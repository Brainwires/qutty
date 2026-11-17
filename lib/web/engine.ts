/**
 * The web tile's engine adapter: what a web tile (app/web-tile.tsx) drives to show a page, kept
 * narrow and backend-agnostic so the engine behind it is one file.
 *
 * The interface mirrors Denext's embedded web view (`denext/desktop/window` `createWebView` →
 * `WebViewHandle`: navigate, back, forward, reload, stop, setVisible, focus, state, close; the
 * events title, url, load, focus-change, new-window, keydown, closed).
 *
 * Two engines:
 *
 * - {@linkcode IframeEngine} (this file): a sandboxed `<iframe>` inside the tile's body. It shows
 *   loopback and local dev pages only ({@linkcode canEmbedInFrame}); the browser demo and any
 *   runtime without web views use it.
 * - `NativeEngine` (lib/web/native-engine.ts): Denext's native web view (`createWebView` +
 *   `attachWebView`), which shows any http(s) site. The desktop app uses it.
 *
 * {@linkcode webEngine} is the one selection point: the native engine once
 * {@linkcode detectWebEngine} found `webViewCapabilities().supported`, else the iframe.
 *
 * Bounds: a view follows the element it is mounted in (`mount(host, …)`), and that is the only
 * place bounds are handled. The iframe simply sits in the element (CSS fills it). The native
 * engine hands the element to Denext's `attachWebView(handle, el)`, which follows it through
 * resizes, scrolling, window resizes and devicePixelRatio changes and hides the view while the
 * element is out of the DOM or `display: none`. It does not see a move that changes no size (a
 * `transform`): the tile says so with `relayout()`.
 *
 * Dictation: `insertText` types a dictated transcript into the page's focused field (the
 * hold-to-dictate key, app/use-voice.ts). The iframe can do it only for a same-origin page, which
 * {@linkcode canEmbedInFrame} never shows, so in practice it answers `false`; the native engine
 * runs the same insertion in the page (`evaluate`).
 *
 * Overlays: a native view draws above all HTML (`capabilities.drawsAboveHtml`). While HTML must
 * show over the tile (a menu, a dialog, Settings, another tile on top, a tile sliding by) the tile
 * calls `setOccluded(true)` and the native view swaps itself for a snapshot of its page
 * (lib/web/native-engine.ts, lib/web/overlays.ts). The iframe is HTML and ignores it.
 *
 * Client-safe: DOM APIs are used only inside `mount`.
 *
 * @module
 */

import { canEmbedInFrame, parseWebUrl } from "./url.ts";
import {
  createNativeEngine,
  denextWebViews,
  type NativeWebViews,
} from "./native-engine.ts";
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
  /** The page asked for a new window (a popup, a `target="_blank"` link); nothing opened. */
  "new-window": { url: string; disposition: "popup" | "tab" };
  /**
   * A key pressed while the page had the keyboard: `forwarded` for one of the engine's forward
   * keys ({@linkcode WebEngine.setForwardKeys}; the page never saw it), else one the page left
   * unhandled. No key release is ever reported.
   */
  keydown: {
    key: string;
    code: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    repeat: boolean;
    forwarded: boolean;
  };
  /** A {@linkcode WebViewHandle.find} search's matches (`activeMatch` 1-based, `0`: none). */
  "find-result": { matches: number; activeMatch: number };
  /**
   * A context menu was asked for in the page (with `capabilities.contextMenu` the engine draws
   * none: the tile draws its own): where (CSS pixels from the view's top left) and what is under
   * the pointer.
   */
  "context-menu": {
    x: number;
    y: number;
    linkUrl?: string;
    imageUrl?: string;
    selectionText?: string;
    isEditable: boolean;
  };
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
  /** It can snapshot the page (what `setOccluded` shows in the view's place). */
  capture: boolean;
  /** It can run script in the page (what `insertText` uses). */
  evaluate: boolean;
  /** Its forward keys reach the app while a page has the keyboard (`keydown`, `forwarded`). */
  forwardKeys: boolean;
  /** `setZoom` / `getZoom` work. */
  zoom: boolean;
  /** `find` / `stopFind` work (and `find-result` comes). */
  find: boolean;
  /** `print` works. */
  print: boolean;
  /** `openDevTools` may work (it is still refused unless the app's DevTools are on). */
  devTools: boolean;
  /** The page's context menu is the tile's (`context-menu`), not the engine's. */
  contextMenu: boolean;
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
   * HTML must show over this view's tile: another tile overlaps it from above (the free-form
   * view; `occludedIds`, lib/workspace/freeform.ts), a menu or dialog is open, a tile is moving
   * (lib/web/overlays.ts). A native view draws above all HTML, so while occluded it shows a
   * snapshot of its page in its element and hides itself, and comes back when it clears. The
   * iframe is ordinary HTML that stacks with the tiles: it ignores it.
   */
  setOccluded(occluded: boolean): Promise<void>;
  /** The view's order among the other views (the tile's z-index); nothing for the iframe. */
  setZOrder(z: number): Promise<void>;
  /** The element moved without changing size (a `transform`): measure it again. */
  relayout(): void;
  /** Give the page the keyboard. */
  focus(): Promise<void>;
  /** The tile lost the workspace's focus: hand the keyboard back to the app if the page has it. */
  blur(): Promise<void>;
  /**
   * Type `text` into the page's focused editable element (an input, a textarea, a contenteditable)
   * as if typed: the page sees its input event. `false` when it cannot: a page it may not reach
   * into (a cross-origin frame), or nothing editable has the focus.
   */
  insertText(text: string): Promise<boolean>;
  state(): Promise<WebViewState>;
  /** Zoom the page (0.25 to 5; 1 is 100%). */
  setZoom(factor: number): Promise<void>;
  getZoom(): Promise<number>;
  /** Find `text` in the page (the same text again: the next match); results come as `find-result`. */
  find(text: string, opts?: { forward?: boolean }): Promise<void>;
  /** End the find (its highlights go). */
  stopFind(): Promise<void>;
  /** The OS print dialog for the page. */
  print(): Promise<void>;
  /** The engine's developer tools for the page. */
  openDevTools(): Promise<void>;
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
  /**
   * The keys the app keeps while a page has the keyboard (accelerators, `"CmdOrCtrl+Shift+L"`):
   * each comes back as a `keydown` event with `forwarded: true`. Engines without
   * `capabilities.forwardKeys` have none.
   */
  setForwardKeys?(keys: readonly string[]): void;
  /** Whether this engine can show `url` (else it goes to the default browser). */
  canEmbed(url: string): boolean;
  /** Open `url` in a view that follows `host` (its bounds and visibility). */
  mount(host: HTMLElement, url: string): Promise<WebViewHandle>;
}

/** The iframe's sandbox: scripts, forms, popups, dialogs and downloads, no top navigation. */
export const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

/** The `<input>` types whose text has a selection (`setRangeText` works on them). */
const RANGE_INPUTS = new Set(["text", "search", "url", "tel", "password"]);
/** The `<input>` types that take typed text. */
const TEXT_INPUTS = new Set([...RANGE_INPUTS, "email"]);

/** The part of an element {@linkcode insertIntoDocument} reads. */
type EditableLike = Element & {
  isContentEditable?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  type?: string;
};

/** Whether `el` takes typed text: a writable text input or textarea, or contenteditable. */
function isEditable(el: EditableLike): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag !== "TEXTAREA" && tag !== "INPUT") return false;
  if (el.disabled || el.readOnly) return false;
  return tag === "TEXTAREA" ||
    TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
}

/**
 * Type `text` into `doc`'s focused editable element, as {@linkcode WebViewHandle.insertText}
 * describes: `execCommand("insertText")` (the page's undo history and input event, as typing
 * does), else `setRangeText` at the selection and an input event. `false` when nothing editable
 * has the focus.
 */
export function insertIntoDocument(doc: Document, text: string): boolean {
  const el = doc.activeElement as EditableLike | null;
  if (!el || !isEditable(el)) return false;
  try {
    if (doc.execCommand("insertText", false, text)) return true;
  } catch { /* not supported: the fallback below */ }
  const field = el as unknown as HTMLInputElement;
  const tag = el.tagName.toUpperCase();
  if (
    tag !== "TEXTAREA" &&
    !(tag === "INPUT" && RANGE_INPUTS.has((el.type ?? "text").toLowerCase()))
  ) return false;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, "end");
  const view = doc.defaultView as (typeof globalThis) | null;
  const Input = view?.InputEvent ?? globalThis.InputEvent;
  el.dispatchEvent(
    Input
      ? new Input("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
      : new Event("input", { bubbles: true }),
  );
  return true;
}

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
  #zoom = 1;
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
    this.#applyZoom(frame);
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

  /**
   * A frame's page cannot be zoomed from outside: the frame is laid out `1 / zoom` as big and
   * scaled by `zoom`, which is what a browser's page zoom looks like.
   */
  #applyZoom(frame: HTMLIFrameElement): void {
    const z = this.#zoom;
    const s = frame.style;
    s.width = z === 1 ? "" : `${100 / z}%`;
    s.height = z === 1 ? "" : `${100 / z}%`;
    s.transform = z === 1 ? "" : `scale(${z})`;
    s.transformOrigin = z === 1 ? "" : "0 0";
  }

  setZoom(factor: number): Promise<void> {
    if (!Number.isFinite(factor)) return Promise.reject(new Error("bad zoom"));
    this.#zoom = Math.min(5, Math.max(0.25, factor));
    if (this.#frame) this.#applyZoom(this.#frame);
    return Promise.resolve();
  }

  getZoom(): Promise<number> {
    return Promise.resolve(this.#zoom);
  }

  /** A cross-origin frame cannot be searched from outside. */
  find(): Promise<void> {
    return Promise.reject(unsupported("find"));
  }

  stopFind(): Promise<void> {
    return Promise.resolve();
  }

  print(): Promise<void> {
    return Promise.reject(unsupported("print"));
  }

  openDevTools(): Promise<void> {
    return Promise.reject(unsupported("openDevTools"));
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

  /** Views are not ordered: the frame stacks with its tile. */
  setZOrder(_z: number): Promise<void> {
    return Promise.resolve();
  }

  /** The frame is laid out with its element. */
  relayout(): void {}

  focus(): Promise<void> {
    this.#frame?.focus();
    return Promise.resolve();
  }

  /** The frame is part of the page: focusing anything else takes the keyboard from it. */
  blur(): Promise<void> {
    return Promise.resolve();
  }

  /** Only a same-origin page: a cross-origin frame has no `contentDocument` for its parent. */
  insertText(text: string): Promise<boolean> {
    if (this.#closed || !this.#frame) return Promise.resolve(false);
    let doc: Document | null = null;
    try {
      doc = this.#frame.contentDocument;
    } catch { /* cross-origin */ }
    return Promise.resolve(doc ? insertIntoDocument(doc, text) : false);
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

/** The error a call the engine cannot make rejects with (`code: "unsupported"`, as Denext's). */
function unsupported(what: string): Error {
  return Object.assign(new Error(`${what} is not supported here`), {
    code: "unsupported",
  });
}

/** The page's own origin (never embedded: see lib/web/url.ts `canEmbedInFrame`). */
function appOrigin(): string | undefined {
  try {
    return globalThis.location?.origin;
  } catch {
    return undefined;
  }
}

/** The iframe engine: a sandboxed iframe that shows loopback and local dev pages only. */
export const IframeEngine: WebEngine = {
  capabilities: {
    engine: "iframe",
    drawsAboveHtml: false,
    readsPage: false,
    capture: false,
    evaluate: false,
    forwardKeys: false,
    zoom: true,
    find: false,
    print: false,
    devTools: false,
    contextMenu: false,
  },
  canEmbed: (url) => canEmbedInFrame(url, appOrigin()),
  mount: (host, url) => Promise.resolve(new IframeView(host, url)),
};

/** The native engine, once {@linkcode detectWebEngine} found the runtime hosts web views. */
let native: WebEngine | null = null;
let detecting: Promise<WebEngine> | null = null;

/**
 * The engine web tiles use: native if the runtime supports it, else the iframe. Until
 * {@linkcode detectWebEngine} has answered it is the iframe.
 */
export function webEngine(): WebEngine {
  return native ?? IframeEngine;
}

/**
 * Ask the runtime once whether it hosts web views (`webViewCapabilities().supported`) and pick
 * the engine: the native one when it does, else the iframe (the browser demo, an older runtime, a
 * runtime whose answer fails). Every later call answers the same engine.
 *
 * @param views The runtime's web views (Denext's; a fake in the tests).
 */
export function detectWebEngine(
  views: NativeWebViews = denextWebViews,
): Promise<WebEngine> {
  return detecting ??= views.capabilities().then((caps) => {
    if (caps.supported) native = createNativeEngine(views, caps, appOrigin());
    return webEngine();
  }, () => IframeEngine);
}

/** Forget the detected engine (tests). */
export function resetWebEngineForTesting(): void {
  native = null;
  detecting = null;
}
