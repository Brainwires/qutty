// Dragging Loopy to another corner (lib/companion/drag.ts): the threshold between a click and a
// drag, the corner a drop snaps to, and Loopy's idle life pausing while it is dragged.

import { assertEquals } from "@std/assert";
import {
  DRAG_THRESHOLD_PX,
  isDrag,
  nearestCorner,
} from "../lib/companion/drag.ts";
import { type LifeContext, mayLiven } from "../lib/companion/loopy-life.ts";

Deno.test("drag: a press that moves a few pixels is still a click", () => {
  const from = { x: 100, y: 100 };
  assertEquals(isDrag(from, from), false);
  assertEquals(isDrag(from, { x: 103, y: 104 }), false); // exactly 5 px
  assertEquals(isDrag(from, { x: 100 + DRAG_THRESHOLD_PX, y: 100 }), false);
  assertEquals(isDrag(from, { x: 104, y: 104 }), true); // 5.66 px
  assertEquals(isDrag(from, { x: 40, y: 100 }), true);
  assertEquals(isDrag(from, { x: 110, y: 100 }, 12), false);
});

Deno.test("drag: the drop snaps to the nearest corner of the area", () => {
  const size = { width: 1000, height: 600 };
  assertEquals(nearestCorner({ x: 20, y: 20 }, size), "top-left");
  assertEquals(nearestCorner({ x: 980, y: 20 }, size), "top-right");
  assertEquals(nearestCorner({ x: 20, y: 580 }, size), "bottom-left");
  assertEquals(nearestCorner({ x: 980, y: 580 }, size), "bottom-right");
  assertEquals(nearestCorner({ x: 499, y: 299 }, size), "top-left");
  // The exact middle, and outside the area (dropped past an edge): the nearest still.
  assertEquals(nearestCorner({ x: 500, y: 300 }, size), "bottom-right");
  assertEquals(nearestCorner({ x: -50, y: 900 }, size), "bottom-left");
  assertEquals(nearestCorner({ x: 1400, y: -10 }, size), "top-right");
});

Deno.test("drag: Loopy is not free for its idle life while dragged", () => {
  const ctx: LifeContext = {
    lively: true,
    state: "idle",
    message: false,
    voice: false,
    busy: false,
    awake: true,
  };
  assertEquals(mayLiven(ctx), true);
  assertEquals(mayLiven({ ...ctx, dragging: false }), true);
  assertEquals(mayLiven({ ...ctx, dragging: true }), false);
});
