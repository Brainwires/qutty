// The page side of the workspaces (desktop/session.ts): join the window's workspace (its snapshot
// and its terminals with their replay), save the snapshot, list / reopen / end workspaces, and the
// Window menu's "Close Window and End Its Shells" (the quit question is the app process's own,
// a native message box). `createDesktopSession` talks to the `session` extension;
// `createDemoSession` is the in-browser stand-in (one workspace, kept while the page lives), so a
// remount of the workspace (the e2e suite's stand-in for a closed and reopened window) goes
// through the same restore path.
//
// Client-safe: the extension is imported for its types only.

import type { desktopExtension, onDesktopEvent } from "denext/desktop/client";
import type { AppMenuItem } from "denext/desktop/app";
import type sessionExtension from "../desktop/session.ts";
import type { SessionJoin, WorkspaceInfo } from "../desktop/session.ts";
import type { JoinedPty } from "./workspace/session.ts";
import { foldReplay, type ReplayExit } from "./workspace/replay.ts";
import {
  CLOSE_AND_END_ITEM,
  newWorkspaceId,
  windowMenu,
  workspaceTitle,
  workspaceWindow,
} from "./workspace/windows.ts";

export type { WorkspaceInfo };

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
  save(snapshot: unknown): Promise<void>;
  list(): Promise<WorkspaceInfo[]>;
  /** Show detached workspace `id` in a window of its own. */
  reopen(id: string): Promise<void>;
  /** A new, empty workspace in a new window (as Cmd+N). */
  newWindow(): Promise<void>;
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
  onChanged(cb: (workspaces: WorkspaceInfo[]) => void): () => void;
}

/**
 * The window and menu calls the desktop session uses (`denext/desktop/window`,
 * `denext/desktop/app`), injectable for tests.
 */
export interface SessionWindowDeps {
  openWindow(
    options: { url: string; key: string; title?: string },
  ): Promise<unknown>;
  closeWindow(): Promise<void>;
  setWindowTitle(title: string): Promise<void>;
  setAppMenu(menu: readonly AppMenuItem[]): Promise<void>;
  onAppMenuItem(handler: (id: string) => void): () => void;
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
  /**
   * Have this window's workspace ended once the window has closed, then close the window
   * (`menu`: the Window menu's click, which the extension may decline; see its `endWindow`).
   */
  const endWindow = async (menu: boolean, confirm = false) => {
    if ((await ext.endWindow({ menu, confirm })).close) await win.closeWindow();
  };
  let menuSet = false;
  /**
   * The Window menu's "Close Window and End Its Shells". Denext queues an application-menu click
   * for every window, even with the main window closed (runtime 3.0.0-denext.16 takes it from
   * `Deno.desktop`'s app-wide `menuclick`); the `session` extension acts for the window used last
   * only.
   */
  const installMenu = () => {
    if (menuSet) return;
    menuSet = true;
    void win.setAppMenu(windowMenu()).catch(() => {});
    win.onAppMenuItem((id) => {
      if (id === CLOSE_AND_END_ITEM) void endWindow(true).catch(() => {});
    });
  };
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
      installMenu();
      return joined;
    },
    save: (snapshot) => ext.save({ snapshot }),
    list: () => ext.list({}),
    async reopen(id) {
      await deps.window.openWindow(workspaceWindow(id));
    },
    async newWindow() {
      await deps.window.openWindow(workspaceWindow(newWorkspaceId(), true));
    },
    async end(id) {
      await ext.end({ id });
    },
    endWindow: (options) => endWindow(false, options?.confirm === true),
    closeWindow: () => win.closeWindow(),
    async guardClose(handler) {
      const caps = await win.windowCapabilities().catch(() => null);
      if (caps?.closeGuard !== true) return null;
      return win.onCloseRequested(({ reason }) => handler(reason));
    },
    focus: () => ext.focus({}),
    onChanged: (cb) =>
      deps.onDesktopEvent<{ workspaces: WorkspaceInfo[] }>(
        "session",
        "changed",
        (e) => cb(e.workspaces),
      ),
  };
}

/** The most output the demo keeps per terminal for a remount. */
const DEMO_REPLAY_CHARS = 256 * 1024;

/** One demo terminal's output, kept for a remount (the backend's replay ring, in miniature). */
interface DemoRecord {
  chunks: { seq: number; data: string }[];
  size: number;
  seq: number;
  exit?: ReplayExit;
  cols: number;
  rows: number;
}

/**
 * The demo session: one workspace, kept as long as the page. The demo backend reports its
 * terminals' output, sizes and exits here (`record*`), and a remounted workspace joins them.
 */
export function createDemoSession(): SessionBackend & {
  recordSpawn(id: string, cols: number, rows: number): void;
  recordData(id: string, data: string): void;
  recordResize(id: string, cols: number, rows: number): void;
  recordExit(id: string, exit: ReplayExit): void;
  release(id: string): void;
} {
  const records = new Map<string, DemoRecord>();
  let snapshot: unknown = null;
  const none = () => () => {};
  return {
    multiWindow: false,
    join: () =>
      Promise.resolve({
        workspace: { id: "demo", name: "Workspace 1" },
        snapshot,
        ptys: [...records].map(([id, r]) => ({
          id,
          cols: r.cols,
          rows: r.rows,
          ...foldReplay([
            ...r.chunks.map((data) => ({ event: "data", data })),
            ...(r.exit ? [{ event: "exit", data: r.exit }] : []),
          ]),
        })),
      }),
    save(s) {
      snapshot = s;
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
  };
}
