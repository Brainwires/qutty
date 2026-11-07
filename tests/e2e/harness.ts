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

import { type Browser, launch, type Page } from "@astral/astral";
import { contentType } from "@std/media-types";
import { copy } from "@std/fs";
import { extname, fromFileUrl, join } from "@std/path";
import {
  computeLayout,
  type LayoutOptions,
  type Rect,
} from "../../lib/layout/mod.ts";
import {
  DEFAULT_SETTINGS,
  type Settings,
  SETTINGS_STORAGE_KEY,
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
  focused: boolean;
  exited: boolean;
  activity: boolean;
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
}

const DEFAULT_W = 1400;
const DEFAULT_H = 900;

/** One page of the app with helpers. Created by `suite` for every case. */
export class App {
  readonly errors: string[] = [];
  platform: "mac" | "other" = "mac";

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
    await this.page.setViewportSize({
      width: this.opts.width ?? DEFAULT_W,
      height: this.opts.height ?? DEFAULT_H,
    });
    await this.cdp.Storage.clearDataForOrigin({
      origin: this.origin,
      storageTypes: "all",
    });
    if (this.opts.reducedMotion) {
      await this.page.emulateMediaFeatures([{
        name: "prefers-reduced-motion",
        value: "reduce",
      }]);
    }
    await this.page.goto(this.url, { waitUntil: "load" });
    await this.waitReady();
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
    await this.page.reload({ waitUntil: "load" });
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
        focused: el.dataset.focused === "true",
        exited: el.dataset.exited === "true",
        activity: el.dataset.activity === "true",
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

  /** What the layout engine says the tiles should be for the app's current MRU and settings. */
  async expectedLayout(): Promise<ReturnType<typeof computeLayout>> {
    const [mru, settings, bounds] = await Promise.all([
      this.mru(),
      this.settings(),
      this.clusterBounds(),
    ]);
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

  /** A real mouse click at the centre of the element (scrolled into view first). */
  async click(selector: string): Promise<void> {
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
              // a tile's re-layout) means it is about to move, even if two frames look alike.
              const moving = () =>
                document.getAnimations().some((a) => {
                  const t = (a.effect as KeyframeEffect | null)?.target;
                  return a.playState === "running" && !!t &&
                    (t === el || t.contains(el));
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
    await this.page.mouse.click(pt.x, pt.y);
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

  /** Click terminal `id`'s chip and wait until it is focused. */
  async focusChip(id: string): Promise<void> {
    await this.click(`[data-testid=chip][data-id="${id}"] .chip-title`);
    await waitFor(
      async () => (await this.focusedId()) === id,
      3000,
      `${id} to be focused`,
    );
  }

  async openSettings(): Promise<void> {
    if (!(await this.exists("[data-testid=settings-panel]"))) {
      await this.click("[data-testid=bar-settings]");
    }
    await waitFor(
      () => this.exists("[data-testid=settings-panel]"),
      2000,
      "the settings panel",
    );
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
    await this.openSettings();
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
    await this.openSettings();
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
    await this.openSettings();
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
    await this.openSettings();
    await this.click(`[data-testid=setting-bar-order][data-value="${order}"]`);
    await waitFor(
      async () => (await this.settings()).barOrder === order,
      2000,
      `bar order ${order}`,
    );
  }

  async setInactiveTiles(mode: "resize" | "scale"): Promise<void> {
    await this.openSettings();
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
const CASE_MS = 300_000 * TIMEOUT_SCALE;

/** Chromium, launched within a bound; one that comes up after the bound is closed again. */
function launchBrowser(): Promise<Browser> {
  const profile = Deno.makeTempDirSync({ prefix: "gui-terminal-e2e-chrome-" });
  const launching = launch({
    headless: true,
    args: [MOTION_FLAG, `--user-data-dir=${profile}`],
  }).then((b) => {
    profiles.set(b, profile);
    return b;
  });
  return bounded(launching, 2 * CALL_MS, "launching Chromium").catch((e) => {
    launching.then((late) => closeBrowser(late), () => {});
    throw e;
  });
}

/** Each launched browser's profile folder: its processes carry it, so a wedged one can be killed. */
const profiles = new WeakMap<Browser, string>();

/** Close a browser that may not answer any more: bounded, then killed (with its renderers). */
async function closeBrowser(browser: Browser): Promise<void> {
  const ok = await bounded(browser.close(), CALL_MS / 4, "closing Chromium")
    .then(() => true, (e) => {
      console.error(`e2e: ${e instanceof Error ? e.message : e}; killing it`);
      return false;
    });
  const profile = profiles.get(browser);
  if (!ok && profile) {
    await new Deno.Command("pkill", {
      args: ["-9", "-f", `--user-data-dir=${profile}`],
    }).output().catch(() => {});
  }
  if (profile) await Deno.remove(profile, { recursive: true }).catch(() => {});
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
      try {
        for (const c of cases) {
          await t.step({
            name: c.name,
            ignore: !!filter && !c.name.includes(filter),
            sanitizeOps: false,
            sanitizeResources: false,
            fn: async () => {
              browser ??= await launchBrowser();
              let page: Page | undefined;
              let ok = false;
              try {
                // A page that never opens is the browser's stall, not the app's: once, the case
                // gets a fresh browser instead (a second stall fails it).
                page = await bounded(
                  browser.newPage(),
                  CALL_MS,
                  "opening a page",
                ).catch(async (e) => {
                  console.error(
                    `e2e: ${e.message}; retrying in a fresh browser`,
                  );
                  const old = browser!;
                  browser = undefined;
                  await closeBrowser(old);
                  browser = await launchBrowser();
                  return bounded(
                    browser.newPage(),
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
                // After a failure (a stalled page) the next page could land in the same stuck
                // renderer: start the next case in a fresh browser.
                if (!ok || !closed) {
                  const old = browser;
                  browser = undefined;
                  await closeBrowser(old);
                }
              }
            },
          });
        }
      } finally {
        if (browser) await closeBrowser(browser);
        await server.close();
      }
    },
  });
}
