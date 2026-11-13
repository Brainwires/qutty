// The free-form (MDI) view: its geometry (lib/workspace/freeform.ts: clamping, moving, resizing
// with minimum sizes, cascade, the row and column arrangements, z-order, tiled → free-form
// seeding, placement, overlap), the view actions in the reducer (lib/workspace/view.ts,
// lib/workspace/store.ts: view per workspace and for new ones, maximize / restore / minimize in
// free-form, the focused tile on top), the snapshot round trip (lib/workspace/session.ts), and
// the menu model (lib/workspace/mdi-menu.ts) with its routing to the page.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import type { Rect } from "../lib/layout/mod.ts";
import { computeLayout } from "../lib/layout/mod.ts";
import {
  CASCADE_STEP,
  cascadeNext,
  cascadeRects,
  clampRect,
  dropTile,
  EMPTY_FREEFORM,
  HEAD_H,
  KEEP_W,
  maximizedRect,
  moveRect,
  occludedIds,
  placeFreeform,
  raise,
  rectsOverlap,
  resizeRect,
  sanitizeFreeform,
  sanitizeViewMode,
  seedRects,
  stripRects,
} from "../lib/workspace/freeform.ts";
import {
  initialState,
  isMaximized,
  maximizedId,
  reduce,
  sanitizeSettings,
  shownMru,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import { planRestore, snapshotOf } from "../lib/workspace/session.ts";
import {
  isMdiItem,
  MDI_ITEM_IDS,
  MDI_LABELS,
  menuCommand,
  STATIC_WINDOW_ITEMS,
  tileItemId,
  VIEW_GROUP,
  viewMenu,
  windowAppItems,
} from "../lib/workspace/mdi-menu.ts";
import {
  isPageMenuItem,
  MINIMIZE_TILE_ITEM,
} from "../lib/workspace/windows.ts";
import { tileMenuToPage } from "../desktop/session.ts";
import { fakeExtensionHost } from "./session_helpers.ts";

const AREA: Rect = { x: 0, y: 0, w: 1000, h: 600 };
const MIN = { w: 240, h: 120 };

const run = (actions: WorkspaceAction[], from = initialState()) =>
  actions.reduce(reduce, from);

/** a, b, c added (c focused), shown free-form. */
const freeThree = (): WorkspaceState =>
  run([
    { type: "add", id: "a", now: 1 },
    { type: "add", id: "b", now: 2 },
    { type: "add", id: "c", now: 3 },
    { type: "setView", view: "freeform" },
  ]);

const inside = (r: Rect, b: Rect) =>
  r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w && r.y + r.h <= b.y + b.h;

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

Deno.test("clampRect: the header stays reachable; sizes between the minimum and the area", () => {
  // Off the bottom right: the top edge comes back so the header shows, KEEP_W of it stays over.
  const far = clampRect({ x: 5000, y: 5000, w: 400, h: 300 }, AREA, MIN);
  assertEquals(far, { x: AREA.w - KEEP_W, y: AREA.h - HEAD_H, w: 400, h: 300 });
  // Off the top left: the top edge is never above the area; KEEP_W stays over the left side.
  const up = clampRect({ x: -900, y: -50, w: 400, h: 300 }, AREA, MIN);
  assertEquals(up, { x: KEEP_W - 400, y: 0, w: 400, h: 300 });
  // Too small → the minimum; too big → the area.
  assertEquals(clampRect({ x: 10, y: 10, w: 10, h: 10 }, AREA, MIN), {
    x: 10,
    y: 10,
    w: 240,
    h: 120,
  });
  const big = clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, AREA, MIN);
  assertEquals([big.w, big.h], [AREA.w, AREA.h]);
  // An area smaller than the minimum: the minimum gives way to the area.
  const tiny = { x: 0, y: 0, w: 200, h: 100 };
  const t = clampRect({ x: 0, y: 0, w: 300, h: 300 }, tiny, MIN);
  assertEquals([t.w, t.h], [200, 100]);
});

Deno.test("moveRect: moves by the delta, clamped", () => {
  const r = { x: 100, y: 100, w: 300, h: 200 };
  assertEquals(moveRect(r, 50, -20, AREA, MIN), {
    x: 150,
    y: 80,
    w: 300,
    h: 200,
  });
  assertEquals(moveRect(r, 0, -500, AREA, MIN).y, 0);
});

Deno.test("resizeRect: every edge and corner, the opposite side fixed, the minimum held", () => {
  const r = { x: 200, y: 200, w: 400, h: 300 };
  assertEquals(resizeRect(r, "e", 50, 0, AREA, MIN), { ...r, w: 450 });
  assertEquals(resizeRect(r, "s", 0, 40, AREA, MIN), { ...r, h: 340 });
  assertEquals(resizeRect(r, "w", -50, 0, AREA, MIN), {
    x: 150,
    y: 200,
    w: 450,
    h: 300,
  });
  assertEquals(resizeRect(r, "n", 0, -30, AREA, MIN), {
    x: 200,
    y: 170,
    w: 400,
    h: 330,
  });
  assertEquals(resizeRect(r, "se", 10, 20, AREA, MIN), {
    ...r,
    w: 410,
    h: 320,
  });
  assertEquals(resizeRect(r, "nw", -10, -20, AREA, MIN), {
    x: 190,
    y: 180,
    w: 410,
    h: 320,
  });
  // The minimum: shrinking from the west stops with the right edge where it was.
  const w = resizeRect(r, "w", 1000, 0, AREA, MIN);
  assertEquals([w.w, w.x + w.w], [MIN.w, 600]);
  const ne = resizeRect(r, "ne", -1000, 1000, AREA, MIN);
  assertEquals([ne.w, ne.h, ne.y + ne.h], [MIN.w, MIN.h, 500]);
  // The area's sides stop the dragged edges.
  assertEquals(resizeRect(r, "e", 5000, 0, AREA, MIN).w, AREA.w - r.x);
  assertEquals(resizeRect(r, "n", 0, -5000, AREA, MIN).y, 0);
  assertEquals(resizeRect(r, "sw", -5000, 5000, AREA, MIN), {
    x: 0,
    y: 200,
    w: 600,
    h: AREA.h - 200,
  });
});

Deno.test("raise: to the top, the same array when it is there already", () => {
  const z = ["a", "b", "c"];
  assertEquals(raise(z, "a"), ["b", "c", "a"]);
  assertStrictEquals(raise(z, "c"), z);
  assertEquals(raise(z, "d"), ["a", "b", "c", "d"]);
});

Deno.test("cascadeNext: a step down-right of the last tile, a sensible size, inside the area", () => {
  const first = cascadeNext(undefined, AREA, MIN, 6);
  assertEquals([first.x, first.y], [6, 6]);
  assertEquals([first.w, first.h], [600, 360], "60% of the area");
  const second = cascadeNext(first, AREA, MIN, 6);
  assertEquals([second.x, second.y], [6 + CASCADE_STEP, 6 + CASCADE_STEP]);
  // Near the bottom right: back to the top left rather than out of the area.
  const late = cascadeNext({ x: 380, y: 230, w: 600, h: 360 }, AREA, MIN, 6);
  assertEquals([late.x, late.y], [6, 6]);
  for (const r of [first, second, late]) assert(inside(r, AREA));
  // A tiny area: the minimum size, still inside.
  const small = cascadeNext(undefined, { x: 0, y: 0, w: 300, h: 150 }, MIN);
  assertEquals([small.w, small.h], [240, 120]);
});

Deno.test("cascadeRects: offset windows in z-order, one size, wrapping when out of room", () => {
  const rects = cascadeRects(["a", "b", "c"], AREA, MIN, 6);
  assertEquals([rects.a.x, rects.b.x, rects.c.x], [
    6,
    6 + CASCADE_STEP,
    6 + 2 * CASCADE_STEP,
  ]);
  assertEquals(rects.a.y, rects.a.x);
  assertEquals(
    new Set(Object.values(rects).map((r) => `${r.w}x${r.h}`)).size,
    1,
  );
  for (const r of Object.values(rects)) assert(inside(r, AREA));
  // Many tiles: the steps start over, every tile stays inside.
  const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const many = cascadeRects(ids, AREA, MIN, 6);
  for (const r of Object.values(many)) {
    assert(inside(r, AREA), JSON.stringify(r));
    assert(r.w >= MIN.w && r.h >= MIN.h);
  }
  assert(many.t39.x < many.t38.x || many.t39.x > many.t0.x, "wrapped");
});

Deno.test("stripRects: rows stack full-width bands, columns sit side by side, gaps between", () => {
  const rows = stripRects(["a", "b", "c"], AREA, MIN, 6, "rows");
  assertEquals(rows.a.x, 6);
  assertEquals(rows.a.w, AREA.w - 12);
  assert(rows.a.y < rows.b.y && rows.b.y < rows.c.y);
  assertEquals(rows.b.y - (rows.a.y + rows.a.h), 6, "the gap");
  assertEquals(rows.c.y + rows.c.h, AREA.h - 6);
  const cols = stripRects(["a", "b", "c"], AREA, MIN, 6, "columns");
  assertEquals(cols.a.y, 6);
  assertEquals(cols.a.h, AREA.h - 12);
  assert(cols.a.x < cols.b.x && cols.b.x < cols.c.x);
  assertEquals(cols.c.x + cols.c.w, AREA.w - 6);
  // Too many for one band each above the minimum: more columns of rows, never below it.
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const dense = stripRects(ids, AREA, MIN, 6, "rows");
  for (const r of Object.values(dense)) {
    assert(r.h >= MIN.h, `row ${r.h}`);
    assert(inside(r, AREA));
  }
  assert(new Set(Object.values(dense).map((r) => r.x)).size > 1);
  assertEquals(stripRects([], AREA, MIN, 6, "rows"), {});
});

Deno.test("occludedIds: a tile is occluded by an overlapping tile above it, not below", () => {
  const order = [
    { id: "web", rect: { x: 0, y: 0, w: 400, h: 300 } },
    { id: "term", rect: { x: 300, y: 200, w: 400, h: 300 } },
    { id: "far", rect: { x: 800, y: 0, w: 100, h: 100 } },
  ];
  assertEquals([...occludedIds(order)], ["web"]);
  // Raise the web tile: nothing covers it any more; the terminal under it is covered.
  assertEquals([...occludedIds([order[1], order[0], order[2]])], ["term"]);
  // Touching edges do not overlap.
  assert(
    !rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }),
  );
  assertEquals(occludedIds([]).size, 0);
});

Deno.test("seedRects / placeFreeform: tiled rects seed missing tiles; new ones cascade", () => {
  const layout = computeLayout(
    ["a", "b"],
    AREA,
    initialState().settings.layout,
  );
  const seed = Object.fromEntries(layout.tiles.map((t) => [t.id, t.rect]));
  const kept = { x: 1, y: 2, w: 300, h: 200 };
  const ff = seedRects({ ...EMPTY_FREEFORM, rects: { a: kept } }, seed);
  assertEquals(ff.rects.a, kept, "a stored rect is kept");
  assertEquals(ff.rects.b, seed.b, "a missing one is seeded");
  assertStrictEquals(seedRects(ff, seed), ff);
  // Placement: c has no rect → a cascade step from the tile below it (b, by the z-order).
  const p = placeFreeform(
    { ...ff, z: ["a", "b"] },
    ["c", "b", "a"],
    AREA,
    MIN,
    6,
  );
  assertEquals(p.order, ["a", "b", "c"]);
  assertEquals(Object.keys(p.placed), ["c"]);
  assertEquals(p.rects.c, cascadeNext(p.rects.b, AREA, MIN, 6));
  // A stored rect outside a smaller area is drawn clamped (and stays stored as it was).
  const shrunk = { x: 0, y: 0, w: 500, h: 300 };
  const q = placeFreeform(
    { ...ff, rects: { ...ff.rects, a: { x: 900, y: 550, w: 300, h: 200 } } },
    ["a"],
    shrunk,
    MIN,
    6,
  );
  assertEquals(
    q.rects.a,
    clampRect({ x: 900, y: 550, w: 300, h: 200 }, shrunk, MIN),
  );
  // Maximized: the whole area (inset by the gap).
  const m = placeFreeform({ ...ff, maximized: "a" }, ["a", "b"], AREA, MIN, 6);
  assertEquals(m.rects.a, maximizedRect(AREA, 6));
  assertEquals(m.rects.a, { x: 6, y: 6, w: 988, h: 588 });
});

Deno.test("sanitizeFreeform / dropTile / sanitizeViewMode", () => {
  const ids = new Set(["a", "b"]);
  assertEquals(
    sanitizeFreeform({
      rects: {
        a: { x: 1.4, y: 2, w: 300, h: 200 },
        b: { x: 0, y: 0, w: -1, h: 5 },
        gone: { x: 0, y: 0, w: 10, h: 10 },
      },
      z: ["gone", "b", "a", "a", 3],
      maximized: "gone",
    }, ids),
    {
      rects: { a: { x: 1, y: 2, w: 300, h: 200 } },
      z: ["b", "a"],
      maximized: null,
    },
  );
  assertEquals(sanitizeFreeform("junk", ids), EMPTY_FREEFORM);
  const ff = { rects: { a: AREA }, z: ["a", "b"], maximized: "a" };
  assertEquals(dropTile(ff, "a"), { rects: {}, z: ["b"], maximized: null });
  assertStrictEquals(dropTile(ff, "zz"), ff);
  assertEquals(sanitizeViewMode("freeform"), "freeform");
  assertEquals(sanitizeViewMode("mdi"), "tiled");
  assertEquals(sanitizeViewMode(undefined), "tiled");
});

// ---------------------------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------------------------

Deno.test("view: tiled by default; per workspace; the default for new ones is a setting", () => {
  const s = initialState();
  assertEquals(s.view, "tiled");
  assertEquals(s.settings.defaultView, "tiled");
  const d = reduce(s, { type: "setDefaultView", view: "freeform" });
  assertEquals(d.settings.defaultView, "freeform");
  assertEquals(d.view, "tiled", "the setting does not switch this workspace");
  assertStrictEquals(
    reduce(d, { type: "setDefaultView", view: "freeform" }),
    d,
  );
  assertEquals(
    sanitizeSettings({ defaultView: "freeform" }).defaultView,
    "freeform",
  );
  assertEquals(sanitizeSettings({ defaultView: "junk" }).defaultView, "tiled");
  const v = reduce(s, { type: "setView", view: "freeform" });
  assertEquals(v.view, "freeform");
  assertStrictEquals(reduce(v, { type: "setView", view: "freeform" }), v);
});

Deno.test("view: switching seeds missing rects from the tiled ones and keeps stored rects", () => {
  const s = run([
    { type: "add", id: "a", now: 1 },
    { type: "add", id: "b", now: 2 },
  ]);
  const layout = computeLayout(shownMru(s), AREA, s.settings.layout);
  const seed = Object.fromEntries(layout.tiles.map((t) => [t.id, t.rect]));
  const free = reduce(s, { type: "setView", view: "freeform", seed });
  assertEquals(free.freeform.rects, seed, "no jump: the tiled rects");
  const moved = reduce(free, {
    type: "freeformRect",
    id: "a",
    rect: { x: 50, y: 60, w: 300, h: 200 },
  });
  const back = reduce(moved, { type: "setView", view: "tiled" });
  assertEquals(
    back.freeform,
    moved.freeform,
    "tiled keeps the free-form geometry",
  );
  const again = reduce(back, { type: "setView", view: "freeform", seed });
  assertEquals(again.freeform.rects.a, { x: 50, y: 60, w: 300, h: 200 });
  // An unknown tile's rect is ignored.
  assertStrictEquals(
    reduce(again, { type: "freeformRect", id: "zz", rect: AREA }),
    again,
  );
});

Deno.test("z-order: focus raises (a click, the bar, a shortcut); close drops the tile", () => {
  let s = freeThree();
  assertEquals(s.freeform.z, ["a", "b", "c"]);
  s = reduce(s, { type: "focus", id: "a", now: 4 });
  assertEquals(s.freeform.z, ["b", "c", "a"]);
  s = reduce(s, { type: "cycle", dir: 1, now: 5 });
  assertEquals(s.freeform.z.at(-1), s.focusedId);
  s = reduce(s, { type: "endCycle" });
  s = reduce(s, { type: "freeformSeed", rects: { a: AREA, zz: AREA } });
  assertEquals(Object.keys(s.freeform.rects), ["a"]);
  s = reduce(s, { type: "remove", id: "a" });
  assert(!s.freeform.z.includes("a"));
  assertEquals(s.freeform.rects, {});
  // The next focused tile comes to the top.
  assertEquals(s.freeform.z.at(-1), s.focusedId);
});

Deno.test("free-form Maximize fills the area for one tile; Restore returns it; no pattern change", () => {
  const s = freeThree();
  const pattern = s.settings.layout.pattern;
  const m = reduce(s, { type: "maximize", id: "a", now: 4 });
  assertEquals(m.freeform.maximized, "a");
  assertEquals(m.focusedId, "a");
  assertEquals(m.freeform.z.at(-1), "a", "on top, the others behind");
  assertEquals(m.settings.layout.pattern, pattern, "not monocle");
  assertEquals(m.previousPattern, null);
  assert(isMaximized(m, "a") && !isMaximized(m, "b"));
  assertEquals(maximizedId(m), "a");
  // Focusing another tile raises it over the maximized one, which stays maximized.
  const f = reduce(m, { type: "focus", id: "b", now: 5 });
  assertEquals(f.freeform.maximized, "a");
  assertEquals(f.freeform.z.at(-1), "b");
  const r = reduce(m, { type: "restoreTile", id: "a", now: 6 });
  assertEquals(r.freeform.maximized, null);
  assertEquals(r.settings.layout.pattern, pattern);
  assertEquals(maximizedId(r), null);
  // Mod+Enter in free-form: maximize / restore the focused tile.
  const t = reduce(s, { type: "toggleMonocle" });
  assertEquals([t.freeform.maximized, t.settings.layout.pattern], [
    "c",
    pattern,
  ]);
  assertEquals(reduce(t, { type: "toggleMonocle" }).freeform.maximized, null);
  // Arranging ends a maximize.
  const a = reduce(m, { type: "arrange", how: "cascade", bounds: AREA });
  assertEquals(a.freeform.maximized, null);
});

Deno.test("free-form Minimize goes to a chip; restoring brings the rect back, not maximized", () => {
  let s = freeThree();
  s = reduce(s, {
    type: "freeformRect",
    id: "c",
    rect: { x: 10, y: 20, w: 300, h: 200 },
  });
  s = reduce(s, { type: "maximize", id: "c", now: 4 });
  s = reduce(s, { type: "minimize", id: "c", now: 5 });
  assertEquals(s.terminals.find((t) => t.id === "c")!.minimized, true);
  assertEquals(s.freeform.maximized, null);
  assertEquals(s.focusedId, "b");
  assertEquals(s.freeform.z.at(-1), "b");
  s = reduce(s, { type: "focus", id: "c", now: 6 });
  assertEquals(s.terminals.find((t) => t.id === "c")!.minimized, undefined);
  assertEquals(s.freeform.rects.c, { x: 10, y: 20, w: 300, h: 200 });
  assertEquals(s.freeform.z.at(-1), "c");
});

Deno.test("tiled view: #60's Maximize (monocle) and Restore are unchanged", () => {
  const s = run([
    { type: "add", id: "a", now: 1 },
    { type: "add", id: "b", now: 2 },
  ]);
  const m = reduce(s, { type: "maximize", id: "a", now: 3 });
  assertEquals(m.settings.layout.pattern, "monocle");
  assertEquals(m.freeform.maximized, null);
  assert(isMaximized(m, "a"));
  const r = reduce(m, { type: "restoreTile", id: "a", now: 4 });
  assertEquals(r.settings.layout.pattern, "cascade");
  // Arrange commands are no-ops in the tiled view.
  assertStrictEquals(
    reduce(s, { type: "arrange", how: "rows", bounds: AREA }),
    s,
  );
});

Deno.test("arrange: cascade in z-order, rows / columns in recency order, shown tiles only", () => {
  let s = freeThree();
  s = reduce(s, { type: "minimize", id: "a", now: 4 });
  const c = reduce(s, { type: "arrange", how: "cascade", bounds: AREA });
  // z: a b c with a minimized → b behind c; c (the front) lowest and rightmost.
  assert(c.freeform.rects.c.x > c.freeform.rects.b.x);
  assert(!c.freeform.rects.a, "a minimized tile is left alone");
  const rows = reduce(s, { type: "arrange", how: "rows", bounds: AREA });
  assert(
    rows.freeform.rects.c.y < rows.freeform.rects.b.y,
    "the focused tile on top",
  );
  assertEquals(rows.freeform.rects.c.x, rows.freeform.rects.b.x);
  const cols = reduce(s, { type: "arrange", how: "columns", bounds: AREA });
  assert(
    cols.freeform.rects.c.x < cols.freeform.rects.b.x,
    "the focused tile left",
  );
  // An empty area does nothing.
  assertStrictEquals(
    reduce(s, {
      type: "arrange",
      how: "rows",
      bounds: { x: 0, y: 0, w: 0, h: 0 },
    }),
    s,
  );
});

// ---------------------------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------------------------

Deno.test("snapshot: the view and the free-form geometry round-trip; an old one is tiled", () => {
  let s = freeThree();
  s = reduce(s, {
    type: "freeformRect",
    id: "a",
    rect: { x: 5, y: 6, w: 300, h: 200 },
  });
  s = reduce(s, { type: "maximize", id: "b", now: 4 });
  const snap = snapshotOf(s, 3, () => ({
    ptyId: null,
    profile: { kind: "shell" },
  }));
  assertEquals(snap.view, "freeform");
  const plan = planRestore(JSON.parse(JSON.stringify(snap)), [])!;
  assertEquals(plan.view, "freeform");
  assertEquals(plan.freeform, s.freeform);
  const back = reduce(initialState(), {
    type: "restore",
    terminals: plan.terminals,
    mru: plan.mru,
    previousPattern: plan.previousPattern,
    view: plan.view,
    freeform: plan.freeform,
  });
  assertEquals(back.view, "freeform");
  assertEquals(back.freeform.rects.a, { x: 5, y: 6, w: 300, h: 200 });
  assertEquals(back.freeform.maximized, "b");
  assertEquals(back.freeform.z.at(-1), back.focusedId);
  // A snapshot from before the free-form view: tiled, no geometry.
  const { view: _v, freeform: _f, ...old } = snap;
  const oldPlan = planRestore(old, [])!;
  assertEquals(oldPlan.view, "tiled");
  assertEquals(oldPlan.freeform, EMPTY_FREEFORM);
});

// ---------------------------------------------------------------------------------------------
// The menu model
// ---------------------------------------------------------------------------------------------

const TILES = [
  { id: "a", title: "zsh — ~", focused: false, minimized: false },
  { id: "b", title: "vim", focused: true, minimized: false },
  { id: "c", title: "htop", focused: false, minimized: true },
];

Deno.test("menu model: View radios in one group, arrange items enabled only free-form", () => {
  const tiled = viewMenu({ view: "tiled", tiles: TILES });
  assertEquals(tiled.map((i) => i.id), [
    MDI_ITEM_IDS.viewTiled,
    MDI_ITEM_IDS.viewFreeform,
    "qutty:view:sep",
    MDI_ITEM_IDS.cascade,
    MDI_ITEM_IDS.tileHorizontally,
    MDI_ITEM_IDS.tileVertically,
  ]);
  assertEquals(tiled[0], {
    id: "qutty:view:tiled",
    label: "Tiled View",
    type: "radio",
    group: VIEW_GROUP,
    checked: true,
    enabled: true,
  });
  assertEquals(tiled[1].checked, false);
  assertEquals(tiled[2].type, "separator");
  assert(tiled.slice(3).every((i) => i.enabled === false));
  const free = viewMenu({ view: "freeform", tiles: TILES });
  assertEquals([free[0].checked, free[1].checked], [false, true]);
  assert(free.slice(3).every((i) => i.enabled === true));
  // Free-form with every tile minimized: nothing to arrange.
  const none = viewMenu({
    view: "freeform",
    tiles: TILES.map((t) => ({ ...t, minimized: true })),
  });
  assert(none.slice(3).every((i) => i.enabled === false));
  assertEquals(
    free.slice(3).map((i) => i.label),
    ["Cascade Tiles", "Arrange Tiles in Rows", "Arrange Tiles in Columns"],
  );
});

Deno.test("menu model: the window's items list the tiles, the focused one checked", () => {
  const items = windowAppItems({ view: "freeform", tiles: TILES });
  assertEquals(items.slice(0, 3), [
    {
      id: tileItemId("a"),
      label: "zsh — ~",
      type: "normal",
      checked: false,
      enabled: true,
    },
    {
      id: tileItemId("b"),
      label: "vim",
      type: "normal",
      checked: true,
      enabled: true,
    },
    {
      id: tileItemId("c"),
      label: "htop (minimized)",
      type: "normal",
      checked: false,
      enabled: true,
    },
  ]);
  assertEquals(items[3].type, "separator");
  assertEquals(items.slice(4).map((i) => i.id), [
    MDI_ITEM_IDS.cascade,
    MDI_ITEM_IDS.tileHorizontally,
    MDI_ITEM_IDS.tileVertically,
  ]);
  assert(items.every((i) => !("accelerator" in i)), "no invented shortcuts");
  assertEquals(windowAppItems({ view: "tiled", tiles: [] }).length, 3);
});

Deno.test("menu model: ids read back; the static Window items carry the model's labels", () => {
  assertEquals(menuCommand(MDI_ITEM_IDS.cascade), { command: "cascade" });
  assertEquals(menuCommand(tileItemId("t12")), { focus: "t12" });
  assertEquals(menuCommand("qutty:tiles:focus:"), null);
  assertEquals(menuCommand(MINIMIZE_TILE_ITEM), null);
  assertEquals(
    STATIC_WINDOW_ITEMS.map((i) => i.label),
    Object.values(MDI_LABELS),
  );
  assert(
    STATIC_WINDOW_ITEMS.every((i) => Object.keys(i).join() === "id,label"),
  );
  assert(isMdiItem(MDI_ITEM_IDS.viewFreeform) && !isMdiItem("nope"));
  assert(isPageMenuItem(MDI_ITEM_IDS.tileVertically));
  assert(isPageMenuItem(MINIMIZE_TILE_ITEM));
  assert(!isPageMenuItem("qutty:window:close-end"));
});

Deno.test("Window menu: a view / arrange item goes to the key window's page", async () => {
  const fake = fakeExtensionHost();
  const off = tileMenuToPage(fake.host, () => 42);
  try {
    await fake.menuItem(MDI_ITEM_IDS.viewFreeform, { id: "w1", key: "ws-1" });
    await fake.menuItem(MDI_ITEM_IDS.cascade, null);
    assertEquals(fake.events.filter((e) => e.event === "tileMenu"), [{
      event: "tileMenu",
      data: { item: MDI_ITEM_IDS.viewFreeform, at: 42 },
      window: "w1",
    }]);
  } finally {
    off();
  }
});
