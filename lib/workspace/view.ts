/**
 * The workspace's view actions: tiled or free-form (each workspace keeps its own; Settings →
 * Layout picks the one a new workspace starts in), free-form rects as tiles are dragged, resized
 * and placed, and the free-form arrange commands (Cascade, Tile Horizontally, Tile Vertically).
 * The geometry is lib/workspace/freeform.ts; Maximize / Restore / Minimize, which both views
 * share, stay in the store's reducer (lib/workspace/store.ts).
 *
 * @module
 */

import type { Rect } from "../layout/mod.ts";
import {
  cascadeRects,
  type FreeformState,
  sanitizeViewMode,
  seedRects,
  setRect,
  stripRects,
  type ViewMode,
} from "./freeform.ts";
import type { WorkspaceState } from "./store.ts";

/** A free-form arrange command (lib/workspace/mdi-menu.ts names them for the menus). */
export type ArrangeHow = "cascade" | "rows" | "columns";

/** The view and free-form actions of the workspace reducer. */
export type ViewAction =
  /**
   * Show the workspace tiled or free-form. `seed`: the tiles' current tiled rects, which become
   * the free-form rects of the tiles that have none yet (so the switch does not jump).
   */
  | { type: "setView"; view: ViewMode; seed?: Record<string, Rect> }
  /** Settings → Layout: the view new workspaces start in. */
  | { type: "setDefaultView"; view: ViewMode }
  /** A free-form tile moved or resized (the end of a drag). */
  | { type: "freeformRect"; id: string; rect: Rect }
  /** Free-form rects for tiles that have none yet (a new tile placed); others are left alone. */
  | { type: "freeformSeed"; rects: Record<string, Rect> }
  /** A free-form arrange command over the shown tiles in an area of `bounds` (tiled: no-op). */
  | { type: "arrange"; how: ArrangeHow; bounds: Rect };

function withFreeform(
  state: WorkspaceState,
  freeform: FreeformState,
): WorkspaceState {
  return freeform === state.freeform ? state : { ...state, freeform };
}

/** The tiles not minimized, back to front (the z-order, then any it does not list). */
function shownBackToFront(state: WorkspaceState): string[] {
  const shown = new Set(
    state.terminals.filter((t) => !t.minimized).map((t) => t.id),
  );
  const z = state.freeform.z.filter((id) => shown.has(id));
  return [...z, ...state.mru.filter((id) => shown.has(id) && !z.includes(id))];
}

/** A free-form arrange command: every shown tile gets a new rect; none stays maximized. */
function arrange(
  state: WorkspaceState,
  how: ArrangeHow,
  bounds: Rect,
): WorkspaceState {
  if (state.view !== "freeform" || bounds.w <= 0 || bounds.h <= 0) return state;
  const { gap, minTileW, minTileH } = state.settings.layout;
  const min = { w: minTileW, h: minTileH };
  const back = shownBackToFront(state);
  if (back.length === 0) return state;
  // Cascade keeps the z-order (the front tile lowest and rightmost); the strips go in recency
  // order, the focused tile first (top or left).
  const rects = how === "cascade"
    ? cascadeRects(back, bounds, min, gap)
    : stripRects(
      [...back].reverse(),
      bounds,
      min,
      gap,
      how === "rows" ? "rows" : "columns",
    );
  return withFreeform(state, {
    ...state.freeform,
    rects: { ...state.freeform.rects, ...rects },
    maximized: null,
  });
}

/** The view and free-form actions. */
export function reduceView(
  state: WorkspaceState,
  action: ViewAction,
): WorkspaceState {
  switch (action.type) {
    case "setView": {
      const view = sanitizeViewMode(action.view);
      const freeform = view === "freeform" && action.seed
        ? seedRects(state.freeform, action.seed)
        : state.freeform;
      if (view === state.view && freeform === state.freeform) return state;
      return { ...state, view, freeform };
    }
    case "setDefaultView": {
      const defaultView = sanitizeViewMode(action.view);
      if (state.settings.defaultView === defaultView) return state;
      return { ...state, settings: { ...state.settings, defaultView } };
    }
    case "freeformRect":
      if (!state.terminals.some((t) => t.id === action.id)) return state;
      return withFreeform(
        state,
        setRect(state.freeform, action.id, action.rect),
      );
    case "freeformSeed": {
      const ids = new Set(state.terminals.map((t) => t.id));
      const known = Object.fromEntries(
        Object.entries(action.rects).filter(([id]) => ids.has(id)),
      );
      return withFreeform(state, seedRects(state.freeform, known));
    }
    case "arrange":
      return arrange(state, action.how, action.bounds);
  }
}
