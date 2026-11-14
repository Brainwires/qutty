// The switcher bar: every terminal as a chip, on any edge of the window. It is the overflow
// surface — terminals the cluster cannot show live here — so chips say whether their terminal
// is tiled or not, or minimized (put there by the user; a click restores it). The chip strip scrolls on wheel and reports the chips scrolled out of view
// in a "+N" menu. Chip moves animate with FLIP; new chips fade in. Each chip (and each "+N"
// menu item) wears its tile's activity state as `data-activity` and in its dot's colour
// (lib/workspace/activity.ts), and shows the title the tile's header shows.
//
// The layout menu (the pattern button) starts with the View choice, Tiled or Free-form, and the
// free-form arrange commands, and ends with the Tiles list (app/view-menu.tsx, from the menu model
// lib/workspace/mdi-menu.ts); the tiled view's patterns sit between them. In the free-form view the
// button reads Free-form.

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
import { type ActivityState, displayTitle } from "../lib/workspace/activity.ts";
import { PatternPreview } from "./pattern-preview.tsx";
import { TilesMenuSection, ViewMenuSection } from "./view-menu.tsx";
import { VIEW_LABELS } from "../lib/workspace/freeform.ts";
import type { MenuTile } from "../lib/workspace/mdi-menu.ts";
import { LaunchMenu, type LaunchMenuProps } from "./launch-menu.tsx";
import { SysMeter } from "./sys-meter.tsx";
import type { Smoothed } from "../lib/sysstats.ts";

export interface SwitcherBarProps {
  state: WorkspaceState;
  /** Each tile's activity state (missing: none). */
  activity: ReadonlyMap<string, ActivityState>;
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
  /** Broadcast input (cluster ssh): whether it is on, and how many tiles are checked. */
  broadcast: { on: boolean; count: number };
  onBroadcast(): void;
  onPattern(pattern: LayoutPattern): void;
  /** An item of the View menu's model (the view, an arrange command, a tile of the list). */
  onMenuItem(id: string): void;
  onToggleSettings(): void;
  /** The system meter's figures (Settings → System monitor); absent: no meter. */
  stats?: Smoothed;
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
  const activityOf = (id: string) => props.activity.get(id) ?? "none";
  const titleOf = (t: TerminalEntry) =>
    displayTitle(t, props.state.settings.tileTitle);

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
  const view = props.state.view;
  const freeform = view === "freeform";
  const menuTiles: MenuTile[] = chips.map((c) => ({
    id: c.id,
    title: titleOf(c.entry),
    focused: c.focused,
    minimized: c.minimized,
  }));
  const pickItem = (id: string) => {
    setMenu("none");
    props.onMenuItem(id);
  };

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
        <button
          type="button"
          class={`bar-btn bar-broadcast${props.broadcast.on ? " is-on" : ""}`}
          data-testid="bar-broadcast"
          onClick={props.onBroadcast}
          aria-pressed={props.broadcast.on}
          title={`${
            props.broadcast.on
              ? "Stop broadcasting"
              : "Broadcast input to several tiles"
          } ${mod("Mod+Shift+I")}`}
          aria-label="Broadcast input"
        >
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="8" cy="8" r="1.6" fill="currentColor" />
            <path
              d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              fill="none"
            />
          </svg>
          {props.broadcast.on && props.broadcast.count > 0 && (
            <span class="bar-broadcast-count" data-testid="bar-broadcast-count">
              {props.broadcast.count}
            </span>
          )}
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
        {chips.map(
          ({ id, entry: t, ordinal, rank, tiled, minimized, focused }) => {
            const cls = [
              "chip",
              minimized ? "is-minimized" : tiled ? "is-tiled" : "is-overflow",
            ];
            if (focused) cls.push("is-focused");
            if (t.exited) cls.push("is-exited");
            const title = titleOf(t);
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
                data-minimized={minimized ? "true" : undefined}
                data-focused={focused ? "true" : "false"}
                data-exited={t.exited ? "true" : "false"}
                data-activity={activityOf(id)}
                data-tint={isTintId(t.ssh?.tint) ? t.ssh.tint : undefined}
                role="button"
                tabIndex={0}
                data-no-window-drag
                title={`${title}${
                  minimized
                    ? " (minimized: click to restore)"
                    : tiled
                    ? ""
                    : " (not tiled)"
                } — rank ${rank}`}
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
                <span class="chip-title">{title}</span>
                {t.exited && <span class="chip-exit">exited</span>}
                <button
                  type="button"
                  class="chip-close"
                  data-testid="chip-close"
                  aria-label={`Close ${title}`}
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
          },
        )}
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
                      data-activity={activityOf(id)}
                      key={id}
                      onClick={() => pick(id)}
                    >
                      <span class="chip-dot" />
                      <span class="menu-label">{titleOf(t)}</span>
                      {t.exited && <span class="chip-exit">exited</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {props.stats && <SysMeter stats={props.stats} vertical={vertical} />}
        <div class="menu-anchor">
          <button
            type="button"
            class={`bar-btn bar-pattern${menu === "pattern" ? " is-open" : ""}`}
            data-testid="bar-pattern"
            data-pattern={props.pattern}
            data-view={view}
            onClick={() => setMenu(menu === "pattern" ? "none" : "pattern")}
            aria-expanded={menu === "pattern"}
            title={freeform
              ? `View: ${VIEW_LABELS.freeform}`
              : `Layout: ${PATTERN_INFO[props.pattern].label} (${
                mod("Mod+Shift+L")
              } cycles)`}
          >
            {freeform
              ? <FreeformGlyph />
              : <PatternPreview pattern={props.pattern} small />}
            {!vertical && (
              <span class="bar-pattern-label">
                {freeform
                  ? VIEW_LABELS.freeform
                  : PATTERN_INFO[props.pattern].label}
              </span>
            )}
          </button>
          {menu === "pattern" && (
            <div
              class="menu menu-patterns"
              role="menu"
              data-testid="pattern-menu"
            >
              <ViewMenuSection
                view={view}
                tiles={menuTiles}
                onPick={pickItem}
              />
              {!freeform && <div class="menu-sep" role="separator" />}
              {!freeform && PATTERNS.map((p) => (
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
              <TilesMenuSection
                view={view}
                tiles={menuTiles}
                onPick={pickItem}
              />
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

/** The free-form view's mark on the layout button: two overlapping windows. */
function FreeformGlyph() {
  return (
    <svg
      class="freeform-glyph"
      viewBox="0 0 16 12"
      width="16"
      height="12"
      aria-hidden="true"
    >
      <rect
        x="1"
        y="1"
        width="9"
        height="6.5"
        rx="1"
        fill="none"
        stroke="currentColor"
        stroke-width="1.2"
      />
      <rect
        x="5.5"
        y="4"
        width="9.5"
        height="7"
        rx="1"
        fill="var(--panel, #222)"
        stroke="currentColor"
        stroke-width="1.2"
      />
    </svg>
  );
}
