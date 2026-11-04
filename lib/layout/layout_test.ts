import { assert, assertEquals } from "@std/assert";
import {
  computeLayout,
  DEFAULT_LAYOUT_OPTIONS,
  type LayoutOptions,
  type LayoutPattern,
  PATTERN_INFO,
  rankScale,
  type Rect,
  touch,
} from "./mod.ts";

const PATTERNS = Object.keys(PATTERN_INFO) as LayoutPattern[];

const BOUNDS: Record<string, Rect> = {
  landscape: { x: 0, y: 0, w: 1920, h: 1080 },
  laptop: { x: 10, y: 40, w: 1440, h: 860 },
  portrait: { x: 0, y: 0, w: 900, h: 1600 },
  square: { x: 0, y: 0, w: 1000, h: 1000 },
  tiny: { x: 0, y: 0, w: 300, h: 200 },
};

const OPTION_SETS: Record<string, Partial<LayoutOptions>> = {
  default: {},
  noGapNoMin: { gap: 0, minTileW: 0, minTileH: 0, maxVisible: 16 },
  max16: { maxVisible: 16, minTileW: 120, minTileH: 60 },
  equal: { decay: 1, maxVisible: 16, minTileW: 100, minTileH: 50 },
  steep: {
    decay: 0.3,
    masterRatio: 0.85,
    maxVisible: 16,
    minTileW: 60,
    minTileH: 40,
  },
  // masterRatio 0.3 is below the documented 0.5..0.85 range: it clamps to 0.5.
  lowMaster: { decay: 0.9, masterRatio: 0.3, maxVisible: 8, gap: 10 },
};

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `t${i}`);
}

function area(r: Rect): number {
  return r.w * r.h;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h &&
    b.y < a.y + a.h;
}

function within(r: Rect, b: Rect): boolean {
  return r.x >= b.x && r.y >= b.y && r.x + r.w <= b.x + b.w &&
    r.y + r.h <= b.y + b.h;
}

function isInt(r: Rect): boolean {
  return [r.x, r.y, r.w, r.h].every(Number.isInteger);
}

Deno.test("invariants hold for every pattern, n=1..16, several bounds/options", () => {
  for (const pattern of PATTERNS) {
    for (const [bName, bounds] of Object.entries(BOUNDS)) {
      for (const [oName, partial] of Object.entries(OPTION_SETS)) {
        const opts = { ...DEFAULT_LAYOUT_OPTIONS, ...partial, pattern };
        for (let n = 1; n <= 16; n++) {
          const label = `${pattern}/${bName}/${oName}/n=${n}`;
          const input = ids(n);
          const res = computeLayout(input, bounds, opts);
          const { tiles, overflow } = res;

          // Every id exactly once; tiles then overflow preserve MRU order.
          assertEquals(
            [...tiles.map((t) => t.id), ...overflow],
            input,
            `${label}: ids`,
          );
          tiles.forEach((t, i) => assertEquals(t.rank, i, `${label}: rank`));

          assert(tiles.length >= 1, `${label}: at least one tile`);
          assert(tiles.length <= opts.maxVisible, `${label}: maxVisible`);
          if (pattern === "monocle") {
            assertEquals(tiles.length, 1, `${label}: monocle`);
            assertEquals(tiles[0].id, "t0");
          }

          for (const t of tiles) {
            assert(
              isInt(t.rect),
              `${label}: integer rect ${JSON.stringify(t.rect)}`,
            );
            assert(t.rect.w >= 0 && t.rect.h >= 0, `${label}: non-negative`);
            assert(
              within(t.rect, bounds),
              `${label}: within bounds ${JSON.stringify(t.rect)}`,
            );
          }

          for (let i = 0; i < tiles.length; i++) {
            for (let j = i + 1; j < tiles.length; j++) {
              assert(
                !overlaps(tiles[i].rect, tiles[j].rect),
                `${label}: overlap ${i} ${j}`,
              );
            }
          }

          if (tiles.length > 1) {
            for (const t of tiles) {
              assert(
                t.rect.w >= opts.minTileW && t.rect.h >= opts.minTileH,
                `${label}: min size ${JSON.stringify(t.rect)}`,
              );
            }
          }

          // Area non-increasing by rank (master-stack: after the master).
          const start = pattern === "master-stack" ? 2 : 1;
          for (let i = start; i < tiles.length; i++) {
            const prev = area(tiles[i - 1].rect);
            const cur = area(tiles[i].rect);
            const r = tiles[i].rect;
            // 1% tolerance plus one px of rounding along each edge.
            const tol = prev * 0.01 + r.w + r.h + 1;
            assert(
              cur <= prev + tol,
              `${label}: area rank ${i} (${cur}) > rank ${i - 1} (${prev})`,
            );
          }

          // Deterministic.
          assertEquals(
            computeLayout(input, bounds, opts),
            res,
            `${label}: deterministic`,
          );
        }
      }
    }
  }
});

Deno.test("gaps: edges and between tiles equal the gap", () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 600 };
  const opts: LayoutOptions = {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "columns",
    decay: 1,
    gap: 10,
    minTileW: 0,
    minTileH: 0,
  };
  const { tiles } = computeLayout(ids(2), bounds, opts);
  assertEquals(tiles[0].rect, { x: 10, y: 10, w: 485, h: 580 });
  assertEquals(tiles[1].rect, { x: 505, y: 10, w: 485, h: 580 });
});

Deno.test("single tile fills bounds minus gap", () => {
  for (const pattern of PATTERNS) {
    const { tiles, overflow } = computeLayout(["a"], {
      x: 0,
      y: 0,
      w: 800,
      h: 600,
    }, {
      ...DEFAULT_LAYOUT_OPTIONS,
      pattern,
      gap: 8,
    });
    assertEquals(overflow, []);
    assertEquals(tiles, [{
      id: "a",
      rank: 0,
      rect: { x: 8, y: 8, w: 784, h: 584 },
    }]);
  }
});

Deno.test("cascade: exact area proportionality without gaps", () => {
  const bounds = { x: 0, y: 0, w: 1600, h: 1000 };
  const opts: LayoutOptions = {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "cascade",
    decay: 0.5,
    masterRatio: 0.85,
    gap: 0,
    minTileW: 0,
    minTileH: 0,
  };
  const { tiles } = computeLayout(ids(4), bounds, opts);
  const total = 1600 * 1000;
  const s = 1 + 0.5 + 0.25 + 0.125;
  tiles.forEach((t, i) => {
    const expected = total * Math.pow(0.5, i) / s;
    assert(Math.abs(area(t.rect) - expected) / expected < 0.01, `rank ${i}`);
  });
  // First tile on the left (landscape → vertical cut), full height.
  assertEquals(tiles[0].rect.x, 0);
  assertEquals(tiles[0].rect.h, 1000);
  // Tiles cover the whole area.
  assertEquals(tiles.reduce((a, t) => a + area(t.rect), 0), total);
});

Deno.test("cascade: first split clamped to masterRatio at low decay", () => {
  const bounds = { x: 0, y: 0, w: 1000, h: 1000 };
  const base = {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "cascade" as const,
    gap: 0,
    minTileW: 0,
    minTileH: 0,
    decay: 0.3,
  };
  const clamped = computeLayout(ids(3), bounds, { ...base, masterRatio: 0.6 });
  assertEquals(clamped.tiles[0].rect.w, 600);
  const unclamped = computeLayout(ids(3), bounds, {
    ...base,
    masterRatio: 0.85,
  });
  // 1 / (1 + 0.3 + 0.09) ≈ 0.719
  assertEquals(unclamped.tiles[0].rect.w, 719);
  // Clamp never makes rank 0 smaller than rank 1. masterRatio 0.3 is out of range and clamps to
  // 0.5, which here is also the floor that keeps rank 0 >= rank 1: an even split.
  const low = computeLayout(ids(2), bounds, { ...base, masterRatio: 0.3 });
  assert(area(low.tiles[0].rect) >= area(low.tiles[1].rect));
  assertEquals(low.tiles[0].rect.w, 500);
  assertEquals(
    low,
    computeLayout(ids(2), bounds, { ...base, masterRatio: 0.5 }),
  );
});

Deno.test("spiral rotates placement side", () => {
  const bounds = { x: 0, y: 0, w: 1600, h: 1000 };
  const { tiles } = computeLayout(ids(4), bounds, {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "spiral",
    decay: 0.8,
    gap: 0,
    minTileW: 0,
    minTileH: 0,
  });
  const [a, b, c, d] = tiles.map((t) => t.rect);
  assertEquals(a.x, 0); // left, full height
  assertEquals(a.h, 1000);
  assertEquals(b.y, 0); // top of the remainder
  assertEquals(b.x, a.w);
  assertEquals(c.x + c.w, 1600); // right side
  assertEquals(d.y + d.h, 1000); // bottom
  assert(d.x >= a.w && d.x + d.w <= c.x);
});

Deno.test("master-stack: master share and portrait orientation", () => {
  const opts = {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "master-stack" as const,
    masterRatio: 0.6,
    gap: 0,
    minTileW: 0,
    minTileH: 0,
  };
  const land = computeLayout(ids(3), { x: 0, y: 0, w: 1000, h: 800 }, opts);
  assertEquals(land.tiles[0].rect, { x: 0, y: 0, w: 600, h: 800 });
  assertEquals(land.tiles[1].rect.x, 600);
  assertEquals(land.tiles[2].rect.x, 600);
  assert(land.tiles[1].rect.h > land.tiles[2].rect.h);
  const port = computeLayout(ids(3), { x: 0, y: 0, w: 800, h: 1000 }, opts);
  assertEquals(port.tiles[0].rect, { x: 0, y: 0, w: 800, h: 600 });
  assert(port.tiles[1].rect.w > port.tiles[2].rect.w);
});

Deno.test("columns and rows are strips", () => {
  const bounds = { x: 0, y: 0, w: 1200, h: 800 };
  const base = { ...DEFAULT_LAYOUT_OPTIONS, gap: 0, minTileW: 0, minTileH: 0 };
  const cols = computeLayout(ids(3), bounds, { ...base, pattern: "columns" });
  for (const t of cols.tiles) assertEquals([t.rect.y, t.rect.h], [0, 800]);
  const rows = computeLayout(ids(3), bounds, { ...base, pattern: "rows" });
  for (const t of rows.tiles) assertEquals([t.rect.x, t.rect.w], [0, 1200]);
});

Deno.test("grid fills reading order, near-square", () => {
  const bounds = { x: 0, y: 0, w: 1200, h: 900 };
  const { tiles } = computeLayout(ids(5), bounds, {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "grid",
    decay: 1,
    maxVisible: 16,
    gap: 0,
    minTileW: 0,
    minTileH: 0,
  });
  // cols = ceil(sqrt(5)) = 3 → row of 3, row of 2.
  const ys = tiles.map((t) => t.rect.y);
  assertEquals(ys[0], ys[1]);
  assertEquals(ys[1], ys[2]);
  assertEquals(ys[3], ys[4]);
  assert(ys[3] > ys[0]);
  assert(
    tiles[0].rect.x < tiles[1].rect.x && tiles[1].rect.x < tiles[2].rect.x,
  );
});

Deno.test("overflow: maxVisible, monocle, min tile size", () => {
  const bounds = { x: 0, y: 0, w: 1920, h: 1080 };
  const r1 = computeLayout(ids(10), bounds, {
    ...DEFAULT_LAYOUT_OPTIONS,
    maxVisible: 4,
  });
  assertEquals(r1.tiles.length, 4);
  assertEquals(r1.overflow, ["t4", "t5", "t6", "t7", "t8", "t9"]);

  const r2 = computeLayout(ids(5), bounds, {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "monocle",
  });
  assertEquals(r2.tiles.length, 1);
  assertEquals(r2.tiles[0].rect, { x: 6, y: 6, w: 1908, h: 1068 });
  assertEquals(r2.overflow, ["t1", "t2", "t3", "t4"]);

  // Tiny bounds: only one tile fits the minimum size.
  const r3 = computeLayout(
    ids(5),
    { x: 0, y: 0, w: 300, h: 200 },
    DEFAULT_LAYOUT_OPTIONS,
  );
  assertEquals(r3.tiles.length, 1);
  assertEquals(r3.overflow.length, 4);

  // Columns: 1000px wide with 300px min width fits at most 3.
  const r4 = computeLayout(ids(6), { x: 0, y: 0, w: 1000, h: 600 }, {
    ...DEFAULT_LAYOUT_OPTIONS,
    pattern: "columns",
    decay: 1,
    gap: 0,
    minTileW: 300,
    minTileH: 0,
  });
  assertEquals(r4.tiles.length, 3);
  assertEquals(r4.overflow, ["t3", "t4", "t5"]);
});

Deno.test("edge cases: empty, duplicates, out-of-range options", () => {
  const bounds = { x: 0, y: 0, w: 800, h: 600 };
  assertEquals(computeLayout([], bounds, DEFAULT_LAYOUT_OPTIONS), {
    tiles: [],
    overflow: [],
  });
  const dup = computeLayout(["a", "b", "a"], bounds, {
    ...DEFAULT_LAYOUT_OPTIONS,
    minTileW: 0,
    minTileH: 0,
  });
  assertEquals(dup.tiles.map((t) => t.id), ["a", "b"]);
  const wild = computeLayout(ids(30), bounds, {
    ...DEFAULT_LAYOUT_OPTIONS,
    maxVisible: 100,
    decay: 5,
    masterRatio: -1,
    minTileW: 0,
    minTileH: 0,
  });
  assertEquals(wild.tiles.length, 16);
  assertEquals(wild.overflow.length, 14);
  // Gap larger than bounds: degenerate but valid.
  const huge = computeLayout(ids(3), { x: 0, y: 0, w: 20, h: 20 }, {
    ...DEFAULT_LAYOUT_OPTIONS,
    gap: 100,
  });
  assertEquals(huge.tiles.length, 1);
  assert(huge.tiles[0].rect.w >= 0);
});

Deno.test("touch moves id to front", () => {
  const mru = ["a", "b", "c"];
  assertEquals(touch(mru, "c"), ["c", "a", "b"]);
  assertEquals(touch(mru, "a"), ["a", "b", "c"]);
  assertEquals(touch(mru, "z"), ["z", "a", "b", "c"]);
  assertEquals(mru, ["a", "b", "c"]); // not mutated
});

Deno.test("rankScale", () => {
  assertEquals(rankScale(0, 0.5), 1);
  assertEquals(rankScale(5, 1), 1);
  let prev = 1;
  for (let r = 1; r < 16; r++) {
    const s = rankScale(r, 0.7);
    assert(s < prev && s > 0);
    prev = s;
  }
  assert(Math.abs(rankScale(2, 0.49) - 0.49) < 1e-9);
});

Deno.test("PATTERN_INFO covers every pattern", () => {
  for (const p of PATTERNS) {
    assert(PATTERN_INFO[p].label.length > 0);
    assert(PATTERN_INFO[p].description.length > 0);
  }
  assertEquals(PATTERNS.length, 7);
});
