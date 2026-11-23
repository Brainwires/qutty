/**
 * Keeping the companion off the controls it would cover (app/companion/use-companion-dodge.ts is
 * the DOM side): the prompt box of an agent tile or a harness overlay, and the overlay's side
 * rail. The companion rests in a corner of the tile area; where that corner's place overlaps one
 * of them, it moves the shortest way that clears it (by a small gap) and stays in
 * the area: above a prompt box that runs along the bottom, beside a rail that runs down the side.
 * A drag that drops it over one ends the same way, since a drop snaps to a corner first.
 *
 * Client-safe and pure.
 *
 * @module
 */

/** A rectangle in CSS px (client coordinates). */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** How far the companion moves from its corner's place (CSS px; up and left are negative). */
export interface Offset {
  readonly dx: number;
  readonly dy: number;
}

/** The space left between the companion and what it moves off (CSS px). */
const DODGE_GAP_PX = 8;

const shift = (b: Box, o: Offset): Box => ({
  left: b.left + o.dx,
  top: b.top + o.dy,
  right: b.right + o.dx,
  bottom: b.bottom + o.dy,
});

/** Whether `a` and `b` overlap (touching edges do not). */
export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom &&
    b.top < a.bottom;
}

const inside = (b: Box, area: Box): boolean =>
  b.left >= area.left - 0.5 && b.right <= area.right + 0.5 &&
  b.top >= area.top - 0.5 && b.bottom <= area.bottom + 0.5;

/**
 * How far to move `box` (the companion at its corner's place) so it overlaps none of
 * `obstacles`, staying inside `area`: each overlap in turn is cleared by the shortest move (up,
 * down, left or right) that keeps the box in the area and off the obstacles cleared before it.
 * `{ dx: 0, dy: 0 }` when nothing is in the way; the best it found when nothing clears them all.
 */
export function dodgeOffset(
  box: Box,
  obstacles: readonly Box[],
  area: Box,
  gap = DODGE_GAP_PX,
): Offset {
  let at: Offset = { dx: 0, dy: 0 };
  const cleared: Box[] = [];
  for (let step = 0; step <= obstacles.length * 2; step++) {
    const cur = shift(box, at);
    const hit = obstacles.find((o) => overlaps(cur, o));
    if (!hit) return at;
    const moves: Offset[] = [
      { dx: 0, dy: hit.top - gap - cur.bottom },
      { dx: 0, dy: hit.bottom + gap - cur.top },
      { dx: hit.left - gap - cur.right, dy: 0 },
      { dx: hit.right + gap - cur.left, dy: 0 },
    ];
    const next = moves
      .map((m) => ({ dx: at.dx + m.dx, dy: at.dy + m.dy }))
      .filter((o) => {
        const b = shift(box, o);
        return inside(b, area) && !cleared.some((c) => overlaps(b, c));
      })
      .sort((a, b) =>
        Math.hypot(a.dx - at.dx, a.dy - at.dy) -
        Math.hypot(b.dx - at.dx, b.dy - at.dy)
      )[0];
    if (!next) return at;
    cleared.push(hit);
    at = next;
  }
  return at;
}
