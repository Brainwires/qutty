/**
 * Loopy's idle life ("Lively", Settings → Companion): the logic of the small things Loopy does
 * on its own while it has nothing to say, kept pure so it is unit-tested; app/companion/
 * use-loopy-life.ts is the thin DOM side (timers, the window's `pointermove`, one rAF loop).
 *
 * - Micro-expressions: now and then (every 4–12 s, never the same twice in a row) a variation of
 *   the neutral face for 0.6–2 s: a glance aside, a look up, a brow raise, a small smile, a head
 *   tilt, a double blink, a soft "hm". They are transforms on the face's parts (public/styles.css,
 *   keyed off `data-expr`), so the face's shapes stay the example's.
 * - The eyes follow the pointer: each pupil moves from its eye's centre toward the pointer,
 *   clamped inside the eye white and eased, and drifts back once the pointer has rested a while.
 * - Excitement: the pointer moving near Loopy, fast around it, or circling it, brings the
 *   `excited` face for a moment, at most once every 20 s, and only while Loopy is idle.
 *
 * None of it ever replaces a mood Loopy shows for a reason (a question, a reply, thinking, a voice
 * turn): {@linkcode mayLiven} says when Loopy is free.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { LoopyState } from "./loopy-machine.ts";

// --- when -----------------------------------------------------------------------------------

/** What decides whether Loopy may live on its own right now. */
export interface LifeContext {
  /** Settings → Companion → Lively. */
  readonly lively: boolean;
  /** Loopy's move. */
  readonly state: LoopyState;
  /** A message (question, reply, `say`) is on screen. */
  readonly message: boolean;
  /** A voice turn is on (listening, transcribing, speaking). */
  readonly voice: boolean;
  /** The companion's brain is working (Loopy thinks). */
  readonly busy: boolean;
  /** The window is shown and has not been in the background long ({@linkcode BLUR_SLEEP_MS}). */
  readonly awake: boolean;
}

/**
 * Whether Loopy is free for its idle life: Lively on, the window awake, standing idle (or in the
 * middle of a blink) with nothing on screen, no voice turn and no thinking.
 */
export function mayLiven(ctx: LifeContext): boolean {
  return ctx.lively && ctx.awake && !ctx.message && !ctx.voice && !ctx.busy &&
    (ctx.state === "idle" || ctx.state === "blink");
}

/** How long the window may be in the background (blurred) before Loopy's idle life stops. */
export const BLUR_SLEEP_MS = 30_000;

// --- micro-expressions ----------------------------------------------------------------------

/** A small variation of the neutral face (`data-expr` on the avatar). */
export type MicroExpression =
  | "glance-left"
  | "glance-right"
  | "look-up"
  | "brow-raise"
  | "smile"
  | "tilt"
  | "double-blink"
  | "hm";

/** How long a micro-expression lasts, and whether it plays with reduced motion. */
interface MicroSpec {
  /** Its length, [shortest, longest] in ms. */
  readonly ms: readonly [number, number];
  /** Plays with reduced motion: only the blink and the glances (which then jump, not slide). */
  readonly reducedMotion: boolean;
}

/** Every micro-expression, with its timing. */
export const MICRO_EXPRESSIONS: Readonly<Record<MicroExpression, MicroSpec>> = {
  "glance-left": { ms: [700, 1400], reducedMotion: true },
  "glance-right": { ms: [700, 1400], reducedMotion: true },
  "look-up": { ms: [1000, 2000], reducedMotion: false },
  "brow-raise": { ms: [900, 1800], reducedMotion: false },
  "smile": { ms: [1000, 2000], reducedMotion: false },
  "tilt": { ms: [1000, 2000], reducedMotion: false },
  "double-blink": { ms: [600, 600], reducedMotion: true },
  "hm": { ms: [800, 1600], reducedMotion: false },
};

/** The quiet between two micro-expressions, [shortest, longest] in ms. */
export const MICRO_DELAY_MS = [4_000, 12_000] as const;

/** The next micro-expression: which, after how long, and for how long. */
export interface MicroStep {
  readonly expression: MicroExpression;
  readonly delayMs: number;
  readonly durationMs: number;
}

const within = (
  [lo, hi]: readonly [number, number],
  r: number,
) => lo + (hi - lo) * Math.min(Math.max(r, 0), 1);

/**
 * The next micro-expression after `prev` (never `prev` again), from the ones that play with
 * `reducedMotion`.
 *
 * @param random A number in [0, 1) per call (`Math.random` by default): three are drawn.
 */
export function nextMicro(
  prev: MicroExpression | null,
  reducedMotion: boolean,
  random: () => number = Math.random,
): MicroStep {
  const all = Object.keys(MICRO_EXPRESSIONS) as MicroExpression[];
  const pool = all.filter((e) =>
    e !== prev && (!reducedMotion || MICRO_EXPRESSIONS[e].reducedMotion)
  );
  const pick =
    pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return {
    expression: pick,
    delayMs: within(MICRO_DELAY_MS, random()),
    durationMs: within(MICRO_EXPRESSIONS[pick].ms, random()),
  };
}

// --- the eyes follow the pointer ------------------------------------------------------------

/** A point or an offset. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** The origin: pupils where the face draws them. */
export const ZERO: Point = { x: 0, y: 0 };

/** The eyes in the drawing (app/companion/loopy.tsx): their centres. */
export const EYE_CENTRES: readonly [Point, Point] = [
  { x: 70, y: 72 },
  { x: 90, y: 72 },
];

/** Where the neutral face draws each pupil, from its eye's centre (drawing units). */
export const NEUTRAL_PUPILS: readonly [Point, Point] = [
  { x: 1.8, y: 1.8 },
  { x: -1.8, y: 1.8 },
];

/**
 * How far a pupil's centre may go from its eye's centre, across and up/down (drawing units): the
 * eye white's radii (7.2 x 8.8) less the pupil's (3.6) and a little margin, so it stays inside.
 */
export const GAZE_REACH: Point = { x: 3.2, y: 4.8 };

/** How far the pointer must be (drawing units) for the pupil to go all the way to the edge. */
const GAZE_FULL_AT = 40;

/** How long the eyes keep following once the pointer stops, ms. */
export const GAZE_HOLD_MS = 1_500;

/** The easing's time constant, ms: about two thirds of the way there in this long. */
const GAZE_TAU_MS = 90;

/**
 * The pupil's move (an offset from where the neutral face draws it, drawing units) to look from
 * `eye` toward `pointer`, both in screen px: along the direction to the pointer, out to the edge
 * of the eye white's reach (less when the pointer is close, so the eyes converge on it).
 *
 * @param base Where the face draws this pupil (from the eye's centre, drawing units).
 * @param pxPerUnit Screen px per drawing unit.
 */
export function gazeOffset(
  eye: Point,
  base: Point,
  pointer: Point,
  pxPerUnit: number,
): Point {
  const dx = pointer.x - eye.x;
  const dy = pointer.y - eye.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6 || !(pxPerUnit > 0)) return { x: -base.x, y: -base.y };
  const ux = dx / dist;
  const uy = dy / dist;
  // The reach ellipse's radius along (ux, uy).
  const edge = 1 /
    Math.hypot(ux / GAZE_REACH.x, uy / GAZE_REACH.y);
  const k = Math.min(1, dist / (GAZE_FULL_AT * pxPerUnit));
  return { x: ux * edge * k - base.x, y: uy * edge * k - base.y };
}

/** Whether the eyes still follow the pointer, last moved at `movedAt` (ms; `null`: never). */
export function following(movedAt: number | null, now: number): boolean {
  return movedAt !== null && now - movedAt < GAZE_HOLD_MS;
}

/** `current` eased toward `target` over `dtMs` (exponential: smooth at any frame rate). */
export function easeToward(
  current: Point,
  target: Point,
  dtMs: number,
  tauMs: number = GAZE_TAU_MS,
): Point {
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return {
    x: current.x + (target.x - current.x) * a,
    y: current.y + (target.y - current.y) * a,
  };
}

/** Whether `a` is as good as `b` (within `eps` drawing units). */
export function near(a: Point, b: Point, eps = 0.02): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

// --- excitement -----------------------------------------------------------------------------

/** Loopy on screen: its centre and size (the avatar's larger side), px. */
export interface Target {
  readonly cx: number;
  readonly cy: number;
  readonly size: number;
}

/** A pointer position at a time (ms). */
export interface Sample extends Point {
  readonly t: number;
}

/** "Near" Loopy: within this many times its size of its centre. */
const EXCITE_NEAR = 1.5;
/** The pointer must move near Loopy this long (ms) to count (a fly-through does not). */
export const EXCITE_DWELL_MS = 150;
/** Fast or circling counts within this many times Loopy's size of its centre. */
const EXCITE_RING = 3;
/** "Fast": px per ms. */
const EXCITE_FAST = 2.5;
/** One full turn around Loopy within this long (ms) is circling it. */
const EXCITE_CIRCLE_MS = 3_000;
/** At most one excitement this often, ms. */
export const EXCITE_COOLDOWN_MS = 20_000;
/** How long the excited face stays, ms. */
export const EXCITE_MS = 1_600;
/** The face counts as hovered within this fraction of Loopy's size of its centre. */
const HOVER_RADIUS = 0.4;

/** What the excitement rules remember of the pointer. */
export interface ExciteTracker {
  readonly last: Sample | null;
  /** When the pointer came near (and has stayed near since), or `null`. */
  readonly nearSince: number | null;
  /** Whether coming near may excite (again): set once the pointer has been away. */
  readonly armed: boolean;
  /** The angle swept around Loopy (radians, signed) since `sweepFrom`. */
  readonly sweep: number;
  readonly sweepFrom: number;
  /** The last excitement, or `null`. */
  readonly firedAt: number | null;
}

export const INITIAL_EXCITE: ExciteTracker = {
  last: null,
  nearSince: null,
  armed: true,
  sweep: 0,
  sweepFrom: 0,
  firedAt: null,
};

/** An angle difference brought into (-π, π]. */
function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** The angle swept around Loopy so far, with the pointer now at `s` (still within the ring). */
function swept(
  tr: ExciteTracker,
  s: Sample,
  loopy: Target,
): Pick<ExciteTracker, "sweep" | "sweepFrom"> {
  const last = tr.last;
  if (!last || s.t - tr.sweepFrom > EXCITE_CIRCLE_MS) {
    return { sweep: 0, sweepFrom: s.t };
  }
  const a0 = Math.atan2(last.y - loopy.cy, last.x - loopy.cx);
  const a1 = Math.atan2(s.y - loopy.cy, s.x - loopy.cx);
  return { sweep: tr.sweep + wrap(a1 - a0), sweepFrom: tr.sweepFrom };
}

/**
 * The pointer moved to `s`: the rules' new memory, and whether Loopy gets excited now. It does
 * when it may (`free`, see {@linkcode mayLiven}), has not been in the last
 * {@linkcode EXCITE_COOLDOWN_MS}, and the pointer has moved near it for
 * {@linkcode EXCITE_DWELL_MS} (once per visit), moved fast close by, or gone once around it.
 */
export function trackExcitement(
  tr: ExciteTracker,
  s: Sample,
  loopy: Target,
  free: boolean,
): { tracker: ExciteTracker; fire: boolean } {
  const dist = Math.hypot(s.x - loopy.cx, s.y - loopy.cy);
  const isNear = dist <= EXCITE_NEAR * loopy.size;
  const inRing = dist <= EXCITE_RING * loopy.size;
  const dt = tr.last ? s.t - tr.last.t : 0;
  const speed = tr.last && dt > 0
    ? Math.hypot(s.x - tr.last.x, s.y - tr.last.y) / dt
    : 0;
  const nearSince = isNear ? tr.nearSince ?? s.t : null;
  const sweep = inRing ? swept(tr, s, loopy) : { sweep: 0, sweepFrom: s.t };
  const next: ExciteTracker = {
    ...tr,
    ...sweep,
    last: s,
    nearSince,
    armed: isNear ? tr.armed : true,
  };
  const cooling = tr.firedAt !== null && s.t - tr.firedAt < EXCITE_COOLDOWN_MS;
  const visit = isNear && next.armed && nearSince !== null &&
    s.t - nearSince >= EXCITE_DWELL_MS;
  const fast = inRing && speed >= EXCITE_FAST;
  const circled = Math.abs(next.sweep) >= 2 * Math.PI;
  if (!free || cooling || !(visit || fast || circled)) {
    return { tracker: next, fire: false };
  }
  return {
    tracker: {
      ...next,
      firedAt: s.t,
      armed: !isNear,
      sweep: 0,
      sweepFrom: s.t,
    },
    fire: true,
  };
}

/** Whether the pointer at `p` is over Loopy's face. */
export function overFace(p: Point, loopy: Target): boolean {
  return Math.hypot(p.x - loopy.cx, p.y - loopy.cy) <=
    HOVER_RADIUS * loopy.size;
}
