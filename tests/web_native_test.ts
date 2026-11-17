// The native web tile engine (lib/web/native-engine.ts) against a fake of Denext's web views:
// which engine is picked, what a view is created with, its events, the snapshot swap and its
// order, the keyboard handed back and forth, the forward keys, and dictation's script run over
// fake documents. Also the area overlays (lib/web/overlays.ts) and a late dictation outcome.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  detectWebEngine,
  IframeEngine,
  resetWebEngineForTesting,
  webEngine,
  type WebViewHandle,
} from "../lib/web/engine.ts";
import {
  type AttachedView,
  canEmbedNatively,
  createNativeEngine,
  insertTextScript,
  MAX_FORWARD_KEYS,
  type NativeCapabilities,
  type NativeWebViews,
  type RawWebView,
  WEB_PARTITION,
} from "../lib/web/native-engine.ts";
import {
  areaOverlays,
  coveredByArea,
  keepoutInsets,
  onAreaOverlays,
  setAreaOverlays,
} from "../lib/web/overlays.ts";
import { forwardAccelerators } from "../lib/workspace/keys.ts";
import {
  DICTATE_MISS,
  type DictateOutcome,
  type SttEngine,
  VoiceController,
} from "../lib/voice/controller.ts";
import { fakeField } from "./web_helpers.ts";

const ALL: NativeCapabilities = {
  supported: true,
  capture: true,
  evaluate: true,
  zOrder: true,
  forwardKeys: true,
};

type Handler = (e: unknown) => void;

/** A fake of Denext's web views: every call is logged, in order. */
function fakeViews(caps: NativeCapabilities = ALL) {
  const log: string[] = [];
  const created: Record<string, unknown>[] = [];
  const raws: {
    fire(event: string, detail?: unknown): void;
    evaluate: (script: string) => Promise<unknown>;
    capture: () => Promise<Blob>;
  }[] = [];
  const attached: { view: AttachedView; detached: boolean }[] = [];
  const frames: (() => void)[] = [];
  const windowActive: ((active: boolean) => void)[] = [];
  const views: NativeWebViews = {
    onWindowActive: (fn) => {
      windowActive.push(fn);
      fn(true);
      return () => {};
    },
    capabilities: () => Promise.resolve(caps),
    create: (options) => {
      created.push({ ...options });
      const handlers = new Map<string, Set<Handler>>();
      const act = (name: string) => (...args: unknown[]) => {
        log.push(args.length ? `${name} ${JSON.stringify(args[0])}` : name);
        return Promise.resolve();
      };
      const fake = {
        fire(event: string, detail: unknown = {}) {
          for (const fn of [...(handlers.get(event) ?? [])]) fn(detail);
        },
        evaluate: (_script: string): Promise<unknown> => Promise.resolve(true),
        capture: () => Promise.resolve(new Blob(["jpeg"])),
      };
      raws.push(fake);
      const raw = {
        setBounds: act("setBounds"),
        setVisible: act("setVisible"),
        navigate: act("navigate"),
        back: act("back"),
        forward: act("forward"),
        reload: act("reload"),
        stop: act("stop"),
        focus: act("focus"),
        blur: act("blur"),
        setZOrder: act("setZOrder"),
        setForwardKeys: act("setForwardKeys"),
        setZoom: act("setZoom"),
        getZoom: () => Promise.resolve(1.25),
        find: (text: string, opts?: unknown) => {
          log.push(`find ${JSON.stringify([text, opts ?? null])}`);
          return Promise.resolve();
        },
        stopFind: act("stopFind"),
        print: act("print"),
        openDevTools: act("openDevTools"),
        state: () =>
          Promise.resolve({
            url: "https://example.com/",
            title: "Example",
            load: "complete",
            canGoBack: true,
            canGoForward: false,
            zOrder: 3,
          }),
        capture: (opts: unknown) => {
          log.push(`capture ${JSON.stringify(opts)}`);
          return fake.capture();
        },
        evaluate: (script: string) => {
          log.push("evaluate");
          return fake.evaluate(script);
        },
        on: (event: string, fn: Handler) => {
          let set = handlers.get(event);
          if (!set) handlers.set(event, set = new Set());
          set.add(fn);
          return () => void set.delete(fn);
        },
        close: () => {
          log.push("close");
          fake.fire("closed");
          return Promise.resolve();
        },
      };
      return Promise.resolve(raw as unknown as RawWebView);
    },
    attach: (view) => {
      const a = { view, detached: false };
      attached.push(a);
      log.push("attach");
      return {
        detach: () => {
          a.detached = true;
        },
        relayout: () => void log.push("relayout"),
      };
    },
    focusPage: () => {
      log.push("focusPage");
      return Promise.resolve();
    },
    frame: () => {
      log.push("frame");
      return new Promise<void>((resolve) => frames.push(resolve));
    },
    scale: () => 2,
    snapshot: (_blob, size) => {
      log.push(`snapshot ${size.width}x${size.height}`);
      return {
        element: { shot: true } as unknown as Node,
        ready: Promise.resolve(),
        dispose: () => void log.push("dispose"),
      };
    },
  };
  /** The attachment's first pass: the bounds, then "the element is shown". */
  const place = async (i = attached.length - 1, visible = true) => {
    await attached[i].view.setBounds({ x: 1, y: 2, width: 300, height: 200 });
    await attached[i].view.setVisible(visible);
  };
  return { views, log, created, raws, attached, frames, place, windowActive };
}

/** A fake tile element: what was put in it. */
function fakeHost() {
  const nodes: unknown[] = [];
  const host = {
    clientWidth: 300,
    clientHeight: 200,
    append: (node: unknown) => void nodes.push(node),
  };
  return { host: host as unknown as HTMLElement, nodes };
}

/** Let every pending promise step run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** A mounted, placed and shown view, its log cleared. */
async function shownView(caps: NativeCapabilities = ALL) {
  const f = fakeViews(caps);
  const engine = createNativeEngine(f.views, caps, "app://localhost");
  const { host, nodes } = fakeHost();
  const view = await engine.mount(host, "https://example.com/");
  await f.place();
  f.log.length = 0;
  return { ...f, engine, view, nodes };
}

Deno.test("native: the engine is picked when the runtime hosts web views, else the iframe", async () => {
  resetWebEngineForTesting();
  assertEquals(webEngine(), IframeEngine, "before the runtime answered");
  const off = fakeViews({ ...ALL, supported: false });
  assertEquals(await detectWebEngine(off.views), IframeEngine);
  assertEquals(webEngine(), IframeEngine);

  resetWebEngineForTesting();
  const broken = {
    ...off.views,
    capabilities: () => Promise.reject(new Error("unavailable")),
  };
  assertEquals(await detectWebEngine(broken), IframeEngine);

  resetWebEngineForTesting();
  const on = fakeViews();
  const engine = await detectWebEngine(on.views);
  assertEquals(engine.capabilities, {
    engine: "native",
    drawsAboveHtml: true,
    readsPage: true,
    capture: true,
    evaluate: true,
    forwardKeys: true,
    keyUp: false,
    zoom: false,
    find: false,
    print: false,
    devTools: false,
    contextMenu: false,
  });
  assertEquals(webEngine(), engine);
  assertEquals(await detectWebEngine(off.views), engine, "asked once");
  resetWebEngineForTesting();
});

Deno.test("native: any http(s) site is shown, never the app's own origin", () => {
  assert(canEmbedNatively("https://github.com/denoland"));
  assert(canEmbedNatively("http://localhost:3000/"));
  assert(canEmbedNatively("http://[::1]:8080/"));
  assert(!canEmbedNatively("file:///etc/passwd"));
  assert(!canEmbedNatively("javascript:alert(1)"));
  assert(!canEmbedNatively("app://localhost/"));
  assert(
    !canEmbedNatively("http://127.0.0.1:4000/x", "http://127.0.0.1:4000"),
  );
  assert(canEmbedNatively("http://127.0.0.1:4001/x", "http://127.0.0.1:4000"));
  const engine = createNativeEngine(fakeViews().views, ALL, "https://a.test");
  assert(engine.canEmbed("https://google.com/"));
  assert(!engine.canEmbed("https://a.test/page"));
});

Deno.test("native: a view is created hidden, in the persistent partition, with safe policies", async () => {
  const f = fakeViews();
  const engine = createNativeEngine(f.views, ALL);
  engine.setForwardKeys?.(["CmdOrCtrl+T", "CmdOrCtrl+T", "CmdOrCtrl+Shift+L"]);
  await engine.mount(fakeHost().host, "https://example.com/");
  assertEquals(f.created, [{
    url: "https://example.com/",
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    visible: false,
    partition: WEB_PARTITION,
    allowPopups: "deny",
    downloads: "ask",
    permissions: "deny",
    forwardKeys: ["CmdOrCtrl+T", "CmdOrCtrl+Shift+L"],
  }]);
  assert(!WEB_PARTITION.startsWith("ephemeral"), "logins survive a restart");
  assertEquals(f.log, ["attach"], "it follows the tile's element");
  // The attachment places it, then it shows.
  await f.place();
  assertEquals(f.log.slice(1), [
    'setBounds {"x":1,"y":2,"width":300,"height":200}',
    "setVisible true",
  ]);
});

Deno.test("native: the view's events and state come through the tile's interface", async () => {
  const { view, raws, log } = await shownView();
  const seen: unknown[] = [];
  for (
    const name of [
      "title",
      "url",
      "load",
      "focus-change",
      "new-window",
      "keydown",
      "keyup",
      "closed",
    ] as const
  ) view.on(name, (e) => seen.push([name, e]));
  const raw = raws[0];
  raw.fire("title", { title: "Docs" });
  raw.fire("url", {
    url: "https://example.com/a",
    canGoBack: true,
    canGoForward: false,
  });
  raw.fire("load", {
    state: "failed",
    url: "https://example.com/a",
    error: { code: "dns", message: "no such host" },
  });
  raw.fire("load", { state: "complete", url: "https://example.com/a" });
  raw.fire("focus-change", { focused: true });
  raw.fire("new-window", { url: "https://example.org/", disposition: "tab" });
  const key = {
    key: "]",
    code: "BracketRight",
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    repeat: false,
    forwarded: true,
  };
  raw.fire("keydown", { ...key, type: "keydown" });
  const { repeat: _, ...up } = key;
  raw.fire("keyup", { ...up, type: "keyup" });
  // Events the tile has no use for are not passed on.
  raw.fire("console", { level: "log", message: "hi" });
  assertEquals(seen, [
    ["title", { title: "Docs" }],
    ["url", {
      url: "https://example.com/a",
      canGoBack: true,
      canGoForward: false,
    }],
    ["load", {
      state: "failed",
      url: "https://example.com/a",
      error: { code: "dns", message: "no such host" },
    }],
    ["load", { state: "complete", url: "https://example.com/a" }],
    ["focus-change", { focused: true }],
    ["new-window", { url: "https://example.org/", disposition: "tab" }],
    ["keydown", key],
    ["keyup", up],
  ]);
  assertEquals(await view.state(), {
    url: "https://example.com/",
    title: "Example",
    load: "complete",
    canGoBack: true,
    canGoForward: false,
  });
  await view.navigate("https://deno.com");
  await view.back();
  await view.reload({ ignoreCache: true });
  assertEquals(log, [
    'navigate "https://deno.com/"',
    "back",
    'reload {"ignoreCache":true}',
  ]);
  await assertRejects(() => view.navigate("file:///etc/passwd"));
  // Its window closed: `closed` once, and nothing after it.
  seen.length = 0;
  raw.fire("closed");
  raw.fire("title", { title: "late" });
  assertEquals(seen, [["closed", {}]]);
});

Deno.test("native: occluded, the picture shows first and only then the view hides", async () => {
  const { view, log, frames, nodes, attached, place } = await shownView();
  const occluding = view.setOccluded(true);
  await settle();
  // The page is captured and its picture is in the element, painted, before the view goes.
  assertEquals(log, [
    'capture {"format":"jpeg","quality":85,"scale":2}',
    "snapshot 300x200",
    "frame",
  ]);
  assertEquals(nodes.length, 1);
  frames.shift()!();
  await occluding;
  assertEquals(log.slice(3), ["setVisible false"]);

  // It clears: the element is measured again (a fresh attachment) and the picture stays until
  // the view is back where the element is now.
  log.length = 0;
  await view.setOccluded(false);
  assertEquals(log, ["attach"]);
  assert(attached[0].detached);
  await place();
  assertEquals(log.slice(1), [
    'setBounds {"x":1,"y":2,"width":300,"height":200}',
    "setVisible true",
    "dispose",
  ]);
});

Deno.test("native: an occlusion that clears while the page is captured never hides the view", async () => {
  const { view, log, raws, attached, place } = await shownView();
  let captured!: (b: Blob) => void;
  raws[0].capture = () => new Promise<Blob>((r) => captured = r);
  const occluding = view.setOccluded(true);
  await settle();
  const clearing = view.setOccluded(false);
  captured(new Blob(["jpeg"]));
  await occluding;
  await clearing;
  assertEquals(
    log.filter((l) => l.startsWith("setVisible") || l === "snapshot"),
    [],
  );
  // It was never hidden: the new attachment just confirms where it is.
  assertEquals(attached.length, 2);
  await place();
  assertEquals(log.filter((l) => l.startsWith("setVisible")), []);
});

Deno.test("native: with no picture the view still hides, and comes back", async () => {
  const { view, log, raws, nodes, place } = await shownView();
  raws[0].capture = () => Promise.reject(new Error("unsupported"));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await view.setOccluded(true);
  } finally {
    console.warn = warn;
  }
  assertEquals(nodes.length, 0);
  assertEquals(log.at(-1), "setVisible false");
  // An engine that cannot capture is not asked to.
  const plain = await shownView({ ...ALL, capture: false });
  await plain.view.setOccluded(true);
  assertEquals(plain.log, ["setVisible false"]);
  await plain.view.setOccluded(false);
  await plain.place();
  assertEquals(plain.log.at(-1), "setVisible true");
  await view.setOccluded(false);
  await place();
  assertEquals(log.at(-1), "setVisible true");
});

Deno.test("native: the element hidden or shown by the attachment, setVisible, relayout, z-order", async () => {
  const { view, log, attached, place, frames } = await shownView();
  // The tile is parked (display: none): no picture, the view just goes.
  await attached[0].view.setVisible(false);
  assertEquals(log, ["setVisible false"]);
  await attached[0].view.setVisible(true);
  assertEquals(log, ["setVisible false", "setVisible true"]);
  log.length = 0;
  await view.setVisible(false);
  await view.setVisible(true);
  assertEquals(log, ["setVisible false", "setVisible true"]);
  // A move no event reports: the attachment measures again, the view stays shown.
  log.length = 0;
  view.relayout();
  assertEquals(log, ["relayout"]);
  assert(!attached[0].detached);
  // Occluded, it waits: the end of the occlusion attaches afresh.
  const occluding = view.setOccluded(true);
  await settle();
  frames.shift()!();
  await occluding;
  log.length = 0;
  view.relayout();
  assertEquals(log, []);
  await view.setOccluded(false);
  assertEquals(log, ["attach"]);
  assert(attached[0].detached);
  await place();
  log.length = 0;
  await view.setZOrder(7);
  await view.setZOrder(7);
  assertEquals(log, ["setZOrder 7"]);
  const flat = await shownView({ ...ALL, zOrder: false });
  await flat.view.setZOrder(7);
  assertEquals(flat.log, []);
});

Deno.test("native: a view hidden with the keyboard takes it back when it shows again", async () => {
  const { view, log, raws, frames, place } = await shownView();
  const focus: boolean[] = [];
  view.on("focus-change", (e) => focus.push(e.focused));
  await view.focus();
  assertEquals(log, ["focus"]);
  raws[0].fire("focus-change", { focused: true });
  await view.focus();
  assertEquals(log, ["focus"], "it has the keyboard already");
  const occluding = view.setOccluded(true);
  await settle();
  frames.shift()!();
  await occluding;
  // The runtime hands the keyboard to the app's page when a view hides, and says so.
  raws[0].fire("focus-change", { focused: false, reason: "hidden" });
  log.length = 0;
  await view.setOccluded(false);
  await place();
  assertEquals(log.filter((l) => l !== "dispose").slice(-2), [
    "setVisible true",
    "focus",
  ]);
  assertEquals(focus, [true, false]);
  // The user moved the keyboard elsewhere while it showed: it does not take it back.
  raws[0].fire("focus-change", { focused: true });
  raws[0].fire("focus-change", { focused: false });
  const again = view.setOccluded(true);
  await settle();
  frames.shift()!();
  await again;
  log.length = 0;
  await view.setOccluded(false);
  await place();
  assert(!log.includes("focus"));
  // Asked for while hidden: it waits until the view shows.
  const hidden = view.setOccluded(true);
  await settle();
  frames.shift()!();
  await hidden;
  log.length = 0;
  await view.focus();
  assertEquals(log, []);
  await view.setOccluded(false);
  await place();
  assertEquals(log.at(-2), "focus");
});

Deno.test("native: a tile that loses the focus hands the keyboard to the app, unless another view takes it", async () => {
  const f = fakeViews();
  const engine = createNativeEngine(f.views, ALL);
  const a = await engine.mount(fakeHost().host, "https://a.example/");
  await f.place(0);
  const b = await engine.mount(fakeHost().host, "https://b.example/");
  await f.place(1);
  f.raws[0].fire("focus-change", { focused: true });
  f.log.length = 0;
  // To a terminal: the app's page takes the keyboard.
  void a.blur();
  assertEquals(f.log, [], "after the turn");
  await settle();
  assertEquals(f.log, ["focusPage"]);
  // To another web tile in the same render: only that view asks for it.
  f.log.length = 0;
  void a.blur();
  void b.focus();
  await settle();
  assertEquals(f.log, ["focus"]);
  // A view without the keyboard has nothing to hand back.
  f.log.length = 0;
  await b.blur();
  await settle();
  assertEquals(f.log, []);
  // Another app is in front: the window is not brought forward; the page gets the keyboard
  // when the window is the active one again.
  f.raws[1].fire("focus-change", { focused: true });
  f.windowActive[0](false);
  void b.blur();
  await settle();
  assertEquals(f.log, []);
  f.windowActive[0](true);
  assertEquals(f.log, ["focusPage"]);
  f.windowActive[0](false);
  f.windowActive[0](true);
  assertEquals(f.log, ["focusPage"], "once");
  // ... unless a view took the keyboard meanwhile.
  f.raws[0].fire("focus-change", { focused: true });
  f.windowActive[0](false);
  f.log.length = 0;
  void a.blur();
  await settle();
  f.raws[1].fire("focus-change", { focused: true });
  f.windowActive[0](true);
  assertEquals(f.log, []);
});

Deno.test("native: with the view's blur and keyUp, the keyboard goes back without the window", async () => {
  const caps = { ...ALL, blur: true, keyUp: true };
  const f = fakeViews(caps);
  const engine = createNativeEngine(f.views, caps);
  assertEquals(engine.capabilities.keyUp, true);
  assertEquals(
    createNativeEngine(f.views, { ...caps, forwardKeys: false }).capabilities
      .keyUp,
    false,
    "no releases without forwarded keys",
  );
  const a = await engine.mount(fakeHost().host, "https://a.example/");
  await f.place(0);
  f.raws[0].fire("focus-change", { focused: true });
  f.log.length = 0;
  // The view hands the keyboard back itself: no focusWindow, even with another app in front.
  f.windowActive[0](false);
  await a.blur();
  await settle();
  assertEquals(f.log, ["blur"]);
  f.windowActive[0](true);
  assertEquals(f.log, ["blur"]);
  // Its blur's focus loss: it does not take the keyboard back when it shows again.
  f.raws[0].fire("focus-change", { focused: false, reason: "blur" });
  f.log.length = 0;
  await a.setVisible(false);
  await a.setVisible(true);
  assertEquals(f.log, ["setVisible false", "setVisible true"]);
  // A view without the keyboard has nothing to hand back.
  f.log.length = 0;
  await a.blur();
  assertEquals(f.log, []);
});

Deno.test("native: the forward keys reach every view, now and later", async () => {
  const f = fakeViews();
  const engine = createNativeEngine(f.views, ALL);
  const first = await engine.mount(fakeHost().host, "https://a.example/");
  assertEquals(f.created[0].forwardKeys, []);
  f.log.length = 0;
  engine.setForwardKeys?.(["CmdOrCtrl+1", "CmdOrCtrl+2"]);
  assertEquals(f.log, ['setForwardKeys ["CmdOrCtrl+1","CmdOrCtrl+2"]']);
  await engine.mount(fakeHost().host, "https://b.example/");
  assertEquals(f.created[1].forwardKeys, ["CmdOrCtrl+1", "CmdOrCtrl+2"]);
  // Keys set while a view is being created reach it once it exists.
  f.log.length = 0;
  const mounting = engine.mount(fakeHost().host, "https://c.example/");
  engine.setForwardKeys?.(["CmdOrCtrl+3"]);
  const third = await mounting;
  assertEquals(f.created[2].forwardKeys, ["CmdOrCtrl+1", "CmdOrCtrl+2"]);
  assertEquals(
    f.log.filter((l) => l.startsWith("setForwardKeys")),
    Array(3).fill('setForwardKeys ["CmdOrCtrl+3"]'),
  );
  await third.close();
  // A closed view is forgotten.
  await first.close();
  f.log.length = 0;
  engine.setForwardKeys?.(
    Array.from({ length: 80 }, (_, i) => `CmdOrCtrl+F${i}`),
  );
  assertEquals(f.log.length, 1);
  assertEquals(
    JSON.parse(f.log[0].slice("setForwardKeys ".length)).length,
    MAX_FORWARD_KEYS,
  );
  // An engine without forward keys is never given any.
  const none = fakeViews({ ...ALL, forwardKeys: false });
  const plain = createNativeEngine(none.views, { ...ALL, forwardKeys: false });
  plain.setForwardKeys?.(["CmdOrCtrl+1"]);
  await plain.mount(fakeHost().host, "https://a.example/");
  assert(!("forwardKeys" in none.created[0]));
  assertEquals(plain.capabilities.forwardKeys, false);
});

Deno.test("keys: the forward keys are the workspace's shortcuts and the talk keys, no other", () => {
  const off = { pttKey: "off", dictateKey: "off" } as const;
  const mac = forwardAccelerators(off, "mac");
  for (
    const key of [
      "CmdOrCtrl+T",
      "CmdOrCtrl+W",
      "CmdOrCtrl+1",
      "CmdOrCtrl+9",
      "CmdOrCtrl+[",
      "CmdOrCtrl+]",
      "CmdOrCtrl+`",
      "CmdOrCtrl+Enter",
      "CmdOrCtrl+=",
      "CmdOrCtrl+Shift+=",
      "CmdOrCtrl+-",
      "CmdOrCtrl+0",
      "CmdOrCtrl+Num0",
      "CmdOrCtrl+NumAdd",
      "CmdOrCtrl+NumSubtract",
      "CmdOrCtrl+Shift+L",
      "CmdOrCtrl+Shift+B",
      "CmdOrCtrl+Shift+O",
      "CmdOrCtrl+Shift+I",
      // The browser keys (only a web tile's page has the keyboard there).
      "CmdOrCtrl+L",
      "CmdOrCtrl+R",
      "CmdOrCtrl+Shift+R",
      "CmdOrCtrl+.",
      "CmdOrCtrl+D",
      "CmdOrCtrl+F",
      "CmdOrCtrl+G",
      "CmdOrCtrl+Shift+G",
      "CmdOrCtrl+P",
      "CmdOrCtrl+Alt+I",
    ]
  ) assert(mac.includes(key), key);
  // What a page keeps: copy, paste, select all, its own tabs' keys.
  for (
    const key of [
      "CmdOrCtrl+C",
      "CmdOrCtrl+V",
      "CmdOrCtrl+X",
      "CmdOrCtrl+Z",
      "CmdOrCtrl+A",
      "CmdOrCtrl+Space",
      "CmdOrCtrl+Shift+M",
      "CmdOrCtrl+Shift+T",
    ]
  ) assert(!mac.includes(key), key);
  // ⌘. is macOS's Stop only.
  assert(!forwardAccelerators(off, "other").includes("CmdOrCtrl+."));
  assertEquals(new Set(mac).size, mac.length);
  assert(mac.length <= MAX_FORWARD_KEYS);
  // The talk keys, once picked (and available on the platform).
  const talk = {
    pttKey: "Mod+Shift+M",
    dictateKey: "Mod+Shift+Space",
  } as const;
  const withTalk = forwardAccelerators(talk, "mac");
  assertEquals(
    withTalk.filter((k) => !mac.includes(k)),
    ["CmdOrCtrl+Shift+M", "CmdOrCtrl+Shift+Space"],
  );
  assert(!forwardAccelerators(talk, "other").includes("CmdOrCtrl+Shift+Space"));
  assert(withTalk.length <= MAX_FORWARD_KEYS);
});

/** Run the dictation script as the page's isolated world would, over a fake `document`. */
function runInsert(
  text: string,
  activeElement: unknown,
  exec: () => boolean = () => false,
) {
  const calls: unknown[][] = [];
  const doc = {
    activeElement,
    defaultView: null,
    execCommand: (...args: unknown[]) => {
      calls.push(args);
      return exec();
    },
  };
  const result = new Function("document", `return ${insertTextScript(text)};`)(
    doc,
  );
  return { result, calls };
}

Deno.test("native: dictation's script types into the page's focused field", () => {
  // execCommand, when the page has it.
  const area = fakeField("TEXTAREA");
  const typed = runInsert('say "hi"\n ', area.field, () => true);
  assertEquals(typed.result, true);
  assertEquals(typed.calls, [["insertText", false, 'say "hi"\n ']]);
  assertEquals(area.field.value, "abc");
  // Else the selection is replaced and the page hears an input event.
  const search = fakeField("INPUT", { type: "search" });
  const ranged = runInsert("XY", search.field, () => {
    throw new Error("unsupported");
  });
  assertEquals(ranged.result, true);
  assertEquals(search.field.value, "aXYc");
  assertEquals(search.events.map((e) => [e.type, e.bubbles]), [[
    "input",
    true,
  ]]);
  // contenteditable, through execCommand.
  assertEquals(
    runInsert(
      "x",
      fakeField("DIV", { isContentEditable: true }).field,
      () => true,
    ).result,
    true,
  );
  // The focus inside a shadow root, and inside a same-origin frame.
  const inner = fakeField("INPUT");
  const hostEl = {
    tagName: "X-FIELD",
    shadowRoot: { activeElement: inner.field },
  };
  assertEquals(runInsert("Q", hostEl).result, true);
  assertEquals(inner.field.value, "aQc");
  const framed = fakeField("TEXTAREA");
  const frameCalls: unknown[][] = [];
  const frame = {
    tagName: "IFRAME",
    contentDocument: {
      activeElement: framed.field,
      defaultView: null,
      execCommand: (...args: unknown[]) => {
        frameCalls.push(args);
        return true;
      },
    },
  };
  const viaFrame = runInsert("Z", frame);
  assertEquals(viaFrame.result, true);
  assertEquals(viaFrame.calls, [], "typed in the frame's document");
  assertEquals(frameCalls, [["insertText", false, "Z"]]);
  // Nothing editable has the focus: refused, nothing typed.
  for (
    const el of [
      null,
      fakeField("DIV").field,
      fakeField("BUTTON").field,
      fakeField("INPUT", { type: "checkbox" }).field,
      fakeField("INPUT", { disabled: true }).field,
      fakeField("TEXTAREA", { readOnly: true }).field,
      { tagName: "IFRAME", contentDocument: null },
    ]
  ) {
    const refused = runInsert("x", el, () => true);
    assertEquals(refused.result, false);
    assertEquals(refused.calls, []);
  }
  // An email field has no selection: only execCommand can type into it.
  const email = fakeField("INPUT", { type: "email" });
  assertEquals(runInsert("x", email.field).result, false);
  assertEquals(email.field.value, "abc");
});

Deno.test("native: insertText answers what the page's script did", async () => {
  const { view, raws, log } = await shownView();
  let script = "";
  raws[0].evaluate = (s) => {
    script = s;
    return Promise.resolve(true);
  };
  assertEquals(await view.insertText("git status"), true);
  assertEquals(script, insertTextScript("git status"));
  assert(script.includes('"git status"'));
  raws[0].evaluate = () => Promise.resolve(false);
  assertEquals(await view.insertText("x"), false);
  raws[0].evaluate = () => Promise.resolve(null);
  assertEquals(await view.insertText("x"), false);
  // The page's CSP refused the evaluation.
  raws[0].evaluate = () => Promise.reject(new Error("error"));
  assertEquals(await view.insertText("x"), false);
  // An engine that cannot evaluate, and a closed view, never try.
  const plain = await shownView({ ...ALL, evaluate: false });
  assertEquals(await plain.view.insertText("x"), false);
  assertEquals(plain.log, []);
  await view.close();
  log.length = 0;
  assertEquals(await view.insertText("x"), false);
  assertEquals(log, []);
});

Deno.test("native: closing drops the picture and the attachment, once", async () => {
  const { view, log, frames, attached } = await shownView();
  const closed: unknown[] = [];
  view.on("closed", (e) => closed.push(e));
  const occluding = view.setOccluded(true);
  await settle();
  frames.shift()!();
  await occluding;
  log.length = 0;
  await view.close();
  await view.close();
  assertEquals(log, ["close", "dispose"]);
  assert(attached.every((a) => a.detached));
  assertEquals(closed, [{}]);
  // Nothing follows.
  await view.setOccluded(false);
  view.relayout();
  await view.focus();
  await settle();
  assertEquals(log, ["close", "dispose"]);
});

Deno.test("overlays: a cover over a tile, and the room a view leaves for what stays", () => {
  const body = { left: 100, top: 50, right: 900, bottom: 650 };
  const seen: number[] = [];
  const off = onAreaOverlays(() => seen.push(areaOverlays().length));
  const companion = {};
  const face = { left: 780, top: 540, right: 880, bottom: 640 };
  setAreaOverlays(companion, [{ kind: "keepout", box: face }]);
  setAreaOverlays(companion, [{ kind: "keepout", box: face }]);
  assertEquals(seen, [1], "the same areas again tell nobody");
  assertEquals(coveredByArea(body, areaOverlays()), false);
  // The face is in the bottom right corner: the strip along the right edge is the smaller loss
  // (120 px of a 600 px side, against 110 px of an 800 px side).
  assertEquals(keepoutInsets(body, areaOverlays()), {
    top: 0,
    right: 120,
    bottom: 0,
    left: 0,
  });
  // Its bubble comes up: the tile under it is covered; one beside it is not.
  setAreaOverlays(companion, [
    { kind: "keepout", box: face },
    { kind: "cover", box: { left: 640, top: 400, right: 900, bottom: 640 } },
  ]);
  assert(coveredByArea(body, areaOverlays()));
  const beside = { left: 0, top: 50, right: 100, bottom: 650 };
  assertEquals(coveredByArea(beside, areaOverlays()), false);
  assertEquals(keepoutInsets(beside, areaOverlays()), {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
  // A banner along the bottom of a wide tile: the strip along the bottom.
  const banner = {};
  setAreaOverlays(banner, [{
    kind: "keepout",
    box: { left: 300, top: 610.5, right: 700, bottom: 640 },
  }]);
  assertEquals(keepoutInsets(body, areaOverlays()), {
    top: 0,
    right: 120,
    bottom: 40,
    left: 0,
  });
  setAreaOverlays(banner, []);
  setAreaOverlays(companion, []);
  assertEquals(areaOverlays(), []);
  off();
  setAreaOverlays(companion, [{ kind: "cover", box: face }]);
  setAreaOverlays(companion, []);
  assertEquals(seen.length, 5, "unsubscribed");
});

Deno.test("dictation: a web page's late answer shows the note, unless another capture started", async () => {
  const stt: SttEngine = {
    id: "fake",
    probe: () => Promise.resolve({ ok: true }),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve("git status"),
    cancel: () => Promise.resolve(),
  };
  const setup = () => {
    let answer!: (o: DictateOutcome) => void;
    const c = new VoiceController({
      engine: () => stt,
      settings: () => ({ review: false, dictate: true }),
      bargeIn: () => {},
      toCompanion: () => {},
      summarize: () => {},
      dictate: () => new Promise<DictateOutcome>((r) => answer = r),
      onState: () => {},
    });
    return { c, answer: (o: DictateOutcome) => answer(o) };
  };
  const typed = setup();
  await typed.c.press();
  await typed.c.release(1000);
  assertEquals(typed.c.state.message, "", "nothing yet: the page has not said");
  typed.answer("typed");
  await settle();
  assertEquals(typed.c.state.message, "");

  const missed = setup();
  await missed.c.press();
  await missed.c.release(1000);
  missed.answer("not-editable");
  await settle();
  assertEquals(missed.c.state.message, DICTATE_MISS["not-editable"]);
  assertEquals(missed.c.state.target, "dictate");

  const late = setup();
  await late.c.press();
  await late.c.release(1000);
  await late.c.press();
  late.answer("not-editable");
  await settle();
  assertEquals(late.c.state.phase, "listening");
  assertEquals(late.c.state.message, "", "the new capture is not disturbed");
  await late.c.cancel();
});

Deno.test("native: a view mounted while the tile is occluded stays hidden until it clears", async () => {
  const f = fakeViews();
  const engine = createNativeEngine(f.views, ALL);
  const view: WebViewHandle = await engine.mount(
    fakeHost().host,
    "https://example.com/",
  );
  await view.setOccluded(true);
  await f.place();
  assertEquals(f.log.filter((l) => l.startsWith("setVisible")), []);
  assertEquals(f.log.filter((l) => l.startsWith("capture")), []);
  await view.setOccluded(false);
  await f.place();
  assertEquals(f.log.filter((l) => l.startsWith("setVisible")), [
    "setVisible true",
  ]);
});

Deno.test("native: the browser features pass through when the runtime has them", async () => {
  const caps = {
    ...ALL,
    zoom: true,
    find: true,
    print: true,
    devTools: true,
    contextMenu: true,
  };
  const f = fakeViews(caps);
  const engine = createNativeEngine(f.views, caps);
  assertEquals(
    [
      engine.capabilities.zoom,
      engine.capabilities.find,
      engine.capabilities.print,
    ],
    [true, true, true],
  );
  const view = await engine.mount(fakeHost().host, "https://example.com/");
  // The tile draws the page's context menu.
  assertEquals(f.created[0].contextMenu, "app");
  const found: unknown[] = [];
  const menus: unknown[] = [];
  view.on("find-result", (e) => found.push(e));
  view.on("context-menu", (e) => menus.push(e));
  f.raws[0].fire("find-result", { matches: 3, activeMatch: 1 });
  f.raws[0].fire("context-menu", {
    x: 4,
    y: 5,
    linkUrl: "https://l/",
    isEditable: false,
    mediaType: "image",
  });
  assertEquals(found, [{ matches: 3, activeMatch: 1 }]);
  assertEquals(menus, [{
    x: 4,
    y: 5,
    linkUrl: "https://l/",
    isEditable: false,
  }]);
  f.log.length = 0;
  await view.setZoom(9);
  assertEquals(await view.getZoom(), 1.25);
  await view.find("needle", { forward: false });
  await view.stopFind();
  await view.print();
  await view.openDevTools();
  assertEquals(f.log, [
    "setZoom 5",
    'find ["needle",{"forward":false}]',
    "stopFind",
    "print",
    "openDevTools",
  ]);
  // Without them: off, and the engine's own context menu.
  const plain = fakeViews();
  const off = createNativeEngine(plain.views, ALL);
  assertEquals(off.capabilities.contextMenu, false);
  await off.mount(fakeHost().host, "https://example.com/");
  assertEquals("contextMenu" in plain.created[0], false);
});
