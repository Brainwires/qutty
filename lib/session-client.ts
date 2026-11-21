// The page side of the workspaces (desktop/session.ts): join the window's workspace (its snapshot
// and its terminals with their replay), save the snapshot, list / reopen / end workspaces, and
// close this window and end its shells (the Shell menu's "Close Window and End Its Shells" and
// the quit question are the app process's own: desktop/session.ts). `createDesktopSession` talks
// to the `session` extension; `createDemoSession` is the in-browser stand-in (one workspace, kept while the page lives), so a
// remount of the workspace (the e2e suite's stand-in for a closed and reopened window) goes
// through the same restore path.
//
// Client-safe: the extension is imported for its types only.

import type { desktopExtension, onDesktopEvent } from "denext/desktop/client";
import type sessionExtension from "../desktop/session.ts";
import type {
  DockCommand,
  DragHover,
  MoveRequestEvent,
  MoveResult,
  MoveTarget,
  SessionJoin,
  TileArrival,
  WorkspaceInfo,
} from "../desktop/session.ts";
import type { DragOver, MoveRequest } from "../desktop/tile-move.ts";
import type { JoinedPty } from "./workspace/session.ts";
import { foldReplay, type ReplayExit } from "./workspace/replay.ts";
import {
  isFreshMenuEvent,
  newWorkspaceId,
  workspaceTitle,
  workspaceWindow,
} from "./workspace/windows.ts";

export type {
  DockCommand,
  DragHover,
  DragOver,
  MoveRequest,
  MoveResult,
  MoveTarget,
  TileArrival,
  WorkspaceInfo,
};

/**
 * Moving this window's tiles to other windows (desktop/tile-move.ts): the header menu's "Move to
 * Window", the header dragged out of the window, and the tiles that arrive here.
 */
export interface TileMoves {
  /** A tile can tear off into a new window (the desktop app). */
  readonly newWindow: boolean;
  /** A header dragged out of the window can drop on another one (the desktop app). */
  readonly drag: boolean;
  /** The other windows (most recently focused first). */
  targets(): Promise<MoveTarget[]>;
  move(request: MoveRequest): Promise<MoveResult>;
  /** The tiles moved here that wait for this page, each terminal ready to adopt. */
  arrivals(): Promise<TileArrival[]>;
  /** A dragged tile is outside this window: which window is under the pointer. */
  dragOver(over: DragOver): Promise<{ target: string | null }>;
  dragEnd(): Promise<void>;
  /** A tile moved here (pull `arrivals`). */
  onArrived(cb: () => void): () => void;
  /** One of this window's tiles moved away. */
  onLeft(cb: (e: { tile: string; move: string }) => void): () => void;
  /** Another window's tile is dragged over this one (or left it). */
  onHover(cb: (e: DragHover) => void): () => void;
  /** The Window menu asks to move the focused tile (`to`: a window id or `"new"`). */
  onRequest(cb: (to: string) => void): () => void;
}

/** What `join` gives the page. */
export interface SessionJoined {
  workspace: { id: string; name: string };
  snapshot: unknown;
  ptys: JoinedPty[];
}

/** A close-request handler: `true` lets the window close (see {@linkcode SessionBackend.guardClose}). */
export type CloseGuard = (
  reason: "close" | "quit",
) => boolean | Promise<boolean>;

/** The workspaces as one window sees them. */
export interface SessionBackend {
  /** Several windows and detached workspaces (the desktop app); the demo has one workspace. */
  readonly multiWindow: boolean;
  /** Show this window's workspace: what it saved before and its terminals, attached here. */
  join(): Promise<SessionJoined>;
  /** Save this window's snapshot (lib/workspace/session.ts). */
  /**
   * Save this window's snapshot (lib/workspace/session.ts); `arrived`: the moves whose tiles it
   * shows now (they no longer wait in the app's process).
   */
  save(snapshot: unknown, arrived?: string[]): Promise<void>;
  /** Moving tiles between windows (absent: one window only). */
  readonly moves?: TileMoves;
  list(): Promise<WorkspaceInfo[]>;
  /** Show detached workspace `id` in a window of its own. */
  reopen(id: string): Promise<void>;
  /**
   * A new, empty workspace in a new window (as Cmd+N). `query` (`?worktree=…`) opens it as a
   * worktree's workspace (lib/scm/worktrees.ts).
   */
  newWindow(query?: string): Promise<void>;
  /** End workspace `id` for real: its terminals are killed (and its sandbox stopped). */
  end(id: string): Promise<void>;
  /**
   * Close this window and end its workspace for real: the workspace is ended once the window has
   * closed, so it is not offered for reopening. `confirm`: the OS's message box asks first when an
   * agent there is busy (without it the user confirmed already).
   */
  endWindow(options?: { confirm?: boolean }): Promise<void>;
  /**
   * Close this window without asking the close guard: its workspace detaches (its shells keep
   * running for Reopen Closed Window, the Dock and the next launch).
   */
  closeWindow(): Promise<void>;
  /**
   * Hold this window's close requests (its close button) for `handler`, which answers whether
   * the window may close. Resolves to the unregistration, or `null` where there is no close guard
   * (the demo, an older runtime): the window then just closes.
   */
  guardClose(handler: CloseGuard): Promise<(() => void) | null>;
  /** This window took the focus. */
  focus(): Promise<void>;
  /**
   * Settings → "Keep shells running after quitting": whether the tiles' shells run in the PTY
   * daemon, which the quit can leave them with (desktop/kept-shells.ts). An app-wide setting the
   * app process keeps.
   */
  keepShells(): Promise<boolean>;
  /** Change it; resolves to the setting now. */
  setKeepShells(on: boolean): Promise<boolean>;
  onChanged(cb: (workspaces: WorkspaceInfo[]) => void): () => void;
  /** The Dock menu's commands for this window (absent: no Dock menu, the demo). */
  readonly dockCommands?: DockCommands;
}

/**
 * The Dock menu's commands for this window (desktop/dock-menu.ts): they wait in the app's
 * process until the page takes them, each once.
 */
export interface DockCommands {
  /** The waiting commands, oldest first. */
  take(): Promise<DockCommand[]>;
  /** Commands are waiting (take them). */
  onWaiting(cb: () => void): () => void;
}

/** The window calls the desktop session uses (`denext/desktop/window`), injectable for tests. */
export interface SessionWindowDeps {
  openWindow(
    options: { url: string; key: string; title?: string },
  ): Promise<unknown>;
  closeWindow(): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  /** `denext/desktop/window`'s `onCloseRequested`. */
  onCloseRequested(
    handler: (
      event: { reason: "close" | "quit" },
    ) => boolean | Promise<boolean>,
  ): () => void;
  /** `denext/desktop/window`'s `windowCapabilities` (its `closeGuard` only). */
  windowCapabilities(): Promise<{ closeGuard: boolean }>;
}

/**
 * The desktop session. `adopt(id, seq)` runs for each joined terminal before `join` resolves: the
 * PTY backend drops output it buffered for that id from the event stream's replay and continues
 * after `seq` (the replay holds it all).
 */
export function createDesktopSession(deps: {
  desktopExtension: typeof desktopExtension;
  onDesktopEvent: typeof onDesktopEvent;
  window: SessionWindowDeps;
  /** Subscribe to the PTY events before the terminals are attached (their output must not be lost). */
  listen(): void;
  adopt(id: string, seq: number): void;
}): SessionBackend {
  const ext = deps.desktopExtension<typeof sessionExtension>("session");
  const win = deps.window;
  return {
    multiWindow: true,
    async join() {
      deps.listen();
      const joined: SessionJoin = await ext.join({});
      for (const p of joined.ptys) deps.adopt(p.id, p.seq);
      // The Window menu lists the windows (and Reopen Closed Window the closed ones) by title:
      // Denext follows `document.title`, and `setWindowTitle` sets the window's own.
      const title = workspaceTitle(joined.workspace.name);
      if (typeof document !== "undefined") document.title = title;
      void win.setWindowTitle(title).catch(() => {});
      return joined;
    },
    save: (snapshot, arrived) =>
      ext.save(arrived?.length ? { snapshot, arrived } : { snapshot }),
    moves: {
      newWindow: true,
      drag: true,
      targets: () => ext.moveTargets({}),
      move: (request) => ext.moveTile(request),
      async arrivals() {
        deps.listen();
        const list: TileArrival[] = await ext.arrivals({});
        for (const a of list) if (a.pty) deps.adopt(a.pty.id, a.pty.seq);
        return list;
      },
      dragOver: (over) => ext.dragOver(over),
      dragEnd: () => ext.dragEnd({}),
      onArrived: (cb) =>
        deps.onDesktopEvent<{ move: string }>(
          "session",
          "tileArrived",
          () => cb(),
        ),
      onLeft: (cb) =>
        deps.onDesktopEvent<{ tile: string; move: string }>(
          "session",
          "tileLeft",
          cb,
        ),
      onHover: (cb) =>
        deps.onDesktopEvent<DragHover>("session", "dragHover", cb),
      onRequest: (cb) =>
        deps.onDesktopEvent<MoveRequestEvent>(
          "session",
          "moveRequest",
          (e) => {
            if (isFreshMenuEvent(e.at, Date.now())) cb(e.to);
          },
        ),
    },
    list: () => ext.list({}),
    async reopen(id) {
      await deps.window.openWindow(workspaceWindow(id));
    },
    async newWindow(query) {
      await deps.window.openWindow(
        workspaceWindow(newWorkspaceId(), true, query ?? ""),
      );
    },
    async end(id) {
      await ext.end({ id });
    },
    // Have this window's workspace ended once the window has closed, then close the window.
    async endWindow(options) {
      const confirm = options?.confirm === true;
      if ((await ext.endWindow({ confirm })).close) await win.closeWindow();
    },
    closeWindow: () => win.closeWindow(),
    async guardClose(handler) {
      const caps = await win.windowCapabilities().catch(() => null);
      if (caps?.closeGuard !== true) return null;
      return win.onCloseRequested(({ reason }) => handler(reason));
    },
    focus: () => ext.focus({}),
    keepShells: () => ext.keepShells({}),
    setKeepShells: (on) => ext.setKeepShells({ on }),
    onChanged: (cb) =>
      deps.onDesktopEvent<{ workspaces: WorkspaceInfo[] }>(
        "session",
        "changed",
        (e) => cb(e.workspaces),
      ),
    dockCommands: {
      take: () => ext.takeDockCommands({}),
      onWaiting: (cb) =>
        deps.onDesktopEvent("session", "dockCommand", () => cb()),
    },
  };
}

/** The most output the demo keeps per terminal for a remount. */
const DEMO_REPLAY_CHARS = 256 * 1024;

/** One demo terminal's output, kept for a remount (the backend's replay ring, in miniature). */
export interface DemoRecord {
  chunks: { seq: number; data: string }[];
  size: number;
  seq: number;
  exit?: ReplayExit;
  cols: number;
  rows: number;
}

/** A demo terminal's replay, as a joining page gets it. */
function joinedOf(id: string, r: DemoRecord): JoinedPty {
  return {
    id,
    cols: r.cols,
    rows: r.rows,
    ...foldReplay([
      ...r.chunks.map((data) => ({ event: "data", data })),
      ...(r.exit ? [{ event: "exit", data: r.exit }] : []),
    ]),
  };
}

/** The demo's tile moves between pages (lib/demo-windows.ts): {@linkcode TileMoves} plus acks. */
export interface DemoTileMoves extends TileMoves {
  /** This page's workspace (`Workspace <name>`). */
  readonly workspace: { id: string; name: string };
  /** The page saved these moves' tiles. */
  ack(moves: readonly string[]): void;
}

/**
 * The demo session: one workspace, kept as long as the page. The demo backend reports its
 * terminals' output, sizes and exits here (`record*`), and a remounted workspace joins them.
 */
export function createDemoSession(moves?: DemoTileMoves): SessionBackend & {
  recordSpawn(id: string, cols: number, rows: number): void;
  recordData(id: string, data: string): void;
  recordResize(id: string, cols: number, rows: number): void;
  recordExit(id: string, exit: ReplayExit): void;
  release(id: string): void;
  /** Take terminal `id`'s record away (it moves to another page), or `undefined`. */
  takeRecord(id: string): DemoRecord | undefined;
  /** Keep a record that came from another page under terminal `id`. */
  putRecord(id: string, record: DemoRecord): void;
  /** Terminal `id`'s replay, as a joining page gets it. */
  joined(id: string): JoinedPty | undefined;
} {
  const records = new Map<string, DemoRecord>();
  let snapshot: unknown = null;
  let keepShells = true;
  const none = () => () => {};
  return {
    multiWindow: false,
    join: () =>
      Promise.resolve({
        workspace: moves?.workspace ?? { id: "demo", name: "Workspace 1" },
        snapshot,
        ptys: [...records].map(([id, r]) => joinedOf(id, r)),
      }),
    ...(moves ? { moves } : {}),
    save(s, arrived) {
      snapshot = s;
      if (arrived) moves?.ack(arrived);
      return Promise.resolve();
    },
    list: () => Promise.resolve([]),
    reopen: () => Promise.resolve(),
    newWindow: () => Promise.resolve(),
    end: () => Promise.resolve(),
    endWindow: () => Promise.resolve(),
    closeWindow: () => Promise.resolve(),
    guardClose: () => Promise.resolve(null),
    focus: () => Promise.resolve(),
    // The demo's shells never outlive the page; the setting is only remembered.
    keepShells: () => Promise.resolve(keepShells),
    setKeepShells(on) {
      keepShells = on;
      return Promise.resolve(keepShells);
    },
    onChanged: none,
    recordSpawn(id, cols, rows) {
      records.set(id, { chunks: [], size: 0, seq: 0, cols, rows });
    },
    recordData(id, data) {
      const r = records.get(id);
      if (!r) return;
      r.chunks.push({ seq: ++r.seq, data });
      r.size += data.length;
      while (r.size > DEMO_REPLAY_CHARS && r.chunks.length > 1) {
        r.size -= r.chunks.shift()!.data.length;
      }
    },
    recordResize(id, cols, rows) {
      const r = records.get(id);
      if (r) Object.assign(r, { cols, rows });
    },
    recordExit(id, exit) {
      const r = records.get(id);
      if (r) r.exit = exit;
    },
    release: (id) => void records.delete(id),
    takeRecord(id) {
      const r = records.get(id);
      records.delete(id);
      return r && structuredClone(r);
    },
    putRecord: (id, record) => void records.set(id, record),
    joined(id) {
      const r = records.get(id);
      return r && joinedOf(id, r);
    },
  };
}
