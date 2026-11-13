/**
 * The tiles' window controls as the workspace's actions: what a double click on a tile's header
 * does (the OS title-bar double-click preference, `denext/desktop/window`'s
 * `getTitleBarPreferences().doubleClick`) and what the Window menu's tile items do. Pure, so it is
 * tested without a DOM.
 *
 * @module
 */

import { MINIMIZE_TILE_ITEM, type TileMenuItem } from "./windows.ts";

/** A tile window-control action (a {@linkcode WorkspaceAction} type in lib/workspace/store.ts). */
export type TileControl = "minimize" | "maximize" | "restoreTile";

/** Maximize, or Restore when the tile is maximized already (the Zoom toggle). */
const zoom = (maximized: boolean): TileControl =>
  maximized ? "restoreTile" : "maximize";

/**
 * What a double click on a tile's header does, from the user's title-bar double-click action:
 * `"maximize"` zooms (maximize / restore), `"minimize"` minimizes, anything else (`"none"`, and
 * `"shade"`, `"lower"`, `"menu"`, which have no tile meaning) does nothing (`null`).
 */
export function headDoubleClickControl(
  action: string,
  maximized: boolean,
): TileControl | null {
  if (action === "maximize") return zoom(maximized);
  if (action === "minimize") return "minimize";
  return null;
}

/** What a Window-menu tile item does to the focused tile. */
export function tileMenuControl(
  item: TileMenuItem,
  maximized: boolean,
): TileControl {
  return item === MINIMIZE_TILE_ITEM ? "minimize" : zoom(maximized);
}
