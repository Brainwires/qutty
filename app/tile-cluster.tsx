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
// into the header (`renderHeadActions`) and over the terminal (`renderOverlay`).

import { type ReactNode, useEffect, useRef, useState } from "denext";
import { type LayoutTile, rankScale, type Rect } from "../lib/layout/mod.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import { formatAge } from "../lib/workspace/format.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import { isTintId } from "../lib/workspace/themes.ts";

/** The workspace's additions to a tile (SSH tiles). */
interface TileExtras {
  /** The tile files are being dragged over. */
  dropTargetId?: string | null;
  renderHeadActions?(entry: TerminalEntry): ReactNode;
  renderOverlay?(entry: TerminalEntry, focused: boolean): ReactNode;
}

export interface TileClusterProps extends TileExtras {
  manager: TerminalManager;
  terminals: TerminalEntry[];
  tiles: LayoutTile[];
  focusedId: string | null;
  decay: number;
  now: number;
  reducedMotion: boolean;
  onFocus(id: string): void;
  onClose(id: string): void;
}

export function TileCluster(props: TileClusterProps) {
  const byId = new Map(props.tiles.map((t) => [t.id, t]));
  return (
    <div class="tiles" data-testid="tiles">
      {props.terminals.map((entry) => (
        <TerminalTile
          key={entry.id}
          entry={entry}
          tile={byId.get(entry.id)}
          focused={entry.id === props.focusedId}
          manager={props.manager}
          decay={props.decay}
          now={props.now}
          reducedMotion={props.reducedMotion}
          onFocus={props.onFocus}
          onClose={props.onClose}
          dropTargetId={props.dropTargetId}
          renderHeadActions={props.renderHeadActions}
          renderOverlay={props.renderOverlay}
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
  tile: LayoutTile | undefined;
  focused: boolean;
  manager: TerminalManager;
  decay: number;
  now: number;
  reducedMotion: boolean;
  onFocus(id: string): void;
  onClose(id: string): void;
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
  const rect = lastRectRef.current;
  const rank = lastRankRef.current;

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
    zIndex: String(100 - rank),
    "--rank-dim": String(dim),
  };

  const classes = ["tile", `is-${phase}`];
  if (focused) classes.push("is-focused");
  if (entry.exited) classes.push("is-exited");
  if (entry.activity) classes.push("has-activity");
  const tint = isTintId(entry.ssh?.tint) ? entry.ssh.tint : undefined;
  if (entry.ssh) classes.push("is-ssh");
  if (tint) classes.push("has-tint");
  if (props.dropTargetId === id) classes.push("is-drop-target");

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
      data-tint={tint}
      onTransitionEnd={(e) => {
        // denext's TransitionEvent type has no `propertyName`; the native event does.
        const native = e as unknown as globalThis.TransitionEvent;
        if (native.target !== rootRef.current) return;
        const prop = native.propertyName;
        if (
          prop === "width" || prop === "height" || prop === "transform"
        ) manager.fitNow(id);
      }}
      onPointerDownCapture={() => {
        if (!focused) props.onFocus(id);
      }}
    >
      <div class="tile-inner">
        <header
          class="tile-head"
          onDoubleClick={() => props.onFocus(id)}
          // The header is not focusable: without this the mousedown's default action moves
          // keyboard focus to <body> right after pointerdown focused the terminal.
          onMouseDown={(e) => e.preventDefault()}
        >
          {entry.ssh && (
            <span class="tile-badge" data-testid="tile-ssh-badge">SSH</span>
          )}
          <span class="tile-title" data-testid="tile-title" title={entry.title}>
            {entry.title}
          </span>
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
            <button
              type="button"
              class="tile-close"
              data-testid="tile-close"
              aria-label="Close terminal"
              title="Close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(id);
              }}
            >
              ×
            </button>
          </span>
        </header>
        <div class="tile-body" data-testid="tile-body" ref={hostRef} />
        {props.renderOverlay?.(entry, focused)}
      </div>
    </div>
  );
}
