// Loopy's lip-sync (lib/companion/lip-sync.ts): the example's mouth shapes, and the talking
// pattern that drives them while Qutty speaks.

import { assert, assertEquals } from "@std/assert";
import {
  LEVEL_STEPS,
  mouthShape,
  talkStep,
} from "../lib/companion/lip-sync.ts";

Deno.test("lip-sync: step 0 is a closed mouth, every other step an open oval that grows", () => {
  assertEquals(mouthShape(0).open, false);
  let previous = "";
  for (let step = 1; step <= LEVEL_STEPS; step++) {
    const { d, open } = mouthShape(step);
    assert(open, `step ${step} is open`);
    assert(d !== previous, `step ${step} has its own shape`);
    previous = d;
  }
  // Out of range clamps.
  assertEquals(mouthShape(-3), mouthShape(0));
  assertEquals(mouthShape(99), mouthShape(LEVEL_STEPS));
});

Deno.test("lip-sync: the talking pattern stays in range, opens and closes, and loops", () => {
  const steps = Array.from({ length: 64 }, (_, i) => talkStep(i));
  assert(steps.every((s) => s >= 0 && s <= LEVEL_STEPS));
  assert(steps.includes(0), "it closes between syllables");
  assert(steps.includes(LEVEL_STEPS), "it opens all the way");
  assert(new Set(steps).size > 2, "it varies");
  assertEquals(talkStep(-1), talkStep(steps.length * 1000 - 1), "it loops");
});
