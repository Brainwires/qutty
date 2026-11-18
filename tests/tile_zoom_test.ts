// Per-tile zoom (lib/workspace/tile-zoom.ts): the steps and the font it gives, the store's zoom
// actions (a tile's own zoom, the shared level of "Zoom All Tiles Together"), the settings that
// sync it across windows, the snapshot and a moved tile carrying it, the View menu's items and the
// keys. Pure, no window.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  clampTileZoom,
  effectiveTileZoom,
  pageZoom,
  sanitizeTileZoom,
  stepTileZoom,
  TILE_ZOOM_RANGE,
  zoomedFontSize,
} from "../lib/workspace/tile-zoom.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  reduce,
  sanitizeSettings,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import {
  movedTileOf,
  planRestore,
  snapshotOf,
} from "../lib/workspace/session.ts";
import { SHELL_PROFILE } from "../lib/ssh-ui.ts";
import {
  ITEM,
  itemAccelerator,
  keyAccelerator,
  menuAction,
  menuInput,
  menuItemStates,
  viewMenuSpec,
} from "../lib/workspace/menus.ts";
import {
  commandForKey,
  type KeyLike,
  routeKey,
} from "../lib/workspace/keys.ts";
import { NO_ZOOM, ownSiteZoom, setSiteZoom } from "../lib/web/zoom.ts";

/** A workspace with terminals `t1`, `t2` and web tile `w1`; `t2` focused. */
function workspace(): WorkspaceState {
  let s = initialState();
  s = reduce(s, { type: "add", id: "t1", now: 1 });
  s = reduce(s, { type: "add", id: "t2", now: 2 });
  return {
    ...s,
    terminals: [
      ...s.terminals,
      {
        id: "w1",
        title: "Page",
        createdAt: 3,
        lastUsedAt: 0,
        exited: false,
        exitCode: null,
        activity: false,
        web: { url: "https://example.com/" },
      },
    ],
  };
}

const zoomOf = (s: WorkspaceState, id: string) =>
  s.terminals.find((t) => t.id === id)?.zoom;

Deno.test("tile zoom: the browsers' steps, clamped to 50%–300%", () => {
  assertEquals(stepTileZoom(1, 1), 1.1);
  assertEquals(stepTileZoom(1.1, 1), 1.25);
  assertEquals(stepTileZoom(1, -1), 0.9);
  assertEquals(stepTileZoom(0.5, -1), TILE_ZOOM_RANGE.min, "stays at the min");
  assertEquals(stepTileZoom(3, 1), TILE_ZOOM_RANGE.max, "stays at the max");
  assertEquals(clampTileZoom(NaN), 1);
  assertEquals(clampTileZoom(9), 3);
  assertEquals(sanitizeTileZoom(1), undefined, "100% is not stored");
  assertEquals(sanitizeTileZoom("2"), undefined);
  assertEquals(sanitizeTileZoom(Infinity), undefined);
  assertEquals(sanitizeTileZoom(0.1), 0.5);
  assertEquals(sanitizeTileZoom(1.25), 1.25);
});

Deno.test("tile zoom: the terminal font it gives, over Settings' size", () => {
  assertEquals(zoomedFontSize(13, 1), 13);
  assertEquals(zoomedFontSize(13, 1.25), 16);
  assertEquals(zoomedFontSize(13, 0.5), 7);
  assertEquals(zoomedFontSize(32, 3), 96, "the largest");
  assertEquals(zoomedFontSize(9, 0.5), 6, "never below 6px");
});

Deno.test("tile zoom: each tile its own, or the shared level while together", () => {
  const off = { zoomTogether: false, sharedZoom: 2 };
  const on = { zoomTogether: true, sharedZoom: 2 };
  assertEquals(effectiveTileZoom({}, off), 1);
  assertEquals(effectiveTileZoom({ zoom: 1.5 }, off), 1.5);
  assertEquals(effectiveTileZoom({ zoom: 1.5 }, on), 2);
  // A page: its site's own zoom wins, then the shared level, then 100%.
  assertEquals(pageZoom(1.25, 2), 1.25);
  assertEquals(pageZoom(undefined, 2), 2);
  assertEquals(pageZoom(undefined, null), 1);
  const sites = setSiteZoom(NO_ZOOM, "https://a.test/x", 1.5);
  assertEquals(ownSiteZoom(sites, "https://a.test/y"), 1.5);
  assertEquals(ownSiteZoom(sites, "https://b.test/"), undefined);
});

Deno.test("store: Zoom In / Out / Actual Size change only that tile's own zoom", () => {
  let s = workspace();
  s = reduce(s, { type: "zoomTile", id: "t2", dir: 1 });
  s = reduce(s, { type: "zoomTile", id: "t2", dir: 1 });
  assertEquals(zoomOf(s, "t2"), 1.25);
  assertEquals(zoomOf(s, "t1"), undefined, "the other tile is untouched");
  assertEquals(s.settings.sharedZoom, 1);
  s = reduce(s, { type: "zoomTile", id: "t1", dir: -1 });
  assertEquals(zoomOf(s, "t1"), 0.9);
  s = reduce(s, { type: "resetTileZoom", id: "t2" });
  assert(!("zoom" in s.terminals.find((t) => t.id === "t2")!), "100%: none");
  assertStrictEquals(reduce(s, { type: "resetTileZoom", id: "t2" }), s);
  // Back to 100% by steps stores nothing either.
  s = reduce(s, { type: "zoomTile", id: "t1", dir: 1 });
  assertEquals(zoomOf(s, "t1"), undefined);
  // A web tile's page zooms itself (per site): the store keeps no zoom for it.
  assertStrictEquals(reduce(s, { type: "zoomTile", id: "w1", dir: 1 }), s);
  assertStrictEquals(reduce(s, { type: "zoomTile", id: "nope", dir: 1 }), s);
  // At the ends nothing changes.
  for (let i = 0; i < 20; i++) {
    s = reduce(s, { type: "zoomTile", id: "t1", dir: 1 });
  }
  assertEquals(zoomOf(s, "t1"), 3);
  assertStrictEquals(reduce(s, { type: "zoomTile", id: "t1", dir: 1 }), s);
});

Deno.test("store: Zoom All Tiles Together steps one shared level; off brings each tile's back", () => {
  let s = workspace();
  s = reduce(s, { type: "zoomTile", id: "t1", dir: 1 });
  s = reduce(s, { type: "setZoomTogether", on: true });
  assert(s.settings.zoomTogether);
  assertStrictEquals(reduce(s, { type: "setZoomTogether", on: true }), s);
  s = reduce(s, { type: "zoomTile", id: "t2", dir: 1 });
  assertEquals(s.settings.sharedZoom, 1.1);
  assertEquals(zoomOf(s, "t2"), undefined, "own zooms are left alone");
  assertEquals(zoomOf(s, "t1"), 1.1);
  for (const id of ["t1", "t2"]) {
    const entry = s.terminals.find((t) => t.id === id)!;
    assertEquals(effectiveTileZoom(entry, s.settings), 1.1, id);
  }
  // A web tile without a zoom of its own zooms the shared level (app/web-tile.tsx).
  s = reduce(s, { type: "setSharedZoom", zoom: 1.5 });
  assertEquals(s.settings.sharedZoom, 1.5);
  s = reduce(s, { type: "resetTileZoom", id: "t1" });
  assertEquals(s.settings.sharedZoom, 1);
  assertEquals(zoomOf(s, "t1"), 1.1, "Actual Size reset the shared level");
  s = reduce(s, { type: "zoomTile", id: "t1", dir: -1 });
  s = reduce(s, { type: "setZoomTogether", on: false });
  assertEquals(s.settings.sharedZoom, 0.9, "kept for next time");
  assertEquals(
    effectiveTileZoom(s.terminals.find((t) => t.id === "t1")!, s.settings),
    1.1,
    "its own zoom is back",
  );
});

Deno.test("settings: the zoom settings persist and sanitise (another window hydrates them)", () => {
  assertEquals(DEFAULT_SETTINGS.zoomTogether, false);
  assertEquals(DEFAULT_SETTINGS.sharedZoom, 1);
  const saved = JSON.parse(JSON.stringify({
    ...DEFAULT_SETTINGS,
    zoomTogether: true,
    sharedZoom: 1.25,
  }));
  const back = sanitizeSettings(saved);
  assertEquals([back.zoomTogether, back.sharedZoom], [true, 1.25]);
  const junk = sanitizeSettings({ zoomTogether: "yes", sharedZoom: "big" });
  assertEquals([junk.zoomTogether, junk.sharedZoom], [false, 1]);
  assertEquals(sanitizeSettings({ sharedZoom: 40 }).sharedZoom, 3);
  // A window following another's settings change (app/workspace.tsx `onStorage`).
  let s = workspace();
  s = reduce(s, {
    type: "hydrateSettings",
    settings: { zoomTogether: true, sharedZoom: 2 },
  });
  assertEquals([s.settings.zoomTogether, s.settings.sharedZoom], [true, 2]);
});

Deno.test("session: a tile's zoom survives the snapshot, a restore and a move", () => {
  let s = workspace();
  s = reduce(s, { type: "zoomTile", id: "t1", dir: 1 });
  const snap = snapshotOf(
    s,
    3,
    (id) =>
      id.startsWith("t")
        ? { ptyId: `p-${id}`, profile: SHELL_PROFILE }
        : undefined,
  );
  const plan = planRestore(JSON.parse(JSON.stringify(snap)), [])!;
  assertEquals(plan.terminals.find((t) => t.id === "t1")?.zoom, 1.1);
  assertEquals(plan.terminals.find((t) => t.id === "t2")?.zoom, undefined);
  // Junk in a snapshot is dropped, a web tile never takes one.
  const bad = JSON.parse(JSON.stringify(snap));
  bad.terminals[1].zoom = "huge";
  bad.terminals[2].zoom = 2;
  const badPlan = planRestore(bad, [])!;
  assertEquals(badPlan.terminals.find((t) => t.id === "t2")?.zoom, undefined);
  assertEquals(badPlan.terminals.find((t) => t.id === "w1")?.zoom, undefined);
  const moved = movedTileOf({
    entry: s.terminals.find((t) => t.id === "t1"),
    tile: { ptyId: "p-t1", profile: SHELL_PROFILE },
  });
  assertEquals(moved?.entry.zoom, 1.1);
});

Deno.test("View menu: Maximize Tile (⌘↩) is a checkbox; Zoom In / Out / Actual Size, Zoom Together", () => {
  const items = viewMenuSpec("mac").items.flatMap((i) =>
    "items" in i ? i.items ?? [] : [i]
  );
  const labelOf = (id: string) => items.find((i) => i.id === id);
  assertEquals(labelOf(ITEM.maximizeTile)?.label, "Maximize Tile");
  assertEquals(labelOf(ITEM.maximizeTile)?.type, "checkbox");
  assertEquals(labelOf(ITEM.maximizeTile)?.accelerator, "CmdOrCtrl+Enter");
  assertEquals(labelOf(ITEM.zoomIn)?.accelerator, "CmdOrCtrl+=");
  assertEquals(labelOf(ITEM.zoomOut)?.accelerator, "CmdOrCtrl+-");
  assertEquals(labelOf(ITEM.actualSize)?.accelerator, "CmdOrCtrl+0");
  assertEquals(labelOf(ITEM.zoomTogether)?.label, "Zoom All Tiles Together");
  assertEquals(labelOf(ITEM.zoomTogether)?.type, "checkbox");
  assert(!items.some((i) => i.label === "Zoom Tile"), "no Zoom Tile left");
  assert(!items.some((i) => i.label === "Bigger"), "no Bigger left");
  // Clicks: the keys' commands, so a click and a key do the same thing.
  assertEquals(menuAction(ITEM.maximizeTile), {
    kind: "key",
    command: { kind: "toggleMonocle" },
  });
  assertEquals(menuAction(ITEM.zoomIn), {
    kind: "key",
    command: { kind: "zoom", dir: 1 },
  });
  assertEquals(menuAction(ITEM.zoomOut), {
    kind: "key",
    command: { kind: "zoom", dir: -1 },
  });
  assertEquals(menuAction(ITEM.actualSize), {
    kind: "key",
    command: { kind: "zoomReset" },
  });
  assertEquals(menuAction(ITEM.zoomTogether), { kind: "zoomTogether" });
  // Each key's accelerator is its item's (the shortcut guard drops a menu echo of a key).
  assertEquals(
    keyAccelerator({ kind: "toggleMonocle" }),
    itemAccelerator(ITEM.maximizeTile),
  );
  assertEquals(
    keyAccelerator({ kind: "zoom", dir: 1 }),
    itemAccelerator(ITEM.zoomIn),
  );
  assertEquals(
    keyAccelerator({ kind: "zoom", dir: -1 }),
    itemAccelerator(ITEM.zoomOut),
  );
  assertEquals(
    keyAccelerator({ kind: "zoomReset" }),
    itemAccelerator(ITEM.actualSize),
  );
});

Deno.test("View menu: Maximize Tile is checked while the focused tile is maximized", () => {
  let s = workspace();
  assertEquals(menuItemStates(menuInput(s, false))[ITEM.maximizeTile], {
    checked: false,
    enabled: true,
  });
  s = reduce(s, { type: "toggleMonocle" });
  assertEquals(menuItemStates(menuInput(s, false))[ITEM.maximizeTile], {
    checked: true,
    enabled: true,
  });
  s = reduce(s, { type: "setZoomTogether", on: true });
  assertEquals(menuItemStates(menuInput(s, false))[ITEM.zoomTogether], {
    checked: true,
  });
});

const key = (
  code: string,
  mods: Partial<KeyLike> = {},
): KeyLike => ({
  key: "",
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

Deno.test("keys: ⌘= / ⌘- / ⌘0 zoom the focused tile; a web tile's page by its own keys", () => {
  const mac = (code: string, m: Partial<KeyLike> = {}) =>
    commandForKey(key(code, { metaKey: true, ...m }), "mac");
  assertEquals(mac("Equal"), { kind: "zoom", dir: 1 });
  assertEquals(mac("Equal", { shiftKey: true }), { kind: "zoom", dir: 1 });
  assertEquals(mac("NumpadAdd"), { kind: "zoom", dir: 1 });
  assertEquals(mac("Minus"), { kind: "zoom", dir: -1 });
  assertEquals(mac("Digit0"), { kind: "zoomReset" });
  assertEquals(mac("Numpad0"), { kind: "zoomReset" });
  // Ctrl on macOS goes to the terminal (Ctrl+- is ^_, readline's undo).
  for (const code of ["Equal", "Minus", "Digit0"]) {
    assertEquals(commandForKey(key(code, { ctrlKey: true }), "mac"), null);
  }
  // Off macOS, Ctrl+= / Ctrl+- / Ctrl+0, as before (Linux terminals zoom with them); nothing more.
  const other = (code: string, m: Partial<KeyLike> = {}) =>
    commandForKey(key(code, { ctrlKey: true, ...m }), "other");
  assertEquals(other("Equal"), { kind: "zoom", dir: 1 });
  assertEquals(other("Minus"), { kind: "zoom", dir: -1 });
  assertEquals(other("Digit0"), { kind: "zoomReset" });
  assertEquals(other("Minus", { shiftKey: true }), null, "Ctrl+_ stays ^_");
  assertEquals(other("Equal", { altKey: true }), null);
  assertEquals(
    routeKey(key("Equal", { metaKey: true }), "mac", true),
    { scope: "web", cmd: { kind: "zoom", dir: 1 } },
  );
  assertEquals(
    routeKey(key("Digit0", { metaKey: true }), "mac", false),
    { scope: "workspace", cmd: { kind: "zoomReset" } },
  );
});
