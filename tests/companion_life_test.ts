// Loopy's idle life (lib/companion/loopy-life.ts): when Loopy may live on its own, the
// micro-expression scheduler, the pupils' offsets toward the pointer, and the excitement rules.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { renderToString } from "denext";
import { jsx } from "denext/jsx-runtime";
import { Loopy } from "../app/companion/loopy.tsx";
import {
  easeToward,
  EXCITE_COOLDOWN_MS,
  EXCITE_DWELL_MS,
  EYE_CENTRES,
  following,
  GAZE_HOLD_MS,
  GAZE_REACH,
  gazeOffset,
  INITIAL_EXCITE,
  type LifeContext,
  mayLiven,
  MICRO_DELAY_MS,
  MICRO_EXPRESSIONS,
  type MicroExpression,
  near,
  NEUTRAL_PUPILS,
  nextMicro,
  overFace,
  type Point,
  type Sample,
  type Target,
  trackExcitement,
} from "../lib/companion/loopy-life.ts";
import type { LoopyState } from "../lib/companion/loopy-machine.ts";

/** A seeded random in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FREE: LifeContext = {
  lively: true,
  state: "idle",
  message: false,
  voice: false,
  busy: false,
  awake: true,
};

Deno.test("life: Loopy lives on its own only when Lively, awake and idle with nothing to say, no voice, no thinking", () => {
  assert(mayLiven(FREE));
  assert(mayLiven({ ...FREE, state: "blink" }));
  for (
    const state of [
      "hidden",
      "appear",
      "think",
      "point",
      "celebrate",
      "dismiss",
    ] as LoopyState[]
  ) {
    assert(!mayLiven({ ...FREE, state }), state);
  }
  assert(!mayLiven({ ...FREE, lively: false }), "Lively off");
  assert(!mayLiven({ ...FREE, awake: false }), "the window hidden");
  assert(!mayLiven({ ...FREE, message: true }), "a message on screen");
  assert(!mayLiven({ ...FREE, voice: true }), "a voice turn");
  assert(!mayLiven({ ...FREE, busy: true }), "the brain thinking");
});

Deno.test("life: micro-expressions never repeat, keep to their timing, and only blink and glance with reduced motion", () => {
  const random = seeded(7);
  const seen = new Set<MicroExpression>();
  let prev: MicroExpression | null = null;
  for (let i = 0; i < 500; i++) {
    const step = nextMicro(prev, false, random);
    assert(step.expression !== prev, `no repeat at ${i}`);
    const [lo, hi] = MICRO_EXPRESSIONS[step.expression].ms;
    assert(step.durationMs >= lo && step.durationMs <= hi, "its length");
    assert(step.durationMs >= 600 && step.durationMs <= 2_000, "0.6–2 s");
    assert(
      step.delayMs >= MICRO_DELAY_MS[0] && step.delayMs <= MICRO_DELAY_MS[1],
      "4–12 s apart",
    );
    seen.add(step.expression);
    prev = step.expression;
  }
  assertEquals(seen.size, Object.keys(MICRO_EXPRESSIONS).length, "all of them");
  assertEquals(MICRO_DELAY_MS, [4_000, 12_000]);

  const calm = new Set<MicroExpression>();
  prev = null;
  for (let i = 0; i < 200; i++) {
    const step = nextMicro(prev, true, random);
    assert(step.expression !== prev);
    calm.add(step.expression);
    prev = step.expression;
  }
  assertEquals(
    [...calm].sort(),
    ["double-blink", "glance-left", "glance-right"],
    "reduced motion: no tilts, smiles or brow moves",
  );

  // The edges of the random range stay in bounds.
  const low = nextMicro(null, false, () => 0);
  assertEquals(low.delayMs, 4_000);
  const high = nextMicro("hm", false, () => 0.999999);
  assert(high.expression !== "hm" && high.delayMs <= 12_000);
});

/** Whether a pupil at `base + offset` (from its eye's centre) is inside the gaze's reach. */
function inside(base: Point, offset: Point): boolean {
  const x = (base.x + offset.x) / GAZE_REACH.x;
  const y = (base.y + offset.y) / GAZE_REACH.y;
  return x * x + y * y <= 1 + 1e-9;
}

Deno.test("life: the pupils move toward the pointer, clamped inside the eye white, less when it is close", () => {
  const eye = { x: 500, y: 300 };
  const base = NEUTRAL_PUPILS[0];
  const unit = 1.5;
  const left = gazeOffset(eye, base, { x: 100, y: 300 }, unit);
  const right = gazeOffset(eye, base, { x: 900, y: 300 }, unit);
  assert(base.x + left.x < 0, "looks left");
  assert(base.x + right.x > 0, "looks right");
  assertAlmostEquals(base.x + left.x, -GAZE_REACH.x, 1e-9);
  assertAlmostEquals(base.y + left.y, 0, 1e-9, "level with the eye");
  const up = gazeOffset(eye, base, { x: 500, y: -400 }, unit);
  assertAlmostEquals(base.y + up.y, -GAZE_REACH.y, 1e-9);

  // Every direction and distance stays inside the eye white.
  for (let a = 0; a < 360; a += 7) {
    for (const d of [3, 20, 60, 400, 5_000]) {
      const r = (a * Math.PI) / 180;
      const p = { x: eye.x + d * Math.cos(r), y: eye.y + d * Math.sin(r) };
      for (const b of NEUTRAL_PUPILS) {
        assert(inside(b, gazeOffset(eye, b, p, unit)), `${a}° at ${d}px`);
      }
    }
  }
  // A pointer close by: the pupil goes less far; on the eye itself: centred.
  const close = gazeOffset(eye, base, { x: 480, y: 300 }, unit);
  assert(base.x + close.x > -GAZE_REACH.x && base.x + close.x < 0);
  assertEquals(gazeOffset(eye, base, eye, unit), { x: -base.x, y: -base.y });
  // The two eyes converge on a pointer between them.
  const [l, r] = NEUTRAL_PUPILS;
  const mid = { x: 520, y: 400 };
  assert(gazeOffset({ x: 500, y: 300 }, l, mid, unit).x + l.x > 0);
  assert(gazeOffset({ x: 540, y: 300 }, r, mid, unit).x + r.x < 0);
});

Deno.test("life: the gaze eases smoothly whatever the frame rate, and stops following after the pointer rests", () => {
  const goal = { x: 3, y: -2 };
  let p = { x: 0, y: 0 };
  let last = 0;
  for (let i = 0; i < 60; i++) {
    p = easeToward(p, goal, 16);
    assert(p.x > last && p.x <= goal.x, "monotonic, no overshoot");
    last = p.x;
  }
  assert(near(p, goal), "there in a second");
  // One 32 ms step is two 16 ms steps.
  const two = easeToward(easeToward({ x: 0, y: 0 }, goal, 16), goal, 16);
  const one = easeToward({ x: 0, y: 0 }, goal, 32);
  assertAlmostEquals(two.x, one.x, 1e-9);
  assertEquals(easeToward(p, goal, -5), p, "no step back in time");

  assert(!following(null, 1_000));
  assert(following(1_000, 1_000 + GAZE_HOLD_MS - 1));
  assert(!following(1_000, 1_000 + GAZE_HOLD_MS));
  assertEquals(GAZE_HOLD_MS, 1_500);
});

const LOOPY: Target = { cx: 1000, cy: 700, size: 100 };

/** Feed `samples` through the rules; the times at which Loopy got excited. */
function run(
  samples: Sample[],
  free: (s: Sample) => boolean = () => true,
): number[] {
  let tr = INITIAL_EXCITE;
  const fired: number[] = [];
  for (const s of samples) {
    const step = trackExcitement(tr, s, LOOPY, free(s));
    tr = step.tracker;
    if (step.fire) fired.push(s.t);
  }
  return fired;
}

/** A slow line of samples from `a` to `b` (a sample every 16 ms, `ms` long), from time `t0`. */
function path(a: Point, b: Point, t0: number, ms: number): Sample[] {
  const n = Math.max(1, Math.round(ms / 16));
  return Array.from({ length: n + 1 }, (_, i) => ({
    x: a.x + ((b.x - a.x) * i) / n,
    y: a.y + ((b.y - a.y) * i) / n,
    t: t0 + (ms * i) / n,
  }));
}

Deno.test("life: moving near Loopy excites it once; then not again within the cooldown, and only after leaving", () => {
  const far = { x: 200, y: 700 };
  const close = { x: 900, y: 700 }; // 100 px from the centre: near (1.5 × 100)
  const closer = { x: 960, y: 690 };
  // A slow approach, a while near.
  const visit = [
    ...path(far, close, 0, 2_000),
    ...path(close, closer, 2_000, 400),
  ];
  const fired = run(visit);
  assertEquals(fired.length, 1, "once");
  const first = fired[0];
  const entered = visit.find((s) => Math.hypot(s.x - 1000, s.y - 700) <= 150)!;
  assert(first - entered.t >= EXCITE_DWELL_MS, "after moving near a moment");

  // Staying near and moving about: no more.
  const stay = [...visit, ...path(closer, close, 2_400, 3_000)];
  assertEquals(run(stay), [first]);
  // Away and back within the cooldown: no; after it: yes.
  const soon = [
    ...stay,
    ...path(close, far, 5_400, 2_000),
    ...path(far, close, 7_400, 2_000),
    ...path(close, closer, 9_400, 400),
  ];
  assertEquals(run(soon), [first]);
  const later = [
    ...soon,
    ...path(closer, far, 9_800, 2_000),
    ...path(far, close, first + EXCITE_COOLDOWN_MS, 2_000),
    ...path(close, closer, first + EXCITE_COOLDOWN_MS + 2_000, 400),
  ];
  const twice = run(later);
  assertEquals(twice.length, 2);
  assert(twice[1] - twice[0] >= EXCITE_COOLDOWN_MS);
  assertEquals(EXCITE_COOLDOWN_MS, 20_000);
});

Deno.test("life: excitement never comes while Loopy is busy, nor from a fly-through or from far away", () => {
  const visit = [
    ...path({ x: 200, y: 700 }, { x: 900, y: 700 }, 0, 2_000),
    ...path({ x: 900, y: 700 }, { x: 960, y: 690 }, 2_000, 400),
  ];
  assertEquals(run(visit, () => false), [], "not while busy");
  // Busy while near, free once the pointer has left and stays away: nothing.
  assertEquals(
    run([
      ...visit,
      ...path({ x: 960, y: 690 }, { x: 200, y: 200 }, 2_400, 3_000),
    ], (s) => s.t >= 2_400 && Math.hypot(s.x - 1000, s.y - 700) > 400),
    [],
  );
  // Slow and far: never.
  assertEquals(run(path({ x: 0, y: 0 }, { x: 400, y: 100 }, 0, 5_000)), []);
  // One sample near, then gone (slowly): not a visit.
  assertEquals(
    run([
      { x: 600, y: 700, t: 0 },
      { x: 900, y: 700, t: 400 },
      { x: 600, y: 700, t: 800 },
    ]),
    [],
  );
});

Deno.test("life: a fast move close by, or a circle around Loopy, excites it", () => {
  // Fast past it, 250 px away (within 3 × its size), 4 px/ms.
  const fast = path({ x: 600, y: 950 }, { x: 1400, y: 950 }, 0, 200);
  assertEquals(run(fast).length, 1, "fast");
  // The same, but slowly: no.
  assertEquals(
    run(path({ x: 600, y: 950 }, { x: 1400, y: 950 }, 0, 3_000)),
    [],
  );
  // A slow circle at 220 px (outside "near"), once around in 2 s.
  const circle: Sample[] = Array.from({ length: 130 }, (_, i) => {
    const a = (i / 125) * 2 * Math.PI;
    return {
      x: 1000 + 220 * Math.cos(a),
      y: 700 + 220 * Math.sin(a),
      t: i * 16,
    };
  });
  const fired = run(circle);
  assertEquals(fired.length, 1, "circling");
  assert(fired[0] > 1_800, "once all the way around");
});

Deno.test("life: hovering over the face; the eyes' geometry is the neutral face's; lively attributes stay off the face", async () => {
  assert(overFace({ x: 1000, y: 700 }, LOOPY));
  assert(overFace({ x: 1035, y: 700 }, LOOPY));
  assert(!overFace({ x: 1060, y: 700 }, LOOPY));

  const html = await renderToString(
    jsx(Loopy as never, { state: "idle" }) as never,
  );
  const circles = [
    ...html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="3.6"/g),
  ]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  assertEquals(circles, [
    {
      x: EYE_CENTRES[0].x + NEUTRAL_PUPILS[0].x,
      y: EYE_CENTRES[0].y + NEUTRAL_PUPILS[0].y,
    },
    {
      x: EYE_CENTRES[1].x + NEUTRAL_PUPILS[1].x,
      y: EYE_CENTRES[1].y + NEUTRAL_PUPILS[1].y,
    },
  ]);

  const head = (s: string) => s.slice(s.indexOf('<g class="loopy-head">'));
  const lively = await renderToString(
    jsx(Loopy as never, {
      state: "idle",
      lively: true,
      expression: "tilt",
    }) as never,
  );
  assertEquals(head(lively), head(html), "the face itself unchanged");
  assert(/<svg[^>]* data-lively=""/.test(lively));
  assert(/<svg[^>]* data-expr="tilt"/.test(lively));
  assert(!/data-lively|data-expr/.test(html), "off: today's avatar");
});
