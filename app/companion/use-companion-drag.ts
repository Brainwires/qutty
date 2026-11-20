// Dragging the companion to another corner, the DOM side of lib/companion/drag.ts. The press is on
// the poke target (the bead), with native pointer listeners on it: the pointer is captured on the
// press, so the moves and the release come here even off the face, and a press that stays within
// DRAG_THRESHOLD_PX is the usual click (the poke, the chat). Past it the overlay follows the
// pointer (a `translate` set on it directly, no re-render per move); on release the companion snaps
// to the nearest corner of the tile area (`onDrop`, which saves Settings → Companion → Corner) and
// the click the release would bring is swallowed (`consumeClick`). A cancelled pointer
// (`pointercancel`) puts the companion back.
//
// In the floating companion's own window (app/companion/floating-companion.tsx) a drag moves the
// window instead (`mover`): by the pointer's movement on screen (`screenX` / `screenY`, since the
// page moves with the window), with no corner to snap to.

import { useEffect, useRef, useState } from "denext";
import type { CompanionCorner } from "../../lib/companion/protocol.ts";
import { isDrag, nearestCorner } from "../../lib/companion/drag.ts";
import type { Point } from "../../lib/companion/face-life.ts";

export interface CompanionDragOptions {
  /** The poke target: the press starts on it. */
  readonly target: { readonly current: HTMLElement | null };
  /** The overlay: it moves while dragged, and its offset parent is the area of the corners. */
  readonly overlay: { readonly current: HTMLElement | null };
  /** The companion was dropped: the corner it snaps to. */
  onDrop(corner: CompanionCorner): void;
  /** Move the window rather than the overlay (the floating companion's window). */
  readonly mover?: WindowMover;
}

/** Moves the floating companion's window while its companion is dragged. */
export interface WindowMover {
  /** A drag began. */
  start(): void;
  /** The pointer has moved (`dx`, `dy`) on screen since the press. */
  moveBy(dx: number, dy: number): void;
  /** The drag ended (`cancelled`: put the window back). */
  end(cancelled: boolean): void;
}

/** What the overlay needs to know of a drag. */
export interface CompanionDrag {
  /** A drag is under way (past the threshold). */
  readonly dragging: boolean;
  /** True (once) for the click that ends a drag: the poke must ignore it. */
  consumeClick(): boolean;
}

/** One press on the companion. */
interface Press {
  readonly id: number;
  readonly start: Point;
  /** Where it began on screen (a window drag goes by the screen). */
  readonly screen: Point;
  dragging: boolean;
}

/** Dragging the companion; see the module comment. */
export function useCompanionDrag(opts: CompanionDragOptions): CompanionDrag {
  const swallow = useRef(false);
  const [dragging, setDragging] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const target = opts.target.current;
    if (!target) return;
    let press: Press | null = null;
    let clear: ReturnType<typeof setTimeout> | undefined;
    const move = (dx: number, dy: number) => {
      if (optsRef.current.mover) return;
      const el = optsRef.current.overlay.current;
      if (!el) return;
      if (dx === 0 && dy === 0) el.style.removeProperty("translate");
      else el.style.setProperty("translate", `${dx}px ${dy}px`);
    };
    /** The press is over: put the overlay back in its corner's place; whether it was a drag. */
    const end = (cancelled = true) => {
      const was = press?.dragging === true;
      press = null;
      move(0, 0);
      if (was) {
        optsRef.current.mover?.end(cancelled);
        setDragging(false);
      }
      return was;
    };
    const mine = (e: PointerEvent) => press?.id === e.pointerId;

    const onDown = (e: PointerEvent) => {
      swallow.current = false;
      if (!e.isPrimary || e.button !== 0) return;
      press = {
        id: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        screen: { x: e.screenX, y: e.screenY },
        dragging: false,
      };
      target.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!press || !mine(e)) return;
      const at = { x: e.clientX, y: e.clientY };
      const mover = optsRef.current.mover;
      if (!press.dragging) {
        if (!isDrag(press.start, at)) return;
        press.dragging = true;
        mover?.start();
        setDragging(true);
      }
      if (mover) {
        mover.moveBy(e.screenX - press.screen.x, e.screenY - press.screen.y);
      } else move(at.x - press.start.x, at.y - press.start.y);
    };
    const onUp = (e: PointerEvent) => {
      if (!mine(e)) return;
      const area = optsRef.current.overlay.current?.offsetParent;
      if (!end(false)) return;
      // The click this release brings comes in the same task; nothing later is swallowed.
      swallow.current = true;
      clearTimeout(clear);
      clear = setTimeout(() => swallow.current = false, 0);
      if (optsRef.current.mover) return;
      const box = area?.getBoundingClientRect() ??
        { left: 0, top: 0, width: innerWidth, height: innerHeight };
      optsRef.current.onDrop(nearestCorner(
        { x: e.clientX - box.left, y: e.clientY - box.top },
        box,
      ));
    };
    const onCancel = (e: PointerEvent) => {
      if (mine(e)) end();
    };

    target.addEventListener("pointerdown", onDown);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onCancel);
    return () => {
      target.removeEventListener("pointerdown", onDown);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onCancel);
      clearTimeout(clear);
      end();
    };
  }, []);

  return {
    dragging,
    consumeClick() {
      const was = swallow.current;
      swallow.current = false;
      return was;
    },
  };
}
