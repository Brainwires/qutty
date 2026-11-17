/**
 * The page's half of the companion's web tools: a web command from the hub (lib/hub/core.ts
 * `WebCommand`, sent like spawn / close / focus) carried out on a web tile's view, answered with a
 * JSON value the hub turns into the tool's result (lib/hub/web-tools.ts). The workspace's half
 * (which tiles exist, opening and closing them) comes in as {@linkcode WebControlDeps}
 * (app/use-web-control.ts); the rest is here, driven by fakes in the tests.
 *
 * What each engine can do: the native view (the desktop app) reads and acts on any page
 * (`evaluate`, the scripts of lib/web/page-script.ts) and pictures it (`capture`). The iframe
 * (the browser demo) only navigates: its pages are cross-origin, so it cannot look inside them,
 * and those tools answer why.
 *
 * Waiting: a navigation (navigate, back, forward, reload) is answered once the view reports its
 * load complete or failed (`load` events), or after {@linkcode LOAD_WAIT_MS} with the page still
 * loading. A click or a submit waits {@linkcode NAV_START_MS} for a navigation to start, and then
 * for it to load. The bounds are the hub's way of bounding a wait (as `wait_for_message` does);
 * the whole command is bounded again by the hub's control timeout.
 *
 * Client-safe.
 *
 * @module
 */

import type {
  WebEngine,
  WebLoadState,
  WebViewHandle,
  WebViewState,
} from "./engine.ts";
import { addressToUrl, parseWebUrl } from "./url.ts";
import { type PageRequest, pageScript } from "./page-script.ts";
import type { ControlResult, WebCommand } from "../hub/core.ts";

/** How long a navigation may take before the answer says it is still loading. */
const LOAD_WAIT_MS = 8_000;
/** How long a click or submit is watched for the navigation it may start. */
const NAV_START_MS = 1_500;
/** How long a new tile's view may take to mount. */
const VIEW_WAIT_MS = 4_000;
/** The longest `web_eval` result (its JSON), in characters. */
export const MAX_EVAL_JSON = 20_000;
/** The largest screenshot (JPEG bytes). */
const MAX_SHOT_BYTES = 3 * 1024 * 1024;
/** Where `open_web` goes without a URL and without a home page in Settings. */
export const FALLBACK_HOME = "https://www.google.com/";

/** Why the iframe engine cannot read or act on a page. */
export const IFRAME_CANNOT_READ =
  "this page can't be read here: the iframe engine (the browser demo) shows only local pages " +
  "and cannot look inside them; the desktop app's native view can";

/** A tile's page as a navigation leaves it. */
interface WebPageState {
  url: string;
  title: string;
  load: WebLoadState;
}

/** What the workspace lends the web commands. */
export interface WebControlDeps {
  /** The engine (`null`: not known yet). */
  engine(): WebEngine | null;
  /** Whether `id` is one of this window's web tiles. */
  isWebTile(id: string): boolean;
  /** Tile `id`'s mounted view, waiting for it to mount until `signal` aborts. */
  view(id: string, signal: AbortSignal): Promise<WebViewHandle | undefined>;
  /** The page the workspace keeps for tile `id` (the iframe cannot read the title). */
  page(id: string): { url: string; title?: string } | undefined;
  /** Settings → Links → Home page. */
  home(): string | undefined;
  /** Open a web tile on `url` beside tile `beside` (a PTY id or a tile id); its id. */
  open(url: string, beside?: string): string | null;
  close(id: string): void;
  focus(id: string): void;
}

/** A signal that aborts after `ms`, and its cancel. */
function deadline(ms: number): { signal: AbortSignal; done(): void } {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return {
    signal: ac.signal,
    done: () => {
      clearTimeout(timer);
      ac.abort();
    },
  };
}

/**
 * Watch `view` for a navigation: `started` resolves when one starts (a `loading` load event or a
 * new URL), `finished` when the page reports complete or failed. `stop` drops the listeners.
 */
function watchLoad(view: WebViewHandle) {
  let started = false;
  let finished = false;
  const wake = new Set<() => void>();
  const ping = () => {
    for (const fn of [...wake]) fn();
  };
  const offs = [
    view.on("load", (e) => {
      if (e.state === "loading") started = true;
      if (e.state === "complete" || e.state === "failed") {
        started = true;
        finished = true;
      }
      ping();
    }),
    view.on("url", () => {
      started = true;
      ping();
    }),
  ];
  /** Resolves true once `cond` holds, false when `ms` passes first. */
  const until = (cond: () => boolean, ms: number) =>
    new Promise<boolean>((resolve) => {
      if (cond()) return resolve(true);
      const bound = deadline(ms);
      const check = () => {
        if (!cond()) return;
        wake.delete(check);
        bound.done();
        resolve(true);
      };
      wake.add(check);
      bound.signal.addEventListener("abort", () => {
        if (!wake.has(check)) return;
        wake.delete(check);
        resolve(cond());
      });
    });
  return {
    /** Whether a navigation started within `ms`. */
    started: (ms: number) => until(() => started, ms),
    /** Whether the page finished loading within `ms`. */
    finished: (ms: number) => until(() => finished, ms),
    stop: () => {
      for (const off of offs) off();
      wake.clear();
    },
  };
}

/** The page's state, with the workspace's title where the engine reads none (the iframe). */
async function stateOf(
  view: WebViewHandle,
  fallback: { url: string; title?: string } | undefined,
): Promise<WebPageState> {
  const s: WebViewState = await view.state();
  return {
    url: s.url || fallback?.url || "",
    title: s.title || (fallback?.url === s.url ? fallback.title ?? "" : ""),
    load: s.load,
  };
}

/** A blob as base64. */
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/**
 * An evaluation's failure, in words. A page's Content-Security-Policy no longer refuses it
 * (Denext 4.20), but where that policy refuses `eval` (WKWebView, WebKitGTK) a promise result is
 * not awaited and comes back `not_serializable`.
 */
function evalError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const unserializable = (e as { code?: unknown } | null)?.code ===
    "not_serializable";
  return `the page did not run the script (${m.slice(0, 300)})${
    unserializable
      ? "; its result is not JSON, or it is a promise on a page whose Content-Security-Policy " +
        "refuses eval (end the script with a plain value there)"
      : ""
  }`;
}

class Refusal extends Error {}
const refuse = (message: string): never => {
  throw new Refusal(message);
};

/** Carry out web command `cmd` in this window. */
export async function runWebCommand(
  cmd: WebCommand,
  deps: WebControlDeps,
): Promise<ControlResult> {
  try {
    return { ok: true, value: await run(cmd, deps) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Refusal
        ? e.message
        : `the page failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function run(cmd: WebCommand, deps: WebControlDeps): Promise<unknown> {
  const engine = deps.engine() ??
    refuse("the window's web engine is not ready yet; try again");
  const op = cmd.op;
  if (op.op === "open") return await open(op, engine, deps);
  const id = cmd.tileId;
  if (!id || !deps.isWebTile(id)) {
    return refuse("that web tile is not in this window");
  }
  if (op.op === "close") {
    deps.close(id);
    return {};
  }
  if (op.op === "focus") {
    deps.focus(id);
    return {};
  }
  const view = await mounted(id, deps);
  const page = () => stateOf(view, deps.page(id));
  switch (op.op) {
    case "navigate": {
      const url = addressToUrl(op.url, { search: true }) ??
        refuse(`"${op.url}" is not an address (and not a search)`);
      if (!engine.canEmbed(url)) {
        return refuse(
          engine.capabilities.engine === "iframe"
            ? `the iframe engine (the browser demo) shows only local pages, not ${url}; the desktop app's native view opens any site`
            : `a web tile cannot show ${url}`,
        );
      }
      return await navigation(view, () => view.navigate(url), page);
    }
    case "go": {
      const s = await view.state();
      if (op.action === "back" && !s.canGoBack) {
        return refuse("there is no page to go back to");
      }
      if (op.action === "forward" && !s.canGoForward) {
        return refuse("there is no page to go forward to");
      }
      return await navigation(
        view,
        () =>
          op.action === "back"
            ? view.back()
            : op.action === "forward"
            ? view.forward()
            : view.reload(),
        page,
      );
    }
    case "read": {
      const evaluate = evaluator(view, engine);
      // A page still loading is read once it has.
      const w = watchLoad(view);
      try {
        if ((await view.state()).load === "loading") {
          await w.finished(LOAD_WAIT_MS);
        }
      } finally {
        w.stop();
      }
      return { result: await evaluate(pageScript(op)) };
    }
    case "click":
    case "type":
    case "scroll": {
      const evaluate = evaluator(view, engine);
      const request: PageRequest = op;
      // A click or a submit may navigate: watched from before it happens.
      const navigates = op.op === "click" || (op.op === "type" && op.submit);
      const w = navigates ? watchLoad(view) : null;
      try {
        const result = await evaluate(pageScript(request));
        const ok = !!result && (result as { ok?: unknown }).ok === true;
        let navigated = false;
        if (w && ok && await w.started(NAV_START_MS)) {
          navigated = true;
          await w.finished(LOAD_WAIT_MS);
        }
        return { result, navigated, page: await page() };
      } finally {
        w?.stop();
      }
    }
    case "eval": {
      const evaluate = evaluator(view, engine);
      const value = await evaluate(op.script);
      let json = JSON.stringify(value ?? null) ?? "null";
      const truncated = json.length > MAX_EVAL_JSON;
      if (truncated) json = json.slice(0, MAX_EVAL_JSON);
      return { json, truncated };
    }
    case "screenshot": {
      if (!engine.capabilities.capture || !view.capture) {
        return refuse(
          engine.capabilities.engine === "iframe"
            ? "the iframe engine (the browser demo) cannot picture a page; the desktop app's native view can"
            : "this web view cannot take a picture of its page",
        );
      }
      const shot = await view.capture({
        format: "jpeg",
        quality: 70,
        scale: 1,
      });
      if (shot.size > MAX_SHOT_BYTES) {
        return refuse("the picture of the page is too large");
      }
      return { mimeType: shot.type || "image/jpeg", data: await base64(shot) };
    }
  }
}

/** Tile `id`'s view, once mounted (a new tile mounts it a moment after it opens). */
async function mounted(
  id: string,
  deps: WebControlDeps,
): Promise<WebViewHandle> {
  const bound = deadline(VIEW_WAIT_MS);
  try {
    return await deps.view(id, bound.signal) ??
      refuse(
        "the tile's page is not showing (the engine could not open it there; it offers the default browser)",
      );
  } finally {
    bound.done();
  }
}

/** The view's `evaluate`, or why this engine has none. */
function evaluator(
  view: WebViewHandle,
  engine: WebEngine,
): (script: string) => Promise<unknown> {
  const evaluate = view.evaluate;
  if (!engine.capabilities.evaluate || !evaluate) {
    return refuse(
      engine.capabilities.engine === "iframe"
        ? IFRAME_CANNOT_READ
        : "this web view cannot run scripts in its page",
    );
  }
  return async (script) => {
    try {
      return await evaluate.call(view, script);
    } catch (e) {
      return refuse(evalError(e));
    }
  };
}

/** Start a navigation and answer once it has loaded (or the wait is over). */
async function navigation(
  view: WebViewHandle,
  start: () => Promise<void>,
  page: () => Promise<WebPageState>,
): Promise<WebPageState & { loaded: boolean }> {
  const w = watchLoad(view);
  try {
    await start();
    const loaded = await w.finished(LOAD_WAIT_MS);
    return { ...await page(), loaded };
  } finally {
    w.stop();
  }
}

/** `open_web`: a new web tile, answered once its page has loaded (or cannot be shown). */
async function open(
  op: { url?: string; beside?: string },
  engine: WebEngine,
  deps: WebControlDeps,
): Promise<unknown> {
  const url = op.url ?? deps.home() ?? FALLBACK_HOME;
  if (!parseWebUrl(url)) return refuse(`not an http(s) address: ${url}`);
  const id = deps.open(url, op.beside) ??
    refuse(
      op.beside
        ? `could not open a web tile beside ${op.beside} (is it in this window?)`
        : "could not open a web tile",
    );
  if (!engine.canEmbed(url)) {
    return {
      tile: id,
      url,
      note: engine.capabilities.engine === "iframe"
        ? "the iframe engine (the browser demo) shows only local pages: the tile offers the default browser"
        : "a web tile cannot show this page: the tile offers the default browser",
    };
  }
  const bound = deadline(VIEW_WAIT_MS);
  let view: WebViewHandle | undefined;
  try {
    view = await deps.view(id, bound.signal);
  } finally {
    bound.done();
  }
  if (!view) return { tile: id, url, load: "loading" };
  const w = watchLoad(view);
  try {
    if ((await view.state()).load === "loading") {
      await w.finished(LOAD_WAIT_MS);
    }
    return { tile: id, ...await stateOf(view, deps.page(id)) };
  } finally {
    w.stop();
  }
}
