// A tile moving between windows, without windows or PTYs: the drag's geometry (lib/workspace/tile-move.ts),
// the snapshot changes (lib/workspace/session.ts), the store's `arrive`, the registry's part
// (desktop/workspace-host.ts: a terminal changing workspace, pending arrivals, departures, a moved
// sandboxed terminal keeping its first workspace's container) and the app process's mover
// (desktop/tile-move.ts) with fakes for the terminals and the windows.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  arrivalPlace,
  isOutside,
  screenOffset,
  tearOffFrame,
  windowAt,
} from "../lib/workspace/tile-move.ts";
import {
  movedTileOf,
  planRestore,
  snapshotHasTile,
  withArrivals,
  withoutTile,
} from "../lib/workspace/session.ts";
import {
  initialState,
  reduce,
  type TerminalEntry,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import { WorkspaceRegistry } from "../desktop/workspace-host.ts";
import {
  type DragHover,
  moveInput,
  type MoveRequest,
  TileMover,
} from "../desktop/tile-move.ts";
import type { PtyReplay } from "../desktop/terminal-sessions.ts";
import type { LayoutTile } from "../lib/layout/mod.ts";

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

Deno.test("tile move: the pointer is out once it leaves the viewport", () => {
  assertFalse(isOutside(10, 10, 800, 600));
  assertFalse(isOutside(0, 600, 800, 600), "the edge is in");
  assert(isOutside(-5, 10, 800, 600));
  assert(isOutside(10, 610, 800, 600));
  assert(isOutside(900, 10, 800, 600));
});

Deno.test("tile move: the window under the pointer, front to back, calibrated on the source window", () => {
  // The source window's frame is at (100, 50); its page's viewport starts 28 px lower in event
  // coordinates (a title bar), so every frame is shifted by the same.
  const offset = screenOffset({ x: 100, y: 78 }, {
    x: 100,
    y: 50,
    width: 800,
    height: 600,
  });
  assertEquals(offset, { x: 0, y: 28 });
  const frames = [
    { id: "front", bounds: { x: 1000, y: 100, width: 400, height: 300 } },
    { id: "back", bounds: { x: 900, y: 50, width: 800, height: 800 } },
  ];
  // Over both: the front one, at the point in its page.
  assertEquals(windowAt(frames, { x: 1100, y: 228 }, offset), {
    id: "front",
    x: 100,
    y: 100,
  });
  // Only over the back one.
  assertEquals(windowAt(frames, { x: 950, y: 128 }, offset), {
    id: "back",
    x: 50,
    y: 50,
  });
  // Over none.
  assertEquals(windowAt(frames, { x: 10, y: 10 }, offset), null);
  // No frame for the source window: no calibration.
  assertEquals(screenOffset({ x: 5, y: 5 }, null), { x: 0, y: 0 });
});

Deno.test("tile move: a torn-off window opens under the pointer at the source window's size", () => {
  assertEquals(
    tearOffFrame({ x: 500, y: 300 }, { x: 0, y: 28 }, {
      width: 1200,
      height: 800,
    }),
    { x: 380, y: 258, width: 1200, height: 800 },
  );
  assertEquals(tearOffFrame({ x: 500, y: 300 }, { x: 0, y: 0 }, null), {
    x: 380,
    y: 286,
  });
});

const tile = (id: string, x: number, y: number, w: number, h: number) =>
  ({ id, rank: 0, rect: { x, y, w, h } }) as LayoutTile;

Deno.test("tile move: where an arriving tile lands", () => {
  const tiles = [tile("a", 0, 0, 500, 600), tile("b", 500, 0, 500, 600)];
  const base = {
    view: "tiled" as const,
    keepsPlaces: true,
    tiles,
    cluster: { left: 0, top: 40 },
    bounds: { x: 0, y: 0, w: 1000, h: 600 },
  };
  // Tiles in place: the slot under the pointer (page px; the cluster starts 40 px down).
  assertEquals(arrivalPlace({ ...base, at: { x: 700, y: 140 } }), {
    before: "b",
  });
  // The focused tile in the main spot: it simply arrives (focused, in the main spot).
  assertEquals(
    arrivalPlace({ ...base, keepsPlaces: false, at: { x: 700, y: 140 } }),
    {},
  );
  // No drop point (the menu).
  assertEquals(arrivalPlace({ ...base, at: undefined }), {});
  // Free-form: its header under the pointer, at its old size.
  assertEquals(
    arrivalPlace({
      ...base,
      view: "freeform",
      at: { x: 400, y: 240 },
      size: { w: 300, h: 200 },
    }),
    { rect: { x: 250, y: 187, w: 300, h: 200 } },
  );
});

// ---------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------

const entry = (id: string, extra: Partial<TerminalEntry> = {}) => ({
  id,
  title: `title ${id}`,
  createdAt: 1,
  lastUsedAt: 2,
  exited: false,
  exitCode: null,
  activity: false,
  ...extra,
});

/** A v1 snapshot with tiles t1 (pty-1), t2 (pty-2) and web tile t3. */
function snapshot() {
  return {
    v: 1,
    seq: 3,
    terminals: [entry("t1"), entry("t2"), entry("t3")],
    mru: ["t2", "t1", "t3"],
    order: ["t1", "t2", "t3"],
    layout: { pattern: "columns" },
    previousPattern: null,
    tiles: {
      t1: { ptyId: "pty-1", profile: { kind: "shell" } },
      t2: { ptyId: "pty-2", profile: { kind: "shell" }, home: "/home/x" },
      t3: { web: { url: "https://example.com/" } },
    },
    view: "freeform",
    freeform: {
      rects: {
        t1: { x: 0, y: 0, w: 10, h: 10 },
        t2: { x: 5, y: 5, w: 9, h: 9 },
      },
      z: ["t1", "t2"],
      maximized: "t2",
    },
  };
}

Deno.test("tile move: a moved tile is validated; it never arrives minimized", () => {
  const moved = movedTileOf({
    entry: entry("t2", { minimized: true, bell: true }),
    tile: { ptyId: "pty-2", profile: { kind: "shell" } },
    size: { w: 300.4, h: 200 },
  });
  assertEquals(moved?.entry.minimized, undefined);
  assertEquals(moved?.tile, { ptyId: "pty-2", profile: { kind: "shell" } });
  assertEquals(moved?.size, { w: 300, h: 200 });
  // A web tile keeps its page in its entry.
  const web = movedTileOf({
    entry: entry("t3"),
    tile: { web: { url: "https://example.com/", title: "Ex" } },
  });
  assertEquals(web?.entry.web, { url: "https://example.com/", title: "Ex" });
  // Junk is refused: no profile, no entry, a page that is not http(s), too big.
  assertEquals(movedTileOf({ entry: entry("x"), tile: {} }), undefined);
  assertEquals(
    movedTileOf({ tile: { web: { url: "https://a/" } } }),
    undefined,
  );
  assertEquals(
    movedTileOf({ entry: entry("x"), tile: { web: { url: "file:///etc" } } }),
    undefined,
  );
  assertEquals(
    movedTileOf({
      entry: entry("x", { title: "x".repeat(40_000) }),
      tile: { web: { url: "https://a/" } },
    }),
    undefined,
  );
});

Deno.test("tile move: the tile leaves the source snapshot whole", () => {
  const out = withoutTile(snapshot(), "t2") as Record<string, unknown> & {
    terminals: { id: string }[];
  };
  assertEquals(out.terminals.map((t) => t.id), ["t1", "t3"]);
  assertEquals(out.mru, ["t1", "t3"]);
  assertEquals(out.order, ["t1", "t3"]);
  assertFalse(snapshotHasTile(out, "t2"));
  assert(snapshotHasTile(out, "t1"));
  assertEquals(out.freeform, {
    rects: { t1: { x: 0, y: 0, w: 10, h: 10 } },
    z: ["t1"],
    maximized: null,
  });
  assertEquals(out.seq, 3, "ids are never reused");
  // Not a snapshot: as it is.
  assertEquals(withoutTile(null, "t1"), null);
});

Deno.test("tile move: tiles that arrived while no page took them join the snapshot, most recent first", () => {
  const moved = movedTileOf({
    entry: entry("t9", { bell: true }),
    tile: { ptyId: "pty-9", profile: { kind: "shell" } },
  })!;
  const web = movedTileOf({
    entry: entry("t4"),
    tile: { web: { url: "https://example.org/" } },
  })!;
  const raw = withArrivals(snapshot(), [moved, web]);
  const plan = planRestore(raw, [
    { id: "pty-1", cols: 80, rows: 24, data: "", seq: 0, truncated: false },
    { id: "pty-9", cols: 80, rows: 24, data: "x", seq: 4, truncated: false },
  ])!;
  // New ids after the snapshot's counter; the last arrival is focused.
  assertEquals(plan.terminals.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5"]);
  assertEquals(plan.mru.slice(0, 2), ["t5", "t4"]);
  assertEquals(plan.seq, 5);
  const t4 = plan.tiles.find((t) => t.id === "t4")!;
  assert("pty" in t4 && t4.pty?.id === "pty-9", "on its terminal");
  assertEquals(plan.terminals[3].bell, undefined, "signals start clear");
  assertEquals(plan.terminals[4].web, { url: "https://example.org/" });
  // No snapshot yet (a torn-off window): one with only them.
  const fresh = planRestore(withArrivals(null, [web]), [])!;
  assertEquals(fresh.terminals.map((t) => [t.id, t.web?.url]), [
    ["t1", "https://example.org/"],
  ]);
  assertEquals(fresh.view, "tiled");
  // Nothing pending: the snapshot as it is.
  const same = snapshot();
  assertEquals(withArrivals(same, []), same);
});

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

function state(actions: WorkspaceAction[]): WorkspaceState {
  return actions.reduce(reduce, initialState());
}

Deno.test("tile move: an arriving tile is focused, in the slot it was dropped on, signals clear", () => {
  const s = state([
    { type: "add", id: "a", now: 1 },
    { type: "add", id: "b", now: 2 },
    { type: "add", id: "c", now: 3 },
  ]);
  const next = reduce(s, {
    type: "arrive",
    entry: entry("t9", { bell: true, minimized: true }),
    now: 10,
    before: "b",
  });
  assertEquals(next.order, ["a", "t9", "b", "c"]);
  assertEquals(next.focusedId, "t9");
  assertEquals(next.mru[0], "t9");
  const e = next.terminals.find((t) => t.id === "t9")!;
  assertEquals([e.bell, e.minimized, e.lastUsedAt], [undefined, undefined, 10]);
  // No slot: last in the order. A free-form rect is kept, on top.
  const ff = reduce(s, {
    type: "arrive",
    entry: entry("t9"),
    now: 10,
    rect: { x: 5, y: 6, w: 300, h: 200 },
  });
  assertEquals(ff.order, ["a", "b", "c", "t9"]);
  assertEquals(ff.freeform.rects.t9, { x: 5, y: 6, w: 300, h: 200 });
  assertEquals(ff.freeform.z.at(-1), "t9");
  // An id it has already: nothing.
  assertEquals(reduce(s, { type: "arrive", entry: entry("a"), now: 1 }), s);
});

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

Deno.test("workspaces: a terminal moves to another workspace; its events follow that window", () => {
  const r = new WorkspaceRegistry();
  r.join("main", "ws-a");
  r.join("w2", "ws-b");
  r.addPty("ws-a", "pty-1");
  assert(r.movePty("pty-1", "ws-b"));
  assertEquals(r.ptysOf("ws-a"), []);
  assertEquals(r.ptysOf("ws-b"), ["pty-1"]);
  assertEquals(r.workspaceOfPty("pty-1"), "ws-b");
  assertEquals(r.windowOfPty("pty-1"), "w2");
  assertFalse(r.movePty("pty-9", "ws-b"), "unknown terminal");
  assertFalse(r.movePty("pty-1", "ws-z"), "unknown workspace");
  // The window most recently focused first.
  r.focused("main");
  assertEquals(r.focusOrder(), ["main", "w2"]);
});

Deno.test("workspaces: arrivals wait until saved; departures are remembered; a workspace holding one is kept", () => {
  const r = new WorkspaceRegistry();
  r.join("w2", "ws-b");
  assert(r.addArrival("ws-b", "mv-1", { x: 1 }));
  assert(r.addArrival("ws-b", "mv-2", { x: 2 }));
  assertFalse(r.addArrival("ws-z", "mv-3", {}));
  r.ackArrivals("ws-b", ["mv-1"]);
  assertEquals(r.arrivals("ws-b").map((a) => a.move), ["mv-2"]);
  // Its window closes before a page saved it: the workspace (no terminals) is kept for it.
  r.windowClosed("w2");
  assert(r.has("ws-b"));
  assertEquals(r.takeArrivals("ws-b").map((a) => a.move), ["mv-2"]);
  assertEquals(r.arrivals("ws-b"), []);
  r.join("main", "ws-a");
  r.departed("ws-a", "t3");
  assertEquals(r.departures("ws-a"), ["t3"]);
});

Deno.test("workspaces: an ended workspace retires once its moved terminals are gone (the sandbox)", () => {
  const r = new WorkspaceRegistry();
  const retired: string[] = [];
  r.onRetired((id) => retired.push(id));
  r.join("main", "ws-a");
  r.join("w2", "ws-b");
  r.addPty("ws-a", "pty-1");
  r.addPty("ws-a", "pty-2");
  r.movePty("pty-2", "ws-b");
  // Ending ws-a kills pty-1 only; pty-2 still runs in ws-a's container, from ws-b.
  assertEquals(r.end("ws-a"), ["pty-1"]);
  assertEquals(retired, []);
  r.removePty("pty-1");
  assertEquals(retired, []);
  r.removePty("pty-2");
  assertEquals(retired, ["ws-a"]);
  // A workspace with nothing moved away retires as it ends.
  r.addPty("ws-b", "pty-3");
  r.end("ws-b");
  assertEquals(retired, ["ws-a", "ws-b"]);
});

// ---------------------------------------------------------------------------------------------
// The mover (desktop/tile-move.ts), with fake terminals and windows
// ---------------------------------------------------------------------------------------------

function fakeApp() {
  const workspaces = new WorkspaceRegistry();
  const owner = new Map<string, string>();
  const handed: [string, string][] = [];
  const events: { event: string; data: unknown; window: string }[] = [];
  const windows: { id: string; kind: string; key?: string }[] = [
    { id: "main", kind: "main", key: "ws-a" },
    { id: "w2", kind: "window", key: "ws-b" },
    { id: "w3", kind: "window", key: "ws-c" },
    { id: "panel", kind: "panel" },
  ];
  const bounds: Record<
    string,
    { x: number; y: number; width: number; height: number }
  > = {
    main: { x: 0, y: 0, width: 800, height: 600 },
    w2: { x: 900, y: 0, width: 800, height: 600 },
    w3: { x: 1000, y: 100, width: 400, height: 300 },
  };
  const opened: Record<string, unknown>[] = [];
  const closed: string[] = [];
  const mover = new TileMover({
    workspaces,
    sessions: {
      handOver: (id: string, window: string): PtyReplay | undefined => {
        if (!owner.has(id)) return undefined;
        owner.set(id, window);
        handed.push([id, window]);
        return {
          id,
          cols: 80,
          rows: 24,
          data: "replay",
          seq: 7,
          truncated: false,
        };
      },
      ownerOf: (id: string) => owner.get(id),
    },
    emit: (event, data, window) => void events.push({ event, data, window }),
    windows: () => windows,
    bounds: (id) => bounds[id] ?? null,
    openWindow: (options) => {
      opened.push({ ...options });
      const id = `w${windows.length + 1}`;
      windows.push({
        id,
        kind: "window",
        key: (options as { key: string }).key,
      });
      return { id };
    },
    closeWindow: (id) => void closed.push(id),
    newWorkspaceId: () => "ws-new",
    now: () => 1000,
  });
  workspaces.join("w3", "ws-c");
  workspaces.join("w2", "ws-b");
  workspaces.join("main", "ws-a");
  workspaces.addPty("ws-a", "pty-1");
  owner.set("pty-1", "main");
  workspaces.save("ws-a", {
    v: 1,
    seq: 2,
    terminals: [entry("t1"), entry("t2")],
    mru: ["t1", "t2"],
    order: ["t1", "t2"],
    tiles: {
      t1: { ptyId: "pty-1", profile: { kind: "shell" } },
      t2: { web: { url: "https://example.com/" } },
    },
  });
  return { workspaces, owner, handed, events, mover, opened, closed, windows };
}

const shellTile = {
  entry: entry("t1"),
  tile: { ptyId: "pty-1", profile: { kind: "shell" } },
};

Deno.test("tile mover: Move to Window changes the terminal's owner and both snapshots in one step", () => {
  const app = fakeApp();
  assertEquals(app.mover.targets("main").map((t) => [t.window, t.name]), [
    ["w2", "Workspace 2"],
    ["w3", "Workspace 1"],
  ]);
  const result = app.mover.move("main", {
    tileId: "t1",
    tile: shellTile,
    to: { window: "w2" },
    last: false,
  });
  assertEquals(result, {
    moved: true,
    move: "mv-rs-1",
    window: "w2",
    created: false,
  });
  // The source snapshot lost it; the target holds it until its page saves it.
  assertFalse(snapshotHasTile(app.workspaces.snapshotOf("ws-a"), "t1"));
  assert(snapshotHasTile(app.workspaces.snapshotOf("ws-a"), "t2"));
  assertEquals(app.workspaces.departures("ws-a"), ["t1"]);
  assertEquals(app.workspaces.arrivals("ws-b").map((a) => a.move), ["mv-rs-1"]);
  // The terminal belongs to the target now (no restart: the same PTY).
  assertEquals(app.workspaces.workspaceOfPty("pty-1"), "ws-b");
  assertEquals(app.owner.get("pty-1"), "w2");
  // Both pages are told.
  assertEquals(app.events, [
    { event: "tileArrived", data: { move: "mv-rs-1" }, window: "w2" },
    {
      event: "tileLeft",
      data: { tile: "t1", move: "mv-rs-1" },
      window: "main",
    },
  ]);
  // The target page pulls it with its replay.
  const [arrival] = app.mover.arrivals("w2");
  assertEquals(arrival.move, "mv-rs-1");
  assertEquals(arrival.tile.entry.id, "t1");
  assertEquals(arrival.pty?.data, "replay");
  assertEquals(app.closed, [], "the source window keeps its other tile");
});

Deno.test("tile mover: a web tile moves as its page; nothing is handed over", () => {
  const app = fakeApp();
  const result = app.mover.move("main", {
    tileId: "t2",
    tile: {
      entry: entry("t2"),
      tile: { web: { url: "https://example.com/" } },
    },
    to: { window: "w3" },
    last: false,
  });
  assert(result.moved);
  assertEquals(app.handed, []);
  const [a] = app.mover.arrivals("w3");
  assertEquals(a.tile.tile, { web: { url: "https://example.com/" } });
  assertEquals(a.pty, undefined);
});

Deno.test("tile mover: refuses another window's terminal, the same window, junk", () => {
  const app = fakeApp();
  app.owner.set("pty-1", "w2");
  const req = (to: MoveRequest["to"], tile: unknown = shellTile) =>
    app.mover.move("main", { tileId: "t1", tile, to, last: false });
  assertEquals(req({ window: "w2" }), { moved: false, reason: "not-owner" });
  app.owner.set("pty-1", "main");
  assertEquals(req({ window: "main" }), { moved: false, reason: "no-window" });
  assertEquals(req({ window: "nope" }), { moved: false, reason: "no-window" });
  assertEquals(req({ window: "w2" }, { entry: {} }), {
    moved: false,
    reason: "invalid",
  });
  assertEquals(app.workspaces.workspaceOfPty("pty-1"), "ws-a", "nothing moved");
  assertEquals(app.events, []);
});

Deno.test("tile mover: the last tile closes its window, whose workspace ends once closed", () => {
  const app = fakeApp();
  const result = app.mover.move("main", {
    tileId: "t1",
    tile: shellTile,
    to: { window: "w2" },
    last: true,
  });
  assert(result.moved);
  assertEquals(app.closed, ["main"]);
  assert(app.workspaces.has("ws-a"), "not before the window has closed");
  app.workspaces.windowClosed("main");
  assertFalse(app.workspaces.has("ws-a"));
  // The terminal lives on in the other workspace.
  assertEquals(app.workspaces.ptysOf("ws-b"), ["pty-1"]);
});

Deno.test("tile mover: a drop lands in the front window under the pointer, at the point in its page", () => {
  const app = fakeApp();
  app.workspaces.focused("w3");
  app.workspaces.focused("main");
  // Over w2 and w3 (w3 focused more recently, so in front).
  const result = app.mover.move("main", {
    tileId: "t1",
    tile: shellTile,
    to: { screen: { x: 1100, y: 228 }, origin: { x: 0, y: 28 } },
    last: false,
  });
  assertEquals(result.moved && result.window, "w3");
  const [a] = app.mover.arrivals("w3");
  assertEquals(a.at, { x: 100, y: 100 });
});

Deno.test("tile mover: a drop on no window tears off into a new one there, unless it is the only tile", () => {
  const app = fakeApp();
  const only = app.mover.move("main", {
    tileId: "t1",
    tile: shellTile,
    to: { screen: { x: 300, y: 900 }, origin: { x: 0, y: 0 } },
    last: true,
  });
  assertEquals(only, { moved: false, reason: "last" });
  assertEquals(app.opened, []);
  const result = app.mover.move("main", {
    tileId: "t1",
    tile: shellTile,
    to: { screen: { x: 300, y: 900 }, origin: { x: 0, y: 0 } },
    last: false,
    size: { width: 1000, height: 700 },
  });
  assertEquals(result.moved && result.created, true);
  assertEquals(app.opened, [{
    url: "/",
    key: "ws-new",
    title: "Qutty",
    width: 1000,
    height: 700,
    x: 180,
    y: 886,
  }]);
  // The new window's workspace holds the tile for its page.
  assertEquals(app.workspaces.workspaceOfPty("pty-1"), "ws-new");
  assertEquals(app.workspaces.arrivals("ws-new").length, 1);
  // The menu's "Move to New Window": wherever Denext puts a new window.
  const web = app.mover.move("main", {
    tileId: "t2",
    tile: {
      entry: entry("t2"),
      tile: { web: { url: "https://example.com/" } },
    },
    to: { newWindow: true },
    last: true,
  });
  assertEquals(web, { moved: false, reason: "last" });
});

Deno.test("tile mover: the window under a dragged tile is told where, and told when it is left", () => {
  const app = fakeApp();
  app.workspaces.focused("w3"); // in front of w2 where they overlap
  const over = (x: number, y: number) =>
    app.mover.dragOver("main", {
      screen: { x, y },
      origin: { x: 0, y: 0 },
      title: "zsh",
    });
  assertEquals(over(950, 10), { target: "w2" });
  assertEquals(over(960, 20), { target: "w2" });
  assertEquals(over(1100, 200), { target: "w3" });
  assertEquals(over(5000, 5000), { target: null });
  app.mover.dragEnd("main");
  const hovers = app.events.map((e) => [e.window, e.data as DragHover]);
  assertEquals(hovers, [
    ["w2", { from: "main", title: "zsh", x: 50, y: 10 }],
    ["w2", { from: "main", title: "zsh", x: 60, y: 20 }],
    ["w2", { from: "main", leave: true }],
    ["w3", { from: "main", title: "zsh", x: 100, y: 100 }],
    ["w3", { from: "main", leave: true }],
  ]);
});

Deno.test("tile mover: a tile that arrived and moves on before its page saved it is not pending twice", () => {
  const app = fakeApp();
  app.mover.move("main", {
    tileId: "t1",
    tile: shellTile,
    to: { window: "w2" },
    last: false,
  });
  // w2's page showed it as t5 but has not saved yet; it moves on to w3.
  app.workspaces.save("ws-b", {
    v: 1,
    seq: 5,
    terminals: [entry("t5")],
    mru: ["t5"],
    tiles: { t5: { ptyId: "pty-1", profile: { kind: "shell" } } },
  });
  const r = app.mover.move("w2", {
    tileId: "t5",
    tile: {
      entry: entry("t5"),
      tile: { ptyId: "pty-1", profile: { kind: "shell" } },
    },
    to: { window: "w3" },
    last: true,
  });
  assert(r.moved);
  assertEquals(app.workspaces.arrivals("ws-b"), []);
  assertEquals(app.workspaces.arrivals("ws-c").length, 1);
  assertEquals(app.workspaces.workspaceOfPty("pty-1"), "ws-c");
});

Deno.test("tile mover: the page's move input is validated", () => {
  const ok = moveInput["~standard"].validate({
    tileId: "t1",
    tile: {},
    to: { screen: { x: 1, y: 2 }, origin: { x: 0, y: 0 } },
    last: true,
    size: { width: 10, height: 20 },
  });
  assert(!ok.issues);
  assertEquals((ok as { value: MoveRequest }).value.to, {
    screen: { x: 1, y: 2 },
    origin: { x: 0, y: 0 },
  });
  const bad = moveInput["~standard"].validate({ tileId: "t1", to: { x: 1 } });
  assert(bad.issues);
  const nan = moveInput["~standard"].validate({
    tileId: "t1",
    to: { screen: { x: NaN, y: 2 }, origin: { x: 0, y: 0 } },
  });
  assert(nan.issues);
});
