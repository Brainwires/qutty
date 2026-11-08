// Loopy's reactions (Settings → Companion → Reactions) against the demo backend. The demo shell
// sends OSC 133 marks around every command like Qutty's zsh plugin, and `job <s> <exit> <cmd…>`
// (lib/shell-marks-demo.ts) stands in for a long build or test run; the minimum duration is set to
// 1 s so the suite is quick. Demo agents report `/pass` and `/fail` status notes. The app's clock
// is moved for the night (`window.__e2e.setClock`, lib/test-hooks.ts).
//
// Covers: a hop of joy after a long build-like command succeeds, a sad face after one fails, the
// line beside Loopy, short and non-build commands left alone; agents' notes; never over an
// ask_user question; reduced motion (no hop); sleepy at night, staying asleep while the pointer
// moves far away, waking with a stretch when it comes near, dozing off again, woken by a message,
// awake by day; the Settings toggles. Takes the screenshots the PR shows (loopy-reactions-*.png,
// copied to `LOOPY_REACTIONS_SHOT_DIR` when set).

import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { launchAgent } from "./agent_helpers.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const LOOPY = `${OVERLAY} svg.loopy`;
const REACTION = "[data-testid=loopy-reaction]";
const SHOT_DIR = join(ROOT, "tests/e2e/__screenshots__");

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Loopy's mood, move and the overlay's top face layer. */
function looks(app: App) {
  return app.eval(
    (s: string, o: string) => {
      const svg = document.querySelector(s);
      return {
        mood: svg?.getAttribute("data-mood") ?? null,
        state: svg?.getAttribute("data-state") ?? null,
        asleep: svg?.hasAttribute("data-asleep") ?? false,
        stretch: svg?.hasAttribute("data-stretch") ?? false,
        face: document.querySelector(o)?.getAttribute("data-face") ?? null,
      };
    },
    LOOPY,
    OVERLAY,
  );
}

/** Wait until Loopy wears `mood`. */
function waitMood(app: App, mood: string, ms = 4000) {
  return waitFor(
    async () => (await looks(app)).mood === mood,
    ms,
    `Loopy ${mood}`,
  );
}

/** Record every mood and move Loopy takes from now on; call again with `reset: false` to read. */
function record(app: App, reset = true): Promise<string[]> {
  return app.eval(
    (s: string, fresh: boolean) => {
      const w = globalThis as {
        __seen?: string[];
        __obs?: MutationObserver;
      };
      if (fresh) {
        w.__obs?.disconnect();
        const seen: string[] = [];
        w.__seen = seen;
        w.__obs = new MutationObserver((list) => {
          for (const m of list) {
            const v = (m.target as Element).getAttribute(m.attributeName!);
            if (v) seen.push(`${m.attributeName}=${v}`);
          }
        });
        w.__obs.observe(document.querySelector(s)!, {
          attributes: true,
          attributeFilter: ["data-mood", "data-state"],
        });
      }
      return [...(w.__seen ?? [])];
    },
    LOOPY,
    reset,
  );
}

/** The line beside Loopy (`null`: none). */
function reactionLine(app: App) {
  return app.eval((s: string) => {
    const el = document.querySelector<HTMLElement>(s);
    return el
      ? { kind: el.dataset.kind ?? "", text: el.textContent ?? "" }
      : null;
  }, REACTION);
}

/** Set Settings → Companion → Reactions → minimum duration (the panel must be open). */
async function setMinDuration(app: App, seconds: number) {
  await app.eval((v: number) => {
    const el = document.querySelector<HTMLInputElement>(
      "[data-testid=setting-companion-reactMinS]",
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, seconds);
  await waitFor(
    async () => (await app.settings()).companion.reactMinS === seconds,
    2000,
    `the minimum at ${seconds} s`,
  );
}

/** Reactions to 1 s commands, so the suite is quick. */
async function quick(app: App) {
  await app.openSettings();
  await waitFor(
    () => app.exists("[data-testid=companion-reactions]"),
    2000,
    "the Reactions group",
  );
  await setMinDuration(app, 1);
  await app.closeSettings();
  await waitFor(
    async () => ["idle", "blink"].includes((await looks(app)).state ?? ""),
    3000,
    "Loopy landed",
  );
}

/** Run a demo `job` in the first shell tile and wait for its prompt. */
async function job(app: App, shell: string, args: string) {
  await app.run(shell, `job ${args}`, 8000);
}

/** Move the app's clock (`null`: back to the real time). */
function setClock(app: App, ms: number | null) {
  return app.eval((v: number | null) => {
    (globalThis as unknown as {
      __e2e: { setClock(ms: number | null): void };
    }).__e2e.setClock(v);
  }, ms);
}

/** 02:00 (or `hour`) local time tomorrow, ms. */
function tomorrowAt(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Loopy's bead centre and size on screen. */
function bead(app: App) {
  return app.eval((s: string) => {
    const r = document.querySelector(`${s} .loopy-bead`)!
      .getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, size: r.width };
  }, OVERLAY);
}

/** A close-up of Loopy (and its line), as loopy-reactions-<name>.png. */
async function shot(app: App, name: string): Promise<void> {
  const c = await bead(app);
  const o = (await app.rectOf(OVERLAY))!;
  const png = await app.page.screenshot({
    format: "png",
    clip: {
      x: o.x - 8,
      y: c.y - 120,
      width: o.width + 16,
      height: 185,
      scale: 3,
    },
  });
  await Deno.mkdir(SHOT_DIR, { recursive: true });
  await Deno.writeFile(join(SHOT_DIR, `loopy-reactions-${name}.png`), png);
  const dir = Deno.env.get("LOOPY_REACTIONS_SHOT_DIR");
  if (dir) await Deno.writeFile(join(dir, `loopy-reactions-${name}.png`), png);
}

suite("loopy reactions", (test) => {
  test("a long build that succeeds: a hop of joy and a line; one that fails: a sad face", async (app) => {
    await quick(app);
    const shell = (await app.focusedId())!;
    await record(app);
    await job(app, shell, "1.2 0 cargo test --release");
    await waitMood(app, "success");
    const ok = await waitFor(() => reactionLine(app), 2000, "the line");
    assertEquals(ok.kind, "celebrate");
    assertMatch(ok.text, /^✓ .+: cargo test --release \(1 s\)$/);
    assertEquals((await looks(app)).face, "reaction");
    // Back to the bare face after a moment, with the hop on the way.
    await waitMood(app, "neutral", 5000);
    const seen = await record(app, false);
    assert(seen.includes("data-state=celebrate"), seen.join(" "));
    assert(seen.includes("data-mood=success"), seen.join(" "));
    assertEquals(await reactionLine(app), null);

    await job(app, shell, "1.2 2 make all");
    await waitMood(app, "sad");
    const bad = await waitFor(() => reactionLine(app), 2000, "the line");
    assertEquals(bad.kind, "sad");
    assertMatch(bad.text, /^✗ .+: make all failed \(exit 2\)$/);
    await waitMood(app, "neutral", 6000);
  });

  test("short commands, non-build commands and Ctrl-C get no reaction", async (app) => {
    await quick(app);
    const shell = (await app.focusedId())!;
    await record(app);
    await job(app, shell, "0.3 0 cargo test");
    await job(app, shell, "1.2 0 crunch-numbers");
    await job(app, shell, "1.2 1 vim notes.md");
    await app.typeInTerminal(shell, "job 30 0 make\n");
    await pause(1300);
    await app.ctrl("c");
    await app.waitForPrompt(shell);
    await pause(600);
    const seen = await record(app, false);
    assert(
      !seen.some((s) => s === "data-mood=success" || s === "data-mood=sad"),
      seen.join(" "),
    );
    assertEquals(await reactionLine(app), null);
  });

  test("agents' status notes: tests passed celebrates, build failed is sad", async (app) => {
    await quick(app);
    const claude = await launchAgent(app, "claude");
    await app.typeInTerminal(claude, "/pass tests\n");
    await waitMood(app, "success");
    assertEquals((await reactionLine(app))?.text, "✓ claude: tests passed");
    await waitMood(app, "neutral", 5000);
    await app.typeInTerminal(claude, "/fail build\n");
    await waitMood(app, "sad");
    assertEquals((await reactionLine(app))?.text, "✗ claude: build failed");
  });

  test("never over an ask_user question; the reaction is dropped, not saved for later", async (app) => {
    await quick(app);
    const shell = (await app.focusedId())!;
    const claude = await launchAgent(app, "claude");
    await app.typeInTerminal(claude, "/ask Ship it?\n");
    await waitMood(app, "attention");
    await job(app, shell, "1.2 2 make all");
    await pause(1200);
    assertEquals((await looks(app)).mood, "attention", "sad never replaces it");
    assertEquals(await reactionLine(app), null);
    await record(app);
    await app.click("[data-testid=loopy-action]");
    await waitMood(app, "neutral", 4000);
    await pause(1200);
    const seen = await record(app, false);
    assert(!seen.includes("data-mood=sad"), seen.join(" "));
  });

  test("reduced motion: the success face without the hop", async (app) => {
    await quick(app);
    const shell = (await app.focusedId())!;
    await record(app);
    await job(app, shell, "1.2 0 npm test");
    await waitMood(app, "success");
    await waitMood(app, "neutral", 5000);
    const seen = await record(app, false);
    assert(!seen.includes("data-state=celebrate"), seen.join(" "));
  }, { reducedMotion: true });

  test("sleepy at night: dozes off when the pointer rests, wakes when it comes near", async (app) => {
    await quick(app);
    await app.page.mouse.move(10, 10);
    // Daytime: awake however long the pointer rests.
    await setClock(app, tomorrowAt(14));
    await pause(400);
    assertEquals((await looks(app)).mood, "neutral");
    // 02:00, the pointer resting since long before: asleep.
    const night = tomorrowAt(2);
    await setClock(app, night);
    await waitMood(app, "sleepy", 3000);
    const asleep = await looks(app);
    assert(asleep.asleep, "data-asleep");
    assertEquals(asleep.face, "sleepy");
    // The pointer moving far away does not wake it.
    for (let i = 0; i < 6; i++) {
      await app.page.mouse.move(20 + i * 30, 40);
      await pause(40);
    }
    await pause(300);
    assertEquals((await looks(app)).mood, "sleepy", "still asleep");
    // Near Loopy: it wakes, with a stretch.
    const c = await bead(app);
    await app.page.mouse.move(c.x - c.size * 1.5, c.y);
    await pause(30);
    await app.page.mouse.move(c.x - c.size * 1.2, c.y);
    await waitFor(
      async () => (await looks(app)).mood !== "sleepy",
      2000,
      "awake",
    );
    const woke = await looks(app);
    assert(woke.stretch, "a stretch");
    assert(!woke.asleep);
    // Move the pointer away and let it rest: two minutes later it dozes off again.
    await app.page.mouse.move(10, 10);
    await setClock(app, night + 3 * 60_000);
    await waitMood(app, "sleepy", 3000);
    // A message wakes it at once.
    await app.run(
      (await app.focusedId())!,
      "qutty-hook say Morning! --mood love",
    );
    await waitMood(app, "love");
    await setClock(app, null);
  });

  test("Settings: the reactions' toggles", async (app) => {
    await quick(app);
    const shell = (await app.focusedId())!;
    await app.openSettings();
    for (const key of ["celebrate", "sad"]) {
      await app.click(`[data-testid=setting-companion-${key}]`);
    }
    await app.closeSettings();
    await record(app);
    await job(app, shell, "1.2 0 make");
    await job(app, shell, "1.2 1 make");
    await pause(500);
    const seen = await record(app, false);
    assert(
      !seen.some((s) => s === "data-mood=success" || s === "data-mood=sad"),
      seen.join(" "),
    );
    // Celebrate on, the line off: the hop without the line.
    await app.openSettings();
    await app.click("[data-testid=setting-companion-celebrate]");
    await app.click("[data-testid=setting-companion-reactBubble]");
    await app.closeSettings();
    await job(app, shell, "1.2 0 make");
    await waitMood(app, "success");
    assertEquals(await reactionLine(app), null);
    // Sleepy off: no sleep at night.
    await app.openSettings();
    await app.click("[data-testid=setting-companion-nightSleepy]");
    await app.closeSettings();
    await waitMood(app, "neutral", 5000);
    await app.page.mouse.move(10, 10);
    await setClock(app, tomorrowAt(3));
    await pause(800);
    assertEquals((await looks(app)).mood, "neutral");
    await setClock(app, null);
    const s = (await app.settings()).companion;
    assertEquals(
      [s.celebrate, s.sad, s.reactBubble, s.nightSleepy],
      [true, false, false, false],
    );
  });

  test("screenshots: sleepy, celebrate and sad", async (app) => {
    await quick(app);
    const shell = (await app.focusedId())!;
    await app.page.mouse.move(10, 10);
    await setClock(app, tomorrowAt(2));
    await waitMood(app, "sleepy", 3000);
    await pause(900);
    await shot(app, "sleepy");
    // Daytime (the real clock may be at night where the suite runs).
    await setClock(app, tomorrowAt(14));
    await waitMood(app, "neutral", 3000);
    await job(app, shell, "1.2 0 cargo test");
    await waitMood(app, "success");
    await pause(1400); // after the hop: the success face and the line
    await shot(app, "celebrate");
    await waitMood(app, "neutral", 5000);
    await job(app, shell, "1.2 2 make all");
    await waitMood(app, "sad");
    await pause(700);
    await shot(app, "sad");
  });
});
