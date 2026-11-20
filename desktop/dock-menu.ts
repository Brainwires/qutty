// The macOS Dock menu (a right click on Qutty's Dock icon), like iTerm2's: the open workspace
// windows (the frontmost one checked; a click brings it forward), New Window, New Terminal,
// "Claude Code (chat)" when Claude Code is installed, and Reopen Closed Window ▸ with the
// detached workspaces that still run terminals. macOS adds Options, Show All Windows, Hide and
// Quit below it.
//
// It is the app process's (desktop.ts installs it), not a page's: Denext's page-side Dock menu
// (`setQuickActions` / `onQuickAction` in `denext/mobile`) takes titles only (no separators,
// checks or submenus), and delivers a click to every open window's page and to none when no
// window is open, which is when the Dock menu matters most here. So the menu goes straight to the
// runtime's `Deno.dock` (`setMenu`, its `"menuclick"` event), which also outlives every page
// reload. Denext's own Dock-menu clicks only go to pages for ids a page set, so the two never
// meet. Where there is no `Deno.dock.setMenu` (Linux, Windows, an older runtime) nothing is set.
//
// What a window does (New Terminal, the agent chat) goes to the frontmost window's page as a
// command it pulls (`session` extension: the `dockCommand` signal and `takeDockCommands`), so a
// page that is still loading (a window the Dock menu just opened) gets it once it is up, and a
// reload never runs it twice. With no window open, New Terminal opens a new window (its first
// terminal is the new terminal) and the agent chat opens one and waits there.
//
// The menu follows the workspaces (desktop/workspace-host.ts `onChanged`) and the focus (the
// `session` extension's `focus`, {@linkcode DockMenu.refresh}). The pure parts (`dockMenu`,
// `dockMenuAction`, `nativeDockMenu`), {@linkcode DockCommandQueue} and {@linkcode DockMenu} over
// a fake dock are tested without a window (tests/dock_menu_test.ts).

import type { WorkspaceInfo, WorkspaceRegistry } from "./workspace-host.ts";
import { terminals } from "./tray.ts";

/** What a Dock menu item asks the frontmost window's page to do. */
export type DockCommand = "newTerminal" | "agentChat";

/** A Dock menu entry before it goes to the runtime. */
export type DockMenuEntry =
  | "separator"
  | { id: string; label: string; checked?: boolean }
  | { label: string; children: DockMenuEntry[] };

/** A native menu entry as `Deno.dock.setMenu` takes it (`Deno.MenuItem`). */
export type DockNativeItem =
  | { item: { label: string; id: string; enabled: boolean; checked?: boolean } }
  | { submenu: { label: string; items: DockNativeItem[] } }
  | "separator";

/** The Dock menu's item ids. */
export const DOCK_NEW_WINDOW = "qutty:dock:new-window";
export const DOCK_NEW_TERMINAL = "qutty:dock:new-terminal";
export const DOCK_AGENT_CHAT = "qutty:dock:agent-chat";
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
}

/** Workspace names in a stable order: "Workspace 2" before "Workspace 10". */
const byName = (a: WorkspaceInfo, b: WorkspaceInfo) =>
  a.name.localeCompare(b.name, undefined, { numeric: true }) ||
  a.id.localeCompare(b.id);

/**
 * The Dock menu: one line per open workspace window (sorted by name, so focusing one does not
 * reorder them; the active one checked), New Window, New Terminal, "Claude Code (chat)", then
 * Reopen Closed Window ▸ with the detached workspaces that run terminals, newest first.
 */
export function dockMenu(input: DockMenuInput): DockMenuEntry[] {
  const open = input.workspaces.filter((w) => w.state === "attached")
    .sort(byName)
    .map((w): DockMenuEntry => ({
      id: DOCK_WINDOW + w.id,
      label: w.name,
      ...(w.id === input.active ? { checked: true } : {}),
    }));
  const closed = input.workspaces
    .filter((w) => w.state === "detached" && w.running > 0)
    .sort((a, b) => (b.detachedAt ?? 0) - (a.detachedAt ?? 0))
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
  for (const prefix of [DOCK_WINDOW, DOCK_REOPEN]) {
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { kind: "workspace", id: id.slice(prefix.length) };
    }
  }
  return undefined;
}

/** The menu in the runtime's shape (`Deno.MenuItem`). */
export function nativeDockMenu(
  entries: readonly DockMenuEntry[],
): DockNativeItem[] {
  return entries.map((e): DockNativeItem => {
    if (e === "separator") return e;
    if ("children" in e) {
      return { submenu: { label: e.label, items: nativeDockMenu(e.children) } };
    }
    return {
      item: {
        label: e.label,
        id: e.id,
        enabled: true,
        ...(e.checked ? { checked: true } : {}),
      },
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

/** `Deno.dock`, as far as the Dock menu uses it. */
export interface DockLike {
  setMenu(menu: DockNativeItem[] | null): void;
  addEventListener(type: "menuclick", listener: (event: Event) => void): void;
  removeEventListener(
    type: "menuclick",
    listener: (event: Event) => void,
  ): void;
}

/** The runtime's `Deno.dock` when it can take a Dock menu (macOS), else `undefined`. */
export function runtimeDock(os: string = Deno.build.os): DockLike | undefined {
  if (os !== "darwin") return undefined;
  const dock = (Deno as unknown as { dock?: Partial<DockLike> }).dock;
  return typeof dock?.setMenu === "function" &&
      typeof dock.addEventListener === "function" &&
      typeof dock.removeEventListener === "function"
    ? dock as DockLike
    : undefined;
}

/** What the Dock menu drives. */
export interface DockMenuDeps {
  dock: DockLike;
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
  /** The clock (tests). */
  now?: () => number;
}

/** How long a burst of changes is coalesced into one menu update. */
const MENU_DEBOUNCE_MS = 100;
/** How long the Claude Code probe's answer is kept. */
const AGENT_PROBE_MS = 60_000;

/** The Dock menu for the app's life (see the module docs). */
export class DockMenu {
  #deps: DockMenuDeps | undefined;
  #menu = "";
  #agentChat = false;
  #probedAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #off: (() => void)[] = [];

  /** Whether the Dock menu is set (macOS with a dock that takes one). */
  get installed(): boolean {
    return this.#deps !== undefined;
  }

  /** Set the menu, follow the workspaces and answer its clicks. Returns the uninstall. */
  install(deps: DockMenuDeps): () => void {
    this.uninstall();
    this.#deps = deps;
    const onClick = (e: Event) => {
      const id = (e as CustomEvent<{ id?: unknown } | null>).detail?.id;
      if (typeof id === "string") this.menuItem(id);
    };
    deps.dock.addEventListener("menuclick", onClick);
    this.#off.push(
      () => deps.dock.removeEventListener("menuclick", onClick),
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
        this.#deps.dock.setMenu(null);
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
    const menu = nativeDockMenu(dockMenu({
      workspaces: deps.registry.list(),
      ...(active !== undefined ? { active } : {}),
      agentChat: this.#agentChat,
    }));
    const json = JSON.stringify(menu);
    if (json === this.#menu) return;
    try {
      deps.dock.setMenu(menu);
      this.#menu = json;
    } catch (err) {
      console.error("dock menu: could not set the menu", err);
    }
  }

  /** Ask again whether Claude Code is installed (at most once a minute). */
  #probe(): void {
    const deps = this.#deps;
    if (!deps?.agentChat) return;
    const now = (deps.now ?? Date.now)();
    if (this.#probedAt !== undefined && now - this.#probedAt < AGENT_PROBE_MS) {
      return;
    }
    this.#probedAt = now;
    deps.agentChat().then((found) => {
      if (this.#deps !== deps || found === this.#agentChat) return;
      this.#agentChat = found;
      this.#apply();
    }, (err) => console.warn("dock menu: could not look for Claude Code", err));
  }

  /** A Dock menu item was chosen. */
  menuItem(id: string): void {
    const deps = this.#deps;
    const action = dockMenuAction(id);
    if (!deps || !action) return;
    if (action.kind === "workspace") return deps.showWorkspace(action.id);
    if (action.kind === "newWindow") return void deps.newWindow();
    const window = deps.registry.activeWindow();
    const workspace = window === undefined
      ? undefined
      : deps.registry.workspaceOfWindow(window);
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
