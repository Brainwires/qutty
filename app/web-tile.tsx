// A web tile's insides (the frame — position, phase, header, close — is app/tile-cluster.tsx's,
// shared with the terminals): the toolbar in the header (back, forward, reload / stop, the address
// field, open in the default browser) and the body the engine's view sits in.
//
// The view comes from the engine (lib/web/engine.ts `webEngine()`): in the desktop app a native
// web view that shows any site (lib/web/native-engine.ts), elsewhere a sandboxed iframe that
// shows loopback and local dev pages only. A page the engine cannot show gets a card that opens
// it in the default browser instead.
//
// Focus, iframe: a workspace focus change lands on the tile's body (`focusWebTile`), not inside
// the page, so the window keeps the keyboard shortcuts; a click in the page gives the page the
// keyboard, and the view's `focus-change` event focuses the tile in the workspace (a click inside
// a cross-origin frame never reaches the page's own pointer listeners).
//
// Focus, native: the focused tile's page takes the keyboard, as a terminal does. The workspace's
// shortcuts and the talk keys still work there: the view hands them back (`keydown`,
// `forwarded`) and they are replayed on the window, where the usual listeners take them
// (`replayForwardedKey`), and so are their releases (`keyup`, the engine's `keyUp`), so a talk key
// can be held in a page. An engine without `keyUp` reports presses only: there a replayed key is
// let go at once, and a talk key pressed in a page latches (as a short click on the mic does)
// until the next press. A modifier alone is never forwarded, so while an alt-tab style cycle is
// under way the keyboard stays with the app and the modifier's release ends the cycle. A tile
// that loses the workspace's focus gives the keyboard back (`blur`).
//
// A native view draws above all HTML. While something must show over the tile (a menu, a dialog,
// Settings, a tile on top of it or moving, the companion's bubble: lib/web/overlays.ts) the view
// shows a snapshot of its page instead (`setOccluded`); for what stays over the tile (the
// companion itself) it leaves a strip of the body free instead (`inset`).
//
// The browser around the page: the bookmarks bar (app/bookmarks-bar.tsx), the star, the address
// field's suggestions, the find bar, page zoom (remembered per site), the page's right-click menu
// and the Back / Forward lists live in app/web-chrome.tsx; the browser keys (⌘L, ⌘R, ⌘[ …) come
// from the workspace's one key router (lib/workspace/keys.ts `routeKey`) to `runWebCommand`.

import { useCallback, useEffect, useRef, useState } from "denext";
import type {
  WebEngine,
  WebLoadState,
  WebViewEventMap,
  WebViewHandle,
} from "../lib/web/engine.ts";
import {
  followUrl,
  startHistory,
  type WebHistory,
} from "../lib/web/history.ts";
import { recordVisit, titleVisit } from "../lib/web/visits.ts";
import { ownSiteZoom, setSiteZoom, stepZoom } from "../lib/web/zoom.ts";
import { pageZoom, stepTileZoom } from "../lib/workspace/tile-zoom.ts";
import type { WebKeyCommand } from "../lib/workspace/keys.ts";
import { visitsStore, zoomStore } from "./web-stores.ts";
import type { OpenWhere } from "./bookmarks-bar.tsx";
import {
  areaOverlays,
  coveredByArea,
  type Insets,
  keepoutInsets,
  onAreaOverlays,
  onOverlays,
} from "../lib/web/overlays.ts";
import {
  addressToUrl,
  hostLabel,
  parseWebUrl,
  type WebPage,
} from "../lib/web/url.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";

/** What the workspace gives web tiles. */
export interface WebTileHooks {
  /** The engine; `null` while the desktop runtime is asked which one it has. */
  engine: WebEngine | null;
  /** The tile's page changed (its URL, or the title the engine read). */
  onPage(id: string, page: WebPage): void;
  /** Open `url` in the default browser (the backend's `linkOpen`). */
  openExternal(url: string): void;
  /** Tile `id`'s view was mounted (`null`: closed); dictation types into it (`insertText`). */
  onView?(id: string, view: WebViewHandle | null): void;
  /** A page asked for a new window: open `url` in a web tile beside it. */
  openTile?(url: string): void;
  /** An alt-tab style cycle is under way: the keyboard stays with the app until it ends. */
  cycling?: boolean;
  /** The home page (Settings → Links → Home page): the toolbar's Home button goes there. */
  home?: string;
  /** Settings → Links → "Show bookmarks bar" (default on). */
  bookmarksBar?: boolean;
  /**
   * The shared zoom level while tiles zoom together (View → "Zoom All Tiles Together"), else
   * `null`: a page without a zoom of its own shows it (lib/workspace/tile-zoom.ts).
   */
  sharedZoom?: number | null;
  /** Set the shared level (⌘= / ⌘- / ⌘0 on a page without a zoom of its own, tiles together). */
  setSharedZoom?(zoom: number): void;
  /** Copy text to the clipboard (the page menu's Copy link, Copy). */
  copy?(text: string): void;
}

/** Where a web tile is, as its frame knows it (app/tile-cluster.tsx). */
export interface WebTileLayout {
  /** Another tile overlaps it from above (the free-form view). */
  occluded: boolean;
  /** Its stacking order among the tiles (its z-index). */
  z: number;
  /** Changes whenever the tile's rect or phase does. */
  key: string;
}

const NO_LAYOUT: WebTileLayout = { occluded: false, z: 1, key: "" };

/** A web tile's view as its header and body draw it. */
export interface WebTileView {
  /** The element the engine's view follows. */
  hostRef: { current: HTMLDivElement | null };
  url: string;
  load: WebLoadState;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The engine can show the page (else the body offers the default browser). */
  embeddable: boolean;
  /** The engine is not known yet: nothing is offered. */
  pending: boolean;
  /** The engine is the native one (it shows any site). */
  native: boolean;
  /** Why the page could not be opened, when the engine refused it. */
  failed: string;
  /** The room the view leaves for what stays over the tile (`null`: none). */
  inset: Insets | null;
  navigate(input: string): boolean;
  /** Go to the home page (Settings → Links). */
  home(): void;
  /** Whether there is a home page this tile can show. */
  hasHome: boolean;
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  openExternal(): void;
  /** The page's title (empty when the engine cannot read it). */
  title: string;
  /** Open `url` here (the tile takes the focus), in a new web tile, or in the default browser. */
  openUrl(url: string, where: OpenWhere): void;
  /** Whether the bookmarks bar shows. */
  showBar: boolean;
  /** The page's zoom (1: 100%). */
  zoom: number;
  zoomBy(dir: 1 | -1): void;
  zoomReset(): void;
  /** Reload past the cache. */
  reloadHard(): void;
  /** What the engine can do beyond showing the page. */
  can: { zoom: boolean; find: boolean; print: boolean; devTools: boolean };
  print(): void;
  devTools(): void;
  /** The find bar: open, its text, and the matches the engine reported. */
  find: FindState;
  setFind(patch: Partial<FindState>): void;
  /** Bumped by each ⌘F: the find field takes the keyboard (again). */
  findFocus: number;
  /** Open the find bar (⌘F), its field taking the keyboard. */
  openFind(): void;
  /** Find `find.text` again, forward or back. */
  findNext(dir: 1 | -1): void;
  closeFind(): void;
  /** The star's popover is open (⌘D or the star). */
  starOpen: boolean;
  setStarOpen(open: boolean): void;
  /** The page asked for its context menu (the tile draws it), in viewport pixels. */
  pageMenu: PageMenu | null;
  closePageMenu(): void;
  /** The pages Back and Forward go to, nearest first. */
  backList: string[];
  forwardList: string[];
  /** Go `n` steps through the history (negative: back). */
  goBy(n: number): void;
  /** Copy text to the clipboard. */
  copy(text: string): void;
  /** Type `text` into the page's focused field. */
  insertText(text: string): void;
  /** Give the keyboard back to the tile's page. */
  focusPage(): void;
}

/** The find bar's state. */
export interface FindState {
  open: boolean;
  text: string;
  matches: number;
  active: number;
}

/** The page's context menu, where it was asked for and what is under the pointer. */
export type PageMenu = WebViewEventMap["context-menu"];

const NO_FIND: FindState = { open: false, text: "", matches: 0, active: 0 };

/** The selector of web tile `id`'s body. */
const bodyOf = (id: string) =>
  `[data-testid="tile"][data-id="${CSS.escape(id)}"] [data-testid="web-body"]`;

/** The native views by tile id: how `focusWebTile` gives a page the keyboard. */
const pageFocus = new Map<string, () => void>();

/** What each mounted web tile does with a browser command. */
const webCommands = new Map<string, (cmd: WebKeyCommand) => void>();
/** How each mounted web tile goes to a URL (the bookmark manager, History). */
const webNavigators = new Map<string, (url: string) => void>();

/**
 * Run browser command `cmd` (lib/workspace/keys.ts `routeKey`) on web tile `id`; `false` when
 * it is not a mounted web tile.
 */
export function runWebCommand(id: string, cmd: WebKeyCommand): boolean {
  const fn = webCommands.get(id);
  fn?.(cmd);
  return !!fn;
}

/** Show `url` in web tile `id`; `false` when it is not a mounted web tile. */
export function navigateWebTile(id: string, url: string): boolean {
  const fn = webNavigators.get(id);
  fn?.(url);
  return !!fn;
}

/** The address field of web tile `id`, focused with its text selected (⌘L). */
function focusAddressOf(id: string): void {
  const field = document.querySelector<HTMLInputElement>(
    `[data-testid="tile"][data-id="${
      CSS.escape(id)
    }"] [data-testid="web-address"]`,
  );
  field?.focus();
  field?.select();
}

/**
 * Give web tile `id` the keyboard: its body, and with the native engine its page (the shortcuts
 * come back from there). Focus already inside the tile (its page after a click there, its
 * address field) stays where it is.
 */
export function focusWebTile(id: string): void {
  const body = document.querySelector<HTMLElement>(bodyOf(id));
  if (body?.closest("[data-testid=tile]")?.contains(document.activeElement)) {
    // The body has it (not the address field): the page may still want the keyboard.
    if (document.activeElement === body) pageFocus.get(id)?.();
    return;
  }
  body?.focus({ preventScroll: true });
  pageFocus.get(id)?.();
}

/** Move the keyboard from a control in a web tile's header to the tile's body. */
export function focusBodyOf(el: Element): void {
  const tile = el.closest<HTMLElement>("[data-testid=tile]");
  tile?.querySelector<HTMLElement>("[data-testid=web-body]")
    ?.focus({ preventScroll: true });
  const id = tile?.dataset.id;
  if (id) pageFocus.get(id)?.();
}

/**
 * A key the page handed back (one of the engine's forward keys), replayed on the window where
 * the workspace's and the talk keys' listeners are: a press, or its release. `releases`: the
 * engine reports releases (`keyUp`); without, a press is let go at once.
 */
function replayForwardedKey(
  e: WebViewEventMap["keydown"] | WebViewEventMap["keyup"],
  type: "keydown" | "keyup",
  releases: boolean,
  target: Pick<EventTarget, "dispatchEvent"> = globalThis,
): void {
  const init: KeyboardEventInit = {
    key: e.key,
    code: e.code,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    repeat: type === "keydown" && "repeat" in e && e.repeat,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEvent(type, init));
  if (type === "keydown" && !releases) {
    target.dispatchEvent(
      new KeyboardEvent("keyup", { ...init, repeat: false }),
    );
  }
}

/** The least time between two tiles a page's popups open (ms). */
const POPUP_GAP_MS = 1000;

/** What the engine said when it refused a page, in words. */
function failureText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "limit") return "Too many web tiles are open in this window.";
  if (code === "not_allowed_url") return "This address can't be opened here.";
  return err instanceof Error ? err.message : String(err);
}

const sameInsets = (a: Insets | null, b: Insets | null) =>
  a === b ||
  (!!a && !!b && a.top === b.top && a.right === b.right &&
    a.bottom === b.bottom && a.left === b.left);

interface ViewState {
  url: string;
  load: WebLoadState;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * The view of web tile `entry` (`null` for a terminal tile): mounts the engine's view in
 * `hostRef` while the page is one the engine can show, and follows its events.
 */
export function useWebTile(
  entry: TerminalEntry,
  focused: boolean,
  /** The tile is displayed (not parked with `display: none`, where nothing takes focus). */
  shown: boolean,
  hooks: WebTileHooks | undefined,
  onFocus: (id: string) => void,
  layout: WebTileLayout = NO_LAYOUT,
): WebTileView | null {
  const page = entry.web;
  const id = entry.id;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<WebViewHandle | null>(null);
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const focusRef = useRef({ focused, onFocus });
  focusRef.current = { focused, onFocus };
  // The URL the view should show: the saved page at first, then whatever the address field asks.
  const [target, setTarget] = useState(page?.url ?? "");
  const [view, setView] = useState<ViewState>({
    url: page?.url ?? "",
    load: "loading",
    canGoBack: false,
    canGoForward: false,
  });
  const [failed, setFailed] = useState("");
  const engine = hooks?.engine ?? null;
  const native = engine?.capabilities.drawsAboveHtml === true;
  const embeddable = !!engine && !!target && !failed && engine.canEmbed(target);

  // What must show over a native view: the open overlays (anywhere), and the area overlays over
  // this tile's body. The iframe hears only of the tiles on top of it, which it ignores.
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const [areaTick, setAreaTick] = useState(0);
  const [areaCovered, setAreaCovered] = useState(false);
  const [inset, setInset] = useState<Insets | null>(null);
  useEffect(() => {
    if (!native) return;
    const offCount = onOverlays((n) => setOverlaysOpen(n > 0));
    const offAreas = onAreaOverlays(() => setAreaTick((n) => n + 1));
    return () => {
      offCount();
      offAreas();
      setOverlaysOpen(false);
      setAreaCovered(false);
      setInset(null);
    };
  }, [native]);
  // Measured when the tile has settled (an overlay is open while it moves) and when an area
  // overlay changes.
  useEffect(() => {
    const body = hostRef.current?.parentElement;
    if (!native || !body) return;
    const r = body.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    const areas = areaOverlays();
    setAreaCovered(coveredByArea(box, areas));
    const next = keepoutInsets(box, areas);
    const none = !next.top && !next.right && !next.bottom && !next.left;
    setInset((was) => {
      const now = none ? null : next;
      return sameInsets(was, now) ? was : now;
    });
  }, [native, layout.key, overlaysOpen, areaTick, embeddable]);
  const covered = layout.occluded || (native && (overlaysOpen || areaCovered));
  const coveredRef = useRef(covered);
  coveredRef.current = covered;
  const zRef = useRef(layout.z);
  zRef.current = layout.z;
  /** The page should have the keyboard (native): the tile is focused, shown, and no cycle runs. */
  const wantsPage = native && focused && shown && hooks?.cycling !== true;
  const wantsPageRef = useRef(wantsPage);
  wantsPageRef.current = wantsPage;
  const popupAt = useRef(0);
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const [find, setFindState] = useState<FindState>(NO_FIND);
  const [starOpen, setStarOpen] = useState(false);
  const [pageMenu, setPageMenu] = useState<PageMenu | null>(null);
  // The tile's own copy of the view's back/forward list (the native view keeps its own and
  // tells only whether it can go back): what the Back and Forward menus list.
  const [trail, setTrail] = useState<WebHistory>(() =>
    startHistory(page?.url ?? "")
  );
  const stepRef = useRef(0);
  const urlRef = useRef(page?.url ?? "");
  const sharedZoom = hooks?.sharedZoom ?? null;
  const sharedRef = useRef(sharedZoom);
  sharedRef.current = sharedZoom;
  /** The zoom `url` shows: its site's own, else the shared level (tiles together), else 100%. */
  const zoomOf = (url: string, sites = zoomStore.get()) =>
    pageZoom(ownSiteZoom(sites, url), sharedRef.current);

  /** Put the view at `factor` (the page's site remembers it when `remember`). */
  const applyZoom = useCallback((factor: number, remember: boolean) => {
    const v = viewRef.current;
    if (!v || !engine?.capabilities.zoom) return;
    if (remember) {
      zoomStore.set(setSiteZoom(zoomStore.get(), urlRef.current, factor));
    }
    if (Math.abs(factor - zoomRef.current) < 1e-3) return;
    zoomRef.current = factor;
    setZoomState(factor);
    void v.setZoom(factor).catch((err) =>
      console.warn("web tile: zoom refused", err)
    );
  }, [engine]);

  // Mount the view when the page is one the engine can show; a page it cannot show closes it.
  useEffect(() => {
    const host = hostRef.current;
    if (!engine || !host || !embeddable || viewRef.current) return;
    let live = true;
    const offs: (() => void)[] = [];
    void engine.mount(host, target).then((v) => {
      if (!live) return void v.close();
      viewRef.current = v;
      hooksRef.current?.onView?.(id, v);
      const report = (patch: Partial<WebPage>) => {
        void v.state().then((s) =>
          hooksRef.current?.onPage(id, {
            url: s.url,
            ...(s.title ? { title: s.title } : {}),
            ...patch,
          })
        );
      };
      offs.push(
        v.on("url", (e) => {
          setView((s) => ({
            ...s,
            url: e.url,
            canGoBack: e.canGoBack,
            canGoForward: e.canGoForward,
          }));
          report({ url: e.url });
          urlRef.current = e.url;
          const step = stepRef.current;
          stepRef.current = step === 0 ? 0 : step - Math.sign(step);
          setTrail((t) => followUrl(t, e.url, Math.sign(step)));
          // A site's zoom comes back with it.
          applyZoom(zoomOf(e.url), false);
        }),
        v.on("load", (e) => {
          setView((s) => ({ ...s, load: e.state }));
          if (e.state === "complete" && e.url) {
            visitsStore.set(
              recordVisit(visitsStore.get(), { url: e.url }, Date.now()),
            );
          }
        }),
        v.on("title", (e) => {
          report({});
          if (e.title) {
            visitsStore.set(
              titleVisit(visitsStore.get(), urlRef.current, e.title),
            );
          }
        }),
        v.on("find-result", (e) =>
          setFindState((f) => ({
            ...f,
            matches: e.matches,
            active: e.activeMatch,
          }))),
        v.on("context-menu", (e) => {
          const r = host.getBoundingClientRect();
          setPageMenu({ ...e, x: r.left + e.x, y: r.top + e.y });
        }),
        v.on("focus-change", (e) => {
          const f = focusRef.current;
          if (e.focused && !f.focused) f.onFocus(id);
        }),
        v.on("keydown", (e) => {
          if (e.forwarded) {
            replayForwardedKey(e, "keydown", engine.capabilities.keyUp);
          }
        }),
        v.on("keyup", (e) => replayForwardedKey(e, "keyup", true)),
        v.on("new-window", (e) => {
          // A popup opens beside the tile, in a tile of its own; a page that asks for many
          // gets one a second.
          const now = Date.now();
          if (!parseWebUrl(e.url) || now - popupAt.current < POPUP_GAP_MS) {
            return;
          }
          popupAt.current = now;
          hooksRef.current?.openTile?.(e.url);
        }),
      );
      void v.state().then((s) => {
        if (!live) return;
        setView({ ...s });
        urlRef.current = s.url;
        applyZoom(zoomOf(s.url), false);
      });
      void v.setZOrder(zRef.current);
      if (coveredRef.current) void v.setOccluded(true);
      if (engine.capabilities.drawsAboveHtml) {
        pageFocus.set(id, () => {
          if (wantsPageRef.current) void v.focus();
        });
        offs.push(() => void pageFocus.delete(id));
        const header = host.closest("[data-testid=tile]")
          ?.querySelector("header");
        if (
          wantsPageRef.current && !header?.contains(document.activeElement)
        ) void v.focus();
      }
    }, (err) => {
      if (live) setFailed(failureText(err));
    });
    return () => {
      live = false;
      for (const off of offs) off();
      zoomRef.current = 1;
      if (viewRef.current) hooksRef.current?.onView?.(id, null);
      void viewRef.current?.close();
      viewRef.current = null;
    };
    // `target` is read at mount only: later navigations go through the view.
  }, [engine, embeddable, id]);

  // Focused from the workspace (the bar, a shortcut, the cycle): the keyboard goes to the body,
  // and with the native engine on to the page. A tile that loses the focus gives the keyboard up.
  const isWeb = page !== undefined;
  useEffect(() => {
    if (!isWeb || !focused || !shown) return;
    const root = hostRef.current?.closest("[data-testid=tile]");
    if (root && !root.contains(document.activeElement)) focusWebTile(id);
    else if (
      wantsPage && document.activeElement === hostRef.current?.parentElement
    ) {
      void viewRef.current?.focus();
    }
    if (!native) return;
    return () => void viewRef.current?.blur();
  }, [focused, shown, isWeb, id, native, wantsPage]);

  // Covered by HTML that must show over it: the view hears of it, and again once it is mounted.
  useEffect(() => {
    void viewRef.current?.setOccluded(covered);
  }, [covered]);
  useEffect(() => {
    void viewRef.current?.setZOrder(layout.z);
  }, [layout.z]);
  // The tile moved: a move that changes no size is not seen by the view's own tracking.
  useEffect(() => {
    viewRef.current?.relayout();
  }, [layout.key]);

  const navigate = useCallback((input: string): boolean => {
    // The native view shows any site, so words that are not an address become a search.
    const url = addressToUrl(input, { search: native });
    if (!url) return false;
    const v = viewRef.current;
    if (v && engine?.canEmbed(url)) {
      // It refuses only a URL that is not http(s), which `addressToUrl` never returns.
      void v.navigate(url).catch((err) =>
        console.warn("web tile: navigation refused", err)
      );
    } else {
      // A page the engine cannot show (or the first one it can after one it could not): the
      // view is (re)mounted, or the card offers the default browser.
      setFailed("");
      setTarget(url);
      setView({ url, load: "loading", canGoBack: false, canGoForward: false });
      hooksRef.current?.onPage(id, { url });
    }
    return true;
  }, [engine, id]);

  // Another tile (or window) zoomed this site: follow.
  useEffect(() => {
    if (!engine?.capabilities.zoom) return;
    return zoomStore.subscribe((z) =>
      applyZoom(zoomOf(urlRef.current, z), false)
    );
  }, [engine, applyZoom]);
  // The shared level changed, or tiles stopped zooming together: follow.
  useEffect(() => {
    if (engine?.capabilities.zoom) applyZoom(zoomOf(urlRef.current), false);
  }, [engine, applyZoom, sharedZoom]);

  const goBy = useCallback((n: number) => {
    const v = viewRef.current;
    if (!v || n === 0) return;
    stepRef.current = n;
    void (async () => {
      for (let i = 0; i < Math.abs(n); i++) {
        await (n < 0 ? v.back() : v.forward()).catch(() => {});
      }
    })();
  }, []);
  // Tiles zooming together: a page without a zoom of its own steps the shared level; one with
  // its own steps that, and Actual Size forgets it (the page joins the shared level again).
  const together = () =>
    sharedRef.current !== null &&
    ownSiteZoom(zoomStore.get(), urlRef.current) === undefined;
  const zoomBy = (dir: 1 | -1) => {
    const shared = sharedRef.current;
    if (shared !== null && together()) {
      return hooksRef.current?.setSharedZoom?.(stepTileZoom(shared, dir));
    }
    applyZoom(stepZoom(zoomRef.current, dir), true);
  };
  const zoomReset = () => {
    if (sharedRef.current === null) return applyZoom(1, true);
    if (together()) return hooksRef.current?.setSharedZoom?.(1);
    zoomStore.set(setSiteZoom(zoomStore.get(), urlRef.current, 1));
  };
  const closeFind = () => {
    setFindState(NO_FIND);
    void viewRef.current?.stopFind().catch(() => {});
  };
  const findNext = (dir: 1 | -1) => {
    const text = findRef.current.text;
    if (!text) return;
    void viewRef.current?.find(text, { forward: dir === 1 }).catch((err) =>
      console.warn("web tile: find refused", err)
    );
  };
  const findRef = useRef(find);
  findRef.current = find;
  const can = {
    zoom: !!engine?.capabilities.zoom,
    find: !!engine?.capabilities.find,
    print: !!engine?.capabilities.print,
    devTools: !!engine?.capabilities.devTools,
  };
  const reloadHard = () => void viewRef.current?.reload({ ignoreCache: true });
  const runCommand = (cmd: WebKeyCommand) => {
    const v = viewRef.current;
    // A native page that has the keyboard hands it back first: a field of the tile's (the
    // address, find, the star's popover) is about to take it.
    const toChrome = () => void v?.blur();
    switch (cmd.kind) {
      case "focusAddress":
        toChrome();
        return focusAddressOf(id);
      case "reload":
        return void v?.reload(
          cmd.ignoreCache ? { ignoreCache: true } : undefined,
        );
      case "stop":
        return void v?.stop();
      case "back":
        return goBy(-1);
      case "forward":
        return goBy(1);
      case "bookmark":
        toChrome();
        return setStarOpen((o) => !o);
      case "find":
        if (!can.find) return;
        toChrome();
        setFindState((f) => ({ ...f, open: true }));
        // The field takes the keyboard once it renders (app/web-chrome.tsx).
        findFocusTick.current++;
        return;
      case "findNext":
        return findNext(cmd.dir);
      case "zoom":
        return zoomBy(cmd.dir);
      case "zoomReset":
        return zoomReset();
      case "print":
        if (can.print) {
          void v?.print().catch((e) => console.warn("web tile: print", e));
        }
        return;
      case "devTools":
        if (can.devTools) {
          void v?.openDevTools().catch((e) =>
            console.warn("web tile: DevTools", e)
          );
        }
        return;
    }
  };
  const findFocusTick = useRef(0);
  const runRef = useRef(runCommand);
  runRef.current = runCommand;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if (!isWeb) return;
    webCommands.set(id, (cmd) => runRef.current(cmd));
    webNavigators.set(id, (u) => void navigateRef.current(u));
    return () => {
      webCommands.delete(id);
      webNavigators.delete(id);
    };
  }, [id, isWeb]);

  if (!page) return null;
  const url = embeddable ? view.url || target : target;
  const copy = (text: string) => {
    if (hooksRef.current?.copy) return hooksRef.current.copy(text);
    void globalThis.navigator?.clipboard?.writeText(text).catch(() => {});
  };
  const backList = trail.entries.slice(0, trail.index).reverse();
  const forwardList = trail.entries.slice(trail.index + 1);
  return {
    hostRef,
    url,
    load: embeddable ? view.load : "complete",
    canGoBack: embeddable && view.canGoBack,
    canGoForward: embeddable && view.canGoForward,
    embeddable,
    pending: engine === null,
    native,
    failed,
    inset,
    navigate,
    home: () => {
      const home = hooksRef.current?.home;
      if (home) navigate(home);
    },
    hasHome: !!hooks?.home && (native || !!engine?.canEmbed(hooks.home)),
    back: () => goBy(-1),
    forward: () => goBy(1),
    reload: () => void viewRef.current?.reload(),
    stop: () => void viewRef.current?.stop(),
    openExternal: () => hooksRef.current?.openExternal(url),
    title: page.title ?? "",
    openUrl: (to, where) => {
      if (where === "browser") return hooksRef.current?.openExternal(to);
      if (where === "tile" && hooksRef.current?.openTile) {
        return hooksRef.current.openTile(to);
      }
      navigate(to);
      if (!focusRef.current.focused) focusRef.current.onFocus(id);
    },
    showBar: hooks?.bookmarksBar !== false,
    zoom,
    zoomBy,
    zoomReset,
    reloadHard,
    can,
    print: () => runCommand({ kind: "print" }),
    devTools: () => runCommand({ kind: "devTools" }),
    find: { ...find, open: find.open && can.find },
    findFocus: findFocusTick.current,
    setFind: (patch) => {
      setFindState((f) => ({ ...f, ...patch }));
      if (patch.text !== undefined) {
        if (patch.text) {
          void viewRef.current?.find(patch.text).catch(() => {});
        } else void viewRef.current?.stopFind().catch(() => {});
      }
    },
    findNext,
    openFind: () => runCommand({ kind: "find" }),
    closeFind,
    starOpen,
    setStarOpen,
    pageMenu,
    closePageMenu: () => setPageMenu(null),
    backList: embeddable ? backList : [],
    forwardList: embeddable ? forwardList : [],
    goBy,
    copy,
    insertText: (text) => void viewRef.current?.insertText(text),
    focusPage: () => {
      const v = viewRef.current;
      if (v && wantsPageRef.current) void v.focus();
    },
  };
}

/** A web tile's body: the engine's view, or the card for a page it cannot show. */
export function WebBody(props: { view: WebTileView }) {
  const { view } = props;
  const inset = view.inset;
  return (
    <div
      class="tile-body web-body"
      data-testid="web-body"
      data-embeddable={view.embeddable ? "true" : "false"}
      data-load={view.load}
      tabIndex={-1}
    >
      {/* The engine's own element: nothing else renders into it. */}
      <div
        class="web-view"
        ref={view.hostRef}
        style={inset
          ? {
            top: `${inset.top}px`,
            right: `${inset.right}px`,
            bottom: `${inset.bottom}px`,
            left: `${inset.left}px`,
          }
          : undefined}
      />
      {!view.embeddable && !view.pending && (
        <div class="web-notice" data-testid="web-notice">
          {view.native
            ? (
              <p>
                <strong>{hostLabel(view.url)}</strong>{" "}
                can't be shown in a tile.{view.failed ? ` ${view.failed}` : ""}
              </p>
            )
            : (
              <p>
                <strong>{hostLabel(view.url)}</strong>{" "}
                can't be shown in a tile yet: Qutty tiles show local development
                pages (localhost, *.localhost, *.test) for now.
              </p>
            )}
          <button
            type="button"
            class="btn-primary"
            data-testid="web-notice-open"
            onClick={view.openExternal}
          >
            Open in default browser
          </button>
        </div>
      )}
    </div>
  );
}
