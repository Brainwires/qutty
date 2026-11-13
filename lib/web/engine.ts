/**
 * The web tile's engine adapter: what a web tile (app/web-tile.tsx) drives to show a page, kept
 * narrow and backend-agnostic so the engine behind it is one file.
 *
 * The interface mirrors Denext's draft embedded web view (`denext/desktop/window`
 * `createWebView` → `WebViewHandle`: navigate, back, forward, reload, stop, setVisible, focus,
 * state, close; the events title, url, load, focus-change, closed), so the coming
 * `NativeEngine` is a thin wrapper over it. Nothing here imports that API yet: it does not exist.
 *
 * Today's engine is {@linkcode IframeEngine}: a sandboxed `<iframe>` inside the tile's body.
 * {@linkcode webEngine} is the one selection point ("native if `webViewCapabilities().supported`,
 * else iframe").
 *
 * Bounds: a view follows the element it is mounted in (`mount(host, …)`), and that is the only
 * place bounds are handled. The iframe simply sits in the element (CSS fills it). The native
 * engine will hand the element to Denext's `attachWebView(handle, el)`, which follows it through
 * layout, scale transforms, scroll and devicePixelRatio changes (at most one `setBounds` per
 * frame) and hides the view while the element is out of the DOM or `display: none`.
 *
 * Overlays: a native view draws above all HTML. `capabilities.drawsAboveHtml` tells the tile to
 * hide it (`setVisible(false)`) while an HTML menu or dialog is open (lib/web/overlays.ts).
 *
 * Client-safe: DOM APIs are used only inside `mount`.
 *
 * @module
 */

import { canEmbedInFrame, parseWebUrl } from "./url.ts";
import {
  canGoBack,
  canGoForward,
  currentUrl,
  goBack,
  goForward,
  pushUrl,
  startHistory,
  type WebHistory,
} from "./history.ts";

/** Where a page load is (Denext's `WebViewLoadState`). */
export type WebLoadState = "loading" | "interactive" | "complete" | "failed";

/** What a view reports (a subset of Denext's `WebViewEventMap`, same names and shapes). */
export interface WebViewEventMap {
  title: { title: string };
  url: { url: string; canGoBack: boolean; canGoForward: boolean };
  load: {
    state: WebLoadState;
    url: string;
    error?: { code: string; message: string };
  };
  "focus-change": { focused: boolean };
  closed: Record<string, never>;
}

/** A view's state at once (Denext's `WebViewHandle.state()`). */
export interface WebViewState {
  url: string;
  /** Empty when the engine cannot read it. */
  title: string;
  load: WebLoadState;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** What an engine can do. */
export interface WebEngineCapabilities {
  engine: "iframe" | "native";
  /** The view is a native layer above all HTML: hide it while an HTML overlay is open. */
  drawsAboveHtml: boolean;
  /** It reports the page's own title and the navigations the page makes itself. */
  readsPage: boolean;
  /** `capture()` (a snapshot of the page); not part of this interface until it is needed. */
  capture: boolean;
  /** `evaluate()` (run script in the page); not part of this interface until it is needed. */
  evaluate: boolean;
}

/** One page view (Denext's `WebViewHandle`, minus `capture`, `evaluate` and `setBounds`). */
export interface WebViewHandle {
  /** Go to `url` (http or https; anything else is refused). */
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(options?: { ignoreCache?: boolean }): Promise<void>;
  stop(): Promise<void>;
  /** Show or hide the view (it keeps its page). */
  setVisible(visible: boolean): Promise<void>;
  /**
   * Another tile overlaps this view's tile and is drawn above it (the free-form view; the tile
   * computes it with `occludedIds`, lib/workspace/freeform.ts, and calls this on each change).
   *
   * TODO(native engine): a native view draws above all HTML, so a terminal tile on top of a web
   * tile would sit under its page. The native engine answers this with Denext's coming web view
   * stacking: `capture()` the page into an `<img>` in the element and `setVisible(false)` while
   * occluded (the snapshot swap), or `raise()` / `lower()` / `setZOrder(n)` once views can be
   * ordered among the tiles. The iframe is ordinary HTML that stacks with the tiles: it ignores it.
   */
  setOccluded(occluded: boolean): Promise<void>;
  /** Give the page the keyboard. */
  focus(): Promise<void>;
  state(): Promise<WebViewState>;
  on<K extends keyof WebViewEventMap>(
    event: K,
    fn: (ev: WebViewEventMap[K]) => void,
  ): () => void;
  /** Close the view for good (it emits `closed`). */
  close(): Promise<void>;
}

/** An engine: which pages it can show, and a view of one inside an element. */
export interface WebEngine {
  readonly capabilities: WebEngineCapabilities;
  /** Whether this engine can show `url` (else it goes to the default browser). */
  canEmbed(url: string): boolean;
  /** Open `url` in a view that follows `host` (its bounds and visibility). */
  mount(host: HTMLElement, url: string): Promise<WebViewHandle>;
}

/** The iframe's sandbox: scripts, forms, popups, dialogs and downloads, no top navigation. */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

type Listeners = { [K in keyof WebViewEventMap]?: Set<(ev: never) => void> };

/**
 * A page in a sandboxed `<iframe>`.
 *
 * What a cross-origin frame hides from its parent: its URL, its title and its history. So this
 * view keeps its own back/forward list (lib/web/history.ts) from the navigations it starts, and
 * reports that list's URL; navigations the page makes itself (a click on one of its links) are
 * not seen, and the title stays empty (the tile shows the host). Every navigation it starts
 * loads a fresh `<iframe>` rather than setting `src`, so the page adds nothing to Qutty's own
 * session history.
 *
 * No message bridge exists between the frame and the app, and none may be added: the desktop
 * runtime takes bridge calls from the main frame only.
 */
class IframeView implements WebViewHandle {
  readonly #host: HTMLElement;
  #frame: HTMLIFrameElement | null = null;
  #history: WebHistory;
  #load: WebLoadState = "loading";
  #title = "";
  #focused = false;
  #closed = false;
  readonly #listeners: Listeners = {};
  readonly #offs: (() => void)[] = [];

  constructor(host: HTMLElement, url: string) {
    this.#host = host;
    this.#history = startHistory(url);
    this.#open(url);
    // A click inside a cross-origin frame never reaches the page's own listeners: the window
    // losing focus to the frame is the only sign of it.
    const onWindowBlur = () =>
      setTimeout(() =>
        this.#setFocused(document.activeElement === this.#frame)
      );
    const onFocusIn = (e: FocusEvent) => {
      if (e.target !== this.#frame) this.#setFocused(false);
    };
    const onWindowFocus = () =>
      this.#setFocused(document.activeElement === this.#frame);
    globalThis.addEventListener("blur", onWindowBlur);
    globalThis.addEventListener("focus", onWindowFocus);
    document.addEventListener("focusin", onFocusIn, true);
    this.#offs.push(
      () => globalThis.removeEventListener("blur", onWindowBlur),
      () => globalThis.removeEventListener("focus", onWindowFocus),
      () => document.removeEventListener("focusin", onFocusIn, true),
    );
  }

  #emit<K extends keyof WebViewEventMap>(event: K, ev: WebViewEventMap[K]) {
    for (const fn of this.#listeners[event] ?? []) {
      (fn as (e: WebViewEventMap[K]) => void)(ev);
    }
  }

  #setFocused(focused: boolean): void {
    if (this.#closed || focused === this.#focused) return;
    this.#focused = focused;
    this.#emit("focus-change", { focused });
  }

  #setLoad(state: WebLoadState, error?: { code: string; message: string }) {
    this.#load = state;
    this.#emit("load", {
      state,
      url: currentUrl(this.#history),
      ...(error ? { error } : {}),
    });
  }

  #emitUrl(): void {
    this.#emit("url", {
      url: currentUrl(this.#history),
      canGoBack: canGoBack(this.#history),
      canGoForward: canGoForward(this.#history),
    });
  }

  /** Load `url` in a fresh frame (`stopped`: the blank frame `stop` leaves). */
  #open(url: string, stopped = false): void {
    const frame = document.createElement("iframe");
    frame.className = "web-frame";
    frame.setAttribute("sandbox", FRAME_SANDBOX);
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("data-testid", "web-frame");
    frame.title = "Web page";
    frame.addEventListener("load", () => {
      if (frame !== this.#frame || stopped || this.#closed) return;
      this.#readTitle(frame);
      this.#setLoad("complete");
    });
    frame.src = url;
    const hadFocus = this.#frame !== null &&
      document.activeElement === this.#frame;
    if (this.#frame) this.#frame.replaceWith(frame);
    else this.#host.append(frame);
    this.#frame = frame;
    if (hadFocus) frame.focus();
    if (this.#title) {
      this.#title = "";
      this.#emit("title", { title: "" });
    }
    if (!stopped) this.#setLoad("loading");
  }

  /** The title of a same-origin page; a cross-origin one (every page here) hides it. */
  #readTitle(frame: HTMLIFrameElement): void {
    let title = "";
    try {
      title = frame.contentDocument?.title ?? "";
    } catch { /* cross-origin */ }
    if (title === this.#title) return;
    this.#title = title;
    this.#emit("title", { title });
  }

  #go(next: WebHistory): Promise<void> {
    if (this.#closed || next === this.#history) return Promise.resolve();
    this.#history = next;
    this.#open(currentUrl(next));
    this.#emitUrl();
    return Promise.resolve();
  }

  navigate(url: string): Promise<void> {
    const parsed = parseWebUrl(url);
    if (!parsed) return Promise.reject(new Error("not an http(s) URL"));
    const next = pushUrl(this.#history, parsed.href);
    // The same URL again is a reload.
    return next === this.#history ? this.reload() : this.#go(next);
  }

  back(): Promise<void> {
    return this.#go(goBack(this.#history));
  }

  forward(): Promise<void> {
    return this.#go(goForward(this.#history));
  }

  reload(): Promise<void> {
    if (!this.#closed) this.#open(currentUrl(this.#history));
    return Promise.resolve();
  }

  /** A frame's load cannot be stopped from outside: a loading page is swapped for a blank one. */
  stop(): Promise<void> {
    if (this.#closed || this.#load !== "loading") return Promise.resolve();
    this.#open("about:blank", true);
    this.#setLoad("failed", { code: "stopped", message: "Stopped" });
    return Promise.resolve();
  }

  setVisible(visible: boolean): Promise<void> {
    if (this.#frame) this.#frame.style.visibility = visible ? "" : "hidden";
    return Promise.resolve();
  }

  /** The iframe is HTML and stacks with the tiles (z-index): nothing to do. */
  setOccluded(_occluded: boolean): Promise<void> {
    return Promise.resolve();
  }

  focus(): Promise<void> {
    this.#frame?.focus();
    return Promise.resolve();
  }

  state(): Promise<WebViewState> {
    return Promise.resolve({
      url: currentUrl(this.#history),
      title: this.#title,
      load: this.#load,
      canGoBack: canGoBack(this.#history),
      canGoForward: canGoForward(this.#history),
    });
  }

  on<K extends keyof WebViewEventMap>(
    event: K,
    fn: (ev: WebViewEventMap[K]) => void,
  ): () => void {
    const set = (this.#listeners[event] ??= new Set()) as Set<
      (ev: WebViewEventMap[K]) => void
    >;
    set.add(fn);
    return () => void set.delete(fn);
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    for (const off of this.#offs) off();
    this.#frame?.remove();
    this.#frame = null;
    this.#emit("closed", {});
    this.#closed = true;
    for (const k of Object.keys(this.#listeners)) {
      delete this.#listeners[k as keyof WebViewEventMap];
    }
    return Promise.resolve();
  }
}

/** The page's own origin (never embedded: see lib/web/url.ts `canEmbedInFrame`). */
function appOrigin(): string | undefined {
  try {
    return globalThis.location?.origin;
  } catch {
    return undefined;
  }
}

/** Today's engine: a sandboxed iframe that shows loopback and local dev pages only. */
export const IframeEngine: WebEngine = {
  capabilities: {
    engine: "iframe",
    drawsAboveHtml: false,
    readsPage: false,
    capture: false,
    evaluate: false,
  },
  canEmbed: (url) => canEmbedInFrame(url, appOrigin()),
  mount: (host, url) => Promise.resolve(new IframeView(host, url)),
};

/**
 * The native engine when the runtime has one, else `null`. A stub until Denext ships its
 * embedded web view: then this awaits `webViewCapabilities().supported` once (at boot) and
 * returns a `NativeEngine` (lib/web/native-engine.ts, wrapping `createWebView` and
 * `attachWebView`).
 */
function nativeEngine(): WebEngine | null {
  return null;
}

/** The engine web tiles use: native if the runtime supports it, else the iframe. */
export function webEngine(): WebEngine {
  return nativeEngine() ?? IframeEngine;
}
