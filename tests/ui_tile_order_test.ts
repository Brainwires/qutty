// Tiles in place (Settings → Layout → "Focused tile moves to the main spot" off): the tile order,
// its seeding, swaps, overflow and persistence (lib/workspace/tile-order.ts, the store, the
// session snapshot).

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { computeLayout, type Rect } from "../lib/layout/mod.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  loadSettings,
  reduce,
  sanitizeSettings,
  saveSettings,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import {
  appendId,
  keepsPlaces,
  overflowSwap,
  sanitizeOrder,
  slotOrder,
  swapIds,
  tileAt,
  withRecencyRanks,
} from "../lib/workspace/tile-order.ts";
import { planRestore, snapshotOf } from "../lib/workspace/session.ts";

const run = (actions: WorkspaceAction[], from = initialState()) =>
  actions.reduce(reduce, from);

const add = (id: string, now = 1): WorkspaceAction => ({
  type: "add",
  id,
  now,
});
const focus = (id: string, now = 9): WorkspaceAction => ({
  type: "focus",
  id,
  now,
});

/** Four tiles a..d (d focused), with the setting off. */
const inPlace = (): WorkspaceState =>
  run([
    add("a"),
    add("b"),
    add("c"),
    add("d"),
    { type: "setFocusToMain", on: false },
  ]);

const BOUNDS: Rect = { x: 0, y: 0, w: 1200, h: 800 };

/** The layout the workspace computes (app/workspace.tsx). */
function layoutOf(s: WorkspaceState, bounds = BOUNDS) {
  const keep = keepsPlaces(s);
  const shown = slotOrder(s, false);
  return withRecencyRanks(
    computeLayout(slotOrder(s, keep), bounds, s.settings.layout),
    shown,
  );
}

const rectsOf = (s: WorkspaceState) =>
  Object.fromEntries(layoutOf(s).tiles.map((t) => [t.id, t.rect]));

Deno.test("tile order: on by default; new tiles go last, closed ones drop out", () => {
  assertEquals(DEFAULT_SETTINGS.focusToMain, true);
  let s = run([add("a"), add("b"), add("c")]);
  assertEquals(s.order, ["a", "b", "c"]);
  s = reduce(s, { type: "remove", id: "b" });
  assertEquals(s.order, ["a", "c"]);
  s = reduce(s, add("d"));
  assertEquals(s.order, ["a", "c", "d"]);
  assertEquals(appendId(["a"], "a"), ["a"]);
});

Deno.test("tile order: turning the setting off seeds it from what is on screen", () => {
  const on = run([add("a"), add("b"), add("c"), focus("a")]);
  assertEquals(on.mru, ["a", "c", "b"]);
  const before = rectsOf(on);
  const off = reduce(on, { type: "setFocusToMain", on: false });
  assertEquals(off.settings.focusToMain, false);
  assertEquals(off.order, ["a", "c", "b"]);
  assertEquals(rectsOf(off), before, "nothing jumps");
  assertStrictEquals(
    reduce(off, { type: "setFocusToMain", on: false }),
    off,
    "no change, same state",
  );
});

Deno.test("tile order: with the setting off, focus changes nothing but the focus", () => {
  let s = inPlace();
  const before = rectsOf(s);
  for (const id of ["a", "c", "b", "d", "a"]) {
    s = reduce(s, focus(id));
    assertEquals(s.focusedId, id);
    assertEquals(rectsOf(s), before, `focusing ${id}`);
  }
  s = reduce(s, { type: "cycle", dir: 1, now: 10 });
  s = reduce(s, { type: "focusPrevious", now: 11 });
  assertEquals(rectsOf(s), before, "cycling");
  // Ranks are still recency ranks: the focused tile is 0.
  const ranks = Object.fromEntries(
    layoutOf(s).tiles.map((t) => [t.id, t.rank]),
  );
  assertEquals(ranks[s.focusedId!], 0);
  assertEquals(
    Object.values(ranks).sort(),
    [0, 1, 2, 3],
  );
});

Deno.test("tile order: on again, the focused tile takes the main spot (MRU)", () => {
  let s = reduce(inPlace(), focus("b"));
  s = reduce(s, { type: "setFocusToMain", on: true });
  assertEquals(layoutOf(s).tiles[0].id, "b");
  assertEquals(slotOrder(s, keepsPlaces(s)), s.mru);
});

Deno.test("tile order: a swap trades two places and keeps the focus", () => {
  let s = inPlace();
  const before = rectsOf(s);
  s = reduce(s, { type: "swapTiles", a: "a", b: "c" });
  assertEquals(s.order, ["d", "a", "b", "c"]);
  assertEquals(s.focusedId, "d");
  const after = rectsOf(s);
  assertEquals(after.a, before.c);
  assertEquals(after.c, before.a);
  assertEquals(after.b, before.b);
  // Unknown ids, or a tile with itself: no change.
  assertStrictEquals(reduce(s, { type: "swapTiles", a: "a", b: "zz" }), s);
  assertStrictEquals(reduce(s, { type: "swapTiles", a: "a", b: "a" }), s);
  assertEquals(swapIds(["x", "y"], "x", "y"), ["y", "x"]);
});

Deno.test("tile order: minimized tiles keep their place and come back to it", () => {
  let s = inPlace();
  const before = rectsOf(s);
  s = reduce(s, { type: "minimize", id: "b", now: 2 });
  assert(!("b" in rectsOf(s)));
  assertEquals(s.order, ["d", "c", "b", "a"]);
  s = reduce(s, { type: "restoreTile", id: "b", now: 3 });
  assertEquals(rectsOf(s), before);
});

Deno.test("tile order: monocle shows the focused tile, whatever the order", () => {
  let s = reduce(inPlace(), focus("a"));
  s = reduce(s, { type: "toggleMonocle" });
  assert(!keepsPlaces(s));
  assertEquals(layoutOf(s).tiles.map((t) => t.id), ["a"]);
});

Deno.test("tile order: overflow — the order decides who shows; a hidden focus takes the oldest slot", () => {
  let s = run([add("a"), add("b"), add("c"), add("d"), add("e")]);
  s = reduce(s, { type: "setLayout", patch: { maxVisible: 3 } });
  s = reduce(s, { type: "setFocusToMain", on: false });
  // Seeded from the MRU: e d c shown, b a in the bar.
  assertEquals(layoutOf(s).tiles.map((t) => t.id), ["e", "d", "c"]);
  assertEquals(overflowSwap(s, layoutOf(s)), null, "nothing to move");
  // d was used before c: focusing hidden a swaps it into c's slot (the least recently used).
  s = reduce(s, focus("d"));
  s = reduce(s, focus("e"));
  s = reduce(s, focus("a"));
  const swap = overflowSwap(s, layoutOf(s));
  assertEquals(swap, ["a", "c"]);
  const cSlot = rectsOf(s).c;
  s = reduce(s, { type: "swapTiles", a: swap![0], b: swap![1] });
  assertEquals(layoutOf(s).tiles.map((t) => t.id), ["e", "d", "a"]);
  assertEquals(rectsOf(s).a, cSlot);
  assertEquals(overflowSwap(s, layoutOf(s)), null);
  // A new tile goes last (hidden) but is focused: it takes the oldest shown tile's slot.
  s = reduce(s, add("f", 20));
  assertEquals(s.order.at(-1), "f");
  assertEquals(overflowSwap(s, layoutOf(s)), ["f", "d"]);
  // With the setting on, nothing is swapped (the MRU shows the focused tile).
  const on = reduce(s, { type: "setFocusToMain", on: true });
  assertEquals(overflowSwap(on, layoutOf(on)), null);
});

Deno.test("tile order: the tile under a point", () => {
  const tiles = computeLayout(["a", "b"], BOUNDS, {
    ...DEFAULT_SETTINGS.layout,
    pattern: "columns",
    decay: 1,
  }).tiles;
  assertEquals(tileAt(tiles, 900, 400, "a"), "b");
  assertEquals(tileAt(tiles, 100, 400, "a"), null, "its own tile");
  assertEquals(tileAt(tiles, 100, 400, "b"), "a");
  assertEquals(tileAt(tiles, -5, 400, "b"), null, "outside");
});

Deno.test("tile order: the setting persists and junk falls back to the default", () => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  const off = inPlace();
  assert(saveSettings(off.settings, storage));
  assertEquals(sanitizeSettings(loadSettings(storage)).focusToMain, false);
  assertEquals(sanitizeSettings({ focusToMain: "no" }).focusToMain, true);
  assertEquals(sanitizeSettings({ focusToMain: 0 }).focusToMain, true);
  // Another window turning it off seeds this one's order too.
  const on = run([add("a"), add("b"), focus("a")]);
  const hydrated = reduce(on, {
    type: "hydrateSettings",
    settings: { focusToMain: false },
  });
  assertEquals(hydrated.order, ["a", "b"]);
});

Deno.test("tile order: the session snapshot keeps it; a restore completes it", () => {
  let s = reduce(inPlace(), { type: "swapTiles", a: "d", b: "a" });
  s = reduce(s, focus("b"));
  assertEquals(s.order, ["a", "c", "b", "d"]);
  const snap = snapshotOf(
    s,
    4,
    () => ({ ptyId: null, profile: { kind: "shell" } }),
  );
  assertEquals(snap.order, ["a", "c", "b", "d"]);
  const plan = planRestore(JSON.parse(JSON.stringify(snap)), [])!;
  assertEquals(plan.order, ["a", "c", "b", "d"]);
  const back = reduce(initialState(s.settings), {
    type: "restore",
    terminals: plan.terminals,
    mru: plan.mru,
    order: plan.order,
    previousPattern: plan.previousPattern,
  });
  assertEquals(back.order, s.order);
  assertEquals(rectsOf(back), rectsOf(s));
  // An older snapshot (no order): the MRU, what was on screen. Junk is dropped, gaps filled.
  const { order: _o, ...old } = snap;
  assertEquals(planRestore(old, [])!.order, plan.mru);
  assertEquals(sanitizeOrder(["b", 3, "b", "zz"], ["a", "b", "c"]), [
    "b",
    "a",
    "c",
  ]);
  const junk = reduce(initialState(), {
    type: "restore",
    terminals: plan.terminals,
    mru: plan.mru,
    order: ["nope"],
    previousPattern: null,
  });
  assertEquals(junk.order, plan.mru);
});
