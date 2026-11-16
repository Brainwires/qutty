/**
 * HTML overlays over web tiles.
 *
 * A native web view (Denext's embedded web view, lib/web/native-engine.ts) is a layer drawn above
 * all HTML, so a menu or dialog that overlaps a web tile would be hidden under it. Two registries
 * tell the web tiles whose engine `drawsAboveHtml` (app/web-tile.tsx); the iframe engine is
 * ordinary HTML and ignores both.
 *
 * - **The count**: overlays that may be anywhere (app/use-html-overlay.ts: the link menu, the
 *   modal dialogs, Settings, the bar's menus, a tile being dragged or sliding to its place). While
 *   it is above zero every native view shows its snapshot instead of itself.
 * - **The areas** ({@linkcode AreaOverlay}): HTML over a known part of the tile area (the
 *   companion, its bubble, the broadcast banner, the dictation note). Only the web tiles under
 *   one are concerned.
 *
 * Client-safe, no DOM.
 *
 * @module
 */

/** A rectangle in the viewport (CSS pixels). */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * HTML drawn over a part of the tile area:
 *
 * - `cover`: something that comes and goes (the companion's bubble and chat box, a note). A
 *   native view under it shows its snapshot meanwhile.
 * - `keepout`: something that stays (the companion itself, the broadcast banner). A snapshot
 *   would freeze the page for good, so a native view under it makes room instead: it leaves a
 *   strip of its tile free ({@linkcode keepoutInsets}).
 */
export interface AreaOverlay {
  kind: "cover" | "keepout";
  box: Box;
}

/** How far a view stays from each edge of its tile's body. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const areas = new Map<unknown, readonly AreaOverlay[]>();
const areaListeners = new Set<() => void>();

/** The area overlays of `owner` (any value that is its own); an empty list removes them. */
export function setAreaOverlays(
  owner: unknown,
  list: readonly AreaOverlay[],
): void {
  const before = areas.get(owner) ?? [];
  if (JSON.stringify(before) === JSON.stringify(list)) return;
  if (list.length === 0) areas.delete(owner);
  else areas.set(owner, list);
  for (const fn of areaListeners) fn();
}

/** Every area overlay. */
export function areaOverlays(): AreaOverlay[] {
  return [...areas.values()].flat();
}

/** Hear of every change to the area overlays; returns the unsubscribe. */
export function onAreaOverlays(fn: () => void): () => void {
  areaListeners.add(fn);
  return () => void areaListeners.delete(fn);
}

/** Whether two boxes overlap (touching edges do not). */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom &&
    b.top < a.bottom;
}

/** Whether a `cover` overlay is over `body`. */
export function coveredByArea(
  body: Box,
  list: readonly AreaOverlay[],
): boolean {
  return list.some((a) => a.kind === "cover" && boxesOverlap(a.box, body));
}

/**
 * The room a view in `body` leaves for the `keepout` overlays over it: for each, the strip along
 * one edge that takes the least of the body away (a native view is a rectangle: it cannot have a
 * corner cut out).
 */
export function keepoutInsets(
  body: Box,
  list: readonly AreaOverlay[],
): Insets {
  const out: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const width = body.right - body.left;
  const height = body.bottom - body.top;
  for (const a of list) {
    if (a.kind !== "keepout" || !boxesOverlap(a.box, body)) continue;
    const cuts: [keyof Insets, number, number][] = [
      ["top", a.box.bottom - body.top, width],
      ["bottom", body.bottom - a.box.top, width],
      ["left", a.box.right - body.left, height],
      ["right", body.right - a.box.left, height],
    ];
    const [edge, depth] = cuts.reduce((best, cut) =>
      cut[1] * cut[2] < best[1] * best[2] ? cut : best
    );
    out[edge] = Math.max(out[edge], Math.ceil(depth));
  }
  return out;
}

type Listener = (open: number) => void;

let open = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const fn of listeners) fn(open);
}

/** An overlay opened; the returned function closes it (once). */
export function openOverlay(): () => void {
  open++;
  emit();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    open--;
    emit();
  };
}

/** How many overlays are open. */
export function openOverlays(): number {
  return open;
}

/** Follow the count (called with the current one at once); returns the unsubscribe. */
export function onOverlays(fn: Listener): () => void {
  listeners.add(fn);
  fn(open);
  return () => void listeners.delete(fn);
}
