// Web tiles without a DOM: which URLs the iframe engine embeds (and the CSP that must allow them),
// the address field, the tile-kept back/forward list, the HTML overlay count, the store's web tile
// (a tile with no PTY) and its snapshot round-trip through a restore.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  addressToUrl,
  canEmbedInFrame,
  FRAME_SRC,
  hostLabel,
  isDevHost,
  sanitizeWebPage,
} from "../lib/web/url.ts";
import {
  canGoBack,
  canGoForward,
  currentUrl,
  goBack,
  goForward,
  MAX_HISTORY,
  pushUrl,
  startHistory,
} from "../lib/web/history.ts";
import { onOverlays, openOverlay, openOverlays } from "../lib/web/overlays.ts";
import { FRAME_SANDBOX, IframeEngine } from "../lib/web/engine.ts";
import { initialState, reduce } from "../lib/workspace/store.ts";
import { planRestore, snapshotOf } from "../lib/workspace/session.ts";
import { csp } from "../app/page.tsx";

Deno.test("web: canEmbed takes http(s) on loopback and dev hosts only", () => {
  for (
    const url of [
      "http://localhost:3000/",
      "http://localhost/",
      "https://localhost:8443/app?x=1#y",
      "http://127.0.0.1:5173/",
      "https://app.localhost:8080/",
      "https://shop.test/",
      "https://a.b.test:9000/x",
      "HTTP://LOCALHOST:3000/",
    ]
  ) assert(canEmbedInFrame(url), url);
  for (
    const url of [
      "https://deno.com/",
      "https://github.com/Brainwires/qutty",
      "http://localhost.evil.com/",
      "http://127.0.0.2/",
      "http://10.0.0.1:3000/",
      "http://[::1]:3000/", // no CSP host-source for an IPv6 literal (lib/web/url.ts)
      "http://test/",
      "http://.localhost/",
      // mixed content in the secure app page (lib/web/url.ts): https only off loopback
      "http://app.localhost:8080/",
      "http://a.b.test:9000/x",
      "file:///Users/me/index.html",
      "ftp://localhost/",
      "javascript:alert(1)",
      "http://user:pw@localhost:3000/",
      "not a url",
      "",
    ]
  ) assert(!canEmbedInFrame(url), url);
});

Deno.test("web: canEmbed never takes the app's own origin", () => {
  assert(canEmbedInFrame("http://127.0.0.1:4000/x"));
  assert(!canEmbedInFrame("http://127.0.0.1:4000/x", "http://127.0.0.1:4000"));
  assert(canEmbedInFrame("http://127.0.0.1:4001/", "http://127.0.0.1:4000"));
  // Denext's own runtime serves the app at a custom scheme: nothing here can match it.
  assert(canEmbedInFrame("http://localhost:3000/", "app://localhost"));
  // The engine reads the page's origin itself (none under Deno: everything dev-host passes).
  assert(IframeEngine.canEmbed("http://localhost:3000/"));
  assert(!IframeEngine.canEmbed("https://deno.com/"));
});

Deno.test("web: the page's CSP frame-src covers exactly what canEmbed takes", () => {
  assertEquals(csp.frameSrc, [...FRAME_SRC]);
  /** Whether a CSP host-source `src` (with `:*`) matches `url`, as a browser checks it. */
  const matches = (src: string, raw: string) => {
    const m = /^(https?):\/\/(\*\.)?([^:/]+):\*$/.exec(src)!;
    const url = new URL(raw);
    if (url.protocol !== `${m[1]}:`) return false;
    return m[2] ? url.hostname.endsWith(`.${m[3]}`) : url.hostname === m[3];
  };
  for (
    const url of [
      "http://localhost:3000/",
      "https://localhost/",
      "http://127.0.0.1:1/",
      "https://127.0.0.1:2/",
      "https://x.localhost:3/",
      "https://x.test:4/",
      "https://y.x.test/",
    ]
  ) {
    assert(canEmbedInFrame(url), url);
    assert(FRAME_SRC.some((src) => matches(src, url)), `CSP allows ${url}`);
  }
  assert(!FRAME_SRC.some((src) => src.includes("[")), "no IPv6 source");
  assertEquals(
    FRAME_SANDBOX,
    "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads",
  );
});

Deno.test("web: dev hosts", () => {
  assert(isDevHost("localhost"));
  assert(isDevHost("LocalHost."));
  assert(isDevHost("a.localhost"));
  assert(isDevHost("site.test"));
  assert(!isDevHost("localhost.com"));
  assert(!isDevHost("test"));
  assert(!isDevHost("contest"));
  assert(!isDevHost("[::1]"));
});

Deno.test("web: the address field's text becomes a URL", () => {
  assertEquals(addressToUrl("http://localhost:3000"), "http://localhost:3000/");
  assertEquals(
    addressToUrl("  localhost:3000/a?b  "),
    "http://localhost:3000/a?b",
  );
  assertEquals(addressToUrl("127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assertEquals(addressToUrl("shop.test"), "http://shop.test/");
  assertEquals(addressToUrl("deno.com/manual"), "https://deno.com/manual");
  assertEquals(addressToUrl("https://deno.com"), "https://deno.com/");
  assertEquals(addressToUrl("javascript://alert(1)"), null);
  assertEquals(addressToUrl("file:///etc/passwd"), null);
  assertEquals(addressToUrl("file://localhost/etc/passwd"), null);
  assertEquals(addressToUrl("two words"), null);
  assertEquals(addressToUrl("word"), null);
  assertEquals(addressToUrl(""), null);
});

Deno.test("web: header label and stored pages", () => {
  assertEquals(hostLabel("http://localhost:3000/a"), "localhost:3000");
  assertEquals(hostLabel("https://shop.test/"), "shop.test");
  assertEquals(sanitizeWebPage({ url: "http://localhost:1/" }), {
    url: "http://localhost:1/",
  });
  assertEquals(
    sanitizeWebPage({ url: "http://localhost:1/", title: " Hi\nthere " }),
    { url: "http://localhost:1/", title: "Hi there" },
  );
  assertEquals(sanitizeWebPage({ url: "file:///x" }), undefined);
  assertEquals(sanitizeWebPage({ url: 3 }), undefined);
  assertEquals(sanitizeWebPage(null), undefined);
});

Deno.test("web: the tile keeps its own back/forward list", () => {
  let h = startHistory("a");
  assertEquals([currentUrl(h), canGoBack(h), canGoForward(h)], [
    "a",
    false,
    false,
  ]);
  assertStrictEquals(goBack(h), h);
  assertStrictEquals(goForward(h), h);
  h = pushUrl(h, "b");
  h = pushUrl(h, "c");
  assertEquals(h.entries, ["a", "b", "c"]);
  assertStrictEquals(pushUrl(h, "c"), h, "the same URL again adds nothing");
  h = goBack(goBack(h));
  assertEquals([currentUrl(h), canGoBack(h), canGoForward(h)], [
    "a",
    false,
    true,
  ]);
  h = goForward(h);
  assertEquals(currentUrl(h), "b");
  // A navigation from the middle drops the forward entries, as a browser does.
  h = pushUrl(h, "d");
  assertEquals(h.entries, ["a", "b", "d"]);
  assertEquals(canGoForward(h), false);
  // It is bounded: the oldest entries go.
  for (let i = 0; i < MAX_HISTORY + 10; i++) h = pushUrl(h, `u${i}`);
  assertEquals(h.entries.length, MAX_HISTORY);
  assertEquals(currentUrl(h), `u${MAX_HISTORY + 9}`);
  assertEquals(h.index, MAX_HISTORY - 1);
});

Deno.test("web: open HTML overlays are counted (a native view hides meanwhile)", () => {
  const seen: number[] = [];
  const off = onOverlays((n) => seen.push(n));
  const closeMenu = openOverlay();
  const closeDialog = openOverlay();
  closeMenu();
  closeMenu(); // once only
  assertEquals(openOverlays(), 1);
  closeDialog();
  off();
  openOverlay()();
  assertEquals(seen, [0, 1, 2, 1, 0]);
  assertEquals(openOverlays(), 0);
});

Deno.test("store: a web tile is a tile (layout, focus, MRU, close) with its page", () => {
  let s = initialState();
  s = reduce(s, { type: "add", id: "t1", now: 1 });
  s = reduce(s, {
    type: "add",
    id: "t2",
    now: 2,
    web: { url: "http://localhost:3000/" },
  });
  assertEquals(s.focusedId, "t2");
  assertEquals(s.mru, ["t2", "t1"]);
  const web = s.terminals[1];
  assertEquals(web.web, { url: "http://localhost:3000/" });
  assertEquals(web.title, "localhost:3000", "the host until a title is known");
  // A process title (the terminal poll) never renames it; its page does.
  assertStrictEquals(reduce(s, { type: "title", id: "t2", title: "zsh" }), s);
  s = reduce(s, {
    type: "webPage",
    id: "t2",
    page: { url: "http://localhost:3000/docs", title: "Docs" },
  });
  assertEquals(s.terminals[1].web, {
    url: "http://localhost:3000/docs",
    title: "Docs",
  });
  assertEquals(s.terminals[1].title, "Docs");
  assertStrictEquals(
    reduce(s, {
      type: "webPage",
      id: "t2",
      page: { url: "http://localhost:3000/docs", title: "Docs" },
    }),
    s,
  );
  // Not a web tile, or not a web page: nothing.
  assertStrictEquals(
    reduce(s, {
      type: "webPage",
      id: "t1",
      page: { url: "http://localhost/" },
    }),
    s,
  );
  assertStrictEquals(
    reduce(s, { type: "webPage", id: "t2", page: { url: "file:///x" } }),
    s,
  );
  s = reduce(s, { type: "focus", id: "t1", now: 3 });
  assertEquals(s.mru, ["t1", "t2"]);
  s = reduce(s, { type: "remove", id: "t2" });
  assertEquals(s.terminals.map((t) => t.id), ["t1"]);
  // A page that is not http(s) never makes a web tile.
  s = reduce(s, { type: "add", id: "t3", now: 4, web: { url: "file:///x" } });
  assertEquals(s.terminals[1].web, undefined);
});

Deno.test("session: a web tile saves its page and comes back at it, with no PTY", () => {
  let s = initialState();
  s = reduce(s, { type: "add", id: "t1", now: 1 });
  s = reduce(s, {
    type: "add",
    id: "t2",
    now: 2,
    web: { url: "http://localhost:3000/" },
  });
  s = reduce(s, {
    type: "webPage",
    id: "t2",
    page: { url: "http://app.localhost:5173/x", title: "App" },
  });
  s = reduce(s, { type: "focus", id: "t1", now: 3 });
  const asked: string[] = [];
  const snap = snapshotOf(s, 2, (id) => {
    asked.push(id);
    return { ptyId: "pty-1", profile: { kind: "shell" } };
  });
  assertEquals(
    asked,
    ["t1"],
    "the terminal manager is asked about terminals only",
  );
  assertEquals(snap.tiles.t2, {
    web: { url: "http://app.localhost:5173/x", title: "App" },
  });
  const json = JSON.parse(JSON.stringify(snap));

  const plan = planRestore(json, [{
    id: "pty-1",
    cols: 80,
    rows: 24,
    data: "",
    seq: 0,
    truncated: false,
  }])!;
  assertEquals(plan.mru, ["t1", "t2"]);
  assertEquals(plan.tiles, [
    {
      id: "t1",
      profile: { kind: "shell" },
      pty: {
        id: "pty-1",
        cols: 80,
        rows: 24,
        data: "",
        seq: 0,
        truncated: false,
      },
    },
    { id: "t2", web: { url: "http://app.localhost:5173/x", title: "App" } },
  ]);
  const restored = plan.terminals.find((t) => t.id === "t2")!;
  assertEquals(restored.web, {
    url: "http://app.localhost:5173/x",
    title: "App",
  });
  assertEquals([restored.title, restored.exited], ["App", false]);
  // Through the store, as the page restores it.
  const back = reduce(initialState(), {
    type: "restore",
    terminals: plan.terminals,
    mru: plan.mru,
    previousPattern: null,
  });
  assertEquals(back.terminals.map((t) => [t.id, t.web?.url]), [
    ["t1", undefined],
    ["t2", "http://app.localhost:5173/x"],
  ]);

  // A snapshot with only web tiles still restores (no PTY is needed), and a junk page is dropped.
  const webOnly = {
    ...json,
    terminals: json.terminals.filter((t: { id: string }) => t.id === "t2"),
    tiles: { t2: json.tiles.t2, t9: { web: { url: "javascript:x" } } },
  };
  const plan2 = planRestore(webOnly, [])!;
  assertEquals(plan2.tiles, [
    { id: "t2", web: { url: "http://app.localhost:5173/x", title: "App" } },
  ]);
  // A terminal entry never comes back carrying a page.
  const forged = {
    ...json,
    terminals: json.terminals.map((t: { id: string }) =>
      t.id === "t1" ? { ...t, web: { url: "http://localhost:1/" } } : t
    ),
  };
  assertEquals(
    planRestore(forged, [])!.terminals.find((t) => t.id === "t1")!.web,
    undefined,
  );
});
