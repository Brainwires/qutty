// Tile activity indicators and program titles on the demo backend (lib/workspace/activity.ts):
// every state shows on an unfocused tile (and its chip, a minimized one too) and clears on focus,
// reduced motion stills the busy shimmer and the done fade, Off and Subtle, and a program's own
// title (OSC 0 / 2) in the header and the chip, falling back with Settings → Tiles → Process
// title. The demo shell drives it all: `later` (background output), `job` (a command that runs
// and ends with an exit status), `bell` and `title` (lib/shell-marks-demo.ts).

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";

const chipSel = (id: string) => `[data-testid=chip][data-id="${id}"]`;

/** Two terminals: `a` (the first) and `b` (new, focused). */
async function pair(app: App): Promise<{ a: string; b: string }> {
  const a = (await app.focusedId())!;
  const b = await app.newTerminal();
  return { a, b };
}

/** Wait for tile `id` and its chip to show activity `state`. */
async function activityIs(
  app: App,
  id: string,
  state: string,
  timeout = 6000,
): Promise<void> {
  await waitFor(
    async () =>
      (await app.attr(tileSel(id), "data-activity")) === state &&
      (await app.attr(chipSel(id), "data-activity")) === state,
    timeout,
    `${id} to show ${state}`,
  );
}

/** Run `command` in `b`, look at `a` instead, and wait for `b` to show `state`. */
async function showsWhileAway(
  app: App,
  ids: { a: string; b: string },
  command: string,
  state: string,
): Promise<void> {
  await app.typeInTerminal(ids.b, `${command}\n`);
  await app.focusChip(ids.a);
  await activityIs(app, ids.b, state);
  assertEquals(await app.attr(tileSel(ids.a), "data-activity"), "none");
}

/** Stop the `job` running in tile `id` (Ctrl-C) and wait for its prompt. */
async function stopJob(app: App, id: string): Promise<void> {
  const before = await app.promptCount(id);
  await app.focusTerminalInput(id);
  await app.ctrl("c");
  await waitFor(
    async () => (await app.promptCount(id)) > before,
    3000,
    "the prompt after Ctrl-C",
  );
}

/** Focusing tile `id` clears what it showed. */
async function focusClears(app: App, id: string): Promise<void> {
  await app.focusChip(id);
  await activityIs(app, id, "none", 3000);
}

/** Computed styles of tile `id`: its border, its header and the header's two pseudo-elements. */
function styles(app: App, id: string) {
  return app.eval((sel: string) => {
    const tile = document.querySelector<HTMLElement>(sel)!;
    const head = tile.querySelector<HTMLElement>(".tile-head")!;
    const s = getComputedStyle(head);
    const after = getComputedStyle(head, "::after");
    const before = getComputedStyle(head, "::before");
    return {
      border: getComputedStyle(tile).borderTopColor,
      headBg: s.backgroundColor,
      headAnimation: s.animationName,
      lineAnimation: after.animationName,
      lineOpacity: after.opacity,
      dot: before.content !== "none" && before.content !== "normal"
        ? before.backgroundColor
        : null,
    };
  }, tileSel(id));
}

/** A theme colour token as the browser computes it (`rgb(r, g, b)`). */
function token(app: App, name: string): Promise<string> {
  return app.eval((n: string) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);
}

/** Wait for tile `id`'s border to be theme token `name` (its colour transitions in). */
async function borderIs(app: App, id: string, name: string): Promise<void> {
  const want = await token(app, name);
  await waitFor(
    async () => (await styles(app, id)).border === want,
    2000,
    `${id}'s border to be ${name}`,
  );
}

/** Pick Settings → Tiles → Tile title. */
async function setTileTitle(app: App, value: string): Promise<void> {
  await app.openSettings();
  await app.choose("[data-testid=setting-tile-title]", value);
  await waitFor(
    async () => (await app.settings()).tileTitle === value,
    2000,
    `tile title ${value}`,
  );
  await app.closeSettings();
}

/** Pick an option in Settings → Tiles. */
async function setIndicators(app: App, mode: string): Promise<void> {
  await app.openSettings();
  await app.click(
    `[data-testid=setting-activity-indicators][data-value="${mode}"]`,
  );
  await waitFor(
    async () => (await app.settings()).activity.indicators === mode,
    2000,
    `indicators ${mode}`,
  );
  await app.closeSettings();
}

suite("tile activity", (test) => {
  test("output: background output tints the header; focus clears it", async (app) => {
    const ids = await pair(app);
    const base = (await styles(app, ids.a)).headBg;
    await showsWhileAway(app, ids, "later 1.5 build finished", "output");
    const s = await styles(app, ids.b);
    assertNotEquals(s.headBg, base, "a tinted header");
    assertEquals(s.lineOpacity, "0", "no busy line");
    await focusClears(app, ids.b);
  });

  test("busy: a running command shimmers along the header's edge; the focused tile shows none", async (app) => {
    const ids = await pair(app);
    await showsWhileAway(app, ids, "job 30 0 make all", "busy");
    const s = await styles(app, ids.b);
    assertEquals(s.lineAnimation, "tile-busy");
    assertEquals(s.lineOpacity, "1");
    // Focused, a running command shows nothing; it is still running (busy again once away).
    await focusClears(app, ids.b);
    await app.focusChip(ids.a);
    await activityIs(app, ids.b, "busy");
    await stopJob(app, ids.b);
  });

  test("attention: a bell latches an amber border and tint until focus", async (app) => {
    const ids = await pair(app);
    await showsWhileAway(app, ids, "bell 1.5", "attention");
    await borderIs(app, ids.b, "--tint-yellow");
    // Latched: it stays after the bell.
    await new Promise((r) => setTimeout(r, 600));
    assertEquals(await app.attr(tileSel(ids.b), "data-activity"), "attention");
    await focusClears(app, ids.b);
  });

  test("failed: a non-zero exit latches a red border until focus", async (app) => {
    const ids = await pair(app);
    await showsWhileAway(app, ids, "job 1.5 2 make all", "failed");
    await borderIs(app, ids.b, "--tint-red");
    await focusClears(app, ids.b);
  });

  test("done: exit 0 tints green, fades, then decays to output", async (app) => {
    const ids = await pair(app);
    await showsWhileAway(app, ids, "job 1.5 0 make all", "done");
    assertEquals((await styles(app, ids.b)).headAnimation, "tile-done");
    // About 4 s later: the job printed a line, so output is what is left.
    await activityIs(app, ids.b, "output", 8000);
    await focusClears(app, ids.b);
  });

  test("a minimized tile's chip shows its activity", async (app) => {
    const ids = await pair(app);
    await app.typeInTerminal(ids.b, "bell 1.5\n");
    await app.click(`${tileSel(ids.b)} [data-testid=tile-minimize]`);
    await waitFor(
      async () => (await app.focusedId()) === ids.a,
      3000,
      "a focused",
    );
    await waitFor(
      async () =>
        (await app.attr(chipSel(ids.b), "data-activity")) === "attention",
      6000,
      "the minimized chip's attention",
    );
    assertEquals(await app.attr(chipSel(ids.b), "data-minimized"), "true");
    // Its chip restores (and focuses) it, which clears it.
    await app.focusChip(ids.b);
    await activityIs(app, ids.b, "none", 3000);
  });

  test("Off shows nothing; Subtle shows a dot and the border, no tint or shimmer", async (app) => {
    const ids = await pair(app);
    await setIndicators(app, "off");
    await app.typeInTerminal(ids.b, "bell 1\n");
    await app.focusChip(ids.a);
    await new Promise((r) => setTimeout(r, 1800));
    assertEquals(await app.attr(tileSel(ids.b), "data-activity"), "none");
    assertEquals(await app.attr(chipSel(ids.b), "data-activity"), "none");
    // The bell was heard all the same: Subtle shows it.
    await setIndicators(app, "subtle");
    await activityIs(app, ids.b, "attention");
    const base = (await styles(app, ids.a)).headBg;
    const s = await styles(app, ids.b);
    assertEquals(s.headBg, base, "no header tint");
    assertEquals(s.dot, await token(app, "--tint-yellow"));
    await borderIs(app, ids.b, "--tint-yellow");
    await focusClears(app, ids.b);
    await app.typeInTerminal(ids.b, "job 30 0 make all\n");
    await app.focusChip(ids.a);
    await activityIs(app, ids.b, "busy");
    assertEquals((await styles(app, ids.b)).lineAnimation, "none");
    await stopJob(app, ids.b);
  });

  test("program titles: OSC 2 / 0 title the header and chip; Process title falls back", async (app) => {
    const ids = await pair(app);
    const title = () =>
      app.eval(
        (sel: string) =>
          document.querySelector(`${sel} [data-testid=tile-title]`)!
            .textContent,
        tileSel(ids.b),
      );
    const chipTitle = () =>
      app.eval(
        (sel: string) =>
          document.querySelector(`${sel} .chip-title`)!.textContent,
        chipSel(ids.b),
      );
    await app.waitForChipTitles();
    const process = await title();
    await app.run(ids.b, "title vim notes.md");
    await waitFor(
      async () => (await title()) === "vim notes.md",
      3000,
      "header",
    );
    assertEquals(await chipTitle(), "vim notes.md");
    await app.run(ids.b, "title -0 htop");
    await waitFor(async () => (await title()) === "htop", 3000, "OSC 0");
    // Settings → Tiles → Process title: the process / folder title again.
    await setTileTitle(app, "process");
    await waitFor(async () => (await title()) !== "htop", 3000, "fallback");
    assert(!(await chipTitle())!.includes("htop"));
    assertEquals(await title(), process);
    // Back to Program title, and an empty title clears the program's.
    await setTileTitle(app, "program");
    await waitFor(
      async () => (await title()) === "htop",
      3000,
      "program again",
    );
    await app.run(ids.b, "title");
    await waitFor(async () => (await title()) === process, 3000, "cleared");
  });
});

suite("tile activity, reduced motion", (test) => {
  test("busy is a still line and done a still tint", async (app) => {
    const ids = await pair(app);
    await showsWhileAway(app, ids, "job 30 0 make all", "busy");
    let s = await styles(app, ids.b);
    assertEquals(s.lineAnimation, "none");
    assertEquals(s.lineOpacity, "1");
    await stopJob(app, ids.b);
    await showsWhileAway(app, ids, "job 1 0 make all", "done");
    s = await styles(app, ids.b);
    assertEquals(s.headAnimation, "none");
    assertEquals(
      await app.eval(() =>
        document.getAnimations().filter((a) =>
          ((a.effect as KeyframeEffect | null)?.target as Element | null)
            ?.closest(".tile")
        ).length
      ),
      0,
      "nothing animates in a tile",
    );
  }, { reducedMotion: true });
});
