// The companion's pure parts (lib/companion/): the state machine and the message queue (ported from
// Denext's examples/companion with its tests' cases, plus Qutty's `update` / `drop`), the `say`
// validation and `qutty-hook say` arguments, the bubbles for `ask_user` questions and the
// companion's replies, and Settings → Companion's sanitising.

import {
  assert,
  assertEquals,
  assertMatch,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  type FaceEvent,
  type FaceModel,
  type FaceMood,
  type FaceState,
  INITIAL_MODEL,
  isVisible,
  MOODS,
  moodState,
  nextTimer,
  QUTTY_MOODS,
  stateDurationMs,
  transition,
} from "../lib/companion/face-machine.ts";
import {
  type CompanionModel,
  companionReducer,
  INITIAL_COMPANION,
  MAX_QUEUE,
} from "../lib/companion/companion-state.ts";
import {
  type CompanionMessage,
  MAX_TEXT,
  MOOD_ALIASES,
  parseSayRequest,
  readingTimeMs,
  SayError,
} from "../lib/companion/messages.ts";
import { parseSayArgs, UsageError } from "../lib/companion/say-args.ts";
import {
  askAnswer,
  askBubble,
  askIdOf,
  replyTimeoutMs,
  turnBubble,
} from "../lib/companion/bubbles.ts";
import {
  brainChoice,
  COMPANION_NAME_MAX,
  companionName,
  DEFAULT_COMPANION,
  DEFAULT_COMPANION_NAME,
  sanitizeCompanion,
} from "../lib/companion/settings.ts";
import { initialState, reduce } from "../lib/workspace/store.ts";

const run = (events: FaceEvent[], from: FaceModel = INITIAL_MODEL) =>
  events.reduce(transition, from);

// --- the machine ------------------------------------------------------------------------------

Deno.test("face machine: show springs up and settles; blinks only while idle; moods map to moves", () => {
  const appeared = run([{ type: "show" }]);
  assertEquals(appeared.state, "appear");
  const idle = transition(appeared, { type: "settle" });
  assertEquals(idle, { state: "idle", pendingMood: null });
  assertEquals(transition(idle, { type: "blink" }).state, "blink");
  assertEquals(transition(INITIAL_MODEL, { type: "blink" }), INITIAL_MODEL);
  assertEquals(transition(idle, { type: "show" }), idle);
  assertEquals(
    transition(idle, { type: "say", mood: "thinking" }).state,
    "think",
  );
  assertEquals(
    transition(idle, { type: "say", mood: "attention" }).state,
    "point",
  );
  assertEquals(
    transition(idle, { type: "say", mood: "success" }).state,
    "celebrate",
  );
  assertEquals(moodState("neutral"), "idle");
  for (const mood of ["thinking", "attention", "success"] as const) {
    const moved = transition(idle, { type: "say", mood });
    assertEquals(transition(moved, { type: "settle" }).state, "idle", mood);
  }
});

Deno.test("face machine: the 13 moods each take the example's move; Qutty's blush stands idle", () => {
  assertEquals(MOODS.length, 14);
  assertEquals(QUTTY_MOODS, ["blush"]);
  assertEquals(MOODS.at(-1), "blush", "after the example's 13");
  const moves: Record<FaceMood, FaceState> = {
    neutral: "idle",
    thinking: "think",
    attention: "point",
    success: "celebrate",
    confused: "think",
    mad: "idle",
    sad: "idle",
    excited: "celebrate",
    sleepy: "idle",
    love: "celebrate",
    surprised: "idle",
    shocked: "idle",
    wow: "celebrate",
    blush: "idle",
  };
  assertEquals(Object.keys(moves), [...MOODS]);
  const idle = run([{ type: "show" }, { type: "settle" }]);
  for (const mood of MOODS) {
    assertEquals(moodState(mood), moves[mood], mood);
    assertEquals(transition(idle, { type: "say", mood }).state, moves[mood]);
  }
});

Deno.test("face machine: a message while hidden lands first; dismiss folds to hidden", () => {
  const landing = transition(INITIAL_MODEL, { type: "say", mood: "attention" });
  assertEquals(landing, { state: "appear", pendingMood: "attention" });
  assertEquals(transition(landing, { type: "settle" }).state, "point");
  const idle = run([{ type: "show" }, { type: "settle" }]);
  const folding = transition(idle, { type: "dismiss" });
  assertEquals(folding.state, "dismiss");
  assertEquals(isVisible(folding.state), false);
  assertEquals(transition(folding, { type: "settle" }).state, "hidden");
  assertEquals(transition(folding, { type: "show" }).state, "appear");
});

Deno.test("face machine: timed moves have durations, held moves don't; idle blinks in 2.5–6 s", () => {
  for (const s of ["appear", "blink", "celebrate", "dismiss"] as const) {
    assert((stateDurationMs(s) ?? 0) > 0, s);
  }
  for (const s of ["hidden", "idle", "think", "point"] as const) {
    assertEquals(stateDurationMs(s), null, s);
  }
  assertEquals(nextTimer("appear"), { event: { type: "settle" }, ms: 650 });
  assertEquals(nextTimer("idle", () => 0), {
    event: { type: "blink" },
    ms: 2_500,
  });
  assert((nextTimer("idle", () => 0.999)?.ms ?? Infinity) < 6_000);
  assertEquals(nextTimer("think"), null);
});

// --- the queue ---------------------------------------------------------------------------------

const msg = (
  id: string,
  mood: CompanionMessage["mood"] = "neutral",
): CompanionMessage => ({ id, text: id, mood, actions: [], timeoutMs: 0 });

const upIdle = (): CompanionModel =>
  companionReducer(companionReducer(INITIAL_COMPANION, { type: "show" }), {
    type: "settle",
  });

Deno.test("companion queue: messages queue; finishing says the next; the last settles; capped; fold drops all", () => {
  let m = upIdle();
  m = companionReducer(m, { type: "enqueue", message: msg("a", "thinking") });
  assertEquals(m.avatar.state, "think");
  m = companionReducer(m, { type: "enqueue", message: msg("b", "success") });
  assertEquals(
    m.avatar.state,
    "think",
    "a waiting message doesn't move the companion",
  );
  assertStrictEquals(
    companionReducer(m, { type: "enqueue", message: msg("a") }),
    m,
    "the same id twice is one bubble",
  );
  assertStrictEquals(companionReducer(m, { type: "finish", id: "b" }), m);
  m = companionReducer(m, { type: "finish", id: "a" });
  assertEquals(m.queue.map((q) => q.id), ["b"]);
  assertEquals(m.avatar.state, "celebrate");
  m = companionReducer(m, { type: "finish", id: "b" });
  assertEquals(m.queue, []);
  assertEquals(m.avatar.state, "idle");

  for (let i = 0; i < MAX_QUEUE + 5; i++) {
    m = companionReducer(m, { type: "enqueue", message: msg(`m${i}`) });
  }
  assertEquals(m.queue.length, MAX_QUEUE + 1);
  m = companionReducer(m, { type: "foldUp" });
  assertEquals(m.queue, []);
  assertEquals(m.avatar.state, "dismiss");
});

Deno.test("companion queue: update patches a message (a new mood on screen moves the companion); drop removes one anywhere", () => {
  let m = upIdle();
  m = companionReducer(m, { type: "enqueue", message: msg("r", "thinking") });
  m = companionReducer(m, { type: "enqueue", message: msg("q") });
  assertEquals(m.avatar.state, "think");
  m = companionReducer(m, {
    type: "update",
    id: "r",
    patch: { text: "streamed", mood: "neutral" },
  });
  assertEquals(m.queue[0].text, "streamed");
  assertEquals(
    m.avatar.state,
    "idle",
    "the reply is done: the companion stops thinking",
  );
  const same = companionReducer(m, {
    type: "update",
    id: "q",
    patch: { mood: "attention" },
  });
  assertEquals(
    same.avatar,
    m.avatar,
    "a waiting message's mood doesn't move the companion",
  );
  assertStrictEquals(
    companionReducer(m, { type: "update", id: "nope", patch: { text: "x" } }),
    m,
  );
  // Drop the waiting one, then the one on screen (which says the next, or settles).
  let d = companionReducer(m, { type: "drop", id: "q" });
  assertEquals(d.queue.map((x) => x.id), ["r"]);
  d = companionReducer(d, { type: "drop", id: "r" });
  assertEquals(d.queue, []);
  assertStrictEquals(companionReducer(d, { type: "drop", id: "r" }), d);
});

// --- say ------------------------------------------------------------------------------------------

Deno.test("say: the example's message shape and validation", () => {
  const { message, wait } = parseSayRequest({ text: "  hello  " }, "m1");
  assertEquals(message, {
    id: "m1",
    text: "hello",
    mood: "neutral",
    actions: [],
    timeoutMs: readingTimeMs("hello"),
  });
  assertEquals(wait, false);
  const asked = parseSayRequest({
    text: "Deploy?",
    actions: [{ id: "yes", label: "Deploy" }],
    wait: true,
  });
  assertEquals(asked.message.timeoutMs, 0);
  assertEquals(asked.wait, true);
  // Every mood (the example's 13 and Qutty's blush); Qutty's state names are aliases of three.
  for (const mood of MOODS) {
    assertEquals(parseSayRequest({ text: "x", mood }).message.mood, mood);
  }
  for (const [alias, mood] of Object.entries(MOOD_ALIASES)) {
    assertEquals(
      parseSayRequest({ text: "x", mood: alias }).message.mood,
      mood,
    );
  }
  assertEquals(MOOD_ALIASES, {
    idle: "neutral",
    ask: "attention",
    error: "sad",
  });
  assertMatch(
    assertThrows(() => parseSayRequest({ text: "x", mood: "angry" }), SayError)
      .message,
    /neutral, thinking, attention, success, confused, mad, sad, excited, sleepy, love, surprised, shocked, wow, blush/,
  );
  for (
    const [body, reason] of [
      [{}, /text/],
      [{ text: "x".repeat(MAX_TEXT + 1) }, /text/],
      [{ text: "x", mood: "angry" }, /mood/],
      [{ text: "x", mood: "constructor" }, /mood/],
      [{ text: "x", mood: 3 }, /mood/],
      [{ text: "x", actions: [{ id: "a b", label: "A" }] }, /actions\[0\]\.id/],
      [{ text: "x", timeoutMs: 10 }, /timeoutMs/],
    ] as Array<[unknown, RegExp]>
  ) {
    assertMatch(
      assertThrows(() => parseSayRequest(body), SayError).message,
      reason,
    );
  }
});

Deno.test("qutty-hook say: words and flags become the say request; usage errors are reported", () => {
  assertEquals(parseSayArgs(["Tests", "passed", "--mood", "success"]), {
    text: "Tests passed",
    mood: "success",
  });
  assertEquals(parseSayArgs(["Night", "--mood", "sleepy"]), {
    text: "Night",
    mood: "sleepy",
  });
  assertEquals(
    parseSayRequest(parseSayArgs(["Aw", "thanks", "--mood", "blush"]))
      .message.mood,
    "blush",
  );
  assertEquals(
    parseSayArgs([
      "Deploy?",
      "--action",
      "yes:Deploy now",
      "--action",
      "no:Later",
      "--wait",
      "--timeout",
      "0",
    ]),
    {
      text: "Deploy?",
      actions: [{ id: "yes", label: "Deploy now" }, {
        id: "no",
        label: "Later",
      }],
      timeoutMs: 0,
      wait: true,
    },
  );
  for (
    const [args, reason] of [
      [[], /say what/],
      [["hi", "--mood"], /--mood needs a value/],
      [["hi", "--action", "nolabel"], /<id>:<label>/],
      [["hi", "--loud"], /unknown flag/],
    ] as Array<[string[], RegExp]>
  ) {
    assertMatch(
      assertThrows(() => parseSayArgs(args), UsageError).message,
      reason,
    );
  }
});

// --- bubbles ------------------------------------------------------------------------------------

Deno.test("bubbles: an ask_user question has a button per action, answered with the question's own label", () => {
  const request = {
    id: "ask-3",
    from: "pty-2",
    fromName: "codex",
    text: "Run the migration?",
    actions: ["Yes, run it", "No"],
  };
  const b = askBubble(request);
  assertEquals(b.id, "ask:ask-3");
  assertEquals(askIdOf(b.id), "ask-3");
  assertEquals(askIdOf("turn:1"), undefined);
  assertEquals(b.kind, "ask");
  assertEquals(b.from, "codex");
  assertEquals(b.mood, "attention");
  assertEquals(b.timeoutMs, 0, "a question stays until answered");
  assertEquals(b.actions, [{ id: "a0", label: "Yes, run it" }, {
    id: "a1",
    label: "No",
  }]);
  assertEquals(askAnswer(request, b, "a1"), "No");
  assertEquals(askAnswer(request, b, null), null);
  const long = { ...request, actions: ["x".repeat(60)] };
  assertEquals(askAnswer(long, askBubble(long), "a0"), "x".repeat(60));
  assertEquals(askBubble({ ...request, actions: [] }).actions, [{
    id: "a0",
    label: "OK",
  }]);
});

Deno.test("bubbles: a user turn shows at once and streams; an agents' turn only when done and not quiet", () => {
  const base = { kind: "turn" as const, turn: 4, source: "user" as const };
  const thinking = turnBubble({ ...base, text: "", done: false })!;
  assertEquals(
    [thinking.id, thinking.text, thinking.mood, thinking.timeoutMs],
    [
      "turn:4",
      "…",
      "thinking",
      0,
    ],
  );
  const streaming = turnBubble({ ...base, text: "Tile 1 is", done: false })!;
  assertEquals(streaming.text, "Tile 1 is");
  const done = turnBubble({ ...base, text: "Tile 1 is a shell.", done: true })!;
  assertEquals(done.mood, "neutral");
  assertEquals(done.timeoutMs, replyTimeoutMs("Tile 1 is a shell."));
  assertEquals(
    turnBubble({ ...base, text: "I stopped", done: true, isError: true })!.mood,
    "sad",
  );
  const mail = { ...base, source: "mail" as const };
  assertEquals(
    turnBubble({ ...mail, text: "codex says hi", done: false }),
    null,
  );
  assertEquals(
    turnBubble({ ...mail, text: "(quiet)", done: true, quiet: true }),
    null,
  );
  assertEquals(
    turnBubble({ ...mail, text: "codex says hi", done: true })?.text,
    "codex says hi",
  );
  assert(replyTimeoutMs("x".repeat(4000)) <= 30_000);
});

Deno.test("bubbles: a reply's mood (its tag, taken off by the runtime) is the face while it streams and once done", () => {
  const base = { kind: "turn" as const, turn: 5, source: "user" as const };
  // The tag still streaming in: nothing to show yet, the companion thinks.
  const hidden = turnBubble({ ...base, text: "", done: false })!;
  assertEquals([hidden.text, hidden.mood], ["…", "thinking"]);
  const streaming = turnBubble({
    ...base,
    text: "Aw,",
    mood: "blush",
    done: false,
  })!;
  assertEquals([streaming.text, streaming.mood], ["Aw,", "blush"]);
  const done = turnBubble({
    ...base,
    text: "Aw, thank you!",
    mood: "blush",
    done: true,
  })!;
  assertEquals([done.text, done.mood], ["Aw, thank you!", "blush"]);
  assertEquals(
    turnBubble({ ...base, text: "x", mood: "love", done: true, isError: true })!
      .mood,
    "sad",
    "a failed turn is sad whatever the tag",
  );
});

// --- settings -----------------------------------------------------------------------------------

/** The reactions' defaults (tests/companion_reactions_test.ts checks them). */
const REACTION_DEFAULTS = {
  nightSleepy: true,
  nightFrom: 0,
  nightTo: 360,
  celebrate: true,
  sad: true,
  reactMinS: 20,
  reactAnyCommand: false,
  reactBubble: true,
  quoteOfDay: true,
  encourage: false,
  encourageEvery: "sometimes" as const,
};

Deno.test("settings: the companion's name: trimmed, capped, Companion when empty or not a string", () => {
  assertEquals(DEFAULT_COMPANION_NAME, "Companion");
  assertEquals(companionName("  Jarvis  "), "Jarvis");
  assertEquals(companionName("Mr\t Robot\n"), "Mr Robot");
  assertEquals(companionName("bell\u0007here"), "bell here");
  // At most COMPANION_NAME_MAX characters (code points: an emoji is not cut in half).
  assertEquals(COMPANION_NAME_MAX, 24);
  assertEquals(companionName("x".repeat(40)), "x".repeat(24));
  assertEquals(companionName("🤖".repeat(30)), "🤖".repeat(24));
  // The cut does not leave a trailing space.
  assertEquals(companionName(`${"a".repeat(23)} b`), "a".repeat(23));
  for (const empty of ["", "   ", "\n\t", undefined, null, 42, {}, ["Jo"]]) {
    assertEquals(companionName(empty), "Companion", String(empty));
  }
  // Through the settings: kept, sanitised, defaulted; absent from a patch leaves it as it was.
  assertEquals(sanitizeCompanion({ name: " Jarvis " }).name, "Jarvis");
  assertEquals(sanitizeCompanion({ name: "" }).name, "Companion");
  assertEquals(sanitizeCompanion({ name: 7 }).name, "Companion");
  assertEquals(sanitizeCompanion({}).name, "Companion");
  const named = sanitizeCompanion({ name: "Jarvis" });
  assertEquals(sanitizeCompanion({ lively: false }, named).name, "Jarvis");
  assertEquals(sanitizeCompanion({ name: "  " }, named).name, "Companion");
  // Settings saved before the name existed load with the default.
  const { name: _gone, ...older } = DEFAULT_COMPANION;
  assertEquals(sanitizeCompanion(older).name, "Companion");
});

Deno.test("settings: the companion's fields sanitise; the store reduces them", () => {
  assertEquals(DEFAULT_COMPANION, {
    name: "Companion",
    mode: "window",
    corner: "bottom-right",
    floatAllSpaces: true,
    brain: true,
    engine: "claude",
    model: "",
    ollamaModel: "",
    lively: true,
    ...REACTION_DEFAULTS,
  });
  assertEquals(
    sanitizeCompanion({
      mode: "off",
      corner: "top-left",
      brain: false,
      engine: "ollama",
      model: "haiku",
      ollamaModel: "qwen3.8:27b-mlx",
      lively: false,
    }),
    {
      name: "Companion",
      mode: "off",
      corner: "top-left",
      floatAllSpaces: true,
      brain: false,
      engine: "ollama",
      model: "haiku",
      ollamaModel: "qwen3.8:27b-mlx",
      lively: false,
      ...REACTION_DEFAULTS,
    },
  );
  // The brain the hub is configured with: Claude Code's alias, or the Ollama model.
  assertEquals(brainChoice({ ...DEFAULT_COMPANION, model: "haiku" }), {
    engine: "claude",
    model: "haiku",
  });
  assertEquals(
    brainChoice({
      ...DEFAULT_COMPANION,
      engine: "ollama",
      ollamaModel: "user/m:tag",
    }),
    { engine: "ollama", model: "user/m:tag" },
  );
  assertEquals(
    sanitizeCompanion({ engine: "api", ollamaModel: "bad name; rm" }),
    DEFAULT_COMPANION,
  );
  assertEquals(
    sanitizeCompanion({
      mode: "zen",
      corner: 3,
      brain: "yes",
      model: "gpt",
      lively: "very",
    }),
    DEFAULT_COMPANION,
  );

  let s = initialState();
  assertEquals(s.settings.companion, DEFAULT_COMPANION);
  s = reduce(s, { type: "setCompanion", patch: { corner: "top-right" } });
  assertEquals(s.settings.companion.corner, "top-right");
  assertStrictEquals(
    reduce(s, { type: "setCompanion", patch: { corner: "top-right" } }),
    s,
  );
  assertStrictEquals(
    reduce(s, { type: "setCompanion", patch: { corner: "middle" as never } }),
    s,
  );
  const hydrated = reduce(initialState(), {
    type: "hydrateSettings",
    settings: { companion: { mode: "off" } as never },
  });
  assertEquals(hydrated.settings.companion, {
    ...DEFAULT_COMPANION,
    mode: "off",
  });
});
