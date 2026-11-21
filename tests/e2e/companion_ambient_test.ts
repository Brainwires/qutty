// The companion's own lines and voice mode against the demo backend (lib/companion/ambient.ts,
// lib/voice/bubble-speech.ts). The harness counts today's quote as shown in every other suite;
// the cases here that want it open with `quote: true`. The app's clock is moved for the day
// rollover (`window.__e2e.setClock`), and `qutty:encourage` makes the next encouraging line due
// now (lib/test-hooks.ts). The demo's voice is a fake engine that records what it says
// (`window.__e2eVoice.spoken`).
//
// Covers: the quote of the day at startup with its author, "Another", once a day across a
// reload; a new day's quote at the first interaction after midnight (and not before it);
// encouragement off by default, then on in Settings and appearing when due, never over another
// bubble; voice mode: every bubble said aloud (a `say` message, the quote with its author, an
// answer), closing a bubble stops its speech, the speaker button and both Settings checkboxes
// are one setting.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { QUOTE_DAY_KEY } from "../../lib/companion/ambient.ts";
import { SETTINGS_STORAGE_KEY } from "../../lib/workspace/store.ts";
import type { VoiceSettings } from "../../lib/voice/settings.ts";
import type { DemoVoiceScript } from "../../lib/voice/client.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const BUBBLE = "[data-testid=companion-bubble]";
const VOICE_MODE = "[data-testid=companion-voice-mode]";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The bubble on screen: its id, text and attribution (`null`: none). */
function bubble(app: App) {
  return app.eval((s: string) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) return null;
    return {
      id: el.dataset.messageId ?? "",
      text: el.querySelector("[data-testid=companion-bubble-text]")
        ?.textContent ?? "",
      cite: el.querySelector("[data-testid=companion-bubble-cite]")
        ?.textContent ?? null,
    };
  }, BUBBLE);
}

/** Wait for a bubble whose id starts with `prefix`. */
function waitBubble(app: App, prefix: string, what: string, ms = 5000) {
  return waitFor(
    async () => {
      const b = await bubble(app);
      return b?.id.startsWith(prefix) ? b : null;
    },
    ms,
    what,
  );
}

/** Today's local day key, as the page sees it. */
function today(app: App, offsetDays = 0): Promise<string> {
  return app.eval((n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }, offsetDays);
}

/** Move the app's clock (`null`: back to the real time). */
function setClock(app: App, ms: number | null) {
  return app.eval((v: number | null) => {
    (globalThis as unknown as {
      __e2e: { setClock(ms: number | null): void };
    }).__e2e.setClock(v);
  }, ms);
}

/** The demo's voice script. */
function voiceScript(app: App): Promise<DemoVoiceScript> {
  return app.eval(() =>
    (globalThis as unknown as { __e2eVoice: DemoVoiceScript }).__e2eVoice
  );
}

/** Voice settings patched in storage, then a reload. */
async function withVoice(app: App, patch: Partial<VoiceSettings>) {
  const settings = await app.settings();
  settings.voice = { ...settings.voice, ...patch };
  await app.eval(
    (k: string, v: string) => localStorage.setItem(k, v),
    SETTINGS_STORAGE_KEY,
    JSON.stringify(settings),
  );
  await app.reload();
  await waitFor(() => app.exists(OVERLAY), 3000, "the overlay");
}

/** Make the next encouraging line due now. */
function encourageNow(app: App) {
  return app.eval(() => {
    globalThis.dispatchEvent(new Event("qutty:encourage"));
  });
}

/** Turn Settings → Companion → Encouragement on (through its checkbox). */
async function turnOnEncouragement(app: App) {
  await app.openSettings("companion");
  const box = "[data-testid=setting-companion-encourage]";
  await waitFor(() => app.exists(box), 2000, "the Encouragement checkbox");
  assertEquals(
    await app.eval(
      (s: string) => document.querySelector<HTMLInputElement>(s)!.checked,
      box,
    ),
    false,
    "off by default",
  );
  await app.click(box);
  await waitFor(
    async () => (await app.settings()).companion.encourage,
    2000,
    "encouragement on",
  );
  await app.closeSettings();
}

suite("companion quote and encouragement", (test) => {
  test(
    "the quote of the day at startup, with its author; Another; once a day",
    async (app) => {
      const day = await today(app);
      const first = await waitBubble(app, `quote:${day}:`, "the startup quote");
      assertEquals(first.id, `quote:${day}:0`);
      assert(first.text.length > 0);
      assert(first.cite?.startsWith("— "), `attribution: ${first.cite}`);
      await app.click('[data-testid=companion-action][data-action="Another"]');
      const next = await waitBubble(app, `quote:${day}:1`, "another quote");
      assert(next.text !== first.text, "another quote");
      await app.click("[data-testid=companion-bubble-close]");
      // Recorded for the day: a reload (a second window, a restart) does not show it again.
      const claim = await app.eval(
        (k: string) => JSON.parse(localStorage.getItem(k) ?? "null"),
        QUOTE_DAY_KEY,
      );
      assertEquals(claim.day, day);
      await app.reload();
      await waitFor(() => app.exists(OVERLAY), 3000, "the overlay again");
      await pause(2500);
      assertEquals(await bubble(app), null);
    },
    { quote: true },
  );

  test(
    "a new day's quote at the first interaction after midnight",
    async (app) => {
      const day = await today(app);
      await waitBubble(app, `quote:${day}:`, "the startup quote");
      await app.click("[data-testid=companion-bubble-close]");
      // The clock passes midnight: nothing yet, no timer shows it.
      const tomorrow = await app.eval(() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d.getTime();
      });
      await setClock(app, tomorrow);
      await pause(1500);
      assertEquals(await bubble(app), null);
      // The first interaction (a key press anywhere) brings it, passively.
      const next = await today(app, 1);
      await app.eval(() => {
        globalThis.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Shift" }),
        );
      });
      const quote = await waitBubble(
        app,
        `quote:${next}:0`,
        "tomorrow's quote",
      );
      assert(quote.cite);
      await app.click("[data-testid=companion-bubble-close]");
      // Only once that day.
      await app.eval(() => {
        globalThis.dispatchEvent(new Event("focus"));
      });
      await pause(500);
      assertEquals(await bubble(app), null);
      await setClock(app, null);
    },
    { quote: true },
  );

  test("encouragement: off by default; on, a line when due, never over another bubble", async (app) => {
    await encourageNow(app);
    await pause(1500);
    assertEquals(await bubble(app), null, "off by default");
    await turnOnEncouragement(app);
    // A message on screen: the line waits.
    const shell = (await app.focusedId())!;
    await app.run(shell, "qutty-hook say Tests passed --timeout 0");
    await waitBubble(app, "", "the message");
    // No keystroke in the last few seconds either.
    await pause(5500);
    await encourageNow(app);
    await pause(800);
    assertEquals((await bubble(app))?.text, "Tests passed");
    await app.click("[data-testid=companion-bubble-close]");
    await waitFor(async () => (await bubble(app)) === null, 2000, "closed");
    await pause(5500);
    await encourageNow(app);
    const line = await waitBubble(app, "cheer:", "an encouraging line");
    assert(line.text.length > 0);
    assertEquals(line.cite, null);
  });
});

suite("companion voice mode", (test) => {
  test("voice mode says the bubble aloud; closing it stops the speech", async (app) => {
    await withVoice(app, { voiceMode: true });
    const shell = (await app.focusedId())!;
    await app.run(shell, "qutty-hook say Tests passed");
    await waitFor(
      async () => (await voiceScript(app)).spoken.includes("Tests passed"),
      4000,
      "the message said",
    );
    await app.click("[data-testid=companion-bubble-close]");
    // A long message, closed while it is said: the speech stops.
    await app.eval(() => {
      (globalThis as unknown as { __e2eVoice: DemoVoiceScript }).__e2eVoice
        .msPerChar = 200;
    });
    await app.run(
      shell,
      "qutty-hook say This is a long message that takes a while to say aloud",
    );
    await waitFor(
      async () => await app.attr(OVERLAY, "data-speaking") === "true",
      4000,
      "speaking",
    );
    const stops = (await voiceScript(app)).stops;
    await app.click("[data-testid=companion-bubble-close]");
    await waitFor(
      async () => await app.attr(OVERLAY, "data-speaking") === "false",
      2000,
      "stopped",
    );
    assert((await voiceScript(app)).stops > stops);
  });

  test(
    "voice mode reads an answer and the quote of the day with its author",
    async (app) => {
      await withVoice(app, { voiceMode: true });
      const day = await today(app);
      const quote = await waitBubble(app, `quote:${day}:`, "the quote", 6000);
      const author = quote.cite!.replace(/^— /, "");
      await waitFor(
        async () =>
          (await voiceScript(app)).spoken.some((s) =>
            s.endsWith(`— ${author}`)
          ),
        4000,
        "the quote said with its author",
      );
      await app.click("[data-testid=companion-bubble-close]");
      await app.click("[data-testid=companion-poke]");
      await waitFor(
        () => app.exists("[data-testid=companion-chat-input]"),
        2000,
        "the chat box",
      );
      await app.page.keyboard.type("What is in tile 1?");
      await app.press("Enter");
      await waitFor(
        async () =>
          (await voiceScript(app)).spoken.some((s) =>
            s.startsWith("Tile 1 is")
          ),
        6000,
        "the answer said",
      );
      // Said once (the bubble), not twice (the old answer path stays quiet in voice mode).
      const spoken = (await voiceScript(app)).spoken;
      assertEquals(spoken.filter((s) => s.startsWith("Tile 1 is")).length, 1);
    },
    { quote: true },
  );

  test("the speaker button and both Settings checkboxes are one setting", async (app) => {
    await waitFor(() => app.exists(VOICE_MODE), 3000, "the speaker button");
    assertEquals(await app.attr(VOICE_MODE, "aria-pressed"), "false");
    await app.click(VOICE_MODE);
    await waitFor(
      async () => (await app.settings()).voice.voiceMode,
      2000,
      "voice mode on",
    );
    assertEquals(await app.attr(VOICE_MODE, "aria-pressed"), "true");
    const checked = (s: string) =>
      app.eval(
        (sel: string) => document.querySelector<HTMLInputElement>(sel)!.checked,
        s,
      );
    await app.openSettings("companion");
    const inCompanion = "[data-testid=setting-companion-voiceMode]";
    await waitFor(() => app.exists(inCompanion), 2000, "the checkbox");
    assertEquals(await checked(inCompanion), true);
    await app.click(inCompanion);
    await waitFor(
      async () => !(await app.settings()).voice.voiceMode,
      2000,
      "voice mode off",
    );
    await app.openSettings("voice");
    const inVoice = "[data-testid=setting-voice-mode]";
    await waitFor(() => app.exists(inVoice), 2000, "the Voice checkbox");
    assertEquals(await checked(inVoice), false);
    await app.click(inVoice);
    await waitFor(
      async () => (await app.settings()).voice.voiceMode,
      2000,
      "voice mode on again",
    );
    // Voice mode includes Speak answers.
    const speak = "[data-testid=setting-voice-speak]";
    assertEquals(await checked(speak), true);
    assert(
      (await app.attr(speak, "disabled")) !== null,
      "Speak answers grayed",
    );
    await app.closeSettings();
  });
});
