/**
 * The free-form (MDI) view's geometry: each tile is an internal window with its own rect inside
 * the workspace area, a back-to-front z-order, and at most one tile maximized (filling the area,
 * the others behind it). The tiled view (lib/layout/mod.ts) ignores all of it, and switching back
 * and forth keeps every tile's free-form rect.
 *
 * Rects are stored as the user left them, in px relative to the area; what is drawn is clamped to
 * the area at render time ({@linkcode placeFreeform}), so a window made smaller and then bigger
 * again gives the tiles their places back, and at least each header stays reachable.
 *
 * Pure and DOM-free, so it is unit-tested without a browser (tests/freeform_test.ts).
 *
 * @module
 */

import type { Rect } from "../layout/mod.ts";

/** How a workspace shows its tiles. */
export type ViewMode = "tiled" | "freeform";

/** Every view mode, in the order the UI lists them. */
export const VIEW_MODES: readonly ViewMode[] = ["tiled", "freeform"];

/** The UI's name for a view mode. */
export const VIEW_LABELS: Record<ViewMode, string> = {
  tiled: "Tiled",
  freeform: "Free-form",
};

/** A view mode from storage (anything else is the tiled view). */
export function sanitizeViewMode(v: unknown): ViewMode {
  return v === "freeform" ? "freeform" : "tiled";
}

/** A workspace's free-form geometry. */
export interface FreeformState {
  /** Each tile's rect as the user left it (unclamped), keyed by tile id. */
  rects: Record<string, Rect>;
  /** Back to front: the last id is drawn on top. */
  z: string[];
  /** The tile maximized over the whole area (MDI maximize), else `null`. */
  maximized: string | null;
}

/** No free-form geometry yet. */
export const EMPTY_FREEFORM: FreeformState = {
  rects: {},
  z: [],
  maximized: null,
};

/** A tile's minimum size (the layout options' `minTileW` × `minTileH`). */
export interface MinSize {
  w: number;
  h: number;
}

/** A resize handle: an edge or a corner, by compass point. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Every resize handle. */
export const EDGES: readonly Edge[] = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
];

/** A tile header's height (styles.css `.tile-head`): what must stay reachable. */
export const HEAD_H = 26;
/** How much of a tile's width stays inside the area when it is dragged off a side. */
export const KEEP_W = 80;
/** The step between cascaded tiles: a header and a bit, so every title shows. */
export const CASCADE_STEP = 28;
/** A new tile's share of the area (each side). */
const NEW_SHARE = 0.6;
/** A cascaded arrangement's largest share of the area (each side). */
const CASCADE_SHARE = 0.8;

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), Math.max(lo, hi));

/** `r` with integer px. */
const rounded = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

/** The minimum size, never bigger than the area. */
function fitMin(min: MinSize, bounds: Rect): MinSize {
  return {
    w: Math.max(1, Math.min(min.w, bounds.w)),
    h: Math.max(1, Math.min(min.h, bounds.h)),
  };
}

/**
 * `r` as it can be drawn in `bounds`: at least `min` (and at most the area) in size, and placed so
 * its header stays reachable: the top edge inside the area, and at least {@linkcode KEEP_W} px of
 * its width over the area.
 */
export function clampRect(r: Rect, bounds: Rect, min: MinSize): Rect {
  const m = fitMin(min, bounds);
  const w = clamp(r.w, m.w, bounds.w);
  const h = clamp(r.h, m.h, bounds.h);
  const keep = Math.min(KEEP_W, w);
  return rounded({
    x: clamp(r.x, keep - w, bounds.w - keep),
    y: clamp(r.y, 0, bounds.h - Math.min(HEAD_H, h)),
    w,
    h,
  });
}

/** `start` moved by (`dx`, `dy`), kept reachable in `bounds`. */
export function moveRect(
  start: Rect,
  dx: number,
  dy: number,
  bounds: Rect,
  min: MinSize,
): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, bounds, min);
}

/**
 * `start` resized from `edge` by (`dx`, `dy`): the opposite edges stay put, the size never goes
 * below `min`, and the dragged edges stop at the area's sides.
 */
export function resizeRect(
  start: Rect,
  edge: Edge,
  dx: number,
  dy: number,
  bounds: Rect,
  min: MinSize,
): Rect {
  const m = fitMin(min, bounds);
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (edge.includes("e")) w = clamp(start.w + dx, m.w, bounds.w - start.x);
  if (edge.includes("s")) h = clamp(start.h + dy, m.h, bounds.h - start.y);
  if (edge.includes("w")) {
    x = clamp(start.x + dx, Math.min(0, start.x), right - m.w);
    w = right - x;
  }
  if (edge.includes("n")) {
    y = clamp(start.y + dy, Math.min(0, start.y), bottom - m.h);
    h = bottom - y;
  }
  return rounded({ x, y, w, h });
}

/** `z` with `id` on top (the same array when it already is). */
export function raise(z: readonly string[], id: string): string[] {
  if (z[z.length - 1] === id) return z as string[];
  return [...z.filter((x) => x !== id), id];
}

/** A new tile's size in `bounds`: a sensible share of the area, at least `min`. */
function newSize(bounds: Rect, min: MinSize): { w: number; h: number } {
  const m = fitMin(min, bounds);
  return {
    w: clamp(Math.round(bounds.w * NEW_SHARE), m.w, bounds.w),
    h: clamp(Math.round(bounds.h * NEW_SHARE), m.h, bounds.h),
  };
}

/**
 * Where a new tile opens: one cascade step down and right of `last` (the tile it opens over), a
 * sensible size, inside the area; back at the top-left corner when the step would leave it.
 * Without `last`, at the area's top-left (inset by `gap`).
 */
export function cascadeNext(
  last: Rect | undefined,
  bounds: Rect,
  min: MinSize,
  gap = 0,
): Rect {
  const { w, h } = newSize(bounds, min);
  const home = { x: gap, y: gap };
  let { x, y } = last
    ? { x: last.x + CASCADE_STEP, y: last.y + CASCADE_STEP }
    : home;
  if (x + w > bounds.w - gap || y + h > bounds.h - gap) ({ x, y } = home);
  return clampRect({ x, y, w, h }, bounds, min);
}

/**
 * Cascade (the MDI command): `ids` back to front, each one step down and right of the one
 * behind it, all one size (as big as the steps leave room for, at most
 * {@linkcode CASCADE_SHARE} of the area, at least `min`); the steps start again at the top-left
 * when they run out of room.
 */
export function cascadeRects(
  ids: readonly string[],
  bounds: Rect,
  min: MinSize,
  gap = 0,
): Record<string, Rect> {
  const m = fitMin(min, bounds);
  const n = ids.length;
  const room = (side: number, lo: number) =>
    clamp(
      Math.min(side * CASCADE_SHARE, side - 2 * gap - CASCADE_STEP * (n - 1)),
      lo,
      side - 2 * gap,
    );
  const w = room(bounds.w, m.w);
  const h = room(bounds.h, m.h);
  // How many steps fit before a tile would leave the area.
  const fit = Math.max(
    1,
    1 +
      Math.floor(
        Math.min(bounds.w - 2 * gap - w, bounds.h - 2 * gap - h) /
          CASCADE_STEP,
      ),
  );
  const out: Record<string, Rect> = {};
  ids.forEach((id, i) => {
    const k = i % fit;
    out[id] = clampRect(
      { x: gap + k * CASCADE_STEP, y: gap + k * CASCADE_STEP, w, h },
      bounds,
      min,
    );
  });
  return out;
}

/** `n` integer spans of `total` px with `gap` px around and between them: [start, size] each. */
function spans(total: number, n: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  const inner = total - gap * (n + 1);
  for (let i = 0; i < n; i++) {
    const a = Math.round(gap * (i + 1) + (inner * i) / n);
    const b = Math.round(gap * (i + 1) + (inner * (i + 1)) / n);
    out.push([a, Math.max(1, b - a)]);
  }
  return out;
}

const transpose = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w });

/** Rows: full-width bands top to bottom, in more columns when the bands would be too short. */
function rowRects(
  ids: readonly string[],
  bounds: Rect,
  min: MinSize,
  gap: number,
): Record<string, Rect> {
  const n = ids.length;
  const fitRows = Math.max(1, Math.floor((bounds.h - gap) / (min.h + gap)));
  const rows = Math.min(n, fitRows);
  const cols = Math.ceil(n / rows);
  const colSpans = spans(bounds.w, cols, gap);
  const out: Record<string, Rect> = {};
  for (let c = 0; c < cols; c++) {
    const inCol = ids.slice(c * rows, (c + 1) * rows);
    const rowSpans = spans(bounds.h, inCol.length, gap);
    inCol.forEach((id, r) => {
      out[id] = {
        x: colSpans[c][0],
        y: rowSpans[r][0],
        w: colSpans[c][1],
        h: rowSpans[r][1],
      };
    });
  }
  return out;
}

/**
 * Tile Horizontally (`"rows"`: full-width bands stacked top to bottom) or Tile Vertically
 * (`"columns"`: full-height columns side by side), `ids` in order, `gap` px around and between
 * them. When the bands would be thinner than `min`, they go into several columns (rows) or rows
 * (columns). A one-time arrangement: the tiles stay free afterwards.
 */
export function stripRects(
  ids: readonly string[],
  bounds: Rect,
  min: MinSize,
  gap: number,
  axis: "rows" | "columns",
): Record<string, Rect> {
  if (ids.length === 0) return {};
  if (axis === "rows") return rowRects(ids, bounds, min, gap);
  const out = rowRects(ids, transpose(bounds), { w: min.h, h: min.w }, gap);
  for (const id of ids) out[id] = transpose(out[id]);
  return out;
}

/** Whether two rects overlap (touching edges do not). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h &&
    b.y < a.y + a.h;
}

/**
 * The tiles another tile covers: each one overlapped by a tile drawn above it. `order` is back to
 * front. A web tile whose engine draws above HTML (a native view) needs this, since it would
 * otherwise sit above a terminal tile that is on top of it (`WebViewHandle.setOccluded`).
 */
export function occludedIds(
  order: readonly { id: string; rect: Rect }[],
): Set<string> {
  const out = new Set<string>();
  order.forEach((low, i) => {
    if (order.slice(i + 1).some((high) => rectsOverlap(low.rect, high.rect))) {
      out.add(low.id);
    }
  });
  return out;
}

/**
 * `seed` rects (the tiles' current tiled rects, when switching to free-form) for the tiles that
 * have no free-form rect yet; the ones that have one keep it.
 */
export function seedRects(
  ff: FreeformState,
  seed: Readonly<Record<string, Rect>>,
): FreeformState {
  const add = Object.entries(seed).filter(([id, r]) =>
    !ff.rects[id] && isRect(r)
  );
  if (add.length === 0) return ff;
  return {
    ...ff,
    rects: {
      ...ff.rects,
      ...Object.fromEntries(add.map(([id, r]) => [id, rounded(r)])),
    },
  };
}

/** `ff` with tile `id` set to `rect`. */
export function setRect(
  ff: FreeformState,
  id: string,
  rect: Rect,
): FreeformState {
  if (!isRect(rect)) return ff;
  const r = rounded(rect);
  const cur = ff.rects[id];
  if (cur && cur.x === r.x && cur.y === r.y && cur.w === r.w && cur.h === r.h) {
    return ff;
  }
  return { ...ff, rects: { ...ff.rects, [id]: r } };
}

/** `ff` without tile `id` (it closed). */
export function dropTile(ff: FreeformState, id: string): FreeformState {
  if (!ff.rects[id] && !ff.z.includes(id) && ff.maximized !== id) return ff;
  const { [id]: _gone, ...rects } = ff.rects;
  return {
    rects,
    z: ff.z.filter((x) => x !== id),
    maximized: ff.maximized === id ? null : ff.maximized,
  };
}

/** `ff` with tile `id` maximized (`on`) or not. */
export function setMaximized(
  ff: FreeformState,
  id: string,
  on: boolean,
): FreeformState {
  const maximized = on ? id : ff.maximized === id ? null : ff.maximized;
  return maximized === ff.maximized ? ff : { ...ff, maximized };
}

/** The area a maximized tile fills: the whole area, inset by the layout's gap. */
export function maximizedRect(bounds: Rect, gap: number): Rect {
  const g = Math.max(0, Math.min(gap, bounds.w / 4, bounds.h / 4));
  return rounded({ x: g, y: g, w: bounds.w - 2 * g, h: bounds.h - 2 * g });
}

/** What the free-form view draws. */
export interface FreeformPlacement {
  /** Each shown tile's rect as drawn (clamped; a maximized tile's fills the area). */
  rects: Record<string, Rect>;
  /** The shown tiles, back to front. */
  order: string[];
  /** Rects placed here for tiles that had none (the workspace stores them). */
  placed: Record<string, Rect>;
}

/**
 * The free-form view of the `shown` tiles (not minimized) in `bounds`: each one's stored rect,
 * clamped to the area; a tile without one is placed {@linkcode cascadeNext} from the tile below it.
 * The order is the z-order, with any shown tile missing from it on top (in `shown` order).
 */
export function placeFreeform(
  ff: FreeformState,
  shown: readonly string[],
  bounds: Rect,
  min: MinSize,
  gap: number,
): FreeformPlacement {
  const set = new Set(shown);
  const order = [
    ...ff.z.filter((id) => set.has(id)),
    ...shown.filter((id) => !ff.z.includes(id)),
  ];
  const rects: Record<string, Rect> = {};
  const placed: Record<string, Rect> = {};
  let below: Rect | undefined;
  for (const id of order) {
    const stored = ff.rects[id];
    const r = stored
      ? clampRect(stored, bounds, min)
      : (placed[id] = cascadeNext(below, bounds, min, gap));
    rects[id] = r;
    below = r;
  }
  if (ff.maximized && set.has(ff.maximized)) {
    rects[ff.maximized] = maximizedRect(bounds, gap);
  }
  return { rects, order, placed };
}

function isRect(v: unknown): v is Rect {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return finite(r.x) && finite(r.y) && finite(r.w) && finite(r.h) && r.w > 0 &&
    r.h > 0;
}

/** Free-form geometry from storage, keeping only `ids`' entries that make sense. */
export function sanitizeFreeform(
  raw: unknown,
  ids: ReadonlySet<string>,
): FreeformState {
  if (typeof raw !== "object" || raw === null) return EMPTY_FREEFORM;
  const v = raw as Record<string, unknown>;
  const rects: Record<string, Rect> = {};
  const rawRects = typeof v.rects === "object" && v.rects !== null
    ? v.rects as Record<string, unknown>
    : {};
  for (const [id, r] of Object.entries(rawRects)) {
    if (ids.has(id) && isRect(r)) rects[id] = rounded(r);
  }
  const z = Array.isArray(v.z)
    ? [...new Set(v.z.filter((id): id is string => ids.has(id as string)))]
    : [];
  const maximized = typeof v.maximized === "string" && ids.has(v.maximized)
    ? v.maximized
    : null;
  return { rects, z, maximized };
}
