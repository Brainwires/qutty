/**
 * The view and window menus' model: the View choice (Tiled / Free-form), the free-form arrange
 * commands and the list of tiles, as menu items with their ids, labels and state. One pure model
 * feeds every surface:
 *
 * - today: the in-app View menu in the switcher bar (app/switcher-bar.tsx renders
 *   {@linkcode viewMenu} and {@linkcode windowAppItems} as they are), and the static Window-menu
 *   items (`desktop.menu.window.items`, denext.config.ts: {@linkcode STATIC_WINDOW_ITEMS}, which
 *   carry no state);
 * - later (Denext's draft menu API, 4.18): `desktop.menu.menus: [{ id: VIEW_MENU_ID, label:
 *   "View", after: "edit", items: viewMenu(...) }]` with `setMenuItemState(id, { checked,
 *   enabled }, { windowId })` from {@linkcode viewMenu}, and
 *   `setWindowMenuAppItems(windowId, windowAppItems(...))` for the tile list under the native
 *   window list. The item shapes here are that API's `MenuItem` and window app item, one to one,
 *   and the ids are stable, so wiring it is one small change in the page.
 *
 * A click (an in-app item, or the Window menu's `{ id, keyWindow }`) is read back with
 * {@linkcode menuCommand}.
 *
 * @module
 */

import { VIEW_LABELS, type ViewMode } from "./freeform.ts";

/** A menu item (Denext's draft `MenuItem`). Radio items toggle within their `group`. */
export interface MenuItem {
  id: string;
  label: string;
  accelerator?: string;
  enabled?: boolean;
  checked?: boolean;
  type?: "normal" | "checkbox" | "radio" | "separator" | "submenu";
  group?: string;
  items?: MenuItem[];
  icon?: string;
  role?: string;
}

/** An item of a window's own section under the native window list (Denext's draft). */
export interface WindowAppItem {
  id: string;
  label: string;
  checked?: boolean;
  enabled?: boolean;
  accelerator?: string;
  type?: "normal" | "separator";
}

/** The View menu's id (Denext's draft `desktop.menu.menus[].id`), the prefix of its items' ids. */
const VIEW_MENU_ID = "qutty:view";
/** The radio group of the View choice. */
export const VIEW_GROUP = `${VIEW_MENU_ID}:mode`;

/** The stable ids of the view and arrange items. */
export const MDI_ITEM_IDS = {
  viewTiled: `${VIEW_MENU_ID}:tiled`,
  viewFreeform: `${VIEW_MENU_ID}:freeform`,
  cascade: "qutty:arrange:cascade",
  tileHorizontally: "qutty:arrange:rows",
  tileVertically: "qutty:arrange:columns",
} as const;

/** A view or arrange command. */
export type MdiCommand = keyof typeof MDI_ITEM_IDS;

/** A menu item id that names a view or arrange command. */
export type MdiItemId = typeof MDI_ITEM_IDS[MdiCommand];

/** The labels (macOS style: title case, no ellipsis, as they do their thing at once). */
export const MDI_LABELS: Record<MdiCommand, string> = {
  viewTiled: `${VIEW_LABELS.tiled} View`,
  viewFreeform: `${VIEW_LABELS.freeform} View`,
  cascade: "Cascade Tiles",
  tileHorizontally: "Arrange Tiles in Rows",
  tileVertically: "Arrange Tiles in Columns",
};

/** The arrange commands, in menu order (free-form only). */
const ARRANGE: readonly MdiCommand[] = [
  "cascade",
  "tileHorizontally",
  "tileVertically",
];

/**
 * "Arrange Minimized" (MDI's arrange icons): a minimized tile is a chip in the switcher bar, which
 * lays the chips out already, so it is never meaningful here and is left out of every menu. It
 * would come back if minimized tiles ever lay in the area as icons.
 */

/** The prefix of a tile-list item's id (`qutty:tiles:focus:<tile id>`). */
const TILE_ITEM_PREFIX = "qutty:tiles:focus:";

/** The id of the tile-list item that focuses tile `tileId`. */
export function tileItemId(tileId: string): string {
  return TILE_ITEM_PREFIX + tileId;
}

/** One tile as the menus list it. */
export interface MenuTile {
  id: string;
  /** What its header shows. */
  title: string;
  focused: boolean;
  minimized: boolean;
}

/** What the menus are computed from. */
export interface MdiMenuInput {
  view: ViewMode;
  /** Every tile, in the order the list shows them. */
  tiles: readonly MenuTile[];
}

const SEPARATOR = (id: string): MenuItem => ({
  id,
  label: "",
  type: "separator",
});

/** The arrange commands as items: enabled in free-form with a tile shown, else greyed. */
function arrangeItems(input: MdiMenuInput): MenuItem[] {
  const enabled = input.view === "freeform" &&
    input.tiles.some((t) => !t.minimized);
  return ARRANGE.map((c) => ({
    id: MDI_ITEM_IDS[c],
    label: MDI_LABELS[c],
    type: "normal",
    enabled,
  }));
}

/**
 * The View menu: Tiled View and Free-form View as radio items of one group (the workspace's
 * view checked), then the arrange commands, enabled only in the free-form view.
 */
export function viewMenu(input: MdiMenuInput): MenuItem[] {
  const radio = (c: "viewTiled" | "viewFreeform", view: ViewMode) => ({
    id: MDI_ITEM_IDS[c],
    label: MDI_LABELS[c],
    type: "radio" as const,
    group: VIEW_GROUP,
    checked: input.view === view,
    enabled: true,
  });
  return [
    radio("viewTiled", "tiled"),
    radio("viewFreeform", "freeform"),
    SEPARATOR(`${VIEW_MENU_ID}:sep`),
    ...arrangeItems(input),
  ];
}

/**
 * A window's own section of the Window menu: its tiles (the focused one checked; a click focuses,
 * or restores a minimized one), then the arrange commands.
 */
export function windowAppItems(input: MdiMenuInput): WindowAppItem[] {
  const tiles: WindowAppItem[] = input.tiles.map((t) => ({
    id: tileItemId(t.id),
    label: t.minimized ? `${t.title} (minimized)` : t.title,
    type: "normal",
    checked: t.focused,
    enabled: true,
  }));
  const arrange = arrangeItems(input).map(({ id, label, enabled }) => ({
    id,
    label,
    type: "normal" as const,
    enabled,
  }));
  return tiles.length === 0 ? arrange : [
    ...tiles,
    { id: "qutty:tiles:sep", label: "", type: "separator" },
    ...arrange,
  ];
}

/**
 * Today's static Window-menu items (`desktop.menu.window.items`: no state, no shortcuts): the
 * View choice and the arrange commands, with the labels the model gives them.
 */
export const STATIC_WINDOW_ITEMS: readonly { id: MdiItemId; label: string }[] =
  (Object.keys(MDI_ITEM_IDS) as MdiCommand[]).map((c) => ({
    id: MDI_ITEM_IDS[c],
    label: MDI_LABELS[c],
  }));

const COMMAND_OF = new Map<string, MdiCommand>(
  (Object.keys(MDI_ITEM_IDS) as MdiCommand[]).map((c) => [MDI_ITEM_IDS[c], c]),
);

/** Whether a menu item id is one of the view or arrange items. */
export function isMdiItem(id: unknown): id is MdiItemId {
  return typeof id === "string" && COMMAND_OF.has(id);
}

/** What a click on menu item `id` asks for, or `null` for an id that is not this model's. */
export function menuCommand(
  id: string,
): { command: MdiCommand } | { focus: string } | null {
  const command = COMMAND_OF.get(id);
  if (command) return { command };
  if (id.startsWith(TILE_ITEM_PREFIX) && id.length > TILE_ITEM_PREFIX.length) {
    return { focus: id.slice(TILE_ITEM_PREFIX.length) };
  }
  return null;
}
