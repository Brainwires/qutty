// Voice mode (lib/voice/bubble-speech.ts, lib/voice/speaker.ts, lib/voice/tts.ts): what each
// bubble says, the text cleaning, streamed replies said sentence by sentence, cut-off when a new
// bubble replaces the old one or the user barges in, and one speaking window across several.

import { assert, assertEquals } from "@std/assert";
import {
  bubbleSpeech,
  MAX_STREAM_SPOKEN,
  planBubbleSpeech,
  REST_ON_SCREEN,
  StreamSpeech,
} from "../lib/voice/bubble-speech.ts";
import { answerToSpeak, cleanSpeech } from "../lib/voice/tts.ts";
import {
  claimSpeaker,
  isSpeaker,
  readSpeaker,
  releaseSpeaker,
  type SpeakerStore,
} from "../lib/voice/speaker.ts";
import type { CompanionMessage } from "../lib/companion/messages.ts";
import { askBubble, turnBubble } from "../lib/companion/bubbles.ts";
import { quoteBubble } from "../lib/companion/ambient.ts";
import { DEFAULT_VOICE, sanitizeVoice } from "../lib/voice/settings.ts";
import type { CompanionUpdate } from "../lib/companion/protocol.ts";

const say = (patch: Partial<CompanionMessage> = {}): CompanionMessage => ({
  id: "m1",
  kind: "say",
  text: "Build finished.",
  mood: "neutral",
  actions: [],
  timeoutMs: 5000,
  ...patch,
});

type Turn = Extract<CompanionUpdate, { kind: "turn" }>;
const turn = (patch: Partial<Turn>): Turn => ({
  kind: "turn",
  turn: 3,
  source: "user",
  text: "",
  done: false,
  ...patch,
});

Deno.test("voice mode: settings: off by default, sanitised", () => {
  assertEquals(DEFAULT_VOICE.voiceMode, false);
  assertEquals(sanitizeVoice({ voiceMode: true }).voiceMode, true);
  assertEquals(sanitizeVoice({ voiceMode: "on" }).voiceMode, false);
  // Voice mode reads answers from the bubble: the old answer path stays quiet (no double voice).
  const done = turn({ text: "Two tiles are idle.", done: true });
  assertEquals(
    answerToSpeak(done, { speakAnswers: true, voiceMode: true }),
    null,
  );
  assert(answerToSpeak(done, { speakAnswers: true, voiceMode: false }));
});

Deno.test("voice mode: the text is cleaned: no markdown, code or URLs read out", () => {
  assertEquals(
    cleanSpeech(
      "## Done\n- **tests** pass, see [the log](https://x.y/z)\n```ts\nconst a = 1;\n```\nMore at https://example.com/a?b=c",
    ),
    "Done tests pass, see the log code omitted. More at a link",
  );
  assertEquals(cleanSpeech("Run `npm test` now."), "Run npm test now.");
  assertEquals(
    cleanSpeech(
      "Use `const veryLongName = someFunction(withArguments, andMore)`.",
    ),
    "Use code omitted.",
  );
  assertEquals(cleanSpeech("> quoted\n> line"), "quoted line");
  // A code block still streaming in (not closed yet) is not read either.
  assertEquals(cleanSpeech("Here:\n```sh\nrm -rf"), "Here: code omitted.");
});

Deno.test("voice mode: what each bubble says", () => {
  assertEquals(bubbleSpeech(say()), "Build finished.");
  const ask = askBubble(
    {
      id: "q1",
      fromName: "codex-2",
      text: "Deploy to **staging** now?",
      actions: ["Yes", "No"],
    } as Parameters<typeof askBubble>[0],
  );
  assertEquals(
    bubbleSpeech(ask),
    "codex-2 asks: Deploy to staging now? Options: Yes, No.",
  );
  // A lone OK button is not read out.
  assertEquals(
    bubbleSpeech({ ...ask, actions: [{ id: "a0", label: "OK" }] }),
    "codex-2 asks: Deploy to staging now?",
  );
  const quote = quoteBubble({
    text: "Simplify, simplify.",
    author: "Henry David Thoreau",
  }, "q");
  assertEquals(
    bubbleSpeech(quote),
    "Simplify, simplify. — Henry David Thoreau",
  );
  // Agents' mail turns and errors: a short summary.
  const long = "The build of tile 2 finished with three warnings. ".repeat(10);
  const mail = turnBubble(turn({ source: "mail", text: long, done: true }))!;
  assert(mail.brief);
  const brief = bubbleSpeech(mail);
  assert(brief.length <= 161, brief);
  assert(brief.startsWith("The build of tile 2 finished"));
  const error = turnBubble(
    turn({
      text: "Claude exited. Here is the whole log: ...",
      done: true,
      isError: true,
    }),
  )!;
  assert(
    bubbleSpeech(error).startsWith("Something went wrong: Claude exited."),
  );
  assertEquals(bubbleSpeech(say({ text: "```\ncode\n```" })), "code omitted.");
});

Deno.test("voice mode: a streamed reply is said sentence by sentence as it arrives", () => {
  const s = new StreamSpeech();
  assertEquals(s.next("…", false), []);
  assertEquals(s.next("Two tiles", false), []);
  assertEquals(s.next("Two tiles are idle. One", false), [
    "Two tiles are idle.",
  ]);
  assertEquals(s.next("Two tiles are idle. One runs", false), []);
  assertEquals(s.next("Two tiles are idle. One runs tests! And", false), [
    "One runs tests!",
  ]);
  assertEquals(s.next("Two tiles are idle. One runs tests! And done", true), [
    "And done",
  ]);
  assertEquals(
    s.next("Two tiles are idle. One runs tests! And done", true),
    [],
  );
});

Deno.test("voice mode: never in the middle of a code block; long replies stop with a note", () => {
  const s = new StreamSpeech();
  const a = "Try this.\n```sh\necho one. two.\n";
  assertEquals(s.next(a, false), ["Try this."]);
  assertEquals(s.next(`${a}echo three.\n`, false), []);
  assertEquals(s.next(`${a}echo three.\n\`\`\`\nThen run it. `, false), [
    "code omitted. Then run it.",
  ]);
  const long = new StreamSpeech();
  const sentence = "This is one more sentence of a very long answer. ";
  let text = "";
  const said: string[] = [];
  for (let i = 0; i < 60; i++) {
    text += sentence;
    said.push(...long.next(text, false));
  }
  assertEquals(said.at(-1), REST_ON_SCREEN);
  assertEquals(said.filter((x) => x === REST_ON_SCREEN).length, 1);
  const spoken = said.slice(0, -1).reduce((n, x) => n + x.length, 0);
  assert(spoken <= MAX_STREAM_SPOKEN, `${spoken}`);
});

Deno.test("voice mode: a new bubble cuts off the old one; a whole bubble is said once", () => {
  let plan = planBubbleSpeech(null, say({ id: "a", text: "First." }), 0);
  assertEquals(plan.steps, [{ text: "First.", replace: false }]);
  // Re-rendered with the same bubble: nothing more.
  plan = planBubbleSpeech(plan.saying, say({ id: "a", text: "First." }), 0);
  assertEquals(plan.steps, []);
  // The next bubble replaces it: cut off, then said.
  plan = planBubbleSpeech(plan.saying, say({ id: "b", text: "Second." }), 0);
  assertEquals(plan.steps, [{ text: "Second.", replace: true }]);
  // No bubble (it closed): nothing to say, the state stays for the next one.
  const idle = planBubbleSpeech(plan.saying, undefined, 0);
  assertEquals(idle.steps, []);
  assertEquals(idle.saying?.id, "b");
  // A streaming reply replacing it with nothing to say yet still cuts the old one off.
  const reply = turnBubble(turn({ turn: 9, text: "", done: false }))!;
  plan = planBubbleSpeech(idle.saying, reply, 0);
  assertEquals(plan.steps, [{ text: "", replace: true }]);
});

Deno.test("voice mode: after a barge-in the rest of a streaming reply stays quiet", () => {
  const first = turnBubble(turn({ text: "One. Two", done: false }))!;
  let plan = planBubbleSpeech(null, first, 4);
  assertEquals(plan.steps, [{ text: "One.", replace: false }]);
  const more = turnBubble(turn({ text: "One. Two. Three. ", done: false }))!;
  // The user talked (the cut count moved): nothing more of this reply.
  plan = planBubbleSpeech(plan.saying, more, 5);
  assertEquals(plan.steps, []);
  // The next bubble speaks again.
  plan = planBubbleSpeech(plan.saying, say({ id: "z", text: "Next." }), 5);
  assertEquals(plan.steps, [{ text: "Next.", replace: true }]);
});

/** A shared storage for the windows of a test. */
function sharedStore(): SpeakerStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

Deno.test("voice mode: one window speaks: the floating companion, else the last active window", () => {
  const s = sharedStore();
  const speakers = (focused: string, floatingShowing = false) =>
    ["w1", "w2", "w3"].filter((self) =>
      isSpeaker({
        self,
        holder: readSpeaker(s),
        floatingShowing,
        focused: self === focused,
      })
    );
  // Nobody claimed yet: the focused window.
  assertEquals(speakers("w2"), ["w2"]);
  claimSpeaker(s, "w1");
  assertEquals(speakers("w2"), ["w1"], "the claim, not the focus, decides");
  claimSpeaker(s, "w3");
  assertEquals(speakers("w1"), ["w3"]);
  // Only the holder gives the claim up.
  releaseSpeaker(s, "w1");
  assertEquals(readSpeaker(s), "w3");
  releaseSpeaker(s, "w3");
  assertEquals(readSpeaker(s), null);
  assertEquals(speakers("w1"), ["w1"]);
  // The floating companion shows: no workspace window speaks.
  claimSpeaker(s, "w2");
  assertEquals(speakers("w2", true), []);
});
