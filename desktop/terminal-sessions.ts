// The app's terminals as detachable sessions: a PtyHost (desktop/pty.ts) whose terminals belong to
// workspaces (desktop/workspace-host.ts) and are owned, for routing, by the window showing their
// workspace. Built on denext's `createOwnedResources` (`onOwnerClosed: "detach"`, a replay ring per
// terminal): the window's close detaches its terminals, the app's quit disposes them all.
//
// - Events (`data` `{ seq, data }`, `exit` `{ exitCode, signal }`) reach the owner window only,
//   as `{ id, data }`; while detached they are only kept in the terminal's replay.
// - `attachWorkspace` hands every terminal of a workspace to the window that shows it now, with
//   its replay folded (lib/workspace/replay.ts) and its grid size.
// - A terminal is released (unregistered, killed if still running) when its tile closes (`kill`),
//   when its workspace is ended, and at the quit. An ended terminal stays registered until then, so
//   a reattached window still shows how it ended.
// - A window's calls only reach the terminals it owns (another window's id is `not_found`).
//
// The extension (desktop/pty.ts) keeps one instance connected to its host; tests and the
// packaged-app self-test connect one to a fake host.

import {
  createOwnedResources,
  DesktopCapError,
  type OwnedResources,
  type OwnedResourcesHost,
} from "denext/desktop";
import {
  type DenoPty,
  type DenoPtyOptions,
  type PtyDataEvent,
  type PtyEmit,
  type PtyExitEvent,
  type PtyHost,
  type PtyInfo,
  type PtySpawnArgs,
  type PtySpawnResult,
} from "./pty.ts";
import type { WorkspaceRegistry } from "./workspace-host.ts";
import { type FoldedReplay, foldReplay } from "../lib/workspace/replay.ts";

/**
 * Each terminal's replay ring buffer: about 1 MiB of output (denext measures a retained event as
 * its JSON, so escape-heavy output counts a little more). A full 5000-line xterm scrollback of a
 * typical shell is well under it; a terminal that printed more replays its last megabyte.
 */
export const REPLAY_BYTES = 1024 * 1024;

/** One terminal handed to a window ({@linkcode TerminalSessions.attachWorkspace}). */
export interface PtyReplay extends FoldedReplay {
  /** The PTY id. */
  id: string;
  /** Its grid size now (the replay was drawn at it). */
  cols: number;
  rows: number;
}

/** Start a terminal in the PTY daemon as `id` (desktop/kept-shells.ts), or `undefined`: not now. */
export type RemoteOpen = (
  id: string,
  options: DenoPtyOptions,
) => Promise<DenoPty | undefined>;

/** A window's id and key, for the calls that come from it. */
export interface CallerWindow {
  /** `ctx.windowId` (`"main"` when absent). */
  id: string;
}

/** Terminals in workspaces, routed to the window showing each workspace. */
export class TerminalSessions {
  readonly host: PtyHost;
  readonly #owned: OwnedResources<string>;
  readonly #ws: WorkspaceRegistry;
  readonly #sizes = new Map<string, { cols: number; rows: number }>();
  /** Killed by their tile: released once their exit has been emitted. */
  readonly #releasing = new Set<string>();
  #win: OwnedResourcesHost | undefined;
  #off: (() => void) | undefined;

  constructor(opts: {
    workspaces: WorkspaceRegistry;
    /** Builds the PTY host with the emit that routes its events. */
    host: (emit: PtyEmit) => PtyHost;
    replayBytes?: number;
  }) {
    this.#ws = opts.workspaces;
    this.#owned = createOwnedResources<string>({
      onOwnerClosed: "detach",
      dispose: (id) => this.#dispose(id),
      replay: {
        maxBytes: opts.replayBytes ?? REPLAY_BYTES,
        events: ["data", "exit"],
      },
    });
    this.host = opts.host((event, data) => this.#route(event, data));
  }

  /**
   * Wire to the extension's host: owner windows' closes detach their terminals and their
   * workspaces, the quit disposes every terminal, an ended workspace's terminals are released.
   */
  connect(host: OwnedResourcesHost): () => void {
    this.#off?.(); // a second setup (tests) replaces the first host
    this.#win = host;
    const offOwned = this.#owned.connect(host);
    const offClosed = host.onWindowClosed((info) => {
      if (info.appQuitting) this.#ws.clear();
      else this.#ws.windowClosed(info.id);
    });
    const offEnded = this.#ws.onEnded((_id, ptys) => {
      for (const p of ptys) void this.#owned.remove(p);
    });
    const off = () => {
      offOwned();
      offClosed();
      offEnded();
      if (this.#off === off) this.#off = undefined;
      this.#win = undefined;
    };
    this.#off = off;
    return off;
  }

  /** The key of window `id` (its workspace id), from the host's open windows. */
  keyOf(windowId: string): string | undefined {
    return this.#win?.windows().find((w) => w.id === windowId)?.key;
  }

  /** The workspace the window shows (joined on first use). */
  workspaceOf(windowId: string): string {
    return this.#ws.workspaceForWindow(windowId, this.keyOf(windowId));
  }

  /**
   * Where new terminals run: given the id and the PTY options, the PTY daemon's terminal, or
   * `undefined` to run it in this process (desktop/kept-shells.ts installs it).
   */
  #remote: RemoteOpen | undefined;

  /** Install (or with `undefined` remove) the PTY daemon's opener. */
  setRemote(open: RemoteOpen | undefined): void {
    this.#remote = open;
  }

  async spawn(
    args: PtySpawnArgs,
    caller: CallerWindow,
  ): Promise<PtySpawnResult> {
    return await this.#start(
      this.workspaceOf(caller.id),
      args,
      caller.id,
    );
  }

  /**
   * Start a terminal in workspace `workspace`, owned by window `window` (none: it waits detached
   * for the window that shows the workspace, as a restored shell does).
   */
  async #start(
    workspace: string,
    args: PtySpawnArgs,
    window: string | undefined,
    prelude?: string,
  ): Promise<PtySpawnResult> {
    const remote = args.sandbox ? undefined : this.#remote;
    return await this.host.spawn(args, {
      owner: workspace,
      ...(prelude ? { prelude } : {}),
      ...(remote
        ? {
          // The daemon, else (it is gone, or refused) this process.
          open: (id, options) =>
            remote(id, options).catch((err) => {
              console.warn(
                `pty: the PTY daemon did not start ${id}; it runs in the app`,
                err,
              );
              return undefined;
            }),
        }
        : {}),
      onCreated: (id) => {
        this.#owned.add(id, id, window === undefined ? {} : { owner: window });
        this.#ws.addPty(workspace, id);
        this.#sizes.set(id, { cols: args.cols, rows: args.rows });
      },
    });
  }

  /**
   * A shell restored from the last session (its daemon was gone): started in workspace
   * `workspace`, detached until its window shows it, with `prelude` (its dimmed history) first.
   */
  async restoreShell(
    workspace: string,
    args: PtySpawnArgs,
    prelude: string,
  ): Promise<PtySpawnResult> {
    return await this.#start(workspace, args, undefined, prelude);
  }

  /**
   * Take on a terminal the PTY daemon kept from the last launch, as `id` in workspace
   * `workspace`: detached until a window shows the workspace, its `replay` first.
   */
  adopt(
    workspace: string,
    id: string,
    pty: DenoPty,
    info: { shell: string; cwd: string; cols: number; rows: number },
    replay: string,
  ): void {
    this.host.adopt(id, pty, {
      shell: info.shell,
      cwd: info.cwd,
      owner: workspace,
      replay,
      onCreated: () => {
        this.#owned.add(id, id, {});
        this.#ws.addPty(workspace, id);
        this.#sizes.set(id, { cols: info.cols, rows: info.rows });
      },
    });
  }

  /** Every terminal the sessions know (running or ended, not yet released). */
  ids(): string[] {
    return [...this.#sizes.keys()];
  }

  /** The running terminals that live in the PTY daemon (what a quit can keep). */
  remoteIds(): string[] {
    return [...this.#sizes.keys()].filter((id) => this.host.isRemote(id));
  }

  /** Terminal `id`'s grid size. */
  sizeOf(id: string): { cols: number; rows: number } | undefined {
    return this.#sizes.get(id);
  }

  /**
   * Let terminal `id` go without ending it (the quit that keeps the shells): the app forgets it,
   * its PTY runs on in the daemon.
   */
  letGo(id: string): void {
    this.host.release(id);
    this.#sizes.delete(id);
  }

  /** `id` must be a terminal the calling window owns. */
  #check(id: string, caller: CallerWindow): void {
    if (this.#owned.owner(id) !== caller.id) {
      throw new DesktopCapError("not_found", "no such terminal", {
        status: 404,
      });
    }
  }

  async write(
    id: string,
    data: string,
    binary: boolean,
    caller: CallerWindow,
  ): Promise<void> {
    this.#check(id, caller);
    await this.host.write(id, data, binary);
  }

  resize(id: string, cols: number, rows: number, caller: CallerWindow): void {
    this.#check(id, caller);
    this.host.resize(id, cols, rows);
    this.#sizes.set(id, { cols, rows });
  }

  async info(id: string, caller: CallerWindow): Promise<PtyInfo> {
    this.#check(id, caller);
    return await this.host.info(id);
  }

  /** The tile closed: kill the terminal (if it runs) and release it once its exit went out. */
  kill(id: string, caller: CallerWindow): void {
    if (this.#owned.get(id) === undefined) return; // released already
    this.#check(id, caller);
    if (!this.host.isRunning(id)) {
      void this.#owned.remove(id); // ended already
      return;
    }
    this.#releasing.add(id);
    this.host.kill(id);
  }

  /**
   * Window `windowId` shows workspace `workspace` now: each of its terminals is handed over, and
   * returned with its replay and size.
   */
  attachWorkspace(workspace: string, windowId: string): PtyReplay[] {
    const out: PtyReplay[] = [];
    for (const id of this.#ws.ptysOf(workspace)) {
      if (this.#owned.get(id) === undefined) {
        this.#ws.removePty(id);
        continue;
      }
      const { replay } = this.#owned.attach(id, windowId);
      const size = this.#sizes.get(id) ?? { cols: 80, rows: 24 };
      out.push({ id, ...size, ...foldReplay(replay) });
    }
    return out;
  }

  /**
   * Hand terminal `id` to window `windowId` (its tile moved there, desktop/tile-move.ts): its events
   * go there from now on, and it is returned with its replay and size. `undefined`: it is not
   * registered (released already).
   */
  handOver(id: string, windowId: string): PtyReplay | undefined {
    if (this.#owned.get(id) === undefined) return undefined;
    const { replay } = this.#owned.attach(id, windowId);
    const size = this.#sizes.get(id) ?? { cols: 80, rows: 24 };
    return { id, ...size, ...foldReplay(replay) };
  }

  /** The window that owns terminal `id` now (`undefined` when detached or unknown). */
  ownerOf(id: string): string | undefined {
    return this.#owned.owner(id);
  }

  /** How many terminals are registered (running or ended, not released). */
  get size(): number {
    return this.#sizes.size;
  }

  /** Release every terminal (the quit; tests). */
  async disposeAll(): Promise<void> {
    await this.#owned.disposeAll();
  }

  #route(event: "data" | "exit", payload: PtyDataEvent | PtyExitEvent): void {
    const { id, ...data } = payload;
    this.#owned.emit(id, event, data);
    if (event === "exit") this.#ws.ptyExited(id);
    if (event === "exit" && this.#releasing.delete(id)) {
      void this.#owned.remove(id);
    }
  }

  #dispose(id: string): void {
    this.#releasing.delete(id);
    this.#sizes.delete(id);
    this.#ws.removePty(id);
    this.host.kill(id);
  }
}
