// The workspace's view, tiled or free-form, as the cluster and the menus use it: the tiles the
// cluster draws (the layout engine's in the tiled view; in the free-form view each shown tile at
// its own rect, in z-order), new free-form tiles' places stored as they appear, the switch
// between the views (seeded from the tiled rects so nothing jumps), and the menu items of the
// view model (lib/workspace/mdi-menu.ts) acted on, whether they came from the in-app View menu
// or the Window menu.

import { useCallback, useEffect, useMemo, useRef } from "denext";
import type { LayoutResult, LayoutTile, Rect } from "../lib/layout/mod.ts";
import {
  occludedIds,
  placeFreeform,
  type ViewMode,
} from "../lib/workspace/freeform.ts";
import { type MdiCommand, menuCommand } from "../lib/workspace/mdi-menu.ts";
import {
  freeformMin,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import type { FreeformTiles } from "./use-freeform-drag.ts";

export interface ViewApi {
  /** The tiles the cluster draws, in recency order. */
  tiles: LayoutTile[];
  /** The free-form view's part of the cluster (absent: tiled). */
  freeform: FreeformTiles | undefined;
  /** Show the workspace tiled or free-form. */
  setView(view: ViewMode): void;
  /** A menu item of the view model was chosen (in-app or Window menu); `false`: not one of its. */
  menuItem(id: string): boolean;
}

export function useFreeformView(opts: {
  state: WorkspaceState;
  /** The tiles not minimized, most recent first. */
  shown: string[];
  bounds: Rect;
  /** The tiled view's layout. */
  layout: LayoutResult;
  run(action: WorkspaceAction): void;
  /** Focus tile `id` (and give it the keyboard), restoring it when minimized. */
  focus(id: string): void;
}): ViewApi {
  const { state, shown, bounds, run } = opts;
  const freeformOn = state.view === "freeform";
  const min = freeformMin(state);
  const { gap } = state.settings.layout;
  const placement = useMemo(
    () =>
      freeformOn && bounds.w > 0 && bounds.h > 0
        ? placeFreeform(state.freeform, shown, bounds, min, gap)
        : null,
    [freeformOn, state.freeform, shown, bounds, min.w, min.h, gap],
  );

  // A tile shown free-form for the first time (a new tile, one never placed) keeps the place
  // it was given.
  useEffect(() => {
    if (placement && Object.keys(placement.placed).length > 0) {
      run({ type: "freeformSeed", rects: placement.placed });
    }
  }, [placement, run]);

  const tiles = useMemo<LayoutTile[]>(
    () =>
      placement
        ? shown.filter((id) => placement.rects[id]).map((id, rank) => ({
          id,
          rect: placement.rects[id],
          rank,
        }))
        : opts.layout.tiles,
    [placement, shown, opts.layout],
  );

  const freeform = useMemo<FreeformTiles | undefined>(() => {
    if (!placement) return undefined;
    const order = placement.order.map((id) => ({
      id,
      rect: placement.rects[id],
    }));
    return {
      bounds,
      min,
      z: new Map(placement.order.map((id, i) => [id, Math.min(99, i + 1)])),
      occluded: occludedIds(order),
      onRect: (id, rect) => run({ type: "freeformRect", id, rect }),
    };
  }, [placement, bounds, min.w, min.h, run]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const layoutRef = useRef(opts.layout);
  layoutRef.current = opts.layout;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const focusRef = useRef(opts.focus);
  focusRef.current = opts.focus;

  const setView = useCallback((view: ViewMode) => {
    // The tiles' tiled rects become the free-form rects of the ones that have none yet.
    const seed = Object.fromEntries(
      layoutRef.current.tiles.map((t) => [t.id, t.rect]),
    );
    run({ type: "setView", view, ...(view === "freeform" ? { seed } : {}) });
  }, [run]);

  const command = useCallback((c: MdiCommand) => {
    if (c === "viewTiled") return setView("tiled");
    if (c === "viewFreeform") return setView("freeform");
    // The arrange commands do nothing in the tiled view (the reducer ignores them there).
    const how = c === "cascade"
      ? "cascade"
      : c === "tileHorizontally"
      ? "rows"
      : "columns";
    run({ type: "arrange", how, bounds: boundsRef.current });
  }, [run, setView]);

  const menuItem = useCallback((id: string) => {
    const what = menuCommand(id);
    if (!what) return false;
    if ("command" in what) command(what.command);
    else if (stateRef.current.terminals.some((t) => t.id === what.focus)) {
      focusRef.current(what.focus);
    }
    return true;
  }, [command]);

  return { tiles, freeform, setView, menuItem };
}
