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
import type {
  PtyDataEvent,
  PtyEmit,
  PtyExitEvent,
  PtyHost,
  PtyInfo,
  PtySpawnArgs,
  PtySpawnResult,
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

  async spawn(
    args: PtySpawnArgs,
    caller: CallerWindow,
    appSupportDir?: string,
  ): Promise<PtySpawnResult> {
    const workspace = this.workspaceOf(caller.id);
    return await this.host.spawn(args, {
      ...(appSupportDir ? { appSupportDir } : {}),
      owner: workspace,
      onCreated: (id) => {
        this.#owned.add(id, id, { owner: caller.id });
        this.#ws.addPty(workspace, id);
        this.#sizes.set(id, { cols: args.cols, rows: args.rows });
      },
    });
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
