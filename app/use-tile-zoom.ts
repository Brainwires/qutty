// Per-tile zoom, the workspace's half (the model is lib/workspace/tile-zoom.ts): Zoom In / Zoom Out
// / Actual Size (the keys and the View menu) go to the focused tile, a web tile's to its page
// (app/web-tile.tsx, its site's zoom), any other tile's to the store; each terminal's zoom is
// handed to the terminal manager, which sizes its font and refits it; the shared level and the
// "Zoom All Tiles Together" toggle are settings, so every window follows them.

import { useCallback, useEffect, useMemo, useRef } from "denext";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type {
  TerminalEntry,
  WorkspaceAction,
  WorkspaceState,
} from "../lib/workspace/store.ts";
import { effectiveTileZoom } from "../lib/workspace/tile-zoom.ts";
import type { KeyCommand } from "../lib/workspace/keys.ts";
import { runWebCommand } from "./web-tile.tsx";

export interface TileZoomOptions {
  /** The page is up (the terminal manager exists). */
  ready: boolean;
  state: WorkspaceState;
  manager: { current: TerminalManager | null };
  run(action: WorkspaceAction): void;
}

/** What web tiles read of the shared zoom (app/web-tile.tsx `WebTileHooks`). */
interface SharedZoomHooks {
  /** The shared level while tiles zoom together, else `null`. */
  sharedZoom: number | null;
  /** Set the shared level (a web tile zoomed while tiles zoom together). */
  setSharedZoom(zoom: number): void;
}

/** A terminal tile (not a web, agent or Source Control tile): one the terminal manager draws. */
const isTerminal = (t: TerminalEntry) => !t.web && !t.chat && !t.scm;

export function useTileZoom(opts: TileZoomOptions) {
  const { ready, state, manager, run } = opts;
  const stateRef = useRef(state);
  stateRef.current = state;
  const { zoomTogether, sharedZoom } = state.settings;

  // Each terminal's zoom, to the manager (a no-op for one that did not change).
  const zoomKey = state.terminals.filter(isTerminal).map((t) =>
    `${t.id}:${t.zoom ?? 1}`
  ).join(" ");
  useEffect(() => {
    const m = manager.current;
    if (!ready || !m) return;
    const s = stateRef.current;
    for (const t of s.terminals) {
      if (isTerminal(t)) m.setZoom(t.id, effectiveTileZoom(t, s.settings));
    }
  }, [ready, zoomKey, zoomTogether, sharedZoom]);

  /** Zoom In / Zoom Out / Actual Size on the focused tile. */
  const runZoom = useCallback(
    (cmd: Extract<KeyCommand, { kind: "zoom" | "zoomReset" }>) => {
      const s = stateRef.current;
      const id = s.focusedId;
      if (!id) return;
      if (s.terminals.some((t) => t.id === id && t.web)) {
        runWebCommand(
          id,
          cmd.kind === "zoom"
            ? { kind: "zoom", dir: cmd.dir }
            : { kind: "zoomReset" },
        );
        return;
      }
      run(
        cmd.kind === "zoom"
          ? { type: "zoomTile", id, dir: cmd.dir }
          : { type: "resetTileZoom", id },
      );
    },
    [run],
  );

  /** The zoom tile `entry` shows (its own, or the shared level). */
  const zoomOf = useCallback(
    (entry: TerminalEntry) =>
      effectiveTileZoom(entry, stateRef.current.settings),
    // Read again when either setting changes (the cluster re-renders with it).
    [zoomTogether, sharedZoom],
  );

  const resetZoom = useCallback(
    (id: string) => run({ type: "resetTileZoom", id }),
    [run],
  );

  const toggleTogether = useCallback(
    () =>
      run({
        type: "setZoomTogether",
        on: !stateRef.current.settings.zoomTogether,
      }),
    [run],
  );

  const web = useMemo<SharedZoomHooks>(() => ({
    sharedZoom: zoomTogether ? sharedZoom : null,
    setSharedZoom: (zoom) => run({ type: "setSharedZoom", zoom }),
  }), [zoomTogether, sharedZoom, run]);

  return { runZoom, zoomOf, resetZoom, toggleTogether, web };
}
