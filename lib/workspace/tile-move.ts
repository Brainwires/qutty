/**
 * A tile dragged from one window to another, as geometry: whether the pointer left the window,
 * which of the app's other windows is under it, where a torn-off tile's new window opens, and where
 * an arriving tile lands in the window it is dropped on. The moving itself (the PTY changing owner,
 * both workspaces' snapshots) is the app process's (desktop/tile-move.ts). Pure and client-safe, so
 * it is tested without windows (tests/tile_move_test.ts).
 *
 * Coordinates: Denext gives each window's frame in screen points (`getBounds`), and the page's
 * pointer events give `screenX` / `screenY`. The two may differ by a constant (the title bar, the
 * screen the runtime measures from), so the source window calibrates them: its page knows where
 * its viewport is in event coordinates (`screenX - clientX`), and the app process knows its frame.
 *
 * @module
 */

import type { LayoutTile, Rect } from "../layout/mod.ts";
import { HEAD_H } from "./freeform.ts";
import { tileAt } from "./tile-order.ts";
import type { ViewMode } from "./freeform.ts";

/** A point on screen, in the page's event coordinates (`screenX`, `screenY`). */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** A window's frame on screen (Denext's `getBounds`). */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One of the app's windows, for the hit test: its id and frame. */
export interface WindowFrame {
  id: string;
  bounds: Frame;
}

/** The window under a point and the point in that window's page (CSS px from its top-left). */
export interface WindowHit {
  id: string;
  x: number;
  y: number;
}

/** How far the drag must leave the window before it counts as out (px). */
const OUTSIDE_MARGIN = 2;

/** Whether client point (`x`, `y`) is outside a `width` × `height` viewport. */
export function isOutside(
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  return x < -OUTSIDE_MARGIN || y < -OUTSIDE_MARGIN ||
    x > width + OUTSIDE_MARGIN || y > height + OUTSIDE_MARGIN;
}

/**
 * The offset from Denext's frame coordinates to the page's event coordinates, from the source
 * window: `origin` is where its viewport's top-left is in event coordinates (`screenX - clientX`,
 * `screenY - clientY`), `bounds` its frame (`null` where the runtime cannot say: no offset).
 */
export function screenOffset(
  origin: ScreenPoint,
  bounds: Frame | null,
): ScreenPoint {
  return bounds
    ? { x: origin.x - bounds.x, y: origin.y - bounds.y }
    : { x: 0, y: 0 };
}

/**
 * The window under screen point `p` (event coordinates; `offset` from {@linkcode screenOffset}):
 * the first of `frames` whose frame holds it, so `frames` go front to back. `null`: none (the
 * desktop, another app's window that Denext does not know of).
 */
export function windowAt(
  frames: readonly WindowFrame[],
  p: ScreenPoint,
  offset: ScreenPoint,
): WindowHit | null {
  const x = p.x - offset.x;
  const y = p.y - offset.y;
  for (const f of frames) {
    const b = f.bounds;
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
      return { id: f.id, x: x - b.x, y: y - b.y };
    }
  }
  return null;
}

/** How far right of the new window's left edge, and down from its top, the pointer holds it. */
const TEAR_OFF_GRAB = { x: 120, y: 14 };

/**
 * Where a window torn off at screen point `p` opens (Denext's frame coordinates): under the
 * pointer, as if it held the new window by its title bar, at `size` (the source window's).
 */
export function tearOffFrame(
  p: ScreenPoint,
  offset: ScreenPoint,
  size: { width: number; height: number } | null,
): { x: number; y: number; width?: number; height?: number } {
  return {
    x: Math.round(p.x - offset.x - TEAR_OFF_GRAB.x),
    y: Math.round(p.y - offset.y - TEAR_OFF_GRAB.y),
    ...(size
      ? { width: Math.round(size.width), height: Math.round(size.height) }
      : {}),
  };
}

/** Where an arriving tile lands: before which tile of the tile order, or at which free-form rect. */
export interface ArrivalPlace {
  /** Tiled, tiles in place: the tile whose slot it takes (that one and the rest move along). */
  before?: string;
  /** Free-form: its rect (the store clamps it to the area as it draws it). */
  rect?: Rect;
}

/**
 * Where a tile dropped at client point `at` lands. Tiled with tiles in place: the slot under the
 * pointer (the tile there and the ones after it move along); tiled with the focused tile in the
 * main spot, or in monocle: nowhere in particular (it arrives focused, so it takes the main spot).
 * Free-form: its header under the pointer, at its old size (`size`, else half the area). With no
 * point (the menu) it simply arrives.
 */
export function arrivalPlace(opts: {
  at: { x: number; y: number } | undefined;
  view: ViewMode;
  keepsPlaces: boolean;
  /** The tiles drawn now (cluster px). */
  tiles: readonly LayoutTile[];
  /** The cluster's top-left in the page. */
  cluster: { left: number; top: number };
  /** The cluster's area. */
  bounds: Rect;
  size?: { w: number; h: number };
}): ArrivalPlace {
  const { at } = opts;
  if (!at) return {};
  const x = at.x - opts.cluster.left;
  const y = at.y - opts.cluster.top;
  if (opts.view === "freeform") {
    const w = Math.min(opts.size?.w ?? opts.bounds.w / 2, opts.bounds.w);
    const h = Math.min(opts.size?.h ?? opts.bounds.h / 2, opts.bounds.h);
    return {
      rect: {
        x: Math.round(x - w / 2),
        y: Math.round(y - HEAD_H / 2),
        w: Math.round(w),
        h: Math.round(h),
      },
    };
  }
  if (!opts.keepsPlaces) return {};
  const before = tileAt(opts.tiles, x, y, "");
  return before ? { before } : {};
}

/** The id of the next move (unique for the app's life; the app process names them). */
export function moveId(n: number, now: number): string {
  return `mv-${now.toString(36)}-${n}`;
}
