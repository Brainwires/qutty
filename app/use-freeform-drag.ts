// Moving and resizing a free-form tile (lib/workspace/freeform.ts): a drag on the header moves it,
// a drag on one of its edge or corner grips resizes it. Pointer events: the window follows the
// pointer (so a drag that leaves the tile, or the window, keeps going), the tile captures the
// pointer once the drag starts, and the drag ends on pointerup, pointercancel, a lost capture or
// the window losing focus. While it lasts the tile is drawn at the live rect (no transition);
// the store hears of the rect once, at the end.
//
// The PTY follows a resize through the terminal manager's own fit: throttled while the grip moves
// (`fitNow` resizes the PTY only when the grid changes), and once more at the end.
//
// A header press that does not move (a click, the first half of a double click) is no drag.

import { useCallback, useEffect, useRef, useState } from "denext";
import type { Rect } from "../lib/layout/mod.ts";
import {
  type Edge,
  type MinSize,
  moveRect,
  resizeRect,
} from "../lib/workspace/freeform.ts";

/** What a free-form tile needs from the cluster. */
export interface FreeformTiles {
  /** The workspace area (px, at 0,0). */
  bounds: Rect;
  /** The smallest a tile may be resized to. */
  min: MinSize;
  /** Each shown tile's stacking order (1: at the back). */
  z: ReadonlyMap<string, number>;
  /** The tiles another tile covers from above (for a native web view: `setOccluded`). */
  occluded: ReadonlySet<string>;
  /** A tile was moved or resized to `rect` (the end of a drag). */
  onRect(id: string, rect: Rect): void;
}

/** How far a header press moves before it is a drag (px). */
const DRAG_THRESHOLD = 3;
/** The least time between two fits while a grip moves (ms). */
const FIT_THROTTLE_MS = 120;

/** A drag starting: the press, what it does (`null`: move), and the element that captures it. */
export type StartDrag = (
  e: PointerEvent,
  edge: Edge | null,
  el: HTMLElement | null,
) => void;

export function useFreeformDrag(opts: {
  id: string;
  /** The tile's rect as drawn. */
  rect: Rect;
  /** The free-form view; absent (tiled) or with the tile maximized, nothing drags. */
  ff: FreeformTiles | undefined;
  enabled: boolean;
  /** Fit the tile's terminal now (resizes its PTY when its grid changed). */
  fit(id: string): void;
}): { live: Rect | null; start: StartDrag } {
  const [live, setLive] = useState<Rect | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const stopRef = useRef<(() => void) | null>(null);
  // Unmounted mid-drag: the listeners go.
  useEffect(() => () => stopRef.current?.(), []);

  const start = useCallback<StartDrag>((e, edge, el) => {
    const o = optsRef.current;
    if (!o.ff || !o.enabled || e.button !== 0 || stopRef.current) return;
    // No text selection, no focus change from the press (the terminal keeps the keyboard).
    e.preventDefault();
    const { id } = o;
    const from = o.rect;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const pointer = e.pointerId;
    let moved = false;
    let current = from;
    let lastFit = 0;
    const fitSoon = () => requestAnimationFrame(() => optsRef.current.fit(id));

    const capture = () => {
      try {
        el?.setPointerCapture(pointer);
      } catch { /* the pointer is gone already */ }
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved) {
        if (
          edge === null && Math.abs(dx) < DRAG_THRESHOLD &&
          Math.abs(dy) < DRAG_THRESHOLD
        ) return;
        moved = true;
        capture();
      }
      const ff = optsRef.current.ff;
      if (!ff) return;
      current = edge
        ? resizeRect(from, edge, dx, dy, ff.bounds, ff.min)
        : moveRect(from, dx, dy, ff.bounds, ff.min);
      setLive(current);
      if (edge && ev.timeStamp - lastFit >= FIT_THROTTLE_MS) {
        lastFit = ev.timeStamp;
        fitSoon();
      }
    };
    const stop = () => {
      globalThis.removeEventListener("pointermove", onMove, true);
      globalThis.removeEventListener("pointerup", onEnd, true);
      globalThis.removeEventListener("pointercancel", onEnd, true);
      globalThis.removeEventListener("blur", onBlur);
      el?.removeEventListener("lostpointercapture", onEnd);
      try {
        if (el?.hasPointerCapture(pointer)) el.releasePointerCapture(pointer);
      } catch { /* gone */ }
      stopRef.current = null;
    };
    const end = () => {
      if (stopRef.current !== stop) return;
      stop();
      if (moved) optsRef.current.ff?.onRect(id, current);
      setLive(null);
      if (moved && edge) fitSoon();
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId === pointer) end();
    };
    const onBlur = () => end();
    globalThis.addEventListener("pointermove", onMove, true);
    globalThis.addEventListener("pointerup", onEnd, true);
    globalThis.addEventListener("pointercancel", onEnd, true);
    globalThis.addEventListener("blur", onBlur);
    el?.addEventListener("lostpointercapture", onEnd);
    stopRef.current = stop;
    if (edge) {
      moved = true;
      capture();
    }
  }, []);

  return { live, start };
}
