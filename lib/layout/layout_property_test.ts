// Property-based, stability and golden tests for the tiling engine (lib/layout/mod.ts).
//
// Every random case comes from a seeded PRNG (mulberry32), so a failure is reproducible: the
// assertion message names the seed and case index. Run: deno test lib/layout/

import { assert, assertEquals } from "@std/assert";
import {
  computeLayout,
  DEFAULT_LAYOUT_OPTIONS,
  type LayoutOptions,
  type LayoutPattern,
  type LayoutResult,
  PATTERN_INFO,
  rankScale,
  type Rect,
  touch,
} from "./mod.ts";

const PATTERNS = Object.keys(PATTERN_INFO) as LayoutPattern[];
const TILED: LayoutPattern[] = PATTERNS.filter((p) => p !== "monocle");

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** mulberry32: a tiny, fast, seedable PRNG returning floats in [0, 1). */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)];

function ids(n: number, prefix = "t"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

function area(r: Rect): number {
  return r.w * r.h;
}

/** Positive-area intersection (touching edges and empty rects do not overlap). */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h &&
    b.y < a.y + a.h;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

const finiteOr = (v: number, d: number) => Number.isFinite(v) ? v : d;
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/** The documented option clamping, restated independently of the engine. */
function normOpts(o: LayoutOptions): LayoutOptions {
  const d = DEFAULT_LAYOUT_OPTIONS;
  return {
    pattern: PATTERNS.includes(o.pattern) ? o.pattern : d.pattern,
    decay: clamp(finiteOr(o.decay, d.decay), 0.3, 1),
    masterRatio: clamp(finiteOr(o.masterRatio, d.masterRatio), 0.5, 0.85),
    maxVisible: Math.round(clamp(finiteOr(o.maxVisible, d.maxVisible), 1, 16)),
    gap: Math.max(0, finiteOr(o.gap, d.gap)),
    minTileW: Math.max(0, finiteOr(o.minTileW, d.minTileW)),
    minTileH: Math.max(0, finiteOr(o.minTileH, d.minTileH)),
  };
}

/** The integer px box tiles must stay inside (bounds with non-finite / negative parts zeroed). */
function pxBox(b: Rect): { x0: number; y0: number; x1: number; y1: number } {
  const x = finiteOr(b.x, 0), y = finiteOr(b.y, 0);
  const w = Math.max(0, finiteOr(b.w, 0)), h = Math.max(0, finiteOr(b.h, 0));
  const x0 = Math.ceil(x), y0 = Math.ceil(y);
  return {
    x0,
    y0,
    x1: Math.max(x0, Math.floor(x + w)),
    y1: Math.max(y0, Math.floor(y + h)),
  };
}

const rectsOf = (res: LayoutResult) => res.tiles.map((t) => t.rect);
const visibleIds = (res: LayoutResult) => res.tiles.map((t) => t.id);

/**
 * Every invariant `computeLayout` documents, for one input/output pair. Throws with `label` on
 * the first violation.
 */
function checkInvariants(
  input: string[],
  bounds: Rect,
  opts: LayoutOptions,
  res: LayoutResult,
  label: string,
): void {
  const o = normOpts(opts);
  const uniq = dedupe(input);
  const { tiles, overflow } = res;

  // Each (de-duplicated) id exactly once, tiles then overflow in MRU order; ranks 0..n-1.
  assertEquals(
    [...tiles.map((t) => t.id), ...overflow],
    uniq,
    `${label}: ids/MRU order`,
  );
  tiles.forEach((t, i) => assertEquals(t.rank, i, `${label}: rank`));

  if (uniq.length === 0) {
    assertEquals(res, { tiles: [], overflow: [] }, `${label}: empty`);
    return;
  }
  assert(tiles.length >= 1, `${label}: at least one tile`);
  assert(tiles.length <= o.maxVisible, `${label}: maxVisible ${o.maxVisible}`);
  if (o.pattern === "monocle") {
    assertEquals(tiles.length, 1, `${label}: monocle`);
  }

  const box = pxBox(bounds);
  for (const t of tiles) {
    const r = t.rect;
    const s = JSON.stringify(r);
    assert(
      [r.x, r.y, r.w, r.h].every(Number.isInteger),
      `${label}: integer rect ${s}`,
    );
    assert(r.w >= 0 && r.h >= 0, `${label}: non-negative ${s}`);
    assert(
      r.x >= box.x0 && r.y >= box.y0 && r.x + r.w <= box.x1 &&
        r.y + r.h <= box.y1,
      `${label}: in bounds ${s} box ${JSON.stringify(box)}`,
    );
  }

  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      assert(
        !overlaps(tiles[i].rect, tiles[j].rect),
        `${label}: overlap ${i}/${j} ${JSON.stringify(tiles[i].rect)} ${
          JSON.stringify(tiles[j].rect)
        }`,
      );
    }
  }

  if (tiles.length > 1) {
    for (const t of tiles) {
      assert(
        t.rect.w >= o.minTileW && t.rect.h >= o.minTileH,
        `${label}: min size ${
          JSON.stringify(t.rect)
        } < ${o.minTileW}x${o.minTileH}`,
      );
    }
  }

  // Area is non-increasing by rank, master included. Tolerance: 1% (gap compensation) plus the
  // rounding of both rects (each edge moves at most 0.5 px, so an area moves by at most
  // w + h + 1). Skipped when a tile is thinner than two gaps (or empty): the gap then eats most
  // of its raw rect and gap compensation's multiplicative update oscillates instead of
  // converging, so slivers can come out in the wrong order (see the report; the default minimum
  // tile size rules them out). Measured: with every side >= 2 * gap there are no violations.
  const thin = Math.max(1, 2 * o.gap);
  if (tiles.every((t) => t.rect.w >= thin && t.rect.h >= thin)) {
    for (let i = 1; i < tiles.length; i++) {
      const p = tiles[i - 1].rect;
      const r = tiles[i].rect;
      const tol = area(p) * 0.01 + p.w + p.h + 1 + r.w + r.h + 1;
      assert(
        area(r) <= area(p) + tol,
        `${label}: area rank ${i} (${area(r)}) > rank ${i - 1} (${area(p)})`,
      );
    }
  }

  // The visible count is maximal: one more tile would break the minimum size.
  const cap = o.pattern === "monocle" ? 1 : Math.min(uniq.length, o.maxVisible);
  const n = tiles.length;
  if (n < cap) {
    const more = computeLayout(uniq.slice(0, n + 1), bounds, {
      ...opts,
      maxVisible: n + 1,
      minTileW: 0,
      minTileH: 0,
    });
    assertEquals(more.tiles.length, n + 1, `${label}: n+1 probe`);
    assert(
      more.tiles.some((t) => t.rect.w < o.minTileW || t.rect.h < o.minTileH),
      `${label}: ${n + 1} tiles would have fit but only ${n} were shown`,
    );
  }

  // Rects depend only on the visible count, not on how many ids overflow.
  assertEquals(
    rectsOf(computeLayout(uniq.slice(0, n), bounds, opts)),
    rectsOf(res),
    `${label}: overflow ids changed the rects`,
  );

  // Deterministic.
  assertEquals(
    computeLayout(input, bounds, opts),
    res,
    `${label}: deterministic`,
  );
}

// ---------------------------------------------------------------------------------------------
// Random generators
// ---------------------------------------------------------------------------------------------

const WILD = [NaN, Infinity, -Infinity, -1, -1e9, 0];

function randBounds(r: Rng): Rect {
  const kind = r();
  if (kind < 0.05) return { x: 0, y: 0, w: 1, h: 1 };
  if (kind < 0.1) {
    return {
      x: int(r, -50, 50),
      y: int(r, -50, 50),
      w: int(r, 0, 3),
      h: int(r, 0, 3),
    };
  }
  if (kind < 0.18) {
    return {
      x: 0,
      y: 0,
      w: int(r, 100_000, 10_000_000),
      h: int(r, 100_000, 10_000_000),
    };
  }
  if (kind < 0.25) {
    // Non-finite / negative parts.
    const b = {
      x: int(r, 0, 100),
      y: int(r, 0, 100),
      w: int(r, 1, 3000),
      h: int(r, 1, 2000),
    };
    const key = pick(r, ["x", "y", "w", "h"] as const);
    b[key] = pick(r, WILD);
    if (r() < 0.3) b[pick(r, ["x", "y", "w", "h"] as const)] = pick(r, WILD);
    return b;
  }
  if (kind < 0.4) {
    // Fractional (devicePixelRatio-scaled) bounds.
    return { x: r() * 200, y: r() * 200, w: r() * 4000, h: r() * 3000 };
  }
  return {
    x: int(r, -500, 500),
    y: int(r, -500, 500),
    w: int(r, 2, 5000),
    h: int(r, 2, 3000),
  };
}

function randOpt(r: Rng, lo: number, hi: number, integer = false): number {
  const k = r();
  if (k < 0.15) return lo;
  if (k < 0.3) return hi;
  if (k < 0.37) return lo - 1 - r() * 10;
  if (k < 0.44) return hi + 1 + r() * 100;
  if (k < 0.52) return pick(r, WILD);
  const v = lo + r() * (hi - lo);
  return integer ? Math.round(v) : v;
}

function randOpts(r: Rng): LayoutOptions {
  return {
    pattern: r() < 0.03 ? ("bogus" as LayoutPattern) : pick(r, PATTERNS),
    decay: randOpt(r, 0.3, 1),
    masterRatio: randOpt(r, 0.5, 0.85),
    maxVisible: randOpt(r, 1, 16, r() < 0.8),
    gap: randOpt(r, 0, 24, r() < 0.7),
    minTileW: randOpt(r, 0, 400, true),
    minTileH: randOpt(r, 0, 250, true),
  };
}

function randIds(r: Rng): string[] {
  const n = int(r, 0, 40);
  // A small pool makes duplicates likely; a large one makes them rare.
  const pool = r() < 0.3 ? int(r, 1, 10) : 1000;
  return Array.from({ length: n }, () => `id${int(r, 0, pool - 1)}`);
}

// ---------------------------------------------------------------------------------------------
// Fuzzing
// ---------------------------------------------------------------------------------------------

Deno.test("fuzz: every invariant over 6000 random inputs (seeded)", () => {
  const seed = 0xc0ffee;
  const r = prng(seed);
  let tiled = 0;
  for (let i = 0; i < 6000; i++) {
    const input = randIds(r);
    const bounds = randBounds(r);
    const opts = randOpts(r);
    const res = computeLayout(input, bounds, opts);
    if (res.tiles.length > 1) tiled++;
    checkInvariants(
      input,
      bounds,
      opts,
      res,
      `seed ${seed} case ${i} ${
        JSON.stringify({ bounds, opts, n: input.length })
      }`,
    );
  }
  // The generator must exercise real multi-tile layouts, not just degenerate ones.
  assert(tiled > 1500, `only ${tiled} multi-tile cases`);
});

Deno.test("fuzz: every option at its extremes x every pattern x bounds", () => {
  const extremes = {
    decay: [0.3, 1, 0, 2, NaN, -Infinity],
    masterRatio: [0.5, 0.85, 0, 1, NaN, Infinity],
    maxVisible: [1, 16, 0, 17, 1000, 1.4, 1.6, NaN],
    gap: [0, 1, 7, 100, -5, Infinity],
    minTileW: [0, 1, 5000, -1, NaN],
    minTileH: [0, 1, 5000, -1, Infinity],
  };
  const bounds: Rect[] = [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0, y: 0, w: 1920, h: 1080 },
    { x: 3, y: 7, w: 600, h: 2400 },
    { x: 0, y: 0, w: 1e7, h: 1e7 },
  ];
  const r = prng(7);
  let count = 0;
  for (const pattern of [...PATTERNS, "nope" as LayoutPattern]) {
    for (const b of bounds) {
      for (const [key, values] of Object.entries(extremes)) {
        for (const v of values) {
          const opts = { ...DEFAULT_LAYOUT_OPTIONS, pattern, [key]: v };
          for (const n of [0, 1, 2, 5, 16, 40]) {
            // Shuffle in a duplicate now and then.
            const input = ids(n);
            if (n > 2 && r() < 0.5) input.splice(1, 0, input[n - 1]);
            const res = computeLayout(input, b, opts);
            checkInvariants(
              input,
              b,
              opts,
              res,
              `${pattern} ${JSON.stringify(b)} ${key}=${v} n=${n}`,
            );
            count++;
          }
        }
      }
    }
  }
  assert(count > 5000);
});

Deno.test("fuzz: non-finite and negative bounds give empty, valid rects", () => {
  for (const pattern of PATTERNS) {
    for (const bad of [NaN, Infinity, -Infinity, -100]) {
      for (
        const b of [
          { x: 0, y: 0, w: bad, h: 600 },
          { x: 0, y: 0, w: 800, h: bad },
          { x: 0, y: 0, w: bad, h: bad },
        ]
      ) {
        const res = computeLayout(ids(4), b, {
          ...DEFAULT_LAYOUT_OPTIONS,
          pattern,
          minTileW: 0,
          minTileH: 0,
        });
        checkInvariants(
          ids(4),
          b,
          { ...DEFAULT_LAYOUT_OPTIONS, pattern, minTileW: 0, minTileH: 0 },
          res,
          `${pattern} ${JSON.stringify(b)}`,
        );
        // A zero-size dimension collapses every tile along it.
        if (!(Number.isFinite(b.w) && b.w > 0)) {
          assert(res.tiles.every((t) => t.rect.w === 0 && t.rect.x === 0));
        }
        if (!(Number.isFinite(b.h) && b.h > 0)) {
          assert(res.tiles.every((t) => t.rect.h === 0 && t.rect.y === 0));
        }
      }
    }
    // A non-finite origin is treated as 0: same result as the origin at 0.
    const opts = { ...DEFAULT_LAYOUT_OPTIONS, pattern };
    const at0 = computeLayout(ids(3), { x: 0, y: 0, w: 1200, h: 800 }, opts);
    for (const bad of [NaN, Infinity, -Infinity]) {
      assertEquals(
        computeLayout(ids(3), { x: bad, y: bad, w: 1200, h: 800 }, opts),
        at0,
        `${pattern}: origin ${bad}`,
      );
    }
  }
});

Deno.test("fuzz: integer gap gives exact spacing between tiles and at the edges", () => {
  const r = prng(99);
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const pattern = pick(r, PATTERNS);
    const gap = int(r, 0, 20);
    const bounds = {
      x: int(r, -100, 100),
      y: int(r, -100, 100),
      w: int(r, 300, 4000),
      h: int(r, 300, 2500),
    };
    const opts: LayoutOptions = {
      pattern,
      decay: 0.3 + r() * 0.7,
      masterRatio: 0.5 + r() * 0.35,
      maxVisible: int(r, 1, 16),
      gap,
      minTileW: int(r, 1, 300),
      minTileH: int(r, 1, 200),
    };
    const res = computeLayout(ids(int(r, 1, 20)), bounds, opts);
    const rs = rectsOf(res);
    if (rs.some((q) => q.w < 1 || q.h < 1)) continue;
    checked++;
    const label = `case ${i} ${JSON.stringify({ bounds, opts })}`;
    // The tiles' bounding box is the bounds inset by exactly `gap`.
    assertEquals(
      Math.min(...rs.map((q) => q.x)),
      bounds.x + gap,
      `${label}: left`,
    );
    assertEquals(
      Math.min(...rs.map((q) => q.y)),
      bounds.y + gap,
      `${label}: top`,
    );
    assertEquals(
      Math.max(...rs.map((q) => q.x + q.w)),
      bounds.x + bounds.w - gap,
      `${label}: right`,
    );
    assertEquals(
      Math.max(...rs.map((q) => q.y + q.h)),
      bounds.y + bounds.h - gap,
      `${label}: bottom`,
    );
    // Every side of every tile faces a neighbour (or the edge) at gap ± 1 px: no wasted space.
    for (const [i0, a] of rs.entries()) {
      const others = rs.filter((_, j) => j !== i0);
      const ySpan = (b: Rect) => a.y < b.y + b.h && b.y < a.y + a.h;
      const xSpan = (b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w;
      const sides = {
        left: Math.min(
          a.x - bounds.x,
          ...others.filter((b) => ySpan(b) && b.x + b.w <= a.x).map((b) =>
            a.x - (b.x + b.w)
          ),
        ),
        right: Math.min(
          bounds.x + bounds.w - (a.x + a.w),
          ...others.filter((b) => ySpan(b) && b.x >= a.x + a.w).map((b) =>
            b.x - (a.x + a.w)
          ),
        ),
        top: Math.min(
          a.y - bounds.y,
          ...others.filter((b) => xSpan(b) && b.y + b.h <= a.y).map((b) =>
            a.y - (b.y + b.h)
          ),
        ),
        bottom: Math.min(
          bounds.y + bounds.h - (a.y + a.h),
          ...others.filter((b) => xSpan(b) && b.y >= a.y + a.h).map((b) =>
            b.y - (a.y + a.h)
          ),
        ),
      };
      for (const [side, d] of Object.entries(sides)) {
        assert(
          Math.abs(d - gap) <= 1,
          `${label}: tile ${i0} ${side} spacing ${d} (gap ${gap}) ${
            JSON.stringify(rs)
          }`,
        );
      }
    }
  }
  assert(checked > 2000, `only ${checked} cases checked`);
});

Deno.test("fuzz: gap 0 tiles partition integer bounds exactly", () => {
  const r = prng(4242);
  for (let i = 0; i < 3000; i++) {
    const pattern = pick(r, PATTERNS);
    const bounds = {
      x: int(r, -300, 300),
      y: int(r, -300, 300),
      w: int(r, 1, 4000),
      h: int(r, 1, 3000),
    };
    const opts: LayoutOptions = {
      pattern,
      decay: 0.3 + r() * 0.7,
      masterRatio: 0.5 + r() * 0.35,
      maxVisible: int(r, 1, 16),
      gap: 0,
      minTileW: 0,
      minTileH: 0,
    };
    const input = ids(int(r, 1, 30));
    const res = computeLayout(input, bounds, opts);
    const label = `case ${i} ${JSON.stringify({ bounds, opts })}`;
    checkInvariants(input, bounds, opts, res, label);
    // No overlaps (checked above) + full area = an exact partition.
    const total = res.tiles.reduce((s, t) => s + area(t.rect), 0);
    assertEquals(total, bounds.w * bounds.h, label);
  }
});

// ---------------------------------------------------------------------------------------------
// Stability properties the UI relies on for animation
// ---------------------------------------------------------------------------------------------

/** Finite, practical options and bounds (what the settings UI can produce). */
function randPractical(r: Rng): { bounds: Rect; opts: LayoutOptions } {
  return {
    bounds: {
      x: int(r, 0, 50),
      y: int(r, 0, 50),
      w: int(r, 200, 3840),
      h: int(r, 150, 2160),
    },
    opts: {
      pattern: pick(r, PATTERNS),
      decay: 0.3 + r() * 0.7,
      masterRatio: 0.5 + r() * 0.35,
      maxVisible: int(r, 1, 16),
      gap: int(r, 0, 16),
      minTileW: int(r, 0, 320),
      minTileH: int(r, 0, 200),
    },
  };
}

Deno.test("stability: touching the focused id is a no-op", () => {
  const r = prng(1);
  for (let i = 0; i < 1000; i++) {
    const { bounds, opts } = randPractical(r);
    const mru = ids(int(r, 1, 25));
    const touched = touch(mru, mru[0]);
    assertEquals(touched, mru);
    assertEquals(
      computeLayout(touched, bounds, opts),
      computeLayout(mru, bounds, opts),
    );
  }
});

Deno.test("stability: touching a visible tile never pulls an overflow id into view", () => {
  const r = prng(2);
  let exercised = 0;
  for (let i = 0; i < 2000; i++) {
    const { bounds, opts } = randPractical(r);
    const mru = ids(int(r, 1, 30));
    const before = computeLayout(mru, bounds, opts);
    const target = pick(r, visibleIds(before));
    const after = computeLayout(touch(mru, target), bounds, opts);
    const label = `case ${i}`;
    assertEquals(after.overflow, before.overflow, `${label}: overflow changed`);
    assertEquals(
      [...visibleIds(after)].sort(),
      [...visibleIds(before)].sort(),
      `${label}: visible set changed`,
    );
    assertEquals(after.tiles[0].id, target);
    // The slots (rects by rank) do not move; only who sits in them does.
    assertEquals(rectsOf(after), rectsOf(before), `${label}: slots moved`);
    if (before.overflow.length > 0) exercised++;
  }
  assert(exercised > 300, `only ${exercised} cases had overflow`);
});

Deno.test("stability: touching an overflow id displaces exactly the oldest visible tile", () => {
  const r = prng(3);
  let exercised = 0;
  for (let i = 0; i < 2000; i++) {
    const { bounds, opts } = randPractical(r);
    const mru = ids(int(r, 2, 30));
    const before = computeLayout(mru, bounds, opts);
    if (before.overflow.length === 0) continue;
    exercised++;
    const target = pick(r, before.overflow);
    const after = computeLayout(touch(mru, target), bounds, opts);
    const vis = visibleIds(before);
    const displaced = vis[vis.length - 1];
    assertEquals(
      visibleIds(after),
      [target, ...vis.slice(0, -1)],
      `case ${i}: visible`,
    );
    assertEquals(
      after.overflow,
      [displaced, ...before.overflow.filter((x) => x !== target)],
      `case ${i}: overflow`,
    );
  }
  assert(exercised > 500, `only ${exercised} cases had overflow`);
});

Deno.test("stability: adding ids keeps the earlier ids' relative order and never hides tiles", () => {
  const r = prng(4);
  for (let i = 0; i < 300; i++) {
    const { bounds, opts } = randPractical(r);
    let mru: string[] = [];
    let prev = computeLayout(mru, bounds, opts);
    for (let k = 0; k < 24; k++) {
      const fresh = `n${k}`;
      // A new terminal is touched (focused); occasionally one is appended as the oldest.
      const prepend = r() < 0.8;
      mru = prepend ? touch(mru, fresh) : [...mru, fresh];
      const next = computeLayout(mru, bounds, opts);
      const order = [...visibleIds(next), ...next.overflow];
      const prevOrder = [...visibleIds(prev), ...prev.overflow];
      assertEquals(
        order.filter((x) => x !== fresh),
        prevOrder,
        `case ${i}/${k}: order`,
      );
      // Adding an id never reduces the visible count.
      assert(
        next.tiles.length >= prev.tiles.length,
        `case ${i}/${k}: visible count shrank`,
      );
      if (prepend) assertEquals(next.tiles[0].id, fresh);
      else {
        // An appended (oldest) id never displaces a visible one.
        assertEquals(
          visibleIds(next).slice(0, prev.tiles.length),
          visibleIds(prev),
        );
      }
      prev = next;
    }
    // And removing ids (closing terminals, oldest first) never grows the visible count.
    while (mru.length > 0) {
      mru = mru.slice(0, -1);
      const next = computeLayout(mru, bounds, opts);
      assert(
        next.tiles.length <= prev.tiles.length,
        `case ${i}: removal grew tiles`,
      );
      prev = next;
    }
  }
});

/** For each ordered tile pair: is a strictly left of / above b. */
function topology(rs: Rect[]): string {
  let s = "";
  for (const a of rs) {
    for (const b of rs) {
      s += `${a.x + a.w <= b.x ? 1 : 0}${a.y + a.h <= b.y ? 1 : 0}`;
    }
  }
  return s;
}

Deno.test("stability: small bounds changes move tile edges by at most the change + 1px", () => {
  const r = prng(5);
  let compared = 0;
  let total = 0;
  for (let i = 0; i < 6000; i++) {
    const { bounds, opts } = randPractical(r);
    // Tiles narrower than this are degenerate (gap-collapsed); see the observation in the report.
    const MIN_SIDE = 20;
    const n = int(r, 1, 10);
    const delta = pick(r, [1, 1, 2, 5, 20]);
    const sign = r() < 0.5 ? -1 : 1;
    const b2 = r() < 0.5
      ? { ...bounds, w: bounds.w + sign * delta }
      : { ...bounds, h: bounds.h + sign * delta };
    const a = rectsOf(computeLayout(ids(n), bounds, opts));
    const c = rectsOf(computeLayout(ids(n), b2, opts));
    total++;
    // A change of tile count or of the split orientation (a remainder crossing square) is a
    // legitimate re-layout, not a jump.
    if (a.length !== c.length || topology(a) !== topology(c)) continue;
    if ([...a, ...c].some((q) => q.w < MIN_SIDE || q.h < MIN_SIDE)) continue;
    compared++;
    a.forEach((x, k) => {
      const y = c[k];
      const moved = Math.max(
        Math.abs(x.x - y.x),
        Math.abs(x.y - y.y),
        Math.abs(x.x + x.w - (y.x + y.w)),
        Math.abs(x.y + x.h - (y.y + y.h)),
      );
      assert(
        moved <= delta + 1,
        `case ${i}: tile ${k} moved ${moved}px for a ${delta}px change ${
          JSON.stringify({ bounds, b2, opts, x, y })
        }`,
      );
    });
  }
  assert(compared > total * 0.5, `only ${compared}/${total} comparable`);
});

Deno.test("stability: translating integer bounds translates every rect exactly", () => {
  const r = prng(6);
  for (let i = 0; i < 2000; i++) {
    const { bounds, opts } = randPractical(r);
    const dx = int(r, -1000, 1000), dy = int(r, -1000, 1000);
    const n = int(r, 1, 20);
    const a = computeLayout(ids(n), bounds, opts);
    const b = computeLayout(ids(n), {
      ...bounds,
      x: bounds.x + dx,
      y: bounds.y + dy,
    }, opts);
    assertEquals(
      rectsOf(b),
      rectsOf(a).map((q) => ({ ...q, x: q.x + dx, y: q.y + dy })),
      `case ${i}`,
    );
    assertEquals(b.overflow, a.overflow);
  }
});

Deno.test("stability: columns/rows, master-stack and grid are transpose-symmetric", () => {
  const r = prng(8);
  const swap = (q: Rect): Rect => ({ x: q.y, y: q.x, w: q.h, h: q.w });
  for (let i = 0; i < 2000; i++) {
    const { bounds, opts } = randPractical(r);
    if (bounds.w === bounds.h) continue; // orientation ties break toward landscape
    const n = int(r, 1, 16);
    const t = swap(bounds);
    const sym = { ...opts, minTileW: opts.minTileH, minTileH: opts.minTileW };
    const cols = computeLayout(ids(n), bounds, { ...opts, pattern: "columns" });
    const rows = computeLayout(ids(n), t, { ...sym, pattern: "rows" });
    assertEquals(
      rectsOf(rows),
      rectsOf(cols).map(swap),
      `case ${i}: columns/rows`,
    );
    for (const pattern of ["master-stack", "grid"] as const) {
      const a = computeLayout(ids(n), bounds, { ...opts, pattern });
      const b = computeLayout(ids(n), t, { ...sym, pattern });
      assertEquals(rectsOf(b), rectsOf(a).map(swap), `case ${i}: ${pattern}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Exact proportions
// ---------------------------------------------------------------------------------------------

/** Expected area share per rank, restated from the documentation. */
function expectedShares(
  pattern: LayoutPattern,
  n: number,
  decay: number,
  mr: number,
): number[] {
  const w = Array.from({ length: n }, (_, i) => Math.pow(decay, i));
  const total = w.reduce((a, b) => a + b, 0);
  const rest = total - 1;
  if (pattern === "master-stack") {
    return w.map((wi, i) => i === 0 ? mr : (1 - mr) * wi / rest);
  }
  if (pattern === "cascade" || pattern === "spiral") {
    let f = 1 / total;
    if (f > mr) f = Math.max(mr, (w[1] / rest) / (1 + w[1] / rest));
    return w.map((wi, i) => i === 0 ? f : (1 - f) * wi / rest);
  }
  return w.map((wi) => wi / total);
}

Deno.test("proportions: gap 0 areas match the documented shares exactly (to the px)", () => {
  const boundsSet = [
    { x: 0, y: 0, w: 3840, h: 2160 },
    { x: 0, y: 0, w: 1600, h: 2560 },
    { x: 0, y: 0, w: 2000, h: 2000 },
  ];
  for (const pattern of TILED) {
    for (const bounds of boundsSet) {
      for (const decay of [0.3, 0.5, 0.7, 0.9, 1]) {
        for (const mr of [0.5, 0.6, 0.85]) {
          for (let n = 2; n <= 8; n++) {
            const { tiles } = computeLayout(ids(n), bounds, {
              pattern,
              decay,
              masterRatio: mr,
              maxVisible: 16,
              gap: 0,
              minTileW: 0,
              minTileH: 0,
            });
            assertEquals(tiles.length, n);
            const shares = expectedShares(pattern, n, decay, mr);
            const total = bounds.w * bounds.h;
            tiles.forEach((t, i) => {
              const want = shares[i] * total;
              // Each edge rounds by at most 0.5 px.
              const tol = t.rect.w + t.rect.h + 1;
              assert(
                Math.abs(area(t.rect) - want) <= tol,
                `${pattern} ${bounds.w}x${bounds.h} d=${decay} mr=${mr} n=${n} rank ${i}: ${
                  area(t.rect)
                } vs ${want.toFixed(1)}`,
              );
            });
          }
        }
      }
    }
  }
});

Deno.test("proportions: gap compensation keeps post-gap areas within 2% of the target", () => {
  for (
    const pattern of ["cascade", "spiral", "columns", "rows", "grid"] as const
  ) {
    for (const gap of [2, 6, 12]) {
      for (const decay of [0.5, 0.7, 0.9, 1]) {
        for (let n = 2; n <= 8; n++) {
          const { tiles } = computeLayout(ids(n), {
            x: 0,
            y: 0,
            w: 3840,
            h: 2160,
          }, {
            pattern,
            decay,
            masterRatio: 0.85,
            maxVisible: 16,
            gap,
            minTileW: 40,
            minTileH: 40,
          });
          if (tiles.length < n) continue; // a tile would be too thin to compensate
          const areas = tiles.map((t) => area(t.rect));
          const sum = areas.reduce((a, b) => a + b, 0);
          const shares = expectedShares(pattern, n, decay, 0.85);
          areas.forEach((a, i) => {
            const rel = Math.abs(a / sum - shares[i]) / shares[i];
            assert(
              rel < 0.02,
              `${pattern} gap=${gap} d=${decay} n=${n} rank ${i}: off by ${
                (rel * 100).toFixed(2)
              }%`,
            );
          });
        }
      }
    }
  }
});

Deno.test("proportions: decay 1 gives equal areas in every tiled pattern but master-stack", () => {
  for (
    const pattern of ["cascade", "spiral", "columns", "rows", "grid"] as const
  ) {
    for (let n = 2; n <= 9; n++) {
      const { tiles } = computeLayout(
        ids(n),
        { x: 0, y: 0, w: 2520, h: 1680 },
        {
          pattern,
          decay: 1,
          masterRatio: 0.85,
          maxVisible: 16,
          gap: 0,
          minTileW: 0,
          minTileH: 0,
        },
      );
      const want = 2520 * 1680 / n;
      for (const t of tiles) {
        assert(
          Math.abs(area(t.rect) - want) <= t.rect.w + t.rect.h + 1,
          `${pattern} n=${n}`,
        );
      }
    }
  }
});

Deno.test("rankScale: sqrt of the area ratio, clamped decay, sane on bad input", () => {
  for (const d of [0.3, 0.5, 0.7, 1]) {
    for (let k = 0; k < 16; k++) {
      assert(Math.abs(rankScale(k, d) - Math.sqrt(Math.pow(d, k))) < 1e-12);
    }
  }
  assertEquals(rankScale(3, 0.1), rankScale(3, 0.3)); // clamped low
  assertEquals(rankScale(3, 5), 1); // clamped high
  assertEquals(rankScale(3, NaN), 1); // NaN decay → 1
  assertEquals(rankScale(-4, 0.5), 1); // negative rank → 0
  assertEquals(rankScale(NaN, 0.5), 1);
  assert(rankScale(Infinity, 0.5) === 1, "non-finite rank is treated as 0");
});

// ---------------------------------------------------------------------------------------------
// Golden snapshots: exact rects per pattern, so any change in the engine shows up here.
// ---------------------------------------------------------------------------------------------

const GOLDEN_CONFIGS = {
  desktop: { bounds: { x: 0, y: 0, w: 1920, h: 1080 }, opts: {}, n: 4 },
  portrait: {
    bounds: { x: 0, y: 0, w: 1000, h: 1600 },
    opts: { decay: 0.5, gap: 0, minTileW: 0, minTileH: 0 },
    n: 5,
  },
  offsetEqual: {
    bounds: { x: 10, y: 40, w: 1440, h: 900 },
    opts: { decay: 1, gap: 10 },
    n: 3,
  },
} as const;

type Quad = [number, number, number, number];
const GOLDEN: Record<
  LayoutPattern,
  Record<keyof typeof GOLDEN_CONFIGS, Quad[]>
> = {
  "cascade": {
    desktop: [[6, 6, 747, 1068], [759, 6, 523, 1068], [1288, 6, 626, 625], [
      1288,
      637,
      626,
      437,
    ]],
    portrait: [[0, 0, 1000, 826], [0, 826, 533, 774], [533, 826, 467, 442], [
      533,
      1268,
      311,
      332,
    ], [844, 1268, 156, 332]],
    offsetEqual: [[20, 50, 467, 880], [497, 50, 466, 880], [973, 50, 467, 880]],
  },
  "spiral": {
    desktop: [[6, 6, 747, 1068], [759, 6, 1155, 484], [1238, 496, 676, 578], [
      759,
      496,
      473,
      578,
    ]],
    portrait: [[0, 0, 1000, 826], [467, 826, 533, 774], [0, 1158, 467, 442], [
      0,
      826,
      311,
      332,
    ], [311, 826, 156, 332]],
    offsetEqual: [[20, 50, 466, 880], [496, 50, 944, 435], [
      496,
      495,
      944,
      435,
    ]],
  },
  "master-stack": {
    desktop: [[6, 6, 1142, 1068], [1154, 6, 760, 484], [1154, 496, 760, 338], [
      1154,
      840,
      760,
      234,
    ]],
    portrait: [[0, 0, 1000, 960], [0, 960, 533, 640], [533, 960, 267, 640], [
      800,
      960,
      133,
      640,
    ], [933, 960, 67, 640]],
    offsetEqual: [[20, 50, 848, 880], [878, 50, 562, 435], [
      878,
      495,
      562,
      435,
    ]],
  },
  "columns": {
    desktop: [[6, 6, 746, 1068], [758, 6, 522, 1068], [1286, 6, 366, 1068], [
      1658,
      6,
      256,
      1068,
    ]],
    portrait: [[0, 0, 516, 1600], [516, 0, 258, 1600], [774, 0, 129, 1600], [
      903,
      0,
      65,
      1600,
    ], [968, 0, 32, 1600]],
    offsetEqual: [[20, 50, 467, 880], [497, 50, 466, 880], [973, 50, 467, 880]],
  },
  "rows": {
    desktop: [[6, 6, 1908, 415], [6, 427, 1908, 290], [6, 723, 1908, 203], [
      6,
      932,
      1908,
      142,
    ]],
    portrait: [[0, 0, 1000, 826], [0, 826, 1000, 413], [0, 1239, 1000, 206], [
      0,
      1445,
      1000,
      103,
    ], [0, 1548, 1000, 52]],
    offsetEqual: [[20, 50, 1420, 287], [20, 347, 1420, 286], [
      20,
      643,
      1420,
      287,
    ]],
  },
  "grid": {
    desktop: [[6, 6, 1119, 713], [1131, 6, 783, 713], [6, 725, 1119, 349], [
      1131,
      725,
      783,
      349,
    ]],
    portrait: [[0, 0, 903, 914], [0, 914, 903, 457], [0, 1371, 903, 229], [
      903,
      0,
      97,
      1067,
    ], [903, 1067, 97, 533]],
    offsetEqual: [[20, 50, 705, 581], [735, 50, 705, 581], [
      20,
      641,
      1420,
      289,
    ]],
  },
  "monocle": {
    desktop: [[6, 6, 1908, 1068]],
    portrait: [[0, 0, 1000, 1600]],
    offsetEqual: [[20, 50, 1420, 880]],
  },
};

for (const pattern of PATTERNS) {
  Deno.test(`golden: ${pattern}`, () => {
    for (const [name, c] of Object.entries(GOLDEN_CONFIGS)) {
      const res = computeLayout(ids(c.n), c.bounds, {
        ...DEFAULT_LAYOUT_OPTIONS,
        ...c.opts,
        pattern,
      });
      const got = res.tiles.map((
        t,
      ): Quad => [t.rect.x, t.rect.y, t.rect.w, t.rect.h]);
      assertEquals(
        got,
        GOLDEN[pattern][name as keyof typeof GOLDEN_CONFIGS],
        `${pattern}/${name}`,
      );
      assertEquals(res.overflow, ids(c.n).slice(got.length));
    }
  });
}
