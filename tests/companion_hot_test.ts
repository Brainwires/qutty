// The companion's hot face (Qutty's own, app/companion/companion-face.tsx `hot`): drawn only over
// the neutral face, in the example's parts (the same eye whites, pupils, brows and mouth classes),
// and kept out of the example's 13 moods, which tests/companion_look_test.ts checks unchanged.

import { assert, assertEquals } from "@std/assert";
import { renderToString } from "denext";
import { jsx } from "denext/jsx-runtime";
import { CompanionFace } from "../app/companion/companion-face.tsx";
import { MOODS } from "../lib/companion/face-machine.ts";

const render = (props: Record<string, unknown>) =>
  renderToString(
    jsx(CompanionFace as never, { state: "idle", ...props }) as never,
  );

Deno.test("The companion hot: not one of the example's moods", () => {
  assertEquals(MOODS.length, 13);
  assert(!(MOODS as readonly string[]).includes("hot"));
});

Deno.test("The companion hot: the flushed, panting, sweating face over the idle bead", async () => {
  const html = await render({ hot: true });
  assert(html.includes('data-mood="hot"'));
  for (
    const part of [
      "companion-hot-flush",
      "companion-hot-cheeks",
      "companion-tongue",
      "companion-sweat",
      "companion-heat",
      'class="companion-eye-white"',
      'class="companion-mouth is-open"',
    ]
  ) assert(html.includes(part), part);
  // The bead's own shading is untouched (the flush is drawn over it, under the face).
  assertEquals(
    /<defs>[\s\S]*?<\/defs>/.exec(html)?.[0],
    /<defs>[\s\S]*?<\/defs>/.exec(await render({}))?.[0],
  );
});

Deno.test("The companion hot: never over a mood shown for a reason", async () => {
  for (const mood of ["attention", "thinking", "sad", "success"]) {
    const html = await render({ hot: true, mood });
    assert(html.includes(`data-mood="${mood}"`), mood);
    assert(!html.includes("companion-sweat"), mood);
    assertEquals(html, await render({ mood }), mood);
  }
  assertEquals(await render({ hot: false }), await render({}));
});
