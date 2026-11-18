// The browser around a web tile's page (app/web-tile.tsx has the page itself):
//
// - The toolbar in the tile's header (`WebToolbar`): Back and Forward (a right click, or a press
//   held until the button fills, lists the pages each goes to), Reload / Stop, Home, the address
//   pill and Open in the default browser. The pill shows a lock (https) or "Not secure" (http),
//   the page's host emphasized while the field is not being edited, a zoom pill when the page is
//   not at 100% (a click puts it back), and the star (☆ / ★): a click bookmarks the page on the
//   bar and opens its popover (name, folder, Remove). While the field is edited it suggests
//   bookmarks and visited pages (↑/↓ pick, Enter goes, Escape closes the list).
// - Under the header (`WebChrome`): the thin loading bar, the bookmarks bar
//   (app/bookmarks-bar.tsx), the find bar (⌘F, with the native engine: Enter / ⌘G next,
//   Shift+Enter / ⌘⇧G previous, Escape closes), and the page's own right-click menu (the native
//   engine hands it to the tile).
//
// Everything that can show over the page (the menus, the suggestions, the popover) registers as
// an HTML overlay, so a native view shows its snapshot meanwhile. No timers: the loading bar and
// the held press are CSS animations.

import { useEffect, useRef, useState } from "denext";
import { addBookmark, bookmarksFor } from "../lib/web/bookmarks.ts";
import { hostLabel, parseWebUrl } from "../lib/web/url.ts";
import { suggest, type Suggestion } from "../lib/web/visits.ts";
import { zoomLabel } from "../lib/web/zoom.ts";
import { BookmarkPopover } from "./bookmark-popover.tsx";
import { BookmarksBar } from "./bookmarks-bar.tsx";
import { useHtmlOverlay } from "./use-html-overlay.ts";
import { type Anchor, type MenuEntry, PopupMenu } from "./web-menu.tsx";
import { WebIcon, type WebIconName } from "./web-icons.tsx";
import {
  bookmarksStore,
  openWebDialog,
  useSynced,
  visitsStore,
} from "./web-stores.ts";
import { focusBodyOf, type WebTileView } from "./web-tile.tsx";

const rectOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** A page's label in a menu: its title when History knows it, else its host and path. */
function pageLabel(url: string): string {
  const v = visitsStore.get().visits.find((x) => x.url === url);
  if (v?.title) return v.title;
  const u = parseWebUrl(url);
  return u ? `${u.host}${u.pathname === "/" ? "" : u.pathname}` : url;
}

/** A toolbar button: an icon, its label as the tooltip. */
function ToolButton(props: {
  testid: string;
  label: string;
  icon: WebIconName;
  run(): void;
  disabled?: boolean;
  /** The list a right click (or a held press) shows. */
  menu?(anchor: Anchor): void;
}) {
  const [holding, setHolding] = useState(false);
  const heldRef = useRef(false);
  return (
    <button
      type="button"
      class={`web-btn${holding ? " is-holding" : ""}`}
      data-testid={props.testid}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onPointerDown={(e) => {
        if (props.menu && e.button === 0) {
          heldRef.current = false;
          setHolding(true);
        }
      }}
      onPointerUp={() => setHolding(false)}
      onPointerLeave={() => setHolding(false)}
      onAnimationEnd={(e) => {
        // The held press filled the button: its list opens (the click that follows does not go).
        if (!holding || !props.menu) return;
        setHolding(false);
        heldRef.current = true;
        props.menu(rectOf(e.currentTarget as HTMLElement));
      }}
      onContextMenu={(e) => {
        if (!props.menu) return;
        e.preventDefault();
        props.menu(rectOf(e.currentTarget as HTMLElement));
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (heldRef.current) {
          heldRef.current = false;
          return;
        }
        props.run();
      }}
    >
      <WebIcon name={props.icon} />
    </button>
  );
}

/** The toolbar in a web tile's header. */
export function WebToolbar(props: { view: WebTileView }) {
  const { view } = props;
  const loading = view.load === "loading";
  const [navMenu, setNavMenu] = useState<
    { dir: -1 | 1; anchor: Anchor } | null
  >(null);
  const list = navMenu?.dir === -1 ? view.backList : view.forwardList;
  return (
    <span class="web-toolbar" data-testid="web-toolbar">
      <ToolButton
        testid="web-back"
        label="Back"
        icon="back"
        run={view.back}
        disabled={!view.canGoBack}
        menu={(anchor) => setNavMenu({ dir: -1, anchor })}
      />
      <ToolButton
        testid="web-forward"
        label="Forward"
        icon="forward"
        run={view.forward}
        disabled={!view.canGoForward}
        menu={(anchor) => setNavMenu({ dir: 1, anchor })}
      />
      {loading && view.embeddable
        ? (
          <ToolButton
            testid="web-stop"
            label="Stop"
            icon="stop"
            run={view.stop}
          />
        )
        : (
          <ToolButton
            testid="web-reload"
            label="Reload"
            icon="reload"
            run={view.reload}
            disabled={!view.embeddable}
          />
        )}
      <ToolButton
        testid="web-home"
        label="Home"
        icon="home"
        run={view.home}
        disabled={!view.hasHome}
      />
      <AddressField view={view} />
      <ToolButton
        testid="web-external"
        label="Open in default browser"
        icon="external"
        run={view.openExternal}
      />
      {navMenu && (
        <PopupMenu
          at={navMenu.anchor}
          label={navMenu.dir === -1 ? "Back" : "Forward"}
          testid="web-nav-menu"
          entries={[
            ...list.slice(0, 15).map((url, i): MenuEntry => ({
              kind: "item",
              id: `${i}`,
              label: pageLabel(url),
              title: url,
              icon: <WebIcon name="page" size={12} />,
              run: () => view.goBy(navMenu.dir * (i + 1)),
            })),
            { kind: "sep" },
            {
              kind: "item",
              id: "history",
              label: "Show all history…",
              icon: <WebIcon name="clock" size={12} />,
              run: () => openWebDialog({ kind: "history" }),
            },
          ]}
          onClose={() => setNavMenu(null)}
        />
      )}
    </span>
  );
}

/** The address pill: security, the field (host emphasized), suggestions, zoom, the star. */
function AddressField(props: { view: WebTileView }) {
  const { view } = props;
  const bookmarks = useSynced(bookmarksStore);
  const visits = useSynced(visitsStore);
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState(-1);
  // Escape closed the list: it stays closed until the text changes.
  const [listClosed, setListClosed] = useState(false);
  // A click that focuses the field selects its text (the mouseup would undo the selection).
  const selectedOnFocus = useRef(false);
  const starRef = useRef<HTMLButtonElement | null>(null);
  const pillRef = useRef<HTMLSpanElement | null>(null);
  const [starId, setStarId] = useState<string | null>(null);

  const url = view.url;
  const parsed = parseWebUrl(url);
  const marked = bookmarksFor(bookmarks, url);
  const suggestions: Suggestion[] = editing && draft !== null && !listClosed
    ? suggest(draft, bookmarks, visits, 8)
    : [];

  // ⌘D or the star: the page is bookmarked (on the bar) and its popover opens.
  useEffect(() => {
    if (!view.starOpen) {
      setStarId(null);
      return;
    }
    const was = bookmarksFor(bookmarksStore.get(), url)[0];
    if (was) return setStarId(was.id);
    const made = addBookmark(bookmarksStore.get(), {
      title: view.title || hostLabel(url),
      url,
    });
    if (!made.id) return view.setStarOpen(false);
    bookmarksStore.set(made.bookmarks);
    setStarId(made.id);
  }, [view.starOpen]);

  const go = (text: string, field: HTMLInputElement) => {
    // Going somewhere gives the keyboard back to the tile, as a browser does.
    if (view.navigate(text)) {
      setDraft(null);
      setPick(-1);
      focusBodyOf(field);
    }
  };

  const showHost = !editing && parsed && draft === null;
  const host = parsed?.host ?? "";
  const hostAt = showHost ? url.indexOf(host) : -1;

  return (
    <span
      class={`web-omnibox${editing ? " is-editing" : ""}`}
      data-testid="web-omnibox"
      ref={pillRef}
    >
      {parsed && (
        <span
          class={`web-security${
            parsed.protocol === "https:" ? "" : " is-insecure"
          }`}
          data-testid="web-security"
          data-secure={parsed.protocol === "https:" ? "true" : "false"}
          title={parsed.protocol === "https:"
            ? "Secure connection (https)"
            : "Not secure: this page is not sent over https"}
        >
          <WebIcon
            name={parsed.protocol === "https:" ? "lock" : "warn"}
            size={11}
          />
          {parsed.protocol !== "https:" && (
            <span class="web-security-label">Not secure</span>
          )}
        </span>
      )}
      <span class="web-address-wrap">
        <input
          type="text"
          class={`web-address${hostAt >= 0 ? " is-pretty" : ""}`}
          data-testid="web-address"
          aria-label="Address"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="web-suggest"
          aria-autocomplete="list"
          spellcheck={false}
          autocomplete="off"
          value={draft ?? url}
          onFocus={(e) => {
            (e.target as HTMLInputElement).select();
            selectedOnFocus.current = true;
            setEditing(true);
          }}
          onMouseUp={(e) => {
            if (selectedOnFocus.current) e.preventDefault();
            selectedOnFocus.current = false;
          }}
          onInput={(e) => {
            setDraft((e.target as HTMLInputElement).value);
            setPick(-1);
            setListClosed(false);
          }}
          onBlur={() => {
            setDraft(null);
            setEditing(false);
            setPick(-1);
            setListClosed(false);
            selectedOnFocus.current = false;
          }}
          onKeyDown={(e) => {
            const field = e.target as HTMLInputElement;
            if (e.key === "ArrowDown" && suggestions.length) {
              e.preventDefault();
              setPick((p) => (p + 1) % suggestions.length);
            } else if (e.key === "ArrowUp" && suggestions.length) {
              e.preventDefault();
              setPick((p) => (p <= 0 ? suggestions.length - 1 : p - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(suggestions[pick]?.url ?? draft ?? url, field);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (suggestions.length) {
                setListClosed(true);
                setPick(-1);
                return;
              }
              // As in a browser: Escape stops a load; it also gives the keyboard back.
              if (view.load === "loading") view.stop();
              setDraft(null);
              focusBodyOf(field);
            }
          }}
        />
        {hostAt >= 0 && (
          <span class="web-address-pretty" aria-hidden="true">
            <span class="web-address-dim">{url.slice(0, hostAt)}</span>
            <span class="web-address-host">{host}</span>
            <span class="web-address-dim">
              {url.slice(hostAt + host.length)}
            </span>
          </span>
        )}
      </span>
      {view.zoom !== 1 && (
        <button
          type="button"
          class="web-zoom"
          data-testid="web-zoom"
          title="Zoom: click for actual size"
          onClick={(e) => {
            e.stopPropagation();
            view.zoomReset();
          }}
        >
          {zoomLabel(view.zoom)}
        </button>
      )}
      {parsed && (
        <button
          type="button"
          ref={starRef}
          class={`web-star${marked.length ? " is-on" : ""}`}
          data-testid="web-star"
          aria-label={marked.length ? "Edit bookmark" : "Bookmark this page"}
          aria-pressed={marked.length > 0}
          title={marked.length ? "Edit bookmark" : "Bookmark this page"}
          onClick={(e) => {
            e.stopPropagation();
            view.setStarOpen(!view.starOpen);
          }}
        >
          <WebIcon name="star" size={13} filled={marked.length > 0} />
        </button>
      )}
      {suggestions.length > 0 && pillRef.current && (
        <Suggestions
          anchor={rectOf(pillRef.current)}
          items={suggestions}
          pick={pick}
          onGo={(s) => {
            const field = pillRef.current?.querySelector("input");
            if (field) go(s.url, field);
          }}
        />
      )}
      {view.starOpen && starId && starRef.current && (
        <BookmarkPopover
          target={{ mode: "star", id: starId }}
          anchor={rectOf(starRef.current)}
          onClose={() => {
            view.setStarOpen(false);
            view.focusPage();
          }}
        />
      )}
    </span>
  );
}

/** The address field's suggestions, under the pill. */
function Suggestions(props: {
  anchor: Anchor;
  items: Suggestion[];
  pick: number;
  onGo(s: Suggestion): void;
}) {
  useHtmlOverlay();
  const a = props.anchor;
  return (
    <div
      class="web-suggest"
      id="web-suggest"
      role="listbox"
      aria-label="Suggestions"
      data-testid="web-suggest"
      style={{
        left: `${a.left}px`,
        top: `${a.bottom + 3}px`,
        width: `${Math.max(280, a.right - a.left)}px`,
      }}
    >
      {props.items.map((s, i) => (
        <div
          key={s.url}
          role="option"
          aria-selected={i === props.pick}
          class={`web-suggest-row${i === props.pick ? " is-active" : ""}`}
          data-testid="web-suggest-row"
          data-kind={s.kind}
          data-url={s.url}
          // Kept in the field: the press must not blur it before the click.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onGo(s)}
        >
          <WebIcon name={s.kind === "bookmark" ? "star" : "clock"} size={12} />
          <span class="web-suggest-title">{s.title || hostLabel(s.url)}</span>
          <span class="web-suggest-url">{s.url}</span>
        </div>
      ))}
    </div>
  );
}

/** Under the header: the loading bar, the bookmarks bar, the find bar, the page's menu. */
export function WebChrome(props: { view: WebTileView }) {
  const { view } = props;
  return (
    <div class="web-chrome" data-testid="web-chrome">
      <div
        class="web-progress"
        data-testid="web-progress"
        data-load={view.embeddable ? view.load : "complete"}
        aria-hidden="true"
      />
      {view.showBar && <BookmarksBar open={view.openUrl} />}
      {view.find.open && <FindBar view={view} />}
      {view.pageMenu && <PageContextMenu view={view} />}
    </div>
  );
}

function FindBar(props: { view: WebTileView }) {
  const { view } = props;
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [view.findFocus]);
  const close = () => {
    view.closeFind();
    const el = ref.current;
    if (el) focusBodyOf(el);
  };
  const f = view.find;
  return (
    <div class="web-find" role="search" data-testid="web-find">
      <WebIcon name="search" size={12} />
      <input
        type="text"
        ref={ref}
        class="web-find-field"
        data-testid="web-find-field"
        aria-label="Find in page"
        placeholder="Find in page"
        spellcheck={false}
        autocomplete="off"
        value={f.text}
        onInput={(e) =>
          view.setFind({ text: (e.target as HTMLInputElement).value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            view.findNext(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      />
      <span class="web-find-count" data-testid="web-find-count">
        {f.text
          ? (f.matches ? `${f.active} of ${f.matches}` : "No matches")
          : ""}
      </span>
      <button
        type="button"
        class="web-btn"
        aria-label="Previous match"
        title="Previous match"
        disabled={!f.matches}
        onClick={() => view.findNext(-1)}
      >
        <WebIcon name="up" size={12} />
      </button>
      <button
        type="button"
        class="web-btn"
        aria-label="Next match"
        title="Next match"
        disabled={!f.matches}
        onClick={() => view.findNext(1)}
      >
        <WebIcon name="down" size={12} />
      </button>
      <button
        type="button"
        class="web-btn"
        data-testid="web-find-close"
        aria-label="Close find bar"
        title="Close"
        onClick={close}
      >
        <WebIcon name="close" size={12} />
      </button>
    </div>
  );
}

/** The page's right-click menu (the native engine hands it to the tile). */
function PageContextMenu(props: { view: WebTileView }) {
  const { view } = props;
  const m = view.pageMenu!;
  const entries: MenuEntry[] = [];
  const item = (id: string, label: string, run: () => void, disabled = false) =>
    entries.push({ kind: "item", id, label, run, disabled });
  const sep = () => {
    if (entries.length && entries[entries.length - 1].kind !== "sep") {
      entries.push({ kind: "sep" });
    }
  };
  const link = m.linkUrl && parseWebUrl(m.linkUrl) ? m.linkUrl : undefined;
  if (link) {
    item(
      "link-tile",
      "Open link in new tile",
      () => view.openUrl(link, "tile"),
    );
    item(
      "link-browser",
      "Open link in default browser",
      () => view.openUrl(link, "browser"),
    );
    item("link-copy", "Copy link address", () => view.copy(link));
    sep();
  }
  const image = m.imageUrl && parseWebUrl(m.imageUrl) ? m.imageUrl : undefined;
  if (image) {
    item(
      "image-tile",
      "Open image in new tile",
      () => view.openUrl(image, "tile"),
    );
    item("image-copy", "Copy image address", () => view.copy(image));
    sep();
  }
  if (m.selectionText) {
    item("copy", "Copy", () => view.copy(m.selectionText!));
  }
  if (m.isEditable) {
    item("paste", "Paste", () => {
      void globalThis.navigator?.clipboard?.readText().then(
        (text) => text && view.insertText(text),
        (err) => console.warn("web tile: the clipboard refused", err),
      );
    });
  }
  sep();
  item("back", "Back", view.back, !view.canGoBack);
  item("forward", "Forward", view.forward, !view.canGoForward);
  item("reload", "Reload", view.reload);
  sep();
  item("bookmark", "Bookmark this page…", () => view.setStarOpen(true));
  if (view.can.find) item("find", "Find in Page…", view.openFind);
  if (view.can.print) item("print", "Print…", view.print);
  if (view.can.devTools) {
    sep();
    item("inspect", "Inspect", view.devTools);
  }
  return (
    <PopupMenu
      at={{ x: m.x, y: m.y }}
      label="Page"
      testid="web-page-menu"
      entries={entries}
      onClose={view.closePageMenu}
    />
  );
}
