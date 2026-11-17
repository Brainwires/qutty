// The web tiles' browser parts that are pure: the browser keys and their routing by the focused
// tile (lib/workspace/keys.ts), the visited pages and the address field's suggestions
// (lib/web/visits.ts), page zoom per site (lib/web/zoom.ts) and the Back / Forward list a tile
// keeps of a native view (lib/web/history.ts `followUrl`).

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  forwardAccelerators,
  type KeyLike,
  routeKey,
  webCommandForKey,
} from "../lib/workspace/keys.ts";
import {
  bareUrl,
  MAX_VISITS,
  NO_VISITS,
  recordVisit,
  removeVisits,
  sanitizeVisits,
  searchVisits,
  suggest,
  titleVisit,
} from "../lib/web/visits.ts";
import { addBookmark, emptyBookmarks } from "../lib/web/bookmarks.ts";
import {
  NO_ZOOM,
  sanitizeZoom,
  setSiteZoom,
  stepZoom,
  zoomFor,
  zoomLabel,
} from "../lib/web/zoom.ts";
import { followUrl, startHistory } from "../lib/web/history.ts";
import { MAX_FORWARD_KEYS } from "../lib/web/native-engine.ts";

const key = (
  code: string,
  mods: Partial<Omit<KeyLike, "code" | "key">> = {},
): KeyLike => ({
  key: "",
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const cmd = (code: string, mods: Partial<KeyLike> = {}) =>
  key(code, { metaKey: true, ...mods });
const ctrl = (code: string, mods: Partial<KeyLike> = {}) =>
  key(code, { ctrlKey: true, ...mods });

Deno.test("keys: the browser keys, Safari's on macOS and Ctrl elsewhere", () => {
  const mac = (k: KeyLike) => webCommandForKey(k, "mac");
  assertEquals(mac(cmd("KeyL")), { kind: "focusAddress" });
  assertEquals(mac(cmd("KeyR")), { kind: "reload", ignoreCache: false });
  assertEquals(mac(cmd("KeyR", { shiftKey: true })), {
    kind: "reload",
    ignoreCache: true,
  });
  assertEquals(mac(cmd("Period")), { kind: "stop" });
  assertEquals(mac(cmd("BracketLeft")), { kind: "back" });
  assertEquals(mac(cmd("BracketRight")), { kind: "forward" });
  assertEquals(mac(cmd("KeyD")), { kind: "bookmark" });
  assertEquals(mac(cmd("KeyF")), { kind: "find" });
  assertEquals(mac(cmd("KeyG")), { kind: "findNext", dir: 1 });
  assertEquals(mac(cmd("KeyG", { shiftKey: true })), {
    kind: "findNext",
    dir: -1,
  });
  assertEquals(mac(cmd("Equal")), { kind: "zoom", dir: 1 });
  assertEquals(mac(cmd("Equal", { shiftKey: true })), { kind: "zoom", dir: 1 });
  assertEquals(mac(cmd("NumpadAdd")), { kind: "zoom", dir: 1 });
  assertEquals(mac(cmd("Minus")), { kind: "zoom", dir: -1 });
  assertEquals(mac(cmd("Digit0")), { kind: "zoomReset" });
  assertEquals(mac(cmd("KeyP")), { kind: "print" });
  assertEquals(mac(cmd("KeyI", { altKey: true })), { kind: "devTools" });
  // Not browser keys: ⌘T, ⌘W, ⌘N stay Qutty's; Ctrl on macOS is not the modifier.
  for (
    const k of [
      cmd("KeyT"),
      cmd("KeyW"),
      cmd("KeyN"),
      cmd("KeyC"),
      ctrl("KeyL"),
    ]
  ) {
    assertEquals(mac(k), null);
  }
  const other = (k: KeyLike) => webCommandForKey(k, "other");
  assertEquals(other(ctrl("KeyL")), { kind: "focusAddress" });
  assertEquals(other(ctrl("KeyI", { altKey: true })), { kind: "devTools" });
  assertEquals(other(ctrl("Period")), null, "⌘. is macOS's");
  assertEquals(other(cmd("KeyL")), null);
});

Deno.test("keys: a focused web tile takes its browser keys; every other shortcut is the workspace's", () => {
  // ⌘[ / ⌘] go back and forward over a web tile, and cycle tiles from a terminal.
  assertEquals(routeKey(cmd("BracketLeft"), "mac", true), {
    scope: "web",
    cmd: { kind: "back" },
  });
  assertEquals(routeKey(cmd("BracketLeft"), "mac", false), {
    scope: "workspace",
    cmd: { kind: "cycle", dir: -1 },
  });
  // ⌘= zooms the page over a web tile, the font from a terminal.
  assertEquals(routeKey(cmd("Equal"), "mac", true), {
    scope: "web",
    cmd: { kind: "zoom", dir: 1 },
  });
  assertEquals(routeKey(cmd("Equal"), "mac", false), {
    scope: "workspace",
    cmd: { kind: "fontSize", dir: 1 },
  });
  assertEquals(routeKey(cmd("Digit0"), "mac", false), {
    scope: "workspace",
    cmd: { kind: "fontSizeReset" },
  });
  // The rest stays the workspace's over a web tile too.
  assertEquals(routeKey(cmd("KeyT"), "mac", true), {
    scope: "workspace",
    cmd: { kind: "newTerminal" },
  });
  assertEquals(routeKey(cmd("KeyW"), "mac", true), {
    scope: "workspace",
    cmd: { kind: "closeFocused" },
  });
  assertEquals(routeKey(cmd("Digit3"), "mac", true), {
    scope: "workspace",
    cmd: { kind: "focusOrdinal", ordinal: 3 },
  });
  assertEquals(routeKey(cmd("KeyI", { shiftKey: true }), "mac", true), {
    scope: "workspace",
    cmd: { kind: "toggleBroadcast" },
  });
  // A terminal never sees the browser keys taken (⌘L, ⌘F … reach the shell's own handling).
  assertEquals(routeKey(cmd("KeyL"), "mac", false), null);
  assertEquals(routeKey(cmd("KeyF"), "mac", false), null);
  assertEquals(routeKey(key("KeyL"), "mac", true), null, "no modifier");
});

Deno.test("keys: a native page hands back the browser keys, within the view's limit", () => {
  const off = { pttKey: "off", dictateKey: "off" } as const;
  for (const platform of ["mac", "other"] as const) {
    const keys = forwardAccelerators(off, platform);
    assert(keys.includes("CmdOrCtrl+L"));
    assert(keys.includes("CmdOrCtrl+Alt+I"));
    assert(!keys.includes("CmdOrCtrl+C"));
    assert(keys.length <= MAX_FORWARD_KEYS, `${keys.length}`);
    const talk = forwardAccelerators(
      { pttKey: "Mod+Shift+M", dictateKey: "Mod+Shift+K" },
      platform,
    );
    assert(talk.length <= MAX_FORWARD_KEYS, `${talk.length}`);
  }
});

Deno.test("visits: newest first, once each, counted, titled, capped", () => {
  let h = recordVisit(NO_VISITS, { url: "https://a.example/" }, 1);
  h = recordVisit(h, { url: "https://b.example/", title: "B" }, 2);
  h = recordVisit(h, { url: "https://a.example/" }, 3);
  assertEquals(h.visits.map((v) => [v.url, v.count, v.at]), [
    ["https://a.example/", 2, 3],
    ["https://b.example/", 1, 2],
  ]);
  assertStrictEquals(recordVisit(h, { url: "javascript:1" }, 4), h);
  h = titleVisit(h, "https://a.example/", "  Page\nA ");
  assertEquals(h.visits[0].title, "Page A");
  assertStrictEquals(titleVisit(h, "https://a.example/", "Page A"), h);
  assertStrictEquals(titleVisit(h, "https://nope/", "X"), h);
  // A later visit with no title keeps the one it had.
  assertEquals(
    recordVisit(h, { url: "https://a.example/" }, 5).visits[0].title,
    "Page A",
  );
  assertEquals(searchVisits(h, "page").map((v) => v.url), [
    "https://a.example/",
  ]);
  assertEquals(searchVisits(h, "").length, 2);
  assertEquals(removeVisits(h, ["https://a.example/"]).visits.length, 1);
  let many = NO_VISITS;
  for (let i = 0; i < MAX_VISITS + 5; i++) {
    many = recordVisit(many, { url: `https://p${i}.example/` }, i + 1);
  }
  assertEquals(many.visits.length, MAX_VISITS);
  assertEquals(many.visits[0].url, `https://p${MAX_VISITS + 4}.example/`);
});

Deno.test("visits: sanitize", () => {
  const h = sanitizeVisits({
    visits: [
      { url: "https://old/", title: "Old", at: 1, count: 2 },
      { url: "https://new/", title: "\u0001New", at: 9, count: -4 },
      { url: "https://old/", title: "dup", at: 5 },
      { url: "file:///x", at: 3 },
      "junk",
    ],
  });
  assertEquals(h.visits, [
    { url: "https://new/", title: "New", at: 9, count: 1 },
    { url: "https://old/", title: "Old", at: 1, count: 2 },
  ]);
  assertEquals(sanitizeVisits(undefined), NO_VISITS);
});

Deno.test("suggestions: bookmarks and visited pages, prefix first, a URL once", () => {
  let b = emptyBookmarks();
  b = addBookmark(b, { title: "Deno docs", url: "https://docs.deno.com/" })
    .bookmarks;
  b = addBookmark(b, { title: "GitHub", url: "https://github.com/" }).bookmarks;
  let h = NO_VISITS;
  h = recordVisit(h, { url: "https://github.com/", title: "GitHub" }, 1);
  h = recordVisit(h, { url: "https://www.dev.to/", title: "DEV" }, 2);
  h = recordVisit(h, { url: "https://deno.land/manual", title: "Manual" }, 3);
  h = recordVisit(h, { url: "https://deno.land/manual", title: "Manual" }, 4);
  h = recordVisit(h, { url: "http://localhost:3000/a", title: "" }, 5);

  assertEquals(bareUrl("https://www.Example.com/x"), "Example.com/x");
  const de = suggest("de", b, h);
  // Prefix matches first (a bookmark before visits), then pages whose words hold it.
  assertEquals(de.map((s) => [s.url, s.kind]), [
    ["https://deno.land/manual", "history"],
    ["https://www.dev.to/", "history"],
    ["https://docs.deno.com/", "bookmark"],
  ]);
  // A bookmarked page comes once, as the bookmark.
  const gh = suggest("git", b, h);
  assertEquals(gh, [{
    url: "https://github.com/",
    title: "GitHub",
    kind: "bookmark",
  }]);
  assertEquals(suggest("local", b, h).map((s) => s.url), [
    "http://localhost:3000/a",
  ]);
  assertEquals(suggest("   ", b, h), []);
  assertEquals(suggest("e", b, h, 2).length, 2);
});

Deno.test("suggestions: a bookmark beats a visit of the same rank; more visits beat fewer", () => {
  let b = emptyBookmarks();
  b = addBookmark(b, { title: "Alpha B", url: "https://alpha-b.example/" })
    .bookmarks;
  let h = NO_VISITS;
  h = recordVisit(h, { url: "https://alpha-a.example/" }, 1);
  h = recordVisit(h, { url: "https://alpha-c.example/" }, 2);
  h = recordVisit(h, { url: "https://alpha-c.example/" }, 3);
  assertEquals(suggest("alpha", b, h).map((s) => s.url), [
    "https://alpha-b.example/",
    "https://alpha-c.example/",
    "https://alpha-a.example/",
  ]);
});

Deno.test("zoom: the browsers' steps, per site, 100% forgotten", () => {
  assertEquals(stepZoom(1, 1), 1.1);
  assertEquals(stepZoom(1, -1), 0.9);
  assertEquals(stepZoom(1.05, 1), 1.1);
  assertEquals(stepZoom(5, 1), 5);
  assertEquals(stepZoom(0.25, -1), 0.25);
  assertEquals(zoomLabel(1.25), "125%");
  let z = setSiteZoom(NO_ZOOM, "https://a.example:8080/x", 1.5);
  assertEquals(z.sites, { "a.example:8080": 1.5 });
  assertEquals(zoomFor(z, "https://A.example:8080/other"), 1.5);
  assertEquals(zoomFor(z, "https://b.example/"), 1);
  assertStrictEquals(setSiteZoom(z, "https://a.example:8080/", 1.5), z);
  z = setSiteZoom(z, "https://a.example:8080/", 1);
  assertEquals(z.sites, {});
  assertStrictEquals(setSiteZoom(z, "not a url", 2), z);
  assertEquals(
    sanitizeZoom({
      sites: {
        "ok.example": 9,
        "bad host!": 2,
        "one.example": 1,
        "n.example": "x",
      },
    }),
    { sites: { "ok.example": 5 } },
  );
  assertEquals(sanitizeZoom(null), NO_ZOOM);
});

Deno.test("history: a tile's copy of the view's list follows its steps", () => {
  let h = startHistory("https://a/");
  h = followUrl(h, "https://b/", 0);
  h = followUrl(h, "https://c/", 0);
  assertEquals(h, {
    entries: ["https://a/", "https://b/", "https://c/"],
    index: 2,
  });
  h = followUrl(h, "https://b/", -1);
  assertEquals(h.index, 1);
  h = followUrl(h, "https://a/", -1);
  assertEquals(h.index, 0);
  // A step that lands on another URL (a redirect) takes the one the view reports.
  h = followUrl(h, "https://b2/", 1);
  assertEquals(h, {
    entries: ["https://a/", "https://b2/", "https://c/"],
    index: 1,
  });
  // A new page drops the forward entries.
  h = followUrl(h, "https://d/", 0);
  assertEquals(h, {
    entries: ["https://a/", "https://b2/", "https://d/"],
    index: 2,
  });
  assertStrictEquals(followUrl(h, "https://d/", 0), h);
});
