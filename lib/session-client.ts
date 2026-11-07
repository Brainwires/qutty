// The page side of the workspaces (desktop/session.ts): join the window's workspace (its snapshot
// and its terminals with their replay), save the snapshot, and the quit question. `createDesktopSession` talks to the `session` extension; `createDemoSession` is
// the in-browser stand-in (one workspace, kept while the page lives), so a remount of the
// workspace (the e2e suite's stand-in for a closed and reopened window) goes through the same
// restore path.
//
// Client-safe: the extension is imported for its types only.

import type { desktopExtension, onDesktopEvent } from "denext/desktop/client";
import type sessionExtension from "../desktop/session.ts";
import type { QuitRequest, SessionJoin } from "../desktop/session.ts";
import type { JoinedPty } from "./workspace/session.ts";
import { foldReplay, type ReplayExit } from "./workspace/replay.ts";

export type { QuitRequest };

/** What `join` gives the page. */
export interface SessionJoined {
  workspace: { id: string; name: string };
  snapshot: unknown;
  ptys: JoinedPty[];
  quit?: QuitRequest;
}

/** The workspaces as one window sees them. */
export interface SessionBackend {
  /** Show this window's workspace: what it saved before and its terminals, attached here. */
  join(): Promise<SessionJoined>;
  /** Save this window's snapshot (lib/workspace/session.ts). */
  save(snapshot: unknown): Promise<void>;
  /** This window took the focus. */
  focus(): Promise<void>;
  /** Answer the quit question; `true` quits the app. */
  answerQuit(quit: boolean): Promise<void>;
  onQuit(cb: (request: QuitRequest) => void): () => void;
}

/** The window calls the desktop session uses (`denext/desktop/window`), injectable for tests. */
export interface SessionWindowDeps {
  quitApp(): Promise<boolean>;
  /** A window opened from desktop.ts or a page gets the default title bar: match the main one. */
  setTitleBarStyle(style: "hiddenInset"): Promise<boolean>;
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
  const loadedAt = Date.now();
  return {
    async join() {
      deps.listen();
      const joined: SessionJoin = await ext.join({});
      for (const p of joined.ptys) deps.adopt(p.id, p.seq);
      void deps.window.setTitleBarStyle("hiddenInset").catch(() => false);
      return joined;
    },
    save: (snapshot) => ext.save({ snapshot }),
    focus: () => ext.focus({}),
    async answerQuit(quit) {
      await ext.answerQuit({ quit });
      if (quit) await deps.window.quitApp();
    },
    // The event stream replays its buffer to a new page: an old question is not asked again
    // (`join` brings the one still open).
    onQuit: (cb) =>
      deps.onDesktopEvent<QuitRequest>("session", "quit", (r) => {
        if (r.at >= loadedAt - 1000) cb(r);
      }),
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
    focus: () => Promise.resolve(),
    answerQuit: () => Promise.resolve(),
    onQuit: none,
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
