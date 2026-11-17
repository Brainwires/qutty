// Where Qutty's companion face intentionally differs from Denext's example (the snapshot in
// tests/fixtures/companion/face-shape.json), for tests/companion_look_test.ts and the e2e look
// check (tests/e2e/companion_test.ts). Everything else must stay the example's.
//
// - Lower, flatter brows (every mood): the example's highest (surprised, shocked, excited, and
//   the neutral face's delighted pose) reached the bead's rim; tests/companion_brows_test.ts keeps
//   them on the head.
// - A small, gentle resting smile (neutral, love): the example's wide crescent read as manic.
// - The shocked eyes a little less wide (ry 11 → 10.4), under the lower brows.
// - Qutty's own additions to the head, left out of the comparison: the catch-lights on the dot
//   pupils (`.companion-glint`) and the rosy cheeks (`.companion-cheeks`).
// - CSS: the brows lift less in the think, celebrate and appear moves (QUTTY_RULES).

import { FACES } from "../app/companion/companion-face.tsx";
import type { FaceMood } from "../lib/companion/face-machine.ts";

/** The example's resting smile, which Qutty draws smaller. */
const EXAMPLE_SMILE = "M71 88 Q80 95 89 88";

/** Qutty's additions to the head, which the example has no counterpart of (CSS selectors). */
export const QUTTY_HEAD_PARTS = ".companion-glint, .companion-cheeks";

/** The example's rules for the face that Qutty changed (selector → its declarations in Qutty). */
export const QUTTY_RULES: Record<string, Record<string, string>> = {
  '.companion-avatar[data-state="think"] .companion-brows': {
    transform: "translateY(-1px) rotate(-3deg)",
  },
  '.companion-avatar[data-state="celebrate"] .companion-brows, .companion-avatar[data-state="appear"] .companion-brows':
    { transform: "translateY(-1px)" },
};

/** The example's head markup for `mood` as Qutty draws it (brows, smile, shocked eyes). */
export function quttyHead(mood: FaceMood, exampleHead: string): string {
  const face = FACES[mood];
  let i = 0;
  return exampleHead
    .replace(
      /(<g class="companion-brows">)([\s\S]*?)(<\/g>)/,
      (_, open: string, inner: string, close: string) =>
        open +
        inner.replace(/d="[^"]*"/g, () => `d="${face.brows[i++]}"`) +
        close,
    )
    .replace(`d="${EXAMPLE_SMILE}"`, `d="${FACES.neutral.mouth}"`)
    .replace(
      mood === "shocked" ? /ry="11"/g : /$^/,
      `ry="${face.eyeRy}"`,
    );
}

/** `html` without Qutty's additions to the head (catch-lights, cheeks). */
export function withoutQuttyParts(html: string): string {
  return html
    .replace(/<path class="companion-glint"[^>]*>(<\/path>)?/g, "")
    .replace(/<g class="companion-cheeks">[\s\S]*?<\/g>/g, "");
}
