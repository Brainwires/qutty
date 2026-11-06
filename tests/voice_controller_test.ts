// Push-to-talk (lib/voice/controller.ts) over a fake STT engine: barge-in on press, the transcript
// routed on release (answer → the companion, the summary phrase, dictate → the focused tile),
// review (Send / Edit / Cancel), the latch click, a release while the mic is still starting,
// cancel, and engines that cannot run.

import { assert, assertEquals } from "@std/assert";
import {
  type SttEngine,
  VoiceController,
  type VoiceState,
} from "../lib/voice/controller.ts";

/** A scripted engine: it returns `transcript` on stop. */
class FakeStt implements SttEngine {
  readonly id = "fake" as const;
  starts = 0;
  stops = 0;
  cancels = 0;
  transcript = "";
  unavailable: string | undefined;
  startGate: Promise<void> = Promise.resolve();
  probe() {
    return Promise.resolve(
      this.unavailable
        ? { ok: false as const, reason: this.unavailable }
        : { ok: true as const },
    );
  }
  async start() {
    this.starts++;
    await this.startGate;
  }
  stop() {
    this.stops++;
    return Promise.resolve(this.transcript);
  }
  cancel() {
    this.cancels++;
    return Promise.resolve();
  }
}

function setup(settings = { review: false, dictate: false }, focused = true) {
  const stt = new FakeStt();
  const log: string[] = [];
  const states: VoiceState[] = [];
  const c = new VoiceController({
    engine: () => stt,
    settings: () => settings,
    bargeIn: () => log.push("barge-in"),
    toCompanion: (t) => log.push(`companion: ${t}`),
    summarize: () => log.push("summarize"),
    dictate: (t) => {
      log.push(`dictate: ${t}`);
      return focused;
    },
    onState: (s) => states.push(s),
  });
  return { stt, log, states, c, settings };
}

Deno.test("push-to-talk: press barges in, release sends what was said to the companion", async () => {
  const { stt, log, c } = setup();
  stt.transcript = "Tell the Codex tile to run the tests.";
  await c.press();
  assertEquals(c.state.phase, "listening");
  assertEquals(log, ["barge-in"]);
  await c.release(1200);
  assertEquals(stt.stops, 1);
  assertEquals(log, [
    "barge-in",
    "companion: Tell the Codex tile to run the tests.",
  ]);
  assertEquals(c.state.phase, "idle");
});

Deno.test("push-to-talk: the summary phrase, dictate mode, nothing heard", async () => {
  const a = setup();
  a.stt.transcript = "What's going on?";
  await a.c.press();
  await a.c.release(900);
  assertEquals(a.log.at(-1), "summarize");

  const b = setup({ review: false, dictate: true });
  b.stt.transcript = "git status.";
  await b.c.press();
  await b.c.release(900);
  assertEquals(b.log.at(-1), "dictate: git status");

  const none = setup({ review: false, dictate: true }, false);
  none.stt.transcript = "ls";
  await none.c.press();
  await none.c.release(900);
  assertEquals(none.c.state.message, "No tile has the focus to type into.");

  const empty = setup();
  empty.stt.transcript = "[BLANK_AUDIO]";
  await empty.c.press();
  await empty.c.release(900);
  assertEquals(empty.c.state.phase, "idle");
  assertEquals(empty.c.state.message, "I didn't catch that.");
  assertEquals(empty.log, ["barge-in"]);
});

Deno.test("push-to-talk: review — Send (as edited), Cancel", async () => {
  const { stt, log, c } = setup({ review: true, dictate: false });
  stt.transcript = "restart the dev server";
  await c.press();
  await c.release(800);
  assertEquals(c.state.phase, "review");
  assertEquals(c.state.transcript, "restart the dev server");
  assertEquals(c.state.target, "companion");
  assertEquals(log, ["barge-in"], "nothing is sent before review");
  c.send("restart the dev server in tile 2");
  assertEquals(log.at(-1), "companion: restart the dev server in tile 2");
  assertEquals(c.state.phase, "idle");

  await c.press();
  await c.release(800);
  await c.cancel();
  assertEquals(c.state.phase, "idle");
  assertEquals(log.filter((l) => l.startsWith("companion")).length, 1);
  assertEquals(
    stt.cancels,
    0,
    "a transcript under review needs no engine cancel",
  );
  // Send outside review does nothing.
  c.send("stray");
  assertEquals(log.filter((l) => l.startsWith("companion")).length, 1);
});

Deno.test("push-to-talk: review in dictate mode types the edited text", async () => {
  const { stt, log, c } = setup({ review: true, dictate: true });
  stt.transcript = "npm test.";
  await c.press();
  await c.release(800);
  assertEquals(c.state.target, "dictate");
  assertEquals(c.state.transcript, "npm test");
  c.send("npm run test.");
  assertEquals(log.at(-1), "dictate: npm run test");
});

Deno.test("push-to-talk: a short click latches; the next press stops", async () => {
  const { stt, log, c } = setup();
  stt.transcript = "hello";
  await c.press();
  await c.release(120);
  assertEquals(c.state.phase, "listening");
  assert(c.state.latched);
  await c.press(); // the second click
  assertEquals(log.at(-1), "companion: hello");
  await c.release(80); // its pointer-up: ignored
  assertEquals(stt.stops, 1);
});

Deno.test("push-to-talk: let go while the mic starts — it stops once it listens", async () => {
  const { stt, log, c } = setup();
  stt.transcript = "quick";
  let open!: () => void;
  stt.startGate = new Promise((r) => (open = r));
  const pressed = c.press();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(c.state.phase, "starting");
  await c.release(900);
  open();
  await pressed;
  assertEquals(log.at(-1), "companion: quick");
});

Deno.test("push-to-talk: cancel drops the audio; a cancel mid-start is honoured", async () => {
  const { stt, log, c } = setup();
  await c.press();
  await c.cancel();
  assertEquals(stt.cancels, 1);
  assertEquals(c.state.phase, "idle");
  let open!: () => void;
  stt.startGate = new Promise((r) => (open = r));
  const pressed = c.press();
  await new Promise((r) => setTimeout(r, 0));
  await c.cancel();
  open();
  await pressed;
  assertEquals(c.state.phase, "idle");
  assertEquals(stt.cancels, 3, "cancelled while starting, then once started");
  assertEquals(log, ["barge-in", "barge-in"]);
});

Deno.test("push-to-talk: an engine that cannot run says why", async () => {
  const { stt, c } = setup();
  stt.unavailable = "the speech model (57 MB) is not downloaded yet";
  await c.press();
  assertEquals(c.state.phase, "error");
  assertEquals(c.state.message, stt.unavailable);
  assertEquals(stt.starts, 0);
  // The next press tries again.
  stt.unavailable = undefined;
  await c.press();
  assertEquals(c.state.phase, "listening");
});

Deno.test("push-to-talk: Summarize barges in and asks", () => {
  const { log, c } = setup();
  c.summarize();
  assertEquals(log, ["barge-in", "summarize"]);
});
