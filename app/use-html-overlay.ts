// HTML that may overlap a web tile registers itself while it is there (lib/web/overlays.ts): a
// native web view, which draws above all HTML, shows a snapshot of its page meanwhile.
//
// - `useHtmlOverlay`: something that may be anywhere (the link menu, the modal dialogs of
//   app/modal.tsx, Settings, the bar's menus, a tile being dragged or sliding to its place).
// - `useAreaOverlays`: something over a known part of the tile area (the companion and its
//   bubble, the broadcast banner, the dictation note): only the web tiles under it follow.
// - `useTileMotion`: whether a tile is sliding or resizing to a new place (its CSS transition).

import { useEffect, useRef, useState } from "denext";
import {
  type AreaOverlay,
  type Box,
  openOverlay,
  setAreaOverlays,
} from "../lib/web/overlays.ts";

/** Count this component as an open overlay while `active`. */
export function useHtmlOverlay(active = true): void {
  useEffect(() => (active ? openOverlay() : undefined), [active]);
}

/** `el`'s box in the viewport, grown by `margin` on every side. */
export function boxOf(el: Element, margin = 0): Box {
  const r = el.getBoundingClientRect();
  return {
    left: r.left - margin,
    top: r.top - margin,
    right: r.right + margin,
    bottom: r.bottom + margin,
  };
}

/** The box around all of `boxes` (`null` for none). */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/**
 * Publish the area overlays of the element in `ref` (what `measure` reads off it) while it is
 * mounted: measured at once, whenever the element or the area it sits in changes size, and
 * whenever `deps` change.
 */
export function useAreaOverlays(
  ref: { readonly current: HTMLElement | null },
  measure: (el: HTMLElement) => AreaOverlay[],
  deps: readonly unknown[] = [],
): void {
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const owner = {};
    const publish = () => setAreaOverlays(owner, measureRef.current(el));
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    if (el.offsetParent) observer.observe(el.offsetParent);
    return () => {
      observer.disconnect();
      setAreaOverlays(owner, []);
    };
  }, deps);
}

/** The properties whose transition moves a tile. */
const MOTION = new Set(["transform", "width", "height"]);

/** Whether a transition that moves `el` is running on it. */
function inMotion(el: Element): boolean {
  return el.getAnimations().some((a) =>
    a instanceof CSSTransition && MOTION.has(a.transitionProperty) &&
    a.playState !== "finished" && a.playState !== "idle"
  );
}

/**
 * Whether the tile in `ref` is sliding or resizing to a new place (while `active`): read from the
 * transitions running on it at each of its transition events and at each render, so a transition
 * that ends unheard never leaves it moving. No timer.
 */
export function useTileMotion(
  ref: { readonly current: HTMLElement | null },
  active: boolean,
): boolean {
  const [moving, setMoving] = useState(false);
  const checkRef = useRef<() => void>(() => {});
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const check = () => setMoving(inMotion(el));
    const onEvent = (e: Event) => {
      if (e.target === el) check();
    };
    checkRef.current = check;
    const events = ["transitionrun", "transitionend", "transitioncancel"];
    for (const name of events) el.addEventListener(name, onEvent);
    return () => {
      for (const name of events) el.removeEventListener(name, onEvent);
      checkRef.current = () => {};
      setMoving(false);
    };
  }, [active]);
  useEffect(() => checkRef.current());
  return moving;
}
