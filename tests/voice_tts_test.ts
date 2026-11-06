// The speech queue (lib/voice/tts.ts): one thing said at a time in order, each turn once, barge-in
// stops what is said and drops the rest, an engine error moves on; and which companion updates
// are read aloud, made sayable.

import { assert, assertEquals } from "@std/assert";
import {
  answerToSpeak,
  speakableText,
  type SpeakOptions,
  SpeechQueue,
  type TtsEngine,
} from "../lib/voice/tts.ts";
import type { CompanionUpdate } from "../lib/companion/protocol.ts";

/** An engine the test finishes by hand. */
class FakeTts implements TtsEngine {
  readonly id = "fake";
  said: { text: string; options: SpeakOptions }[] = [];
  stops = 0;
  #pending: (() => void)[] = [];
  failNext = false;
  speak(text: string, options: SpeakOptions): Promise<void> {
    this.said.push({ text, options });
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("engine broke"));
    }
    return new Promise((resolve) => this.#pending.push(resolve));
  }
  stop(): Promise<void> {
    this.stops++;
    for (const r of this.#pending.splice(0)) r();
    return Promise.resolve();
  }
  /** The current utterance ends. */
  finish(): void {
    this.#pending.shift()?.();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function queueWith(engine: FakeTts, max?: number) {
  const speaking: boolean[] = [];
  const errors: unknown[] = [];
  const queue = new SpeechQueue({
    engine: () => engine,
    options: () => ({ rate: 1.2, volume: 0.5 }),
    onSpeaking: (on) => speaking.push(on),
    onError: (e) => errors.push(e),
    ...(max ? { maxQueued: max } : {}),
  });
  return { queue, speaking, errors };
}

Deno.test("speech queue: one at a time, in order, with the settings", async () => {
  const tts = new FakeTts();
  const { queue, speaking } = queueWith(tts);
  queue.say("first");
  queue.say("second", "alert");
  assertEquals(tts.said.map((s) => s.text), ["first"]);
  assertEquals(tts.said[0].options, { rate: 1.2, volume: 0.5 });
  assert(queue.speaking);
  assertEquals(queue.pending, 1);
  tts.finish();
  await tick();
  assertEquals(tts.said.map((s) => s.text), ["first", "second"]);
  tts.finish();
  await tick();
  assert(!queue.speaking);
  assertEquals(speaking, [true, true, false]);
});

Deno.test("speech queue: each key is said once; blank text is not said", async () => {
  const tts = new FakeTts();
  const { queue } = queueWith(tts);
  queue.say("answer", "answer", "turn:1");
  queue.say("answer again", "answer", "turn:1");
  queue.say("   ");
  tts.finish();
  await tick();
  assertEquals(tts.said.map((s) => s.text), ["answer"]);
});

Deno.test("speech queue: barge-in stops the speech and drops the queue", async () => {
  const tts = new FakeTts();
  const { queue, speaking } = queueWith(tts);
  queue.say("a long answer");
  queue.say("then this");
  queue.say("and this", "alert");
  await queue.interrupt();
  assertEquals(tts.stops, 1);
  assert(!queue.speaking);
  assertEquals(queue.pending, 0);
  await tick();
  // The stopped utterance settling does not start the dropped ones.
  assertEquals(tts.said.map((s) => s.text), ["a long answer"]);
  assertEquals(speaking, [true, false]);
  // Speaking resumes with the next thing said.
  queue.say("after");
  assertEquals(tts.said.map((s) => s.text), ["a long answer", "after"]);
  // Interrupting with nothing said does not call the engine.
  tts.finish();
  await tick();
  await queue.interrupt();
  assertEquals(tts.stops, 1);
});

Deno.test("speech queue: an engine error moves on; the oldest alert goes first when full", async () => {
  const tts = new FakeTts();
  const { queue, errors } = queueWith(tts, 2);
  tts.failNext = true;
  queue.say("broken");
  await tick();
  await tick();
  assertEquals(errors.length, 1);
  assert(!queue.speaking);
  queue.say("now"); // speaking
  queue.say("alert 1", "alert");
  queue.say("answer");
  queue.say("alert 2", "alert"); // full: alert 1 is dropped
  assertEquals(queue.pending, 2);
  for (let i = 0; i < 3; i++) {
    tts.finish();
    await tick();
  }
  assertEquals(tts.said.map((s) => s.text), [
    "broken",
    "now",
    "answer",
    "alert 2",
  ]);
});

Deno.test("speakable text: markdown, code and links are not read out", () => {
  assertEquals(
    speakableText(
      "## Status\n- **claude** runs `npm test`\n- see [the docs](https://x.y)\n```sh\nrm -rf\n```\nDone: https://example.com/a",
    ),
    "Status claude runs npm test see the docs (code) Done: a link",
  );
  const long = "This sentence is short. ".repeat(40);
  const cut = speakableText(long);
  assert(cut.length <= 600 && cut.endsWith("."), cut);
});

const turn = (patch: Partial<Extract<CompanionUpdate, { kind: "turn" }>>) =>
  ({
    kind: "turn",
    turn: 4,
    source: "user",
    text: "Two tiles are idle.",
    done: true,
    ...patch,
  }) as CompanionUpdate;

Deno.test("answers read aloud: finished user turns only, while Speak answers is on", () => {
  const on = { speakAnswers: true };
  assertEquals(answerToSpeak(turn({}), on), {
    key: "turn:4",
    text: "Two tiles are idle.",
  });
  assertEquals(answerToSpeak(turn({}), { speakAnswers: false }), null);
  assertEquals(answerToSpeak(turn({ done: false }), on), null);
  assertEquals(answerToSpeak(turn({ isError: true }), on), null);
  assertEquals(answerToSpeak(turn({ source: "mail" }), on), null);
  assertEquals(answerToSpeak(turn({ quiet: true }), on), null);
  assertEquals(answerToSpeak(turn({ text: "  " }), on), null);
  assertEquals(
    answerToSpeak({ kind: "tool", turn: 4, name: "read_screen" }, on),
    null,
  );
});
