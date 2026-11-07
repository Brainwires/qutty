// The switcher bar: every terminal as a chip, on any edge of the window. It is the overflow
// surface — terminals the cluster cannot show live here — so chips say whether their terminal
// is tiled or not. The chip strip scrolls on wheel and reports the chips scrolled out of view
// in a "+N" menu. Chip moves animate with FLIP; new chips fade in.

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "denext";
import { makeWindowDraggable } from "denext/desktop/window";
import { type LayoutPattern, PATTERN_INFO } from "../lib/layout/mod.ts";
import { type KeyPlatform, shortcutLabel } from "../lib/workspace/keys.ts";
import { barChips } from "../lib/workspace/bar.ts";
import {
  type BarPosition,
  PATTERNS,
  type TerminalEntry,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import { isTintId } from "../lib/workspace/themes.ts";
import { PatternPreview } from "./pattern-preview.tsx";
import { LaunchMenu, type LaunchMenuProps } from "./launch-menu.tsx";

export interface SwitcherBarProps {
  state: WorkspaceState;
  visibleIds: Set<string>;
  position: BarPosition;
  pattern: LayoutPattern;
  platform: KeyPlatform;
  desktop: boolean;
  settingsOpen: boolean;
  onFocus(id: string): void;
  onClose(id: string): void;
  onNew(): void;
  /** The `+` picker's entries and actions (app/launch-menu.tsx). */
  launch: Pick<
    LaunchMenuProps,
    "sections" | "plusTitle" | "plusEntryId" | "onLaunch" | "sandbox" | "ollama"
  >;
  /** The picker opened (the workspace refreshes its entries). */
  onLaunchOpen(): void;
  /** Put the keyboard back in the focused terminal (Escape in the picker). */
  onRefocus(): void;
  /** The SSH connection manager (the button next to `+`). */
  connectionsOpen: boolean;
  onConnections(): void;
  onPattern(pattern: LayoutPattern): void;
  onToggleSettings(): void;
  /** The Workspaces menu (desktop app), before the settings button. */
  workspaces?: ReactNode;
}

/** Scroll `list` so chip `el` is in view, by where the chip is laid out (its FLIP transform aside). */
function revealChip(list: HTMLElement, el: HTMLElement, vertical: boolean) {
  const t = getComputedStyle(el).transform;
  const m = t && t !== "none" ? new DOMMatrixReadOnly(t) : undefined;
  const r = el.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  const [start, end, lo, hi] = vertical
    ? [r.top - (m?.m42 ?? 0), r.bottom - (m?.m42 ?? 0), box.top, box.bottom]
    : [r.left - (m?.m41 ?? 0), r.right - (m?.m41 ?? 0), box.left, box.right];
  const by = start < lo
    ? start - lo
    : end > hi
    ? Math.min(end - hi, start - lo)
    : 0;
  if (by !== 0) list.scrollBy(vertical ? { top: by } : { left: by });
}

export function SwitcherBar(props: SwitcherBarProps) {
  const barRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const chipEls = useRef(new Map<string, HTMLElement>());
  const prevRects = useRef(new Map<string, DOMRect>());
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [menu, setMenu] = useState<"none" | "more" | "pattern" | "launch">(
    "none",
  );
  const vertical = props.position === "left" || props.position === "right";
  const chips = barChips(props.state, props.visibleIds);
  const ids = chips.map((c) => c.id);
  const byId = new Map<string, TerminalEntry>(
    props.state.terminals.map((t) => [t.id, t]),
  );
  const focusedId = props.state.focusedId;

  // The bar background is the window's drag region on desktop (chips and buttons opt out).
  useEffect(() => {
    const el = barRef.current;
    if (!props.desktop || !el) return;
    return makeWindowDraggable(el);
  }, [props.desktop, props.position]);

  // FLIP: chips that moved start at their old position and glide to the new one.
  const orderKey = ids.join("\u0000") + (vertical ? "|v" : "|h");
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>();
    for (const [id, el] of chipEls.current) {
      next.set(id, el.getBoundingClientRect());
    }
    const prev = prevRects.current;
    prevRects.current = next;
    if (prev.size === 0) return;
    const moved: HTMLElement[] = [];
    for (const [id, el] of chipEls.current) {
      const a = prev.get(id);
      const b = next.get(id);
      if (!a || !b) continue;
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(el);
    }
    if (moved.length === 0) return;
    // Commit the inverted transforms, then let the CSS transition play them back.
    void listRef.current?.offsetWidth;
    const raf = requestAnimationFrame(() => {
      for (const el of moved) {
        el.style.transition = "";
        el.style.transform = "";
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      // Superseded before its frame (the order changed again): drop the inversion now, or these
      // chips stay displaced for good and the next FLIP measures them where they are drawn.
      for (const el of moved) el.style.transform = "";
      requestAnimationFrame(() => {
        for (const el of moved) {
          if (el.style.transform === "") el.style.transition = "";
        }
      });
    };
  }, [orderKey]);

  // Which chips are scrolled out of view → the "+N" menu.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = list.getBoundingClientRect();
      const hidden: string[] = [];
      for (const id of ids) {
        const el = chipEls.current.get(id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const out = vertical
          ? r.top < box.top - 1 || r.bottom > box.bottom + 1
          : r.left < box.left - 1 || r.right > box.right + 1;
        if (out) hidden.push(id);
      }
      setHiddenIds((
        h,
      ) => (h.length === hidden.length && h.every((x, i) => x === hidden[i])
        ? h
        : hidden)
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(list);
    // A chip changing width (its title arrives) moves the ones after it without resizing the list.
    for (const el of chipEls.current.values()) ro.observe(el);
    list.addEventListener("scroll", schedule, { passive: true });
    // The first measure runs while moved chips are still gliding (FLIP) and new ones are still
    // scaling in, so their rects are not final: measure again when those motions end.
    list.addEventListener("transitionend", schedule);
    list.addEventListener("animationend", schedule);
    return () => {
      ro.disconnect();
      list.removeEventListener("scroll", schedule);
      list.removeEventListener("transitionend", schedule);
      list.removeEventListener("animationend", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [orderKey, vertical]);

  // Keep the focused chip in view. Not `scrollIntoView`: a focus change that reorders the chips
  // (MRU order) has just inverted them for FLIP, and the chip's box is still drawn where it was;
  // scrolling to that would scroll to its old place (with Reduce Motion, for good).
  useEffect(() => {
    const list = listRef.current;
    const el = focusedId ? chipEls.current.get(focusedId) : undefined;
    if (list && el) revealChip(list, el, vertical);
  }, [focusedId]);

  // Close menus on Escape or an outside click.
  useEffect(() => {
    if (menu === "none") return;
    const onDown = (e: PointerEvent) => {
      const bar = barRef.current;
      if (bar && e.target instanceof Node && !bar.contains(e.target)) {
        setMenu("none");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase + stop: the Escape that closes a menu must not also reach the shell.
      e.preventDefault();
      e.stopPropagation();
      setMenu("none");
      if (menu === "launch") props.onRefocus();
    };
    globalThis.addEventListener("pointerdown", onDown, true);
    globalThis.addEventListener("keydown", onKey, true);
    return () => {
      globalThis.removeEventListener("pointerdown", onDown, true);
      globalThis.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const pick = (id: string) => {
    setMenu("none");
    props.onFocus(id);
  };

  const mod = (keys: string) => shortcutLabel(keys, props.platform);

  return (
    <nav
      ref={barRef}
      class={`bar bar-${props.position}${vertical ? " is-vertical" : ""}`}
      aria-label="Terminals"
      data-testid="bar"
      data-position={props.position}
    >
      <div class="bar-lead" data-no-window-drag>
        <LaunchMenu
          {...props.launch}
          plusTitle={`${props.launch.plusTitle} ${mod("Mod+T")}`}
          open={menu === "launch"}
          onNew={props.onNew}
          onToggle={(open) => {
            setMenu(open ? "launch" : "none");
            if (open) props.onLaunchOpen();
          }}
          onLaunch={(entry) => {
            setMenu("none");
            props.launch.onLaunch(entry);
          }}
          onConnections={() => {
            setMenu("none");
            props.onConnections();
          }}
          {...(props.launch.ollama
            ? {
              ollama: {
                newCount: props.launch.ollama.newCount,
                onOpen: () => {
                  setMenu("none");
                  props.launch.ollama?.onOpen();
                },
              },
            }
            : {})}
        />
        <button
          type="button"
          class={`bar-btn bar-connections${
            props.connectionsOpen ? " is-open" : ""
          }`}
          data-testid="bar-connections"
          onClick={props.onConnections}
          aria-expanded={props.connectionsOpen}
          title={`SSH connections ${mod("Mod+Shift+O")}`}
          aria-label="SSH connections"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <rect
              x="2"
              y="2.5"
              width="12"
              height="4.5"
              rx="1.2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <rect
              x="2"
              y="9"
              width="12"
              height="4.5"
              rx="1.2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <circle cx="4.8" cy="4.75" r="0.9" fill="currentColor" />
            <circle cx="4.8" cy="11.25" r="0.9" fill="currentColor" />
          </svg>
        </button>
      </div>
      <div
        class="chips"
        data-testid="chips"
        ref={listRef}
        onWheel={(e) => {
          const list = listRef.current;
          if (!list || vertical) return;
          // A mouse wheel scrolls the horizontal strip; a trackpad's horizontal delta already does.
          // (denext's WheelEvent type lacks deltaX/deltaY; the native event has them.)
          const w = e as unknown as globalThis.WheelEvent;
          if (Math.abs(w.deltaY) > Math.abs(w.deltaX)) {
            list.scrollLeft += w.deltaY;
            w.preventDefault();
          }
        }}
      >
        {chips.map(({ id, entry: t, ordinal, rank, tiled, focused }) => {
          const cls = ["chip", tiled ? "is-tiled" : "is-overflow"];
          if (focused) cls.push("is-focused");
          if (t.exited) cls.push("is-exited");
          if (t.activity) cls.push("has-activity");
          return (
            <div
              key={id}
              ref={(el: HTMLDivElement | null) => {
                if (el) chipEls.current.set(id, el);
                else chipEls.current.delete(id);
              }}
              class={cls.join(" ")}
              data-testid="chip"
              data-id={id}
              data-ordinal={ordinal}
              data-rank={rank}
              data-tiled={tiled ? "true" : "false"}
              data-focused={focused ? "true" : "false"}
              data-exited={t.exited ? "true" : "false"}
              data-activity={t.activity ? "true" : "false"}
              data-tint={isTintId(t.ssh?.tint) ? t.ssh.tint : undefined}
              role="button"
              tabIndex={0}
              data-no-window-drag
              title={`${t.title}${tiled ? "" : " (not tiled)"} — rank ${rank}`}
              onClick={() => props.onFocus(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  props.onFocus(id);
                }
              }}
            >
              {ordinal <= 9 && <span class="chip-ordinal">{ordinal}</span>}
              <span class="chip-dot" aria-hidden="true" />
              <span class="chip-title">{t.title}</span>
              {t.exited && <span class="chip-exit">exited</span>}
              <button
                type="button"
                class="chip-close"
                data-testid="chip-close"
                aria-label={`Close ${t.title}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose(id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div class="bar-tail" data-no-window-drag>
        {hiddenIds.length > 0 && (
          <div class="menu-anchor">
            <button
              type="button"
              class={`bar-btn bar-more${menu === "more" ? " is-open" : ""}`}
              data-testid="bar-more"
              onClick={() => setMenu(menu === "more" ? "none" : "more")}
              aria-expanded={menu === "more"}
              title="Terminals scrolled out of view"
            >
              +{hiddenIds.length}
            </button>
            {menu === "more" && (
              <div class="menu" role="menu" data-testid="overflow-menu">
                {hiddenIds.map((id) => {
                  const t = byId.get(id);
                  if (!t) {
                    return null;
                  }
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      data-testid="overflow-item"
                      data-id={id}
                      key={id}
                      onClick={() => pick(id)}
                    >
                      <span class={`chip-dot${t.activity ? " on" : ""}`} />
                      <span class="menu-label">{t.title}</span>
                      {t.exited && <span class="chip-exit">exited</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div class="menu-anchor">
          <button
            type="button"
            class={`bar-btn bar-pattern${menu === "pattern" ? " is-open" : ""}`}
            data-testid="bar-pattern"
            data-pattern={props.pattern}
            onClick={() => setMenu(menu === "pattern" ? "none" : "pattern")}
            aria-expanded={menu === "pattern"}
            title={`Layout: ${PATTERN_INFO[props.pattern].label} (${
              mod("Mod+Shift+L")
            } cycles)`}
          >
            <PatternPreview pattern={props.pattern} small />
            {!vertical && (
              <span class="bar-pattern-label">
                {PATTERN_INFO[props.pattern].label}
              </span>
            )}
          </button>
          {menu === "pattern" && (
            <div
              class="menu menu-patterns"
              role="menu"
              data-testid="pattern-menu"
            >
              {PATTERNS.map((p) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={p === props.pattern}
                  class={`menu-item${p === props.pattern ? " is-active" : ""}`}
                  data-testid="pattern-item"
                  data-pattern={p}
                  key={p}
                  onClick={() => {
                    setMenu("none");
                    props.onPattern(p);
                  }}
                >
                  <PatternPreview pattern={p} />
                  <span class="menu-label">{PATTERN_INFO[p].label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {props.workspaces}
        <button
          type="button"
          class={`bar-btn bar-settings${props.settingsOpen ? " is-open" : ""}`}
          data-testid="bar-settings"
          onClick={props.onToggleSettings}
          aria-expanded={props.settingsOpen}
          aria-label="Layout settings"
          title="Layout settings"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              fill="none"
            />
            <circle
              cx="10.5"
              cy="4.5"
              r="1.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <circle
              cx="5.5"
              cy="11.5"
              r="1.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            />
          </svg>
        </button>
      </div>
    </nav>
  );
}
