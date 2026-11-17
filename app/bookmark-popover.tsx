// The small bookmark popovers: the star's ("Bookmark added": its name and folder, or Remove),
// "Edit…" from the bar's right-click menu (its name, URL and folder) and "New folder…" (a name).
// Under the element they come from, kept in the window; an HTML overlay while open (a native web
// view shows its snapshot).
//
// Keyboard: the name has the focus (selected); Tab moves through the fields and buttons (and
// stays inside), Enter saves, Escape closes keeping what is saved (the star's bookmark stays, as
// in the browsers). A click outside saves and closes.

import { useEffect, useLayoutEffect, useRef, useState } from "denext";
import {
  addFolder,
  bookmarkUrl,
  folderList,
  moveNode,
  nodeById,
  removeNodes,
  updateNode,
} from "../lib/web/bookmarks.ts";
import { useHtmlOverlay } from "./use-html-overlay.ts";
import { bookmarksStore, useSynced } from "./web-stores.ts";
import type { Anchor } from "./web-menu.tsx";

export type BookmarkPopoverMode =
  | { mode: "star"; id: string }
  | { mode: "edit"; id: string }
  | { mode: "newFolder"; parentId: string; index?: number };

export interface BookmarkPopoverProps {
  target: BookmarkPopoverMode;
  anchor: Anchor;
  onClose(): void;
}

const FOCUSABLE = "input, select, button";

export function BookmarkPopover(props: BookmarkPopoverProps) {
  useHtmlOverlay();
  const t = props.target;
  const bookmarks = useSynced(bookmarksStore);
  const node = t.mode === "newFolder" ? undefined : nodeById(bookmarks, t.id);
  const [title, setTitle] = useState(node?.title ?? "New folder");
  const [url, setUrl] = useState(node?.url ?? "");
  const [folder, setFolder] = useState(
    t.mode === "newFolder" ? t.parentId : node?.parentId ?? "bar",
  );
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const savedRef = useRef(false);

  const save = () => {
    if (savedRef.current) return;
    savedRef.current = true;
    let b = bookmarksStore.get();
    if (t.mode === "newFolder") {
      b = addFolder(b, {
        title,
        parentId: t.parentId,
        ...(t.index !== undefined ? { index: t.index } : {}),
      }).bookmarks;
    } else if (nodeById(b, t.id)) {
      b = updateNode(b, t.id, {
        title,
        ...(t.mode === "edit" && node?.kind === "bookmark" ? { url } : {}),
      });
      if (folder !== nodeById(b, t.id)?.parentId) b = moveNode(b, t.id, folder);
    }
    bookmarksStore.set(b);
  };
  const close = (keep: boolean) => {
    if (keep) save();
    props.onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = globalThis.innerWidth || 1000;
    const vh = globalThis.innerHeight || 800;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const a = props.anchor;
    setPos({
      left: Math.max(4, Math.min(a.right - w, vw - w - 4, a.left)),
      top: a.bottom + 4 + h <= vh ? a.bottom + 4 : Math.max(4, a.top - h - 4),
    });
  }, []);

  useEffect(() => {
    const field = ref.current?.querySelector<HTMLInputElement>("input");
    field?.focus();
    field?.select();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current(true);
    };
    globalThis.addEventListener("pointerdown", onDown, true);
    return () => globalThis.removeEventListener("pointerdown", onDown, true);
  }, []);

  // The bookmark went (deleted in another window): nothing is left to edit.
  useEffect(() => {
    if (t.mode !== "newFolder" && !node) props.onClose();
  }, [node === undefined]);

  const folders = folderList(bookmarks).filter(({ node: f }) =>
    // A folder cannot go into itself.
    t.mode === "newFolder" || !node || node.kind !== "folder" ||
    f.id !== node.id
  );
  const urlOk = t.mode !== "edit" || node?.kind !== "bookmark" ||
    bookmarkUrl(url) !== null;
  const heading = t.mode === "star"
    ? "Bookmark added"
    : t.mode === "newFolder"
    ? "New folder"
    : node?.kind === "folder"
    ? "Edit folder"
    : "Edit bookmark";

  return (
    <div
      ref={ref}
      class="bm-popover"
      role="dialog"
      aria-label={heading}
      data-testid="bm-popover"
      data-mode={t.mode}
      style={{
        left: `${pos?.left ?? -9999}px`,
        top: `${pos?.top ?? -9999}px`,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        } else if (e.key === "Enter" && urlOk) {
          const target = e.target as HTMLElement;
          if (target.tagName === "BUTTON") return;
          e.preventDefault();
          close(true);
        } else if (e.key === "Tab") {
          const all = [
            ...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
          ];
          const first = all[0];
          const last = all[all.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div class="bm-popover-head">{heading}</div>
      <label class="bm-field">
        <span>Name</span>
        <input
          type="text"
          data-testid="bm-popover-name"
          spellcheck={false}
          autocomplete="off"
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
      </label>
      {t.mode === "edit" && node?.kind === "bookmark" && (
        <label class="bm-field">
          <span>URL</span>
          <input
            type="text"
            data-testid="bm-popover-url"
            class={urlOk ? "" : "is-invalid"}
            spellcheck={false}
            autocomplete="off"
            value={url}
            onInput={(e) => setUrl((e.target as HTMLInputElement).value)}
          />
        </label>
      )}
      {t.mode !== "newFolder" && (
        <label class="bm-field">
          <span>Folder</span>
          <select
            data-testid="bm-popover-folder"
            value={folder}
            onChange={(e) => setFolder((e.target as HTMLSelectElement).value)}
          >
            {folders.map(({ node: f, depth }) => (
              <option value={f.id} key={f.id}>
                {"  ".repeat(depth)}
                {f.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <div class="bm-popover-actions">
        {t.mode !== "newFolder" && (
          <button
            type="button"
            class="btn-quiet is-danger"
            data-testid="bm-popover-remove"
            onClick={() => {
              savedRef.current = true;
              bookmarksStore.set(
                removeNodes(bookmarksStore.get(), [t.id]).bookmarks,
              );
              props.onClose();
            }}
          >
            Remove
          </button>
        )}
        <span class="bm-popover-gap" />
        <button
          type="button"
          class="btn-primary"
          data-testid="bm-popover-done"
          disabled={!urlOk}
          onClick={() => close(true)}
        >
          {t.mode === "newFolder" ? "Create" : "Done"}
        </button>
      </div>
    </div>
  );
}
