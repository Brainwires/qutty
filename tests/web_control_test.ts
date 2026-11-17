// The page's half of the companion's web tools (lib/web/web-control.ts) over fake views and
// engines: what each engine can do (the iframe navigates, the native view reads, acts and
// pictures), waiting for loads by their events, a click's navigation, the caps, open_web's home
// page and a page the engine cannot show, and the errors. Plus the page scripts' parsers and
// formatting (lib/web/page-script.ts); the scripts themselves run in Chromium in
// tests/e2e/companion_web_test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  FALLBACK_HOME,
  IFRAME_CANNOT_READ,
  MAX_EVAL_JSON,
  runWebCommand,
  type WebControlDeps,
} from "../lib/web/web-control.ts";
import type {
  WebEngine,
  WebViewEventMap,
  WebViewHandle,
  WebViewState,
} from "../lib/web/engine.ts";
import type { ControlResult, WebOp } from "../lib/hub/core.ts";
import {
  formatPageRead,
  pageError,
  pageScript,
  parsePageAction,
  parsePageRead,
} from "../lib/web/page-script.ts";

type Listener = (ev: never) => void;

/** A view whose page "loads" when the test says so. */
class FakeView {
  state: WebViewState = {
    url: "http://localhost:3000/a",
    title: "",
    load: "complete",
    canGoBack: false,
    canGoForward: false,
  };
  listeners = new Map<string, Set<Listener>>();
  calls: string[] = [];
  /** What `evaluate` answers (a function of the script). */
  answer: (script: string) => unknown = () => ({ ok: true });
  /** Navigations finish at once with this load state (`null`: never). */
  finish: "complete" | "failed" | null = "complete";

  emit<K extends keyof WebViewEventMap>(k: K, ev: WebViewEventMap[K]) {
    for (const fn of [...(this.listeners.get(k) ?? [])]) {
      (fn as (e: WebViewEventMap[K]) => void)(ev);
    }
  }
  #go(url: string) {
    this.state = { ...this.state, url, load: "loading" };
    this.emit("load", { state: "loading", url });
    const finish = this.finish;
    if (finish) {
      queueMicrotask(() => {
        this.state = { ...this.state, load: finish };
        this.emit("load", { state: finish, url });
      });
    }
  }
  handle(withEval: boolean): WebViewHandle {
    const view: WebViewHandle = {
      navigate: (url) => {
        this.calls.push(`navigate ${url}`);
        this.#go(url);
        return Promise.resolve();
      },
      back: () => {
        this.calls.push("back");
        this.#go("http://localhost:3000/back");
        return Promise.resolve();
      },
      forward: () => Promise.resolve(),
      reload: () => {
        this.calls.push("reload");
        this.#go(this.state.url);
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
      setVisible: () => Promise.resolve(),
      setOccluded: () => Promise.resolve(),
      setZOrder: () => Promise.resolve(),
      relayout: () => {},
      focus: () => Promise.resolve(),
      blur: () => Promise.resolve(),
      insertText: () => Promise.resolve(false),
      state: () => Promise.resolve({ ...this.state }),
      on: (event, fn) => {
        const set = this.listeners.get(event) ?? new Set();
        this.listeners.set(event, set);
        set.add(fn as Listener);
        return () => void set.delete(fn as Listener);
      },
      close: () => Promise.resolve(),
    };
    if (withEval) {
      view.evaluate = (script) => {
        this.calls.push("evaluate");
        return Promise.resolve(this.answer(script));
      };
      view.capture = () =>
        Promise.resolve(
          new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
        );
    }
    return view;
  }
}

const engine = (kind: "iframe" | "native"): WebEngine => ({
  capabilities: {
    engine: kind,
    drawsAboveHtml: kind === "native",
    readsPage: kind === "native",
    capture: kind === "native",
    evaluate: kind === "native",
    forwardKeys: false,
  },
  canEmbed: (url) => kind === "native" || new URL(url).hostname === "localhost",
  mount: () => Promise.reject(new Error("not here")),
});

/** A window with web tile t1 (its view `view`) on engine `kind`. */
function setup(kind: "iframe" | "native") {
  const fake = new FakeView();
  const view = fake.handle(kind === "native");
  const opened: { url: string; beside?: string }[] = [];
  const closed: string[] = [];
  const views = new Map<string, WebViewHandle>([["t1", view]]);
  const deps: WebControlDeps = {
    engine: () => engine(kind),
    isWebTile: (id) => views.has(id) || id === "t2",
    view: (id) => Promise.resolve(views.get(id)),
    page: () => ({ url: "http://localhost:3000/a", title: "Page A" }),
    home: () => undefined,
    open: (url, beside) => {
      opened.push({ url, ...(beside ? { beside } : {}) });
      return "t9";
    },
    close: (id) => closed.push(id),
    focus: () => {},
  };
  const run = (op: WebOp, tileId = "t1") =>
    runWebCommand({ kind: "web", op, tileId }, deps);
  return { fake, view, views, deps, run, opened, closed };
}

const value = (r: ControlResult) => {
  if (!r.ok) throw new Error(`failed: ${r.error}`);
  return r.value as Record<string, unknown>;
};
const error = (r: ControlResult) => (r.ok ? "" : r.error);

Deno.test("web control, iframe: navigates and waits for the load; cannot read, act or picture the page", async () => {
  const { run, fake } = setup("iframe");
  const nav = value(await run({ op: "navigate", url: "localhost:3000/b" }));
  assertEquals(nav, {
    url: "http://localhost:3000/b",
    title: "",
    load: "complete",
    loaded: true,
  });
  assertEquals(fake.calls, ["navigate http://localhost:3000/b"]);
  assertStringIncludes(
    error(await run({ op: "navigate", url: "https://example.com" })),
    "the iframe engine (the browser demo) shows only local pages",
  );
  for (
    const op of [
      { op: "read", maxChars: 1000 },
      { op: "click", target: { ref: 1 } },
      { op: "eval", script: "1" },
    ] as WebOp[]
  ) {
    assertEquals(error(await run(op)), IFRAME_CANNOT_READ);
  }
  assertStringIncludes(
    error(await run({ op: "screenshot" })),
    "cannot picture a page",
  );
  assertEquals(
    error(await run({ op: "go", action: "back" })),
    "there is no page to go back to",
  );
});

Deno.test("web control: a tile not in this window, an engine not ready, a view that never mounts", async () => {
  const { run, deps } = setup("native");
  assertEquals(
    error(await run({ op: "read", maxChars: 1000 }, "t7")),
    "that web tile is not in this window",
  );
  // t2 is a web tile whose view never mounts (the wait is bounded by the view lookup's signal).
  deps.view = (_id, signal) =>
    new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve(undefined))
    );
  const t0 = Date.now();
  assertStringIncludes(
    error(await run({ op: "read", maxChars: 1000 }, "t2")),
    "the tile's page is not showing",
  );
  assert(Date.now() - t0 < 10_000);
  deps.engine = () => null;
  assertStringIncludes(
    error(await run({ op: "read", maxChars: 1000 })),
    "web engine is not ready",
  );
});

Deno.test("web control, native: read runs the page script once the page has loaded; eval is capped; a refusal is explained", async () => {
  const { run, fake } = setup("native");
  fake.state.load = "loading";
  let script = "";
  fake.answer = (s) => {
    script = s;
    return { ok: true, url: "u", title: "t", text: "hi", elements: [] };
  };
  const read = run({ op: "read", maxChars: 2000, selector: "main" });
  queueMicrotask(() => {
    fake.state.load = "complete";
    fake.emit("load", { state: "complete", url: "u" });
  });
  assertEquals(value(await read).result, {
    ok: true,
    url: "u",
    title: "t",
    text: "hi",
    elements: [],
  });
  assertStringIncludes(script, '"op":"read","maxChars":2000,"selector":"main"');

  fake.answer = () => ({ big: "y".repeat(MAX_EVAL_JSON) });
  const ev = value(await run({ op: "eval", script: "x" }));
  assertEquals((ev.json as string).length, MAX_EVAL_JSON);
  assertEquals(ev.truncated, true);
  fake.answer = () => undefined;
  assertEquals(value(await run({ op: "eval", script: "void 0" })), {
    json: "null",
    truncated: false,
  });

  fake.answer = () => {
    throw new Error("EvalError: refused by CSP");
  };
  assertStringIncludes(
    error(await run({ op: "eval", script: "1" })),
    "Content-Security-Policy",
  );
});

Deno.test("web control, native: a click that navigates waits for the new page; one that does not returns", async () => {
  const { run, fake, view } = setup("native");
  fake.answer = () => {
    // The page's link: it navigates.
    void view.navigate("https://shop.example/in");
    return { ok: true, element: { ref: 1, role: "link", name: "In" } };
  };
  const clicked = value(await run({ op: "click", target: { ref: 1 } }));
  assertEquals(clicked.navigated, true);
  assertEquals(clicked.page, {
    url: "https://shop.example/in",
    title: "",
    load: "complete",
  });

  fake.answer = () => ({ ok: false, error: 'nothing clickable says "Zz"' });
  const t0 = Date.now();
  const missed = value(await run({ op: "click", target: { text: "Zz" } }));
  assertEquals(missed.navigated, false);
  // A failed click does not wait for a navigation.
  assert(Date.now() - t0 < 1000);
  assertEquals(
    (missed.result as { error: string }).error,
    'nothing clickable says "Zz"',
  );

  // A scroll never waits; a type without submit neither.
  fake.answer = () => ({ ok: true, scroll: { y: 1, height: 2, viewport: 1 } });
  assertEquals(
    value(await run({ op: "scroll", to: "bottom" })).navigated,
    false,
  );
});

Deno.test("web control: navigate words search; reload waits; a screenshot is base64 JPEG; close and focus", async () => {
  const { run, fake, closed } = setup("native");
  const nav = value(await run({ op: "navigate", url: "deno web view" }));
  assertEquals(nav.url, "https://www.google.com/search?q=deno%20web%20view");
  fake.finish = "failed";
  assertEquals(value(await run({ op: "go", action: "reload" })).load, "failed");
  const shot = value(await run({ op: "screenshot" }));
  assertEquals(shot, { mimeType: "image/jpeg", data: "AQID" });
  assertEquals(value(await run({ op: "close" })), {});
  assertEquals(closed, ["t1"]);
});

Deno.test("open_web: the home page, else the fallback; beside a tile; a page the engine cannot show still opens a tile", async () => {
  const { deps, views, opened, fake } = setup("iframe");
  const open = (op: { url?: string; beside?: string }) =>
    runWebCommand({ kind: "web", op: { op: "open", ...op } }, deps);
  // The iframe cannot show Google: the tile opens with its card, and the answer says so.
  const fallback = value(await open({}));
  assertEquals(fallback.tile, "t9");
  assertEquals(fallback.url, FALLBACK_HOME);
  assertStringIncludes(String(fallback.note), "shows only local pages");
  deps.home = () => "http://localhost:3000/home";
  views.set("t9", fake.handle(false));
  fake.state = { ...fake.state, url: "http://localhost:3000/home" };
  const home = value(await open({ beside: "pty-2" }));
  assertEquals(home, {
    tile: "t9",
    url: "http://localhost:3000/home",
    title: "",
    load: "complete",
  });
  assertEquals(opened, [{ url: FALLBACK_HOME }, {
    url: "http://localhost:3000/home",
    beside: "pty-2",
  }]);
  deps.open = () => null;
  assertStringIncludes(
    error(await open({ beside: "pty-8" })),
    "could not open a web tile beside pty-8",
  );
});

Deno.test("page scripts: one self-contained script per request; their answers checked and formatted", () => {
  for (
    const req of [
      { op: "read", maxChars: 100 },
      { op: "click", target: { text: "Go" } },
      {
        op: "type",
        target: { ref: 2 },
        text: 'a"b',
        clear: true,
        submit: true,
      },
      { op: "scroll", to: "top" },
    ] as const
  ) {
    // It parses as a script (it runs in the page, not here).
    new Function(`return ${pageScript(req)}`);
  }
  assertEquals(pageError({ ok: true }), undefined);
  assertEquals(pageError({ ok: false, error: "no" }), "no");
  assertEquals(pageError(null), "the page gave no answer");
  const read = parsePageRead({
    ok: true,
    url: "https://a.example/",
    title: "A",
    text: "Hello [#1 link: Next]",
    elements: [
      { ref: 1, role: "link", name: "Next", href: "https://a.example/n" },
      {
        ref: 2,
        role: "checkbox",
        name: "Agree",
        checked: false,
        disabled: true,
      },
      { ref: 3, role: "textbox", name: "Name", value: "Ann" },
    ],
    truncated: false,
    more: 0,
  }, 100);
  assertEquals(
    formatPageRead(read),
    [
      "A — https://a.example/",
      "",
      "Hello [#1 link: Next]",
      "",
      "Interactive elements (act on them by number: web_click, web_type):",
      '#1 link "Next" → https://a.example/n',
      '#2 checkbox "Agree" (unchecked) (disabled)',
      '#3 textbox "Name" = "Ann"',
    ].join("\n"),
  );
  assertEquals(
    parsePageAction({
      ok: true,
      element: { ref: 4, role: "button", name: "Go" },
      submitted: "sideways",
      value: "v",
    }),
    { element: { ref: 4, role: "button", name: "Go" }, value: "v" },
  );
});
