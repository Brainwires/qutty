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
// (`replayForwardedKey`). Only presses come back, never releases, so a replayed key is let go at
// once: a talk key pressed in a page latches (as a short click on the mic does) and the next
// press stops it. While an alt-tab style cycle is under way the keyboard stays with the app, so
// the modifier's release ends the cycle. A tile that loses the workspace's focus gives the
// keyboard back (`blur`).
//
// A native view draws above all HTML. While something must show over the tile (a menu, a dialog,
// Settings, a tile on top of it or moving, the companion's bubble: lib/web/overlays.ts) the view
// shows a snapshot of its page instead (`setOccluded`); for what stays over the tile (the
// companion itself) it leaves a strip of the body free instead (`inset`).

import { useCallback, useEffect, useRef, useState } from "denext";
import type {
  WebEngine,
  WebLoadState,
  WebViewEventMap,
  WebViewHandle,
} from "../lib/web/engine.ts";
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
  back(): void;
  forward(): void;
  reload(): void;
  stop(): void;
  openExternal(): void;
}

/** The selector of web tile `id`'s body. */
const bodyOf = (id: string) =>
  `[data-testid="tile"][data-id="${CSS.escape(id)}"] [data-testid="web-body"]`;

/** The native views by tile id: how `focusWebTile` gives a page the keyboard. */
const pageFocus = new Map<string, () => void>();

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
function focusBodyOf(el: Element): void {
  const tile = el.closest<HTMLElement>("[data-testid=tile]");
  tile?.querySelector<HTMLElement>("[data-testid=web-body]")
    ?.focus({ preventScroll: true });
  const id = tile?.dataset.id;
  if (id) pageFocus.get(id)?.();
}

/**
 * A key the page handed back (one of the engine's forward keys), replayed on the window where
 * the workspace's and the talk keys' listeners are. The view reports no release, so the key is
 * let go at once.
 */
function replayForwardedKey(
  e: WebViewEventMap["keydown"],
  target: Pick<EventTarget, "dispatchEvent"> = globalThis,
): void {
  const init: KeyboardEventInit = {
    key: e.key,
    code: e.code,
    altKey: e.altKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    shiftKey: e.shiftKey,
    repeat: e.repeat,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", { ...init, repeat: false }));
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
        }),
        v.on("load", (e) => setView((s) => ({ ...s, load: e.state }))),
        v.on("title", () => report({})),
        v.on("focus-change", (e) => {
          const f = focusRef.current;
          if (e.focused && !f.focused) f.onFocus(id);
        }),
        v.on("keydown", (e) => {
          if (e.forwarded) replayForwardedKey(e);
        }),
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
      void v.state().then((s) => live && setView({ ...s }));
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
    const url = addressToUrl(input);
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

  if (!page) return null;
  const url = embeddable ? view.url || target : target;
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
    back: () => void viewRef.current?.back(),
    forward: () => void viewRef.current?.forward(),
    reload: () => void viewRef.current?.reload(),
    stop: () => void viewRef.current?.stop(),
    openExternal: () => hooksRef.current?.openExternal(url),
  };
}

/** The toolbar in a web tile's header. */
export function WebToolbar(props: { view: WebTileView }) {
  const { view } = props;
  const [draft, setDraft] = useState<string | null>(null);
  // A click that focuses the field selects its text (the mouseup would undo the selection).
  const selectedOnFocus = useRef(false);
  const loading = view.load === "loading";
  const tool = (
    testid: string,
    label: string,
    glyph: string,
    run: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      class="web-btn"
      data-testid={testid}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      {glyph}
    </button>
  );
  return (
    <span class="web-toolbar" data-testid="web-toolbar">
      {tool("web-back", "Back", "‹", view.back, !view.canGoBack)}
      {tool("web-forward", "Forward", "›", view.forward, !view.canGoForward)}
      {loading && view.embeddable
        ? tool("web-stop", "Stop", "×", view.stop)
        : tool("web-reload", "Reload", "↻", view.reload, !view.embeddable)}
      <input
        type="text"
        class="web-address"
        data-testid="web-address"
        aria-label="Address"
        spellcheck={false}
        autocomplete="off"
        value={draft ?? view.url}
        onFocus={(e) => {
          (e.target as HTMLInputElement).select();
          selectedOnFocus.current = true;
        }}
        onMouseUp={(e) => {
          if (selectedOnFocus.current) e.preventDefault();
          selectedOnFocus.current = false;
        }}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={() => {
          setDraft(null);
          selectedOnFocus.current = false;
        }}
        onKeyDown={(e) => {
          const field = e.target as HTMLInputElement;
          if (e.key === "Enter") {
            e.preventDefault();
            // Going somewhere gives the keyboard back to the tile, as a browser does.
            if (view.navigate(draft ?? view.url)) {
              setDraft(null);
              focusBodyOf(field);
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            focusBodyOf(field);
          }
        }}
      />
      {tool(
        "web-external",
        "Open in default browser",
        "↗",
        view.openExternal,
      )}
    </span>
  );
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
