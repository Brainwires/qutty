// The menu of a link in a terminal, at the pointer: right-click on a link (Open / Reveal / Copy),
// and ⌘-click on a remote path in an SSH tile (Download, which cannot open locally). Escape, a
// click elsewhere or picking an item closes it; ↑/↓ move between the items. The items come from
// app/use-links.ts.

import { useEffect, useRef } from "denext";
import { moveIndex } from "../lib/launcher.ts";

export interface LinkMenuItem {
  /** `open`, `edit`, `reveal`, `download`, `copy`. */
  action: string;
  label: string;
  run(): void;
}

export interface LinkMenuProps {
  x: number;
  y: number;
  /** The link, shortened, as the menu's title. */
  title: string;
  items: LinkMenuItem[];
  onClose(): void;
}

export function LinkMenu(props: LinkMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    globalThis.addEventListener("pointerdown", onDown, true);
    return () => globalThis.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Kept inside the window.
  const w = globalThis.innerWidth ?? 1000;
  const h = globalThis.innerHeight ?? 800;
  const left = Math.max(4, Math.min(props.x, w - 280));
  const top = Math.max(4, Math.min(props.y, h - 40 - 30 * props.items.length));

  const onKey = (e: { key: string; preventDefault(): void }) => {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
    ];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") props.onClose();
    else if (e.key === "ArrowDown") {
      items[moveIndex(items.length, at, 1)]?.focus();
    } else if (e.key === "ArrowUp") {
      items[moveIndex(items.length, at, -1)]?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <div
      class="menu link-menu"
      role="menu"
      ref={ref}
      data-testid="link-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      onKeyDown={onKey}
    >
      <div class="link-menu-title" title={props.title}>{props.title}</div>
      {props.items.map((item) => (
        <button
          type="button"
          role="menuitem"
          class="menu-item"
          key={item.action}
          data-testid="link-menu-item"
          data-action={item.action}
          onClick={() => {
            props.onClose();
            item.run();
          }}
        >
          <span class="menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
