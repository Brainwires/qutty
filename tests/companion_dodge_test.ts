// Keeping the companion off the prompt boxes and the harness rail (lib/companion/dodge.ts).

import { assertEquals } from "@std/assert";
import { type Box, dodgeOffset, overlaps } from "../lib/companion/dodge.ts";

const box = (left: number, top: number, w: number, h: number): Box => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

const AREA = box(0, 0, 1000, 800);
/** The companion in the bottom-right corner. */
const COMPANION = box(780, 690, 200, 100);
/** A prompt box along the bottom of a tile that fills the area. */
const COMPOSER = box(10, 700, 980, 90);
/** A harness rail down the right of the terminal, above the prompt box. */
const RAIL = box(948, 60, 32, 630);

Deno.test("overlaps: touching edges do not", () => {
  assertEquals(overlaps(box(0, 0, 10, 10), box(10, 0, 10, 10)), false);
  assertEquals(overlaps(box(0, 0, 10, 10), box(9, 9, 10, 10)), true);
});

Deno.test("dodgeOffset: nothing in the way, no move", () => {
  assertEquals(dodgeOffset(COMPANION, [], AREA), { dx: 0, dy: 0 });
  assertEquals(dodgeOffset(COMPANION, [box(0, 0, 100, 100)], AREA), {
    dx: 0,
    dy: 0,
  });
});

Deno.test("dodgeOffset: over a prompt box along the bottom, it moves up above it", () => {
  // 790 → 692: the box's top less the gap.
  assertEquals(dodgeOffset(COMPANION, [COMPOSER], AREA), { dx: 0, dy: -98 });
});

Deno.test("dodgeOffset: above the prompt box and beside the rail", () => {
  const o = dodgeOffset(COMPANION, [COMPOSER, RAIL], AREA);
  assertEquals(o, { dx: -40, dy: -98 });
  const at = box(COMPANION.left + o.dx, COMPANION.top + o.dy, 200, 100);
  assertEquals(overlaps(at, COMPOSER), false);
  assertEquals(overlaps(at, RAIL), false);
});

Deno.test("dodgeOffset: stays in the area; the best it found when nothing fits", () => {
  // A prompt box filling the whole area: no move clears it.
  assertEquals(dodgeOffset(COMPANION, [AREA], AREA), { dx: 0, dy: 0 });
  // A top-corner companion over a bar at the top moves down, never out of the area.
  const top = box(780, 10, 200, 100);
  assertEquals(dodgeOffset(top, [box(0, 0, 1000, 60)], AREA), {
    dx: 0,
    dy: 58,
  });
});
