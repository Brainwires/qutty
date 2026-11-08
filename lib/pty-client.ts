// The page side of the PTY backend. `getPtyBackend()` picks, at run time:
//
// - `desktopBackend` inside the Deno Desktop window: calls the `pty` desktop extension
//   (desktop/pty.ts) through denext's gated bridge and listens to its `data` / `exit` events;
// - `demoBackend` in a plain browser (`denext dev`): a fake shell (banner, prompt, echo, line
//   editing, a few commands) so the UI can be built without the desktop app.
//
// Both also carry the agent hub's page side: the tiles behind the badges, `ask_user` questions
// and their answers, and Settings → Agent integration (the `hub` extension, desktop/hub.ts; in the
// demo, the fake hub in lib/hub-demo.ts).
//
// Detection: `desktopOs()` from `denext/desktop/client` is defined only in a page the desktop
// runtime served (it reads the runtime-injected `__denext.desktop` marker; no bridge call). A
// `?pty=demo` query parameter forces the demo backend, for testing the UI inside the window.
//
// This module is client-safe: the extension is imported for its types only.

import {
  desktopExtension,
  desktopOs,
  onDesktopEvent,
} from "denext/desktop/client";
import type ptyExtension from "../desktop/pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "../desktop/pty.ts";
import type sshExtension from "../desktop/ssh.ts";
import type hubExtension from "../desktop/hub.ts";
import type sandboxExtension from "../desktop/sandbox.ts";
import type ollamaExtension from "../desktop/ollama.ts";
import type linksExtension from "../desktop/links.ts";
import type { LinkEditRequest, LinkOpenRequest, LinkTarget } from "./links.ts";
import { createDemoLinks } from "./links-demo.ts";
import type sysstatsExtension from "../desktop/sysstats.ts";
import type { SysSample } from "./sysstats.ts";
import { demoLoadCommand, demoSample } from "./sysstats-demo.ts";
import { demoJob, markedCommand, osc133, runMark } from "./shell-marks-demo.ts";
import type { OllamaStatus } from "./ollama/cli.ts";
import type {
  LibraryOrder,
  LibraryPageResult,
  LibraryResult,
} from "./ollama/library.ts";
import { createDemoOllama } from "./ollama/demo.ts";
import type { SandboxStatus } from "./sandbox/lifecycle.ts";
import type { SandboxSettings } from "./sandbox/settings.ts";
import { createDemoSandbox, type SandboxAction } from "./sandbox/demo.ts";
import type {
  AskAnswer,
  AskRequest,
  HubSnapshot,
  IntegrationStatus,
  IntegrationTarget,
} from "./hub/protocol.ts";
import type {
  SshCommand,
  SshDownloadArgs,
  SshForwardArgs,
  SshForwardStatus,
  SshHostsResult,
  SshListArgs,
  SshSaveForwardsArgs,
  SshTransferEvent,
  SshTransferStarted,
  SshUploadArgs,
} from "../desktop/ssh.ts";
import type { SshHost, SshHostInput, SshTarget } from "./ssh-config.ts";
import type { SshListing } from "./ssh-command.ts";
import { createDemoSsh, remoteOf } from "./ssh-demo.ts";
import { createDemoHub, type DemoHub } from "./hub-demo.ts";
import type { ControlCommand, ControlResult } from "./hub/core.ts";
import type {
  AuditEntry,
  CompanionStatus,
  CompanionUpdate,
  SayEvent,
} from "./companion/protocol.ts";
import type { BrainEngine } from "./companion/settings.ts";
import type { Launchables } from "./launcher.ts";
import { baseName } from "./ssh-ui.ts";
import {
  createDemoSession,
  createDesktopSession,
  type SessionBackend,
  type SessionWindowDeps,
} from "./session-client.ts";
import { quitApp, setTitleBarStyle } from "denext/desktop/window";

export type {
  SshCommand,
  SshDownloadArgs,
  SshForwardArgs,
  SshForwardStatus,
  SshHostsResult,
  SshListArgs,
  SshSaveForwardsArgs,
  SshTransferEvent,
  SshTransferStarted,
  SshUploadArgs,
};

/** `spawn` options. */
export interface PtySpawnOptions {
  cols: number;
  rows: number;
  /** Working directory (default: the home folder). */
  cwd?: string;
  /** Shell program (default: `$SHELL`, else `/bin/zsh`; started as a login shell). */
  shell?: string;
  /**
   * A program to run instead of a shell (what `sshCommand` returns, or a picked shell): an
   * absolute path or a name on `PATH`. Run as is, not as a login shell.
   */
  program?: string;
  /** Its arguments. */
  args?: string[];
  /** The agent tool `program` is (`claude`): the agent hub adds the flags that connect it. */
  agent?: string;
  /**
   * The agent runs through `ollama launch` on this model: the hub's flags go after a final `--`
   * (desktop/pty.ts), and the hub records the model.
   */
  ollamaModel?: string;
  /** Run it in the window's shared Docker sandbox (`docker exec` into its container). */
  sandbox?: boolean;
}

/** What `spawn` returns. */
export interface PtySpawned {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
}

/** What `info` returns (best-effort). */
export interface PtyProcessInfo {
  id: string;
  pid: number;
  /** The foreground process name, e.g. `zsh` or `vim`. */
  process: string;
  /** The foreground process's working directory, when it could be read. */
  cwd?: string;
}

/** How a terminal ended. `signal` is the terminating signal number, or `null`. */
export interface PtyExit {
  exitCode: number;
  signal: number | null;
}

/** A PTY backend: the desktop extension or the in-browser demo shell. */
export interface PtyBackend {
  readonly kind: "desktop" | "demo";
  /** The workspaces: join this window's and save it (lib/session-client.ts). */
  readonly session: SessionBackend;
  spawn(options: PtySpawnOptions): Promise<PtySpawned>;
  /**
   * Send input. `binary` marks xterm `onBinary` data (one byte per char, e.g. legacy mouse
   * reports), which must not be UTF-8 encoded.
   */
  write(
    id: string,
    data: string,
    options?: { binary?: boolean },
  ): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  /** The user's macOS DefaultKeyBinding.dict text (null when absent or not macOS). */
  keyBindings(): Promise<string | null>;
  /** What the `+` picker can start: installed shells and agent tools (lib/launcher.ts). */
  launchables(): Promise<Launchables>;
  /** Settings → Sandbox: this window's shared Docker sandbox (desktop/sandbox.ts). */
  sandboxStatus(): Promise<SandboxStatus>;
  /** Send the window's sandbox settings (on load and on every change). */
  sandboxConfigure(settings: SandboxSettings): Promise<SandboxStatus>;
  /** Whether Docker is installed and running (the status says why not). */
  sandboxCheck(): Promise<SandboxStatus>;
  /** Start the container with these settings (before the first sandboxed tile; no timeout). */
  sandboxEnsure(settings: SandboxSettings): Promise<SandboxStatus>;
  /** The status line's Restart, Stop and Reset volume. */
  sandboxAction(action: SandboxAction): Promise<SandboxStatus>;

  // --- Ollama (desktop/ollama.ts) ------------------------------------------------------------

  /** Ollama installed? its server, the pulled and loaded models, the `ollama launch` harnesses. */
  ollamaStatus(): Promise<OllamaStatus>;
  /** Search the ollama.com library (cached for a few hours by the backend). */
  ollamaLibrary(
    query: string,
    opts?: { order?: LibraryOrder; toolsOnly?: boolean },
  ): Promise<LibraryResult>;
  /** A library model's page: the harnesses it is listed for, its variants. */
  ollamaLibraryModel(name: string): Promise<LibraryPageResult>;
  /** Open the Ollama app (macOS), which starts its server; false when it is not installed. */
  ollamaOpenApp(): Promise<boolean>;

  // --- Clickable links (desktop/links.ts) ----------------------------------------------------

  /** Which printed paths exist, resolved against `cwd` and the home folder (`null`: no). */
  linkResolve(
    cwd: string | undefined,
    paths: string[],
  ): Promise<(LinkTarget | null)[]>;
  /** Open a URL in the browser or a file in its default app, or reveal a path. */
  linkOpen(request: LinkOpenRequest): Promise<void>;
  /** The editor presets (lib/links.ts) whose command is installed. */
  linkEditors(): Promise<string[]>;
  /** Run an editor command template on a file. */
  linkEdit(request: LinkEditRequest): Promise<void>;

  // --- The system monitor (desktop/sysstats.ts) ------------------------------------------------

  /** CPU since the previous sample, GPU and memory pressure (%), for the meter and hot Loopy. */
  sysSample(): Promise<SysSample>;
  kill(id: string): Promise<void>;
  info(id: string): Promise<PtyProcessInfo>;
  /**
   * Output for terminal `id`. Output that arrived before the first subscriber (between the
   * process starting and `spawn` resolving) is delivered to it. Returns an unsubscribe function.
   */
  onData(id: string, cb: (data: string) => void): () => void;
  /** Called once when terminal `id` ends (immediately if it already has). */
  onExit(id: string, cb: (exit: PtyExit) => void): () => void;

  // --- SSH (desktop/ssh.ts) ------------------------------------------------------------------

  /** The saved hosts (`~/.ssh/config` + its includes, then `~/.ssh/qutty.conf`) and the recents. */
  sshHosts(): Promise<SshHostsResult>;
  /** Add or update a host in `~/.ssh/qutty.conf` (and make sure the user's config includes it). */
  sshSaveHost(host: SshHostInput): Promise<SshHost>;
  /** Remove a host from `~/.ssh/qutty.conf` (hosts from the user's own config cannot be). */
  sshDeleteHost(alias: string): Promise<void>;
  /**
   * The `program` + `args` to `spawn` a tile with for `target` (the shared-connection options,
   * tmux-on-connect and the remote command applied). Records the target as recent.
   */
  sshCommand(target: SshTarget): Promise<SshCommand>;
  /** Copy local files or folders to a remote folder, over the tile's connection. */
  sshUpload(args: SshUploadArgs): Promise<SshTransferStarted>;
  /** Copy a remote file or folder to a local folder (default `~/Downloads`), never overwriting. */
  sshDownload(args: SshDownloadArgs): Promise<SshTransferStarted>;
  /** List a remote folder (the download picker). */
  sshList(args: SshListArgs): Promise<SshListing>;
  /** Stop a transfer; its final event has `error: "cancelled"`. */
  sshCancel(transferId: string): Promise<void>;
  /** Whether the target's shared connection is up, and the forwards added on it (`ssh -O check`). */
  sshForwards(target: SshTarget): Promise<SshForwardStatus>;
  /** Add a port forward to the live connection (`ssh -O forward`); rejects with ssh's error. */
  sshForwardAdd(args: SshForwardArgs): Promise<SshForwardStatus>;
  /** Stop a port forward (`ssh -O cancel`). */
  sshForwardCancel(args: SshForwardArgs): Promise<SshForwardStatus>;
  /** Replace a Qutty host's favourite forwards (its `# qutty:` metadata in qutty.conf). */
  sshSaveForwards(args: SshSaveForwardsArgs): Promise<SshHost>;
  /** Progress and completion of every transfer. Subscribe before starting one. */
  onTransfer(cb: (event: SshTransferEvent) => void): () => void;

  // --- Agent hub (desktop/hub.ts) ------------------------------------------------------------

  /** The hub's tiles and open questions (`running: false, tiles: []` when it did not start). */
  hubSnapshot(): Promise<HubSnapshot & { asks: AskRequest[] }>;
  /** Answer `ask_user` question `id` with a button label, or `null` (dismissed). */
  hubAnswer(id: string, action: AskAnswer["action"]): Promise<boolean>;
  /** Tell the hub terminal `ptyId`'s title (agents see it in `list_peers`). */
  hubSetLabel(ptyId: string, label: string): Promise<void>;
  /** A full snapshot of the tiles after every change. */
  onHubTiles(cb: (snapshot: HubSnapshot) => void): () => void;
  /** A new `ask_user` question (each id once, also when the event stream replays). */
  onHubAsk(cb: (request: AskRequest) => void): () => void;
  /** A question was answered (here or elsewhere) or its tile went away. */
  onHubAskClosed(cb: (id: string) => void): () => void;
  /** Settings → Agent integration: what is installed, and what Install would change. */
  integrationStatus(): Promise<IntegrationStatus[]>;
  /** Install the user-scope registration for `target`; the new status (throws with the reason). */
  integrationInstall(target: IntegrationTarget): Promise<IntegrationStatus[]>;
  /** Remove exactly Qutty's entries for `target`; the new status. */
  integrationUninstall(target: IntegrationTarget): Promise<IntegrationStatus[]>;

  // --- The companion (desktop/companion.ts) ----------------------------------------------------

  /** The brain's status and the recent privileged actions (newest first). */
  companionStatus(): Promise<
    { status: CompanionStatus; activity: AuditEntry[] }
  >;
  /**
   * The user typed (or, `via: "voice"`, said) something to the companion; its reply streams as
   * `onCompanion` turn updates.
   */
  companionSend(
    text: string,
    via?: "chat" | "voice",
  ): Promise<{ turn: number }>;
  /**
   * Settings → Companion: whether the brain may run, which one (default Claude Code), and its
   * model (`""`: the default).
   */
  companionConfigure(
    enabled: boolean,
    model: string,
    engine?: BrainEngine,
  ): Promise<CompanionStatus>;
  /** The button pressed under a waited-for `qutty-hook say` (`null`: closed). */
  companionSayDone(id: string, action: string | null): Promise<boolean>;
  /** The page carried out (or could not carry out) a companion command. */
  hubControlDone(requestId: string, result: ControlResult): Promise<boolean>;
  /** The brain's status, its turns as they stream, its tool calls, new audit entries. */
  onCompanion(cb: (update: CompanionUpdate) => void): () => void;
  /** A `qutty-hook say` message for Loopy's bubble. */
  onHubSay(cb: (say: SayEvent) => void): () => void;
  /** A companion command for the page (spawn / close / focus a tile); answer with `hubControlDone`. */
  onHubControl(
    cb: (request: { requestId: string; command: ControlCommand }) => void,
  ): () => void;
}

/** A companion command as the page receives it. */
export interface ControlRequest {
  requestId: string;
  command: ControlCommand;
}

/** A set of callbacks: the transfer fan-out both backends share. */
function fanout<T>() {
  const subs = new Set<(value: T) => void>();
  return {
    emit(value: T) {
      for (const cb of [...subs]) cb(value);
    },
    on(cb: (value: T) => void): () => void {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Event fan-out shared by both backends
// ---------------------------------------------------------------------------------------------

/** Per-id output not yet claimed by a subscriber is kept up to this many characters. */
const MAX_UNCLAIMED_CHARS = 512 * 1024;
/** Unclaimed output for an id nobody subscribes to is dropped after this long. */
const UNCLAIMED_TTL_MS = 30_000;

/**
 * Per-id fan-out of `data` / `exit` with the early-output buffer. Exported for tests only (the app
 * goes through a {@linkcode PtyBackend}).
 */
export class PtyEvents {
  #data = new Map<string, Set<(data: string) => void>>();
  #exit = new Map<string, Set<(exit: PtyExit) => void>>();
  #unclaimed = new Map<
    string,
    { chunks: string[]; size: number; timer: ReturnType<typeof setTimeout> }
  >();
  #exited = new Map<string, PtyExit>();

  emitData(id: string, data: string): void {
    const subs = this.#data.get(id);
    if (subs && subs.size > 0) {
      for (const cb of subs) cb(data);
      return;
    }
    let u = this.#unclaimed.get(id);
    if (!u) {
      const timer = setTimeout(
        () => this.#unclaimed.delete(id),
        UNCLAIMED_TTL_MS,
      );
      u = { chunks: [], size: 0, timer };
      this.#unclaimed.set(id, u);
    }
    u.chunks.push(data);
    u.size += data.length;
    while (u.size > MAX_UNCLAIMED_CHARS && u.chunks.length > 1) {
      u.size -= u.chunks.shift()!.length;
    }
  }

  emitExit(id: string, exit: PtyExit): void {
    if (this.#exited.has(id)) return;
    this.#exited.set(id, exit);
    const subs = this.#exit.get(id);
    this.#exit.delete(id);
    if (subs) { for (const cb of subs) cb(exit); }
  }

  onData(id: string, cb: (data: string) => void): () => void {
    let subs = this.#data.get(id);
    if (!subs) this.#data.set(id, subs = new Set());
    subs.add(cb);
    const u = this.#unclaimed.get(id);
    if (u) {
      this.#unclaimed.delete(id);
      clearTimeout(u.timer);
      const backlog = u.chunks.join("");
      if (backlog) cb(backlog);
    }
    return () => {
      subs.delete(cb);
      if (subs.size === 0 && this.#data.get(id) === subs) this.#data.delete(id);
    };
  }

  /**
   * Terminal `id` was handed to this page with its replay (which holds everything so far): drop
   * the output buffered for it from the event stream's own replay.
   */
  forget(id: string): void {
    const u = this.#unclaimed.get(id);
    if (!u) return;
    clearTimeout(u.timer);
    this.#unclaimed.delete(id);
  }

  onExit(id: string, cb: (exit: PtyExit) => void): () => void {
    const done = this.#exited.get(id);
    if (done) {
      queueMicrotask(() => cb(done));
      return () => {};
    }
    let subs = this.#exit.get(id);
    if (!subs) this.#exit.set(id, subs = new Set());
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Desktop backend
// ---------------------------------------------------------------------------------------------

/**
 * The two `denext/desktop/client` functions the desktop backend uses. Injectable so tests can
 * drive the backend with a fake bridge and event source.
 */
export interface DesktopBridgeDeps {
  desktopExtension: typeof desktopExtension;
  onDesktopEvent: typeof onDesktopEvent;
  /** The window calls of the workspaces (default `denext/desktop/window`'s). */
  window?: SessionWindowDeps;
}

/** A PTY event as the page receives it: the terminal's id and the event's own data. */
type PtyEventOf<T extends { id: string }> = { id: string; data: Omit<T, "id"> };

/**
 * A new desktop backend (the app uses the {@linkcode desktopBackend} singleton). `deps` defaults
 * to the real `denext/desktop/client`; tests pass a fake.
 */
export function createDesktopBackend(
  deps: DesktopBridgeDeps = { desktopExtension, onDesktopEvent },
): PtyBackend {
  const { desktopExtension, onDesktopEvent } = deps;
  const windowDeps = deps.window ?? { quitApp, setTitleBarStyle };
  const pty = desktopExtension<typeof ptyExtension>("pty");
  const ssh = desktopExtension<typeof sshExtension>("ssh");
  const hub = desktopExtension<typeof hubExtension>("hub");
  const sandbox = desktopExtension<typeof sandboxExtension>("sandbox");
  const ollama = desktopExtension<typeof ollamaExtension>("ollama");
  const links = desktopExtension<typeof linksExtension>("links");
  const sysstats = desktopExtension<typeof sysstatsExtension>("sysstats");
  const events = new PtyEvents();
  // The desktop event stream is at-least-once (a reconnect replays its buffer): drop repeats.
  const lastSeq = new Map<string, number>();
  let listening = false;
  const transfers = fanout<SshTransferEvent>();
  const lastTransferSeq = new Map<string, number>();
  let listeningTransfers = false;
  const hubTiles = fanout<HubSnapshot>();
  const hubAsks = fanout<AskRequest>();
  const hubAskClosed = fanout<string>();
  /** Questions already delivered or closed: a replayed `ask` must not open one again. */
  const seenAsks = new Set<string>();
  let listeningHub = false;
  const companion = fanout<CompanionUpdate>();
  const says = fanout<SayEvent>();
  const controls = fanout<ControlRequest>();
  /**
   * The event stream replays its buffer to a new page: a companion update, `say` or command from
   * before this page loaded is history, not something to show (or do) again.
   */
  const loadedAt = Date.now();
  const fresh = (data: { at?: number }) =>
    typeof data.at !== "number" || data.at >= loadedAt - 1000;
  const seenSays = new Set<string>();
  const seenControls = new Set<string>();
  let listeningCompanion = false;
  const listenCompanion = () => {
    if (listeningCompanion) return;
    listeningCompanion = true;
    onDesktopEvent<CompanionUpdate & { at?: number }>(
      "hub",
      "companion",
      (u) => {
        if (fresh(u)) companion.emit(u);
      },
    );
    onDesktopEvent<SayEvent & { at?: number }>("hub", "say", (e) => {
      if (!fresh(e) || seenSays.has(e.message.id)) return;
      seenSays.add(e.message.id);
      says.emit(e);
    });
    onDesktopEvent<ControlRequest & { at?: number }>("hub", "control", (e) => {
      if (!fresh(e) || seenControls.has(e.requestId)) return;
      seenControls.add(e.requestId);
      controls.emit({ requestId: e.requestId, command: e.command });
    });
  };

  const listenHub = () => {
    if (listeningHub) return;
    listeningHub = true;
    // `tiles` is a full snapshot each time, so a repeat is harmless.
    onDesktopEvent<HubSnapshot>("hub", "tiles", hubTiles.emit);
    onDesktopEvent<AskRequest>("hub", "ask", (request) => {
      if (seenAsks.has(request.id)) return;
      seenAsks.add(request.id);
      hubAsks.emit(request);
    });
    onDesktopEvent<{ id: string }>("hub", "askClosed", ({ id }) => {
      seenAsks.add(id);
      hubAskClosed.emit(id);
    });
  };

  const listenTransfers = () => {
    if (listeningTransfers) return;
    listeningTransfers = true;
    // Kept after `done` too: a replay re-sends the finished transfer's events as well.
    onDesktopEvent<SshTransferEvent>("ssh", "transfer", (event) => {
      if (event.seq <= (lastTransferSeq.get(event.transferId) ?? 0)) return;
      lastTransferSeq.set(event.transferId, event.seq);
      transfers.emit(event);
    });
  };

  const listen = () => {
    if (listening) return;
    listening = true;
    // Each terminal's events reach the window showing its workspace only, as `{ id, data }`
    // (denext's owned resources, desktop/terminal-sessions.ts).
    onDesktopEvent<PtyEventOf<PtyDataEvent>>("pty", "data", (e) => {
      const { seq, data } = e.data;
      if (seq <= (lastSeq.get(e.id) ?? 0)) return;
      lastSeq.set(e.id, seq);
      events.emitData(e.id, data);
    });
    onDesktopEvent<PtyEventOf<PtyExitEvent>>("pty", "exit", (e) => {
      // `lastSeq` is kept after the exit: a replay of the stream re-sends the dead terminal's
      // output too, and must be dropped like any other repeat (one number per terminal).
      events.emitExit(e.id, {
        exitCode: e.data.exitCode,
        signal: e.data.signal,
      });
    });
  };

  return {
    kind: "desktop",
    session: createDesktopSession({
      desktopExtension,
      onDesktopEvent,
      window: windowDeps,
      listen,
      adopt: (id, seq) => {
        events.forget(id);
        lastSeq.set(id, Math.max(seq, lastSeq.get(id) ?? 0));
      },
    }),
    async spawn(options) {
      // Subscribe first: the shell's first output can arrive before `spawn` resolves.
      listen();
      return await pty.spawn(options);
    },
    async write(id, data, options) {
      await pty.write(
        options?.binary ? { id, data, binary: true } : { id, data },
      );
    },
    async resize(id, cols, rows) {
      await pty.resize({ id, cols, rows });
    },
    async kill(id) {
      await pty.kill({ id });
    },
    async info(id) {
      return await pty.info({ id });
    },
    async keyBindings() {
      return await pty.keyBindings({});
    },
    async launchables() {
      return await pty.launchables({});
    },
    sandboxStatus: () => sandbox.status({}),
    sandboxConfigure: (settings) => sandbox.configure({ settings }),
    sandboxCheck: () => sandbox.check({}),
    async sandboxEnsure(settings) {
      await sandbox.configure({ settings });
      return await sandbox.ensure({});
    },
    sandboxAction: (action) =>
      action === "restart"
        ? sandbox.restart({})
        : action === "stop"
        ? sandbox.stop({})
        : sandbox.resetVolume({}),
    ollamaStatus: () => ollama.status({}),
    ollamaLibrary: (query, opts = {}) =>
      ollama.library({
        ...(query.trim() ? { query: query.trim() } : {}),
        order: opts.order ?? "popular",
        toolsOnly: opts.toolsOnly === true,
      }),
    ollamaLibraryModel: (name) => ollama.libraryModel({ name }),
    ollamaOpenApp: () => ollama.openApp({}),
    linkResolve: (cwd, paths) =>
      links.resolve(cwd === undefined ? { paths } : { cwd, paths }),
    linkOpen: (request) => links.open(request),
    linkEditors: () => links.editors({}),
    linkEdit: (request) => links.edit(request),
    sysSample: () => sysstats.sample({}),
    onData: (id, cb) => {
      listen();
      return events.onData(id, cb);
    },
    onExit: (id, cb) => {
      listen();
      return events.onExit(id, cb);
    },
    async sshHosts() {
      return await ssh.sshHosts({});
    },
    async sshSaveHost(host) {
      return await ssh.sshSaveHost(host);
    },
    async sshDeleteHost(alias) {
      await ssh.sshDeleteHost({ alias });
    },
    async sshCommand(target) {
      return await ssh.sshCommand({ target });
    },
    async sshUpload(args) {
      listenTransfers();
      return await ssh.sshUpload(args);
    },
    async sshDownload(args) {
      listenTransfers();
      return await ssh.sshDownload(args);
    },
    async sshList(args) {
      return await ssh.sshList(args);
    },
    async sshCancel(transferId) {
      await ssh.sshCancel({ transferId });
    },
    async sshForwards(target) {
      return await ssh.sshForwards({ target });
    },
    async sshForwardAdd(args) {
      return await ssh.sshForwardAdd(args);
    },
    async sshForwardCancel(args) {
      return await ssh.sshForwardCancel(args);
    },
    async sshSaveForwards(args) {
      return await ssh.sshSaveForwards(args);
    },
    onTransfer: (cb) => {
      listenTransfers();
      return transfers.on(cb);
    },
    async hubSnapshot() {
      return await hub.snapshot({});
    },
    async hubAnswer(id, action) {
      return await hub.answer({ id, action });
    },
    async hubSetLabel(ptyId, label) {
      await hub.setLabel({ id: ptyId, label });
    },
    onHubTiles: (cb) => {
      listenHub();
      return hubTiles.on(cb);
    },
    onHubAsk: (cb) => {
      listenHub();
      return hubAsks.on(cb);
    },
    onHubAskClosed: (cb) => {
      listenHub();
      return hubAskClosed.on(cb);
    },
    async integrationStatus() {
      return await hub.integrationStatus({});
    },
    async integrationInstall(target) {
      return await hub.integrationInstall({ target });
    },
    async integrationUninstall(target) {
      return await hub.integrationUninstall({ target });
    },
    async companionStatus() {
      return await hub.companionStatus({});
    },
    async companionSend(text, via = "chat") {
      return await hub.companionSend({ text, via });
    },
    async companionConfigure(enabled, model, engine = "claude") {
      return await hub.companionConfigure({ enabled, model, engine });
    },
    async companionSayDone(id, action) {
      return await hub.companionSayDone({ id, action });
    },
    async hubControlDone(requestId, result) {
      return await hub.controlDone({ requestId, ...result });
    },
    onCompanion: (cb) => {
      listenCompanion();
      return companion.on(cb);
    },
    onHubSay: (cb) => {
      listenCompanion();
      return says.on(cb);
    },
    onHubControl: (cb) => {
      listenCompanion();
      return controls.on(cb);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Demo backend: a fake shell for plain-browser development
// ---------------------------------------------------------------------------------------------

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const fg = (n: number) => `${ESC}[38;5;${n}m`;

const DEMO_FILES: { name: string; dir?: boolean; exec?: boolean }[] = [
  { name: "Applications", dir: true },
  { name: "Desktop", dir: true },
  { name: "Documents", dir: true },
  { name: "Downloads", dir: true },
  { name: "Source", dir: true },
  { name: "notes.md" },
  { name: "build.sh", exec: true },
  { name: "todo.txt" },
];

const DEMO_HELP = [
  `${BOLD}Qutty demo shell${RESET} ${DIM}(no real processes — browser dev mode)${RESET}`,
  "",
  `  ${fg(81)}help${RESET}       this list`,
  `  ${fg(81)}ls${RESET}         list files`,
  `  ${fg(81)}date${RESET}       print the date`,
  `  ${fg(81)}echo${RESET} ...   print arguments`,
  `  ${fg(81)}clear${RESET}      clear the screen (also Ctrl+L)`,
  `  ${fg(81)}top${RESET}        ticking process table (q or Ctrl+C to quit)`,
  `  ${fg(81)}colors${RESET}     256-colour palette`,
  `  ${fg(81)}stress${RESET} [n] print n lines fast (default 2000)`,
  `  ${fg(81)}size${RESET}       print rows and columns`,
  `  ${fg(81)}links${RESET}      URLs, paths and OSC 8 links to ⌘-click`,
  `  ${
    fg(81)
  }load${RESET} <cpu> [gpu]  pin the demo's CPU / GPU figures (\`load off\`)`,
  `  ${
    fg(81)
  }query${RESET}      ask the terminal for its cursor and attributes`,
  `  ${fg(81)}replies${RESET}    how many answers to queries arrived`,
  `  ${
    fg(81)
  }job${RESET} <s> <exit> <cmd…>  pretend to run cmd for s seconds (Loopy reacts)`,
  `  ${
    fg(81)
  }qutty-hook say${RESET} <text> [--mood m] [--action id:label] [--wait]  Loopy says it`,
  `  ${fg(81)}pwd${RESET}, ${fg(81)}cd${RESET}, ${fg(81)}whoami${RESET}, ${
    fg(81)
  }exit${RESET}`,
  "",
];

/** xterm's answers to the demo's `query`: a cursor position report, primary device attributes. */
// deno-lint-ignore no-control-regex
const QUERY_REPLY = /\x1b\[\d+;\d+R|\x1b\[\?[\d;]*c/g;

/** An OSC 8 hyperlink: `text` linked to `uri`. */
const osc8 = (uri: string, text: string) =>
  `${ESC}]8;;${uri}\x07${text}${ESC}]8;;\x07`;

/**
 * `links`: one of each kind of link (lib/links.ts), the paths in lib/links-demo.ts's fake file
 * system, and things that are not links. One per line, so the e2e suite can find them.
 */
const DEMO_LINKS = [
  `url: https://deno.com/ (and https://docs.deno.com/runtime/).`,
  `mail: mailto:demo@example.com`,
  `osc8: ${osc8("https://github.com/Brainwires/qutty", "Qutty on GitHub")}`,
  `osc8 file: ${osc8("file:///Users/demo/notes.md", "my notes")}`,
  `file: ~/notes.md`,
  `folder: ~/Downloads`,
  `relative: Source/qutty/README.md`,
  `error: Source/qutty/src/main.ts:42:7: error: demo`,
  `remote: /home/demo/logs/app.log`,
  `missing: ./missing.ts`,
  `not links: 1.2.3 12:30 3/4`,
];

/** A demo agent's `/help`: what it can do with the demo agent hub (lib/hub-demo.ts). */
const DEMO_AGENT_HELP = [
  `${BOLD}demo agent${RESET} ${DIM}(no real model — browser dev mode)${RESET}`,
  "",
  `  ${fg(209)}/help${RESET}              this list`,
  `  ${
    fg(209)
  }/ask${RESET} [question]     ask the user (Yes / No); the answer is printed here`,
  `  ${
    fg(209)
  }/msg${RESET} <name> <text>  queue a message for another tile (its badge counts it)`,
  `  ${
    fg(209)
  }/msg companion${RESET} <text>  ask the companion (Loopy answers in its bubble)`,
  `  ${
    fg(209)
  }/fail${RESET} [what]        report a failure (set_status note "<what> failed")`,
  `  ${
    fg(209)
  }/pass${RESET} [what]        report a success (set_status note "<what> passed")`,
  `  ${fg(209)}/exit${RESET}              quit`,
  `  anything else      busy for a moment, then idle; queued messages are read first`,
  "",
];

/** How long a demo agent stays busy after a line. */
const DEMO_BUSY_MS = 1500;

/** What the demo backend says is installed (the e2e suite launches these). */
const DEMO_LAUNCHABLES: Launchables = {
  shells: [
    { path: "/bin/zsh", label: "zsh", isDefault: true },
    { path: "/bin/bash", label: "bash", isDefault: false },
    { path: "/opt/homebrew/bin/fish", label: "fish", isDefault: false },
  ],
  agents: [
    {
      name: "claude",
      label: "Claude Code",
      path: "/Users/demo/.local/bin/claude",
    },
    { name: "codex", label: "Codex", path: "/opt/homebrew/bin/codex" },
  ],
};

/** A demo agent tool: started by its path or name, it greets, echoes, and ends on `/exit`. */
const demoAgentOf = (program: string | undefined) =>
  program === undefined
    ? undefined
    : DEMO_LAUNCHABLES.agents.find((a) =>
      a.path === program || a.name === program
    );

/** What a demo terminal pretends to run: the demo shell (under a name), ssh, or an agent tool. */
interface DemoMode {
  /** The shell's name (`info` reports it): `demo-sh`, or the picked shell's. */
  name: string;
  /** A fake ssh session: the prompt and banner look remote. */
  remote?: { user: string; host: string };
  /** A fake agent tool. */
  agent?: { name: string; label: string };
  /** A fake `ollama pull` first (`done` adds the model to the demo's list). */
  pull?: { done(): void };
  /** A fake shell in the shared sandbox (root in `qutty-sandbox`). */
  sandbox?: boolean;
}

class DemoShell {
  line = "";
  cwd = "~";
  topTimer: ReturnType<typeof setInterval> | undefined;
  /** A demo agent's busy → idle timer. */
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** A `job` running (lib/shell-marks-demo.ts): it ends on this timer. */
  jobTimer: ReturnType<typeof setTimeout> | undefined;
  /** A command was marked as started (OSC 133 `C`) and not yet as ended. */
  marked = false;
  /** The exit status the running command will end with. */
  status = 0;
  exited = false;
  /** Answers to `query` received (cursor position and device attributes reports). */
  replies = 0;

  constructor(
    readonly id: string,
    public cols: number,
    public rows: number,
    readonly out: (data: string) => void,
    readonly exit: (e: PtyExit) => void,
    readonly hub: DemoHub,
    readonly mode: DemoMode = { name: "demo-sh" },
  ) {}

  get remote(): { user: string; host: string } | undefined {
    return this.mode.remote;
  }

  start(): void {
    const agent = this.mode.agent;
    const pull = this.mode.pull;
    if (pull) {
      // A fake `ollama pull`: the progress lines, then the model is "here".
      this.out(
        `pulling manifest\r\npulling 5642e97495e1: 100% ▕████████████████▏ 1.0 GB\r\n` +
          `verifying sha256 digest\r\nwriting manifest\r\nsuccess\r\n`,
      );
      pull.done();
      if (!agent) {
        this.exit({ exitCode: 0, signal: null });
        return;
      }
    }
    if (agent) {
      this.out(
        `${
          fg(209)
        }${BOLD}✻ ${agent.label}${RESET} ${DIM}demo backend — a fake ${agent.name}, /help for commands, /exit to quit${RESET}\r\n\r\n`,
      );
      this.prompt();
      return;
    }
    this.out(
      this.mode.sandbox
        ? `${DIM}demo backend — a fake shell in the shared sandbox, no Docker involved${RESET}\r\n\r\n`
        : this.remote
        ? `${DIM}demo backend — a fake ssh session, nothing is connected${RESET}\r\n` +
          `Welcome to ${BOLD}${this.remote.host}${RESET}\r\n\r\n`
        : `${
          fg(141)
        }${BOLD}Qutty${RESET} ${DIM}demo backend — the desktop app runs a real shell${RESET}\r\n` +
          `Type ${fg(81)}help${RESET} for commands.\r\n\r\n`,
    );
    this.prompt();
  }

  prompt(): void {
    if (this.mode.agent) {
      this.out(`${fg(209)}>${RESET} `);
      return;
    }
    // A fake remote shell reports its directory with OSC 7, like zsh/fish do on every prompt
    // (`~` is /home/demo there); the SSH tile uploads dropped files into it.
    if (this.remote) {
      const dir = this.cwd === "~"
        ? "/home/demo"
        : this.cwd.replace(/^~\//, "/home/demo/");
      this.out(`${ESC}]7;file://${this.remote.host}${encodeURI(dir)}\x07`);
    }
    // Shell integration marks, like Qutty's zsh plugin: the last command's end, then the prompt
    // (the local shell's: a fake remote one has no plugin).
    if (!this.remote) {
      this.markDone();
      this.out(osc133("A"));
    }
    const who = this.remote
      ? `${this.remote.user}@${this.remote.host}`
      : this.mode.sandbox
      ? "root@qutty-sandbox"
      : "demo";
    this.out(`${fg(114)}${who}${RESET}:${fg(75)}${this.cwd}${RESET}$ `);
  }

  /**
   * What `info` reports: a real ssh tile's foreground process is `ssh`; an agent tool is often a
   * node script (the tile's title names the tool, not this).
   */
  get process(): string {
    if (this.topTimer) return "top";
    if (this.mode.agent) return "node";
    return this.remote ? "ssh" : this.mode.name;
  }

  /** OSC 133 `C` for a command line about to run (a local shell's, not an agent's). */
  markRun(line: string): void {
    if (this.mode.agent || this.remote || !line.trim()) return;
    this.out(runMark(markedCommand(line)));
    this.marked = true;
    this.status = 0;
  }

  /** OSC 133 `D;<exit>` for the command marked as running, if any. */
  markDone(): void {
    if (!this.marked) return;
    this.marked = false;
    this.out(osc133(`D;${this.status}`));
  }

  /** `job <seconds> <exit> <command…>`: pretend to run a long command. */
  startJob(args: string[]): void {
    const job = demoJob(args);
    if (!job) {
      this.out("usage: job <seconds> <exit> <command…>\r\n");
      this.status = 2;
      return;
    }
    this.out(`${DIM}(demo) running ${job.command}…${RESET}\r\n`);
    this.jobTimer = setTimeout(() => {
      this.jobTimer = undefined;
      if (this.exited) return;
      this.status = job.exitCode;
      this.out(
        job.exitCode === 0
          ? `${DIM}(demo) ${job.command}: done${RESET}\r\n`
          : `${DIM}(demo) ${job.command}: exit ${job.exitCode}${RESET}\r\n`,
      );
      this.prompt();
    }, job.ms);
  }

  input(data: string): void {
    if (this.exited) return;
    if (this.jobTimer) {
      if (!data.includes("\x03")) return;
      clearTimeout(this.jobTimer);
      this.jobTimer = undefined;
      this.status = 130;
      this.out("^C\r\n");
      this.prompt();
      return;
    }
    if (this.topTimer) {
      if (data.includes("q") || data.includes("\x03")) this.stopTop();
      return;
    }
    // The terminal's answers to `query`, counted for `replies` (the broadcast e2e checks that a
    // tile's answers never reach another tile).
    this.replies += (data.match(QUERY_REPLY) ?? []).length;
    // Drop escape sequences (arrows, function keys); the demo has no history or cursor motion.
    // deno-lint-ignore no-control-regex
    const clean = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|\x1b./g, "");
    for (const ch of clean) {
      if (ch === "\r" || ch === "\n") {
        this.out("\r\n");
        const cmd = this.line;
        this.line = "";
        this.markRun(cmd);
        this.run(cmd);
        if (this.exited) return;
        if (!this.topTimer && !this.jobTimer) this.prompt();
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length > 0) {
          this.line = [...this.line].slice(0, -1).join("");
          this.out("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        this.out("^C\r\n");
        this.prompt();
      } else if (ch === "\x0c") {
        this.out(`${ESC}[2J${ESC}[H`);
        this.prompt();
        this.out(this.line);
      } else if (ch === "\x15") {
        // Ctrl+U: kill the line.
        this.out("\b \b".repeat([...this.line].length));
        this.line = "";
      } else if (ch === "\x04") {
        if (this.line === "") {
          this.run("exit");
          return; // nothing after the EOF is read
        }
      } else if (ch >= " " || ch === "\t") {
        const c = ch === "\t" ? " " : ch;
        this.line += c;
        this.out(c);
      }
    }
  }

  /**
   * A demo agent's turn: `/exit` (or `exit`) ends it; `/help`, `/ask` and `/msg` use the demo
   * hub; anything else gets a canned answer and keeps the agent busy for a moment. Messages
   * queued for it are read first.
   */
  runAgent(raw: string): void {
    const text = raw.trim();
    const println = (s: string) => this.out(`${s}\r\n`);
    if (text === "/exit" || text === "exit") {
      this.exited = true;
      this.exit({ exitCode: 0, signal: null });
      return;
    }
    if (text === "") return;
    for (const m of this.hub.take(this.id)) {
      println(`${fg(81)}✉ ${m.fromName}:${RESET} ${m.text}`);
    }
    const [cmd, ...rest] = text.split(/\s+/);
    if (cmd === "/help") {
      for (const l of DEMO_AGENT_HELP) println(l);
    } else if (cmd === "/ask") {
      this.askUser(rest.join(" ") || "Apply the demo change to notes.md?");
      println(`${DIM}(demo) asked the user, waiting for the answer…${RESET}`);
    } else if (cmd === "/msg" && rest.length >= 2) {
      const to = this.hub.send(this.id, rest[0], rest.slice(1).join(" "));
      println(
        `${DIM}(demo) ${
          to ? `queued for ${to}` : `no other tile is named ${rest[0]}`
        }${RESET}`,
      );
    } else if (cmd === "/msg") {
      println(`${DIM}(demo) usage: /msg <name> <text>${RESET}`);
    } else if (cmd === "/fail" || cmd === "/pass") {
      const what = rest.join(" ") || (cmd === "/fail" ? "build" : "tests");
      const note = `${what} ${cmd === "/fail" ? "failed" : "passed"}`;
      clearTimeout(this.idleTimer);
      this.hub.setStatus(this.id, "idle", note);
      println(`${DIM}(demo) set_status idle, note: ${note}${RESET}`);
    } else {
      println(`${DIM}(demo) ${this.mode.agent!.name} heard: ${text}${RESET}`);
      this.hub.setStatus(this.id, "busy");
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(
        () => this.hub.setStatus(this.id, "idle"),
        DEMO_BUSY_MS,
      );
    }
  }

  /** `qutty-hook say …` through the demo hub; a `--wait`'s answer is printed above a fresh prompt. */
  say(args: string[]): void {
    const error = this.hub.say(this.id, args, (action) => {
      if (this.exited) return;
      this.out(`\r${ESC}[2K${action ?? ""}${action ? "\r\n" : ""}`);
      this.prompt();
      this.out(this.line);
    });
    if (error) this.out(`qutty-hook say: ${error}\r\n`);
  }

  /** `ask_user` through the demo hub; the answer is printed above a fresh prompt. */
  askUser(question: string): void {
    this.hub.ask(this.id, question, ["Yes", "No"], (action) => {
      if (this.exited) return;
      this.out(
        `\r${ESC}[2K${DIM}(demo) the user answered: ${
          action ?? "nothing (dismissed)"
        }${RESET}\r\n`,
      );
      this.prompt();
      this.out(this.line);
    });
  }

  run(raw: string): void {
    if (this.mode.agent) return this.runAgent(raw);
    const [cmd = "", ...args] = raw.trim().split(/\s+/);
    const println = (s = "") => this.out(`${s}\r\n`);
    switch (cmd) {
      case "":
        return;
      case "help":
        for (const l of DEMO_HELP) println(l);
        return;
      case "ls": {
        const names = DEMO_FILES.map((f) =>
          f.dir
            ? `${fg(75)}${BOLD}${f.name}${RESET}`
            : f.exec
            ? `${fg(114)}${f.name}${RESET}`
            : f.name
        );
        println(names.join("  "));
        return;
      }
      case "date":
        println(new Date().toString());
        return;
      case "echo":
        println(args.join(" "));
        return;
      case "clear":
        this.out(`${ESC}[2J${ESC}[3J${ESC}[H`);
        return;
      case "pwd":
        println(this.cwd === "~" ? "/Users/demo" : this.cwd);
        return;
      case "cd":
        this.cwd = args[0] && args[0] !== "~"
          ? (args[0].startsWith("/") ? args[0] : `~/${args[0]}`)
          : "~";
        return;
      case "whoami":
        println(this.remote?.user ?? "demo");
        return;
      case "hostname":
        println(this.remote?.host ?? "demo.local");
        return;
      case "size":
        println(`${this.rows} ${this.cols}`);
        return;
      case "colors": {
        let s = "";
        for (let i = 0; i < 256; i++) {
          s += `${ESC}[48;5;${i}m ${String(i).padStart(3)} ${RESET}`;
          if (i === 15 || (i > 15 && (i - 15) % 6 === 0)) s += "\r\n";
        }
        this.out(s);
        println();
        return;
      }
      case "stress": {
        const n = Math.min(Math.max(Number(args[0]) || 2000, 1), 200_000);
        const lines: string[] = [];
        for (let i = 1; i <= n; i++) {
          lines.push(
            `${fg(16 + (i % 216))}line ${i}${RESET} ${"·".repeat(i % 60)}`,
          );
        }
        this.out(lines.join("\r\n") + "\r\n");
        return;
      }
      case "top":
        this.startTop();
        return;
      case "links":
        for (const l of DEMO_LINKS) println(l);
        return;
      case "load":
        println(demoLoadCommand(args));
        return;
      case "query":
        // Cursor position (DSR 6) and primary device attributes: xterm answers both.
        this.out(`${ESC}[6n${ESC}[c`);
        return;
      case "replies":
        println(`replies: ${this.replies}`);
        return;
      case "job":
        return this.startJob(args);
      case "qutty-hook":
        if (args[0] !== "say") {
          println(
            "usage: qutty-hook say <text> [--mood m] [--action id:label] [--wait]",
          );
          return;
        }
        return this.say(args.slice(1));
      case "exit":
        this.exited = true;
        this.out(
          this.remote
            ? `logout\r\nConnection to ${this.remote.host} closed.\r\n`
            : "logout\r\n",
        );
        this.exit({ exitCode: Number(args[0]) || 0, signal: null });
        return;
      default:
        println(`demo-sh: command not found: ${cmd}`);
        this.status = 127;
    }
  }

  startTop(): void {
    // The alternate screen, like a real full-screen program.
    this.out(`${ESC}[?1049h${ESC}[?25l`);
    const procs = [
      "WindowServer",
      "kernel_task",
      "deno",
      "Qutty",
      "zsh",
      "node",
      "mds_stores",
      "Safari",
    ];
    const draw = () => {
      const now = new Date().toLocaleTimeString();
      let s = `${ESC}[H${ESC}[2J`;
      s += `${BOLD}demo top${RESET} — ${now}   ${DIM}q to quit${RESET}\r\n`;
      s +=
        `Load Avg: ${(Math.random() * 3).toFixed(2)}, ${
          (Math.random() * 3).toFixed(2)
        }  ` +
        `CPU: ${(Math.random() * 40).toFixed(1)}% user\r\n\r\n`;
      s += `${ESC}[7m${"PID".padEnd(7)}${"COMMAND".padEnd(22)}${
        "%CPU".padStart(6)
      }${"MEM".padStart(8)}${
        " ".repeat(Math.max(0, this.cols - 43))
      }${RESET}\r\n`;
      const rows = procs.map((name, i) => ({
        pid: 100 + i * 37,
        name,
        cpu: Math.random() * 30,
        mem: Math.round(Math.random() * 900),
      }))
        .sort((a, b) => b.cpu - a.cpu);
      for (const p of rows.slice(0, Math.max(1, this.rows - 5))) {
        s += `${String(p.pid).padEnd(7)}${p.name.padEnd(22)}${
          p.cpu.toFixed(1).padStart(6)
        }${`${p.mem}M`.padStart(8)}\r\n`;
      }
      this.out(s);
    };
    draw();
    this.topTimer = setInterval(draw, 1000);
  }

  stopTop(): void {
    clearInterval(this.topTimer);
    this.topTimer = undefined;
    this.out(`${ESC}[?25h${ESC}[?1049l`);
    this.prompt();
  }

  dispose(): void {
    if (this.topTimer) clearInterval(this.topTimer);
    this.topTimer = undefined;
    clearTimeout(this.idleTimer);
    clearTimeout(this.jobTimer);
    this.jobTimer = undefined;
  }
}

/** A new demo backend (the app uses the {@linkcode demoBackend} singleton; tests want fresh ones). */
export function createDemoBackend(): PtyBackend {
  const events = new PtyEvents();
  const shells = new Map<string, DemoShell>();
  let next = 0;
  let pid = 4000;

  const get = (id: string) => {
    const s = shells.get(id);
    if (!s) throw new Error(`no such terminal: ${id}`);
    return s;
  };
  // The interface is promise-based: an unknown id rejects rather than throwing synchronously.
  const attempt = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const transfers = fanout<SshTransferEvent>();
  const ssh = createDemoSsh(transfers.emit);
  const hubTiles = fanout<HubSnapshot>();
  const hubAsks = fanout<AskRequest>();
  const hubAskClosed = fanout<string>();
  const hubCompanion = fanout<CompanionUpdate>();
  const hubSays = fanout<SayEvent>();
  const hubControls = fanout<ControlRequest>();
  const hub = createDemoHub({
    tiles: hubTiles.emit,
    ask: hubAsks.emit,
    askClosed: hubAskClosed.emit,
    companion: hubCompanion.emit,
    say: hubSays.emit,
    control: hubControls.emit,
  }, { codexUntrusted: pageParam("codexTrust") === "untrusted" });
  const sandbox = createDemoSandbox();
  const ollama = createDemoOllama();
  const links = createDemoLinks();
  const session = createDemoSession();
  const end = (id: string, e: PtyExit) => {
    shells.get(id)?.dispose();
    shells.delete(id);
    hub.remove(id);
    session.recordExit(id, e);
    events.emitExit(id, e);
  };

  return {
    kind: "demo",
    session,
    spawn(options) {
      // `ssh` and the demo agent tools are programs the demo knows; anything else is the demo
      // shell under its name.
      const remote = options.program === "ssh"
        ? remoteOf(options.args ?? [])
        : undefined;
      // `ollama pull` / `ollama launch <harness>` (lib/ollama/demo.ts) run as a fake pull and a
      // demo agent named after the harness.
      const viaOllama = ollama.command(options.program, options.args);
      const launched = viaOllama?.launch;
      const agent = launched
        ? {
          name: launched.harness,
          label: `${launched.harness} · ${launched.model}`,
        }
        : demoAgentOf(options.program);
      const pulling = viaOllama?.pull;
      const id = `demo-${++next}`;
      const shell = new DemoShell(
        id,
        options.cols,
        options.rows,
        (data) => {
          session.recordData(id, data);
          events.emitData(id, data);
        },
        (e) => setTimeout(() => end(id, e), 0),
        hub,
        {
          name: options.shell ? baseName(options.shell) : "demo-sh",
          ...(remote ? { remote } : {}),
          ...(options.sandbox ? { sandbox: true } : {}),
          ...(agent ? { agent: { name: agent.name, label: agent.label } } : {}),
          ...(pulling ? { pull: { done: () => ollama.pulled(pulling) } } : {}),
        },
      );
      shells.set(id, shell);
      session.recordSpawn(id, options.cols, options.rows);
      hub.add(id, agent?.name, options.sandbox === true, launched?.model);
      // Like a real shell, output arrives after spawn resolves (and is buffered until onData).
      setTimeout(() => {
        if (shells.get(id) === shell) shell.start(); // not if killed already
      }, 0);
      return Promise.resolve({
        id,
        pid: ++pid,
        shell: options.program ?? options.shell ?? "demo-sh",
        cwd: options.cwd ?? "/Users/demo",
      });
    },
    write(id, data) {
      return attempt(() => get(id).input(data));
    },
    resize(id, cols, rows) {
      return attempt(() => {
        const s = get(id);
        s.cols = cols;
        s.rows = rows;
        session.recordResize(id, cols, rows);
      });
    },
    kill(id) {
      if (shells.has(id)) end(id, { exitCode: 0, signal: 1 });
      session.release(id);
      return Promise.resolve();
    },
    keyBindings() {
      return Promise.resolve(null);
    },
    launchables() {
      return Promise.resolve(structuredClone(DEMO_LAUNCHABLES));
    },
    sandboxStatus: () => sandbox.status(),
    sandboxConfigure: (settings) => sandbox.configure(settings),
    sandboxCheck: () => sandbox.check(),
    sandboxEnsure: (settings) => sandbox.ensure(settings),
    sandboxAction: (action) => sandbox.action(action),
    ollamaStatus: () => ollama.status(),
    ollamaLibrary: (query, opts) => ollama.library(query, opts),
    ollamaLibraryModel: (name) => ollama.libraryModel(name),
    ollamaOpenApp: () => ollama.openApp(),
    linkResolve: (cwd, paths) => links.resolve(cwd, paths),
    linkOpen: (request) => links.open(request),
    linkEditors: () => links.editors(),
    linkEdit: (request) => links.edit(request),
    sysSample: () => Promise.resolve(demoSample()),
    info(id) {
      return attempt(() => {
        const s = get(id);
        return {
          id,
          pid: 4000 + Number(id.slice(5)),
          process: s.process,
          cwd: s.cwd === "~" ? "/Users/demo" : s.cwd,
        };
      });
    },
    onData: (id, cb) => events.onData(id, cb),
    onExit: (id, cb) => events.onExit(id, cb),
    sshHosts: () => ssh.sshHosts(),
    sshSaveHost: (host) => ssh.sshSaveHost(host),
    sshDeleteHost: (alias) => ssh.sshDeleteHost(alias),
    sshCommand: (target) => ssh.sshCommand(target),
    sshUpload: (args) => ssh.sshUpload(args),
    sshDownload: (args) => ssh.sshDownload(args),
    sshList: (args) => ssh.sshList(args),
    sshCancel: (transferId) => ssh.sshCancel(transferId),
    sshForwards: (target) => ssh.sshForwards(target),
    sshForwardAdd: (args) => ssh.sshForwardAdd(args),
    sshForwardCancel: (args) => ssh.sshForwardCancel(args),
    sshSaveForwards: (args) => ssh.sshSaveForwards(args),
    onTransfer: (cb) => transfers.on(cb),
    hubSnapshot: () => hub.snapshot(),
    hubAnswer: (id, action) => hub.answer(id, action),
    hubSetLabel: (ptyId, label) => hub.setLabel(ptyId, label),
    onHubTiles: (cb) => hubTiles.on(cb),
    onHubAsk: (cb) => hubAsks.on(cb),
    onHubAskClosed: (cb) => hubAskClosed.on(cb),
    integrationStatus: () => hub.integrationStatus(),
    integrationInstall: (target) => hub.integrationInstall(target),
    integrationUninstall: (target) => hub.integrationUninstall(target),
    companionStatus: () => hub.companion.status(),
    companionSend: (text, via) => hub.companion.send(text, via),
    companionConfigure: (enabled, model, engine) =>
      hub.companion.configure(enabled, model, engine),
    companionSayDone: (id, action) => hub.companion.sayDone(id, action),
    hubControlDone: (requestId, result) =>
      hub.companion.controlDone(requestId, result),
    onCompanion: (cb) => hubCompanion.on(cb),
    onHubSay: (cb) => hubSays.on(cb),
    onHubControl: (cb) => hubControls.on(cb),
  };
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

/** The page's query parameter `name` (`null`: absent, or no location). */
function pageParam(name: string): string | null {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get(name);
  } catch {
    return null;
  }
}

/** Whether this page runs inside the Deno Desktop window (the runtime-injected marker). */
export function isDesktop(): boolean {
  return desktopOs() !== undefined;
}

let desktopSingleton: PtyBackend | undefined;
let demoSingleton: PtyBackend | undefined;

/** The desktop-extension backend (only works inside the desktop window). */
export function desktopBackend(): PtyBackend {
  return (desktopSingleton ??= createDesktopBackend());
}

/** The in-browser fake shell. */
export function demoBackend(): PtyBackend {
  return (demoSingleton ??= createDemoBackend());
}

/**
 * The backend for this page: the desktop extension inside the desktop window, else the demo
 * shell. `?pty=demo` forces the demo.
 */
export function getPtyBackend(): PtyBackend {
  let forceDemo = false;
  try {
    forceDemo =
      new URLSearchParams(globalThis.location?.search ?? "").get("pty") ===
        "demo";
  } catch { /* no location (SSR) */ }
  return !forceDemo && isDesktop() ? desktopBackend() : demoBackend();
}
