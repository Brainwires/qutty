// The tile cluster: one absolutely positioned tile per terminal, in one container, keyed by id
// and rendered in creation order (never MRU order) so React never moves a tile's DOM node — the
// xterm instance inside stays alive across every re-layout. Position comes from
// `transform: translate()` + width/height, which CSS transitions animate.
//
// A tile not in the layout (overflow) stays mounted but goes through leaving → parked
// (display:none); coming back it goes parked → entering (no transition, at its new rect) →
// shown, which is also how a new terminal animates in.
//
// SSH tiles add a badge and their host tint (`data-tint`), plus whatever the workspace renders
// into the header (`renderHeadLead` on the left, `renderHeadActions` on the right) and over the
// terminal (`renderOverlay`). The tiles input is broadcast to (`broadcastIds`) wear a loud border. A tile the agent
// hub knows an agent harness for (`agentOf`) shows the agent's hub name, its status (busy, idle,
// waiting for the user) and how many messages wait for it.
//
// Scaled inactive tiles (Settings → Inactive tiles: scale): every tile's terminal body is laid
// out at the focused tile's body size, so the terminal manager fits every terminal to that one
// size and a focus change never changes a host's size (nothing to refit, no PTY resize). A
// non-focused tile shows its body letterboxed with `transform: scale()` (which the fit and the
// ResizeObserver do not see) under a transparent click-catcher: xterm's mouse maths does not
// survive a transform, so a scaled terminal takes no selection or mouse reports, and a click
// only focuses the tile.
//
// Window controls: every tile's header has Minimize, Maximize (Restore on the tile shown alone in
// monocle) and Close. A minimized tile is out of the layout, so it parks like an overflow one (a
// web tile's page stays loaded). A double click on the header (not on its controls or a web
// tile's address field) does what the workspace says the OS title-bar double click does.
//
// Activity (lib/workspace/activity.ts): an unfocused tile wears its one activity state as
// `data-activity` (output, busy, attention, failed, done, none), which styles.css draws on the
// header and the border. Its title is the program's own (OSC 0 / 2) when Settings → Tiles says so.
//
// The free-form view (`freeform` set; lib/workspace/freeform.ts): the tiles' rects are the user's,
// stacked in the workspace's z-order. A drag on a header (not on its controls or the address
// field) moves a tile and the grips on its edges and corners resize it (app/use-freeform-drag.ts:
// no transition while the pointer moves). Maximize fills the whole area with the tile (MDI
// maximize), the others behind it; a maximized tile does not drag. A web tile hears when another
// tile covers it from above (`setOccluded`, for a native engine that draws above HTML).

import { type ReactNode, useEffect, useRef, useState } from "denext";
import { type LayoutTile, rankScale, type Rect } from "../lib/layout/mod.ts";
import { EDGES } from "../lib/workspace/freeform.ts";
import {
  type FreeformTiles,
  type StartDrag,
  useFreeformDrag,
} from "./use-freeform-drag.ts";
import { letterbox, type Size, tileBodySize } from "../lib/layout/scale.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TileInfo } from "../lib/hub/protocol.ts";
import { formatAge } from "../lib/workspace/format.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import {
  type ActivityState,
  displayTitle,
  type TileTitle,
} from "../lib/workspace/activity.ts";
import { isTintId } from "../lib/workspace/themes.ts";
import {
  useWebTile,
  WebBody,
  type WebTileHooks,
  WebToolbar,
} from "./web-tile.tsx";

/** The workspace's additions to a tile (SSH tiles, agent badges). */
interface TileExtras {
  /** The tile files are being dragged over. */
  dropTargetId?: string | null;
  /** The agent hub's entry for a tile (the badge is drawn when it has a harness). */
  agentOf?(id: string): TileInfo | undefined;
  renderHeadActions?(entry: TerminalEntry): ReactNode;
  /** Drawn first in the header (the broadcast checkbox). */
  renderHeadLead?(entry: TerminalEntry): ReactNode;
  renderOverlay?(entry: TerminalEntry, focused: boolean): ReactNode;
  /** The tiles typing is broadcast to (marked loudly; empty when broadcast is off). */
  broadcastIds?: ReadonlySet<string>;
  /** What web tiles (an entry with `web`) drive their page through (app/web-tile.tsx). */
  web?: WebTileHooks;
  /** The free-form view (absent: the tiled view). */
  freeform?: FreeformTiles;
}

export interface TileClusterProps extends TileExtras {
  manager: TerminalManager;
  terminals: TerminalEntry[];
  /** Each tile's activity state (missing: none). */
  activity: ReadonlyMap<string, ActivityState>;
  /** Settings → Tiles → Tile title. */
  tileTitle: TileTitle;
  tiles: LayoutTile[];
  focusedId: string | null;
  decay: number;
  now: number;
  reducedMotion: boolean;
  /** Show inactive tiles scaled down at the focused tile's size instead of resizing them. */
  scaleInactive: boolean;
  onFocus(id: string): void;
  onClose(id: string): void;
  /** The maximized tile (monocle, or free-form maximize): its header offers Restore. */
  maximizedId: string | null;
  onMinimize(id: string): void;
  onMaximize(id: string): void;
  onRestore(id: string): void;
  /** A double click on a header's empty part (the OS title-bar double-click action). */
  onHeadDoubleClick(id: string): void;
}

export function TileCluster(props: TileClusterProps) {
  const byId = new Map(props.tiles.map((t) => [t.id, t]));
  // The tiles are in rank order: the first is the focused one.
  const focusedRect = props.tiles[0]?.rect;
  const full = props.scaleInactive && focusedRect
    ? tileBodySize(focusedRect)
    : null;
  return (
    <div class="tiles" data-testid="tiles">
      {props.terminals.map((entry) => (
        <TerminalTile
          key={entry.id}
          entry={entry}
          activity={props.activity.get(entry.id) ?? "none"}
          title={displayTitle(entry, props.tileTitle)}
          tile={byId.get(entry.id)}
          focused={entry.id === props.focusedId}
          manager={props.manager}
          decay={props.decay}
          now={props.now}
          reducedMotion={props.reducedMotion}
          full={full}
          onFocus={props.onFocus}
          onClose={props.onClose}
          maximized={entry.id === props.maximizedId}
          onMinimize={props.onMinimize}
          onMaximize={props.onMaximize}
          onRestore={props.onRestore}
          onHeadDoubleClick={props.onHeadDoubleClick}
          dropTargetId={props.dropTargetId}
          agentOf={props.agentOf}
          renderHeadActions={props.renderHeadActions}
          renderHeadLead={props.renderHeadLead}
          renderOverlay={props.renderOverlay}
          broadcastIds={props.broadcastIds}
          web={props.web}
          freeform={props.freeform}
        />
      ))}
    </div>
  );
}

type Phase = "parked" | "entering" | "shown" | "leaving";

/** How long the leave animation takes (matches `--tile-ms` in styles.css). */
const LEAVE_MS = 260;

interface TerminalTileProps extends TileExtras {
  entry: TerminalEntry;
  activity: ActivityState;
  /** What the header shows (the program's title or the process's). */
  title: string;
  tile: LayoutTile | undefined;
  focused: boolean;
  manager: TerminalManager;
  decay: number;
  now: number;
  reducedMotion: boolean;
  /** Scale mode: the focused tile's body size, which every body is laid out at; else `null`. */
  full: Size | null;
  onFocus(id: string): void;
  onClose(id: string): void;
  /** Shown alone in monocle: the toggle reads Restore. */
  maximized: boolean;
  onMinimize(id: string): void;
  onMaximize(id: string): void;
  onRestore(id: string): void;
  onHeadDoubleClick(id: string): void;
}

/** Scale mode: the body at the full size, letterboxed into the tile's own body unless focused. */
function scaledBodyStyle(full: Size, rect: Rect, focused: boolean) {
  const fit = focused ? null : letterbox(tileBodySize(rect), full);
  return {
    width: `${full.w}px`,
    height: `${full.h}px`,
    transform: fit
      ? `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`
      : "none",
  };
}

function TerminalTile(props: TerminalTileProps) {
  const { entry, tile, manager, focused } = props;
  const id = entry.id;
  const visible = tile !== undefined;
  const [phase, setPhase] = useState<Phase>("parked");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef(false);
  const lastRectRef = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const lastRankRef = useRef(0);
  if (tile) {
    lastRectRef.current = tile.rect;
    lastRankRef.current = tile.rank;
  }
  const rank = lastRankRef.current;
  const ff = props.freeform;
  const drag = useFreeformDrag({
    id,
    rect: lastRectRef.current,
    ff,
    enabled: visible && !props.maximized,
    fit: (tid) => manager.fitNow(tid),
  });
  const rect = drag.live ?? lastRectRef.current;
  // A web tile: its toolbar and its page instead of a terminal (the manager never knows its id,
  // so the manager calls below do nothing for it).
  const web = useWebTile(
    entry,
    focused,
    phase !== "parked",
    props.web,
    props.onFocus,
    ff?.occluded.has(id) ?? false,
  );

  // Phase machine driven by visibility.
  useEffect(() => {
    if (visible) {
      if (phase === "shown") return;
      if (phase === "leaving" || props.reducedMotion) {
        setPhase("shown");
        return;
      }
      if (phase === "parked") {
        setPhase("entering");
        return;
      }
      // entering → shown on the next frames, after the entering styles have been committed.
      rootRef.current?.getBoundingClientRect();
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setPhase("shown"));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    if (phase === "parked") return;
    if (phase === "leaving") {
      const t = setTimeout(
        () => setPhase("parked"),
        props.reducedMotion ? 0 : LEAVE_MS,
      );
      return () => clearTimeout(t);
    }
    setPhase(props.reducedMotion ? "parked" : "leaving");
  }, [visible, phase, props.reducedMotion]);

  // A focus request made while the tile was parked (display:none) lands once it is displayed.
  useEffect(() => {
    if (phase !== "parked") manager.focusPending(id);
  }, [manager, id, phase]);

  // Open the terminal into its host the first time the tile has a real size; tell the manager
  // when it is hidden so it never fits a 0×0 box.
  useEffect(() => {
    manager.setHidden(id, !visible);
    if (visible && !attachedRef.current && hostRef.current) {
      attachedRef.current = true;
      manager.attach(id, hostRef.current);
    }
  }, [manager, id, visible]);

  // Fit when the host's size settles (debounced in the manager) and when the transition ends.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => manager.scheduleFit(id));
    ro.observe(host);
    return () => ro.disconnect();
  }, [manager, id]);

  const dim = focused ? 1 : 0.62 + 0.38 * rankScale(rank, props.decay);
  const scale = phase === "entering" ? 0.96 : phase === "leaving" ? 0.94 : 1;
  const style = {
    transform: `translate(${rect.x}px, ${rect.y}px)${
      scale !== 1 ? ` scale(${scale})` : ""
    }`,
    width: `${rect.w}px`,
    height: `${rect.h}px`,
    zIndex: String(ff ? ff.z.get(id) ?? 1 : 100 - rank),
    "--rank-dim": String(dim),
  };

  // A web tile's body is never scaled: it has no terminal to keep at one size.
  const full = web ? null : props.full;
  const classes = ["tile", `is-${phase}`];
  if (full) classes.push("is-scaled");
  if (focused) classes.push("is-focused");
  if (entry.exited) classes.push("is-exited");
  // A sandboxed tile wears the green tint plus a hatched header (SANDBOX_TINT).
  const tint = isTintId(entry.ssh?.tint)
    ? entry.ssh.tint
    : entry.sandbox
    ? SANDBOX_TINT
    : undefined;
  if (entry.ssh) classes.push("is-ssh");
  if (web) classes.push("is-web");
  if (entry.sandbox) classes.push("is-sandbox");
  if (tint) classes.push("has-tint");
  if (props.dropTargetId === id) classes.push("is-drop-target");
  const broadcasting = props.broadcastIds?.has(id) ?? false;
  if (broadcasting) classes.push("is-broadcast");
  if (ff) classes.push("is-freeform");
  if (drag.live) classes.push("is-dragging");
  const draggable = !!ff && !props.maximized;

  return (
    <div
      ref={rootRef}
      class={classes.join(" ")}
      style={style}
      data-testid="tile"
      data-id={id}
      data-rank={visible ? rank : ""}
      data-phase={phase}
      data-focused={focused ? "true" : "false"}
      data-exited={entry.exited ? "true" : "false"}
      data-ssh={entry.ssh ? "true" : undefined}
      data-web={web ? "true" : undefined}
      data-sandbox={entry.sandbox ? "true" : undefined}
      data-tint={tint}
      data-broadcast={broadcasting ? "true" : undefined}
      data-activity={props.activity}
      data-maximized={props.maximized ? "true" : undefined}
      onTransitionEnd={(e) => {
        // denext's TransitionEvent type has no `propertyName`; the native event does.
        const native = e as unknown as globalThis.TransitionEvent;
        if (native.target !== rootRef.current) return;
        const prop = native.propertyName;
        if (
          prop === "width" || prop === "height" || prop === "transform"
        ) manager.fitNow(id);
      }}
      onPointerDownCapture={(e: { target: EventTarget | null }) => {
        // Focusing an unfocused tile moves it to the top slot, so a press that focused it first
        // would have its button slide away before the release and the click would miss. Header
        // buttons (close, minimize, the web toolbar…) and anything marked `data-keep-focus` (the
        // broadcast checkbox) act without it; each focuses afterwards where that makes sense.
        const t = e.target as Element | null;
        if (!focused && !t?.closest?.(KEEP_FOCUS)) props.onFocus(id);
      }}
    >
      <div class="tile-inner">
        <header
          class="tile-head"
          onPointerDown={(e) => {
            // Free-form: a drag on the header moves the tile (not from its controls).
            const t = e.target as Element | null;
            if (!draggable || t?.closest?.(DRAG_SKIP)) return;
            drag.start(e as unknown as PointerEvent, null, rootRef.current);
          }}
          onDoubleClick={(e) => {
            // Not on a control (the window buttons, a web tile's toolbar and address field).
            const t = e.target as Element | null;
            if (t?.closest?.(HEAD_CONTROLS)) return;
            props.onHeadDoubleClick(id);
          }}
          // The header is not focusable: without this the mousedown's default action moves
          // keyboard focus to <body> right after pointerdown focused the terminal. A web tile's
          // address field takes the click as any field does.
          onMouseDown={(e) => {
            if (!(e.target as Element | null)?.closest?.("input")) {
              e.preventDefault();
            }
          }}
        >
          {props.renderHeadLead?.(entry)}
          {entry.ssh && (
            <span class="tile-badge" data-testid="tile-ssh-badge">SSH</span>
          )}
          {entry.sandbox && (
            <span
              class="tile-badge"
              data-testid="tile-sandbox-badge"
              title="Runs in the window's shared Docker sandbox"
            >
              SANDBOX
            </span>
          )}
          <AgentBadge tile={props.agentOf?.(id)} />
          <span
            class="tile-title"
            data-testid="tile-title"
            title={props.title}
          >
            {props.title}
          </span>
          {web && <WebToolbar view={web} />}
          <span class="tile-meta">
            {props.renderHeadActions?.(entry)}
            {entry.exited && (
              <span class="tile-exited">
                exited{entry.exitCode ? ` ${entry.exitCode}` : ""}
              </span>
            )}
            {!focused && (
              <span class="tile-age">
                {formatAge(props.now, entry.lastUsedAt)}
              </span>
            )}
            {!focused && (
              <span class="tile-rank" aria-label={`recency rank ${rank}`}>
                {rank}
              </span>
            )}
            <WindowControls
              maximized={props.maximized}
              web={!!web}
              onMinimize={() => props.onMinimize(id)}
              onMaximize={() => props.onMaximize(id)}
              onRestore={() => props.onRestore(id)}
            />
            <button
              type="button"
              class="tile-close"
              data-testid="tile-close"
              // Not focused first (the tile's capture-phase pointerdown): focusing an unfocused
              // tile moves it to the top slot, so the click would land on whatever is there now.
              data-keep-focus
              aria-label={web ? "Close web tile" : "Close terminal"}
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(id);
              }}
            >
              ×
            </button>
          </span>
        </header>
        {web ? <WebBody view={web} /> : (
          <div
            class="tile-body"
            data-testid="tile-body"
            ref={hostRef}
            style={full ? scaledBodyStyle(full, rect, focused) : undefined}
          />
        )}
        {full && (
          // Hidden (CSS) rather than unmounted once focused: the pointerdown that focuses the
          // tile re-renders it, and the mousedown that follows must still land here so its
          // default (moving keyboard focus to <body>, as on the header) can be cancelled.
          <div
            class="tile-catcher"
            data-testid="tile-catcher"
            aria-hidden="true"
            onMouseDown={(e) => e.preventDefault()}
          />
        )}
        {props.renderOverlay?.(entry, focused)}
      </div>
      {draggable && <Grips start={drag.start} />}
    </div>
  );
}

/** What a header press never drags from: its controls, the address field, opt-outs. */
const DRAG_SKIP = "button, input, select, textarea, a, [data-keep-focus]";

/** A free-form tile's resize grips: its four edges and four corners. */
function Grips(props: { start: StartDrag }) {
  return (
    <>
      {EDGES.map((edge) => (
        <div
          key={edge}
          class={`tile-grip grip-${edge}`}
          data-testid="tile-grip"
          data-edge={edge}
          aria-hidden="true"
          onPointerDown={(e) => {
            const el = e.target as HTMLElement | null;
            props.start(e as unknown as PointerEvent, edge, el);
          }}
        />
      ))}
    </>
  );
}

/** What a press may land on without focusing the tile first (see the tile's pointerdown). */
const KEEP_FOCUS = "[data-keep-focus], .tile-head button";

/** What a header double click leaves alone: its buttons, fields and links. */
const HEAD_CONTROLS =
  "button, input, select, textarea, a, [data-no-head-dblclick]";

/** A tile's Minimize and Maximize / Restore buttons (beside its close button). */
function WindowControls(props: {
  maximized: boolean;
  web: boolean;
  onMinimize(): void;
  onMaximize(): void;
  onRestore(): void;
}) {
  const what = props.web ? "web tile" : "terminal";
  // The tile's own pointerdown focus is skipped (`data-keep-focus`): each action focuses (or moves
  // the focus away) itself.
  const button = (
    testid: string,
    label: string,
    title: string,
    act: () => void,
    glyph: ReactNode,
  ) => (
    <button
      type="button"
      class="tile-ctl"
      data-testid={testid}
      data-keep-focus
      aria-label={label}
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        act();
      }}
    >
      <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
        {glyph}
      </svg>
    </button>
  );
  return (
    <>
      {button(
        "tile-minimize",
        `Minimize ${what}`,
        "Minimize",
        props.onMinimize,
        <path d="M1.5 7.5h7" />,
      )}
      {props.maximized
        ? button(
          "tile-restore",
          `Restore ${what}`,
          "Restore",
          props.onRestore,
          <path d="M1.5 3.5h5v5h-5zM3.5 3.5v-2h5v5h-2" />,
        )
        : button(
          "tile-maximize",
          `Maximize ${what}`,
          "Maximize",
          props.onMaximize,
          <path d="M1.5 1.5h7v7h-7z" />,
        )}
    </>
  );
}

/** The tint every sandboxed tile wears. */
const SANDBOX_TINT = "green";

/** An agent tile's hub name, status and unread count (nothing for a tile without a harness). */
function AgentBadge(props: { tile: TileInfo | undefined }) {
  const tile = props.tile;
  if (!tile?.harness) return null;
  const unread = tile.unread > 0
    ? `, ${tile.unread} unread message${tile.unread === 1 ? "" : "s"}`
    : "";
  return (
    <span
      class="tile-agent"
      data-testid="tile-agent-badge"
      data-status={tile.status}
      data-unread={String(tile.unread)}
      data-session={tile.session ?? ""}
      title={`${tile.name} (${tile.harness}${
        tile.model ? ` · ${tile.model}` : ""
      }${
        tile.session ? ` · session ${tile.session.slice(0, 8)}` : ""
      }): ${tile.status}${unread}`}
    >
      <span class="tile-agent-dot" aria-hidden="true" />
      <span class="tile-agent-name">{tile.name}</span>
      <span class="tile-agent-status">{tile.status}</span>
      {tile.unread > 0 && (
        <span class="tile-agent-unread" data-testid="tile-agent-unread">
          {tile.unread}
        </span>
      )}
    </span>
  );
}
