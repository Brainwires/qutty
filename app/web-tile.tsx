// A web tile's insides (the frame — position, phase, header, close — is app/tile-cluster.tsx's,
// shared with the terminals): the toolbar in the header (back, forward, reload / stop, the address
// field, open in the default browser) and the body the engine's view sits in.
//
// The view comes from the engine (lib/web/engine.ts `webEngine()`): today a sandboxed iframe that
// shows loopback and local dev pages only. A page the engine cannot show (most public sites, which
// refuse to be framed) gets a card that opens it in the default browser instead.
//
// Focus: a workspace focus change lands on the tile's body (`focusWebTile`), not inside the page,
// so the window keeps the keyboard shortcuts; a click in the page gives the page the keyboard, and
// the view's `focus-change` event focuses the tile in the workspace (a click inside a cross-origin
// frame never reaches the page's own pointer listeners).

import { useCallback, useEffect, useRef, useState } from "denext";
import type {
  WebEngine,
  WebLoadState,
  WebViewHandle,
} from "../lib/web/engine.ts";
import { onOverlays } from "../lib/web/overlays.ts";
import { addressToUrl, hostLabel, type WebPage } from "../lib/web/url.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";

/** What the workspace gives web tiles. */
export interface WebTileHooks {
  engine: WebEngine;
  /** The tile's page changed (its URL, or the title the engine read). */
  onPage(id: string, page: WebPage): void;
  /** Open `url` in the default browser (the backend's `linkOpen`). */
  openExternal(url: string): void;
}

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

/**
 * Give web tile `id` the keyboard (its body, not the page: the shortcuts keep working). Focus
 * already inside the tile (its page after a click there, its address field) stays where it is.
 */
export function focusWebTile(id: string): void {
  const body = document.querySelector<HTMLElement>(bodyOf(id));
  if (body?.closest("[data-testid=tile]")?.contains(document.activeElement)) {
    return;
  }
  body?.focus({ preventScroll: true });
}

/** Move the keyboard from a control in a web tile's header to the tile's body. */
function focusBodyOf(el: Element): void {
  el.closest("[data-testid=tile]")
    ?.querySelector<HTMLElement>("[data-testid=web-body]")
    ?.focus({ preventScroll: true });
}

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
  const engine = hooks?.engine;
  const embeddable = !!engine && !!target && engine.canEmbed(target);

  // Mount the view when the page is one the engine can show; a page it cannot show closes it.
  useEffect(() => {
    const host = hostRef.current;
    if (!engine || !host || !embeddable || viewRef.current) return;
    let live = true;
    const offs: (() => void)[] = [];
    void engine.mount(host, target).then((v) => {
      if (!live) return void v.close();
      viewRef.current = v;
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
      );
      void v.state().then((s) => live && setView({ ...s }));
      // A native view hides while an HTML menu or dialog is open (it would cover it).
      if (engine.capabilities.drawsAboveHtml) {
        offs.push(onOverlays((n) => void v.setVisible(n === 0)));
      }
    });
    return () => {
      live = false;
      for (const off of offs) off();
      void viewRef.current?.close();
      viewRef.current = null;
    };
    // `target` is read at mount only: later navigations go through the view.
  }, [engine, embeddable, id]);

  // Focused from the workspace (the bar, a shortcut, the cycle): the keyboard goes to the body.
  const isWeb = page !== undefined;
  useEffect(() => {
    if (!isWeb || !focused || !shown) return;
    const root = hostRef.current?.closest("[data-testid=tile]");
    if (root && !root.contains(document.activeElement)) focusWebTile(id);
  }, [focused, shown, isWeb, id]);

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
  return (
    <div
      class="tile-body web-body"
      data-testid="web-body"
      data-embeddable={view.embeddable ? "true" : "false"}
      data-load={view.load}
      tabIndex={-1}
    >
      {/* The engine's own element: nothing else renders into it. */}
      <div class="web-view" ref={view.hostRef} />
      {!view.embeddable && (
        <div class="web-notice" data-testid="web-notice">
          <p>
            <strong>{hostLabel(view.url)}</strong>{" "}
            can't be shown in a tile yet: Qutty tiles show local development
            pages (localhost, *.localhost, *.test) for now.
          </p>
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
