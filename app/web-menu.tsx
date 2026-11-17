// The web tiles' menus (a bookmarks folder's dropdown and the bar's overflow, the right-click
// menus of the bar, the page, Back and Forward): a menu at a point or under an element, with
// nested submenus. It registers as an HTML overlay (app/use-html-overlay.ts), so a native web
// view shows its snapshot while it is open.
//
// Keyboard (WAI-ARIA menu): ↑/↓ move (wrapping), Home/End jump, Enter or Space picks, → opens a
// submenu and ← or Escape closes it, Escape on the top menu or Tab closes it all. A click outside
// closes it. A middle click, or one with ⌘ (Ctrl elsewhere), picks an item "in a new tile".

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "denext";
import { moveIndex } from "../lib/launcher.ts";
import { useHtmlOverlay } from "./use-html-overlay.ts";
import { WebIcon } from "./web-icons.tsx";

/** How an item was picked. */
export interface PickHow {
  /** A middle click, or ⌘ / Ctrl held: open it in a new tile. */
  newTile: boolean;
}

export type MenuEntry =
  | {
    kind: "item";
    id: string;
    label: string;
    icon?: ReactNode;
    /** Right-aligned, quieter text (a shortcut, a host). */
    hint?: string;
    disabled?: boolean;
    danger?: boolean;
    title?: string;
    run(how: PickHow): void;
  }
  | {
    kind: "submenu";
    id: string;
    label: string;
    icon?: ReactNode;
    /** Its entries, made when it opens. */
    entries(): MenuEntry[];
  }
  | { kind: "sep" }
  | { kind: "heading"; label: string };

/** A rectangle in the viewport. */
export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PopupMenuProps {
  /** A point (a right click) or the element it drops from. */
  at: { x: number; y: number } | Anchor;
  entries: MenuEntry[];
  label: string;
  testid?: string;
  onClose(): void;
  /** A right click on item `id` (the bookmark under it gets its own menu). */
  onItemContext?(id: string, at: { x: number; y: number }): void;
  /** A press on item `id` (where a drag starts). */
  onItemPointerDown?(id: string, e: PointerEvent): void;
}

const ITEM = "[role=menuitem]";

/** Where a menu of `size` goes: below (or above) its anchor, or at its point, inside the window. */
function place(
  at: PopupMenuProps["at"],
  size: { w: number; h: number },
  side: "below" | "right",
): { left: number; top: number } {
  const vw = globalThis.innerWidth || 1000;
  const vh = globalThis.innerHeight || 800;
  const a: Anchor = "x" in at
    ? { left: at.x, top: at.y, right: at.x, bottom: at.y }
    : at;
  let left: number;
  let top: number;
  if (side === "right") {
    left = a.right + size.w <= vw - 4 ? a.right : a.left - size.w;
    top = a.top - 4;
  } else {
    left = a.left;
    top = a.bottom + size.h <= vh - 4 || "x" in at ? a.bottom : a.top - size.h;
  }
  return {
    left: Math.max(4, Math.min(left, vw - size.w - 4)),
    top: Math.max(4, Math.min(top, vh - size.h - 4)),
  };
}

export function PopupMenu(props: PopupMenuProps) {
  useHtmlOverlay();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  // The open submenus: for each level below the top, the item it hangs from and its rect.
  const [open, setOpen] = useState<{ id: string; at: Anchor }[]>([]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!layerRef.current?.contains(e.target as Node)) closeRef.current();
    };
    globalThis.addEventListener("pointerdown", onDown, true);
    return () => globalThis.removeEventListener("pointerdown", onDown, true);
  }, []);

  const levels: { entries: MenuEntry[]; at: PopupMenuProps["at"] }[] = [
    { entries: props.entries, at: props.at },
  ];
  for (const o of open) {
    const parent = levels[levels.length - 1].entries.find((e) =>
      e.kind === "submenu" && e.id === o.id
    );
    if (!parent || parent.kind !== "submenu") break;
    levels.push({ entries: parent.entries(), at: o.at });
  }

  return (
    <div class="web-menu-layer" ref={layerRef}>
      {levels.map((level, depth) => (
        <MenuLevel
          key={depth === 0 ? "top" : open[depth - 1].id}
          depth={depth}
          entries={level.entries}
          at={level.at}
          label={depth === 0 ? props.label : open[depth - 1].id}
          testid={depth === 0 ? props.testid : `${props.testid ?? "menu"}-sub`}
          openId={open[depth]?.id}
          onOpen={(id, at, focus) => {
            setOpen((was) => [...was.slice(0, depth), { id, at }]);
            if (focus) pendingFocus = depth + 1;
          }}
          onCloseLevel={() => {
            if (depth === 0) return props.onClose();
            setOpen((was) => was.slice(0, depth - 1));
            const parent = layerRef.current?.querySelectorAll<HTMLElement>(
              "[data-menu-level]",
            )[depth - 1];
            parent?.querySelector<HTMLElement>(
              `[data-id="${CSS.escape(open[depth - 1].id)}"]`,
            )?.focus();
          }}
          onCloseBelow={() => setOpen((was) => was.slice(0, depth))}
          onCloseAll={props.onClose}
          onItemContext={props.onItemContext}
          onItemPointerDown={props.onItemPointerDown}
        />
      ))}
    </div>
  );
}

/**
 * Follow the pointer on the window while a drag may be under way (the bookmarks bar, the
 * manager): `onMove` on each move, `onUp` when it is let go or cancelled. Returns the stop.
 */
export function followPointer(
  onMove: (e: PointerEvent) => void,
  onUp: (e: PointerEvent) => void,
): () => void {
  globalThis.addEventListener("pointermove", onMove);
  globalThis.addEventListener("pointerup", onUp);
  globalThis.addEventListener("pointercancel", onUp);
  return () => {
    globalThis.removeEventListener("pointermove", onMove);
    globalThis.removeEventListener("pointerup", onUp);
    globalThis.removeEventListener("pointercancel", onUp);
  };
}

/** The level that should take the keyboard once it renders (a submenu opened by key). */
let pendingFocus = -1;

function MenuLevel(props: {
  depth: number;
  entries: MenuEntry[];
  at: PopupMenuProps["at"];
  label: string;
  testid?: string;
  openId?: string;
  onOpen(id: string, at: Anchor, focus: boolean): void;
  onCloseLevel(): void;
  /** Close the submenus below this level. */
  onCloseBelow(): void;
  onCloseAll(): void;
  onItemContext?: PopupMenuProps["onItemContext"];
  onItemPointerDown?: PopupMenuProps["onItemPointerDown"];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(place(props.at, {
      w: el.offsetWidth,
      h: el.offsetHeight,
    }, props.depth === 0 ? "below" : "right"));
  }, [props.entries.length]);
  useEffect(() => {
    // The top menu takes the keyboard at once; a submenu when it was opened by key.
    if (props.depth === 0 || pendingFocus === props.depth) {
      pendingFocus = -1;
      ref.current?.querySelector<HTMLElement>(ITEM)?.focus();
    }
  }, []);

  const openSub = (el: HTMLElement, id: string, focus: boolean) => {
    const r = el.getBoundingClientRect();
    props.onOpen(id, {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
    }, focus);
  };

  const onKey = (
    e: { key: string; preventDefault(): void; stopPropagation(): void },
  ) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])]
      .filter((el) => !(el as HTMLButtonElement).disabled);
    const active = document.activeElement as HTMLElement | null;
    const at = items.indexOf(active!);
    const entryId = active?.dataset.id;
    const entry = props.entries.find((x) =>
      (x.kind === "item" || x.kind === "submenu") && x.id === entryId
    );
    if (e.key === "ArrowDown") items[moveIndex(items.length, at, 1)]?.focus();
    else if (e.key === "ArrowUp") {
      items[moveIndex(items.length, at, -1)]?.focus();
    } else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items[items.length - 1]?.focus();
    else if (e.key === "ArrowRight" && entry?.kind === "submenu" && active) {
      openSub(active, entry.id, true);
    } else if (e.key === "ArrowLeft" && props.depth > 0) props.onCloseLevel();
    else if (e.key === "Escape") props.onCloseLevel();
    else if (e.key === "Tab") return props.onCloseAll();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      class="menu web-menu"
      role="menu"
      aria-label={props.label}
      data-menu-level={props.depth}
      data-testid={props.testid}
      style={{
        left: `${pos?.left ?? -9999}px`,
        top: `${pos?.top ?? -9999}px`,
      }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {props.entries.length === 0 && (
        <div class="web-menu-empty" data-testid="web-menu-empty">(empty)</div>
      )}
      {props.entries.map((entry, i) => {
        if (entry.kind === "sep") {
          return <div class="menu-sep" role="separator" key={`s${i}`} />;
        }
        if (entry.kind === "heading") {
          return <div class="menu-heading" key={`h${i}`}>{entry.label}</div>;
        }
        const sub = entry.kind === "submenu";
        return (
          <button
            type="button"
            role="menuitem"
            key={entry.id}
            data-id={entry.id}
            data-testid="web-menu-item"
            aria-haspopup={sub ? "menu" : undefined}
            aria-expanded={sub ? props.openId === entry.id : undefined}
            class={`menu-item web-menu-item${
              sub && props.openId === entry.id ? " is-open" : ""
            }${!sub && entry.danger ? " is-danger" : ""}`}
            disabled={!sub && entry.disabled}
            title={!sub ? entry.title : undefined}
            onPointerEnter={(e) => {
              const el = e.currentTarget as HTMLElement;
              if (sub) openSub(el, entry.id, false);
              else if (props.openId) props.onCloseBelow();
            }}
            onPointerDown={(e) =>
              props.onItemPointerDown?.(entry.id, e as unknown as PointerEvent)}
            onContextMenu={(e) => {
              if (!props.onItemContext || sub) return;
              e.preventDefault();
              props.onItemContext(entry.id, { x: e.clientX, y: e.clientY });
            }}
            onMouseDown={(e) => {
              // A middle press would start the browser's autoscroll.
              if (e.button === 1) e.preventDefault();
            }}
            onMouseUp={(e) => {
              // The middle button (no click event comes for it everywhere).
              if (e.button !== 1 || sub) return;
              e.preventDefault();
              props.onCloseAll();
              entry.run({ newTile: true });
            }}
            onClick={(e) => {
              if (sub) {
                return openSub(e.currentTarget as HTMLElement, entry.id, true);
              }
              props.onCloseAll();
              entry.run({ newTile: e.metaKey || e.ctrlKey });
            }}
          >
            {entry.icon && <span class="web-menu-icon">{entry.icon}</span>}
            <span class="menu-label">{entry.label}</span>
            {!sub && entry.hint && (
              <span class="web-menu-hint">{entry.hint}</span>
            )}
            {sub && (
              <span class="web-menu-chevron">
                <WebIcon name="chevron" size={11} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
