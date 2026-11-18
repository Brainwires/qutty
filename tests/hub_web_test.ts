// The companion's web tools at the hub (lib/hub/web-tools.ts, lib/hub/web-tiles.ts): web tiles in
// the registry (ids, names, owners), list_peers and read_screen on them, the permission matrix
// (a tile reads a page, only the companion acts), the routing of each tool to the page's control
// channel, the page's answers checked and formatted (caps, errors), image content for a
// screenshot, and the audit of the acting calls.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildToolRegistry, createHubHandler } from "../lib/hub/tools.ts";
import type {
  ControlCommand,
  ControlResult,
  WebCommand,
} from "../lib/hub/core.ts";
import type { PrivilegedCall } from "../lib/hub/protocol.ts";
import { WebTiles } from "../lib/hub/web-tiles.ts";
import { Registry } from "../lib/hub/registry.ts";
import {
  COMPANION_ID,
  ctxFor,
  hubWithTiles,
  resultText,
  tile,
} from "./hub_helpers.ts";

/** A read the page script would answer. */
const READ = {
  ok: true,
  url: "https://shop.example/",
  title: "Shop",
  text: "# Shop\n\nWelcome [#1 link: Sign in] back.",
  elements: [
    { ref: 1, role: "link", name: "Sign in", href: "https://shop.example/in" },
    { ref: 2, role: "searchbox", name: "Search", value: "" },
  ],
  truncated: false,
  more: 0,
  scroll: { y: 0, height: 3000, viewport: 800 },
};

/** A hub with terminals pty-1..3 and web tiles t5 (web-1) and t6 (web-2) in workspace ws-1. */
function webHub(
  answer: (c: WebCommand) => ControlResult = () => ({ ok: true, value: {} }),
) {
  const { core, env } = hubWithTiles();
  env.controlResult = (c: ControlCommand) =>
    c.kind === "web" ? answer(c) : { ok: true };
  core.setWebTiles("ws-1", [
    { id: "t5", url: "https://shop.example/", title: "Shop" },
    { id: "t6", url: "http://localhost:3000/" },
  ]);
  const calls: PrivilegedCall[] = [];
  const h = createHubHandler(core, buildToolRegistry(core), {
    audit: (c) => calls.push(c),
  });
  const call = (
    name: string,
    args: Record<string, unknown>,
    who = COMPANION_ID,
  ) => h.callTool(name, args, ctxFor(who));
  return { core, env, h, call, calls };
}

Deno.test("web tiles: each owner's page tiles become web-<n> tiles named browser; a report replaces the owner's set", () => {
  const r = new Registry();
  const removed: string[] = [];
  const w = new WebTiles(r, (id) => {
    removed.push(id);
    r.remove(id);
  });
  w.sync("ws-1", [{ id: "t5", url: "https://a.example/", title: "A" }]);
  w.sync("ws-2", [{ id: "t5", url: "https://b.example/" }]);
  assertEquals(
    r.list().map((t) => [t.id, t.name, t.kind, t.url, t.label]),
    [
      ["web-1", "browser", "web", "https://a.example/", "A"],
      ["web-2", "browser-2", "web", "https://b.example/", undefined],
    ],
  );
  assertEquals(w.place("web-2"), { owner: "ws-2", local: "t5" });
  // A new page and title update in place; a tile missing from its owner's report goes.
  w.sync("ws-1", [
    { id: "t5", url: "https://a.example/next", title: "Next" },
    { id: "t9", url: "https://c.example/" },
  ]);
  assertEquals(r.get("web-1")?.url, "https://a.example/next");
  assertEquals(r.get("web-1")?.label, "Next");
  w.sync("ws-1", [{ id: "t9", url: "https://c.example/" }]);
  assertEquals(removed, ["web-1"]);
  assertEquals(r.get("web-2")?.url, "https://b.example/");
  assertEquals(w.place("web-1"), undefined);
});

Deno.test("web tiles: list_peers shows them with kind web and their page; read_screen reads the page", async () => {
  const { call, env } = webHub((c) =>
    c.op.op === "read"
      ? { ok: true, value: { result: READ } }
      : { ok: false, error: "?" }
  );
  const peers = JSON.parse(resultText(await call("list_peers", {})));
  const web = peers.tiles.find((t: { id: string }) => t.id === "web-1");
  assertEquals(web.kind, "web");
  assertEquals(web.url, "https://shop.example/");
  assertEquals(web.label, "Shop");
  assertEquals(web.name, "browser");

  const screen = JSON.parse(
    resultText(await call("read_screen", { tile: "browser" })),
  );
  assertEquals(screen.kind, "web");
  assertEquals(screen.url, "https://shop.example/");
  assertStringIncludes(
    screen.screen,
    '#1 link "Sign in" → https://shop.example/in',
  );
  assertEquals(env.controls.at(-1), {
    kind: "web",
    op: { op: "read", maxChars: 12000 },
    tileId: "t5",
    owner: "ws-1",
  });

  const scroll = await call("read_scrollback", { tile: "web-1" });
  assert(scroll.isError);
  assertStringIncludes(resultText(scroll), "web-1 is a web tile");
});

Deno.test("web tiles: read_screen of a page the window cannot read gives its title, URL and why", async () => {
  const { call } = webHub(() => ({
    ok: false,
    error: "this page can't be read here: the iframe engine (the browser demo)",
  }));
  const r = await call("read_screen", { tile: "browser" });
  assert(!r.isError, "an answer, not an error");
  const screen = JSON.parse(resultText(r));
  assertEquals(
    [screen.kind, screen.url, screen.title, screen.screen],
    ["web", "https://shop.example/", "Shop", ""],
  );
  assertStringIncludes(screen.note, "iframe engine");
});

Deno.test("web tools: a tile's agent may read a page but not act on one (refusals audited)", async () => {
  const { call, env, calls } = webHub(() => ({
    ok: true,
    value: { result: READ },
  }));
  const read = await call("read_page", { tile: "web-1" }, tile("pty-1"));
  assertEquals(read.isError, undefined);
  assertStringIncludes(
    resultText(read),
    "tile web-1 (browser): Shop — https://shop.example/",
  );
  for (
    const [name, args] of [
      ["open_web", {}],
      ["web_navigate", { tile: "web-1", url: "x.example" }],
      ["web_go", { tile: "web-1", action: "back" }],
      ["web_click", { tile: "web-1", ref: 1 }],
      ["web_type", { tile: "web-1", ref: 2, text: "hi" }],
      ["web_scroll", { tile: "web-1", to: "top" }],
      ["web_eval", { tile: "web-1", script: "1" }],
      ["web_screenshot", { tile: "web-1" }],
    ] as const
  ) {
    const r = await call(name, args, tile("pty-1"));
    assert(r.isError, name);
    assertStringIncludes(resultText(r), "companion only");
  }
  // Only the read reached the page; every refusal is in the audit, the read is not.
  assertEquals(env.controls.length, 1);
  assertEquals(calls.length, 8);
  assert(calls.every((c) => c.by === "pty-1" && !c.ok));
});

Deno.test("web tools: each reaches the page as a web command for the tile's page id and owner", async () => {
  const { call, env, calls } = webHub((c) => {
    switch (c.op.op) {
      case "navigate":
      case "go":
        return {
          ok: true,
          value: {
            url: "https://www.google.com/search?q=cheap%20flights",
            title: "cheap flights",
            load: "complete",
            loaded: true,
          },
        };
      case "click":
        return {
          ok: true,
          value: {
            result: {
              ok: true,
              element: { ref: 1, role: "link", name: "Sign in" },
            },
            navigated: true,
            page: { url: "https://shop.example/in", title: "Sign in" },
          },
        };
      case "type":
        return {
          ok: true,
          value: {
            result: {
              ok: true,
              element: { ref: 2, role: "searchbox", name: "Search" },
              value: "socks",
              submitted: "form",
            },
            navigated: false,
            page: { url: "https://shop.example/", title: "Shop" },
          },
        };
      case "scroll":
        return {
          ok: true,
          value: {
            result: {
              ok: true,
              scroll: { y: 800, height: 3000, viewport: 800 },
            },
          },
        };
      default:
        return { ok: true, value: {} };
    }
  });
  const nav = JSON.parse(
    resultText(
      await call("web_navigate", { tile: "web-1", url: "cheap flights" }),
    ),
  );
  assertEquals(nav.loaded, true);
  assertEquals(env.controls.at(-1), {
    kind: "web",
    op: {
      op: "navigate",
      url: "https://www.google.com/search?q=cheap%20flights",
    },
    tileId: "t5",
    owner: "ws-1",
  });
  await call("web_go", { tile: "web-2", action: "reload" });
  assertEquals((env.controls.at(-1) as WebCommand).op, {
    op: "go",
    action: "reload",
  });
  assertEquals((env.controls.at(-1) as WebCommand).tileId, "t6");

  const click = JSON.parse(
    resultText(await call("web_click", { tile: "web-1", text: "Sign in" })),
  );
  assertEquals(click.clicked, { ref: 1, role: "link", name: "Sign in" });
  assertEquals(click.navigated, true);
  assertEquals(click.url, "https://shop.example/in");
  assertEquals((env.controls.at(-1) as WebCommand).op, {
    op: "click",
    target: { text: "Sign in" },
  });

  const typed = JSON.parse(resultText(
    await call("web_type", {
      tile: "web-1",
      ref: 2,
      text: "socks",
      submit: true,
    }),
  ));
  assertEquals(typed.submitted, "form");
  assertEquals(typed.value, "socks");
  assertEquals((env.controls.at(-1) as WebCommand).op, {
    op: "type",
    target: { ref: 2 },
    text: "socks",
    clear: false,
    submit: true,
  });

  const scrolled = JSON.parse(
    resultText(await call("web_scroll", { tile: "web-1", by: 800 })),
  );
  assertEquals(scrolled.y, 800);

  // Every acting call is in the audit, by the companion.
  assertEquals(calls.map((c) => c.tool), [
    "web_navigate",
    "web_go",
    "web_click",
    "web_type",
    "web_scroll",
  ]);
  assert(calls.every((c) => c.by === "companion" && c.ok));
});

Deno.test("web tools: clear errors for a terminal, bad arguments, and what the page refused", async () => {
  const { call, env } = webHub((c) =>
    c.op.op === "click"
      ? {
        ok: true,
        value: {
          result: {
            ok: false,
            error:
              "no element #9 (numbers come from the last read_page; read the page again)",
          },
        },
      }
      : {
        ok: false,
        error:
          "this page can't be read here: the iframe engine (the browser demo) shows only local pages",
      }
  );
  const expectError = async (
    name: string,
    args: Record<string, unknown>,
    text: string,
  ) => {
    const r = await call(name, args);
    assert(r.isError, `${name} should fail`);
    assertStringIncludes(resultText(r), text);
  };
  await expectError(
    "read_page",
    { tile: "pty-3" },
    "tile pty-3 (shell-3) is a terminal, not a web tile",
  );
  await expectError(
    "web_click",
    { tile: "nobody", ref: 1 },
    'no tile is called "nobody"',
  );
  await expectError(
    "web_click",
    { tile: "web-1", ref: 1, text: "x" },
    "give exactly one of ref, selector or text",
  );
  await expectError(
    "web_type",
    { tile: "web-1", text: "x" },
    "give exactly one of ref or selector",
  );
  await expectError("web_scroll", { tile: "web-1" }, "give to, ref or by");
  await expectError(
    "web_go",
    { tile: "web-1", action: "up" },
    '"action" is back, forward or reload',
  );
  await expectError(
    "web_navigate",
    { tile: "web-1", url: "   " },
    "is not an address or a search",
  );
  await expectError("read_page", { tile: "web-1" }, "iframe engine");
  await expectError("web_click", { tile: "web-1", ref: 9 }, "no element #9");
  await expectError(
    "write_tile",
    { tile: "web-1", text: "ls", enter: true },
    "web-1 is a web tile, not a terminal",
  );
  await expectError(
    "send_message",
    { to: "web-1", text: "hi" },
    "web-1 is a web tile: it has no agent",
  );
  // The checks before the page: only the two page answers reached it.
  assertEquals(env.controls.length, 2);
});

Deno.test("web tools: a broadcast skips web tiles; close_tile and focus_tile on one go to its page", async () => {
  const { core, call, env } = webHub();
  const sent = core.send(tile("pty-1"), "all", "hello");
  assertEquals(sent.map((m) => m.to), ["pty-2", "pty-3"]);
  await call("focus_tile", { tile: "web-2" });
  await call("close_tile", { tile: "browser" });
  assertEquals(env.controls, [
    { kind: "web", op: { op: "focus" }, tileId: "t6", owner: "ws-1" },
    { kind: "web", op: { op: "close" }, tileId: "t5", owner: "ws-1" },
  ]);
});

Deno.test("open_web: words become a search; the new tile joins the registry at once (in the answering window)", async () => {
  const { call, env, core } = webHub((c) =>
    c.op.op === "open"
      ? {
        ok: true,
        owner: "ws-2",
        value: {
          tile: "t2",
          url: (c.op as { url?: string }).url ?? "https://home.example/",
          title: "Results",
        },
      }
      : { ok: true }
  );
  const opened = JSON.parse(
    resultText(await call("open_web", { url: "deno web views" })),
  );
  assertEquals(opened.tile, "web-3");
  assertEquals(opened.name, "browser-3");
  assertEquals(opened.title, "Results");
  assertEquals(env.controls.at(-1), {
    kind: "web",
    op: {
      op: "open",
      url: "https://www.google.com/search?q=deno%20web%20views",
    },
  });
  assertEquals(core.webTiles.place("web-3"), { owner: "ws-2", local: "t2" });

  // No URL: the page picks its home page. Beside a web tile: in that tile's window.
  await call("open_web", { beside: "web-1" });
  assertEquals(env.controls.at(-1), {
    kind: "web",
    op: { op: "open", beside: "t5" },
    owner: "ws-1",
  });
  // Beside a terminal: its PTY id (the page finds it).
  await call("open_web", { url: "example.com", beside: "pty-2" });
  assertEquals((env.controls.at(-1) as WebCommand).op, {
    op: "open",
    url: "https://example.com/",
    beside: "pty-2",
  });
});

Deno.test("read_page: the page's answer is checked and capped; a selector and maxChars are passed on", async () => {
  const long = "x".repeat(5000);
  const { call, env } = webHub(() => ({
    ok: true,
    value: {
      result: {
        ...READ,
        text: long,
        elements: [...READ.elements, { ref: 0, role: "bad" }, "junk"],
        more: 4,
      },
    },
  }));
  const text = resultText(
    await call("read_page", {
      tile: "web-1",
      maxChars: 1000,
      selector: "main",
    }),
  );
  assertEquals((env.controls.at(-1) as WebCommand).op, {
    op: "read",
    maxChars: 1000,
    selector: "main",
  });
  assert(text.includes("x".repeat(1000)) && !text.includes("x".repeat(1001)));
  assertStringIncludes(text, "… (cut: pass maxChars for more");
  assertStringIncludes(text, '#2 searchbox "Search"');
  assertStringIncludes(text, "(+4 more not numbered");
  assert(!text.includes("bad"));
  assertStringIncludes(text, "(scrolled to 0 of 3000px; 800px visible)");
  const bad = await call("read_page", { tile: "web-1", maxChars: 10 });
  assert(bad.isError);
});

Deno.test("web_screenshot is image content; web_eval returns the script's JSON (cut when long)", async () => {
  const { h } = webHub((c) =>
    c.op.op === "screenshot"
      ? { ok: true, value: { mimeType: "image/jpeg", data: "AAAA" } }
      : c.op.op === "eval" && c.op.script === "big"
      ? { ok: true, value: { json: '["abc', truncated: true } }
      : { ok: true, value: { json: '{"n":2}', truncated: false } }
  );
  const shot = await h.callTool(
    "web_screenshot",
    { tile: "web-1" },
    ctxFor(COMPANION_ID),
  );
  assertEquals(shot.content[1], {
    type: "image",
    data: "AAAA",
    mimeType: "image/jpeg",
  });
  assertStringIncludes(resultText(shot), "tile web-1 (browser)");
  const small = JSON.parse(resultText(
    await h.callTool(
      "web_eval",
      { tile: "web-1", script: "({n: 2})" },
      ctxFor(COMPANION_ID),
    ),
  ));
  assertEquals(small.result, { n: 2 });
  const big = JSON.parse(resultText(
    await h.callTool(
      "web_eval",
      { tile: "web-1", script: "big" },
      ctxFor(COMPANION_ID),
    ),
  ));
  assertEquals(big, { tile: "web-1", result: '["abc', truncated: true });
});
