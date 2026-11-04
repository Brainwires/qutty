import { assertEquals } from "@std/assert";
import { computeLayout, DEFAULT_LAYOUT_OPTIONS } from "../lib/layout/mod.ts";
import { barChips, splitChips, visibleIdSet } from "../lib/workspace/bar.ts";
import {
  initialState,
  reduce,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";

function run(
  actions: WorkspaceAction[],
  from = initialState(),
): WorkspaceState {
  return actions.reduce(reduce, from);
}

const five = (): WorkspaceState =>
  run(
    ["a", "b", "c", "d", "e"].map((id, i) => ({ type: "add", id, now: i + 1 })),
  );

const BOUNDS = { x: 0, y: 0, w: 1600, h: 1000 };

Deno.test("bar orders by MRU or by creation; ordinals follow the bar order", () => {
  let s = five(); // mru e d c b a
  s = reduce(s, { type: "focus", id: "b", now: 10 }); // mru b e d c a
  const all = new Set(["a", "b", "c", "d", "e"]);
  let chips = barChips(s, all);
  assertEquals(chips.map((c) => c.id), ["b", "e", "d", "c", "a"]);
  assertEquals(chips.map((c) => c.ordinal), [1, 2, 3, 4, 5]);
  assertEquals(chips.map((c) => c.rank), [0, 1, 2, 3, 4]);
  assertEquals(chips.map((c) => c.focused), [true, false, false, false, false]);

  s = reduce(s, { type: "setBarOrder", order: "created" });
  chips = barChips(s, all);
  assertEquals(chips.map((c) => c.id), ["a", "b", "c", "d", "e"]);
  assertEquals(chips.map((c) => c.ordinal), [1, 2, 3, 4, 5]);
  assertEquals(chips.map((c) => c.rank), [4, 0, 3, 2, 1], "rank is still MRU");
  assertEquals(chips[1].focused, true);
  // ⌘3 in creation order is "c".
  assertEquals(
    reduce(s, { type: "focusOrdinal", ordinal: 3, now: 11 }).focusedId,
    "c",
  );
});

Deno.test("tiled vs overflow chips follow the layout's maxVisible", () => {
  const s = five(); // mru e d c b a
  const layout = computeLayout(s.mru, BOUNDS, {
    ...DEFAULT_LAYOUT_OPTIONS,
    maxVisible: 3,
  });
  assertEquals(layout.overflow, ["b", "a"]);
  const visible = visibleIdSet(layout);
  const chips = barChips(s, visible);
  assertEquals(chips.map((c) => [c.id, c.tiled]), [
    ["e", true],
    ["d", true],
    ["c", true],
    ["b", false],
    ["a", false],
  ]);
  const { tiled, overflow } = splitChips(chips);
  assertEquals(tiled.map((c) => c.id), ["e", "d", "c"]);
  assertEquals(overflow.map((c) => c.id), ["b", "a"]);
});

Deno.test("focusing an overflow terminal tiles it and pushes the oldest tiled one out", () => {
  let s = five();
  const opts = { ...DEFAULT_LAYOUT_OPTIONS, maxVisible: 3 };
  s = reduce(s, { type: "focus", id: "a", now: 20 }); // mru a e d c b
  const layout = computeLayout(s.mru, BOUNDS, opts);
  assertEquals(layout.tiles.map((t) => t.id), ["a", "e", "d"]);
  assertEquals(layout.overflow, ["c", "b"]);
  const chips = barChips(s, visibleIdSet(layout));
  assertEquals(chips.find((c) => c.id === "a")?.tiled, true);
  assertEquals(
    chips.find((c) => c.id === "c")?.tiled,
    false,
    "c left the cluster",
  );
  // Closing a tiled terminal pulls the next overflow one back in.
  s = reduce(s, { type: "remove", id: "e" });
  const after = computeLayout(s.mru, BOUNDS, opts);
  assertEquals(after.tiles.map((t) => t.id), ["a", "d", "c"]);
  assertEquals(after.overflow, ["b"]);
});

Deno.test("monocle tiles only the focused terminal; everything else is overflow", () => {
  let s = five();
  s = reduce(s, { type: "toggleMonocle" });
  const layout = computeLayout(s.mru, BOUNDS, s.settings.layout);
  assertEquals(layout.tiles.map((t) => t.id), ["e"]);
  const { tiled, overflow } = splitChips(barChips(s, visibleIdSet(layout)));
  assertEquals(tiled.map((c) => c.id), ["e"]);
  assertEquals(overflow.map((c) => c.id), ["d", "c", "b", "a"]);
});

Deno.test("chips skip ids the store no longer knows and an empty workspace has none", () => {
  assertEquals(barChips(initialState(), new Set()), []);
  const s = five();
  const broken = { ...s, mru: ["zz", ...s.mru] };
  assertEquals(barChips(broken, new Set()).map((c) => c.id), [
    "e",
    "d",
    "c",
    "b",
    "a",
  ]);
});
