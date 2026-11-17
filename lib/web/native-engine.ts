/**
 * The native web tile engine: Denext's embedded web view (`createWebView` + `attachWebView`,
 * `denext/desktop/window`; runtime 3.0.0-denext.22, WKWebView / CEF on macOS) behind the web
 * tile's {@linkcode WebEngine} interface (lib/web/engine.ts). It shows any http(s) site, never
 * the app's own origin (Denext refuses that too).
 *
 * A native view is a layer above all of the page's HTML, glued to the tile's element. What makes
 * it feel like a tile:
 *
 * - **The snapshot swap** (`setOccluded`). While HTML must show over the tile, the view captures
 *   its page (`capture`, JPEG), shows the picture in the element (an `<img>`), waits one frame
 *   so the picture is painted, and only then hides itself: no blank flash. When it clears the
 *   element is measured again, the view is shown, and the picture goes once the view is back.
 *   The steps run one after another (a chain), each looking at what is wanted by then, so a menu
 *   that opens and closes at once never leaves the view hidden.
 * - **Placement.** `attachWebView` follows the element's size, scrolling and the window. It owns
 *   the view's visibility, so the engine hands it a stand-in whose `setVisible` only records what
 *   the attachment wants ("placed"); the view really shows when it is placed, visible and not
 *   occluded. The attachment does not hear of a move that changes no size (a CSS `transform`): a
 *   fresh attachment measures at once, which is what `relayout()` and the end of an occlusion do.
 * - **Keys.** The engine's forward keys (the workspace's shortcuts and the talk keys,
 *   lib/workspace/keys.ts `forwardAccelerators`) skip the page and come back as `keydown` events
 *   with `forwarded: true`. Only key presses are reported, never releases.
 * - **Focus.** A click in the page reports `focus-change` before the page has the click. Hiding a
 *   view hands the keyboard to the app's page, so a view that had it when it was occluded takes
 *   it back when shown again. `blur()` hands the keyboard to the app's page (`focusWindow`) unless
 *   another view asks for it in the same turn; with another app in front it waits until the
 *   window is the active one again (`focusWindow` would bring it to the front).
 * - **Dictation.** `insertText` runs {@linkcode insertTextScript} in the page (`evaluate`, an
 *   isolated world that shares the DOM).
 * - **The companion's web tools** read and act on the page through the same `evaluate`, and
 *   picture it with `capture` (lib/web/web-control.ts).
 *
 * Policies: logins persist (the named partition {@linkcode WEB_PARTITION}); a popup opens nothing
 * in the view and is reported (`new-window`: the tile opens it in a new tile); a download asks
 * where to save it (the OS save panel); camera, microphone, location and notification prompts are
 * refused.
 *
 * Everything the runtime does is behind {@linkcode NativeWebViews}, so the tests drive the engine
 * with a fake. Client-safe: nothing runs at import.
 *
 * @module
 */

import {
  attachWebView,
  createWebView,
  type CreateWebViewOptions,
  focusWindow,
  onWindowBlur,
  onWindowFocus,
  type WebViewCapabilities,
  webViewCapabilities,
  type WebViewHandle as DenextWebView,
} from "denext/desktop/window";
import type {
  WebEngine,
  WebViewEventMap,
  WebViewHandle,
  WebViewState,
} from "./engine.ts";
import { parseWebUrl } from "./url.ts";

/** The storage partition every web tile shares: persistent, so logins survive a restart. */
export const WEB_PARTITION = "qutty-web";

/** The most forward keys a view takes (Denext's limit). */
export const MAX_FORWARD_KEYS = 64;

/** The slice of Denext's `WebViewHandle` the engine drives. */
export type RawWebView = Pick<
  DenextWebView,
  | "setBounds"
  | "setVisible"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "stop"
  | "focus"
  | "state"
  | "capture"
  | "evaluate"
  | "setZOrder"
  | "setForwardKeys"
  | "on"
  | "close"
>;

/** What `attachWebView` drives: the engine's stand-in for the view. */
export type AttachedView = Pick<RawWebView, "setBounds" | "setVisible" | "on">;

/** The capabilities the engine reads. */
export type NativeCapabilities = Pick<
  WebViewCapabilities,
  "supported" | "capture" | "evaluate" | "zOrder" | "forwardKeys"
>;

/** A page snapshot standing in for its view. */
export interface Snapshot {
  /** The node to put in the tile's element. */
  readonly element: Node;
  /** Resolves once the picture can be painted. */
  readonly ready: Promise<void>;
  /** Take it out of the document and free it. */
  dispose(): void;
}

/** The runtime's web views, as the engine uses them (Denext's, or a fake in the tests). */
export interface NativeWebViews {
  capabilities(): Promise<NativeCapabilities>;
  create(options: CreateWebViewOptions): Promise<RawWebView>;
  /** Keep `view` on `element`; returns the detach. A new attachment measures at once. */
  attach(view: AttachedView, element: HTMLElement): () => void;
  /** Hand the keyboard to the app's own page (it brings the window to the front). */
  focusPage(): Promise<void>;
  /** Follow whether the window is the active one (called with the state now, then on changes). */
  onWindowActive(fn: (active: boolean) => void): () => void;
  /** The next animation frame. */
  frame(): Promise<void>;
  /** Output pixels per CSS pixel of a snapshot. */
  scale(): number;
  /** A picture of `blob` at `size` (CSS pixels). */
  snapshot(blob: Blob, size: { width: number; height: number }): Snapshot;
}

/** Denext's web views. */
export const denextWebViews: NativeWebViews = {
  capabilities: () => webViewCapabilities(),
  create: (options) => createWebView(options),
  // `attachWebView` calls only `setBounds`, `setVisible` and `on("closed")` on its handle.
  attach: (view, element) =>
    attachWebView(view as unknown as DenextWebView, element),
  focusPage: () => focusWindow(),
  onWindowActive: (fn) => {
    fn(globalThis.document?.visibilityState !== "hidden");
    const offFocus = onWindowFocus(() => fn(true));
    const offBlur = onWindowBlur(() => fn(false));
    return () => {
      offFocus();
      offBlur();
    };
  },
  frame: () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  scale: () => Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1)),
  // A `data:` URL, which the page's CSP allows for images (`img-src 'self' data:`); a `blob:`
  // URL would be refused.
  snapshot: (blob, size) => {
    const img = document.createElement("img");
    img.className = "web-snapshot";
    img.alt = "";
    img.draggable = false;
    img.setAttribute("data-testid", "web-snapshot");
    img.style.width = `${size.width}px`;
    img.style.height = `${size.height}px`;
    const ready = new Promise<void>((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve();
      reader.onload = () => {
        img.src = String(reader.result);
        img.decode().then(resolve, () => resolve());
      };
      reader.readAsDataURL(blob);
    });
    return { element: img, ready, dispose: () => img.remove() };
  },
};

/** Whether the native engine shows `url`: any http(s) page but the app's own origin. */
export function canEmbedNatively(raw: string, appOrigin?: string): boolean {
  const url = parseWebUrl(raw);
  return !!url && (appOrigin === undefined || url.origin !== appOrigin);
}

/**
 * The script that types `text` into the page's focused editable element, as
 * `insertIntoDocument` (lib/web/engine.ts) does for a same-origin frame: it follows the focus
 * into shadow roots and same-origin frames, then `execCommand("insertText")` (the page's undo
 * history and input event), else `setRangeText` and an input event. It evaluates to `true` when
 * the text went in, `false` when nothing editable has the focus. Self-contained: it runs in the
 * page's isolated world.
 */
export function insertTextScript(text: string): string {
  return `(() => {
  const text = ${JSON.stringify(text)};
  const RANGE = ["text", "search", "url", "tel", "password"];
  let doc = document;
  let el = doc.activeElement;
  for (let i = 0; i < 16 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
      continue;
    }
    const frame = String(el.tagName).toUpperCase();
    if (frame === "IFRAME" || frame === "FRAME") {
      let inner = null;
      try { inner = el.contentDocument; } catch (_) { /* cross-origin */ }
      if (inner && inner.activeElement) {
        doc = inner;
        el = inner.activeElement;
        continue;
      }
    }
    break;
  }
  if (!el) return false;
  const tag = String(el.tagName).toUpperCase();
  const type = String(el.type || "text").toLowerCase();
  const ranged = tag === "TEXTAREA" || (tag === "INPUT" && RANGE.includes(type));
  const field = ranged || (tag === "INPUT" && type === "email");
  if (!el.isContentEditable && !(field && !el.disabled && !el.readOnly)) return false;
  try {
    if (doc.execCommand("insertText", false, text)) return true;
  } catch (_) { /* not supported: the fallback below */ }
  if (!ranged) return false;
  const start = el.selectionStart == null ? el.value.length : el.selectionStart;
  const end = el.selectionEnd == null ? start : el.selectionEnd;
  el.setRangeText(text, start, end, "end");
  const view = doc.defaultView || globalThis;
  const Input = view.InputEvent || globalThis.InputEvent;
  el.dispatchEvent(
    Input
      ? new Input("input", { bubbles: true, inputType: "insertText", data: text })
      : new Event("input", { bubbles: true }),
  );
  return true;
})()`;
}

/** What the views of one engine share. */
interface Shared {
  readonly views: NativeWebViews;
  readonly caps: NativeCapabilities;
  forwardKeys: string[];
  /** A view gave the keyboard up: the app's page gets it unless a view takes it this turn. */
  releaseKeyboard(): void;
  /** A view takes the keyboard. */
  takeKeyboard(): void;
}

type Listeners = { [K in keyof WebViewEventMap]?: Set<(ev: never) => void> };

/** One native web view on a tile's element. */
class NativeView implements WebViewHandle {
  readonly #raw: RawWebView;
  readonly #host: HTMLElement;
  readonly #shared: Shared;
  readonly #listeners: Listeners = {};
  readonly #offs: (() => void)[] = [];
  #detach: (() => void) | null = null;
  #closed = false;
  /** What the attachment wants: the element is displayed and in view. */
  #placed = false;
  /** `setVisible`. */
  #visible = true;
  #occluded = false;
  /** The occlusion cleared: the element is measured again before the view shows. */
  #remeasure = false;
  /** A fresh attachment has not measured yet (the snapshot stays meanwhile). */
  #measuring = false;
  /** Whether the native view is showing. */
  #shown = false;
  #shot: Snapshot | null = null;
  #chain: Promise<void> = Promise.resolve();
  /** The page has the keyboard. */
  #focused = false;
  /** The page should have the keyboard when the view shows. */
  #wantFocus = false;
  /** The view is being hidden with the keyboard: the focus loss that follows is the engine's. */
  #hidingFocused = false;
  #z: number | undefined;

  constructor(raw: RawWebView, host: HTMLElement, shared: Shared) {
    this.#raw = raw;
    this.#host = host;
    this.#shared = shared;
    this.#offs.push(
      raw.on("title", (e) => this.#emit("title", { title: e.title })),
      raw.on("url", (e) =>
        this.#emit("url", {
          url: e.url,
          canGoBack: e.canGoBack,
          canGoForward: e.canGoForward,
        })),
      raw.on("load", (e) =>
        this.#emit("load", {
          state: e.state,
          url: e.url,
          ...(e.error ? { error: e.error } : {}),
        })),
      raw.on("focus-change", (e) => this.#onFocus(e.focused === true)),
      raw.on(
        "new-window",
        (e) =>
          this.#emit("new-window", { url: e.url, disposition: e.disposition }),
      ),
      raw.on("keydown", (e) => this.#emit("keydown", { ...e })),
      raw.on("closed", () => this.#finish()),
    );
    this.#attach();
  }

  #emit<K extends keyof WebViewEventMap>(event: K, ev: WebViewEventMap[K]) {
    for (const fn of [...(this.#listeners[event] ?? [])]) {
      (fn as (e: WebViewEventMap[K]) => void)(ev);
    }
  }

  #onFocus(focused: boolean): void {
    if (this.#closed) return;
    this.#focused = focused;
    if (focused) {
      this.#wantFocus = true;
      this.#shared.takeKeyboard();
    } else if (this.#hidingFocused) {
      // Hidden under a snapshot: it takes the keyboard back when it shows again.
      this.#hidingFocused = false;
    } else {
      this.#wantFocus = false;
    }
    this.#emit("focus-change", { focused });
  }

  /** A fresh attachment: it measures the element and sets the bounds on the next frame. */
  #attach(): void {
    this.#detach?.();
    this.#measuring = true;
    this.#detach = this.#shared.views.attach({
      setBounds: (b) => this.#raw.setBounds(b),
      setVisible: (visible) => {
        this.#placed = visible;
        this.#measuring = false;
        return this.#sync();
      },
      on: (event, fn) => this.#raw.on(event, fn),
    }, this.#host);
  }

  #wanted(): boolean {
    return this.#placed && this.#visible && !this.#occluded;
  }

  /** Bring the native view in line with what is wanted, after whatever step is running. */
  #sync(): Promise<void> {
    this.#chain = this.#chain.then(() => this.#step()).catch((err) => {
      if (!this.#closed) console.warn("web tile: the view did not follow", err);
    });
    return this.#chain;
  }

  async #step(): Promise<void> {
    if (this.#closed) return;
    if (this.#remeasure && !this.#occluded) {
      this.#remeasure = false;
      // Hidden: it shows only once the new attachment has put it where the element is now.
      if (!this.#shown) this.#placed = false;
      this.#attach();
    }
    if (this.#wanted() && !this.#shown) {
      await this.#raw.setVisible(true);
      this.#shown = true;
      this.#hidingFocused = false;
      if (this.#wantFocus && !this.#focused && !this.#closed) {
        await this.#raw.focus().catch(() => {});
      }
    } else if (!this.#wanted() && this.#shown) {
      if (this.#occluded && this.#shared.caps.capture) await this.#snapshot();
      // It may have cleared while the page was captured: then the view just stays.
      if (!this.#closed && !this.#wanted()) {
        this.#hidingFocused = this.#focused;
        await this.#raw.setVisible(false);
        this.#shown = false;
      }
    }
    if (!this.#occluded && !this.#measuring) this.#dropShot();
  }

  /** Put a picture of the page in the element and let it paint. */
  async #snapshot(): Promise<void> {
    const views = this.#shared.views;
    try {
      const blob = await this.#raw.capture({
        format: "jpeg",
        quality: 85,
        scale: views.scale(),
      });
      if (this.#closed || !this.#occluded) return;
      const shot = views.snapshot(blob, {
        width: this.#host.clientWidth,
        height: this.#host.clientHeight,
      });
      await shot.ready;
      if (this.#closed || !this.#occluded) return shot.dispose();
      this.#dropShot();
      this.#shot = shot;
      this.#host.append(shot.element);
      await views.frame();
    } catch (err) {
      // No picture: the view still hides, so the HTML above it shows.
      console.warn("web tile: no snapshot of the page", err);
    }
  }

  #dropShot(): void {
    this.#shot?.dispose();
    this.#shot = null;
  }

  navigate(url: string): Promise<void> {
    const parsed = parseWebUrl(url);
    if (!parsed) return Promise.reject(new Error("not an http(s) URL"));
    return this.#raw.navigate(parsed.href);
  }

  back(): Promise<void> {
    return this.#raw.back();
  }

  forward(): Promise<void> {
    return this.#raw.forward();
  }

  reload(options?: { ignoreCache?: boolean }): Promise<void> {
    return this.#raw.reload(options);
  }

  stop(): Promise<void> {
    return this.#raw.stop();
  }

  setVisible(visible: boolean): Promise<void> {
    this.#visible = visible;
    return this.#sync();
  }

  setOccluded(occluded: boolean): Promise<void> {
    if (occluded === this.#occluded) return this.#chain;
    this.#occluded = occluded;
    if (!occluded) this.#remeasure = true;
    return this.#sync();
  }

  setZOrder(z: number): Promise<void> {
    if (this.#closed || !this.#shared.caps.zOrder || z === this.#z) {
      return Promise.resolve();
    }
    this.#z = z;
    return this.#raw.setZOrder(z).catch(() => {});
  }

  relayout(): void {
    // Occluded: the end of the occlusion measures.
    if (!this.#closed && !this.#occluded) this.#attach();
  }

  focus(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#wantFocus = true;
    this.#shared.takeKeyboard();
    // Hidden: it takes the keyboard when it shows.
    if (!this.#shown || this.#focused) return Promise.resolve();
    return this.#raw.focus().catch(() => {});
  }

  blur(): Promise<void> {
    this.#wantFocus = false;
    if (this.#focused && !this.#closed) this.#shared.releaseKeyboard();
    return Promise.resolve();
  }

  async insertText(text: string): Promise<boolean> {
    if (this.#closed || !this.#shared.caps.evaluate) return false;
    try {
      return await this.#raw.evaluate<unknown>(insertTextScript(text)) === true;
    } catch {
      // The page's CSP may refuse the evaluation (WKWebView), or the view closed.
      return false;
    }
  }

  evaluate(script: string): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("the view is closed"));
    if (!this.#shared.caps.evaluate) {
      return Promise.reject(new Error("this runtime cannot evaluate"));
    }
    return this.#raw.evaluate<unknown>(script);
  }

  capture(
    opts: { format: "jpeg" | "png"; quality?: number; scale?: number },
  ): Promise<Blob> {
    if (this.#closed) return Promise.reject(new Error("the view is closed"));
    if (!this.#shared.caps.capture) {
      return Promise.reject(new Error("this runtime cannot capture"));
    }
    return this.#raw.capture(opts);
  }

  async state(): Promise<WebViewState> {
    const s = await this.#raw.state();
    return {
      url: s.url,
      title: s.title,
      load: s.load,
      canGoBack: s.canGoBack,
      canGoForward: s.canGoForward,
    };
  }

  setForwardKeys(keys: string[]): void {
    if (this.#closed) return;
    void this.#raw.setForwardKeys(keys).catch((err) =>
      console.warn("web tile: forward keys refused", err)
    );
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

  /** The view is gone (its `close()`, or its window closed): `closed` once, then nothing. */
  #finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach?.();
    this.#detach = null;
    for (const off of this.#offs) off();
    this.#dropShot();
    this.#emit("closed", {});
    for (const k of Object.keys(this.#listeners)) {
      delete this.#listeners[k as keyof WebViewEventMap];
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#raw.close().catch(() => {});
    this.#finish();
  }
}

/**
 * The native engine over `views`, whose capabilities are `caps` (`supported`). `appOrigin` is
 * the page's own origin, which it never shows.
 */
export function createNativeEngine(
  views: NativeWebViews,
  caps: NativeCapabilities,
  appOrigin?: string,
): WebEngine {
  const live = new Set<NativeView>();
  let toPage = false;
  // Handing the keyboard to the page brings the window to the front, so it waits while another
  // app is in front (a tile may lose the focus then: an agent's tile closing) and is done when
  // the window is the active one again.
  let active = true;
  let owed = false;
  const giveToPage = () => void views.focusPage().catch(() => {});
  views.onWindowActive((now) => {
    active = now;
    if (!now || !owed) return;
    owed = false;
    giveToPage();
  });
  const shared: Shared = {
    views,
    caps,
    forwardKeys: [],
    releaseKeyboard() {
      if (toPage) return;
      toPage = true;
      // After this turn: a tile that takes the focus in the same render asks for it first.
      queueMicrotask(() => {
        if (!toPage) return;
        toPage = false;
        if (active) giveToPage();
        else owed = true;
      });
    },
    takeKeyboard() {
      toPage = false;
      owed = false;
    },
  };
  return {
    capabilities: {
      engine: "native",
      drawsAboveHtml: true,
      readsPage: true,
      capture: caps.capture,
      evaluate: caps.evaluate,
      forwardKeys: caps.forwardKeys,
    },
    canEmbed: (url) => canEmbedNatively(url, appOrigin),
    setForwardKeys(keys) {
      shared.forwardKeys = [...new Set(keys)].slice(0, MAX_FORWARD_KEYS);
      if (!caps.forwardKeys) return;
      for (const view of live) view.setForwardKeys(shared.forwardKeys);
    },
    async mount(host, url) {
      const keys = shared.forwardKeys;
      const raw = await views.create({
        url,
        // The attachment puts it on the element; hidden until then.
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        visible: false,
        partition: WEB_PARTITION,
        allowPopups: "deny",
        downloads: "ask",
        permissions: "deny",
        ...(caps.forwardKeys ? { forwardKeys: keys } : {}),
      });
      const view = new NativeView(raw, host, shared);
      live.add(view);
      // The keys were set while the view was being created (the first tiles of a restored
      // workspace mount before the workspace names its shortcuts).
      if (caps.forwardKeys && shared.forwardKeys !== keys) {
        view.setForwardKeys(shared.forwardKeys);
      }
      view.on("closed", () => live.delete(view));
      return view;
    },
  };
}
