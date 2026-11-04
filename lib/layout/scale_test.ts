import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { computeLayout, DEFAULT_LAYOUT_OPTIONS, PATTERN_INFO } from "./mod.ts";
import type { LayoutPattern } from "./mod.ts";
import { letterbox, TILE_BODY_INSET, tileBodySize } from "./scale.ts";

Deno.test("tileBodySize: the rect minus the border and header", () => {
  assertEquals(TILE_BODY_INSET, { w: 2, h: 28 });
  assertEquals(tileBodySize({ x: 5, y: 9, w: 800, h: 600 }), {
    w: 798,
    h: 572,
  });
  // Position does not matter; a rect smaller than the chrome gives 0, never negative.
  assertEquals(
    tileBodySize({ x: 0, y: 0, w: 800, h: 600 }),
    tileBodySize({ x: 400, y: 300, w: 800, h: 600 }),
  );
  assertEquals(tileBodySize({ x: 0, y: 0, w: 1, h: 20 }), { w: 0, h: 0 });
  assertEquals(tileBodySize({ x: 0, y: 0, w: NaN, h: Infinity }), {
    w: 0,
    h: 0,
  });
});

Deno.test("letterbox: scale is the tighter axis and the slack is split evenly", () => {
  const full = { w: 1000, h: 500 };
  // Width-bound: half the width, more than half the height available.
  let l = letterbox({ w: 500, h: 400 }, full);
  assertEquals(l.scale, 0.5);
  assertEquals(l.x, 0);
  assertEquals(l.y, (400 - 250) / 2);
  // Height-bound.
  l = letterbox({ w: 900, h: 100 }, full);
  assertEquals(l.scale, 0.2);
  assertEquals(l.x, (900 - 200) / 2);
  assertEquals(l.y, 0);
  // Same aspect: no letterbox.
  l = letterbox({ w: 250, h: 125 }, full);
  assertEquals(l, { scale: 0.25, x: 0, y: 0 });
});

Deno.test("letterbox: never magnifies, and degenerate sizes are harmless", () => {
  // A box as big as (or bigger than) the terminal: scale 1, centred.
  assertEquals(letterbox({ w: 1000, h: 500 }, { w: 1000, h: 500 }), {
    scale: 1,
    x: 0,
    y: 0,
  });
  assertEquals(letterbox({ w: 1200, h: 700 }, { w: 1000, h: 500 }), {
    scale: 1,
    x: 100,
    y: 100,
  });
  assertEquals(letterbox({ w: 100, h: 100 }, { w: 0, h: 500 }), {
    scale: 1,
    x: 0,
    y: 0,
  });
  assertEquals(letterbox({ w: 100, h: 100 }, { w: NaN, h: 500 }), {
    scale: 1,
    x: 0,
    y: 0,
  });
  assertEquals(letterbox({ w: 0, h: 0 }, { w: 1000, h: 500 }), {
    scale: 0,
    x: 0,
    y: 0,
  });
});

Deno.test("letterbox: every inactive tile of every pattern fits inside its own body", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const bounds = { x: 0, y: 0, w: 1400, h: 860 };
  for (const pattern of Object.keys(PATTERN_INFO) as LayoutPattern[]) {
    const { tiles } = computeLayout(ids, bounds, {
      ...DEFAULT_LAYOUT_OPTIONS,
      pattern,
    });
    const full = tileBodySize(tiles[0].rect);
    for (const t of tiles) {
      const box = tileBodySize(t.rect);
      const l = letterbox(box, full);
      assert(l.scale > 0 && l.scale <= 1, `${pattern} ${t.id} ${l.scale}`);
      // The scaled terminal stays inside the body, centred in the slack.
      assert(l.x >= 0 && l.y >= 0, `${pattern} ${t.id} offsets`);
      assertAlmostEquals(l.x * 2 + full.w * l.scale, box.w, 1e-9);
      assertAlmostEquals(l.y * 2 + full.h * l.scale, box.h, 1e-9);
      if (t.rank === 0) assertEquals(l, { scale: 1, x: 0, y: 0 });
    }
  }
});
