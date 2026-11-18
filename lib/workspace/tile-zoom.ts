/**
 * Per-tile zoom: View → Zoom In / Zoom Out / Actual Size (⌘= / ⌘- / ⌘0, Ctrl elsewhere) act on
 * the focused tile only. A terminal tile scales its own font (a factor over Settings' terminal
 * font size; the PTY refits to the new cell), an agent tile and a harness overlay's prompt scale
 * their content by the same factor, and a web tile zooms its page (remembered per site, as before:
 * lib/web/zoom.ts). The steps are the browsers' (lib/web/zoom.ts `stepZoom`), so a terminal at
 * 125% and a page at 125% read the same.
 *
 * A tile's own zoom lives in its entry (`TerminalEntry.zoom`, absent at 100%), so it is saved
 * with the workspace's snapshot and travels with the tile to another window.
 *
 * "Zoom All Tiles Together" (View menu; `Settings.zoomTogether`, default off) swaps every tile's
 * own zoom for one shared level (`Settings.sharedZoom`), synced across windows with the other
 * settings. Zooming any tile then changes the shared level, and every terminal and agent tile in
 * every window follows it. Each tile keeps its own zoom underneath: turning the setting off brings
 * it back. Web pages follow the shared level too, except a site with a zoom of its own (one zoomed
 * while the setting was off): there ⌘= / ⌘- change that site's zoom, and ⌘0 forgets it, so the
 * page joins the shared level again.
 *
 * Pure and client-safe.
 *
 * @module
 */

import { stepZoom } from "../web/zoom.ts";

/** The smallest and largest zoom a tile (or the shared level) takes. */
export const TILE_ZOOM_RANGE = { min: 0.5, max: 3 } as const;

/** The smallest and largest terminal font size a zoom gives, in px. */
const ZOOMED_FONT = { min: 6, max: 96 } as const;

/** `zoom` within {@linkcode TILE_ZOOM_RANGE}, to two decimals; 1 for anything not a number. */
export function clampTileZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  const z = Math.round(zoom * 100) / 100;
  return Math.min(TILE_ZOOM_RANGE.max, Math.max(TILE_ZOOM_RANGE.min, z));
}

/** The next zoom step from `zoom` in direction `dir`, within the range (stays at the ends). */
export function stepTileZoom(zoom: number, dir: 1 | -1): number {
  return clampTileZoom(stepZoom(clampTileZoom(zoom), dir));
}

/** Whether `zoom` is 100% (no indicator, nothing stored). */
export function isActualSize(zoom: number): boolean {
  return Math.abs(zoom - 1) < 1e-3;
}

/** A stored zoom (a snapshot, a moved tile, settings): a valid one, else `undefined`. */
export function sanitizeTileZoom(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const z = clampTileZoom(raw);
  return isActualSize(z) ? undefined : z;
}

/** What a tile's zoom is read from: its own, and the zoom settings. */
export interface ZoomInput {
  /** The tile's own zoom (absent: 100%). */
  zoom?: number;
}

/** The zoom settings (`Settings.zoomTogether` / `Settings.sharedZoom`). */
export interface ZoomSettings {
  zoomTogether: boolean;
  sharedZoom: number;
}

/** The zoom tile `entry` shows: the shared level while tiles zoom together, else its own. */
export function effectiveTileZoom(
  entry: ZoomInput,
  settings: ZoomSettings,
): number {
  return settings.zoomTogether
    ? clampTileZoom(settings.sharedZoom)
    : clampTileZoom(entry.zoom ?? 1);
}

/** The terminal font size Settings' `fontSize` gives at `zoom` (whole px, within bounds). */
export function zoomedFontSize(fontSize: number, zoom: number): number {
  if (isActualSize(zoom)) return fontSize;
  const px = Math.round(fontSize * clampTileZoom(zoom));
  return Math.min(ZOOMED_FONT.max, Math.max(ZOOMED_FONT.min, px));
}

/**
 * The zoom a web page shows: its site's own zoom when it has one, else the shared level while
 * tiles zoom together (`shared`; `null` when they do not), else 100%.
 */
export function pageZoom(
  siteZoom: number | undefined,
  shared: number | null,
): number {
  return siteZoom ?? shared ?? 1;
}
