// The voice layer against the demo backend, with fake engines (lib/voice/client.ts
// `createDemoVoice`: scripted transcripts, no microphone; a timed TTS that records what it says):
// the mic button's hold / latch states, the hold-to-talk key (never reaching the terminal), the
// transcript review (Send / Edit / Cancel), dictate mode, spoken answers and barge-in, the
// Summarize button, spoken event alerts, and Settings → Voice.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { launchAgent } from "./agent_helpers.ts";
import { SETTINGS_STORAGE_KEY } from "../../lib/workspace/store.ts";
import type { VoiceSettings } from "../../lib/voice/settings.ts";
import type { DemoVoiceScript } from "../../lib/voice/client.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const MIC = "[data-testid=loopy-mic]";
const REVIEW = "[data-testid=voice-review]";
const BUBBLE_TEXT = "[data-testid=loopy-bubble-text]";

/** Settings → Voice as given (persisted, then the page reloaded). */
async function withVoice(app: App, patch: Partial<VoiceSettings>) {
  const settings = await app.settings();
  settings.voice = { ...settings.voice, ...patch };
  await app.eval(
    (k: string, v: string) => localStorage.setItem(k, v),
    SETTINGS_STORAGE_KEY,
    JSON.stringify(settings),
  );
  await app.reload();
  await waitFor(() => app.exists(MIC), 3000, "the mic button");
}

/** The demo's voice script (`window.__e2eVoice`). */
function script(app: App): Promise<DemoVoiceScript> {
  return app.eval(() =>
    (globalThis as unknown as { __e2eVoice: DemoVoiceScript }).__e2eVoice
  );
}

/** The next capture returns `text`. */
function willHear(app: App, text: string, msPerChar?: number) {
  return app.eval(
    (t: string, ms: number | null) => {
      const s = (globalThis as unknown as { __e2eVoice: DemoVoiceScript })
        .__e2eVoice;
      s.transcripts.push(t);
      if (ms !== null) s.msPerChar = ms;
    },
    text,
    msPerChar ?? null,
  );
}

async function center(app: App, selector: string) {
  return await app.eval((s: string) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

/** Hold the mic button for `ms`. */
async function holdMic(app: App, ms = 500) {
  const { x, y } = await center(app, MIC);
  await app.page.mouse.move(x, y);
  await app.page.mouse.down();
  await waitFor(
    async () => await app.attr(MIC, "data-phase") === "listening",
    2000,
    "listening",
  );
  await new Promise((r) => setTimeout(r, ms));
  await app.page.mouse.up();
}

function bubbleText(app: App, includes: string, ms = 5000) {
  return waitFor(
    async () => {
      const t = await app.eval(
        (s: string) => document.querySelector(s)?.textContent ?? "",
        BUBBLE_TEXT,
      );
      return t.includes(includes) ? t : null;
    },
    ms,
    `the bubble saying ${includes}`,
  );
}

suite("voice", (test) => {
  test("hold the mic: listening, then the transcript waits for review; Send asks Loopy", async (app) => {
    await waitFor(() => app.exists(MIC), 3000, "the mic button");
    assertEquals(await app.attr(MIC, "data-phase"), "idle");
    await willHear(app, "What is in tile 1?");
    await holdMic(app);
    await waitFor(() => app.exists(REVIEW), 3000, "the review box");
    assertEquals(await app.attr(REVIEW, "data-target"), "companion");
    assertEquals(
      await app.eval(
        () =>
          document.querySelector<HTMLInputElement>(
            "[data-testid=voice-review-text]",
          )!.value,
      ),
      "What is in tile 1?",
    );
    assertEquals((await script(app)).starts, ["local"]);
    await app.click("[data-testid=voice-review-send]");
    await bubbleText(app, "Tile 1 is");
    assert(!(await app.exists(REVIEW)));
  });

  test("review: Edit changes what is sent; Cancel sends nothing", async (app) => {
    await waitFor(() => app.exists(MIC), 3000, "the mic button");
    await willHear(app, "what is in tile 7");
    await holdMic(app);
    await waitFor(() => app.exists(REVIEW), 3000, "the review box");
    await app.click("[data-testid=voice-review-edit]");
    await app.eval(() => {
      const i = document.querySelector<HTMLInputElement>(
        "[data-testid=voice-review-text]",
      )!;
      i.select();
    });
    await app.page.keyboard.type("what is in tile 1");
    await app.click("[data-testid=voice-review-send]");
    await bubbleText(app, "Tile 1 is");

    await willHear(app, "never mind");
    await holdMic(app);
    await waitFor(() => app.exists(REVIEW), 3000, "the review box");
    await app.click("[data-testid=voice-review-cancel]");
    assert(!(await app.exists(REVIEW)));
    await new Promise((r) => setTimeout(r, 400));
    const text = await app.eval(
      (s: string) => document.querySelector(s)?.textContent ?? "",
      BUBBLE_TEXT,
    );
    assert(!text.includes("never mind"), text);
  });

  test("a short click latches listening; the next click stops", async (app) => {
    await waitFor(() => app.exists(MIC), 3000, "the mic button");
    await willHear(app, "latched words");
    await app.click(MIC);
    await waitFor(
      async () => await app.attr(MIC, "data-latched") === "true",
      2000,
      "latched",
    );
    assertEquals(await app.attr(MIC, "data-phase"), "listening");
    assertEquals(await app.attr(OVERLAY, "data-voice"), "listening");
    // The listening mic pulses (App.click waits for stillness): click its centre.
    const { x, y } = await center(app, MIC);
    await app.clickAt(x, y);
    await waitFor(() => app.exists(REVIEW), 3000, "the review box");
  });

  test("the hold-to-talk key listens and never reaches the terminal", async (app) => {
    const id = (await app.focusedId())!;
    await app.focusTerminalInput(id);
    const before = await app.lastLine(id);
    await willHear(app, "from the keyboard");
    const kb = app.page.keyboard;
    await kb.down(app.mod);
    await kb.down("Shift");
    await kb.down("KeyM" as never);
    await waitFor(
      async () => await app.attr(MIC, "data-phase") === "listening",
      2000,
      "listening",
    );
    await new Promise((r) => setTimeout(r, 400));
    await kb.up("KeyM" as never);
    await kb.up("Shift");
    await kb.up(app.mod);
    await waitFor(() => app.exists(REVIEW), 3000, "the review box");
    assertEquals(await app.lastLine(id), before, "nothing typed into the tile");
    await app.click("[data-testid=voice-review-cancel]");
    assert(!(await app.exists(REVIEW)));
  });

  test("dictate mode types the transcript into the focused tile, with no model", async (app) => {
    await withVoice(app, { dictate: true, review: false });
    const id = (await app.focusedId())!;
    await willHear(app, "echo dictated words.");
    await holdMic(app);
    await app.waitForText(id, "echo dictated words");
    // Typed, not run: no Enter.
    assertStringIncludes(await app.lastLine(id), "echo dictated words");
    assertEquals((await script(app)).spoken, []);
  });

  test("answers are read aloud; pressing the mic stops the speech (barge-in)", async (app) => {
    await withVoice(app, { speakAnswers: true, review: false });
    await willHear(app, "What is in tile 1?", 300);
    await holdMic(app);
    await bubbleText(app, "Tile 1 is");
    await waitFor(
      async () => await app.attr(OVERLAY, "data-speaking") === "true",
      5000,
      "speaking",
    );
    assert(await app.exists("[data-testid=loopy-stop-speaking]"));
    const spoken = (await script(app)).spoken;
    assertEquals(spoken.length, 1);
    assertStringIncludes(spoken[0], "Tile 1 is");
    // Talking over it stops it.
    await willHear(app, "and tile 2?", 20);
    await holdMic(app, 200);
    await waitFor(
      async () => await app.attr(OVERLAY, "data-speaking") === "false",
      2000,
      "stopped speaking",
    );
    assert((await script(app)).stops >= 1);
  });

  test("Summarize asks Loopy about every tile, and the answer is spoken", async (app) => {
    await withVoice(app, { speakAnswers: true });
    await app.click("[data-testid=loopy-summarize]");
    await bubbleText(app, "tile");
    const text = await bubbleText(app, " is ");
    assert(/\d+ tiles?:/.test(text), text);
    await waitFor(
      async () => (await script(app)).spoken.length > 0,
      5000,
      "the summary spoken",
    );
  });

  test("spoken alerts: an agent finished, a build failed", async (app) => {
    await withVoice(app, { alertFinished: true, alertBuildFailed: true });
    const claude = await launchAgent(app, "claude");
    await app.typeInTerminal(claude, "do something\r");
    await waitFor(
      async () =>
        (await script(app)).spoken.find((s) => s.endsWith("finished.")) ?? null,
      5000,
      "the finished alert",
    );
    await app.typeInTerminal(claude, "/fail build\r");
    const said = await waitFor(
      async () =>
        (await script(app)).spoken.find((s) => s.includes("build failed")) ??
          null,
      5000,
      "the build-failed alert",
    );
    assertStringIncludes(said, "claude");
  });

  test("Settings → Voice: toggles persist; the engine status shows", async (app) => {
    await app.openSettings();
    await waitFor(
      () => app.exists("[data-testid=voice-settings]"),
      2000,
      "the section",
    );
    await app.click("[data-testid=setting-voice-speak]");
    await waitFor(
      async () => (await app.settings()).voice.speakAnswers,
      2000,
      "speakAnswers saved",
    );
    await app.click("[data-testid=setting-voice-dictate]");
    await waitFor(
      async () => (await app.settings()).voice.dictate,
      2000,
      "dictate saved",
    );
    const lib = await waitFor(
      () =>
        app.eval(() =>
          document.querySelector("[data-testid=voice-lib-status]")
            ?.textContent ?? null
        ),
      3000,
      "the library status",
    );
    assertStringIncludes(lib, "demo");
    const keys = await app.eval(() =>
      [
        ...document.querySelectorAll<HTMLOptionElement>(
          "[data-testid=setting-voice-ptt] option",
        ),
      ].map((o) => o.value)
    );
    assertEquals(
      keys,
      app.platform === "mac"
        ? ["Mod+Shift+M", "Mod+Shift+K", "Mod+Shift+Space", "off"]
        : ["Mod+Shift+M", "Mod+Shift+K", "off"],
    );
    // Push-to-talk off: the key no longer listens.
    await app.eval(() => {
      const s = document.querySelector<HTMLSelectElement>(
        "[data-testid=setting-voice-ptt]",
      )!;
      s.value = "off";
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(
      async () => (await app.settings()).voice.pttKey === "off",
      2000,
      "ptt off saved",
    );
  });
});
