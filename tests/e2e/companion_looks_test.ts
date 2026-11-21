// Companion looks against the demo backend: the test look (tests/fixtures/looks/pixel-blob, read
// from a temp looks folder through desktop/companion-looks.ts, the desktop's own code) put in the
// demo's looks folder, picked in Settings → Companion → Look; the overlay then draws its pictures
// (an `<img>` from a data: URL) for the mood on screen, with its scoped look.css, and Loopy comes
// back when Loopy is picked again. Also "Create a look…" in the demo, and a chosen look that is
// gone (the companion keeps Loopy, Settings says why).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { LookStore } from "../../desktop/companion-looks.ts";
import type { Look } from "../../lib/companion/looks.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const PICTURE = `${OVERLAY} [data-testid=companion-look-picture]`;
const CHOICE = "[data-testid=setting-companion-look]";
/** Where the screenshots go (gitignored): the pictures the PR shows. */
const SHOT_DIR = join(ROOT, "tests/e2e/__screenshots__");

/** Photograph the element `selector` (with `pad` px around it) as `name` in SHOT_DIR. */
async function shoot(app: App, selector: string, name: string, pad = 8) {
  const r = await app.rectOf(selector);
  if (!r) return;
  await Deno.mkdir(SHOT_DIR, { recursive: true });
  const png = await app.page.screenshot({
    format: "png",
    clip: {
      x: Math.max(0, r.x - pad),
      y: Math.max(0, r.y - pad),
      width: r.width + 2 * pad,
      height: r.height + 2 * pad,
      scale: 2,
    },
  });
  await Deno.writeFile(join(SHOT_DIR, name), png);
}

/** The test look, read from a temp looks folder by the desktop's code. */
async function pixelBlob(): Promise<Look> {
  const dir = await Deno.makeTempDir({ prefix: "qutty-e2e-looks-" });
  try {
    await copy(
      join(ROOT, "tests/fixtures/looks/pixel-blob"),
      join(dir, "pixel-blob"),
    );
    const got = await new LookStore(dir).get("pixel-blob");
    assert("look" in got, JSON.stringify(got));
    return got.look;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Put `look` in the demo's looks folder. */
function addLook(app: App, look: Look) {
  return app.eval((l: Look) => {
    (globalThis as unknown as { __e2eLooks: { add(l: Look): void } })
      .__e2eLooks.add(l);
  }, look);
}

/** What the overlay draws: the look's picture (its name and src), or the drawn face. */
function drawn(app: App) {
  return app.eval(
    (overlay: string, picture: string) => {
      const root = document.querySelector<HTMLElement>(overlay);
      const img = document.querySelector<HTMLImageElement>(picture);
      const box = img?.closest<HTMLElement>("[data-testid=companion-look]");
      return {
        look: root?.dataset.look ?? null,
        svg: !!root?.querySelector("svg.companion-avatar"),
        picture: box?.dataset.picture ?? null,
        mood: box?.dataset.mood ?? null,
        state: box?.dataset.state ?? null,
        src: img?.getAttribute("src") ?? null,
        loaded: !!img && img.complete && img.naturalWidth > 0,
        width: box?.offsetWidth ?? 0,
        css: root?.querySelector("[data-testid=companion-look-css]")
          ?.textContent ?? "",
      };
    },
    OVERLAY,
    PICTURE,
  );
}

/** Pick look `id` in Settings → Companion → Look. */
async function pick(app: App, id: string): Promise<void> {
  await app.openSettings("companion");
  const sel = `${CHOICE}[data-value="${id}"]`;
  await waitFor(() => app.exists(sel), 3000, `the ${id} choice`);
  await app.click(sel);
  await waitFor(
    () =>
      app.eval(
        (s: string) =>
          document.querySelector(s)?.getAttribute("aria-checked") === "true",
        sel,
      ),
    2000,
    `${id} picked`,
  );
  await app.closeSettings();
}

/** Say something in `mood`, and wait for the look to draw `picture` for it. */
async function sayMood(
  app: App,
  look: Look,
  mood: string,
  picture: string,
): Promise<void> {
  const shell = (await app.focusedId())!;
  await app.run(
    shell,
    `qutty-hook say Mood ${mood} --mood ${mood} --timeout 0`,
  );
  const d = await waitFor(
    async () => {
      const d = await drawn(app);
      return d.mood === mood && d.picture === picture ? d : null;
    },
    4000,
    `the ${picture} picture for ${mood}`,
  );
  assertEquals(d.src, look.images[picture]);
  await app.eval(() => {
    document.querySelector<HTMLElement>(
      "[data-testid=companion-bubble-close]",
    )?.click();
  });
}

suite("companion looks", (test) => {
  test("a picked look draws its picture for each mood, and Loopy comes back", async (app) => {
    const look = await pixelBlob();
    await addLook(app, look);
    await waitFor(
      async () => (await drawn(app)).svg,
      3000,
      "Loopy at first",
    );
    await pick(app, "pixel-blob");
    const idle = await waitFor(
      async () => {
        const d = await drawn(app);
        return d.picture === "idle" && d.loaded ? d : null;
      },
      4000,
      "the idle picture",
    );
    assertEquals(idle.look, "pixel-blob");
    assertEquals(idle.svg, false);
    assertEquals(idle.src, look.images.idle);
    assert(idle.src!.startsWith("data:image/svg+xml;base64,"));
    // look.json's size (the box as laid out, before the bob turns it).
    assertEquals(Math.round(idle.width), 96);
    // look.css, scoped to the look.
    assertStringIncludes(idle.css, '[data-look="pixel-blob"] {');

    await shoot(app, OVERLAY, "companion-look-pixel-blob.png", 40);
    await app.openSettings("companion");
    await shoot(
      app,
      "[data-testid=companion-look-settings]",
      "companion-look-settings.png",
    );
    await app.closeSettings();

    await sayMood(app, look, "sad", "sad");
    // No mad.svg: mad falls back to sad; no success.svg: success to happy.
    await sayMood(app, look, "mad", "sad");
    await sayMood(app, look, "success", "happy");
    await sayMood(app, look, "confused", "thinking");

    await pick(app, "loopy");
    await waitFor(
      async () => {
        const d = await drawn(app);
        return d.svg && d.look === null && d.src === null;
      },
      3000,
      "Loopy again",
    );
  });

  test("Create a look adds the starter look; a look that is gone keeps Loopy", async (app) => {
    await app.openSettings("companion");
    await app.click("[data-testid=companion-looks-create]");
    await waitFor(
      () => app.exists(`${CHOICE}[data-value="my-look"]`),
      3000,
      "the starter look listed",
    );
    await app.closeSettings();
    await pick(app, "my-look");
    await waitFor(
      async () => (await drawn(app)).picture === "idle",
      4000,
      "the starter look's idle picture",
    );

    // After a reload the demo's folder is empty again: the saved look is gone, so the companion
    // keeps Loopy and Settings says why.
    assertEquals((await app.settings()).companion.look, "my-look");
    await app.reload();
    await waitFor(async () => (await drawn(app)).svg, 4000, "Loopy");
    assertEquals((await drawn(app)).look, null);
    await app.openSettings("companion");
    const note = await waitFor(
      () =>
        app.eval(() =>
          document.querySelector("[data-testid=companion-look-note]")
            ?.textContent ?? null
        ),
      3000,
      "the note",
    );
    assertStringIncludes(note, "my-look");
    assertStringIncludes(note, "Loopy");
  });
});
