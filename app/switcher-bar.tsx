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
// button reads Free-form. With the native menus on (desktop app), the Tiles list is the Window
// menu's and leaves this menu; the View choice and the patterns, with their previews, stay.

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
import { barChips, chipScrollTarget } from "../lib/workspace/bar.ts";
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
import { useHtmlOverlay } from "./use-html-overlay.ts";
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
    | "sections"
    | "plusTitle"
    | "plusEntryId"
    | "onLaunch"
    | "sandbox"
    | "ollama"
    | "onWebPage"
    | "onAgentChat"
    | "apiKeyChat"
    | "agentPresets"
    | "onBookmarks"
    | "onHistory"
    | "onSourceControl"
  >;
  /** The picker opened (the workspace refreshes its entries). */
  onLaunchOpen(): void;
  /** Put the keyboard back in the focused terminal (Escape in the picker). */
  onRefocus(): void;
  /** The SSH connection manager (the button next to `+`). */
  connectionsOpen: boolean;
  onConnections(): void;
  /**
   * Broadcast input (cluster ssh): whether it is on, how many tiles are checked, and which (their
   * chips get a badge).
   */
  broadcast: { on: boolean; count: number; members?: ReadonlySet<string> };
  onBroadcast(): void;
  onPattern(pattern: LayoutPattern): void;
  /** An item of the View menu's model (the view, an arrange command, a tile of the list). */
  onMenuItem(id: string): void;
  /** The native menus are on: the Window menu lists the tiles, so this menu does not. */
  nativeMenus?: boolean;
  onToggleSettings(): void;
  /** The system meter's figures (Settings → System monitor); absent: no meter. */
  stats?: Smoothed;
  /** The Workspaces menu (desktop app), before the settings button. */
  workspaces?: ReactNode;
}

/**
 * Keep the page's focus where it is through this press: its `mousedown` would move it to whatever
 * it lands on (the chip, or the strip if the chip has already moved away), taking the keyboard
 * from the terminal the press just focused. Tab still reaches a chip.
 */
function keepFocusThroughPress(): void {
  const stop = (e: Event) => e.preventDefault();
  const done = () => {
    removeEventListener("mousedown", stop, true);
    removeEventListener("pointerup", done, true);
    removeEventListener("pointercancel", done, true);
  };
  addEventListener("mousedown", stop, true);
  addEventListener("pointerup", done, true);
  addEventListener("pointercancel", done, true);
}

/** Where a chip is laid out, in its offset parent: no FLIP transform, no scroll of the strip. */
interface ChipPos {
  left: number;
  top: number;
}

/**
 * Every chip's layout position. Not `getBoundingClientRect`: that moves with a scroll of the strip
 * (revealChip's smooth scroll, the user's), which would read as every chip having moved.
 */
function chipPositions(els: Map<string, HTMLElement>): Map<string, ChipPos> {
  const out = new Map<string, ChipPos>();
  for (const [id, el] of els) {
    out.set(id, { left: el.offsetLeft, top: el.offsetTop });
  }
  return out;
}

/**
 * Where `list` must scroll to show chip `el` (`null`: it is in view), by where the chip is laid
 * out (its FLIP transform aside), as an absolute position of the strip.
 */
function chipTarget(
  list: HTMLElement,
  el: HTMLElement,
  vertical: boolean,
): number | null {
  const t = getComputedStyle(el).transform;
  const m = t && t !== "none" ? new DOMMatrixReadOnly(t) : undefined;
  const r = el.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  // The chip in the strip's content coordinates: its viewport place, less the strip's, plus how
  // far the strip is scrolled right now (a smooth scroll under way included).
  const [start, end] = vertical
    ? [r.top - (m?.m42 ?? 0), r.bottom - (m?.m42 ?? 0)]
      .map((v) => v - box.top - list.clientTop + list.scrollTop)
    : [r.left - (m?.m41 ?? 0), r.right - (m?.m41 ?? 0)]
      .map((v) => v - box.left - list.clientLeft + list.scrollLeft);
  return chipScrollTarget({ start, end }, {
    scroll: vertical ? list.scrollTop : list.scrollLeft,
    size: vertical ? list.clientHeight : list.clientWidth,
    content: vertical ? list.scrollHeight : list.scrollWidth,
  });
}

/** How many frames a strip with a reveal pending may stand still before it is aimed again. */
const STALL_FRAMES = 8;
/** How many times a stalled reveal is aimed again before it is given up. */
const STALL_TRIES = 4;

/** The strip's scroll position on its axis. */
const scrollPos = (list: HTMLElement, vertical: boolean) =>
  vertical ? list.scrollTop : list.scrollLeft;

export function SwitcherBar(props: SwitcherBarProps) {
  const barRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const chipEls = useRef(new Map<string, HTMLElement>());
  /** Where each chip was laid out at the last render (see the FLIP effect). */
  const prevRects = useRef(new Map<string, ChipPos>());
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [menu, setMenu] = useState<"none" | "more" | "pattern" | "launch">(
    "none",
  );
  // The bar's own menus (the launch menu registers itself) drop over the tiles.
  useHtmlOverlay(menu === "more" || menu === "pattern");
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
    const next = chipPositions(chipEls.current);
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
  // Keep the "before" positions current between reorders: a chip's width changes with its title
  // and the bar's size, and a FLIP from positions measured at the last reorder would glide every
  // chip whose neighbours changed width since. (Runs after the FLIP effect, every render.)
  useLayoutEffect(() => {
    prevRects.current = chipPositions(chipEls.current);
  });

  // Keep the focused chip in view. Not `scrollIntoView`: a focus change that reorders the chips
  // (MRU order) has just inverted them for FLIP, and the chip's box is still drawn where it was;
  // scrolling to that would scroll to its old place (with Reduce Motion, for good).
  //
  // A reveal is wanted from a focus change (or a reorder) until the chip is seen in view, and is
  // checked again whenever the strip settles (the measure below: a smooth scroll's end, a FLIP
  // glide's end, a resize). The strip's smooth scroll did not always run or finish (a reorder or
  // a resize under way, a second focus change), which left the focused chip (first in MRU order)
  // scrolled out of view on the left; aiming at an absolute place again until it is in view fixes
  // that, and no timer is involved. Someone else scrolling the strip drops the wish: the user (a
  // wheel, a press in it), or any scroll that moves away from where the bar aims (a script's
  // `scrollIntoView`), so the bar never fights it.
  const reveal = useRef({
    want: false,
    aim: null as number | null,
    /** The strip's position at the last scroll event or aim. */
    at: 0,
  });
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;
  const verticalRef = useRef(vertical);
  verticalRef.current = vertical;
  /** Scroll toward the focused chip if it is wanted and not in view (`settled`: no scroll runs). */
  const revealFocused = useRef((settled: boolean) => {
    const r = reveal.current;
    const list = listRef.current;
    const id = focusedRef.current;
    const el = id ? chipEls.current.get(id) : undefined;
    if (!r.want || !list || !el) return;
    const v = verticalRef.current;
    const target = chipTarget(list, el, v);
    if (target === null) {
      r.want = false;
      r.aim = null;
      return;
    }
    // On its way there already: asking again mid-scroll would only restart it.
    if (
      !settled && r.aim !== null && Math.abs(target - r.aim) <= 1 &&
      Math.abs(scrollPos(list, v) - target) > 1
    ) return;
    r.aim = target;
    r.at = scrollPos(list, v);
    list.scrollTo(v ? { top: target } : { left: target });
    watchStall();
  }).current;
  /**
   * While a reveal is pending, watch the strip frame by frame: a smooth scroll that stopped short
   * fires no event at all (no `scrollend`), so a strip that has not moved for
   * {@linkcode STALL_FRAMES} frames is aimed again. Ends once the chip is in view or the reveal
   * is dropped; a frame callback, not a timer, and nothing here touches the keyboard.
   */
  const stallFrame = useRef(0);
  const watchStall = () => {
    if (stallFrame.current) return;
    let last = NaN;
    let still = 0;
    let tries = 0;
    const tick = () => {
      stallFrame.current = 0;
      const list = listRef.current;
      if (!reveal.current.want || !list) return;
      const pos = scrollPos(list, verticalRef.current);
      still = Math.abs(pos - last) < 0.5 ? still + 1 : 0;
      last = pos;
      if (still >= STALL_FRAMES) {
        still = 0;
        // A strip that cannot get there (it never moves) is not chased for ever.
        if (++tries > STALL_TRIES) return void (reveal.current.want = false);
        revealFocused(true);
        if (!reveal.current.want) return;
      }
      stallFrame.current = requestAnimationFrame(tick);
    };
    stallFrame.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(stallFrame.current), []);
  useEffect(() => {
    reveal.current = { want: true, aim: null, at: 0 };
    revealFocused(true);
  }, [focusedId, orderKey]);

  // Which chips are scrolled out of view → the "+N" menu; and the focused chip's reveal, checked
  // again as the strip settles.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    let settled = false;
    const measure = () => {
      frame = 0;
      revealFocused(settled);
      settled = false;
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
    const schedule = (still = true) => {
      settled ||= still;
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const settle = () => schedule(true);
    const moving = () => {
      // A scroll away from the aim is someone else's: the reveal stands down.
      const r = reveal.current;
      const pos = scrollPos(list, verticalRef.current);
      if (
        r.want && r.aim !== null &&
        Math.abs(pos - r.aim) > Math.abs(r.at - r.aim) + 1
      ) r.want = false;
      r.at = pos;
      schedule(false);
    };
    schedule();
    const ro = new ResizeObserver(settle);
    ro.observe(list);
    // A chip changing width (its title arrives) moves the ones after it without resizing the list.
    for (const el of chipEls.current.values()) ro.observe(el);
    list.addEventListener("scroll", moving, { passive: true });
    list.addEventListener("scrollend", settle);
    // The first measure runs while moved chips are still gliding (FLIP) and new ones are still
    // scaling in, so their rects are not final: measure again when those motions end.
    list.addEventListener("transitionend", settle);
    list.addEventListener("animationend", settle);
    // The user scrolling the strip: the focused chip need not come back into view.
    const userScroll = () => void (reveal.current.want = false);
    list.addEventListener("wheel", userScroll, { passive: true });
    list.addEventListener("pointerdown", userScroll);
    return () => {
      ro.disconnect();
      list.removeEventListener("scroll", moving);
      list.removeEventListener("scrollend", settle);
      list.removeEventListener("transitionend", settle);
      list.removeEventListener("animationend", settle);
      list.removeEventListener("wheel", userScroll);
      list.removeEventListener("pointerdown", userScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [orderKey, vertical]);

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
      data-part="bar"
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
          {...(props.launch.onWebPage
            ? {
              onWebPage: () => {
                setMenu("none");
                props.launch.onWebPage?.();
              },
            }
            : {})}
          {...(props.launch.onAgentChat
            ? {
              onAgentChat: (agent, preset) => {
                setMenu("none");
                props.launch.onAgentChat?.(agent, preset);
              },
            }
            : {})}
          {...(props.launch.apiKeyChat ? { apiKeyChat: true } : {})}
          {...(props.launch.onBookmarks
            ? {
              onBookmarks: () => {
                setMenu("none");
                props.launch.onBookmarks?.();
              },
            }
            : {})}
          {...(props.launch.onHistory
            ? {
              onHistory: () => {
                setMenu("none");
                props.launch.onHistory?.();
              },
            }
            : {})}
          {...(props.launch.onSourceControl
            ? {
              onSourceControl: (show?: "worktrees") => {
                setMenu("none");
                props.launch.onSourceControl?.(show);
              },
            }
            : {})}
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
          title={`Broadcast: type into several tiles at once (cluster SSH). ${
            mod("Mod+Shift+I")
          }`}
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
        data-part="chips"
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
                data-part="chip"
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
                // Focus on the press, as a browser tab does: the strip can move between press and
                // release (it scrolls to keep the focused chip in view), and a release over
                // something else fires no click. The close button acts on its own click instead.
                onPointerDown={(e) => {
                  const pe = e as unknown as globalThis.PointerEvent;
                  if (pe.button !== 0 || pe.pointerType === "touch") return;
                  if ((pe.target as Element | null)?.closest?.(".chip-close")) {
                    return;
                  }
                  keepFocusThroughPress();
                  props.onFocus(id);
                }}
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
                {props.broadcast.on && props.broadcast.members?.has(id) && (
                  <span
                    class="chip-bcast"
                    data-testid="chip-broadcast"
                    title="Broadcasting: typing here goes to every checked tile"
                  />
                )}
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
              {props.launch.onSourceControl && (
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  data-testid="view-source-control"
                  onClick={() => {
                    setMenu("none");
                    props.launch.onSourceControl?.();
                  }}
                >
                  <span class="menu-check" aria-hidden="true" />
                  <span class="menu-label">Source Control</span>
                </button>
              )}
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
              {!props.nativeMenus && (
                <TilesMenuSection
                  view={view}
                  tiles={menuTiles}
                  onPick={pickItem}
                />
              )}
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
