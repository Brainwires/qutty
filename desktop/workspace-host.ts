// The workspace host: which terminals belong to which workspace, and which window shows it. It
// lives in the app's Deno process with the PTYs (desktop/pty.ts), so both outlive a window: the
// app is kept alive with no window (`desktop.app.keepAlive`), and a window is only a view.
//
// The model (TODO.md, "New Window" + "Detachable sessions"):
//
// - A workspace is a named group of terminals plus the page's snapshot of it (tiles, layout, MRU
//   order), which the page saves here as it changes. Its id is the key of the window that shows it
//   (`desktop.window.key` for the main window, a fresh `ws-…` key for New Window), so a window
//   reopened with the same key (Reopen Closed Window, the session restored at launch, the Dock,
//   the page's Workspaces menu) shows the same workspace again.
// - One window per workspace: denext refuses a second open window with the same key.
// - Closing a window detaches its workspace: the terminals keep running and their output keeps
//   filling each PTY's replay buffer. A workspace with no terminals is simply dropped.
// - Ending a workspace (the page's "End workspace", the Window menu's "Close Window and End Its
//   Shells") kills its terminals and lets the sandbox container go (`onEnded`); desktop.ts then
//   forgets its window key. A workspace shown in a window is ended once that window has closed
//   (`endOnClose`), so the close never brings it back to Reopen Closed Window. Quitting the app
//   (Cmd+Q) ends every workspace; when an agent is busy the quit asks first (`beforeQuit`, asked by
//   desktop/session.ts).
// - With no window open the app lives in the menu bar / tray (desktop/tray.ts): its menu lists the
//   workspaces that have terminals and reopens (or focuses) one. Closing the last window keeps the
//   app there while any terminal runs (macOS hides the Dock icon until a window opens again), and
//   quits once none does: the last window's "End Shells", or the last detached terminal exiting.
//   Where there is no tray, the last window's close quits off macOS and leaves a Dock app on macOS.
//
// No runtime API is used here (no `Deno.*`), so the whole state machine is tested without a
// window (tests/workspace_host_test.ts). The singleton {@linkcode workspaces} is shared by the
// `pty`, `session` and `sandbox` extensions and by desktop.ts (the Dock and the window keys).

/** A workspace as the page's Workspaces menu lists it. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  /** `attached`: a window shows it; `detached`: its terminals run with no window. */
  state: "attached" | "detached";
  /** How many terminals it has (running, or ended but not closed yet). */
  terminals: number;
  /** How many of them still run (their shell has not exited). */
  running: number;
  /** How many of them run an agent that is busy right now. */
  busy: number;
  /** When it was detached (ms since the epoch). */
  detachedAt?: number;
}

/** An agent tile that is working right now (the hub's status, desktop/hub.ts). */
export interface BusyTile {
  /** The PTY id (`pty-3`). */
  ptyId: string;
  /** The hub's name for it (`claude`). */
  name: string;
}

/**
 * What the quit guard answers ({@linkcode WorkspaceRegistry.beforeQuit}): go ahead, or cancel
 * the quit and ask about these busy agents first.
 */
export type QuitDecision =
  | { allow: true }
  | { allow: false; busy: BusyTile[] };

interface Workspace {
  id: string;
  name: string;
  window: string | undefined;
  ptys: Set<string>;
  snapshot: unknown;
  detachedAt: number | undefined;
}

/** How long a confirmed quit stays confirmed (the quit is issued again right after). */
const CONFIRM_TTL_MS = 15_000;
/** The id of a workspace whose window has no key (it should not happen; every window has one). */
const UNKEYED_PREFIX = "win-";

/** Every workspace, the window ↔ workspace mapping, and the quit guard. */
export class WorkspaceRegistry {
  readonly #workspaces = new Map<string, Workspace>();
  readonly #byWindow = new Map<string, string>();
  readonly #ptyOwner = new Map<string, string>();
  /** Terminals whose shell exited (their tile still shows them). */
  readonly #exited = new Set<string>();
  /** Open windows, most recently focused first. */
  #focus: string[] = [];
  #named = 0;
  #busy: () => BusyTile[] = () => [];
  #ended = new Set<(id: string, ptys: string[]) => void>();
  #changed = new Set<() => void>();
  #confirmedAt: number | undefined;
  /** Workspaces to end, not detach, once their window closes. */
  readonly #endOnClose = new Set<string>();
  readonly #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
  }

  /** The workspace id a window with this key shows. */
  static idFor(windowId: string, key: string | undefined): string {
    return key ?? `${UNKEYED_PREFIX}${windowId}`;
  }

  /**
   * Window `windowId` (opened with `key`) shows its workspace: created when new, attached when
   * detached. A workspace another window still shows moves to this one (denext keeps keys unique,
   * so only a reload of the same window gets here twice).
   */
  join(windowId: string, key: string | undefined): {
    id: string;
    name: string;
    snapshot: unknown;
    created: boolean;
  } {
    const id = WorkspaceRegistry.idFor(windowId, key);
    let ws = this.#workspaces.get(id);
    const created = ws === undefined;
    if (!ws) {
      ws = {
        id,
        name: `Workspace ${++this.#named}`,
        window: undefined,
        ptys: new Set(),
        snapshot: null,
        detachedAt: undefined,
      };
      this.#workspaces.set(id, ws);
    }
    const before = this.#byWindow.get(windowId);
    if (before !== undefined && before !== id) this.#detach(before);
    if (ws.window !== undefined && ws.window !== windowId) {
      this.#byWindow.delete(ws.window);
    }
    ws.window = windowId;
    ws.detachedAt = undefined;
    this.#byWindow.set(windowId, id);
    this.focused(windowId);
    this.#notify();
    return { id, name: ws.name, snapshot: ws.snapshot, created };
  }

  /** The workspace window `windowId` shows, joining it on first use (a spawn before `join`). */
  workspaceForWindow(windowId: string, key: string | undefined): string {
    return this.#byWindow.get(windowId) ?? this.join(windowId, key).id;
  }

  /** The workspace window `windowId` shows, if it joined one. */
  workspaceOfWindow(windowId: string): string | undefined {
    return this.#byWindow.get(windowId);
  }

  /** The window showing workspace `id` (`undefined` when it is detached or unknown). */
  windowOf(id: string): string | undefined {
    return this.#workspaces.get(id)?.window;
  }

  /** Whether workspace `id` exists (attached or detached). */
  has(id: string): boolean {
    return this.#workspaces.has(id);
  }

  /**
   * A window closed for good: its workspace is detached (or dropped when it has no terminals), or
   * ended when {@linkcode endOnClose} marked it.
   */
  windowClosed(windowId: string): string | undefined {
    this.#focus = this.#focus.filter((w) => w !== windowId);
    const id = this.#byWindow.get(windowId);
    if (id === undefined) return undefined;
    if (this.#endOnClose.delete(id)) {
      this.end(id);
      return id;
    }
    this.#detach(id);
    this.#notify();
    return id;
  }

  /**
   * End workspace `id` when its window closes, instead of detaching it (the window is about to be
   * closed by the page). Ending it after the close keeps it out of the closed windows Denext
   * offers to reopen: its key is forgotten once it has been remembered. A detached workspace is
   * ended at once. Returns whether `id` exists.
   */
  endOnClose(id: string): boolean {
    const ws = this.#workspaces.get(id);
    if (!ws) return false;
    if (ws.window === undefined) this.end(id);
    else this.#endOnClose.add(id);
    return true;
  }

  #detach(id: string): void {
    const ws = this.#workspaces.get(id);
    if (!ws) return;
    if (ws.window !== undefined) this.#byWindow.delete(ws.window);
    ws.window = undefined;
    if (ws.ptys.size === 0) {
      this.#workspaces.delete(id);
      return;
    }
    ws.detachedAt = this.#now();
  }

  /** A terminal started in workspace `id`. */
  addPty(id: string, ptyId: string): void {
    const ws = this.#workspaces.get(id);
    if (!ws) return;
    ws.ptys.add(ptyId);
    this.#ptyOwner.set(ptyId, id);
    this.#notify();
  }

  /** A terminal was closed (its tile went away) or killed. */
  removePty(ptyId: string): void {
    const id = this.#ptyOwner.get(ptyId);
    this.#ptyOwner.delete(ptyId);
    this.#exited.delete(ptyId);
    const ws = id === undefined ? undefined : this.#workspaces.get(id);
    if (!ws) return;
    ws.ptys.delete(ptyId);
    // A detached workspace whose last terminal went away has nothing left to reopen.
    if (ws.ptys.size === 0 && ws.window === undefined) {
      this.#workspaces.delete(ws.id);
    }
    this.#notify();
  }

  /** Terminal `ptyId`'s shell exited (its tile keeps it until closed): it no longer runs. */
  ptyExited(ptyId: string): void {
    if (!this.#ptyOwner.has(ptyId) || this.#exited.has(ptyId)) return;
    this.#exited.add(ptyId);
    this.#notify();
  }

  /** The workspace terminal `ptyId` belongs to. */
  workspaceOfPty(ptyId: string): string | undefined {
    return this.#ptyOwner.get(ptyId);
  }

  /**
   * Where an event about terminal `ptyId` should go: the window showing its workspace, `null`
   * when that workspace is detached (nowhere: it waits for a reattach), `undefined` when the
   * terminal is unknown (every window, as before).
   */
  windowOfPty(ptyId: string): string | null | undefined {
    const id = this.#ptyOwner.get(ptyId);
    if (id === undefined) return undefined;
    return this.#workspaces.get(id)?.window ?? null;
  }

  /** Workspace `id`'s terminals. */
  ptysOf(id: string): string[] {
    return [...(this.#workspaces.get(id)?.ptys ?? [])];
  }

  /** What the page saved for workspace `id` last (`null` when nothing). */
  snapshotOf(id: string): unknown {
    return this.#workspaces.get(id)?.snapshot ?? null;
  }

  /** The page's snapshot of workspace `id` (tiles, layout, MRU order). */
  save(id: string, snapshot: unknown): void {
    const ws = this.#workspaces.get(id);
    if (ws) ws.snapshot = snapshot;
  }

  /**
   * End workspace `id` for real: it is forgotten, and `onEnded` listeners (the PTY host kills
   * its terminals, the sandbox stops its container) are told. Returns its terminals.
   */
  end(id: string): string[] {
    const ws = this.#workspaces.get(id);
    if (!ws) return [];
    this.#workspaces.delete(id);
    this.#endOnClose.delete(id);
    if (ws.window !== undefined) this.#byWindow.delete(ws.window);
    const ptys = [...ws.ptys];
    for (const p of ptys) {
      this.#ptyOwner.delete(p);
      this.#exited.delete(p);
    }
    for (const fn of [...this.#ended]) {
      try {
        fn(id, ptys);
      } catch (err) {
        console.error(`workspace ${id}: an end listener failed`, err);
      }
    }
    this.#notify();
    return ptys;
  }

  /** Call `fn` when a workspace is ended; returns the unsubscribe. */
  onEnded(fn: (id: string, ptys: string[]) => void): () => void {
    this.#ended.add(fn);
    return () => this.#ended.delete(fn);
  }

  /** Call `fn` when the list changes (a join, a detach, a terminal added or removed). */
  onChanged(fn: () => void): () => void {
    this.#changed.add(fn);
    return () => this.#changed.delete(fn);
  }

  #notify(): void {
    for (const fn of [...this.#changed]) {
      try {
        fn();
      } catch (err) {
        console.error("workspaces: a change listener failed", err);
      }
    }
  }

  /** The hub's busy agent tiles (desktop/hub.ts installs it). */
  setBusyProvider(fn: (() => BusyTile[]) | undefined): void {
    this.#busy = fn ?? (() => []);
  }

  #busyTiles(): BusyTile[] {
    try {
      return this.#busy().filter((t) => this.#ptyOwner.has(t.ptyId));
    } catch {
      return [];
    }
  }

  /** The busy agent tiles of workspace `id` (what closing its window would end). */
  busyIn(id: string): BusyTile[] {
    return this.#busyTiles().filter((t) => this.#ptyOwner.get(t.ptyId) === id);
  }

  /** Every workspace: attached ones first (in focus order), then detached, newest first. */
  list(): WorkspaceInfo[] {
    const busy = new Set(this.#busyTiles().map((t) => t.ptyId));
    const rank = (ws: Workspace) => {
      if (ws.window === undefined) return this.#focus.length;
      const i = this.#focus.indexOf(ws.window);
      return i < 0 ? this.#focus.length - 1 : i;
    };
    return [...this.#workspaces.values()]
      .sort((a, b) =>
        rank(a) - rank(b) || (b.detachedAt ?? 0) - (a.detachedAt ?? 0)
      )
      .map((ws) => ({
        id: ws.id,
        name: ws.name,
        state: ws.window === undefined ? "detached" : "attached",
        terminals: ws.ptys.size,
        running: [...ws.ptys].filter((p) => !this.#exited.has(p)).length,
        busy: [...ws.ptys].filter((p) => busy.has(p)).length,
        ...(ws.detachedAt !== undefined ? { detachedAt: ws.detachedAt } : {}),
      }));
  }

  /** The detached workspace closed most recently (what a Dock click with no window reopens). */
  lastDetached(): string | undefined {
    let best: Workspace | undefined;
    for (const ws of this.#workspaces.values()) {
      if (ws.window !== undefined) continue;
      if (!best || (ws.detachedAt ?? 0) > (best.detachedAt ?? 0)) best = ws;
    }
    return best?.id;
  }

  /** Window `windowId` took the focus (the companion talks to the active window). */
  focused(windowId: string): void {
    this.#focus = [windowId, ...this.#focus.filter((w) => w !== windowId)];
  }

  /** The most recently focused window that shows a workspace. */
  activeWindow(): string | undefined {
    return this.#focus.find((w) => this.#byWindow.has(w));
  }

  /**
   * The quit guard: a quit goes ahead when no agent is busy (or the user confirmed it just now).
   * Otherwise it is cancelled, with the busy agents to ask about (desktop/session.ts asks with
   * the OS's message box, then answers with {@linkcode answerQuit} and quits again).
   */
  beforeQuit(): QuitDecision {
    const now = this.#now();
    if (
      this.#confirmedAt !== undefined &&
      now - this.#confirmedAt < CONFIRM_TTL_MS
    ) {
      this.#confirmedAt = undefined;
      return { allow: true };
    }
    this.#confirmedAt = undefined;
    const busy = this.#busyTiles();
    return busy.length === 0 ? { allow: true } : { allow: false, busy };
  }

  /** The user answered the quit question: `true` lets the next quit through. */
  answerQuit(quit: boolean): void {
    this.#confirmedAt = quit ? this.#now() : undefined;
  }

  /** Forget everything (the app is quitting; tests). */
  clear(): void {
    this.#workspaces.clear();
    this.#byWindow.clear();
    this.#ptyOwner.clear();
    this.#exited.clear();
    this.#focus = [];
    this.#endOnClose.clear();
    this.#confirmedAt = undefined;
  }
}

const KEY = Symbol.for("qutty.workspaces");

/**
 * The app's registry, shared by the extensions and desktop.ts. Kept on `globalThis` so the entry
 * and the extension modules share one even if the loader gave them two copies of this module.
 */
export const workspaces: WorkspaceRegistry =
  ((globalThis as Record<symbol, unknown>)[KEY] as
    | WorkspaceRegistry
    | undefined) ??
    ((globalThis as Record<symbol, unknown>)[KEY] =
      new WorkspaceRegistry()) as WorkspaceRegistry;

/** The hub's events (desktop/hub.ts `HubEvent`). */
type HubEventName =
  | "tiles"
  | "ask"
  | "askClosed"
  | "control"
  | "companion"
  | "say";

/**
 * Where one of the hub's events goes with several windows: `{}` is every window, `{ window }`
 * one, `null` none.
 *
 * - `tiles` and `askClosed` are idempotent: every window (each shows only its own tiles).
 * - An agent's `ask` goes to the window showing its tile; while its workspace is detached it
 *   waits in the hub (the page reads it from the snapshot when the workspace is shown again). The
 *   companion's own questions go to the active window.
 * - The companion's `say`, `companion` and `control` go to the active window (the companion
 *   follows the user), or every window when none joined a workspace yet.
 */
export function hubEventTarget(
  registry: WorkspaceRegistry,
  event: HubEventName,
  data: unknown,
): { window?: string } | null {
  if (event === "tiles" || event === "askClosed") return {};
  if (event === "ask") {
    const from = (data as { from?: unknown } | null)?.from;
    const owner = typeof from === "string"
      ? registry.windowOfPty(from)
      : undefined;
    if (owner === null) return null;
    if (owner !== undefined) return { window: owner };
  }
  const active = registry.activeWindow();
  return active === undefined ? {} : { window: active };
}

/** Whether an open question from `from` (a tile id, or the companion) belongs in window `windowId`. */
export function askVisibleIn(
  registry: WorkspaceRegistry,
  from: string,
  windowId: string,
): boolean {
  const owner = registry.windowOfPty(from);
  return owner === undefined || owner === windowId;
}
