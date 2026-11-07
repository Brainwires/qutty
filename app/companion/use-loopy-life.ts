// Loopy's idle life in the window (Settings → Companion → Lively), the DOM side of
// lib/companion/loopy-life.ts, which holds every rule: micro-expressions now and then while Loopy
// is free, the pupils following the pointer, and a burst of excitement when the pointer comes
// near. Kept thin:
//
// - one passive `pointermove` listener on the window (so it works over the terminals too), which
//   only stores the position and asks for an animation frame;
// - one rAF loop that reads the avatar's box, works out the pupils' offsets and eases them, and
//   writes them as custom properties on the avatar's holder (`--loopy-gaze-lx/ly/rx/ry`, drawing
//   units; public/styles.css turns them into transforms on the pupils). It runs while the pointer
//   moves and until the eyes have drifted back, then stops;
// - a timer chain for the micro-expressions, and the excitement's timer, all cleared on unmount.
//
// The window hidden, or in the background for a while (BLUR_SLEEP_MS), puts it all to sleep. While
// Loopy is dragged (app/companion/use-loopy-drag.ts) it is not free (`mayLiven`): the pointer on
// its face brings no delight and no excitement, and the eyes just keep looking at the pointer.

import { useEffect, useRef, useState } from "denext";
import type { Dispatch } from "denext";
import type { CompanionEvent } from "../../lib/companion/companion-state.ts";
import {
  BLUR_SLEEP_MS,
  easeToward,
  EXCITE_MS,
  EYE_CENTRES,
  following,
  gazeOffset,
  INITIAL_EXCITE,
  type LifeContext,
  mayLiven,
  type MicroExpression,
  near,
  NEUTRAL_PUPILS,
  nextMicro,
  overFace,
  type Point,
  type Sample,
  type Target,
  trackExcitement,
  ZERO,
} from "../../lib/companion/loopy-life.ts";
import { LOOPY_VIEWBOX } from "./loopy.tsx";

export interface LoopyLifeOptions extends Omit<LifeContext, "awake"> {
  /** The element holding Loopy's SVG: the gaze offsets are set on it. */
  readonly stage: { readonly current: HTMLElement | null };
  readonly reducedMotion: boolean;
  /** For the excited hop (Loopy's `celebrate`), left out with reduced motion. */
  readonly dispatch: Dispatch<CompanionEvent>;
}

/** What Loopy's idle life shows: a micro-expression (or delight) and, briefly, excitement. */
export interface LoopyLife {
  readonly expression: MicroExpression | "delighted" | undefined;
  readonly excited: boolean;
}

const GAZE_VARS = [
  "--loopy-gaze-lx",
  "--loopy-gaze-ly",
  "--loopy-gaze-rx",
  "--loopy-gaze-ry",
] as const;

const [VB_X, VB_Y, VB_W] = LOOPY_VIEWBOX;

/** Whether the window is shown and has not sat in the background for long. */
function useAwake(enabled: boolean): boolean {
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      clearTimeout(timer);
      setAwake(document.visibilityState !== "hidden");
    };
    const blur = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setAwake(false), BLUR_SLEEP_MS);
    };
    wake();
    document.addEventListener("visibilitychange", wake);
    globalThis.addEventListener("focus", wake);
    globalThis.addEventListener("blur", blur);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      globalThis.removeEventListener("focus", wake);
      globalThis.removeEventListener("blur", blur);
    };
  }, [enabled]);
  return awake;
}

/** A micro-expression now and then while `active`; none otherwise. */
function useMicroExpressions(
  active: boolean,
  reducedMotion: boolean,
): MicroExpression | undefined {
  const [expression, setExpression] = useState<MicroExpression | undefined>();
  const last = useRef<MicroExpression | null>(null);
  useEffect(() => {
    setExpression(undefined);
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const step = nextMicro(last.current, reducedMotion);
      timer = setTimeout(() => {
        last.current = step.expression;
        setExpression(step.expression);
        timer = setTimeout(() => {
          setExpression(undefined);
          schedule();
        }, step.durationMs);
      }, step.delayMs);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [active, reducedMotion]);
  return expression;
}

/** Loopy's box on screen: its bead's centre and size, and the eyes' centres, in px. */
function measure(svg: Element) {
  const box = svg.getBoundingClientRect();
  const unit = box.width / VB_W;
  const at = (p: Point): Point => ({
    x: box.left + (p.x - VB_X) * unit,
    y: box.top + (p.y - VB_Y) * unit,
  });
  const bead = at({ x: 80, y: 76 });
  const target: Target = {
    cx: bead.x,
    cy: bead.y,
    size: Math.max(box.width, box.height),
  };
  return { unit, target, eyes: EYE_CENTRES.map(at) as [Point, Point] };
}

/** Loopy's idle life; see the module comment. */
export function useLoopyLife(opts: LoopyLifeOptions): LoopyLife {
  const { lively, reducedMotion } = opts;
  const awake = useAwake(lively);
  const free = mayLiven({ ...opts, awake });
  const [excited, setExcited] = useState(false);
  const [hover, setHover] = useState(false);
  // The eyes are on the pointer: no micro-expression then (a glance would fight the gaze).
  const [watching, setWatching] = useState(false);
  const micro = useMicroExpressions(free, reducedMotion);

  // The pointer loop reads the latest of these without being set up again.
  const live = useRef({ free, reducedMotion, dispatch: opts.dispatch });
  live.current = { free, reducedMotion, dispatch: opts.dispatch };

  // Something to say, a voice turn, thinking or a drag ends the excitement at once.
  const interrupted = opts.message || opts.voice || opts.busy ||
    opts.dragging === true;
  useEffect(() => {
    if (interrupted) setExcited(false);
  }, [interrupted]);

  useEffect(() => {
    const stage = opts.stage.current;
    if (!lively || !awake || !stage) return;
    let pointer: Sample | null = null;
    let fresh = false;
    let frame = 0;
    let lastFrame = 0;
    let gaze: [Point, Point] = [ZERO, ZERO];
    let tracker = INITIAL_EXCITE;
    let hovering = false;
    let looking = false;
    let calm: ReturnType<typeof setTimeout> | undefined;

    let written = "";
    /** Set the gaze offsets, when they changed (a resting gaze writes nothing). */
    const write = (next: [Point, Point]) => {
      const values = [next[0].x, next[0].y, next[1].x, next[1].y].map((v) =>
        `${v.toFixed(2)}px`
      );
      const key = values.join();
      if (key === written) return;
      written = key;
      GAZE_VARS.forEach((name, i) => stage.style.setProperty(name, values[i]));
    };
    const setHovering = (on: boolean) => {
      if (on === hovering) return;
      hovering = on;
      setHover(on);
    };
    const excite = () => {
      setExcited(true);
      if (!live.current.reducedMotion) {
        live.current.dispatch({ type: "say", mood: "excited" });
      }
      clearTimeout(calm);
      calm = setTimeout(() => setExcited(false), EXCITE_MS);
    };

    const tick = (now: number) => {
      frame = 0;
      const svg = stage.querySelector("svg.loopy");
      if (!svg) return;
      const { unit, target, eyes } = measure(svg);
      if (pointer && fresh) {
        fresh = false;
        const step = trackExcitement(
          tracker,
          pointer,
          target,
          live.current.free,
        );
        tracker = step.tracker;
        if (step.fire) excite();
        setHovering(overFace(pointer, target));
      }
      const look = pointer !== null && following(pointer.t, performance.now());
      if (look !== looking) {
        looking = look;
        setWatching(look);
      }
      const goal: [Point, Point] = look
        ? [
          gazeOffset(eyes[0], NEUTRAL_PUPILS[0], pointer!, unit),
          gazeOffset(eyes[1], NEUTRAL_PUPILS[1], pointer!, unit),
        ]
        : [ZERO, ZERO];
      const dt = lastFrame ? now - lastFrame : 16;
      lastFrame = now;
      const next: [Point, Point] = live.current.reducedMotion ? goal : [
        easeToward(gaze[0], goal[0], dt),
        easeToward(gaze[1], goal[1], dt),
      ];
      const settled = near(next[0], goal[0]) && near(next[1], goal[1]);
      gaze = settled ? goal : next;
      write(gaze);
      // Keep going while the eyes follow or drift back; then rest until the pointer moves.
      if (look || !settled) frame = requestAnimationFrame(tick);
      else lastFrame = 0;
    };
    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY, t: performance.now() };
      fresh = true;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onLeave = () => setHovering(false);

    globalThis.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      globalThis.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      cancelAnimationFrame(frame);
      clearTimeout(calm);
      for (const name of GAZE_VARS) stage.style.removeProperty(name);
      setHover(false);
      setWatching(false);
      setExcited(false);
    };
  }, [lively, awake]);

  return {
    expression: !free
      ? undefined
      : hover
      ? "delighted"
      : watching
      ? undefined
      : micro,
    excited,
  };
}
