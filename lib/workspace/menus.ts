/**
 * The native menu bar's model (desktop app, Denext 4.18's app menus): pure builders from the
 * workspace's state to Denext's menu shapes, the stable item ids, and a click's id back to what the
 * page does. The same model feeds the backend (desktop/menus.ts: the custom menus at launch) and
 * the page (app/use-native-menus.ts: per-window state, the window's own Window-menu items, the
 * launch submenu, clicks).
 *
 * The bar, macOS: Qutty (About, Settings… ⌘,, Hide, Hide Others, Show All, Quit: the page's
 * `setAppMenu`), Shell, Edit (the standard roles: the page's `setAppMenu`), View, Window (Denext's:
 * Minimize, Zoom, Reopen Closed Window, the open windows, then this window's tiles, then Bring All
 * to Front), Help. Linux and Windows: Shell (with Settings… at its end), View, Window, Help. They
 * get no Edit menu and no roles: a GTK accelerator wins over the page, so Edit's Ctrl+C / Ctrl+V /
 * Ctrl+A would never reach the shell.
 *
 * Shortcuts: only the workspace's own (lib/workspace/keys.ts), Denext's New Window (⌘N) and the
 * macOS standard Settings… (⌘,). A key the page's keydown handler takes is taken once: on macOS
 * the page sees a key equivalent before the menu does and its handler calls `preventDefault()`, so
 * the menu never fires; on Linux the window's accelerators win and the page never sees the key.
 * {@linkcode createShortcutGuard} drops a menu click that follows the same key the page just
 * handled, in case a runtime ever delivers both.
 *
 * @module
 */

import type {
  AppMenuItem,
  DesktopMenuItemSpec,
  DesktopMenuItemState,
  DesktopMenuUpdate,
  DesktopWindowMenuAppItem,
} from "denext/desktop/app";
import { type LayoutPattern, PATTERN_INFO } from "../layout/mod.ts";
import type { KeyCommand, KeyPlatform } from "./keys.ts";
import type { ViewMode } from "./freeform.ts";
import {
  MDI_ITEM_IDS,
  MDI_LABELS,
  type MenuTile,
  tileItemId,
  VIEW_GROUP,
} from "./mdi-menu.ts";
import {
  BAR_POSITIONS,
  barOrderIds,
  type BarPosition,
  maximizedId,
  PATTERNS,
  type WorkspaceState,
} from "./store.ts";
import type { TileControl } from "./tile-controls.ts";
import { CLOSE_AND_END_ITEM } from "./windows.ts";

/** The custom top-level menus' ids (`setMenu`). */
export const MENU_IDS = {
  shell: "qutty:shell",
  view: "qutty:view",
  help: "qutty:help",
} as const;

/** The ids of the native items (besides the view model's, lib/workspace/mdi-menu.ts). */
export const ITEM = {
  settings: "qutty:app:settings",
  newTile: "qutty:shell:new-tile",
  newWindow: "qutty:shell:new-window",
  closeTile: "qutty:shell:close-tile",
  closeAndEnd: CLOSE_AND_END_ITEM,
  connections: "qutty:shell:connections",
  broadcast: "qutty:shell:broadcast",
  webPage: "qutty:launch-web",
  bookmarks: "qutty:web:bookmarks",
  history: "qutty:web:history",
  agentChat: "qutty:launch-agent-chat",
  ollama: "qutty:launch-ollama",
  nextLayout: "qutty:layout:next",
  minimizeTile: "qutty:tile:minimize",
  maximizeTile: "qutty:tile:maximize",
  restoreTile: "qutty:tile:restore",
  zoomTile: "qutty:tile:zoom",
  bigger: "qutty:font:bigger",
  smaller: "qutty:font:smaller",
  actualSize: "qutty:font:reset",
  nextBar: "qutty:bar:next",
  nextTile: "qutty:tiles:next",
  previousTile: "qutty:tiles:previous",
  lastTile: "qutty:tiles:last",
  repo: "qutty:help:repo",
} as const;

/** Where Help → "Qutty on GitHub" goes. */
export const REPO_URL = "https://github.com/Brainwires/qutty";

const LAYOUT_PREFIX = "qutty:layout:pattern:";
/** The Window menu's "Move Tile to <window>" items: this prefix and the window's id. */
const MOVE_PREFIX = "qutty:window:move-tile:";

/** The id of the Window menu's "Move Tile to" item for window `window` (`"new"`: a new window). */
export function moveItemId(window: string): string {
  return `${MOVE_PREFIX}${window}`;
}
const LAYOUT_GROUP = "qutty:layout";
const BAR_PREFIX = "qutty:bar:position:";
const BAR_GROUP = "qutty:bar";
const LAUNCH_PREFIX = "qutty:launch:";
/** Denext's longest item id and label. */
const MAX_ID = 128;
const MAX_LABEL = 256;

/** The id of the Layout submenu's item for `pattern`. */
export function patternItemId(pattern: LayoutPattern): string {
  return LAYOUT_PREFIX + pattern;
}

/** The id of the Switcher Bar submenu's item for `position`. */
export function barItemId(position: BarPosition): string {
  return BAR_PREFIX + position;
}

/** The id of the launch submenu's item for launch entry `entryId`. */
export function launchItemId(entryId: string): string {
  return LAUNCH_PREFIX + entryId;
}

/** The accelerator of each shortcut item (the workspace's keys, Settings… and New Window). */
const ACCELERATORS: Record<string, string> = {
  [ITEM.settings]: "CmdOrCtrl+,",
  [ITEM.newTile]: "CmdOrCtrl+T",
  [ITEM.newWindow]: "CmdOrCtrl+N",
  [ITEM.closeTile]: "CmdOrCtrl+W",
  [ITEM.connections]: "CmdOrCtrl+Shift+O",
  [ITEM.broadcast]: "CmdOrCtrl+Shift+I",
  [ITEM.nextLayout]: "CmdOrCtrl+Shift+L",
  [ITEM.zoomTile]: "CmdOrCtrl+Enter",
  [ITEM.bigger]: "CmdOrCtrl+=",
  [ITEM.smaller]: "CmdOrCtrl+-",
  [ITEM.actualSize]: "CmdOrCtrl+0",
  [ITEM.nextBar]: "CmdOrCtrl+Shift+B",
  [ITEM.nextTile]: "CmdOrCtrl+]",
  [ITEM.previousTile]: "CmdOrCtrl+[",
  [ITEM.lastTile]: "CmdOrCtrl+`",
};

/** The menu item a shortcut (a {@linkcode KeyCommand}) also is, by its accelerator. */
export function keyAccelerator(cmd: KeyCommand): string | null {
  switch (cmd.kind) {
    case "newTerminal":
      return ACCELERATORS[ITEM.newTile];
    case "closeFocused":
      return ACCELERATORS[ITEM.closeTile];
    case "focusOrdinal":
      return `CmdOrCtrl+${cmd.ordinal}`;
    case "cycle":
      return ACCELERATORS[cmd.dir === 1 ? ITEM.nextTile : ITEM.previousTile];
    case "focusPrevious":
      return ACCELERATORS[ITEM.lastTile];
    case "cyclePattern":
      return ACCELERATORS[ITEM.nextLayout];
    case "cycleBarPosition":
      return ACCELERATORS[ITEM.nextBar];
    case "toggleMonocle":
      return ACCELERATORS[ITEM.zoomTile];
    case "fontSize":
      return ACCELERATORS[cmd.dir === 1 ? ITEM.bigger : ITEM.smaller];
    case "fontSizeReset":
      return ACCELERATORS[ITEM.actualSize];
    case "openConnections":
      return ACCELERATORS[ITEM.connections];
    case "toggleBroadcast":
      return ACCELERATORS[ITEM.broadcast];
  }
}

/** A clickable item, with its accelerator when it has one. */
function item(
  id: string,
  label: string,
  more: Partial<DesktopMenuItemSpec> = {},
): DesktopMenuItemSpec {
  const accelerator = ACCELERATORS[id];
  return { id, label, ...(accelerator ? { accelerator } : {}), ...more };
}

const SEP: DesktopMenuItemSpec = { type: "separator" };

/** The page's own menus (`setAppMenu`): macOS's app menu and Edit; `null` elsewhere (none). */
export function appMenu(platform: KeyPlatform): AppMenuItem[] | null {
  if (platform !== "mac") return null;
  return [
    {
      label: "Qutty",
      submenu: [
        { role: "about" },
        "separator",
        {
          id: ITEM.settings,
          label: "Settings…",
          accelerator: ACCELERATORS[ITEM.settings],
        },
        "separator",
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        "separator",
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        "separator",
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
  ];
}

/** One launchable entry of the `+` menu, as the native submenu lists it. */
export interface LaunchMenuEntry {
  id: string;
  label: string;
  /** The entry's kind and agent (an `"agent"` entry for `claude` gets its "(chat)" twin). */
  kind?: string;
  agent?: { name: string };
}

/** The `+` menu's entries (app/launch-menu.tsx) as the Shell menu's "New Tile With" submenu. */
export interface LaunchMenuInput {
  sections: readonly {
    id: string;
    title: string;
    entries: readonly LaunchMenuEntry[];
  }[];
  /** "Ollama models…" (Ollama installed). */
  ollama: boolean;
  /** "Web Page" (the native web engine). */
  webPage: boolean;
  /** "Bookmarks…" and "History…" (web tiles can be shown: any engine). */
  webDialogs?: boolean;
  /** "Claude Code (chat)" after the Claude Code entry: a new agent tile (app/agent-tile.tsx). */
  agentChat?: boolean;
}

/** Whether `text` is something Denext takes as an id or label (no control characters). */
function plain(text: string, max: number): boolean {
  return text.length > 0 && text.length <= max &&
    ![...text].some((c) => c < " " || c === "\u007f");
}

/** The "New Tile With" submenu: each section (a greyed heading, its entries), then the extras. */
function launchItems(
  launch: LaunchMenuInput | undefined,
): DesktopMenuItemSpec[] {
  const out: DesktopMenuItemSpec[] = [];
  for (const section of launch?.sections ?? []) {
    const entries = section.entries.filter((e) =>
      plain(launchItemId(e.id), MAX_ID) && plain(e.label, MAX_LABEL)
    );
    if (entries.length === 0 && section.id !== "ollama") continue;
    if (out.length > 0) out.push(SEP);
    out.push(
      item(`qutty:launch-heading:${section.id}`, section.title, {
        enabled: false,
      }),
    );
    for (const e of entries) {
      out.push(item(launchItemId(e.id), e.label));
      if (
        launch?.agentChat && e.kind === "agent" && e.agent?.name === "claude"
      ) {
        out.push(item(ITEM.agentChat, `${e.label} (chat)`));
      }
    }
    if (section.id === "ollama" && launch?.ollama) {
      out.push(item(ITEM.ollama, "Ollama Models…"));
    }
  }
  const extras: DesktopMenuItemSpec[] = [
    ...(launch?.webPage ? [item(ITEM.webPage, "Web Page")] : []),
    item(ITEM.connections, "Connections…"),
  ];
  return [...out, ...(out.length > 0 ? [SEP] : []), ...extras];
}

/**
 * The Shell menu (File's place): new tiles and windows, the web tiles' Bookmarks… and History…
 * (as in the `+` menu), closing, broadcast input.
 */
export function shellMenu(
  platform: KeyPlatform,
  launch?: LaunchMenuInput,
): DesktopMenuUpdate {
  return {
    label: "Shell",
    after: "app",
    items: [
      item(ITEM.newTile, "New Tile"),
      { label: "New Tile With", items: launchItems(launch) },
      item(ITEM.newWindow, "New Window"),
      ...(launch?.webDialogs
        ? [
          SEP,
          item(ITEM.bookmarks, "Bookmarks…"),
          item(ITEM.history, "History…"),
        ]
        : []),
      SEP,
      item(ITEM.closeTile, "Close Tile"),
      item(ITEM.closeAndEnd, "Close Window and End Its Shells"),
      SEP,
      item(ITEM.broadcast, "Broadcast Input", { type: "checkbox" }),
      // macOS keeps Settings… in the app menu (the page's `setAppMenu`). ⌘, is the macOS
      // standard only: no Ctrl+, elsewhere.
      ...(platform === "mac"
        ? []
        : [SEP, { id: ITEM.settings, label: "Settings…" }]),
    ],
  };
}

const BAR_LABELS: Record<BarPosition, string> = {
  top: "Top",
  bottom: "Bottom",
  left: "Left",
  right: "Right",
};

/** The View menu: the view, the layout, the arrange commands, the focused tile, font size, bar. */
export function viewMenuSpec(platform: KeyPlatform): DesktopMenuUpdate {
  const radio = (
    id: string,
    label: string,
    group: string,
  ): DesktopMenuItemSpec => item(id, label, { type: "radio", group });
  return {
    label: "View",
    after: "edit",
    items: [
      radio(MDI_ITEM_IDS.viewTiled, MDI_LABELS.viewTiled, VIEW_GROUP),
      radio(MDI_ITEM_IDS.viewFreeform, MDI_LABELS.viewFreeform, VIEW_GROUP),
      SEP,
      {
        label: "Layout",
        items: [
          ...PATTERNS.map((p) =>
            radio(patternItemId(p), PATTERN_INFO[p].label, LAYOUT_GROUP)
          ),
          SEP,
          item(ITEM.nextLayout, "Next Layout"),
        ],
      },
      item(MDI_ITEM_IDS.cascade, MDI_LABELS.cascade),
      item(MDI_ITEM_IDS.tileHorizontally, MDI_LABELS.tileHorizontally),
      item(MDI_ITEM_IDS.tileVertically, MDI_LABELS.tileVertically),
      SEP,
      item(ITEM.minimizeTile, "Minimize Tile"),
      item(ITEM.maximizeTile, "Maximize Tile"),
      item(ITEM.restoreTile, "Restore Tile"),
      item(ITEM.zoomTile, "Zoom Tile"),
      SEP,
      item(ITEM.bigger, "Bigger"),
      item(ITEM.smaller, "Smaller"),
      item(ITEM.actualSize, "Actual Size"),
      SEP,
      {
        label: "Switcher Bar",
        items: [
          ...BAR_POSITIONS.map((p) =>
            radio(barItemId(p), BAR_LABELS[p], BAR_GROUP)
          ),
          SEP,
          item(ITEM.nextBar, "Next Position"),
        ],
      },
      ...(platform === "mac" ? [SEP, { role: "toggleFullScreen" }] : []),
    ],
  };
}

/** The Help menu: the project's page. */
export function helpMenu(): DesktopMenuUpdate {
  return {
    label: "Help",
    after: "window",
    items: [item(ITEM.repo, "Qutty on GitHub")],
  };
}

/** Every custom menu the backend sets at launch (the Shell menu without the launch entries yet). */
export function customMenus(
  platform: KeyPlatform,
): { id: string; menu: DesktopMenuUpdate }[] {
  return [
    { id: MENU_IDS.shell, menu: shellMenu(platform) },
    { id: MENU_IDS.view, menu: viewMenuSpec(platform) },
    { id: MENU_IDS.help, menu: helpMenu() },
  ];
}

/** What the menus' state is computed from: one window's workspace. */
export interface NativeMenuInput {
  view: ViewMode;
  pattern: LayoutPattern;
  barPosition: BarPosition;
  /** The focused tile (`null`: none). */
  focusedId: string | null;
  /** The maximized tile (`null`: none). */
  maximizedId: string | null;
  /** Broadcast input is on. */
  broadcast: boolean;
  /** Every tile, in the switcher bar's order (⌘1 is the first). */
  tiles: readonly MenuTile[];
}

/**
 * The menus' input from a workspace's state. A tile is listed by its own title ("zsh — ~/src", read
 * every couple of seconds), never the title its program sets: a program may animate that several
 * times a second (an agent's spinner), and each change would rebuild every window's menu bar.
 */
export function menuInput(
  state: WorkspaceState,
  broadcast: boolean,
): NativeMenuInput {
  const byId = new Map(state.terminals.map((t) => [t.id, t]));
  const tiles: MenuTile[] = barOrderIds(state).flatMap((id) => {
    const t = byId.get(id);
    return t
      ? [{
        id,
        title: t.title,
        focused: id === state.focusedId,
        minimized: t.minimized === true,
      }]
      : [];
  });
  return {
    view: state.view,
    pattern: state.settings.layout.pattern,
    barPosition: state.settings.barPosition,
    focusedId: state.focusedId,
    maximizedId: maximizedId(state),
    broadcast,
    tiles,
  };
}

/**
 * Every stateful item's state for one window: the radio checks (view, layout, bar position), the
 * broadcast checkbox, and what is enabled (Restore Tile only with a tile maximized, the arrange
 * commands only free-form with a tile shown, the layouts only tiled, ...).
 */
export function menuItemStates(
  input: NativeMenuInput,
): Record<string, DesktopMenuItemState> {
  const tiled = input.view === "tiled";
  const focused = input.focusedId !== null;
  const shown = input.tiles.some((t) => !t.minimized);
  const out: Record<string, DesktopMenuItemState> = {
    [MDI_ITEM_IDS.viewTiled]: { checked: tiled },
    [MDI_ITEM_IDS.viewFreeform]: { checked: !tiled },
    [ITEM.nextLayout]: { enabled: tiled },
    [ITEM.closeTile]: { enabled: focused },
    [ITEM.broadcast]: { checked: input.broadcast },
    [ITEM.minimizeTile]: { enabled: focused },
    [ITEM.maximizeTile]: {
      enabled: focused && input.maximizedId !== input.focusedId,
    },
    [ITEM.restoreTile]: { enabled: input.maximizedId !== null },
    [ITEM.zoomTile]: { enabled: focused },
  };
  for (
    const id of [
      MDI_ITEM_IDS.cascade,
      MDI_ITEM_IDS.tileHorizontally,
      MDI_ITEM_IDS.tileVertically,
    ]
  ) {
    out[id] = { enabled: !tiled && shown };
  }
  for (const p of PATTERNS) {
    out[patternItemId(p)] = { checked: p === input.pattern, enabled: tiled };
  }
  for (const p of BAR_POSITIONS) {
    out[barItemId(p)] = { checked: p === input.barPosition };
  }
  return out;
}

/** The changes from the states pushed already (`pushed`) to `next`, item by item. */
export function stateChanges(
  pushed: ReadonlyMap<string, DesktopMenuItemState>,
  next: Record<string, DesktopMenuItemState>,
): [string, DesktopMenuItemState][] {
  return Object.entries(next).filter(([id, s]) => {
    const was = pushed.get(id);
    return was?.checked !== s.checked || was?.enabled !== s.enabled;
  });
}

/**
 * The window's own Window-menu items: its tiles in the switcher bar's order (the focused one
 * checked, ⌘1..9 on the first nine), then Next / Previous / Last Used Tile.
 */
/** Where the Window menu can move the focused tile (desktop/tile-move.ts `MoveTarget`s). */
export interface MoveMenuInput {
  /** The other windows: their ids and workspace names. */
  targets: readonly { window: string; name: string }[];
  /** A tile can tear off into a new window. */
  newWindow: boolean;
}

/**
 * The window's own Window-menu items: its tiles (⌘1–⌘9), next / previous / last tile, and with
 * `moves` "Move Tile to <window>" for each other window and "Move Tile to New Window" (as the tile
 * header's menu; flat items, since the window items have no submenus).
 */
export function windowMenuItems(
  input: NativeMenuInput,
  moves?: MoveMenuInput,
): DesktopWindowMenuAppItem[] {
  const tiles = input.tiles.map((t, i): DesktopWindowMenuAppItem => ({
    id: tileItemId(t.id),
    label: t.minimized ? `${t.title} (minimized)` : t.title,
    checked: t.focused,
    ...(i < 9 ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}),
  })).filter((t) => plain(t.id!, MAX_ID) && plain(t.label!, MAX_LABEL));
  if (tiles.length === 0) return [];
  const many = input.tiles.filter((t) => !t.minimized).length > 1;
  const nav = (id: string, label: string): DesktopWindowMenuAppItem => ({
    id,
    label,
    accelerator: ACCELERATORS[id],
    enabled: many,
  });
  const move: DesktopWindowMenuAppItem[] = input.focusedId === null || !moves
    ? []
    : [
      ...moves.targets.map((t) => ({
        id: moveItemId(t.window),
        label: `Move Tile to ${t.name}`,
      })),
      // A window's only tile tearing off would just be the window again.
      ...(moves.newWindow && input.tiles.length > 1
        ? [{ id: moveItemId("new"), label: "Move Tile to New Window" }]
        : []),
    ].filter((t) => plain(t.id, MAX_ID) && plain(t.label, MAX_LABEL));
  return [
    ...tiles,
    { type: "separator" },
    nav(ITEM.nextTile, "Next Tile"),
    nav(ITEM.previousTile, "Previous Tile"),
    nav(ITEM.lastTile, "Last Used Tile"),
    ...(move.length > 0 ? [{ type: "separator" as const }, ...move] : []),
  ];
}

/** What a click on a native item asks the key window's page to do. */
export type MenuAction =
  /** What the shortcut does (the page's `runCommand`). */
  | { kind: "key"; command: KeyCommand }
  /** Open Settings. */
  | { kind: "settings" }
  /** A view-model item (lib/workspace/mdi-menu.ts): the view, an arrange command, a tile. */
  | { kind: "view"; id: string }
  | { kind: "pattern"; pattern: LayoutPattern }
  | { kind: "barPosition"; position: BarPosition }
  /** The focused (Restore: the maximized) tile's control. */
  | { kind: "tile"; control: TileControl }
  /** Start launch entry `entryId` (as the `+` menu does). */
  | { kind: "launch"; entryId: string }
  | { kind: "webPage" }
  /** The web tiles' bookmark manager or History (app/web-stores.ts `openWebDialog`). */
  | { kind: "webDialog"; dialog: "bookmarks" | "history" }
  | { kind: "ollama" }
  /** Move the focused tile to window `to` (`"new"`: a new window). */
  | { kind: "moveTile"; to: string }
  /** "Claude Code (chat)": a new agent tile. */
  | { kind: "agentChat" };

const KEY_ITEMS: Record<string, KeyCommand> = {
  [ITEM.newTile]: { kind: "newTerminal" },
  [ITEM.closeTile]: { kind: "closeFocused" },
  [ITEM.connections]: { kind: "openConnections" },
  [ITEM.broadcast]: { kind: "toggleBroadcast" },
  [ITEM.nextLayout]: { kind: "cyclePattern" },
  [ITEM.zoomTile]: { kind: "toggleMonocle" },
  [ITEM.bigger]: { kind: "fontSize", dir: 1 },
  [ITEM.smaller]: { kind: "fontSize", dir: -1 },
  [ITEM.actualSize]: { kind: "fontSizeReset" },
  [ITEM.nextBar]: { kind: "cycleBarPosition" },
  [ITEM.nextTile]: { kind: "cycle", dir: 1 },
  [ITEM.previousTile]: { kind: "cycle", dir: -1 },
  [ITEM.lastTile]: { kind: "focusPrevious" },
};

const TILE_ITEMS: Record<string, TileControl> = {
  [ITEM.minimizeTile]: "minimize",
  [ITEM.maximizeTile]: "maximize",
  [ITEM.restoreTile]: "restoreTile",
};

const VIEW_IDS = new Set<string>(Object.values(MDI_ITEM_IDS));

/**
 * What a click on item `id` asks the page to do, or `null` for an item the page leaves alone (the
 * backend's New Window, Close Window and End Its Shells, Help; a heading; an unknown id).
 */
export function menuAction(id: string): MenuAction | null {
  const key = KEY_ITEMS[id];
  if (key) return { kind: "key", command: key };
  const control = TILE_ITEMS[id];
  if (control) return { kind: "tile", control };
  if (id === ITEM.settings) return { kind: "settings" };
  if (id === ITEM.webPage) return { kind: "webPage" };
  if (id === ITEM.bookmarks) return { kind: "webDialog", dialog: "bookmarks" };
  if (id === ITEM.history) return { kind: "webDialog", dialog: "history" };
  if (id === ITEM.agentChat) return { kind: "agentChat" };
  if (id === ITEM.ollama) return { kind: "ollama" };
  if (id.startsWith(MOVE_PREFIX) && id.length > MOVE_PREFIX.length) {
    return { kind: "moveTile", to: id.slice(MOVE_PREFIX.length) };
  }
  if (
    VIEW_IDS.has(id) ||
    (id.startsWith(tileItemId("")) && id.length > tileItemId("").length)
  ) {
    return { kind: "view", id };
  }
  if (id.startsWith(LAYOUT_PREFIX)) {
    const pattern = id.slice(LAYOUT_PREFIX.length) as LayoutPattern;
    return PATTERNS.includes(pattern) ? { kind: "pattern", pattern } : null;
  }
  if (id.startsWith(BAR_PREFIX)) {
    const position = id.slice(BAR_PREFIX.length) as BarPosition;
    return BAR_POSITIONS.includes(position)
      ? { kind: "barPosition", position }
      : null;
  }
  if (id.startsWith(LAUNCH_PREFIX) && id.length > LAUNCH_PREFIX.length) {
    return { kind: "launch", entryId: id.slice(LAUNCH_PREFIX.length) };
  }
  return null;
}

/**
 * Whether the page acts on `action` now. While a modal dialog has the keyboard only its own
 * shortcut's item (Connections…, which closes it) works, as with the keys.
 */
export function menuActionAllowed(
  action: MenuAction,
  modalOpen: boolean,
): boolean {
  return !modalOpen ||
    (action.kind === "key" && action.command.kind === "openConnections");
}

/** The accelerator of item `id` (a window's tile item: its ⌘N from `items`), if it has one. */
export function itemAccelerator(
  id: string,
  items: readonly DesktopWindowMenuAppItem[] = [],
): string | undefined {
  return ACCELERATORS[id] ?? items.find((i) => i.id === id)?.accelerator;
}

/** How long after the page handled a key a menu click with that key's accelerator is dropped. */
export const SHORTCUT_ECHO_MS = 500;

/**
 * The page's guard against a shortcut running twice (its keydown, then the menu item with the same
 * accelerator): `pressed` when the keydown handler ran a command, `allows` for each menu click.
 */
export function createShortcutGuard(now: () => number): {
  pressed(accelerator: string | null): void;
  allows(accelerator: string | undefined): boolean;
} {
  let last: { accelerator: string; at: number } | null = null;
  return {
    pressed(accelerator) {
      last = accelerator ? { accelerator, at: now() } : null;
    },
    allows(accelerator) {
      const echo = last !== null && accelerator === last.accelerator &&
        now() - last.at <= SHORTCUT_ECHO_MS;
      if (echo) last = null;
      return !echo;
    },
  };
}
