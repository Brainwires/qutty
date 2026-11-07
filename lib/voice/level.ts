/**
 * The microphone's level while push-to-talk listens: desktop/voice.ts reads the native library's
 * `rla_level` (the input's RMS, 0–1, over the last ~100 ms; 0 when not capturing) every
 * {@linkcode LEVEL_MS} (20 Hz) and sends the page a `level` event when it changed enough
 * ({@linkcode levelGate}); the page swells Loopy's head with it (the listening pulse,
 * app/companion/loopy.tsx `level`). The demo's fake voice sends a made-up level the same way.
 *
 * Speech is quiet as RMS goes (rarely above ~0.3), so {@linkcode normalizeLevel} spreads the
 * useful range over 0–1, as Denext's examples/companion lib/lip-sync.ts does (its `SILENCE` and
 * `FULL`).
 *
 * Client-safe and pure.
 *
 * @module
 */

/** How often the level is read while listening (ms): 20 Hz. */
export const LEVEL_MS = 50;

/** Below this RMS the input counts as silent: breath and line noise leave Loopy still. */
export const SILENCE = 0.02;

/** An RMS this loud swells Loopy all the way. */
export const FULL = 0.25;

/** The smallest change worth sending (on the 0–1 scale); silence is always sent once. */
export const LEVEL_STEP = 0.04;

/** The library's RMS (anything: NaN, negative, above 1) as the pulse's 0–1. */
export function normalizeLevel(rms: number): number {
  if (!(rms > SILENCE)) return 0;
  return Math.min(1, (rms - SILENCE) / (FULL - SILENCE));
}

/**
 * A filter for the levels sent: true for the first one, a change of at least `step`, and a fall
 * to silence (so the pulse settles); false for the rest.
 */
export function levelGate(step = LEVEL_STEP): (level: number) => boolean {
  let last: number | undefined;
  return (level) => {
    const send = last === undefined ||
      (level === 0 ? last !== 0 : Math.abs(level - last) >= step);
    if (send) last = level;
    return send;
  };
}
