// Loopy sleepy at night (Settings → Companion → Reactions), the DOM side of
// lib/companion/sleepy.ts, which holds the rules. Kept thin and cheap:
//
// - one passive `pointermove` and one `keydown` listener on the window, which only note the time
//   (any activity keeps Loopy from dozing off); while Loopy sleeps, a pointer move also checks
//   whether it came near Loopy (one bounding box read), which wakes it;
// - a check every SLEEP_CHECK_MS (and when the e2e suite moves the clock, lib/test-hooks.ts)
//   whether it is night and the pointer has rested long enough.
//
// Waking up plays a stretch (`stretching`, public/styles.css "Loopy wakes"), left out with reduced
// motion. Anything that needs Loopy's face (`busy`: a message, thinking, a voice turn, a reaction)
// wakes it too.

import { useEffect, useRef, useState } from "denext";
import {
  nearEnoughToWake,
  shouldSleep,
  shouldWake,
  STRETCH_MS,
} from "../../lib/companion/sleepy.ts";
import { CLOCK_EVENT, clockNow } from "../../lib/test-hooks.ts";

/** How often the night and the pointer's rest are checked, ms. */
const SLEEP_CHECK_MS = 15_000;

export interface LoopySleepOptions {
  /** Settings → Companion → Reactions → Sleepy at night. */
  readonly enabled: boolean;
  /** The night's hours (minutes since midnight). */
  readonly from: number;
  readonly to: number;
  /** Something else needs Loopy's face: it wakes (and does not fall asleep). */
  readonly busy: boolean;
  /** The element holding Loopy's SVG (for "near"). */
  readonly stage: { readonly current: HTMLElement | null };
  readonly reducedMotion: boolean;
}

/** Whether Loopy sleeps, and whether it is stretching awake. */
export interface LoopySleep {
  readonly asleep: boolean;
  readonly stretching: boolean;
}

/** Loopy's centre and size on screen, px (`null`: not drawn). */
function loopyBox(stage: HTMLElement | null) {
  const svg = stage?.querySelector("svg.loopy");
  if (!svg) return null;
  const r = svg.getBoundingClientRect();
  return {
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
    size: Math.max(r.width, r.height),
  };
}

/** Loopy's night; see the module comment. */
export function useLoopySleep(opts: LoopySleepOptions): LoopySleep {
  const [asleep, setAsleep] = useState(false);
  const [stretching, setStretching] = useState(false);
  const lastActivity = useRef(clockNow());
  const live = useRef(opts);
  live.current = opts;
  const asleepRef = useRef(false);
  asleepRef.current = asleep;
  const stretchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const wake = () => {
    lastActivity.current = clockNow();
    if (!asleepRef.current) return;
    asleepRef.current = false;
    setAsleep(false);
    if (live.current.reducedMotion) return;
    setStretching(true);
    clearTimeout(stretchTimer.current);
    stretchTimer.current = setTimeout(() => setStretching(false), STRETCH_MS);
  };
  const wakeRef = useRef(wake);
  wakeRef.current = wake;

  const { enabled, from, to, busy } = opts;
  useEffect(() => {
    if (!enabled) {
      if (asleepRef.current) wakeRef.current();
      return;
    }
    const check = () => {
      const o = live.current;
      const ctx = {
        enabled: o.enabled,
        now: clockNow(),
        from: o.from,
        to: o.to,
        busy: o.busy,
      };
      if (asleepRef.current) {
        if (shouldWake(ctx)) wakeRef.current();
      } else if (shouldSleep({ ...ctx, lastActivity: lastActivity.current })) {
        asleepRef.current = true;
        setAsleep(true);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!asleepRef.current) {
        lastActivity.current = clockNow();
        return;
      }
      const box = loopyBox(live.current.stage.current);
      if (box && nearEnoughToWake({ x: e.clientX, y: e.clientY }, box)) {
        wakeRef.current();
      }
    };
    const onKey = () => {
      if (!asleepRef.current) lastActivity.current = clockNow();
    };
    check();
    const timer = setInterval(check, SLEEP_CHECK_MS);
    globalThis.addEventListener("pointermove", onMove, { passive: true });
    globalThis.addEventListener("keydown", onKey, { passive: true });
    globalThis.addEventListener(CLOCK_EVENT, check);
    return () => {
      clearInterval(timer);
      globalThis.removeEventListener("pointermove", onMove);
      globalThis.removeEventListener("keydown", onKey);
      globalThis.removeEventListener(CLOCK_EVENT, check);
    };
  }, [enabled, from, to]);

  // Something to say (or think, or hear) wakes Loopy at once, and keeps it awake; the rest before
  // it dozes off again counts from when that ended.
  useEffect(() => {
    if (busy) wakeRef.current();
    else lastActivity.current = clockNow();
  }, [busy]);

  useEffect(() => () => clearTimeout(stretchTimer.current), []);

  return { asleep: asleep && !busy, stretching };
}
