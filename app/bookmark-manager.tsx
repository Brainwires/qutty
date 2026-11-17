// The bookmark manager (app/modal.tsx's dialog): the folder tree on the left, the open folder's
// entries on the right, and a search across every bookmark. Opened from "Bookmarks…" (the bar's
// » and right-click menus, the `+` menu) through app/web-stores.ts `openWebDialog`.
//
// - Rename inline (double click the name, or F2), change a bookmark's URL inline (double click it).
// - Select with a click, ⌘-click (Ctrl elsewhere) to add or take one away, Shift-click for a run;
//   Delete or Backspace deletes the selection. The toast that says so has Undo; it goes with the
//   next change (any, in any window) or its ×. No timer.
// - New folder, and drag (pointer events) to reorder entries or move them onto a folder in the tree.
// - Import a Netscape bookmarks HTML file (what every browser exports) into an "Imported" folder;
//   Export the whole tree as one. Qutty has no file-save dialog (Denext's `dialogs` capability is
//   not enabled: it would bake broad write and run permissions into the app), so Export copies the
//   HTML to the clipboard, and in a plain browser also downloads it.
//
// Keyboard: the tree (↑/↓ move, → / ← open and close nothing: every folder is shown, Enter or a
// move opens it) and the list (↑/↓ move, Shift extends, Space toggles, ⌘A all, Enter opens, F2
// renames, Delete deletes) are one tab stop each; Escape cancels an edit, else closes.

import { useEffect, useMemo, useRef, useState } from "denext";
import {
  addFolder,
  BAR_ID,
  type BookmarkNode,
  type Bookmarks,
  bookmarkUrl,
  childrenOf,
  descendantsOf,
  folderList,
  isRoot,
  mergeImported,
  moveNode,
  nodeById,
  pathOf,
  type Removed,
  removeNodes,
  restoreNodes,
  searchBookmarks,
  updateNode,
} from "../lib/web/bookmarks.ts";
import {
  exportNetscapeBookmarks,
  parseNetscapeBookmarks,
} from "../lib/web/bookmark-files.ts";
import { Modal } from "./modal.tsx";
import { BookmarkGlyph, type OpenWhere } from "./bookmarks-bar.tsx";
import { WebIcon } from "./web-icons.tsx";
import { followPointer } from "./web-menu.tsx";
import { bookmarksStore, useSynced } from "./web-stores.ts";

export interface BookmarkManagerProps {
  /** The folder it opens on (default: the bar). */
  folderId?: string;
  /** An entry to show picked (its folder opens). */
  selectId?: string;
  open(url: string, where: OpenWhere): void;
  /** Whether this is a desktop window (Export also downloads in a plain browser). */
  desktop: boolean;
  onClose(): void;
}

type Edit = { id: string; field: "title" | "url"; value: string } | null;

interface Toast {
  text: string;
  /** What Undo puts back (none: a plain note). */
  removed?: Removed;
  /** The tree right after: any other change closes the toast. */
  after: Bookmarks;
}

export function BookmarkManager(props: BookmarkManagerProps) {
  const bookmarks = useSynced(bookmarksStore);
  const start = props.selectId
    ? nodeById(bookmarks, props.selectId)
    : undefined;
  const [folderId, setFolderId] = useState(
    start?.parentId ?? props.folderId ?? BAR_ID,
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(start ? [start.id] : []),
  );
  const [active, setActive] = useState<string | null>(start?.id ?? null);
  const anchorRef = useRef<string | null>(start?.id ?? null);
  const [edit, setEdit] = useState<Edit>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [drop, setDrop] = useState<
    { id: string; where: "before" | "after" | "into" } | null
  >(null);
  const dragRef = useRef<
    { ids: string[]; x: number; y: number; moving: boolean } | null
  >(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // The folder went (deleted elsewhere): back to the bar.
  const folder = nodeById(bookmarks, folderId);
  useEffect(() => {
    if (!folder) setFolderId(BAR_ID);
  }, [!folder]);
  // The next change closes the toast.
  useEffect(() => {
    if (toast && bookmarks !== toast.after) setToast(null);
  }, [bookmarks]);

  const searching = query.trim() !== "";
  const rows: BookmarkNode[] = useMemo(
    () =>
      searching
        ? searchBookmarks(bookmarks, query)
        : childrenOf(bookmarks, folderId),
    [bookmarks, folderId, query],
  );
  const tree = folderList(bookmarks);

  const commit = (next: Bookmarks, note?: Omit<Toast, "after">) => {
    bookmarksStore.set(next);
    setToast(note ? { ...note, after: next } : null);
  };

  const remove = (ids: readonly string[]) => {
    const { bookmarks: next, removed } = removeNodes(bookmarksStore.get(), ids);
    if (removed.entries.length === 0) return;
    const count = removed.entries.length;
    commit(next, {
      text: `Deleted ${count} ${count === 1 ? "item" : "items"}.`,
      removed,
    });
    setSelected(new Set());
    setActive(null);
    listRef.current?.focus();
  };

  const saveEdit = () => {
    if (!edit) return;
    const b = bookmarksStore.get();
    const next = updateNode(b, edit.id, { [edit.field]: edit.value });
    setEdit(null);
    if (next !== b) commit(next);
    listRef.current?.focus();
  };

  const pick = (
    id: string,
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => {
    setActive(id);
    if (e.shiftKey && anchorRef.current) {
      const ids = rows.map((r) => r.id);
      const a = ids.indexOf(anchorRef.current);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelected(new Set(ids.slice(lo, hi + 1)));
        return;
      }
    }
    anchorRef.current = id;
    if (e.metaKey || e.ctrlKey) {
      setSelected((was) => {
        const next = new Set(was);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else setSelected(new Set([id]));
  };

  const openRow = (n: BookmarkNode, where: OpenWhere) => {
    if (n.kind === "folder") {
      setQuery("");
      setFolderId(n.id);
      setSelected(new Set());
      setActive(null);
      return;
    }
    props.onClose();
    props.open(n.url!, where);
  };

  const newFolder = () => {
    const parentId = searching ? BAR_ID : folderId;
    const made = addFolder(bookmarksStore.get(), {
      title: "New folder",
      parentId,
    });
    if (!made.id) return;
    commit(made.bookmarks);
    setQuery("");
    setFolderId(parentId);
    setSelected(new Set([made.id]));
    setActive(made.id);
    setEdit({ id: made.id, field: "title", value: "New folder" });
  };

  const onImportFile = (file: File) => {
    void file.text().then((html) => {
      const items = parseNetscapeBookmarks(html);
      const { bookmarks: next, folderId: id, count } = mergeImported(
        bookmarksStore.get(),
        items,
      );
      if (!id) {
        setToast({
          text: "Nothing could be imported.",
          after: bookmarksStore.get(),
        });
        return;
      }
      commit(next, {
        text: count === 0
          ? "The file had no bookmarks."
          : `Imported ${count} ${count === 1 ? "bookmark" : "bookmarks"}.`,
      });
      setQuery("");
      setFolderId(id);
    }, (err) => console.warn("bookmarks: the file could not be read", err));
  };

  const onExport = () => {
    const b = bookmarksStore.get();
    const html = exportNetscapeBookmarks(b);
    const count = b.nodes.filter((n) => n.kind === "bookmark").length;
    if (!props.desktop) {
      const a = document.createElement("a");
      a.href = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      a.download = "bookmarks.html";
      a.click();
    }
    void globalThis.navigator?.clipboard?.writeText(html).then(
      () =>
        setToast({
          text: `Copied ${count} ${
            count === 1 ? "bookmark" : "bookmarks"
          } as bookmarks HTML${
            props.desktop ? ": paste it into a file named bookmarks.html" : ""
          }.`,
          after: bookmarksStore.get(),
        }),
      (err) => console.warn("bookmarks: the clipboard refused", err),
    );
  };

  // Drags: entries onto the list (reorder) or onto a folder in the tree or the list (move).
  useEffect(() => {
    const target = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(
        "[data-bmm-id]",
      );
      const id = el?.dataset.bmmId;
      const d = dragRef.current;
      if (!el || !id || !d || d.ids.includes(id)) return null;
      if (el.dataset.bmmTree === "true") return { id, where: "into" as const };
      const r = el.getBoundingClientRect();
      const t = (y - r.top) / Math.max(1, r.height);
      if (el.dataset.bmmFolder === "true" && t > 0.25 && t < 0.75) {
        return { id, where: "into" as const };
      }
      return { id, where: t < 0.5 ? "before" as const : "after" as const };
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moving && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      d.moving = true;
      setDrop(target(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.moving) return;
      setDrop(null);
      const at = target(e.clientX, e.clientY);
      if (!at) return;
      let b = bookmarksStore.get();
      if (at.where === "into") {
        for (const id of d.ids) b = moveNode(b, id, at.id);
      } else {
        const ref = nodeById(b, at.id);
        if (!ref?.parentId) return;
        for (const id of d.ids) {
          const siblings = childrenOf(b, ref.parentId).filter((n) =>
            n.id !== id
          );
          const i = siblings.findIndex((n) => n.id === at.id);
          b = moveNode(b, id, ref.parentId, at.where === "before" ? i : i + 1);
        }
        // Several land in their order: each after the one before.
        if (at.where === "after" && d.ids.length > 1) {
          let prev = d.ids[0];
          for (const id of d.ids.slice(1)) {
            const siblings = childrenOf(b, ref.parentId).filter((n) =>
              n.id !== id
            );
            b = moveNode(
              b,
              id,
              ref.parentId,
              siblings.findIndex((n) => n.id === prev) + 1,
            );
            prev = id;
          }
        }
      }
      if (b !== bookmarksStore.get()) commit(b);
    };
    return followPointer(onMove, onUp);
  }, []);

  const startDrag = (id: string, e: PointerEvent) => {
    if (e.button !== 0 || edit) return;
    const ids = selected.has(id)
      ? rows.filter((r) => selected.has(r.id)).map((r) => r.id)
      : [id];
    dragRef.current = { ids, x: e.clientX, y: e.clientY, moving: false };
  };

  const onListKey = (e: KeyboardEvent) => {
    if (edit) return;
    const ids = rows.map((r) => r.id);
    const at = active ? ids.indexOf(active) : -1;
    const mod = e.metaKey || e.ctrlKey;
    const move = (to: number) => {
      if (ids.length === 0) return;
      const id = ids[Math.max(0, Math.min(ids.length - 1, to))];
      pick(id, { metaKey: false, ctrlKey: false, shiftKey: e.shiftKey });
      listRef.current?.querySelector<HTMLElement>(
        `[data-bmm-id="${CSS.escape(id)}"]`,
      )?.scrollIntoView({ block: "nearest" });
    };
    const node = active ? nodeById(bookmarks, active) : undefined;
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? ids.length - 1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(ids.length - 1);
    else if (e.key === " " && active) {
      pick(active, { metaKey: true, ctrlKey: false, shiftKey: false });
    } else if (e.key === "a" && mod) setSelected(new Set(ids));
    else if (e.key === "Enter" && node) {
      openRow(node, mod ? "tile" : "here");
    } else if (e.key === "F2" && node) {
      setEdit({ id: node.id, field: "title", value: node.title });
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
      remove([...selected]);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onTreeKey = (e: KeyboardEvent) => {
    const ids = tree.map((t) => t.node.id);
    const at = ids.indexOf(folderId);
    let to = -1;
    if (e.key === "ArrowDown") to = Math.min(ids.length - 1, at + 1);
    else if (e.key === "ArrowUp") to = Math.max(0, at - 1);
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = ids.length - 1;
    else if (e.key === "Enter" || e.key === "ArrowRight") {
      e.preventDefault();
      listRef.current?.focus();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    setQuery("");
    setFolderId(ids[to]);
    setSelected(new Set());
    setActive(null);
  };

  const editField = (n: BookmarkNode, field: "title" | "url") => (
    <input
      type="text"
      class="bmm-edit"
      data-testid={`bmm-edit-${field}`}
      spellcheck={false}
      autocomplete="off"
      value={edit!.value}
      ref={(el: HTMLInputElement | null) => {
        if (el && document.activeElement !== el) {
          el.focus();
          el.select();
        }
      }}
      onInput={(e) =>
        setEdit({
          id: n.id,
          field,
          value: (e.target as HTMLInputElement).value,
        })}
      onBlur={saveEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (field === "url" && !bookmarkUrl(edit!.value)) return;
          saveEdit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setEdit(null);
          listRef.current?.focus();
        }
        e.stopPropagation();
      }}
    />
  );

  const where = searching
    ? `Search: ${rows.length} ${rows.length === 1 ? "bookmark" : "bookmarks"}`
    : pathOf(bookmarks, folderId).map((n) => n.title).join(" › ");

  return (
    <Modal
      label="Bookmarks"
      testid="bm-manager"
      class="bm-manager"
      onClose={props.onClose}
    >
      <div class="modal-head">
        <h2>Bookmarks</h2>
        <label class="bmm-search">
          <WebIcon name="search" size={13} />
          <input
            type="search"
            data-testid="bmm-search"
            placeholder="Search bookmarks"
            aria-label="Search bookmarks"
            spellcheck={false}
            autocomplete="off"
            value={query}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setSelected(new Set());
              setActive(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                listRef.current?.focus();
              } else if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </label>
        <button
          type="button"
          class="btn-quiet"
          data-testid="bmm-close"
          onClick={props.onClose}
        >
          Done
        </button>
      </div>
      <div class="bmm-tools">
        <button
          type="button"
          class="btn-quiet"
          data-testid="bmm-new-folder"
          onClick={newFolder}
        >
          <WebIcon name="plus" size={12} /> New folder
        </button>
        <button
          type="button"
          class="btn-quiet is-danger"
          data-testid="bmm-delete"
          disabled={selected.size === 0}
          onClick={() => remove([...selected])}
        >
          Delete{selected.size > 1 ? ` ${selected.size}` : ""}
        </button>
        <span class="bmm-tools-gap" />
        <button
          type="button"
          class="btn-quiet"
          data-testid="bmm-import"
          title="Import a bookmarks HTML file exported from Chrome, Safari, Firefox or Edge"
          onClick={() => fileRef.current?.click()}
        >
          Import…
        </button>
        <input
          type="file"
          ref={fileRef}
          data-testid="bmm-import-file"
          accept=".html,.htm,text/html"
          hidden
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            const file = input.files?.[0];
            if (file) onImportFile(file);
            input.value = "";
          }}
        />
        <button
          type="button"
          class="btn-quiet"
          data-testid="bmm-export"
          title="The bookmarks as an HTML file every browser imports"
          onClick={onExport}
        >
          Export
        </button>
      </div>
      <div class="bmm-body">
        <div
          class="bmm-tree"
          role="tree"
          aria-label="Folders"
          data-testid="bmm-tree"
          tabIndex={0}
          onKeyDown={(e) => onTreeKey(e as unknown as KeyboardEvent)}
        >
          {tree.map(({ node: f, depth }) => (
            <div
              key={f.id}
              role="treeitem"
              aria-selected={!searching && f.id === folderId}
              aria-level={depth + 1}
              class={`bmm-folder${
                !searching && f.id === folderId ? " is-current" : ""
              }${drop?.id === f.id ? " is-drop-into" : ""}`}
              data-testid="bmm-folder"
              data-bmm-id={f.id}
              data-bmm-tree="true"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => {
                setQuery("");
                setFolderId(f.id);
                setSelected(new Set());
                setActive(null);
              }}
            >
              <WebIcon name="folder" size={13} />
              <span class="bmm-folder-name">{f.title}</span>
              <span class="bmm-count">
                {descendantsOf(bookmarks, f.id).filter((n) =>
                  n.kind === "bookmark"
                ).length || ""}
              </span>
            </div>
          ))}
        </div>
        <div class="bmm-main">
          <div class="bmm-where" data-testid="bmm-where">{where}</div>
          <div
            class="bmm-list"
            role="listbox"
            aria-label={where}
            aria-multiselectable="true"
            aria-activedescendant={active ? `bmm-row-${active}` : undefined}
            data-testid="bmm-list"
            tabIndex={0}
            ref={listRef}
            onKeyDown={(e) => onListKey(e as unknown as KeyboardEvent)}
          >
            {rows.length === 0 && (
              <div class="bmm-empty" data-testid="bmm-empty">
                {searching ? "No bookmarks match." : "This folder is empty."}
              </div>
            )}
            {rows.map((n) => (
              <div
                key={n.id}
                id={`bmm-row-${n.id}`}
                role="option"
                aria-selected={selected.has(n.id)}
                class={`bmm-row${selected.has(n.id) ? " is-selected" : ""}${
                  active === n.id ? " is-active" : ""
                }${drop?.id === n.id ? ` is-drop-${drop.where}` : ""}`}
                data-testid="bmm-row"
                data-bmm-id={n.id}
                data-bmm-folder={n.kind === "folder" ? "true" : undefined}
                onPointerDown={(e) =>
                  startDrag(n.id, e as unknown as PointerEvent)}
                onClick={(e) => {
                  if (edit?.id === n.id) return;
                  pick(n.id, e);
                  listRef.current?.focus();
                }}
                onMouseUp={(e) => {
                  if (e.button === 1 && n.kind === "bookmark") {
                    e.preventDefault();
                    openRow(n, "tile");
                  }
                }}
              >
                <BookmarkGlyph node={n} />
                <span
                  class="bmm-title"
                  data-testid="bmm-title"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (isRoot(n.id)) return;
                    setEdit({ id: n.id, field: "title", value: n.title });
                  }}
                >
                  {edit?.id === n.id && edit.field === "title"
                    ? editField(n, "title")
                    : n.title}
                </span>
                {n.kind === "bookmark" && (
                  <span
                    class="bmm-url"
                    data-testid="bmm-url"
                    title={n.url}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEdit({ id: n.id, field: "url", value: n.url! });
                    }}
                  >
                    {edit?.id === n.id && edit.field === "url"
                      ? editField(n, "url")
                      : n.url}
                  </span>
                )}
                {searching && (
                  <span class="bmm-in">
                    {nodeById(bookmarks, n.parentId!)?.title}
                  </span>
                )}
                <span class="bmm-row-actions">
                  <button
                    type="button"
                    class="bmm-row-btn"
                    tabIndex={-1}
                    data-testid="bmm-rename"
                    aria-label={`Rename ${n.title}`}
                    title="Rename (F2)"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEdit({ id: n.id, field: "title", value: n.title });
                    }}
                  >
                    Rename
                  </button>
                  {n.kind === "bookmark" && (
                    <button
                      type="button"
                      class="bmm-row-btn"
                      tabIndex={-1}
                      data-testid="bmm-open"
                      aria-label={`Open ${n.title}`}
                      title="Open (Enter); in a new tile: ⌘-click or middle click"
                      onClick={(e) => {
                        e.stopPropagation();
                        openRow(n, e.metaKey || e.ctrlKey ? "tile" : "here");
                      }}
                    >
                      Open
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {toast && (
        <div class="bmm-toast" role="status" data-testid="bmm-toast">
          <span>{toast.text}</span>
          {toast.removed && (
            <button
              type="button"
              class="btn-quiet"
              data-testid="bmm-undo"
              onClick={() => {
                const back = restoreNodes(bookmarksStore.get(), toast.removed!);
                bookmarksStore.set(back);
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
          <button
            type="button"
            class="bmm-toast-close"
            aria-label="Dismiss"
            data-testid="bmm-toast-close"
            onClick={() => setToast(null)}
          >
            <WebIcon name="close" size={11} />
          </button>
        </div>
      )}
    </Modal>
  );
}
