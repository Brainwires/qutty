/**
 * Dragging Loopy within the window (app/companion/use-loopy-drag.ts is the DOM side): a press on
 * its face that moves further than {@linkcode DRAG_THRESHOLD_PX} becomes a drag, and anything
 * shorter stays a click (the poke that opens the chat). On release Loopy snaps to the corner of the
 * tile area nearest the drop point ({@linkcode nearestCorner}), which becomes Settings → Companion
 * → Corner: there is no free position, so the bubble and the chat box keep the layout each corner
 * already has, and the Corner select stays the keyboard's way to move Loopy.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { CompanionCorner } from "./protocol.ts";
import type { Point } from "./loopy-life.ts";

/** How far (CSS px) a press must move before it is a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 5;

/** Whether the pointer has gone from `from` to `to` further than `threshold` px. */
export function isDrag(
  from: Point,
  to: Point,
  threshold = DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > threshold;
}

/**
 * The corner nearest `point` in an area of `size` (`point` from the area's top left): the half it
 * is in, each way. The exact middle goes to the bottom right (the default corner).
 */
export function nearestCorner(
  point: Point,
  size: { readonly width: number; readonly height: number },
): CompanionCorner {
  const top = point.y < size.height / 2;
  const left = point.x < size.width / 2;
  return `${top ? "top" : "bottom"}-${left ? "left" : "right"}`;
}
