// Loopy's lip-sync: a mouth step (0 closed … LEVEL_STEPS wide open) becomes a mouth shape on its
// face. `LEVEL_STEPS` and `mouthShape` are Denext's examples/companion lib/lip-sync.ts
// (feat/loopy-voice-tools; same author, MIT) unchanged, so Loopy's speaking mouth is the example's.
//
// The example samples the model's voice with a Web Audio analyser. Qutty's speech comes from the
// OS (denext/mobile `speak()`) or the native library, neither of which hands the page any audio,
// so while something is said the mouth runs through a fixed syllable-like pattern instead
// (`talkStep`). Pure, so it is unit-tested.

/** How many open steps the mouth (and the listening pulse) has above closed (0). */
export const LEVEL_STEPS = 4;

/** The mouth for a step: a closed line, or an open oval that grows taller with the level. */
export function mouthShape(
  step: number,
): { readonly d: string; readonly open: boolean } {
  const s = Math.max(0, Math.min(LEVEL_STEPS, Math.round(step)));
  if (s === 0) return { d: "M73 90 Q80 92 87 90", open: false };
  const rx = 4 + s * 0.9;
  const ry = 1.6 + s * 1.6;
  const cy = 89 + s * 0.6;
  return {
    d: `M${(80 - rx).toFixed(1)} ${cy.toFixed(1)} a${rx.toFixed(1)} ${
      ry.toFixed(1)
    } 0 1 0 ${(2 * rx).toFixed(1)} 0 a${rx.toFixed(1)} ${ry.toFixed(1)} 0 1 0 ${
      (-2 * rx).toFixed(1)
    } 0`,
    open: true,
  };
}

/** How long each mouth step of {@linkcode talkStep} shows (ms). */
export const TALK_STEP_MS = 110;

/**
 * Syllables: the mouth opens to different widths and closes between some of them, so it reads as
 * talking rather than a steady flap.
 */
const TALK_PATTERN: readonly number[] = [
  1,
  3,
  4,
  2,
  0,
  2,
  4,
  3,
  1,
  0,
  3,
  2,
  4,
  1,
  0,
  2,
];

/** The mouth step for the `tick`th {@linkcode TALK_STEP_MS} slot of speech (it loops). */
export function talkStep(tick: number): number {
  const n = TALK_PATTERN.length;
  return TALK_PATTERN[((Math.floor(tick) % n) + n) % n];
}
