import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  barOrderIds,
  DEFAULT_SETTINGS,
  INACTIVE_TILE_MODES,
  initialState,
  loadSettings,
  PATTERNS,
  reduce,
  sanitizeSettings,
  saveSettings,
  SETTINGS_SECTIONS,
  SETTINGS_STORAGE_KEY,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";

function run(
  actions: WorkspaceAction[],
  from = initialState(),
): WorkspaceState {
  return actions.reduce(reduce, from);
}

/** An in-memory settings storage and the map behind it. */
function memoryStorage() {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  return { mem, storage };
}

const three = (): WorkspaceState =>
  run([
    { type: "add", id: "a", now: 1 },
    { type: "add", id: "b", now: 2 },
    { type: "add", id: "c", now: 3 },
  ]);

Deno.test("add focuses the new terminal and keeps creation order", () => {
  const s = three();
  assertEquals(s.terminals.map((t) => t.id), ["a", "b", "c"]);
  assertEquals(s.mru, ["c", "b", "a"]);
  assertEquals(s.focusedId, "c");
  assertEquals(
    reduce(s, { type: "add", id: "a", now: 9 }),
    s,
    "duplicate add is a no-op",
  );
});

Deno.test("focus touches MRU, stamps lastUsedAt and clears activity", () => {
  let s = three();
  s = reduce(s, { type: "activity", id: "a" });
  assert(s.terminals.find((t) => t.id === "a")!.activity);
  assertStrictEquals(
    reduce(s, { type: "activity", id: "c" }),
    s,
    "focused terminal never shows activity",
  );
  s = reduce(s, { type: "focus", id: "a", now: 10 });
  assertEquals(s.mru, ["a", "c", "b"]);
  assertEquals(s.focusedId, "a");
  const a = s.terminals.find((t) => t.id === "a")!;
  assertEquals(a.lastUsedAt, 10);
  assertEquals(a.activity, false);
  assertStrictEquals(
    reduce(s, { type: "focus", id: "zz", now: 11 }),
    s,
    "unknown id is a no-op",
  );
});

Deno.test("remove drops the terminal and focuses the next most recent", () => {
  let s = three();
  s = reduce(s, { type: "remove", id: "c" });
  assertEquals(s.terminals.map((t) => t.id), ["a", "b"]);
  assertEquals(s.mru, ["b", "a"]);
  assertEquals(s.focusedId, "b");
  s = run([{ type: "remove", id: "b" }, { type: "remove", id: "a" }], s);
  assertEquals(s.focusedId, null);
  assertEquals(s.mru, []);
});

Deno.test("focusPrevious jumps to mru[1]; focusOrdinal follows the bar order", () => {
  let s = three();
  s = reduce(s, { type: "focusPrevious", now: 5 });
  assertEquals(s.focusedId, "b");
  // Bar in MRU order: b, c, a → ordinal 3 is "a".
  assertEquals(barOrderIds(s), ["b", "c", "a"]);
  s = reduce(s, { type: "focusOrdinal", ordinal: 3, now: 6 });
  assertEquals(s.focusedId, "a");
  // Creation order: a, b, c → ordinal 2 is "b".
  s = reduce(s, { type: "setBarOrder", order: "created" });
  assertEquals(barOrderIds(s), ["a", "b", "c"]);
  s = reduce(s, { type: "focusOrdinal", ordinal: 2, now: 7 });
  assertEquals(s.focusedId, "b");
  assertStrictEquals(
    reduce(s, { type: "focusOrdinal", ordinal: 9, now: 8 }),
    s,
  );
});

Deno.test("cycle walks the MRU snapshot like alt-tab until endCycle", () => {
  let s = three(); // mru c, b, a
  s = reduce(s, { type: "cycle", dir: 1, now: 10 });
  assertEquals(s.focusedId, "b");
  assertEquals(s.mru, ["b", "c", "a"]);
  s = reduce(s, { type: "cycle", dir: 1, now: 11 });
  assertEquals(
    s.focusedId,
    "a",
    "a second press continues down the original order",
  );
  s = reduce(s, { type: "cycle", dir: 1, now: 12 });
  assertEquals(s.focusedId, "c", "wraps around");
  s = reduce(s, { type: "cycle", dir: -1, now: 13 });
  assertEquals(s.focusedId, "a", "backwards");
  s = reduce(s, { type: "endCycle" });
  assertEquals(s.cycle, null);
  assertEquals(s.mru[0], "a");
  // A fresh cycle starts from the new MRU order (a, c, b).
  s = reduce(s, { type: "cycle", dir: 1, now: 14 });
  assertEquals(s.focusedId, "c");
  // A plain focus ends the cycle.
  s = reduce(s, { type: "focus", id: "b", now: 15 });
  assertEquals(s.cycle, null);
  // One terminal: nothing to cycle.
  const one = run([{ type: "add", id: "x", now: 1 }]);
  assertStrictEquals(reduce(one, { type: "cycle", dir: 1, now: 2 }), one);
});

Deno.test("exit, restart and title updates", () => {
  let s = three();
  s = reduce(s, { type: "exited", id: "a", exitCode: 130 });
  let a = s.terminals.find((t) => t.id === "a")!;
  assertEquals([a.exited, a.exitCode], [true, 130]);
  s = reduce(s, { type: "restarted", id: "a", now: 50 });
  a = s.terminals.find((t) => t.id === "a")!;
  assertEquals([a.exited, a.exitCode, a.lastUsedAt], [false, null, 50]);
  s = reduce(s, { type: "title", id: "a", title: "vim — ~/x" });
  assertEquals(s.terminals.find((t) => t.id === "a")!.title, "vim — ~/x");
  assertStrictEquals(
    reduce(s, { type: "title", id: "a", title: "vim — ~/x" }),
    s,
    "same title is a no-op",
  );
});

Deno.test("setLayout clamps and cyclePattern walks every pattern", () => {
  let s = initialState();
  s = reduce(s, {
    type: "setLayout",
    patch: { decay: 5, masterRatio: 0, maxVisible: 3.6, gap: -4 },
  });
  assertEquals(s.settings.layout.decay, 1);
  assertEquals(s.settings.layout.masterRatio, 0.5);
  assertEquals(s.settings.layout.maxVisible, 4);
  assertEquals(s.settings.layout.gap, 0);
  s = reduce(s, { type: "setLayout", patch: { pattern: "nope" as never } });
  assertEquals(s.settings.layout.pattern, "cascade");
  const seen: string[] = [];
  for (let i = 0; i < PATTERNS.length; i++) {
    s = reduce(s, { type: "cyclePattern" });
    seen.push(s.settings.layout.pattern);
  }
  assertEquals(new Set(seen).size, PATTERNS.length);
  assertEquals(s.settings.layout.pattern, "cascade");
});

Deno.test("toggleMonocle remembers and restores the previous pattern", () => {
  let s = reduce(initialState(), {
    type: "setLayout",
    patch: { pattern: "spiral" },
  });
  s = reduce(s, { type: "toggleMonocle" });
  assertEquals(s.settings.layout.pattern, "monocle");
  assertEquals(s.previousPattern, "spiral");
  s = reduce(s, { type: "toggleMonocle" });
  assertEquals(s.settings.layout.pattern, "spiral");
  assertEquals(s.previousPattern, null);
  // Monocle picked by hand, then toggled off → cascade.
  s = reduce(s, { type: "setLayout", patch: { pattern: "monocle" } });
  s = reduce(s, { type: "toggleMonocle" });
  assertEquals(s.settings.layout.pattern, "cascade");
});

Deno.test("bar position cycles through all four edges", () => {
  let s = initialState();
  const seen = [s.settings.barPosition];
  for (let i = 0; i < 4; i++) {
    s = reduce(s, { type: "cycleBarPosition" });
    seen.push(s.settings.barPosition);
  }
  assertEquals(seen, ["top", "bottom", "left", "right", "top"]);
  assertStrictEquals(reduce(s, { type: "setBarPosition", position: "top" }), s);
});

Deno.test("settings sanitise untrusted input and round-trip through storage", () => {
  const junk = sanitizeSettings({
    layout: { decay: "x", maxVisible: 99, pattern: "grid" },
    barPosition: "diagonal",
    barOrder: "created",
  });
  assertEquals(junk.layout.decay, DEFAULT_SETTINGS.layout.decay);
  assertEquals(junk.layout.maxVisible, 16);
  assertEquals(junk.layout.pattern, "grid");
  assertEquals(junk.barPosition, "top");
  assertEquals(junk.barOrder, "created");
  assertEquals(sanitizeSettings(null), DEFAULT_SETTINGS);

  const { mem, storage } = memoryStorage();
  assertEquals(loadSettings(storage), null);
  assert(saveSettings({ ...DEFAULT_SETTINGS, barPosition: "left" }, storage));
  assert(mem.has(SETTINGS_STORAGE_KEY));
  assertEquals(loadSettings(storage)?.barPosition, "left");
  mem.set(SETTINGS_STORAGE_KEY, "{not json");
  assertEquals(loadSettings(storage), null);
  const throwing = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assertEquals(loadSettings(throwing), null);
  assertEquals(saveSettings(DEFAULT_SETTINGS, throwing), false);
  assertEquals(saveSettings(DEFAULT_SETTINGS, null), false);
  assertEquals(loadSettings(null), null);

  const s = reduce(initialState(), {
    type: "hydrateSettings",
    settings: { barPosition: "right", layout: { gap: 12 } as never },
  });
  assertEquals(s.settings.barPosition, "right");
  assertEquals(s.settings.layout.gap, 12);
  assertEquals(s.settings.layout.pattern, "cascade");
});

Deno.test("settings: the theme and folded sections sanitise, reduce and persist", () => {
  assertEquals(DEFAULT_SETTINGS.theme, "sea-glass");
  // Agent integration starts folded; the rest open.
  assertEquals(DEFAULT_SETTINGS.collapsedSections, ["integration"]);
  assertEquals(sanitizeSettings({ theme: "plum" }).theme, "plum");
  for (const junk of ["solarized", "", 7, null, { id: "plum" }]) {
    assertEquals(sanitizeSettings({ theme: junk }).theme, "sea-glass");
  }
  // Absent keeps the base (a partial hydrate does not reset the theme).
  assertEquals(
    sanitizeSettings({}, { ...DEFAULT_SETTINGS, theme: "cloud" }).theme,
    "cloud",
  );
  assertEquals(
    sanitizeSettings({ collapsedSections: ["font", "bogus", 3, "layout"] })
      .collapsedSections,
    ["layout", "font"],
  );
  // Junk keeps the base's.
  assertEquals(
    sanitizeSettings({ collapsedSections: "layout" }).collapsedSections,
    ["integration"],
  );
  assertEquals(SETTINGS_SECTIONS, [
    "layout",
    "tiles",
    "theme",
    "font",
    "companion",
    "voice",
    "sandbox",
    "ollama",
    "links",
    "monitor",
    "windows",
    "integration",
  ]);

  let s = initialState();
  s = reduce(s, { type: "setTheme", theme: "sakura" });
  assertEquals(s.settings.theme, "sakura");
  assertStrictEquals(reduce(s, { type: "setTheme", theme: "sakura" }), s);
  assertEquals(
    reduce(s, { type: "setTheme", theme: "nope" as never }).settings.theme,
    "sea-glass",
  );
  s = reduce(s, { type: "toggleSection", section: "integration" });
  assertEquals(s.settings.collapsedSections, [], "integration unfolds");
  s = reduce(s, { type: "toggleSection", section: "font" });
  s = reduce(s, { type: "toggleSection", section: "layout" });
  assertEquals(s.settings.collapsedSections, ["layout", "font"]);
  s = reduce(s, { type: "toggleSection", section: "font" });
  assertEquals(s.settings.collapsedSections, ["layout"]);
  assertStrictEquals(
    reduce(s, { type: "toggleSection", section: "nope" as never }),
    s,
  );

  const { mem, storage } = memoryStorage();
  assert(saveSettings(s.settings, storage));
  const back = reduce(initialState(), {
    type: "hydrateSettings",
    settings: loadSettings(storage)!,
  });
  assertEquals(back.settings.theme, "sakura");
  assertEquals(back.settings.collapsedSections, ["layout"]);
  // A stored theme that no longer exists.
  mem.set(SETTINGS_STORAGE_KEY, JSON.stringify({ theme: "retired" }));
  assertEquals(
    reduce(initialState(), {
      type: "hydrateSettings",
      settings: loadSettings(storage)!,
    }).settings.theme,
    "sea-glass",
  );
});

Deno.test("SSH tiles: titled by their host, keep it, and carry the exit details", () => {
  const ssh = {
    kind: "ssh" as const,
    target: { alias: "prod-api" },
    label: "prod-api",
    tint: "red",
  };
  let s = run([{ type: "add", id: "s", now: 1, ssh }]);
  let t = s.terminals[0];
  assertEquals([t.title, t.ssh], ["prod-api", ssh]);
  assertStrictEquals(
    reduce(s, { type: "title", id: "s", title: "ssh — ~" }),
    s,
    "polled titles do not replace the host label",
  );
  s = reduce(s, { type: "exited", id: "s", exitCode: 255, signal: null });
  t = s.terminals[0];
  assertEquals([t.exited, t.exitCode, t.exitSignal], [true, 255, null]);
  s = reduce(s, {
    type: "exited",
    id: "s",
    exitCode: null,
    message: "bad alias",
  });
  assertEquals(s.terminals[0].exitMessage, "bad alias");
  s = reduce(s, { type: "restarted", id: "s", now: 9 });
  t = s.terminals[0];
  assertEquals([t.exited, t.exitCode, t.exitMessage], [false, null, undefined]);
});

Deno.test("settings: inactive tiles default to resize, sanitise, reduce and persist", () => {
  assertEquals(DEFAULT_SETTINGS.inactiveTiles, "resize");
  assertEquals(INACTIVE_TILE_MODES, ["resize", "scale"]);
  assertEquals(
    sanitizeSettings({ inactiveTiles: "scale" }).inactiveTiles,
    "scale",
  );
  for (const junk of ["zoom", "", 1, null, ["scale"]]) {
    assertEquals(
      sanitizeSettings({ inactiveTiles: junk }).inactiveTiles,
      "resize",
    );
  }
  // Absent keeps the base.
  assertEquals(
    sanitizeSettings({}, { ...DEFAULT_SETTINGS, inactiveTiles: "scale" })
      .inactiveTiles,
    "scale",
  );

  let s = initialState();
  s = reduce(s, { type: "setInactiveTiles", mode: "scale" });
  assertEquals(s.settings.inactiveTiles, "scale");
  assertStrictEquals(reduce(s, { type: "setInactiveTiles", mode: "scale" }), s);
  assertStrictEquals(
    reduce(s, { type: "setInactiveTiles", mode: "bogus" as never }),
    s,
  );

  const { storage } = memoryStorage();
  assert(saveSettings(s.settings, storage));
  const back = reduce(initialState(), {
    type: "hydrateSettings",
    settings: loadSettings(storage)!,
  });
  assertEquals(back.settings.inactiveTiles, "scale");
});

Deno.test("settings: links default to auto, sanitise, reduce and persist", () => {
  assertEquals(DEFAULT_SETTINGS.links, {
    editor: "auto",
    command: "",
    web: "tile",
  });
  assertEquals(
    sanitizeSettings({
      links: { editor: "bogus", command: "zed {file}", web: "tab" },
    }).links,
    { editor: "auto", command: "zed {file}", web: "tile" },
  );
  assertEquals(
    sanitizeSettings({ links: { web: "browser" } }).links.web,
    "browser",
  );
  let s = initialState();
  s = reduce(s, { type: "setLinks", patch: { editor: "zed" } });
  assertEquals(s.settings.links.editor, "zed");
  assertStrictEquals(
    reduce(s, { type: "setLinks", patch: { editor: "zed" } }),
    s,
  );
  s = reduce(s, {
    type: "setLinks",
    patch: { editor: "custom", command: "hx {file}" },
  });
  s = reduce(s, { type: "setLinks", patch: { web: "browser" } });
  assertEquals(s.settings.links.web, "browser");
  const { storage } = memoryStorage();
  assert(saveSettings(s.settings, storage));
  const back = reduce(initialState(), {
    type: "hydrateSettings",
    settings: loadSettings(storage)!,
  });
  assertEquals(back.settings.links, {
    editor: "custom",
    command: "hx {file}",
    web: "browser",
  });
});

Deno.test("settings: the system monitor defaults (meter off, hot Loopy on), reduces and persists", () => {
  assertEquals(DEFAULT_SETTINGS.monitor, {
    meter: false,
    hotLoopy: true,
    hotAt: 85,
    coolAt: 70,
    sustainS: 10,
  });
  let s = initialState();
  s = reduce(s, { type: "setMonitor", patch: { meter: true, sustainS: 4 } });
  assertEquals(s.settings.monitor.meter, true);
  assertStrictEquals(
    reduce(s, { type: "setMonitor", patch: { meter: true } }),
    s,
  );
  const { storage } = memoryStorage();
  assert(saveSettings(s.settings, storage));
  const back = reduce(initialState(), {
    type: "hydrateSettings",
    settings: loadSettings(storage)!,
  });
  assertEquals(back.settings.monitor, { ...s.settings.monitor });
  assertEquals(
    sanitizeSettings({ monitor: { hotAt: "x", meter: 1 } }).monitor,
    DEFAULT_SETTINGS.monitor,
  );
});

Deno.test("settings: what a window's close button does defaults to asking, reduces and persists", () => {
  assertEquals(DEFAULT_SETTINGS.windowClose, "ask");
  // Settings stored before the choice existed get the default.
  assertEquals(sanitizeSettings({ theme: "plum" }).windowClose, "ask");
  for (const junk of ["", "close", "ASK", 1, null, {}, ["end"], true]) {
    assertEquals(sanitizeSettings({ windowClose: junk }).windowClose, "ask");
  }
  for (const choice of ["ask", "keep", "end"] as const) {
    assertEquals(sanitizeSettings({ windowClose: choice }).windowClose, choice);
  }
  // A stored choice survives a junk-free hydrate on top of another base.
  assertEquals(
    sanitizeSettings({}, { ...DEFAULT_SETTINGS, windowClose: "end" })
      .windowClose,
    "end",
  );

  let s = initialState();
  s = reduce(s, { type: "setWindowClose", windowClose: "keep" });
  assertEquals(s.settings.windowClose, "keep");
  assertStrictEquals(
    reduce(s, { type: "setWindowClose", windowClose: "keep" }),
    s,
  );
  assertEquals(
    reduce(s, { type: "setWindowClose", windowClose: "bogus" as never })
      .settings.windowClose,
    "ask",
  );
  s = reduce(s, { type: "setWindowClose", windowClose: "end" });
  const { storage, mem } = memoryStorage();
  assert(saveSettings(s.settings, storage));
  assertEquals(JSON.parse(mem.get(SETTINGS_STORAGE_KEY)!).windowClose, "end");
  const back = reduce(initialState(), {
    type: "hydrateSettings",
    settings: loadSettings(storage)!,
  });
  assertEquals(back.settings.windowClose, "end");
});
