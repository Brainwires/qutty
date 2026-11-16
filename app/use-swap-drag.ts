// Swapping two tiled tiles by a header drag, while tiles keep their places (Settings → Layout →
// "Focused tile moves to the main spot" off; lib/workspace/tile-order.ts). A press on a tile's
// header (not on its controls) that moves past a few px picks the tile up: it follows the pointer
// and the tile under the pointer shows it takes the drop. Releasing there swaps the two (the
// layout's own transitions carry both to their new slots); releasing anywhere else, Escape, a
// lost pointer capture or the window losing focus puts it back. A press that does not move is a
// plain click (the tile's own pointerdown focused it; a double click still reaches the header).
//
// Pointer events only (no HTML5 drag and drop: terminals and web views take those), captured by
// the header once the drag starts. The tile under the pointer comes from the layout's rects, not
// from hit-testing the page, so a native view drawn above a tile's body does not matter.

import { useCallback, useEffect, useRef, useState } from "denext";
import type { LayoutTile } from "../lib/layout/mod.ts";
import { tileAt } from "../lib/workspace/tile-order.ts";

/** How far a header press moves before it picks the tile up (px). */
const SWAP_THRESHOLD = 4;

/** A tile being dragged: by how much (px), and the tile it would swap with (`null`: none). */
export interface SwapDrag {
  id: string;
  dx: number;
  dy: number;
  over: string | null;
}

export function useSwapDrag(opts: {
  tiles: readonly LayoutTile[];
  /** Swapping is on (tiles keep their places, tiled, not monocle); absent: no drag. */
  onSwap: ((a: string, b: string) => void) | undefined;
}): {
  drag: SwapDrag | null;
  /** A header press on tile `id` (`head`: the header, which captures the pointer). */
  start(e: PointerEvent, id: string, head: HTMLElement): void;
} {
  const [drag, setDrag] = useState<SwapDrag | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const stopRef = useRef<(() => void) | null>(null);
  // Unmounted mid-drag: the listeners go.
  useEffect(() => () => stopRef.current?.(), []);
  // Swapping turned off mid-drag (the setting, the view, monocle): the drag is dropped.
  const enabled = opts.onSwap !== undefined;
  useEffect(() => {
    if (!enabled) stopRef.current?.();
  }, [enabled]);

  const start = useCallback(
    (e: PointerEvent, id: string, head: HTMLElement) => {
      if (!optsRef.current.onSwap || e.button !== 0 || stopRef.current) return;
      const pointer = e.pointerId;
      const x0 = e.clientX;
      const y0 = e.clientY;
      // The tiles' rects are relative to the tiles' container.
      const box = head.closest("[data-testid=tiles]")?.getBoundingClientRect();
      if (!box) return;
      let live: SwapDrag | null = null;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointer) return;
        const dx = ev.clientX - x0;
        const dy = ev.clientY - y0;
        if (
          !live && Math.abs(dx) < SWAP_THRESHOLD &&
          Math.abs(dy) < SWAP_THRESHOLD
        ) return;
        if (!live) {
          try {
            head.setPointerCapture(pointer);
          } catch { /* the pointer is gone already */ }
        }
        const over = tileAt(
          optsRef.current.tiles,
          ev.clientX - box.left,
          ev.clientY - box.top,
          id,
        );
        live = { id, dx, dy, over };
        setDrag(live);
      };
      const stop = () => {
        globalThis.removeEventListener("pointermove", onMove, true);
        globalThis.removeEventListener("pointerup", onUp, true);
        globalThis.removeEventListener("pointercancel", onCancel, true);
        globalThis.removeEventListener("keydown", onKey, true);
        globalThis.removeEventListener("blur", cancel);
        head.removeEventListener("lostpointercapture", cancel);
        try {
          if (head.hasPointerCapture(pointer)) {
            head.releasePointerCapture(pointer);
          }
        } catch { /* gone */ }
        stopRef.current = null;
        if (live) setDrag(null);
        live = null;
      };
      function cancel() {
        if (stopRef.current === stop) stop();
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointer || stopRef.current !== stop) return;
        const target = live?.over ?? null;
        stop();
        if (target) optsRef.current.onSwap?.(id, target);
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId === pointer) cancel();
      };
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !live) return;
        // The Escape puts the tile back; it does not reach the terminal.
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      };
      globalThis.addEventListener("pointermove", onMove, true);
      globalThis.addEventListener("pointerup", onUp, true);
      globalThis.addEventListener("pointercancel", onCancel, true);
      globalThis.addEventListener("keydown", onKey, true);
      globalThis.addEventListener("blur", cancel);
      head.addEventListener("lostpointercapture", cancel);
      stopRef.current = stop;
    },
    [],
  );

  return { drag, start };
}
