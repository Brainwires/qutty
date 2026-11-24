// End-to-end harness: a static export of the app served by a tiny Deno file server, driven in
// headless Chromium through astral, with the in-browser demo PTY (`?pty=demo`) and the test
// hooks (`?test=1`, see lib/test-hooks.ts).
//
// Why a static export and not `denext dev`: the export is one ~2 s build per test process, after
// which every page load is plain static files — no on-demand compilation, no HMR socket, no
// dev-only console chatter, and identical bytes for every test. The export is copied into a temp
// dir right away so a concurrent `denext export` (or the desktop packager) rewriting `out/` can
// not change the files under a running suite. Set `E2E_NO_BUILD=1` to reuse the current `out/`.
//
// Structure: `suite(name, define)` registers ONE Deno.test per file whose cases run as steps, so
// the browser (and the server) are launched once per file and every case still reports on its
// own. Each case gets a fresh page with the origin's storage cleared, and fails if the page logs
// a console error or throws. `E2E_FILTER=<substring>` runs only the matching cases.
// `E2E_CPU_THROTTLE=<n>` slows the page's CPU n times (Chromium's throttling), to try a
// timing-sensitive case the way a loaded CI runner runs it.

import { Browser, generateBinArgs, getBinary, type Page } from "@astral/astral";
import { contentType } from "@std/media-types";
import { copy } from "@std/fs";
import { extname, fromFileUrl, join } from "@std/path";
import {
  computeLayout,
  type LayoutOptions,
  type Rect,
} from "../../lib/layout/mod.ts";
import { QUOTE_DAY_KEY } from "../../lib/companion/ambient.ts";
import {
  DEFAULT_SETTINGS,
  type Settings,
  SETTINGS_STORAGE_KEY,
  type SettingsTab,
} from "../../lib/workspace/store.ts";

export const ROOT = fromFileUrl(new URL("../../", import.meta.url));

// Every waitFor timeout is multiplied by this (E2E_TIMEOUT_SCALE; CI sets it, its runners are
// several times slower than a desktop Mac).
const TIMEOUT_SCALE = Math.max(
  1,
  Number(Deno.env.get("E2E_TIMEOUT_SCALE")) || 1,
);

// The motion tests need animations, so Chromium must not inherit the OS "Reduce motion" setting
// (GitHub's macOS runners have it on). E2E_REDUCED_MOTION=1 forces it on instead.
const MOTION_FLAG = Deno.env.get("E2E_REDUCED_MOTION") === "1"
  ? "--force-prefers-reduced-motion"
  : "--force-prefers-no-reduced-motion";

// ---------------------------------------------------------------------------------------------
// Build + serve
// ---------------------------------------------------------------------------------------------

let siteDir: Promise<string> | undefined;

/** Export the app once per process and snapshot it into a temp dir. */
function buildSite(): Promise<string> {
  return siteDir ??= (async () => {
    if (Deno.env.get("E2E_NO_BUILD") !== "1") {
      const out = await new Deno.Command(Deno.execPath(), {
        // The project's own task, so the export uses the same Denext as everything else.
        args: ["task", "export"],
        cwd: ROOT,
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (!out.success) {
        throw new Error(
          `denext export failed:\n${new TextDecoder().decode(out.stderr)}\n${
            new TextDecoder().decode(out.stdout)
          }`,
        );
      }
    }
    const dir = await Deno.makeTempDir({ prefix: "gui-terminal-e2e-" });
    await copy(join(ROOT, "out"), join(dir, "site"));
    return join(dir, "site");
  })();
}

interface Server {
  origin: string;
  close(): Promise<void>;
}

async function serve(dir: string): Promise<Server> {
  const ac = new AbortController();
  let resolvePort: (port: number) => void;
  const port = new Promise<number>((r) => resolvePort = r);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: (addr) => resolvePort(addr.port),
  }, async (req) => {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith("/")) path += "index.html";
    if (path.includes("..")) return new Response("bad path", { status: 400 });
    try {
      const body = await Deno.readFile(join(dir, path));
      return new Response(body, {
        headers: {
          "content-type": contentType(extname(path)) ??
            "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  return {
    origin: `http://127.0.0.1:${await port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** The test pages web tiles load (`serveWebPages`), and every path they were asked for. */
export interface WebPages extends Server {
  /** `http://localhost:<port>`: a dev host the iframe engine embeds, not the app's origin. */
  origin: string;
  hits: string[];
}

/**
 * A tiny site for the web tile tests, on its own port (so its origin is never the app's): `/a`
 * and `/b` (titled "Page A" / "Page B", each linking to the other) and `/slow` (answers after
 * `?ms=`). Every request's path is recorded in `hits`, which is how a test knows a page loaded
 * (the frame is cross-origin: the app cannot look inside it, and neither can the test).
 */
export async function serveWebPages(): Promise<WebPages> {
  const ac = new AbortController();
  const hits: string[] = [];
  let resolvePort: (port: number) => void;
  const port = new Promise<number>((r) => resolvePort = r);
  const page = (title: string, next: string) =>
    new Response(
      `<!doctype html><title>${title}</title><body><h1>${title}</h1>` +
        `<a href="${next}">next</a></body>`,
      { headers: { "content-type": "text/html", "cache-control": "no-store" } },
    );
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: (addr) => resolvePort(addr.port),
  }, async (req) => {
    const url = new URL(req.url);
    hits.push(url.pathname);
    if (url.pathname === "/a") return page("Page A", "/b");
    if (url.pathname === "/b") return page("Page B", "/a");
    if (url.pathname === "/slow") {
      await new Promise((r) =>
        setTimeout(r, Number(url.searchParams.get("ms")))
      );
      return page("Slow", "/a");
    }
    return new Response("not found", { status: 404 });
  });
  return {
    // `localhost` resolves to 127.0.0.1 in Chromium (it falls back from ::1 to IPv4).
    origin: `http://localhost:${await port}`,
    hits,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------------------------

/**
 * `p`, or a rejection naming `what` after `ms` (not scaled): a page that stops answering (its
 * renderer stalled, its frames stopped) fails the step that waited on it instead of hanging the
 * suite until CI kills the job. `p` keeps running; its late result is dropped.
 */
function bounded<T>(
  p: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what}: no answer after ${ms}ms (hung)`)),
      ms,
    );
  });
  return Promise.race([p, hung]).finally(() => clearTimeout(timer));
}

/**
 * How long one page call (an eval, a click, a navigation) may take (scaled). Generous: it only
 * has to tell a hang from a slow, loaded machine.
 */
const CALL_MS = 60_000 * TIMEOUT_SCALE;

/** Poll `cond` until it returns a truthy value (which is returned); no fixed sleeps. */
export async function waitFor<T>(
  cond: () => T | Promise<T>,
  timeout = 5000,
  what = "condition",
): Promise<NonNullable<T>> {
  timeout *= TIMEOUT_SCALE;
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    // One check that never answers fails the wait. A check may be slow (one with a wait of its
    // own, a loaded machine), so it gets a page call's time past the deadline.
    const check = bounded(
      Promise.resolve().then(cond),
      Math.max(0, deadline - Date.now()) + CALL_MS,
      `waiting for ${what}: a check`,
    );
    try {
      const v = await check;
      if (v) return v as NonNullable<T>;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out after ${timeout}ms waiting for ${what} (last: ${
          last instanceof Error ? last.message : JSON.stringify(last)
        })`,
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The ids of the bar's chips (the open terminals). */
export async function chipIdSet(app: App): Promise<Set<string>> {
  return new Set((await app.chips()).map((c) => c.id));
}

/** Wait for a focused terminal that is not in `before` (a new tile) and return its id. */
export function newFocusedTile(app: App, before: Set<string>): Promise<string> {
  return waitFor(
    async () => {
      const f = await app.focusedId();
      return f && !before.has(f) ? f : null;
    },
    5000,
    "a new focused terminal",
  );
}

// ---------------------------------------------------------------------------------------------
// The app under test
// ---------------------------------------------------------------------------------------------

export interface ChipInfo {
  id: string;
  ordinal: number;
  rank: number;
  tiled: boolean;
  /** Minimized to the bar (not tiled, not overflow). */
  minimized: boolean;
  focused: boolean;
  exited: boolean;
  /** Its tile's activity state (`none`, `output`, `busy`, `attention`, `failed`, `done`). */
  activity: string;
}

export interface TileInfo {
  id: string;
  rank: number | null;
  phase: string;
  focused: boolean;
  exited: boolean;
}

export interface TerminalState {
  text: string;
  cols: number;
  rows: number;
  ptyId: string | null;
  exited: boolean;
  /** xterm's font options. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: string;
}

/** One PTY resize the backend received (`window.__e2e.resizes`). */
export interface PtyResize {
  ptyId: string;
  cols: number;
  rows: number;
}

/** A viewport rect. */
export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface OpenOptions {
  width?: number;
  height?: number;
  reducedMotion?: boolean;
  /** Extra query string (appended after `pty=demo&test=1`). */
  query?: string;
  /** Keep the origin's storage (a second page of the same app: `App.openPeer`). */
  keepStorage?: boolean;
  /**
   * Let the companion's quote of the day show (on by default in the app). Off unless asked for:
   * every other case starts as if today's quote had been shown already, so no bubble appears
   * that it does not expect.
   */
  quote?: boolean;
}

const DEFAULT_W = 1400;
const DEFAULT_H = 900;

/** What `App.click` reads back after a press: where it landed while armed for a selector. */
interface ClickGuard {
  /** The element the next press is aimed at (null: not armed, every press goes through). */
  selector: string | null;
  /** `"ok"` (the press landed on it), a description of what it landed on instead, or null. */
  landed: string | null;
  /** The last few presses and focus changes, with times: what `focusChip` reports on a timeout. */
  trace: string[];
}

/**
 * Installed in every page before the app's own scripts (so its capture listeners run before any
 * of the app's): while `App.click` has it armed for a selector, a press that lands on anything
 * but that element is swallowed whole (pointerdown through click), so it sets nothing off, and
 * `click` aims again. Between the point check and the press arriving the element can still move:
 * the chip strip's smooth scroll (`scroll-behavior: smooth`, started by the switcher bar after a
 * focus change) sits still for a frame or more before it moves, so it passes the stillness check.
 */
function clickGuardScript(): void {
  const g: ClickGuard = { selector: null, landed: null, trace: [] };
  Object.defineProperty(globalThis, "__clickGuard", { value: g });
  const note = (line: string) => {
    g.trace.push(`${performance.now().toFixed(0)} ${line}`);
    if (g.trace.length > 40) g.trace.shift();
  };
  const describe = (t: EventTarget | null) =>
    t instanceof Element
      ? `${t.tagName.toLowerCase()}.${[...t.classList].join(".")}${
        (t.closest("[data-id]") as HTMLElement | null)?.dataset.id
          ? ` in ${(t.closest("[data-id]") as HTMLElement).dataset.id}`
          : ""
      }`
      : String(t);
  for (const type of ["pointerdown", "pointerup", "click", "keydown"]) {
    addEventListener(type, (e) => {
      const at = e instanceof MouseEvent ? ` at ${e.clientX},${e.clientY}` : "";
      const key = e instanceof KeyboardEvent ? ` ${e.key}` : "";
      note(`${type}${key} on ${describe(e.target)}${at}`);
    }, true);
  }
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (el.dataset?.testid === "app") note(`focused ${el.dataset.focused}`);
    }
  }).observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-focused"],
  });
  let swallow = false;
  const block = (e: Event) => {
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  addEventListener("pointerdown", (e) => {
    swallow = false;
    if (g.selector === null) return;
    const el = document.querySelector(g.selector);
    const t = e.target;
    if (el && t instanceof Node && el.contains(t)) {
      g.landed = "ok";
      return;
    }
    g.landed = `${describe(t)} at ${e.clientX},${e.clientY}`;
    swallow = true;
    block(e);
  }, true);
  for (const type of ["mousedown", "pointerup", "mouseup", "click"]) {
    addEventListener(type, (e) => {
      if (swallow) block(e);
    }, true);
  }
}

/**
 * Installed in every page before the app's scripts unless a case asks for the quote of the day:
 * the quote counts as shown for every day to come (lib/companion/ambient.ts `claimDay`).
 */
function quietQuoteScript(key: string): void {
  try {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(
        key,
        JSON.stringify({ day: "9999-12-31", by: "e2e" }),
      );
    }
  } catch {
    // No storage: the app shows nothing either.
  }
}

/** One page of the app with helpers. Created by `suite` for every case. */
export class App {
  readonly errors: string[] = [];
  platform: "mac" | "other" = "mac";
  /**
   * How long `click` waits between aiming and pressing: a loaded CI runner's round trip, so a
   * test can make something that moves in that gap move every time.
   */
  pressDelayMs = 0;

  constructor(
    readonly page: Page,
    readonly origin: string,
    readonly opts: OpenOptions,
  ) {
    page.addEventListener("console", (e) => {
      if (e.detail.type === "error" || e.detail.type === "assert") {
        this.errors.push(`console.${e.detail.type}: ${e.detail.text}`);
      }
    });
    page.addEventListener("pageerror", (e) => {
      this.errors.push(`pageerror: ${e.detail.message}`);
    });
  }

  get url(): string {
    const q = this.opts.query ? `&${this.opts.query}` : "";
    return `${this.origin}/?pty=demo&test=1${q}`;
  }

  get cdp() {
    return this.page.unsafelyGetCelestialBindings();
  }

  /** The modifier the app's shortcuts use on this platform. */
  get mod(): "Meta" | "Control" {
    return this.platform === "mac" ? "Meta" : "Control";
  }

  async boot(): Promise<void> {
    // Every page call here is bounded: a page that stops answering fails the case in minutes.
    await bounded(this.#setUp(), CALL_MS, "setting up the page");
    await bounded(
      this.page.goto(this.url, { waitUntil: "load" }),
      CALL_MS,
      "loading the app",
    );
    await this.waitReady();
  }

  async #setUp(): Promise<void> {
    await this.page.setViewportSize({
      width: this.opts.width ?? DEFAULT_W,
      height: this.opts.height ?? DEFAULT_H,
    });
    if (!this.opts.keepStorage) {
      await this.cdp.Storage.clearDataForOrigin({
        origin: this.origin,
        storageTypes: "all",
      });
    }
    if (this.opts.reducedMotion) {
      await this.page.emulateMediaFeatures([{
        name: "prefers-reduced-motion",
        value: "reduce",
      }]);
    }
    await this.cdp.Page.addScriptToEvaluateOnNewDocument({
      source: `(${clickGuardScript.toString()})();`,
    });
    if (!this.opts.quote) {
      await this.cdp.Page.addScriptToEvaluateOnNewDocument({
        source: `(${quietQuoteScript.toString()})(${
          JSON.stringify(QUOTE_DAY_KEY)
        });`,
      });
    }
    const throttle = Number(Deno.env.get("E2E_CPU_THROTTLE") ?? "0");
    if (throttle > 1) {
      await this.cdp.Emulation.setCPUThrottlingRate({ rate: throttle });
    }
  }

  /**
   * A second page of the app in the same browser (another "window"; with `?peers=<name>` the demo
   * pages move tiles to each other, lib/demo-windows.ts), booted with its first terminal. The
   * caller closes it (`page.close()`).
   */
  async openPeer(query: string): Promise<App> {
    const page = await this.page.browser().newPage();
    const peer = new App(page, this.origin, {
      ...this.opts,
      query,
      keepStorage: true,
    });
    await peer.boot();
    return peer;
  }

  /** Wait for the app to be interactive with its first terminal at a prompt. */
  async waitReady(): Promise<void> {
    await waitFor(
      () => this.eval(() => !!(globalThis as { __e2e?: unknown }).__e2e),
      10_000,
      "the e2e hooks",
    );
    this.platform = await this.eval(() =>
      document.querySelector("[data-testid=app]")!.getAttribute(
        "data-platform",
      )
    ) as "mac" | "other";
    const id = await waitFor(
      () => this.focusedId(),
      5000,
      "a focused terminal",
    );
    await this.waitForPrompt(id);
  }

  async reload(): Promise<void> {
    await bounded(
      this.page.reload({ waitUntil: "load" }),
      CALL_MS,
      "reloading the app",
    );
    await this.waitReady();
  }

  // deno-lint-ignore no-explicit-any
  eval<T>(fn: (...args: any[]) => T, ...args: unknown[]): Promise<Awaited<T>> {
    return bounded(
      // deno-lint-ignore no-explicit-any
      this.page.evaluate(fn as any, { args: args as any }) as Promise<
        Awaited<T>
      >,
      CALL_MS,
      `page eval \`${String(fn).replace(/\s+/g, " ").slice(0, 80)}\``,
    );
  }

  /** Fail the case on any console error or uncaught page error. */
  assertNoErrors(): void {
    if (this.errors.length > 0) {
      throw new Error(`page errors:\n  ${this.errors.join("\n  ")}`);
    }
  }

  // ---- DOM reads ----------------------------------------------------------------------------

  attr(selector: string, name: string): Promise<string | null> {
    return this.eval(
      (s: string, n: string) =>
        document.querySelector(s)?.getAttribute(n) ?? null,
      selector,
      name,
    );
  }

  count(selector: string): Promise<number> {
    return this.eval(
      (s: string) => document.querySelectorAll(s).length,
      selector,
    );
  }

  exists(selector: string): Promise<boolean> {
    return this.eval((s: string) => !!document.querySelector(s), selector);
  }

  async focusedId(): Promise<string | null> {
    const v = await this.attr("[data-testid=app]", "data-focused");
    return v ? v : null;
  }

  pattern(): Promise<string | null> {
    return this.attr("[data-testid=app]", "data-pattern");
  }

  /** Chips in DOM order. */
  chips(): Promise<ChipInfo[]> {
    return this.eval(() =>
      [...document.querySelectorAll<HTMLElement>("[data-testid=chip]")].map((
        el,
      ) => ({
        id: el.dataset.id!,
        ordinal: Number(el.dataset.ordinal),
        rank: Number(el.dataset.rank),
        tiled: el.dataset.tiled === "true",
        minimized: el.dataset.minimized === "true",
        focused: el.dataset.focused === "true",
        exited: el.dataset.exited === "true",
        activity: el.dataset.activity ?? "none",
      }))
    );
  }

  /** Tiles in DOM (creation) order. */
  tiles(): Promise<TileInfo[]> {
    return this.eval(() =>
      [...document.querySelectorAll<HTMLElement>("[data-testid=tile]")].map((
        el,
      ) => ({
        id: el.dataset.id!,
        rank: el.dataset.rank === "" ? null : Number(el.dataset.rank),
        phase: el.dataset.phase!,
        focused: el.dataset.focused === "true",
        exited: el.dataset.exited === "true",
      }))
    );
  }

  /** The MRU order, read from the chips' ranks. */
  async mru(): Promise<string[]> {
    const chips = await this.chips();
    return chips.slice().sort((a, b) => a.rank - b.rank).map((c) => c.id);
  }

  /** The persisted settings (written by the app on every change), or the defaults. */
  async settings(): Promise<Settings> {
    const raw = await this.eval(
      (k: string) => localStorage.getItem(k),
      SETTINGS_STORAGE_KEY,
    );
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    return JSON.parse(raw) as Settings;
  }

  /** The cluster's content box, which is what the app hands to `computeLayout`. */
  clusterBounds(): Promise<Rect> {
    return this.eval(() => {
      const el = document.querySelector<HTMLElement>("[data-testid=cluster]")!;
      return { x: 0, y: 0, w: el.clientWidth, h: el.clientHeight };
    });
  }

  rectOf(selector: string): Promise<BoxRect | null> {
    return this.eval((s: string) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r
        ? {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          right: r.right,
          bottom: r.bottom,
        }
        : null;
    }, selector);
  }

  /** Wait until no tile is entering/leaving and every shown tile's rect is still for 3 frames. */
  async settle(timeout = 4000): Promise<void> {
    let last = "";
    await waitFor(
      async () =>
        (last = await this.eval(() =>
          new Promise<string>((resolve) => {
            const sample = () =>
              [...document.querySelectorAll<HTMLElement>("[data-testid=tile]")]
                .map((el) => {
                  const r = el.getBoundingClientRect();
                  return `${el.dataset.id}:${el.dataset.phase}:${
                    r.x.toFixed(1)
                  },${r.y.toFixed(1)},${r.width.toFixed(1)},${
                    r.height.toFixed(1)
                  }`;
                }).join("|");
            // A re-layout not applied yet (the cluster just changed size) is not settled either:
            // every shown tile must fit the cluster.
            const cluster = document.querySelector("[data-testid=cluster]")
              ?.getBoundingClientRect();
            const outside = () =>
              !!cluster &&
              [...document.querySelectorAll<HTMLElement>(
                "[data-testid=tile][data-phase=shown]",
              )].some((el) => {
                const r = el.getBoundingClientRect();
                return r.right > cluster.right + 0.5 ||
                  r.bottom > cluster.bottom + 0.5;
              });
            const busy = () =>
              outside() ||
              !!document.querySelector(
                "[data-testid=tile][data-phase=entering],[data-testid=tile][data-phase=leaving]",
              );
            const first = sample();
            let frames = 0;
            // No frame for a second: the page is not rendering (rAF never fires), say so.
            const stalled = setTimeout(
              () => resolve("no animation frame"),
              1000,
            );
            const done = (why: string) => {
              clearTimeout(stalled);
              resolve(why);
            };
            const tick = () => {
              if (busy() || sample() !== first) return done("moving");
              if (++frames >= 3) return done("settled");
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          })
        )) === "settled",
      timeout,
      "tiles to settle",
    ).catch((e) => {
      throw new Error(
        last ? `${e.message} (the page said: ${last})` : e.message,
      );
    });
  }

  /** Settled rects of the shown tiles, relative to the cluster, keyed by id. */
  async tileRects(): Promise<Record<string, Rect>> {
    await this.settle();
    return await this.rawTileRects();
  }

  rawTileRects(): Promise<Record<string, Rect>> {
    return this.eval(() => {
      const base = document.querySelector("[data-testid=tiles]")!
        .getBoundingClientRect();
      const out: Record<
        string,
        { x: number; y: number; w: number; h: number }
      > = {};
      for (
        const el of document.querySelectorAll<HTMLElement>(
          "[data-testid=tile][data-phase=shown]",
        )
      ) {
        const r = el.getBoundingClientRect();
        out[el.dataset.id!] = {
          x: r.x - base.x,
          y: r.y - base.y,
          w: r.width,
          h: r.height,
        };
      }
      return out;
    });
  }

  /**
   * What the layout engine says the tiles should be for the app's current MRU (without the
   * minimized tiles, which are never laid out) and settings.
   */
  async expectedLayout(): Promise<ReturnType<typeof computeLayout>> {
    const [chips, settings, bounds] = await Promise.all([
      this.chips(),
      this.settings(),
      this.clusterBounds(),
    ]);
    const mru = chips.filter((c) => !c.minimized).sort((a, b) =>
      a.rank - b.rank
    ).map((c) => c.id);
    return computeLayout(mru, bounds, settings.layout as LayoutOptions);
  }

  /**
   * Assert the settled tile rects equal `computeLayout(mru, clusterRect, opts)` within ±1px,
   * with the same set of tiles shown. Retries briefly (settings are persisted in an effect).
   */
  async assertLayoutMatches(tolerance = 1): Promise<void> {
    let lastMsg = "";
    await waitFor(
      async () => {
        const rects = await this.tileRects();
        const expected = await this.expectedLayout();
        const ids = Object.keys(rects).sort();
        const want = expected.tiles.map((t) => t.id).sort();
        if (ids.join() !== want.join()) {
          lastMsg = `shown tiles ${ids} != layout tiles ${want}`;
          return false;
        }
        for (const t of expected.tiles) {
          const r = rects[t.id];
          for (const k of ["x", "y", "w", "h"] as const) {
            if (Math.abs(r[k] - t.rect[k]) > tolerance) {
              lastMsg = `tile ${t.id}.${k}: dom ${r[k]} vs layout ${t.rect[k]}`;
              return false;
            }
          }
        }
        return true;
      },
      5000,
      "layout to match computeLayout",
    ).catch((e) => {
      throw new Error(`${e.message}: ${lastMsg}`);
    });
  }

  terminal(id: string): Promise<TerminalState | null> {
    return this.eval(
      (i: string) =>
        (globalThis as unknown as {
          __e2e: { terminal(id: string): unknown };
        }).__e2e.terminal(i),
      id,
    ) as Promise<TerminalState | null>;
  }

  async readTerminalText(id: string): Promise<string> {
    return (await this.terminal(id))?.text ?? "";
  }

  kills(): Promise<string[]> {
    return this.eval(
      () => [
        ...(globalThis as unknown as { __e2e: { kills: string[] } }).__e2e
          .kills,
      ],
    );
  }

  /** Every PTY resize the backend was asked for, in order. */
  resizes(): Promise<PtyResize[]> {
    return this.eval(
      () => [
        ...(globalThis as unknown as { __e2e: { resizes: PtyResize[] } })
          .__e2e.resizes,
      ],
    );
  }

  async waitForText(
    id: string,
    match: string | RegExp,
    timeout = 5000,
  ): Promise<string> {
    return await waitFor(
      async () => {
        const text = await this.readTerminalText(id);
        const ok = typeof match === "string"
          ? text.includes(match)
          : match.test(text);
        return ok ? text : "";
      },
      timeout,
      `terminal ${id} to show ${match}`,
    );
  }

  /** Count of prompt lines (`demo:~$`) in a terminal. */
  async promptCount(id: string): Promise<number> {
    const text = await this.readTerminalText(id);
    return text.split("\n").filter((l) => /^demo:\S*\$/.test(l)).length;
  }

  async waitForPrompt(id: string, timeout = 5000): Promise<void> {
    await waitFor(
      async () => {
        const s = await this.terminal(id);
        return !!s?.ptyId && /demo:\S*\$/.test(s.text);
      },
      timeout,
      `a prompt in ${id}`,
    );
  }

  /** The current (last non-empty) line of a terminal. */
  async lastLine(id: string): Promise<string> {
    const lines = (await this.readTerminalText(id)).split("\n").filter((l) =>
      l.trim() !== ""
    );
    return lines.at(-1) ?? "";
  }

  // ---- Input ------------------------------------------------------------------------------

  /**
   * A real mouse click at the centre of the element (scrolled into view first). The press must
   * land on that element: one that lands elsewhere because something moved under the point after
   * it was checked is swallowed by the page's click guard (`clickGuardScript`) and aimed again.
   */
  async click(selector: string): Promise<void> {
    let landed: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const pt = await this.#clickablePoint(selector);
      const armed = await this.eval((s: string) => {
        const g = (globalThis as { __clickGuard?: ClickGuard }).__clickGuard;
        if (!g) return false;
        g.selector = s;
        g.landed = null;
        return true;
      }, selector);
      if (this.pressDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.pressDelayMs));
      }
      await this.page.mouse.click(pt.x, pt.y);
      if (!armed) return;
      landed = await this.eval(() => {
        const g = (globalThis as { __clickGuard?: ClickGuard }).__clickGuard;
        if (!g) return "ok";
        g.selector = null;
        return g.landed ?? "nothing";
      });
      if (landed === "ok") return;
      console.warn(
        `e2e: a click on ${selector} landed on ${landed}; aiming again`,
      );
    }
    throw new Error(
      `clicking ${selector}: the press kept landing elsewhere (last on ${landed})`,
    );
  }

  /**
   * A click held as a person holds one: press on `selector` once it is clickable, wait `holdMs`
   * (whatever the press set off, such as a tile moving, happens meanwhile), then release at the
   * same point. `click()` presses and releases at once, before anything can move.
   */
  async slowClick(selector: string, holdMs = 250): Promise<void> {
    const pt = await this.#clickablePoint(selector);
    const mouse = this.page.mouse;
    await mouse.move(pt.x, pt.y);
    await mouse.down();
    await new Promise((r) => setTimeout(r, holdMs));
    await mouse.up();
  }

  /** Where to click `selector`: its centre, once it has stopped moving and nothing covers it. */
  async #clickablePoint(selector: string): Promise<{ x: number; y: number }> {
    // Wait until the element stops moving (chips glide with FLIP, tiles transition) so the
    // click lands on it and not on whatever is passing under that point.
    const pt = await waitFor(
      () =>
        this.eval(
          (s: string) =>
            new Promise<{ x: number; y: number } | null>((resolve) => {
              const el = document.querySelector(s);
              if (!el) return resolve(null);
              // A running transition/animation on the element or an ancestor (a chip's FLIP glide,
              // a tile's re-layout) means it is about to move, even if two frames look alike. One
              // that only paints (a tile's activity shimmer or fading tint) moves nothing.
              const MOVES =
                /^(transform|translate|scale|rotate|width|height|top|left|right|bottom|opacity)$/;
              const moving = () =>
                document.getAnimations().some((a) => {
                  const fx = a.effect as KeyframeEffect | null;
                  const t = fx?.target;
                  return a.playState === "running" && !!t &&
                    (t === el || t.contains(el)) &&
                    fx!.getKeyframes().some((k) =>
                      Object.keys(k).some((p) => MOVES.test(p))
                    );
                });
              if (moving()) return resolve(null);
              // Instant: the chip strip scrolls smoothly, and re-polling would restart that.
              el.scrollIntoView({
                block: "nearest",
                inline: "nearest",
                behavior: "instant",
              });
              const a = el.getBoundingClientRect();
              // No frame for a second (the page is not rendering): not clickable yet.
              const stalled = setTimeout(() => resolve(null), 1000);
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  clearTimeout(stalled);
                  const b = el.getBoundingClientRect();
                  const still = Math.abs(a.x - b.x) < 0.5 &&
                    Math.abs(a.y - b.y) < 0.5 &&
                    Math.abs(a.width - b.width) < 0.5;
                  if (!still || moving() || b.width === 0 || b.height === 0) {
                    return resolve(null);
                  }
                  const x = b.x + b.width / 2;
                  const y = b.y + b.height / 2;
                  // Something else on top (a menu, the settings panel) would take the click.
                  const top = document.elementFromPoint(x, y);
                  if (!top || !(top === el || el.contains(top))) {
                    return resolve(null);
                  }
                  resolve({ x, y });
                })
              );
            }),
          selector,
        ),
      4000,
      `${selector} to be clickable`,
    );
    return pt;
  }

  /** Pick `value` in the `<select>` at `selector` (as the user would: input, then change). */
  async choose(selector: string, value: string): Promise<void> {
    await this.eval(
      (s: string, v: string) => {
        const el = document.querySelector<HTMLSelectElement>(s)!;
        el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      },
      selector,
      value,
    );
  }

  /** A real click at a viewport point. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }

  /** Press a key with the platform modifier (and Shift) held: `shortcut("KeyT")`. */
  async shortcut(key: string, opts: { shift?: boolean } = {}): Promise<void> {
    const kb = this.page.keyboard;
    // deno-lint-ignore no-explicit-any
    const k = key as any;
    await kb.down(this.mod);
    if (opts.shift) await kb.down("Shift");
    await kb.press(k);
    if (opts.shift) await kb.up("Shift");
    await kb.up(this.mod);
  }

  /** Press a plain key (`Enter`, `Escape`, `Backspace`, ...). */
  // deno-lint-ignore no-explicit-any
  press(key: any): Promise<void> {
    return this.page.keyboard.press(key);
  }

  /** Ctrl+<key>, independent of the platform. */
  async ctrl(key: string): Promise<void> {
    const kb = this.page.keyboard;
    await kb.down("Control");
    // deno-lint-ignore no-explicit-any
    await kb.press(key as any);
    await kb.up("Control");
  }

  /** Whether keyboard focus is inside terminal `id`'s xterm. */
  xtermHasFocus(id: string): Promise<boolean> {
    return this.eval((i: string) => {
      const host = document.querySelector(
        `[data-testid=tile][data-id="${i}"] [data-testid=tile-body]`,
      );
      return !!host && !!document.activeElement &&
        host.contains(document.activeElement);
    }, id);
  }

  /** Focus terminal `id` (through its chip unless it already is) and its xterm textarea. */
  async focusTerminalInput(id: string): Promise<void> {
    if ((await this.focusedId()) !== id) await this.focusChip(id);
    await this.eval((i: string) => {
      document.querySelector<HTMLTextAreaElement>(
        `[data-testid=tile][data-id="${i}"] .xterm-helper-textarea`,
      )?.focus();
    }, id);
    await waitFor(() => this.xtermHasFocus(id), 3000, `xterm ${id} focus`);
  }

  /** Type into terminal `id`; `\n` presses Enter. */
  async typeInTerminal(id: string, text: string): Promise<void> {
    await this.focusTerminalInput(id);
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) await this.page.keyboard.type(parts[i]);
      if (i < parts.length - 1) await this.page.keyboard.press("Enter");
    }
  }

  /** Type a command, press Enter and wait for the next prompt. */
  async run(id: string, command: string, timeout = 5000): Promise<string> {
    const before = await this.promptCount(id);
    await this.typeInTerminal(id, command + "\n");
    await waitFor(
      async () => (await this.promptCount(id)) > before,
      timeout,
      `"${command}" to finish in ${id}`,
    );
    return this.readTerminalText(id);
  }

  // ---- Actions ----------------------------------------------------------------------------

  /** Create a terminal (via the + button or the shortcut); returns its id once at a prompt. */
  async newTerminal(via: "button" | "shortcut" = "button"): Promise<string> {
    const before = new Set((await this.chips()).map((c) => c.id));
    if (via === "button") await this.click("[data-testid=bar-new]");
    else await this.shortcut("KeyT");
    const id = await waitFor(
      async () => {
        const f = await this.focusedId();
        return f && !before.has(f) ? f : null;
      },
      5000,
      "a new focused terminal",
    );
    // A terminal past maxVisible never attaches until it is shown, but a new one is focused
    // and therefore always tiled.
    await this.waitForPrompt(id);
    return id;
  }

  /** Create terminals until there are `n`. Returns all ids in creation order. */
  async ensureTerminals(n: number): Promise<string[]> {
    while ((await this.count("[data-testid=chip]")) < n) {
      await this.newTerminal();
    }
    return (await this.tiles()).map((t) => t.id);
  }

  /**
   * Wait until every chip whose shell is running shows its read title, not the "shell"
   * placeholder a terminal starts with. The title is read a moment after the spawn (a terminal
   * that was never shown has not spawned, and keeps the placeholder) and widens the chip, which
   * moves its close button and every chip after it: a click aimed before that lands elsewhere.
   */
  async waitForChipTitles(): Promise<void> {
    await waitFor(
      () =>
        this.eval(() => {
          const e2e = (globalThis as unknown as {
            __e2e: { terminal(id: string): { ptyId?: string } | null };
          }).__e2e;
          return [
            ...document.querySelectorAll<HTMLElement>(
              "[data-testid=chip][data-exited=false]",
            ),
          ].every((chip) =>
            !e2e.terminal(chip.dataset.id!)?.ptyId ||
            chip.querySelector(".chip-title")?.textContent !== "shell"
          );
        }),
      3000,
      "the chips' titles",
    );
  }

  /** Click the close button on terminal `id`'s chip, once the chips have their titles. */
  async closeChip(id: string): Promise<void> {
    await this.waitForChipTitles();
    await this.click(
      `[data-testid=chip][data-id="${id}"] [data-testid=chip-close]`,
    );
  }

  /** Click terminal `id`'s chip (once the chips have their titles) and wait until it is focused. */
  async focusChip(id: string): Promise<void> {
    await this.waitForChipTitles();
    await this.click(`[data-testid=chip][data-id="${id}"] .chip-title`);
    try {
      await waitFor(
        async () => (await this.focusedId()) === id,
        3000,
        `${id} to be focused`,
      );
    } catch (err) {
      // A flake seen only on loaded CI runners: say what the page saw, press by press.
      const trace = await this.eval(() =>
        (globalThis as { __clickGuard?: ClickGuard }).__clickGuard?.trace ?? []
      ).catch(() => []);
      throw new Error(
        `${(err as Error).message}\n  page trace:\n    ${trace.join("\n    ")}`,
      );
    }
  }

  /** Open the Settings dialog (from the bar's button), on `tab` when given. */
  async openSettings(tab?: SettingsTab): Promise<void> {
    if (!(await this.exists("[data-testid=settings-panel]"))) {
      await this.click("[data-testid=bar-settings]");
    }
    await waitFor(
      () => this.exists("[data-testid=settings-panel]"),
      2000,
      "the settings panel",
    );
    if (tab) await this.settingsTab(tab);
  }

  /** Show Settings tab `tab` (the dialog must be open): click it unless it is shown already. */
  async settingsTab(tab: SettingsTab): Promise<void> {
    const panel = `[data-testid=settings-category][data-tab="${tab}"]`;
    const shown = () =>
      this.eval((s: string) => {
        const el = document.querySelector<HTMLElement>(s);
        return !!el && !el.hidden &&
          !document.querySelector(".settings-content.is-searching");
      }, panel);
    if (!(await shown())) {
      await this.click(`[data-testid=settings-tab][data-tab="${tab}"]`);
    }
    await waitFor(shown, 2000, `the ${tab} settings tab`);
  }

  async closeSettings(): Promise<void> {
    if (await this.exists("[data-testid=settings-panel]")) {
      await this.click("[data-testid=settings-close]");
    }
    await waitFor(
      async () => !(await this.exists("[data-testid=settings-panel]")),
      2000,
      "the settings panel to close",
    );
  }

  /** Set a range input in the settings panel and fire `input` (the panel must be open). */
  async setSlider(
    key: "decay" | "masterRatio" | "maxVisible" | "gap",
    value: number,
  ): Promise<void> {
    await this.openSettings("layout");
    await this.eval(
      (k: string, v: number) => {
        const el = document.querySelector<HTMLInputElement>(
          `[data-testid=setting-${k}]`,
        )!;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      },
      key,
      value,
    );
    await waitFor(
      async () => (await this.settings()).layout[key] === value,
      2000,
      `${key} = ${value}`,
    );
  }

  /** Pick a pattern through the settings panel. */
  async setPatternViaSettings(pattern: string): Promise<void> {
    await this.openSettings("layout");
    await this.click(
      `[data-testid=setting-pattern][data-pattern="${pattern}"]`,
    );
    await waitFor(
      async () => (await this.pattern()) === pattern,
      2000,
      pattern,
    );
  }

  async setBarPosition(position: string): Promise<void> {
    await this.openSettings("general");
    await this.click(
      `[data-testid=setting-bar-position][data-value="${position}"]`,
    );
    await waitFor(
      async () =>
        (await this.attr("[data-testid=bar]", "data-position")) === position,
      2000,
      `bar at ${position}`,
    );
  }

  async setBarOrder(order: "mru" | "created"): Promise<void> {
    await this.openSettings("general");
    await this.click(`[data-testid=setting-bar-order][data-value="${order}"]`);
    await waitFor(
      async () => (await this.settings()).barOrder === order,
      2000,
      `bar order ${order}`,
    );
  }

  async setInactiveTiles(mode: "resize" | "scale"): Promise<void> {
    await this.openSettings("appearance");
    await this.click(
      `[data-testid=setting-inactive-tiles][data-value="${mode}"]`,
    );
    await waitFor(
      async () => (await this.settings()).inactiveTiles === mode,
      2000,
      `inactive tiles ${mode}`,
    );
  }

  /** Tag terminal `id`'s xterm element with a JS property (for never-remount checks). */
  tagXterm(id: string, tag: string): Promise<boolean> {
    return this.eval(
      (i: string, t: string) => {
        const el = document.querySelector(
          `[data-testid=tile][data-id="${i}"] .xterm`,
        ) as (HTMLElement & { __e2eTag?: string }) | null;
        if (!el) return false;
        el.__e2eTag = t;
        return true;
      },
      id,
      tag,
    );
  }

  xtermTag(id: string): Promise<string | null> {
    return this.eval((i: string) => {
      const el = document.querySelector(
        `[data-testid=tile][data-id="${i}"] .xterm`,
      ) as (HTMLElement & { __e2eTag?: string }) | null;
      return el?.__e2eTag ?? null;
    }, id);
  }

  async screenshot(path: string): Promise<Uint8Array> {
    const png = await this.page.screenshot({ format: "png" });
    await Deno.writeFile(path, png);
    return png;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.page.setViewportSize({ width, height });
    await waitFor(
      () =>
        this.eval(
          (w: number, h: number) => innerWidth === w && innerHeight === h,
          width,
          height,
        ),
      3000,
      `viewport ${width}x${height}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------------------------

export type CaseFn = (app: App) => Promise<void>;

/** How long one case may run, start to finish (scaled): a hang fails it, the suite goes on. */
const CASE_MS = 120_000 * TIMEOUT_SCALE;

/** How long Chromium may take to come up and answer (scaled); it normally takes a second or two. */
const LAUNCH_MS = 20_000 * TIMEOUT_SCALE;

/**
 * Set by the e2e runner (tests/e2e/run.ts) for each file it runs: every Chromium profile folder
 * of that run carries it, so the runner can kill exactly that file's browsers after a timeout.
 */
const PROFILE_TAG = Deno.env.get("E2E_PROFILE_TAG") ?? "";

/** A Chromium this harness launched: its process, profile folder and the tail of its stderr. */
interface Launched {
  child: Deno.ChildProcess;
  profile: string;
  stderr: string[];
}

const launched = new WeakMap<Browser, Launched>();

/**
 * Drain Chromium's stderr for as long as it runs (a pipe nobody reads fills up and blocks the
 * browser's next write), keeping the last lines for a failure report. Resolves with the DevTools
 * endpoint once Chromium prints it (null if it exits first).
 */
function drainStderr(
  child: Deno.ChildProcess,
  tail: string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = "";
    let found = false;
    const line = (l: string) => {
      tail.push(l);
      if (tail.length > 30) tail.shift();
      const ws = l.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
      if (ws && !found) {
        found = true;
        resolve(ws);
      }
    };
    (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of child.stderr) {
          buf += decoder.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            line(buf.slice(0, nl).trimEnd());
            buf = buf.slice(nl + 1);
          }
        }
      } catch {
        // The pipe closed under us (the browser was killed).
      }
      if (buf) line(buf.trimEnd());
      if (!found) resolve(null);
    })();
  });
}

/** A WebSocket once it is open; rejects if it errors or closes first. */
function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`DevTools socket ${url} failed`));
    ws.onclose = () => reject(new Error(`DevTools socket ${url} closed`));
  });
}

/**
 * Chromium, launched within a bound. Astral's `launch` stops reading the browser's stderr once it
 * has the endpoint, and its steps (the wait for the endpoint, the `/json/version` fetch, the
 * socket's open) have no bound of their own, so the harness starts the process itself and hands
 * it to astral's `Browser`. A launch that does not come up is killed, and its error carries the
 * browser's last stderr lines.
 */
async function launchBrowser(): Promise<Browser> {
  // E2E_CHROME: a Chromium of the system's own (Astral downloads none for Linux on ARM).
  const path = Deno.env.get("E2E_CHROME") || await getBinary("chrome");
  const profile = Deno.makeTempDirSync({
    prefix: `gui-terminal-e2e-chrome-${PROFILE_TAG ? `${PROFILE_TAG}-` : ""}`,
  });
  const args = generateBinArgs("chrome", {
    headless: true,
    args: [
      MOTION_FLAG,
      `--user-data-dir=${profile}`,
      ...(Deno.env.get("E2E_CHROME") ? ["--no-sandbox"] : []),
    ],
  });
  const child = new Deno.Command(path, {
    args,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const record: Launched = { child, profile, stderr: [] };
  const endpoint = drainStderr(child, record.stderr);
  const started = Date.now();
  try {
    return await bounded(
      (async () => {
        const ws = await endpoint;
        if (!ws) throw new Error("Chromium exited before it listened");
        const b = new Browser(await openSocket(ws), child, {
          headless: true,
          product: "chrome",
        });
        launched.set(b, record);
        return b;
      })(),
      LAUNCH_MS,
      "launching Chromium",
    );
  } catch (e) {
    await killLaunched(record);
    throw new Error(
      `${e instanceof Error ? e.message : e} (after ${
        Date.now() - started
      }ms); Chromium's last stderr lines:\n    ${record.stderr.join("\n    ")}`,
    );
  }
}

/** Kill a launched Chromium (its renderers go with it) and remove its profile. */
async function killLaunched(record: Launched): Promise<void> {
  try {
    record.child.kill("SIGKILL");
  } catch {
    // Exited already.
  }
  await bounded(record.child.status, 10_000, "Chromium exiting").catch(
    () => {},
  );
  // Helpers that outlived the main process carry the profile path, which is this browser's alone.
  await new Deno.Command("pkill", {
    args: ["-9", "-f", `--user-data-dir=${record.profile}`],
  }).output().catch(() => {});
  await Deno.remove(record.profile, { recursive: true }).catch(() => {});
}

/** Close a browser that may not answer any more: bounded, then killed (with its renderers). */
async function closeBrowser(browser: Browser): Promise<void> {
  const ok = await bounded(browser.close(), CALL_MS / 4, "closing Chromium")
    .then(() => true, (e) => {
      console.error(`e2e: ${e instanceof Error ? e.message : e}; killing it`);
      return false;
    });
  const record = launched.get(browser);
  if (!record) return;
  if (!ok) await killLaunched(record);
  else await Deno.remove(record.profile, { recursive: true }).catch(() => {});
}

interface Case {
  name: string;
  fn: CaseFn;
  opts: OpenOptions;
}

/**
 * One Deno.test per suite (file); every case is a step with its own fresh page. The browser is
 * launched once per suite.
 */
export function suite(
  name: string,
  define: (
    test: (name: string, fn: CaseFn, opts?: OpenOptions) => void,
  ) => void,
): void {
  const cases: Case[] = [];
  define((n, fn, opts = {}) => cases.push({ name: n, fn, opts }));
  const filter = Deno.env.get("E2E_FILTER");

  Deno.test({
    name: `e2e: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn(t) {
      const dir = await buildSite();
      const server = await serve(dir);
      let browser: Browser | undefined;
      let launchFailures = 0;
      try {
        for (const c of cases) {
          await t.step({
            name: c.name,
            ignore: !!filter && !c.name.includes(filter),
            sanitizeOps: false,
            sanitizeResources: false,
            fn: async () => {
              const started = Date.now();
              try {
                await runCase(c);
              } catch (e) {
                // Said at once, not only in the summary at the end: a job cancelled later (its
                // time limit) would never print it.
                console.error(
                  `e2e: FAILED "${c.name}" after ${
                    ((Date.now() - started) / 1000).toFixed(1)
                  }s: ${e instanceof Error ? e.stack ?? e.message : e}`,
                );
                throw e;
              }
            },
          });
        }
      } finally {
        if (browser) await closeBrowser(browser);
        await server.close();
      }

      /**
       * The suite's browser, launched if there is none (each case after a failure starts in a
       * fresh one). A launch that fails is tried once more; once two in a row have failed, every
       * later case fails at once instead of waiting out launches that will not come up either.
       */
      async function getBrowser(): Promise<Browser> {
        if (browser) return browser;
        if (launchFailures >= 2) {
          throw new Error(
            "Chromium failed to launch twice in a row earlier in this file (see above); not trying again",
          );
        }
        for (;;) {
          try {
            browser = await launchBrowser();
            launchFailures = 0;
            return browser;
          } catch (e) {
            launchFailures++;
            console.error(`e2e: ${e instanceof Error ? e.message : e}`);
            if (launchFailures >= 2) throw e;
          }
        }
      }

      async function runCase(c: Case): Promise<void> {
        let page: Page | undefined;
        let ok = false;
        try {
          // A page that never opens is the browser's stall, not the app's: once, the case gets a
          // fresh browser instead (a second stall fails it).
          page = await bounded(
            (await getBrowser()).newPage(),
            CALL_MS,
            "opening a page",
          ).catch(async (e) => {
            console.error(`e2e: ${e.message}; retrying in a fresh browser`);
            const old = browser!;
            browser = undefined;
            await closeBrowser(old);
            return bounded(
              (await getBrowser()).newPage(),
              CALL_MS,
              "opening a page (in a fresh browser)",
            );
          });
          const app = new App(page, server.origin, c.opts);
          await bounded(
            (async () => {
              await app.boot();
              await c.fn(app);
            })(),
            CASE_MS,
            `case "${c.name}"`,
          );
          app.assertNoErrors();
          ok = true;
        } finally {
          const closed = page !== undefined && await bounded(
            page.close(),
            CALL_MS,
            "closing the page",
          ).then(() => true, () => false);
          // After a failure (a stalled page, a case still running after its bound) the next page
          // could land in the same stuck renderer, or meet the failed case's leftovers: start the
          // next case in a fresh browser.
          if ((!ok || !closed) && browser) {
            const old = browser;
            browser = undefined;
            await closeBrowser(old);
          }
        }
      }
    },
  });
}
