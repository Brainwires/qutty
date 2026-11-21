// Shells that survive quitting the app (Settings → "Keep shells running after quitting").
//
// With the setting on, the tiles' terminals run in the PTY daemon (desktop/ptyd.ts) instead of
// the app's process (sandboxed tiles and the hidden helper PTYs stay in the app). The quit then
// asks (desktop/session.ts): "Keep Shells Running" lets every daemon terminal go without ending it
// and leaves the workspaces with the daemon (`keepForNextLaunch`); "End Shells" quits as before
// (the daemon ends a terminal whose app went away without letting it go).
//
// At the next launch (`start`), before any window joins its workspace:
//
// - the daemon is there: each kept workspace comes back detached with the page's snapshot, and
//   each of its terminals is adopted with the output it printed (its replay), so the windows Denext
//   restores (their keys are the workspace ids) rebuild every tile on its running shell;
// - the daemon is gone (a reboot): the record the quit also wrote to the app's folder brings back
//   the shell tiles in their last folder, their old text dimmed above the new prompt; other tiles
//   come back ended. A terminal that ran a coding agent with a known session (Claude Code, Codex:
//   the hub's registry, recorded at the quit) gets its agent resumed in the fresh shell
//   (lib/agent/resume.ts), staggered, at most eight without asking, with Settings → Tiles →
//   "Resume agents after restart" on; an agent tile from the `+` picker comes back for that too;
// - a daemon of another protocol version answers (an older Qutty's shells): the user is told, and
//   may end them.
//
// The singleton {@linkcode shellKeeper} is shared by the `pty` extension (which starts it) and the
// `session` extension (the quit question, the setting).

import type { DesktopConfirmOptions } from "denext/desktop";
import type { TerminalSessions } from "./terminal-sessions.ts";
import type { WorkspaceRegistry } from "./workspace-host.ts";
import type { DenoPty, DenoPtyOptions } from "./pty.ts";
import { ensureDir, writeFileAtomic } from "./libc.ts";
import {
  connectPtyd,
  otherDaemons,
  type PtydClient,
  ptydDir,
  ptydSocketPath,
  shutdownDaemon,
} from "./ptyd-client.ts";
import { unlinkPath } from "./hub-socket.ts";
import { TileMover } from "./tile-move.ts";
import { withArrivals } from "../lib/workspace/session.ts";
import {
  identityAtQuit,
  liveIdentity,
  planResumes,
  RESUME_CAP,
  resumeDelay,
  resumeLine,
} from "../lib/agent/resume.ts";
import {
  type AgentResumeProvider,
  agentResumeProvider,
  onAgentsChanged,
} from "./agent-resume.ts";
import {
  CoalescedWriter,
  LIVE_FILE,
  type LostShells,
  lostShellsPlan,
} from "../lib/ptyd/live.ts";
import {
  cutToLine,
  historyPrelude,
  plainHistory,
  PTYD_PROTOCOL,
} from "../lib/ptyd/protocol.ts";
import {
  KEPT_VERSION,
  type KeptRecord,
  type KeptTerminal,
  parseKept,
  respawnPlan,
  retarget,
  type ShellRespawn,
} from "../lib/ptyd/kept.ts";

/** The file the quit's record also goes to, in the app-support folder. */
export const KEPT_FILE = "kept-shells.json";
/** The setting's file, in the app-support folder. */
export const PREFS_FILE = "ptyd.json";
/** How much of a terminal's output the file keeps as its history. */
const HISTORY_BYTES = 64 * 1024;
/**
 * How long the app waits for the daemon the `ptyd` sidecar is starting at launch (the sidecar
 * starts once the window's server is up; a second runtime takes a few seconds on a slow Mac). The
 * wait starts with the app, and a spawn meanwhile waits for it.
 */
const CONNECT_WAIT_MS = 10_000;
/** How long after a failed connection the daemon is not looked for again. */
const RETRY_AFTER_MS = 30_000;

/** What the keeper needs from the app (the real ones, or fakes in tests). */
export interface KeeperDeps {
  sessions: TerminalSessions;
  workspaces: WorkspaceRegistry;
  /** The daemon's socket folder. */
  socketDir(): Promise<string>;
  /** Connect to the daemon of protocol `v` (default: this one) in `dir`; rejects when none answers. */
  connect(dir: string, v?: number): Promise<PtydClient>;
  /** The other protocol versions whose daemons answer in `dir`. */
  otherDaemons(dir: string): Promise<number[]>;
  /** End the daemon of protocol `v` in `dir`, and its shells. */
  shutdownDaemon(dir: string, v: number): Promise<void>;
  /** The app-support folder (the record and the setting; none: no files). */
  appSupportDir?: string;
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): void;
  remove(path: string): void;
  /** The OS's message box (rejects where there is none). */
  confirm?(options: DesktopConfirmOptions): Promise<number | null>;
  /** `Date.now`. */
  now?(): number;
  /** Wait `ms` (the connection retries). */
  sleep?(ms: number): Promise<void>;
  /** How long a spawn waits for a daemon that is starting (default 10 s). */
  connectWaitMs?: number;
  /** The hub's side of resuming agents (none: no hub, nothing is resumed). */
  agents?(): AgentResumeProvider | undefined;
  /** Type into a terminal (a resume command). */
  write?(id: string, text: string): Promise<void>;
  /** Run `fn` in `ms` (the resumes' stagger, the live record's debounce). */
  later?(fn: () => void, ms: number): void;
  /** Call `fn` when the hub's tiles change (desktop/agent-resume.ts `onAgentsChanged`). */
  watchAgents?(fn: () => void): void;
}

/** What the quit question and Settings use. */
export interface QuitKeeper {
  /** How many running shells a quit can keep (0 with the setting off). */
  keepable(): number;
  /** Let every daemon terminal go and leave the workspaces with the daemon; how many. */
  keepForNextLaunch(): Promise<number>;
  /** The quit goes ahead: a clean exit (the live session record goes). */
  cleanExit?(): void;
}

/** The setting, and the shells kept across launches. */
export class ShellKeeper implements QuitKeeper {
  #deps: KeeperDeps | undefined;
  #keep = true;
  #resume = true;
  #client: PtydClient | undefined;
  #connecting: Promise<PtydClient | undefined> | undefined;
  #failedAt: number | undefined;
  #ready: Promise<void> = Promise.resolve();
  /** The live record's writer (made at `start`; writes only once the startup has read it). */
  #live: CoalescedWriter | undefined;
  /** The live record as last written, and which of its terminals ran in the daemon. */
  #lastLive:
    | { text: string; record: KeptRecord; remote: Set<string> }
    | undefined;
  /** The app is exiting cleanly: the daemon going away is no loss. */
  #exiting = false;
  /** Old PTY id → its agent to resume, after the daemon died (`resumeLost`). */
  #lost = new Map<string, ShellRespawn>();
  #lostResumes = 0;
  #onLost = new Set<(lost: LostShells) => void>();

  /** Settled once the last launch's shells are back (or there were none). */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Whether new tiles' shells run in the daemon (Settings → "Keep shells running after quitting"). */
  get keepShells(): boolean {
    return this.#keep;
  }

  /** Change the setting (saved for the next launch). */
  setKeepShells(on: boolean): void {
    this.#keep = on;
    this.#savePrefs();
  }

  /**
   * Whether a restart resumes the agents that ran in the kept shells (Settings → Tiles → "Resume
   * agents after restart").
   */
  get resumeAgents(): boolean {
    return this.#resume;
  }

  /** Change it (saved with the other setting). */
  setResumeAgents(on: boolean): void {
    this.#resume = on;
    this.#savePrefs();
  }

  #savePrefs(): void {
    const d = this.#deps;
    if (!d?.appSupportDir) return;
    try {
      d.writeText(
        `${d.appSupportDir}/${PREFS_FILE}`,
        JSON.stringify({ keepShells: this.#keep, resumeAgents: this.#resume }),
      );
    } catch (err) {
      console.warn("pty: could not save the keep-shells settings", err);
    }
  }

  /** Read the setting, bring back the last launch's shells, and route new tiles to the daemon. */
  start(deps: KeeperDeps): Promise<void> {
    this.#deps = deps;
    const live = new CoalescedWriter(
      () => this.#writeLive(deps),
      deps.later ?? ((fn, ms) => void setTimeout(fn, ms)),
    );
    this.#ready = this.#startup(deps).catch((err) => {
      console.error("pty: could not restore the last session's shells", err);
    }).finally(() => {
      // The live record follows the session from now on (it was read above).
      this.#live = live;
      this.#writeLive(deps);
    });
    deps.workspaces.onSaved(() => this.#live?.poke());
    deps.watchAgents?.(() => this.#live?.poke());
    deps.sessions.setRemote((id, options) => this.#open(id, options));
    return this.#ready;
  }

  /**
   * The app exits cleanly (a quit, whatever it did with the shells): the live record goes, so the
   * next launch does not take it for a crash.
   */
  cleanExit(): void {
    this.#exiting = true;
    this.#live?.stop();
    const d = this.#deps;
    if (d?.appSupportDir) d.remove(`${d.appSupportDir}/${LIVE_FILE}`);
  }

  /** The live record now: every running terminal, its workspace's snapshot, its agent session. */
  #liveRecord(d: KeeperDeps): KeptRecord {
    const agents = d.agents?.();
    const ids = d.sessions.ids().filter((id) => d.sessions.host.isRunning(id));
    const terms = new Map<string, KeptTerminal>();
    for (const id of ids) {
      const known = d.sessions.host.describe(id);
      if (!known) continue;
      const tile = agents?.agentOf(id);
      const agent = liveIdentity(tile, known.cwd);
      terms.set(id, {
        ptyId: id,
        shell: known.shell,
        cwd: tile?.cwd ?? known.cwd,
        ...(d.sessions.sizeOf(id) ?? { cols: 80, rows: 24 }),
        ...(agent ? { agent } : {}),
      });
    }
    return this.#recordOf(d, ids, terms);
  }

  /** Write the live record when it changed (atomically: a crash mid-write keeps the old one). */
  #writeLive(d: KeeperDeps): void {
    if (!d.appSupportDir || this.#exiting) return;
    const record = this.#liveRecord(d);
    const text = JSON.stringify({ ...record, savedAt: 0 });
    const remote = new Set(d.sessions.remoteIds());
    const same = this.#lastLive?.text === text;
    this.#lastLive = { text, record, remote };
    if (same) return;
    try {
      d.writeText(`${d.appSupportDir}/${LIVE_FILE}`, JSON.stringify(record));
    } catch (err) {
      console.warn("pty: could not write the live session record", err);
    }
  }

  /** Call `fn` when the daemon dies and takes shells with it (the session extension tells the page). */
  onShellsLost(fn: (lost: LostShells) => void): () => void {
    this.#onLost.add(fn);
    return () => this.#onLost.delete(fn);
  }

  /** The daemon went away while the app runs: offer to start its tiles' shells again. */
  #daemonLost(d: KeeperDeps): void {
    const last = this.#lastLive;
    if (this.#exiting || !last || last.remote.size === 0) return;
    const { lost, resume } = lostShellsPlan(
      last.record,
      last.remote,
      this.#resume && d.agents?.() !== undefined,
    );
    for (const r of resume) this.#lost.set(r.ptyId, r);
    for (const l of lost) {
      for (const fn of [...this.#onLost]) {
        try {
          fn(l);
        } catch (err) {
          console.error("pty: a lost-shells listener failed", err);
        }
      }
    }
  }

  /**
   * The page started a fresh shell (`newId`) in the tile whose terminal the daemon took (`oldId`):
   * resume the agent that ran there, if it is one to resume.
   */
  resumeLost(oldId: string, newId: string): boolean {
    const d = this.#deps;
    const r = this.#lost.get(oldId);
    if (!d || !r) return false;
    this.#lost.delete(oldId);
    this.#resumeIn(d, newId, r, this.#lostResumes++);
    return true;
  }

  keepable(): number {
    return this.#keep ? (this.#deps?.sessions.remoteIds().length ?? 0) : 0;
  }

  async keepForNextLaunch(): Promise<number> {
    const d = this.#deps;
    const client = this.#client;
    if (!d || !client || client.closed) return 0;
    const ids = d.sessions.remoteIds();
    if (ids.length === 0) return 0;
    const record = await this.#record(d, client, ids);
    // The quit is under way: the daemon closing from here on is no loss, and the live record
    // stays as it is until the exit removes it.
    this.#exiting = true;
    this.#live?.stop();
    // Let go first (each `detach` is answered before `setState`, which is answered last).
    for (const id of ids) d.sessions.letGo(id);
    await client.request("setState", {
      state: {
        ...record,
        workspaces: record.workspaces.map((w) => ({
          ...w,
          terms: w.terms.map(({ history: _h, ...t }) => t),
        })),
      },
    });
    if (d.appSupportDir) {
      try {
        d.writeText(`${d.appSupportDir}/${KEPT_FILE}`, JSON.stringify(record));
      } catch (err) {
        console.warn("pty: could not write the kept shells' record", err);
      }
    }
    return ids.length;
  }

  /** The record of the terminals `ids` and their workspaces. */
  async #record(
    d: KeeperDeps,
    client: PtydClient,
    ids: string[],
  ): Promise<KeptRecord> {
    const terms = new Map<string, KeptTerminal>();
    const agents = d.agents?.();
    await Promise.all(ids.map(async (id) => {
      const known = d.sessions.host.describe(id);
      const size = d.sessions.sizeOf(id) ?? { cols: 80, rows: 24 };
      if (!known) return;
      const info = await d.sessions.host.info(id).catch(() => undefined);
      const peek = await client.request("peek", {
        sid: id,
        maxBytes: HISTORY_BYTES,
      }).catch(() => ({ text: "", truncated: false }));
      const cwd = info?.cwd ?? known.cwd;
      // The agent session it runs, while the agent still runs (resumed after a restart).
      const agent = identityAtQuit(agents?.agentOf(id), info?.process, cwd);
      terms.set(id, {
        ptyId: id,
        shell: known.shell,
        cwd,
        ...size,
        history: plainHistory(cutToLine(peek.text, peek.truncated)),
        ...(agent ? { agent } : {}),
      });
    }));
    return this.#recordOf(d, ids, terms);
  }

  /** The record of terminals `ids` (described in `terms`) and the workspaces they are in. */
  #recordOf(
    d: KeeperDeps,
    ids: readonly string[],
    terms: ReadonlyMap<string, KeptTerminal>,
  ): KeptRecord {
    return {
      v: KEPT_VERSION,
      savedAt: (d.now ?? Date.now)(),
      workspaces: d.workspaces.keptWorkspaces(new Set(ids)).map((w) => ({
        id: w.id,
        name: w.name,
        // A tile moved here that the window's page has not saved yet (a quit right after the
        // move) is only a pending arrival: it joins the snapshot, as a page joining would take it.
        snapshot: withArrivals(
          w.snapshot,
          TileMover.pendingTiles(d.workspaces.arrivals(w.id)),
        ),
        terms: w.ptys.flatMap((p) => terms.get(p) ?? []),
      })),
    };
  }

  async #startup(d: KeeperDeps): Promise<void> {
    if (d.appSupportDir) {
      const prefs = await d.readText(`${d.appSupportDir}/${PREFS_FILE}`);
      try {
        const v = prefs ? JSON.parse(prefs) : undefined;
        if (typeof v?.keepShells === "boolean") this.#keep = v.keepShells;
        if (typeof v?.resumeAgents === "boolean") {
          this.#resume = v.resumeAgents;
        }
      } catch { /* a damaged file: the default */ }
    }
    const dir = await d.socketDir();
    const client = await d.connect(dir).catch(() => undefined);
    const file = d.appSupportDir
      ? `${d.appSupportDir}/${KEPT_FILE}`
      : undefined;
    // The live record is there only when the last exit was not clean (a crash, a power loss).
    const liveText = d.appSupportDir
      ? await d.readText(`${d.appSupportDir}/${LIVE_FILE}`)
      : undefined;
    let adopted = false;
    if (client) {
      this.#attachClient(client);
      adopted = await this.#adoptAll(d, client);
    }
    // No daemon, or a fresh one the sidecar just started (a reboot ended the old one): the record
    // the quit wrote brings the shell tiles back instead; with no quit at all, the live record.
    const text = !adopted && file ? await d.readText(file) : undefined;
    if (text) await this.#respawn(d, text);
    else if (!adopted && liveText) await this.#respawn(d, liveText);
    if (file) d.remove(file);
    // No daemon yet (the sidecar is starting one): look for it now, so the first tiles' shells
    // find it (a spawn meanwhile waits for this, not for a fresh wait of its own).
    if (!client && this.#keep) void this.#daemon();
    await this.#offerToEndOthers(d, dir);
  }

  /**
   * Take back every terminal the daemon kept, in the workspaces its state names. Whether the
   * daemon had kept anything (a state).
   */
  async #adoptAll(d: KeeperDeps, client: PtydClient): Promise<boolean> {
    const sessions = await client.list();
    const { state } = await client.request("getState", {});
    const record = parseKept(state);
    const where = new Map<
      string,
      { ws: KeptRecord["workspaces"][number]; t: KeptTerminal }
    >();
    for (const ws of record?.workspaces ?? []) {
      for (const t of ws.terms) where.set(t.ptyId, { ws, t });
    }
    for (const s of sessions) {
      const found = where.get(s.sid);
      if (!found || s.attached) {
        // Not a kept tile's (or another app has it): nothing here can show it.
        if (!s.attached) {
          await client.request("release", { sid: s.sid }).catch(() => {});
        }
        continue;
      }
      d.workspaces.restore(found.ws);
      const adopted = await client.adopt(s.sid, s.pid);
      d.sessions.adopt(
        found.ws.id,
        s.sid,
        adopted.pty,
        {
          shell: found.t.shell,
          cwd: found.t.cwd ?? "",
          cols: s.cols,
          rows: s.rows,
        },
        cutToLine(adopted.replay, adopted.truncated),
      );
      if (adopted.exit) {
        await client.request("release", { sid: s.sid }).catch(() => {});
      }
    }
    await client.request("setState", { state: null });
    return record !== undefined;
  }

  /** The daemon is gone: start the kept shell tiles again in their folders, with their history. */
  async #respawn(d: KeeperDeps, text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const record = parseKept(raw);
    const plans = (record?.workspaces ?? []).map((ws) => ({
      ws,
      plan: respawnPlan(ws),
    }));
    const chosen = await this.#chooseResumes(
      d,
      plans.flatMap((p) => p.plan),
    );
    let n = 0;
    for (const { ws, plan } of plans) {
      // An agent tile comes back only to resume its agent.
      const starts = plan.filter((r) => !r.program || chosen.has(r));
      if (starts.length === 0) continue;
      const moved = new Map<string, string>();
      d.workspaces.restore({ id: ws.id, name: ws.name, snapshot: ws.snapshot });
      for (const r of starts) {
        try {
          const started = await d.sessions.restoreShell(
            ws.id,
            {
              cols: r.cols,
              rows: r.rows,
              ...(r.cwd ? { cwd: r.cwd } : {}),
              ...(r.shell ? { shell: r.shell } : {}),
            },
            historyPrelude(r.history, "restored after the shells ended"),
          );
          moved.set(r.ptyId, started.id);
          if (chosen.has(r)) this.#resumeIn(d, started.id, r, n++);
        } catch (err) {
          console.warn(`pty: could not restore a shell of ${ws.name}`, err);
        }
      }
      d.workspaces.save(ws.id, retarget(ws.snapshot, moved));
    }
  }

  /**
   * The respawned terminals whose agent is resumed: with the setting on, up to
   * {@linkcode RESUME_CAP}, and the rest only when the user says so.
   */
  async #chooseResumes(
    d: KeeperDeps,
    plan: readonly ShellRespawn[],
  ): Promise<Set<ShellRespawn>> {
    if (!d.agents?.() || !d.write) return new Set();
    const candidates = plan.flatMap((r) =>
      r.agent ? [{ ptyId: r.ptyId, agent: r.agent, survived: false, r }] : []
    );
    const { resume, ask } = planResumes(candidates, this.#resume);
    let picked = resume;
    if (ask.length > 0) {
      const all = resume.length + ask.length;
      const choice = d.confirm
        ? await d.confirm(resumeQuestion(all)).catch(() => 0)
        : 0;
      picked = choice === 1 ? [...resume, ...ask] : choice === 0 ? resume : [];
    }
    return new Set(picked.map((c) => c.r));
  }

  /** Type `r`'s resume command into its fresh shell `id`, the `n`th resume (staggered). */
  #resumeIn(d: KeeperDeps, id: string, r: ShellRespawn, n: number): void {
    const agent = r.agent;
    const agents = d.agents?.();
    const write = d.write;
    if (!agent || !agents || !write) return;
    const line = resumeLine(agent, agents.hubArgs(agent.harness), r.program);
    const later = d.later ??
      ((fn: () => void, ms: number) => void setTimeout(fn, ms));
    later(() => {
      write(id, line).then(
        () => agents.resumed(id),
        (err) => console.warn(`pty: could not resume the agent in ${id}`, err),
      );
    }, resumeDelay(n));
  }

  /** Another version's daemon still runs shells: say so, and end them if the user wants. */
  async #offerToEndOthers(d: KeeperDeps, dir: string): Promise<void> {
    const others = await d.otherDaemons(dir);
    if (others.length === 0 || !d.confirm) return;
    const choice = await d.confirm({
      title: "Shells from another Qutty version",
      message: "Shells kept by a different version of Qutty are still running",
      detail:
        "This version cannot show them. End them now, or keep them running for the version that started them.",
      buttons: ["End Them", "Keep Running"],
      defaultId: 1,
      cancelId: 1,
      kind: "warning",
    }).catch(() => 1);
    if (choice !== 0) return;
    for (const v of others) {
      await d.shutdownDaemon(dir, v).catch((err) =>
        console.warn(`pty: could not end the protocol ${v} daemon`, err)
      );
    }
  }

  #attachClient(client: PtydClient): void {
    this.#client = client;
    client.onClose(() => {
      if (this.#client !== client) return;
      this.#client = undefined;
      // The daemon died under the running app (not a quit): its shells ended with it.
      if (this.#deps) this.#daemonLost(this.#deps);
    });
  }

  /** A tile's terminal in the daemon (with the setting on and a daemon to be had). */
  async #open(
    id: string,
    options: DenoPtyOptions,
  ): Promise<DenoPty | undefined> {
    if (!this.#keep) return undefined;
    const client = await this.#daemon();
    return client ? await client.open(id, options) : undefined;
  }

  /** The connection, made when there is none (the sidecar may still be starting the daemon). */
  #daemon(): Promise<PtydClient | undefined> {
    const d = this.#deps;
    if (!d) return Promise.resolve(undefined);
    if (this.#client && !this.#client.closed) {
      return Promise.resolve(this.#client);
    }
    const now = (d.now ?? Date.now)();
    if (this.#failedAt !== undefined && now - this.#failedAt < RETRY_AFTER_MS) {
      return Promise.resolve(undefined);
    }
    this.#connecting ??= (async () => {
      const sleep = d.sleep ??
        ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const dir = await d.socketDir();
      const deadline = (d.now ?? Date.now)() +
        (d.connectWaitMs ?? CONNECT_WAIT_MS);
      for (;;) {
        const client = await d.connect(dir).catch(() => undefined);
        if (client) {
          const hello = await client.hello().catch(() => undefined);
          if (hello?.v === PTYD_PROTOCOL) {
            this.#failedAt = undefined;
            this.#attachClient(client);
            return client;
          }
          await client.close();
          break;
        }
        if ((d.now ?? Date.now)() >= deadline) break;
        await sleep(200);
      }
      this.#failedAt = (d.now ?? Date.now)();
      console.warn(
        "pty: no PTY daemon: new shells run in the app (they end at quit)",
      );
      return undefined;
    })().finally(() => (this.#connecting = undefined));
    return this.#connecting;
  }
}

/** The question when more than {@linkcode RESUME_CAP} agents would resume at once. */
export function resumeQuestion(n: number): DesktopConfirmOptions {
  return {
    title: "Resume agents",
    message: `${n} coding agents were running when Qutty last quit`,
    detail:
      `Their shells did not survive the restart. Resume the first ${RESUME_CAP} now, all ${n}, or none (each tile still opens in its folder).`,
    buttons: [`Resume ${RESUME_CAP}`, `Resume All ${n}`, "Don't Resume"],
    defaultId: 0,
    cancelId: 2,
    kind: "info",
  };
}

/** The keeper's dependencies in the app: the daemon's socket, files through libc, the message box. */
export function desktopKeeperDeps(
  sessions: TerminalSessions,
  workspaces: WorkspaceRegistry,
  host: {
    appSupportDir?: string;
    confirm?(options: DesktopConfirmOptions): Promise<number | null>;
  },
): KeeperDeps {
  const encoder = new TextEncoder();
  return {
    sessions,
    workspaces,
    socketDir: ptydDir,
    connect: (dir, v) => connectPtyd(ptydSocketPath(dir, v)),
    otherDaemons,
    shutdownDaemon,
    ...(host.appSupportDir ? { appSupportDir: host.appSupportDir } : {}),
    readText: (path) => Deno.readTextFile(path).catch(() => undefined),
    writeText: (path, text) => {
      ensureDir(path.slice(0, path.lastIndexOf("/")), 0o755);
      writeFileAtomic(path, encoder.encode(text), 0o600);
    },
    remove: (path) => void unlinkPath(path),
    ...(host.confirm ? { confirm: (o) => host.confirm!(o) } : {}),
    agents: agentResumeProvider,
    write: (id, text) => sessions.host.write(id, text),
    watchAgents: (fn) => void onAgentsChanged(fn),
  };
}

const KEY = Symbol.for("qutty.shellKeeper");

/** The app's keeper (on `globalThis`, like the workspace registry). */
export function shellKeeper(): ShellKeeper {
  const g = globalThis as Record<symbol, ShellKeeper | undefined>;
  return (g[KEY] ??= new ShellKeeper());
}
