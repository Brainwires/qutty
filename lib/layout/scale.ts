/**
 * Sizing math for the "scale" inactive-tile mode: every terminal is laid out at the size of the
 * focused tile's terminal body, and an inactive tile shows it scaled down (letterboxed, centred)
 * to fit its own body. Pure and DOM-free, like the layout engine.
 *
 * The cols/rows themselves still come from xterm's fit addon: the terminal's host element is
 * given the focused body size, so the addon measures exactly what the terminal would get as the
 * focused tile, with that terminal's own font metrics.
 *
 * @module
 */

import type { Rect } from "./mod.ts";

/** A width and height in px. */
export interface Size {
  w: number;
  h: number;
}

/**
 * What a tile's chrome takes from its rect before the terminal body: the 1px border on each
 * side, and the 26px header (its 1px rule included, `box-sizing: border-box`). Mirrors `.tile`
 * / `.tile-head` in public/styles.css (an e2e test checks the two agree).
 */
export const TILE_BODY_INSET: Readonly<Size> = { w: 2, h: 2 + 26 };

/** The terminal body's size inside a tile of the given rect (never negative). */
export function tileBodySize(rect: Rect): Size {
  return {
    w: Math.max(0, finiteOr(rect.w, 0) - TILE_BODY_INSET.w),
    h: Math.max(0, finiteOr(rect.h, 0) - TILE_BODY_INSET.h),
  };
}

/** A scale and the offset (px, applied before scaling, origin top-left) that letterbox it. */
export interface Letterbox {
  scale: number;
  x: number;
  y: number;
}

/**
 * Fit a `full`-sized terminal into `box`: `scale = min(box.w / full.w, box.h / full.h)`, capped
 * at 1 (never magnified), and the offsets that centre the scaled terminal in `box`. A degenerate
 * size gives scale 1 at the origin (nothing sensible to fit).
 */
export function letterbox(box: Size, full: Size): Letterbox {
  const bw = Math.max(0, finiteOr(box.w, 0));
  const bh = Math.max(0, finiteOr(box.h, 0));
  const fw = finiteOr(full.w, 0);
  const fh = finiteOr(full.h, 0);
  if (fw <= 0 || fh <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(1, bw / fw, bh / fh);
  // max(0, …): the bound axis's slack is 0 up to rounding error.
  return {
    scale,
    x: Math.max(0, (bw - fw * scale) / 2),
    y: Math.max(0, (bh - fh * scale) / 2),
  };
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
