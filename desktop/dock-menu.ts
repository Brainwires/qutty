// The macOS Dock menu (a right click on Qutty's Dock icon), like iTerm2's: the open workspace
// windows (the frontmost one checked; a click brings it forward), New Window, New Terminal,
// "Claude Code (chat)" when Claude Code is installed, "Codex (chat)" when Codex is, and Reopen
// Closed Window ▸ with the detached workspaces that still run terminals. macOS adds Options, Show All Windows, Hide and
// Quit below it.
//
// It is the app process's (desktop.ts installs it), not a page's: Denext 4.22's backend Dock menu
// (`setDockMenu` / `onDockMenuItem` on `runDesktop`'s result) takes separators, checks and
// submenus, outlives every page reload, and hands each click to the backend once, with the key
// window, and with no window open too, which is when the Dock menu matters most here. (Before
// 4.22 Qutty set the runtime's `Deno.dock` menu itself; the page-side `setQuickActions` took
// titles only.) Off macOS `setDockMenu` is a no-op, and desktop.ts installs nothing there.
//
// Reopen Closed Window lists the windows Denext remembers the user closed (`windows.closed()`,
// most recent first, keyed by workspace id) whose workspace is still detached with terminals
// running; a detached workspace Denext does not list (closed before a relaunch, say) follows,
// the most recently detached first.
//
// What a window does (New Terminal, the agent chats) goes to the frontmost window's page as a
// command it pulls (`session` extension: the `dockCommand` signal and `takeDockCommands`), so a
// page that is still loading (a window the Dock menu just opened) gets it once it is up, and a
// reload never runs it twice. With no window open, New Terminal opens a new window (its first
// terminal is the new terminal) and an agent chat opens one and waits there.
//
// The menu follows the workspaces (desktop/workspace-host.ts `onChanged`) and the focus (the
// `session` extension's `focus`, {@linkcode DockMenu.refresh}). The pure parts (`dockMenu`,
// `dockMenuAction`, `nativeDockMenu`), {@linkcode DockCommandQueue} and {@linkcode DockMenu} over
// a fake host are tested without a window (tests/dock_menu_test.ts).

import type {
  DesktopAppMenusApi,
  DesktopClosedWindow,
  DesktopDockMenuItem,
  DesktopWindowMenuItemContext,
} from "denext/desktop";
import type { WorkspaceInfo, WorkspaceRegistry } from "./workspace-host.ts";
import { terminals } from "./tray.ts";

/** What a Dock menu item asks the frontmost window's page to do. */
export type DockCommand = "newTerminal" | "agentChat" | "codexChat";

/** A Dock menu entry before it goes to the runtime. */
export type DockMenuEntry =
  | "separator"
  | { id: string; label: string; checked?: boolean }
  | { label: string; children: DockMenuEntry[] };

/** The Dock menu's item ids. */
export const DOCK_NEW_WINDOW = "qutty:dock:new-window";
export const DOCK_NEW_TERMINAL = "qutty:dock:new-terminal";
export const DOCK_AGENT_CHAT = "qutty:dock:agent-chat";
export const DOCK_CODEX_CHAT = "qutty:dock:codex-chat";
const DOCK_WINDOW = "qutty:dock:window:";
const DOCK_REOPEN = "qutty:dock:reopen:";

/** The most workspaces Reopen Closed Window lists (as many as the tray). */
export const DOCK_MAX_REOPEN = 15;

/** What the Dock menu is built from. */
export interface DockMenuInput {
  /** `WorkspaceRegistry.list()`. */
  workspaces: readonly WorkspaceInfo[];
  /** The workspace of the most recently focused window (checked). */
  active?: string;
  /** "Claude Code (chat)": Claude Code is installed. */
  agentChat: boolean;
  /** "Codex (chat)": Codex is installed (as the `+` menu offers it). */
  codexChat?: boolean;
  /**
   * The windows the user closed, most recent first (`windows.closed()`): Reopen Closed Window's
   * order. A detached workspace not in it follows, the most recently detached first.
   */
  closed?: readonly Pick<DesktopClosedWindow, "key">[];
}

/** Workspace names in a stable order: "Workspace 2" before "Workspace 10". */
const byName = (a: WorkspaceInfo, b: WorkspaceInfo) =>
  a.name.localeCompare(b.name, undefined, { numeric: true }) ||
  a.id.localeCompare(b.id);

/**
 * The Dock menu: one line per open workspace window (sorted by name, so focusing one does not
 * reorder them; the active one checked), New Window, New Terminal, "Claude Code (chat)",
 * "Codex (chat)", then Reopen Closed Window ▸ with the detached workspaces that run terminals, newest first.
 */
export function dockMenu(input: DockMenuInput): DockMenuEntry[] {
  const open = input.workspaces.filter((w) => w.state === "attached")
    .sort(byName)
    .map((w): DockMenuEntry => ({
      id: DOCK_WINDOW + w.id,
      label: w.name,
      ...(w.id === input.active ? { checked: true } : {}),
    }));
  const rank = new Map<string, number>();
  for (const [i, w] of (input.closed ?? []).entries()) {
    if (!rank.has(w.key)) rank.set(w.key, i);
  }
  const closed = input.workspaces
    .filter((w) => w.state === "detached" && w.running > 0)
    .sort((a, b) =>
      (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) ||
      (b.detachedAt ?? 0) - (a.detachedAt ?? 0)
    )
    .slice(0, DOCK_MAX_REOPEN)
    .map((w): DockMenuEntry => ({
      id: DOCK_REOPEN + w.id,
      label: `${w.name} — ${terminals(w.running)}`,
    }));
  return [
    ...open,
    ...(open.length > 0 ? ["separator" as const] : []),
    { id: DOCK_NEW_WINDOW, label: "New Window" },
    { id: DOCK_NEW_TERMINAL, label: "New Terminal" },
    ...(input.agentChat
      ? [{ id: DOCK_AGENT_CHAT, label: "Claude Code (chat)" }]
      : []),
    ...(input.codexChat
      ? [{ id: DOCK_CODEX_CHAT, label: "Codex (chat)" }]
      : []),
    ...(closed.length > 0
      ? [
        "separator" as const,
        { label: "Reopen Closed Window", children: closed },
      ]
      : []),
  ];
}

/** What a Dock menu item does. */
export type DockMenuAction =
  | { kind: "newWindow" }
  | { kind: "command"; command: DockCommand }
  | { kind: "workspace"; id: string };

/** The action of Dock menu item `id` (`undefined`: not one of ours). */
export function dockMenuAction(id: string): DockMenuAction | undefined {
  if (id === DOCK_NEW_WINDOW) return { kind: "newWindow" };
  if (id === DOCK_NEW_TERMINAL) {
    return { kind: "command", command: "newTerminal" };
  }
  if (id === DOCK_AGENT_CHAT) return { kind: "command", command: "agentChat" };
  if (id === DOCK_CODEX_CHAT) return { kind: "command", command: "codexChat" };
  for (const prefix of [DOCK_WINDOW, DOCK_REOPEN]) {
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { kind: "workspace", id: id.slice(prefix.length) };
    }
  }
  return undefined;
}

/** The menu in Denext's shape (`setDockMenu`'s {@linkcode DesktopDockMenuItem}s). */
export function nativeDockMenu(
  entries: readonly DockMenuEntry[],
): DesktopDockMenuItem[] {
  return entries.map((e): DesktopDockMenuItem => {
    if (e === "separator") return { type: "separator" };
    if ("children" in e) {
      return { label: e.label, submenu: nativeDockMenu(e.children) };
    }
    return {
      id: e.id,
      label: e.label,
      ...(e.checked ? { checked: true } : {}),
    };
  });
}

/** How long a command waits for its window's page (a window that never loads drops it). */
export const DOCK_COMMAND_TTL_MS = 60_000;

/**
 * The commands waiting for each window's page. {@linkcode push} queues one and signals the
 * window (the `session` extension's `dockCommand` event); the page {@linkcode take}s them all,
 * each once.
 */
export class DockCommandQueue {
  readonly #queues = new Map<string, { command: DockCommand; at: number }[]>();
  #signal: (windowId: string) => void = () => {};
  readonly #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
  }

  /** How a window is told it has commands (the `session` extension sets it up). */
  setSignal(fn: (windowId: string) => void): void {
    this.#signal = fn;
  }

  /** Queue `command` for window `windowId`'s page and tell it. */
  push(windowId: string, command: DockCommand): void {
    const queue = this.#queues.get(windowId) ?? [];
    queue.push({ command, at: this.#now() });
    this.#queues.set(windowId, queue);
    try {
      this.#signal(windowId);
    } catch (err) {
      console.error("dock menu: could not signal the window", err);
    }
  }

  /** Window `windowId`'s waiting commands, oldest first (too old ones dropped); the queue empties. */
  take(windowId: string): DockCommand[] {
    const queue = this.#queues.get(windowId) ?? [];
    this.#queues.delete(windowId);
    const now = this.#now();
    return queue.filter((c) => now - c.at <= DOCK_COMMAND_TTL_MS).map((c) =>
      c.command
    );
  }

  /** Window `windowId` closed: its commands go. */
  drop(windowId: string): void {
    this.#queues.delete(windowId);
  }
}

/** What the Dock menu is set through: `runDesktop`'s result (Denext 4.22's backend Dock menu). */
export type DockMenuHost = Pick<
  DesktopAppMenusApi,
  "setDockMenu" | "onDockMenuItem"
>;

/** The keyed windows the user closed (`runDesktop`'s `windows.closed()`). */
export interface ClosedWindowsLike {
  closed(): readonly Pick<DesktopClosedWindow, "key">[];
}

/** What the Dock menu drives. */
export interface DockMenuDeps {
  dock: DockMenuHost;
  /** Reopen Closed Window's order (absent: the most recently detached first). */
  windows?: ClosedWindowsLike;
  registry: Pick<
    WorkspaceRegistry,
    "list" | "onChanged" | "activeWindow" | "workspaceOfWindow"
  >;
  /** Bring workspace `id`'s window forward, or reopen it when detached (tray mode's). */
  showWorkspace(id: string): void;
  /** Open a window on a fresh workspace; its id (tray mode's). */
  newWindow(): string | undefined;
  /** Where the page commands wait. */
  commands: Pick<DockCommandQueue, "push">;
  /** Whether Claude Code is installed (asked at install and on a refresh, at most once a minute). */
  agentChat?: () => Promise<boolean>;
  /** Whether Codex is installed (asked with the Claude Code probe). */
  codexChat?: () => Promise<boolean>;
  /** The clock (tests). */
  now?: () => number;
}

/** How long a burst of changes is coalesced into one menu update. */
const MENU_DEBOUNCE_MS = 100;
/** How long the Claude Code and Codex probes' answers are kept. */
const AGENT_PROBE_MS = 60_000;

/** The Dock menu for the app's life (see the module docs). */
export class DockMenu {
  #deps: DockMenuDeps | undefined;
  #menu = "";
  #agentChat = false;
  #codexChat = false;
  #probedAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #off: (() => void)[] = [];

  /** Whether the Dock menu is set (macOS). */
  get installed(): boolean {
    return this.#deps !== undefined;
  }

  /** Set the menu, follow the workspaces and answer its clicks. Returns the uninstall. */
  install(deps: DockMenuDeps): () => void {
    this.uninstall();
    this.#deps = deps;
    this.#off.push(
      deps.dock.onDockMenuItem((id, ctx) => this.menuItem(id, ctx)),
      deps.registry.onChanged(() => this.refresh()),
    );
    this.#apply();
    this.#probe();
    return () => this.uninstall();
  }

  /** Clear the menu and stop following (tests; a second install). */
  uninstall(): void {
    for (const off of this.#off.splice(0)) off();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#deps && this.#menu !== "") {
      try {
        this.#deps.dock.setDockMenu(null);
      } catch { /* the runtime is going away */ }
    }
    this.#deps = undefined;
    this.#menu = "";
    this.#probedAt = undefined;
  }

  /** Build the menu again soon (a window opened, closed, took the focus). */
  refresh(): void {
    if (!this.#deps || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#apply();
      this.#probe();
    }, MENU_DEBOUNCE_MS);
  }

  #apply(): void {
    const deps = this.#deps;
    if (!deps) return;
    const window = deps.registry.activeWindow();
    const active = window === undefined
      ? undefined
      : deps.registry.workspaceOfWindow(window);
    let closed: readonly Pick<DesktopClosedWindow, "key">[] = [];
    try {
      closed = deps.windows?.closed() ?? [];
    } catch { /* no window store: the detach order alone */ }
    const menu = nativeDockMenu(dockMenu({
      workspaces: deps.registry.list(),
      ...(active !== undefined ? { active } : {}),
      agentChat: this.#agentChat,
      codexChat: this.#codexChat,
      closed,
    }));
    const json = JSON.stringify(menu);
    if (json === this.#menu) return;
    try {
      deps.dock.setDockMenu(menu);
      this.#menu = json;
    } catch (err) {
      console.error("dock menu: could not set the menu", err);
    }
  }

  /** Ask again whether Claude Code and Codex are installed (at most once a minute). */
  #probe(): void {
    const deps = this.#deps;
    if (!deps?.agentChat && !deps?.codexChat) return;
    const now = (deps.now ?? Date.now)();
    if (this.#probedAt !== undefined && now - this.#probedAt < AGENT_PROBE_MS) {
      return;
    }
    this.#probedAt = now;
    deps.agentChat?.().then((found) => {
      if (this.#deps !== deps || found === this.#agentChat) return;
      this.#agentChat = found;
      this.#apply();
    }, (err) => console.warn("dock menu: could not look for Claude Code", err));
    deps.codexChat?.().then((found) => {
      if (this.#deps !== deps || found === this.#codexChat) return;
      this.#codexChat = found;
      this.#apply();
    }, (err) => console.warn("dock menu: could not look for Codex", err));
  }

  /**
   * A Dock menu item was chosen (`onDockMenuItem`, with the key window Denext names). A command
   * goes to {@linkcode commandTarget}'s window.
   */
  menuItem(
    id: string,
    ctx: Partial<DesktopWindowMenuItemContext> = {},
  ): void {
    const deps = this.#deps;
    const action = dockMenuAction(id);
    if (!deps || !action) return;
    if (action.kind === "workspace") return deps.showWorkspace(action.id);
    if (action.kind === "newWindow") return void deps.newWindow();
    const { window, workspace } = commandTarget(deps.registry, ctx.keyWindow);
    if (window !== undefined && workspace !== undefined) {
      deps.showWorkspace(workspace);
      deps.commands.push(window, action.command);
      return;
    }
    // No window: a new one. Its first terminal is the new terminal; the chat waits for its page.
    const opened = deps.newWindow();
    if (opened !== undefined && action.command !== "newTerminal") {
      deps.commands.push(opened, action.command);
    }
  }
}

/**
 * The window a Dock command goes to: the key window Denext names when it shows a workspace (not
 * the floating companion's window), else the workspace window focused last (`activeWindow`);
 * none with no workspace window open.
 */
export function commandTarget(
  registry: Pick<WorkspaceRegistry, "activeWindow" | "workspaceOfWindow">,
  keyWindow: DesktopWindowMenuItemContext["keyWindow"] | undefined,
): { window?: string; workspace?: string } {
  if (keyWindow) {
    const workspace = registry.workspaceOfWindow(keyWindow.id);
    if (workspace !== undefined) return { window: keyWindow.id, workspace };
  }
  const window = registry.activeWindow();
  const workspace = window === undefined
    ? undefined
    : registry.workspaceOfWindow(window);
  return window === undefined || workspace === undefined
    ? {}
    : { window, workspace };
}

const MENU_KEY = Symbol.for("qutty.dockMenu");
const QUEUE_KEY = Symbol.for("qutty.dockCommands");
const shared = globalThis as Record<symbol, unknown>;

/**
 * The app's Dock menu, installed by desktop.ts and refreshed by the `session` extension. Kept on
 * `globalThis`, as desktop/tray.ts's `trayMode` is, in case the loader gave the entry and the
 * extensions two copies.
 */
export const dockMenuController: DockMenu =
  (shared[MENU_KEY] as DockMenu | undefined) ??
    (shared[MENU_KEY] = new DockMenu()) as DockMenu;

/** The commands waiting for the pages, shared the same way. */
export const dockCommands: DockCommandQueue =
  (shared[QUEUE_KEY] as DockCommandQueue | undefined) ??
    (shared[QUEUE_KEY] = new DockCommandQueue()) as DockCommandQueue;
