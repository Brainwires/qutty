// The tiles' window controls: Minimize / Maximize / Restore in the reducer (lib/workspace/store.ts),
// the layout and the switcher bar that follow from them, the snapshot round trip
// (lib/workspace/session.ts), the double-click and Window-menu mapping
// (lib/workspace/tile-controls.ts), and the `session` extension handing the menu's tile items to
// the key window's page (desktop/session.ts).

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  initialState,
  isMaximized,
  reduce,
  shownFocus,
  shownMru,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import { computeLayout } from "../lib/layout/mod.ts";
import { barChips, splitChips, visibleIdSet } from "../lib/workspace/bar.ts";
import { planRestore, snapshotOf } from "../lib/workspace/session.ts";
import {
  headDoubleClickControl,
  tileMenuControl,
} from "../lib/workspace/tile-controls.ts";
import {
  CLOSE_AND_END_ITEM,
  isTileMenuItem,
  MINIMIZE_TILE_ITEM,
  ZOOM_TILE_ITEM,
} from "../lib/workspace/windows.ts";
import { tileMenuToPage } from "../desktop/session.ts";
import { fakeExtensionHost } from "./session_helpers.ts";

const run = (actions: WorkspaceAction[], from = initialState()) =>
  actions.reduce(reduce, from);

/** a, b, c added in that order: c focused, MRU c b a. */
const three = (): WorkspaceState =>
  run([
    { type: "add", id: "a", now: 1 },
    { type: "add", id: "b", now: 2 },
    { type: "add", id: "c", now: 3 },
  ]);

const minimized = (s: WorkspaceState) =>
  s.terminals.filter((t) => t.minimized).map((t) => t.id);

const BOUNDS = { x: 0, y: 0, w: 1200, h: 800 };

Deno.test("minimize: out of the layout, focus to the next MRU tile, shell untouched", () => {
  const s = reduce(three(), { type: "minimize", id: "c", now: 4 });
  assertEquals(minimized(s), ["c"]);
  assertEquals(s.focusedId, "b");
  assertEquals(s.mru, ["b", "a", "c"], "the minimized tile goes last");
  assertEquals(shownMru(s), ["b", "a"]);
  // Still a tile of the workspace (its shell runs; the close question counts it).
  assertEquals(s.terminals.map((t) => t.id), ["a", "b", "c"]);
  assertEquals(s.terminals.find((t) => t.id === "c")!.exited, false);
  const layout = computeLayout(shownMru(s), BOUNDS, s.settings.layout);
  assertEquals(layout.tiles.map((t) => t.id).sort(), ["a", "b"]);
  // Minimizing again, or an unknown tile, changes nothing.
  assertStrictEquals(reduce(s, { type: "minimize", id: "c", now: 5 }), s);
  assertStrictEquals(reduce(s, { type: "minimize", id: "zz", now: 5 }), s);
});

Deno.test("minimize: a tile that is not focused keeps the focus where it is", () => {
  const s = reduce(three(), { type: "minimize", id: "a", now: 4 });
  assertEquals(s.focusedId, "c");
  assertEquals(s.mru, ["c", "b", "a"]);
});

Deno.test("minimize: cycling, focusPrevious and the MRU skip minimized tiles", () => {
  let s = reduce(three(), { type: "minimize", id: "b", now: 4 });
  s = reduce(s, { type: "focusPrevious", now: 5 });
  assertEquals(s.focusedId, "a");
  s = reduce(s, { type: "endCycle" });
  const seen: (string | null)[] = [];
  for (let i = 0; i < 4; i++) {
    s = reduce(s, { type: "cycle", dir: 1, now: 6 + i });
    seen.push(s.focusedId);
  }
  assertEquals(seen, ["c", "a", "c", "a"]);
  // With one tile shown, there is nothing to cycle to.
  s = run([
    { type: "endCycle" },
    { type: "minimize", id: "c", now: 20 },
  ], s);
  assertStrictEquals(reduce(s, { type: "cycle", dir: 1, now: 21 }), s);
  assertStrictEquals(reduce(s, { type: "focusPrevious", now: 21 }), s);
});

Deno.test("minimize: the last shown tile too (nothing focused, every chip in the bar)", () => {
  const s = run([
    { type: "minimize", id: "c", now: 4 },
    { type: "minimize", id: "b", now: 5 },
    { type: "minimize", id: "a", now: 6 },
  ], three());
  assertEquals(s.focusedId, null);
  assertEquals(shownMru(s), []);
  assertEquals(computeLayout([], BOUNDS, s.settings.layout).tiles, []);
  const chips = barChips(s, new Set());
  assertEquals(chips.map((c) => [c.id, c.minimized, c.tiled]), [
    ["c", true, false],
    ["b", true, false],
    ["a", true, false],
  ]);
  // A new tile is shown and focused.
  const t = reduce(s, { type: "add", id: "d", now: 7 });
  assertEquals(t.focusedId, "d");
  assertEquals(shownMru(t), ["d"]);
});

Deno.test("restore: a minimized tile comes back tiled and focused (chip click, focus, ⌘N)", () => {
  const s = reduce(three(), { type: "minimize", id: "a", now: 4 });
  for (
    const action of [
      { type: "restoreTile", id: "a", now: 5 },
      { type: "focus", id: "a", now: 5 },
      { type: "focusOrdinal", ordinal: 3, now: 5 }, // bar order (MRU): c b a
    ] satisfies WorkspaceAction[]
  ) {
    const r = reduce(s, action);
    assertEquals(minimized(r), [], action.type);
    assertEquals(r.focusedId, "a", action.type);
    assertEquals(r.mru, ["a", "c", "b"], action.type);
    assertEquals(r.terminals.find((t) => t.id === "a")!.minimized, undefined);
  }
});

Deno.test("restore from minimized while in monocle also leaves monocle", () => {
  let s = run([
    { type: "setLayout", patch: { pattern: "grid" } },
    { type: "minimize", id: "a", now: 4 },
    { type: "toggleMonocle" },
  ], three());
  assertEquals(s.settings.layout.pattern, "monocle");
  s = reduce(s, { type: "restoreTile", id: "a", now: 5 });
  assertEquals(s.settings.layout.pattern, "grid");
  assertEquals(s.previousPattern, null);
  assertEquals(s.focusedId, "a");
});

Deno.test("maximize: focus the tile and show it alone, remembering the pattern", () => {
  let s = reduce(three(), { type: "setLayout", patch: { pattern: "spiral" } });
  s = reduce(s, { type: "maximize", id: "a", now: 4 });
  assertEquals(s.focusedId, "a");
  assertEquals(s.settings.layout.pattern, "monocle");
  assertEquals(s.previousPattern, "spiral");
  assert(isMaximized(s, "a"));
  assert(!isMaximized(s, "b"));
  assertEquals(
    computeLayout(shownMru(s), BOUNDS, s.settings.layout).tiles.map((t) =>
      t.id
    ),
    ["a"],
  );
  // Maximize on another tile from inside monocle just focuses it (the pattern stays remembered).
  s = reduce(s, { type: "maximize", id: "b", now: 5 });
  assertEquals(s.focusedId, "b");
  assertEquals(s.settings.layout.pattern, "monocle");
  assertEquals(s.previousPattern, "spiral");
  // Restore: back to the tiled pattern.
  s = reduce(s, { type: "restoreTile", id: "b", now: 6 });
  assertEquals(s.settings.layout.pattern, "spiral");
  assertEquals(s.previousPattern, null);
  assertEquals(s.focusedId, "b");
  assert(!isMaximized(s, "b"));
});

Deno.test("maximize and Mod+Enter share one monocle: either undoes the other", () => {
  let s = reduce(three(), { type: "setLayout", patch: { pattern: "grid" } });
  s = reduce(s, { type: "maximize", id: "b", now: 4 });
  s = reduce(s, { type: "toggleMonocle" });
  assertEquals(s.settings.layout.pattern, "grid");
  s = reduce(s, { type: "toggleMonocle" });
  s = reduce(s, { type: "restoreTile", id: s.focusedId!, now: 5 });
  assertEquals(s.settings.layout.pattern, "grid");
});

Deno.test("restore never lands in monocle: no remembered pattern, or monocle remembered", () => {
  // Monocle picked by hand (nothing remembered): Restore goes to the default tiled pattern.
  let s = reduce(three(), { type: "setLayout", patch: { pattern: "monocle" } });
  s = reduce(s, { type: "restoreTile", id: "c", now: 4 });
  assertEquals(s.settings.layout.pattern, "cascade");
  // A snapshot that remembered monocle itself (junk): the default tiled pattern too.
  s = reduce(s, {
    type: "restore",
    terminals: s.terminals,
    mru: s.mru,
    layout: { pattern: "monocle" },
    previousPattern: "monocle",
  });
  s = reduce(s, { type: "restoreTile", id: "c", now: 5 });
  assertEquals(s.settings.layout.pattern, "cascade");
  // Restore on a tiled tile outside monocle only focuses it.
  const t = reduce(s, { type: "restoreTile", id: "a", now: 6 });
  assertEquals([t.focusedId, t.settings.layout.pattern], ["a", "cascade"]);
});

Deno.test("minimize in monocle shows the next MRU tile alone", () => {
  let s = reduce(three(), { type: "maximize", id: "c", now: 4 });
  s = reduce(s, { type: "minimize", id: "c", now: 5 });
  assertEquals(s.focusedId, "b");
  assertEquals(s.settings.layout.pattern, "monocle");
  assert(isMaximized(s, "b"));
});

Deno.test("removing the focused tile skips minimized ones for the next focus", () => {
  let s = reduce(three(), { type: "minimize", id: "b", now: 4 });
  s = reduce(s, { type: "remove", id: "c" });
  assertEquals(s.focusedId, "a");
  s = reduce(s, { type: "remove", id: "a" });
  assertEquals(s.focusedId, null, "only a minimized tile is left");
  assertEquals(s.mru, ["b"]);
});

Deno.test("bar: a minimized chip is neither tiled nor overflow", () => {
  const s = reduce(three(), { type: "minimize", id: "b", now: 4 });
  const layout = computeLayout(shownMru(s), BOUNDS, {
    ...s.settings.layout,
    maxVisible: 1,
  });
  const split = splitChips(barChips(s, visibleIdSet(layout)));
  assertEquals(split.tiled.map((c) => c.id), ["c"]);
  assertEquals(split.overflow.map((c) => c.id), ["a"]);
  assertEquals(split.minimized.map((c) => c.id), ["b"]);
});

Deno.test("snapshot: minimized tiles round-trip and come back minimized", () => {
  const s = reduce(three(), { type: "minimize", id: "c", now: 4 });
  const ptys: Record<string, string> = { a: "pty-1", b: "pty-2", c: "pty-3" };
  const snap = snapshotOf(s, 3, (id) => ({
    ptyId: ptys[id],
    profile: { kind: "shell" },
  }));
  const pty = (id: string) => ({
    id,
    cols: 80,
    rows: 24,
    data: "",
    seq: 0,
    truncated: false,
  });
  const plan = planRestore(JSON.parse(JSON.stringify(snap)), [
    pty("pty-1"),
    pty("pty-2"),
    pty("pty-3"),
  ])!;
  assertEquals(
    plan.terminals.filter((t) => t.minimized).map((t) => t.id),
    ["c"],
  );
  assertEquals(shownFocus(plan.terminals, plan.mru), "b");
  const back = reduce(initialState(), {
    type: "restore",
    terminals: plan.terminals,
    mru: plan.mru,
    previousPattern: plan.previousPattern,
  });
  assertEquals(minimized(back), ["c"]);
  assertEquals(back.focusedId, "b");
  assertEquals(back.mru, ["b", "a", "c"]);
  // Junk in the snapshot's flag is dropped; a restore puts shown tiles ahead of minimized ones.
  const junk = planRestore({
    ...snap,
    terminals: snap.terminals.map((t) => ({
      ...t,
      minimized: t.id === "a" ? "yes" : t.minimized,
    })),
    mru: ["c", "b", "a"],
  }, [])!;
  assertEquals(junk.terminals.find((t) => t.id === "a")!.minimized, undefined);
  const r = reduce(initialState(), {
    type: "restore",
    terminals: junk.terminals,
    mru: junk.mru,
    previousPattern: null,
  });
  assertEquals(r.mru, ["b", "a", "c"]);
  assertEquals(r.focusedId, "b");
});

Deno.test("header double click follows the title-bar double-click action", () => {
  assertEquals(headDoubleClickControl("maximize", false), "maximize");
  assertEquals(headDoubleClickControl("maximize", true), "restoreTile");
  assertEquals(headDoubleClickControl("minimize", false), "minimize");
  assertEquals(headDoubleClickControl("minimize", true), "minimize");
  for (const none of ["none", "shade", "lower", "menu", "junk"]) {
    assertEquals(headDoubleClickControl(none, false), null, none);
  }
});

Deno.test("Window menu: Minimize Tile and Zoom Tile on the focused tile", () => {
  assertEquals(tileMenuControl(MINIMIZE_TILE_ITEM, false), "minimize");
  assertEquals(tileMenuControl(ZOOM_TILE_ITEM, false), "maximize");
  assertEquals(tileMenuControl(ZOOM_TILE_ITEM, true), "restoreTile");
  assert(isTileMenuItem(MINIMIZE_TILE_ITEM) && isTileMenuItem(ZOOM_TILE_ITEM));
  assert(!isTileMenuItem(CLOSE_AND_END_ITEM) && !isTileMenuItem(undefined));
});

Deno.test("session: the Window menu's tile items go to the key window's page only", async () => {
  const fake = fakeExtensionHost([]);
  const off = tileMenuToPage(fake.host);
  try {
    await fake.menuItem(MINIMIZE_TILE_ITEM, { id: "w2", key: "ws-2" });
    await fake.menuItem(ZOOM_TILE_ITEM, { id: "w1", key: "ws-1" });
    // Not a tile item, or no window open: nothing is sent.
    await fake.menuItem(CLOSE_AND_END_ITEM, { id: "w1", key: "ws-1" });
    await fake.menuItem(ZOOM_TILE_ITEM, null);
    assertEquals(
      fake.events.filter((e) => e.event === "tileMenu").map((e) => [
        e.window,
        (e.data as { item: string }).item,
      ]),
      [["w2", MINIMIZE_TILE_ITEM], ["w1", ZOOM_TILE_ITEM]],
    );
  } finally {
    off();
  }
});
