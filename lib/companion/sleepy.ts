/**
 * Sleepy at night (Settings → Companion → Reactions): between the night's hours (default 00:00
 * to 06:00, local time) and once the pointer has not moved for a while, Loopy dozes off in the
 * example's `sleepy` mood (droopy eyes, z's) and its idle life slows down. The pointer moving near
 * it, or anything to say (a question, a reply, a reaction, thinking, a voice turn), wakes it with
 * a stretch; the pointer moving elsewhere only keeps it from falling asleep.
 *
 * Client-safe and pure; app/companion/use-loopy-sleep.ts is the DOM side.
 *
 * @module
 */

/** Minutes since midnight (0–1439). */
export type DayMinute = number;

/** The minute of the day of `ms` (local time). */
export function dayMinute(ms: number): DayMinute {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Whether `minute` is in the window from `from` (inclusive) to `to` (exclusive). A window that
 * ends before it starts crosses midnight (22:00–06:00); one that starts where it ends is empty.
 */
export function inWindow(
  minute: DayMinute,
  from: DayMinute,
  to: DayMinute,
): boolean {
  if (from === to) return false;
  return from < to
    ? minute >= from && minute < to
    : minute >= from || minute < to;
}

/** "06:30" for 390. */
export function formatMinute(m: DayMinute): string {
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 390 for "06:30" (an `<input type="time">` value); `null` for anything else. */
export function parseMinute(text: string): DayMinute | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** How long the pointer must rest before Loopy dozes off, ms. */
export const SLEEP_AFTER_MS = 2 * 60_000;
/** How long the wake-up stretch lasts, ms. */
export const STRETCH_MS = 900;

/** What decides whether Loopy sleeps. */
export interface SleepContext {
  /** Settings → Companion → Reactions → Sleepy at night. */
  readonly enabled: boolean;
  /** Now (ms). */
  readonly now: number;
  /** The night's hours. */
  readonly from: DayMinute;
  readonly to: DayMinute;
  /** When the pointer last moved (or a key was pressed), ms. */
  readonly lastActivity: number;
  /** Something is on Loopy's face for a reason (a message, thinking, a voice turn, a reaction). */
  readonly busy: boolean;
}

/** Whether Loopy may fall asleep now (it stays asleep until something wakes it). */
export function shouldSleep(ctx: SleepContext): boolean {
  return ctx.enabled && !ctx.busy &&
    inWindow(dayMinute(ctx.now), ctx.from, ctx.to) &&
    ctx.now - ctx.lastActivity >= SLEEP_AFTER_MS;
}

/** Whether a sleeping Loopy wakes: night is over, it was turned off, or something needs it. */
export function shouldWake(ctx: Omit<SleepContext, "lastActivity">): boolean {
  return !ctx.enabled || ctx.busy ||
    !inWindow(dayMinute(ctx.now), ctx.from, ctx.to);
}

/** "Near" Loopy, for waking it: within this many times its size of its centre. */
const WAKE_NEAR = 2;

/** Whether the pointer at (`x`, `y`) is near enough to wake Loopy (centre `cx`, `cy`, `size` px). */
export function nearEnoughToWake(
  p: { readonly x: number; readonly y: number },
  loopy: { readonly cx: number; readonly cy: number; readonly size: number },
): boolean {
  return Math.hypot(p.x - loopy.cx, p.y - loopy.cy) <= WAKE_NEAR * loopy.size;
}
