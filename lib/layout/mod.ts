/**
 * Pure, framework-free tiling layout engine for the GUI terminal.
 *
 * The app (not the user) sizes tiles: the most recently used (MRU) terminal
 * gets the most space, the previously focused one the second most, and so on.
 * Terminals beyond the visible limit are not tiled and are reported as
 * `overflow` (they live only in the switcher bar).
 *
 * Every function here is deterministic: the same input always produces the
 * same rects, so the UI can animate tiles (keyed by id) with CSS transitions.
 *
 * @module
 */

/** An axis-aligned rectangle in px. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Available tiling patterns. */
export type LayoutPattern =
  | "cascade"
  | "spiral"
  | "master-stack"
  | "columns"
  | "rows"
  | "grid"
  | "monocle";

/** Options controlling how tiles are sized and how many are shown. */
export interface LayoutOptions {
  pattern: LayoutPattern;
  /** 0.3..1, weight ratio between consecutive MRU ranks (1 = equal sizes). */
  decay: number;
  /**
   * 0.5..0.85, share of the focused tile for master-stack; also used as a cap
   * on the focused tile's first split for cascade/spiral (see `computeLayout`).
   */
  masterRatio: number;
  /** 1..16, tiles shown; the rest overflow. */
  maxVisible: number;
  /** px between tiles and around the edges. */
  gap: number;
  /** px; if tiles would be narrower, the visible count is reduced. */
  minTileW: number;
  /** px; if tiles would be shorter, the visible count is reduced. */
  minTileH: number;
}

/** A tiled terminal: its id, integer-px rect, and MRU rank (0 = focused). */
export interface LayoutTile {
  id: string;
  rect: Rect;
  rank: number;
}

/** Result of `computeLayout`. */
export interface LayoutResult {
  /** Tiled terminals, ordered by rank (MRU order). */
  tiles: LayoutTile[];
  /** Ids that are not tiled, in MRU order. */
  overflow: string[];
}

/** Sensible defaults for a desktop window. */
export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  pattern: "cascade",
  decay: 0.7,
  masterRatio: 0.6,
  maxVisible: 6,
  gap: 6,
  minTileW: 240,
  minTileH: 120,
};

/** Human-readable metadata for each pattern (for a settings UI). */
export const PATTERN_INFO: Record<
  LayoutPattern,
  { label: string; description: string }
> = {
  cascade: {
    label: "Cascade",
    description:
      "Dwindle split: each terminal takes its share of the remaining space, cut along the longer side, so tiles shrink with age.",
  },
  spiral: {
    label: "Spiral",
    description:
      "Like cascade, but each split rotates around the window (left, top, right, bottom), spiralling older terminals inward.",
  },
  "master-stack": {
    label: "Master + stack",
    description:
      "The focused terminal takes a fixed share of the window; the others stack beside it, sized by recency.",
  },
  columns: {
    label: "Columns",
    description: "Side-by-side columns, with widths sized by recency.",
  },
  rows: {
    label: "Rows",
    description: "Stacked rows, with heights sized by recency.",
  },
  grid: {
    label: "Grid",
    description:
      "A near-square grid filled in reading order; earlier (more recent) cells are bigger.",
  },
  monocle: {
    label: "Monocle",
    description:
      "Only the focused terminal is shown, filling the window; the rest live in the switcher.",
  },
};

const PATTERNS = Object.keys(PATTERN_INFO) as LayoutPattern[];

/** Move `id` to the front of the MRU list (prepends it if absent). Pure. */
export function touch(mru: string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}

/**
 * Visual scale cue for a tile of the given rank, for font/opacity hints.
 * Returns 1 for rank 0 and is non-increasing in rank (strictly decreasing when
 * decay < 1). It is the linear-dimension scale of a tile whose area is
 * proportional to `decay^rank`, i.e. `sqrt(decay)^rank`.
 */
export function rankScale(rank: number, decay: number): number {
  const d = clamp(finiteOr(decay, 1), 0.3, 1);
  const r = Math.max(0, finiteOr(rank, 0));
  return Math.pow(d, r / 2);
}

/**
 * Compute tile rects for terminals in MRU order (`mruIds[0]` is focused).
 *
 * Process:
 * 1. Ids are de-duplicated (first occurrence wins) and options are clamped to
 *    their documented ranges; non-finite bounds coordinates and non-finite or
 *    negative bounds sizes are treated as 0.
 * 2. The candidate visible count `n = min(ids, maxVisible)` (1 for monocle).
 * 3. Fractional rects are computed in the outer area (bounds inset by gap/2),
 *    each tile is inset by gap/2 (so every gap equals `gap`), and edges are
 *    rounded to integer px (edges, not sizes, so there are no overlaps).
 * 4. If any tile is smaller than `minTileW` x `minTileH`, `n` is reduced by
 *    one (the oldest goes to overflow) and step 3 repeats; a single tile is
 *    always accepted.
 *
 * Cascade/spiral cap: with very low decay, the focused tile's exact share
 * `w0 / Σw` can exceed `masterRatio`; in that case the first split fraction is
 * clamped down to `masterRatio`, but never below the fraction needed to keep
 * the focused tile at least as large as rank 1. All later splits keep exact
 * area proportionality (area_i ∝ decay^i for i ≥ 1).
 */
export function computeLayout(
  mruIds: string[],
  bounds: Rect,
  opts: LayoutOptions,
): LayoutResult {
  const ids = dedupe(mruIds);
  if (ids.length === 0) return { tiles: [], overflow: [] };
  const o = normalizeOptions(opts);
  bounds = normalizeBounds(bounds);

  let n = o.pattern === "monocle" ? 1 : Math.min(ids.length, o.maxVisible);
  let rects = layoutRects(n, bounds, o);
  while (n > 1 && !rects.every((r) => r.w >= o.minTileW && r.h >= o.minTileH)) {
    n--;
    rects = layoutRects(n, bounds, o);
  }

  return {
    tiles: rects.map((rect, rank) => ({ id: ids[rank], rect, rank })),
    overflow: ids.slice(n),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Non-finite coordinates become 0; non-finite or negative sizes become 0. */
function normalizeBounds(b: Rect): Rect {
  return {
    x: finiteOr(b.x, 0),
    y: finiteOr(b.y, 0),
    w: Math.max(0, finiteOr(b.w, 0)),
    h: Math.max(0, finiteOr(b.h, 0)),
  };
}

function normalizeOptions(opts: LayoutOptions): LayoutOptions {
  const d = DEFAULT_LAYOUT_OPTIONS;
  return {
    pattern: PATTERNS.includes(opts.pattern) ? opts.pattern : d.pattern,
    decay: clamp(finiteOr(opts.decay, d.decay), 0.3, 1),
    masterRatio: clamp(finiteOr(opts.masterRatio, d.masterRatio), 0.5, 0.85),
    maxVisible: Math.round(
      clamp(finiteOr(opts.maxVisible, d.maxVisible), 1, 16),
    ),
    gap: Math.max(0, finiteOr(opts.gap, d.gap)),
    minTileW: Math.max(0, finiteOr(opts.minTileW, d.minTileW)),
    minTileH: Math.max(0, finiteOr(opts.minTileH, d.minTileH)),
  };
}

function weights(n: number, decay: number): number[] {
  const w: number[] = [];
  for (let i = 0; i < n; i++) w.push(Math.pow(decay, i));
  return w;
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** Final integer rects for `n` tiles: fractional layout, gaps, edge rounding. */
function layoutRects(n: number, bounds: Rect, o: LayoutOptions): Rect[] {
  const half = o.gap / 2;
  const outer = inset(bounds, half);
  if (n <= 1 || o.pattern === "monocle") {
    return [roundEdges(inset(outer, half), bounds)];
  }
  const target = targetWeights(n, o);
  let eff = target;
  let raw = rawLayout(eff, outer, o);
  if (half > 0 && GAP_COMPENSATED.includes(o.pattern)) {
    // Insetting by the gap removes more area (relatively) from thin tiles, so
    // post-gap areas drift from the intended proportions. Nudge the effective
    // weights toward the target a fixed number of times (deterministic).
    const tSum = sum(target);
    for (let k = 0; k < GAP_ITERATIONS; k++) {
      const a = raw.map((r) => area(inset(r, half)));
      const aSum = sum(a);
      if (aSum <= 0) break;
      eff = eff.map((e, i) => {
        const want = (target[i] / tSum) * aSum;
        return e * (a[i] > 0 ? clamp(want / a[i], 0.5, 2) : 2);
      });
      raw = rawLayout(eff, outer, o);
    }
  }
  return raw.map((r) => roundEdges(inset(r, half), bounds));
}

const GAP_COMPENSATED: LayoutPattern[] = [
  "cascade",
  "spiral",
  "columns",
  "rows",
  "grid",
];
const GAP_ITERATIONS = 8;

function area(r: Rect): number {
  return r.w * r.h;
}

/**
 * Intended area weights per rank: decay^i, except that for cascade/spiral the
 * focused share is capped at `masterRatio` (but never below rank 1's share).
 */
function targetWeights(n: number, o: LayoutOptions): number[] {
  const w = weights(n, o.decay);
  if ((o.pattern === "cascade" || o.pattern === "spiral") && n > 1) {
    const rest = sum(w) - w[0];
    const f0 = w[0] / (w[0] + rest);
    if (f0 > o.masterRatio) {
      // Rank 1 would get (1 - f) * r1 of the area; keep f >= that.
      const r1 = w[1] / rest;
      const f = Math.max(o.masterRatio, r1 / (1 + r1));
      w[0] = (f / (1 - f)) * rest;
    }
  }
  return w;
}

function inset(r: Rect, d: number): Rect {
  const w = Math.max(0, r.w - 2 * d);
  const h = Math.max(0, r.h - 2 * d);
  // Keep the rect centred when it collapses.
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

function roundEdges(r: Rect, bounds: Rect): Rect {
  const bx0 = Math.ceil(bounds.x);
  const by0 = Math.ceil(bounds.y);
  const bx1 = Math.max(bx0, Math.floor(bounds.x + bounds.w));
  const by1 = Math.max(by0, Math.floor(bounds.y + bounds.h));
  const x0 = clamp(Math.round(r.x), bx0, bx1);
  const y0 = clamp(Math.round(r.y), by0, by1);
  const x1 = clamp(Math.round(r.x + r.w), x0, bx1);
  const y1 = clamp(Math.round(r.y + r.h), y0, by1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Fractional (unrounded, gapless) rects partitioning `area`. */
function rawLayout(w: number[], area: Rect, o: LayoutOptions): Rect[] {
  if (w.length <= 1) return [{ ...area }];
  switch (o.pattern) {
    case "cascade":
      return dwindle(w, area, false);
    case "spiral":
      return dwindle(w, area, true);
    case "master-stack":
      return masterStack(w, area, o.masterRatio);
    case "columns":
      return strip(w, area, true);
    case "rows":
      return strip(w, area, false);
    case "grid":
      return grid(w, area);
    case "monocle":
      return [{ ...area }];
  }
}

type Side = "left" | "top" | "right" | "bottom";
const SPIRAL_LANDSCAPE: Side[] = ["left", "top", "right", "bottom"];
const SPIRAL_PORTRAIT: Side[] = ["top", "right", "bottom", "left"];

/** Split `rem` so the piece on `side` gets fraction `f`; returns [piece, rest]. */
function cut(rem: Rect, f: number, side: Side): [Rect, Rect] {
  switch (side) {
    case "left": {
      const pw = rem.w * f;
      return [
        { x: rem.x, y: rem.y, w: pw, h: rem.h },
        { x: rem.x + pw, y: rem.y, w: rem.w - pw, h: rem.h },
      ];
    }
    case "right": {
      const pw = rem.w * f;
      return [
        { x: rem.x + rem.w - pw, y: rem.y, w: pw, h: rem.h },
        { x: rem.x, y: rem.y, w: rem.w - pw, h: rem.h },
      ];
    }
    case "top": {
      const ph = rem.h * f;
      return [
        { x: rem.x, y: rem.y, w: rem.w, h: ph },
        { x: rem.x, y: rem.y + ph, w: rem.w, h: rem.h - ph },
      ];
    }
    case "bottom": {
      const ph = rem.h * f;
      return [
        { x: rem.x, y: rem.y + rem.h - ph, w: rem.w, h: ph },
        { x: rem.x, y: rem.y, w: rem.w, h: rem.h - ph },
      ];
    }
  }
}

/**
 * Cascade (dwindle) and spiral. Tile i takes fraction w_i / Σ_{j≥i} w_j of the
 * remaining rect. Cascade cuts along the remaining rect's longer axis and
 * places the tile left/top; spiral rotates the side each step.
 */
function dwindle(
  w: number[],
  area: Rect,
  spiral: boolean,
): Rect[] {
  const n = w.length;
  const out: Rect[] = [];
  const sides = area.w >= area.h ? SPIRAL_LANDSCAPE : SPIRAL_PORTRAIT;
  let rem = area;
  let tail = sum(w);
  for (let i = 0; i < n - 1; i++) {
    const f = w[i] / tail;
    const side: Side = spiral
      ? sides[i % 4]
      : (rem.w >= rem.h ? "left" : "top");
    const [piece, rest] = cut(rem, f, side);
    out.push(piece);
    rem = rest;
    tail -= w[i];
  }
  out.push(rem);
  return out;
}

/** Focused tile takes `masterRatio` of the longer axis; others stack. */
function masterStack(w: number[], area: Rect, masterRatio: number): Rect[] {
  const landscape = area.w >= area.h;
  const [master, rest] = cut(area, masterRatio, landscape ? "left" : "top");
  return [master, ...strip(w.slice(1), rest, !landscape)];
}

/** One strip: side-by-side (`horizontal`) or stacked, sized ∝ weights. */
function strip(w: number[], area: Rect, horizontal: boolean): Rect[] {
  const total = sum(w);
  const out: Rect[] = [];
  let acc = 0;
  for (const wi of w) {
    const a = acc / total;
    acc += wi;
    const b = acc / total;
    out.push(
      horizontal
        ? { x: area.x + area.w * a, y: area.y, w: area.w * (b - a), h: area.h }
        : { x: area.x, y: area.y + area.h * a, w: area.w, h: area.h * (b - a) },
    );
  }
  return out;
}

/**
 * Weighted grid ("slice and dice"): cells fill reading order in rows of
 * `ceil(sqrt(n))`; each row's height ∝ the sum of its weights and each cell's
 * width ∝ its weight within the row, so area_i ∝ w_i exactly. In portrait
 * bounds the grid is transposed (columns of cells).
 */
function grid(w: number[], area: Rect): Rect[] {
  const n = w.length;
  const perLine = Math.ceil(Math.sqrt(n));
  const landscape = area.w >= area.h;
  const lines: number[][] = [];
  for (let i = 0; i < n; i += perLine) lines.push(w.slice(i, i + perLine));
  const lineRects = strip(lines.map(sum), area, !landscape);
  const out: Rect[] = [];
  lines.forEach((line, li) =>
    out.push(...strip(line, lineRects[li], landscape))
  );
  return out;
}
