// The bookmarks bar: a slim row under a web tile's toolbar with the "Bookmarks bar" folder's
// entries (lib/web/bookmarks.ts), shown on every web tile while Settings → Links → "Show
// bookmarks bar" is on.
//
// - An entry is a monogram (the first letter of its title or host: no remote favicons, the
//   page's CSP allows `img-src 'self' data:` only, and no host learns what is bookmarked) and
//   its title. A click opens it in this tile; a middle click or ⌘-click (Ctrl elsewhere) in a new
//   web tile beside this one.
// - A folder opens a dropdown (app/web-menu.tsx), its folders as submenus. What does not fit
//   goes in the » menu at the end.
// - A drag (pointer events) reorders the bar, or drops an entry into a folder (the middle of a
//   folder's button). An entry in a folder's dropdown can be dragged onto the bar too.
// - The right-click menu: Open, Open in new tile, Open in default browser, Edit…, Delete, New
//   folder…, Bookmarks… (the manager); on the bar itself New folder…, Bookmarks…, History….
//
// Keyboard: the entries are buttons in one tab stop (← / → move between them, Home / End jump,
// Enter or Space opens, ↓ opens a folder, the context-menu key or Shift+F10 the right-click menu).

import { useEffect, useLayoutEffect, useRef, useState } from "denext";
import {
  BAR_ID,
  type BookmarkNode,
  childrenOf,
  monogram,
  moveNode,
  nodeById,
  removeNodes,
} from "../lib/web/bookmarks.ts";
import {
  BookmarkPopover,
  type BookmarkPopoverMode,
} from "./bookmark-popover.tsx";
import {
  type Anchor,
  followPointer,
  type MenuEntry,
  PopupMenu,
} from "./web-menu.tsx";
import { WebIcon } from "./web-icons.tsx";
import { bookmarksStore, openWebDialog, useSynced } from "./web-stores.ts";

/** Where a bookmark opens. */
export type OpenWhere = "here" | "tile" | "browser";

export interface BookmarksBarProps {
  open(url: string, where: OpenWhere): void;
}

/** The icon of an entry: its monogram, or a folder. */
export function BookmarkGlyph(props: { node: BookmarkNode }) {
  const n = props.node;
  if (n.kind === "folder") {
    return (
      <span class="bm-glyph is-folder">
        <WebIcon name="folder" size={13} />
      </span>
    );
  }
  const letter = monogram(n.title, n.url);
  // A hue from the letter, so the bar is easy to scan (the theme sets lightness and chroma).
  const hue = ((letter.codePointAt(0) ?? 0) * 47) % 360;
  return (
    <span
      class="bm-glyph"
      style={{ "--bm-hue": String(hue) } as Record<string, string>}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

/** The menu entries of folder `parentId`: its bookmarks, and its folders as submenus. */
function folderEntries(
  parentId: string,
  open: (url: string, where: OpenWhere) => void,
): MenuEntry[] {
  const b = bookmarksStore.get();
  return childrenOf(b, parentId).map((n): MenuEntry =>
    n.kind === "folder"
      ? {
        kind: "submenu",
        id: n.id,
        label: n.title,
        icon: <BookmarkGlyph node={n} />,
        entries: () => folderEntries(n.id, open),
      }
      : {
        kind: "item",
        id: n.id,
        label: n.title,
        icon: <BookmarkGlyph node={n} />,
        title: n.url,
        run: (how) => open(n.url!, how.newTile ? "tile" : "here"),
      }
  );
}

type BarMenu =
  | { kind: "folder"; id: string; anchor: Anchor }
  | { kind: "overflow"; anchor: Anchor }
  | { kind: "context"; id: string | null; at: { x: number; y: number } };

interface Drag {
  id: string;
  x: number;
  y: number;
  moving: boolean;
}

type Drop = { id: string; where: "before" | "after" | "into" } | null;

const rectOf = (el: Element): Anchor => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** Room kept at the end for the » button (px). */
const OVERFLOW_W = 26;

export function BookmarksBar(props: BookmarksBarProps) {
  const bookmarks = useSynced(bookmarksStore);
  const items = childrenOf(bookmarks, BAR_ID);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(items.length);
  const [menu, setMenu] = useState<BarMenu | null>(null);
  const [popover, setPopover] = useState<
    { target: BookmarkPopoverMode; anchor: Anchor } | null
  >(null);
  const [drop, setDrop] = useState<Drop>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** A drag just ended: the click that follows it opens nothing. */
  const draggedRef = useRef(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const openRef = useRef(props.open);
  openRef.current = props.open;
  const open = (url: string, where: OpenWhere) => openRef.current(url, where);

  // How many entries fit: measured on every change of the entries and of the row's width.
  const measure = () => {
    const row = rowRef.current;
    if (!row) return;
    const els = [...row.querySelectorAll<HTMLElement>("[data-bm-index]")];
    const width = row.clientWidth;
    let n = els.length;
    for (let i = 0; i < els.length; i++) {
      const right = els[i].offsetLeft + els[i].offsetWidth;
      const room = i === els.length - 1 ? width : width - OVERFLOW_W;
      if (right > room) {
        n = i;
        break;
      }
    }
    setFit((was) => (was === n ? was : n));
  };
  useLayoutEffect(measure, [bookmarks]);
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => ro.disconnect();
  }, []);

  // A drag: the window follows the pointer until it is let go.
  useEffect(() => {
    const target = (x: number, y: number): Drop => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(
        "[data-bm-id]",
      );
      const id = el?.dataset.bmId;
      const d = dragRef.current;
      if (!el || !id || !d || id === d.id) return null;
      if (!rowRef.current?.contains(el)) return null;
      const r = el.getBoundingClientRect();
      const t = (x - r.left) / Math.max(1, r.width);
      if (el.dataset.bmFolder === "true" && t > 0.25 && t < 0.75) {
        return { id, where: "into" };
      }
      return { id, where: t < 0.5 ? "before" : "after" };
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moving && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      if (!d.moving) {
        d.moving = true;
        setDragId(d.id);
      }
      setDrop(target(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.moving) return;
      draggedRef.current = true;
      setDragId(null);
      setDrop(null);
      const at = target(e.clientX, e.clientY);
      if (!at) return;
      let b = bookmarksStore.get();
      if (at.where === "into") b = moveNode(b, d.id, at.id);
      else {
        const siblings = childrenOf(b, BAR_ID).filter((n) => n.id !== d.id);
        const i = siblings.findIndex((n) => n.id === at.id);
        b = moveNode(b, d.id, BAR_ID, at.where === "before" ? i : i + 1);
      }
      bookmarksStore.set(b);
      setMenu(null);
    };
    return followPointer(onMove, onUp);
  }, []);

  const startDrag = (id: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    draggedRef.current = false;
    dragRef.current = { id, x: e.clientX, y: e.clientY, moving: false };
  };

  const contextEntries = (id: string | null): MenuEntry[] => {
    const node = id ? nodeById(bookmarksStore.get(), id) : undefined;
    const anchor = (): Anchor => {
      const el = id
        ? rowRef.current?.querySelector(`[data-bm-id="${CSS.escape(id)}"]`)
        : null;
      return el ? rectOf(el) : menuAnchor();
    };
    const out: MenuEntry[] = [];
    if (node?.kind === "bookmark") {
      out.push(
        {
          kind: "item",
          id: "open",
          label: "Open",
          run: () => open(node.url!, "here"),
        },
        {
          kind: "item",
          id: "tile",
          label: "Open in new tile",
          run: () => open(node.url!, "tile"),
        },
        {
          kind: "item",
          id: "browser",
          label: "Open in default browser",
          run: () => open(node.url!, "browser"),
        },
        { kind: "sep" },
      );
    }
    if (node) {
      out.push(
        {
          kind: "item",
          id: "edit",
          label: "Edit…",
          run: () =>
            setPopover({
              target: { mode: "edit", id: node.id },
              anchor: anchor(),
            }),
        },
        {
          kind: "item",
          id: "delete",
          label: "Delete",
          danger: true,
          run: () =>
            bookmarksStore.set(
              removeNodes(bookmarksStore.get(), [node.id]).bookmarks,
            ),
        },
        { kind: "sep" },
      );
    }
    const parentId = node?.parentId ?? BAR_ID;
    const siblings = childrenOf(bookmarksStore.get(), parentId);
    out.push(
      {
        kind: "item",
        id: "folder",
        label: "New folder…",
        run: () =>
          setPopover({
            target: {
              mode: "newFolder",
              parentId,
              ...(node
                ? { index: siblings.findIndex((n) => n.id === node.id) + 1 }
                : {}),
            },
            anchor: anchor(),
          }),
      },
      {
        kind: "item",
        id: "manager",
        label: "Bookmarks…",
        run: () =>
          openWebDialog({
            kind: "bookmarks",
            ...(node ? { selectId: node.id } : {}),
          }),
      },
    );
    if (!node) {
      out.push({
        kind: "item",
        id: "history",
        label: "History…",
        run: () => openWebDialog({ kind: "history" }),
      });
    }
    return out;
  };

  /** Where a menu opened from the keyboard on the bar itself goes. */
  const menuAnchor = (): Anchor => {
    const r = rowRef.current?.getBoundingClientRect();
    return r
      ? { left: r.left + 8, top: r.top, right: r.left + 8, bottom: r.bottom }
      : { left: 0, top: 0, right: 0, bottom: 0 };
  };

  let menuEl = null;
  if (menu?.kind === "folder") {
    menuEl = (
      <PopupMenu
        at={menu.anchor}
        label={nodeById(bookmarks, menu.id)?.title ?? "Folder"}
        testid="bm-folder-menu"
        entries={folderEntries(menu.id, open)}
        onClose={() => setMenu(null)}
        onItemContext={(id, at) => setMenu({ kind: "context", id, at })}
        onItemPointerDown={startDrag}
      />
    );
  } else if (menu?.kind === "overflow") {
    const hidden = items.slice(fit);
    const entries: MenuEntry[] = [
      ...hidden.map((n): MenuEntry =>
        n.kind === "folder"
          ? {
            kind: "submenu",
            id: n.id,
            label: n.title,
            icon: <BookmarkGlyph node={n} />,
            entries: () => folderEntries(n.id, open),
          }
          : {
            kind: "item",
            id: n.id,
            label: n.title,
            title: n.url,
            icon: <BookmarkGlyph node={n} />,
            run: (how) => open(n.url!, how.newTile ? "tile" : "here"),
          }
      ),
      { kind: "sep" },
      {
        kind: "item",
        id: "manager",
        label: "Bookmarks…",
        run: () => openWebDialog({ kind: "bookmarks" }),
      },
    ];
    menuEl = (
      <PopupMenu
        at={menu.anchor}
        label="More bookmarks"
        testid="bm-overflow-menu"
        entries={entries}
        onClose={() => setMenu(null)}
        onItemContext={(id, at) => setMenu({ kind: "context", id, at })}
        onItemPointerDown={startDrag}
      />
    );
  } else if (menu?.kind === "context") {
    menuEl = (
      <PopupMenu
        at={menu.at}
        label="Bookmark"
        testid="bm-context-menu"
        entries={contextEntries(menu.id)}
        onClose={() => setMenu(null)}
      />
    );
  }

  const focusEntry = (i: number) => {
    const els = rowRef.current?.querySelectorAll<HTMLElement>(
      "[data-bm-index]",
    );
    const n = Math.min(fit, els?.length ?? 0);
    if (!els || n === 0) return;
    const at = (i + n) % n;
    setFocusIndex(at);
    els[at]?.focus();
  };

  return (
    <div
      class="bm-bar"
      role="toolbar"
      aria-label="Bookmarks bar"
      data-testid="bm-bar"
      data-keep-focus
      ref={rowRef}
      onContextMenu={(e) => {
        if ((e.target as Element).closest("[data-bm-id]")) return;
        e.preventDefault();
        setMenu({
          kind: "context",
          id: null,
          at: { x: e.clientX, y: e.clientY },
        });
      }}
    >
      {items.length === 0 && (
        <span class="bm-empty" data-testid="bm-empty">
          Bookmark a page with the star in the address field.
        </span>
      )}
      {items.map((n, i) => (
        <button
          type="button"
          key={n.id}
          class={`bm-item${i >= fit ? " is-hidden" : ""}${
            dragId === n.id ? " is-dragging" : ""
          }${drop?.id === n.id ? ` is-drop-${drop.where}` : ""}${
            menu?.kind === "folder" && menu.id === n.id ? " is-open" : ""
          }`}
          data-testid="bm-item"
          data-bm-id={n.id}
          data-bm-index={i}
          data-bm-folder={n.kind === "folder" ? "true" : undefined}
          aria-haspopup={n.kind === "folder" ? "menu" : undefined}
          tabIndex={i === Math.min(focusIndex, fit - 1) ? 0 : -1}
          aria-hidden={i >= fit ? "true" : undefined}
          title={n.kind === "bookmark" ? `${n.title}\n${n.url}` : n.title}
          onPointerDown={(e) => startDrag(n.id, e as unknown as PointerEvent)}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          onMouseUp={(e) => {
            if (e.button !== 1 || n.kind !== "bookmark") return;
            e.preventDefault();
            open(n.url!, "tile");
          }}
          onClick={(e) => {
            if (draggedRef.current) {
              draggedRef.current = false;
              return;
            }
            setFocusIndex(i);
            if (n.kind === "folder") {
              const el = e.currentTarget as HTMLElement;
              setMenu((m) =>
                m?.kind === "folder" && m.id === n.id
                  ? null
                  : { kind: "folder", id: n.id, anchor: rectOf(el) }
              );
            } else {
              open(n.url!, e.metaKey || e.ctrlKey ? "tile" : "here");
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({
              kind: "context",
              id: n.id,
              at: { x: e.clientX, y: e.clientY },
            });
          }}
          onKeyDown={(e) => {
            const el = e.currentTarget as HTMLElement;
            if (e.key === "ArrowRight") focusEntry(i + 1);
            else if (e.key === "ArrowLeft") focusEntry(i - 1);
            else if (e.key === "Home") focusEntry(0);
            else if (e.key === "End") focusEntry(fit - 1);
            else if (e.key === "ArrowDown" && n.kind === "folder") {
              setMenu({ kind: "folder", id: n.id, anchor: rectOf(el) });
            } else if (
              e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)
            ) {
              const r = el.getBoundingClientRect();
              setMenu({
                kind: "context",
                id: n.id,
                at: { x: r.left, y: r.bottom },
              });
            } else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <BookmarkGlyph node={n} />
          <span class="bm-title">{n.title}</span>
          {n.kind === "folder" && (
            <span class="bm-caret">
              <WebIcon name="down" size={10} />
            </span>
          )}
        </button>
      ))}
      {fit < items.length && (
        <button
          type="button"
          class={`bm-overflow${menu?.kind === "overflow" ? " is-open" : ""}`}
          data-testid="bm-overflow"
          aria-label="More bookmarks"
          aria-haspopup="menu"
          title="More bookmarks"
          onClick={(e) => {
            const el = e.currentTarget as HTMLElement;
            setMenu((m) =>
              m?.kind === "overflow"
                ? null
                : { kind: "overflow", anchor: rectOf(el) }
            );
          }}
        >
          »
        </button>
      )}
      {menuEl}
      {popover && (
        <BookmarkPopover
          target={popover.target}
          anchor={popover.anchor}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}
