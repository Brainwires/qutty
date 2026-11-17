// The brain's mood tag (lib/companion/mood-tag.ts): a reply that starts with `[mood: blush]` sets
// the companion's face and never shows the tag; a tag still streaming in shows as nothing; the
// runtime (lib/companion/runtime.ts) takes it off the text of every `turn` update, the `(quiet)`
// check included; and the system prompt tells the brain to use it (blush when flattered).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { splitMoodTag } from "../lib/companion/mood-tag.ts";
import { MOODS } from "../lib/companion/face-machine.ts";
import { COMPANION_SYSTEM_PROMPT } from "../lib/companion/brain.ts";
import { CompanionRuntime } from "../lib/companion/runtime.ts";
import type { BrainSink } from "../lib/companion/brain.ts";
import type { CompanionUpdate } from "../lib/companion/protocol.ts";
import { Mailboxes } from "../lib/hub/mailbox.ts";
import { COMPANION } from "../lib/hub/protocol.ts";
import { waitUntil } from "./hub_helpers.ts";

Deno.test("mood tag: a leading tag is taken off and names the mood", () => {
  assertEquals(splitMoodTag("[mood: blush] Aw, thank you!"), {
    text: "Aw, thank you!",
    mood: "blush",
  });
  // Spelling and spacing the models use.
  for (
    const raw of [
      "[mood:blush]Aw",
      "  [Mood: Blush]  Aw",
      "[MOOD = blush] Aw",
      "[mood blush] Aw",
      "[ mood : blush ]\nAw",
    ]
  ) {
    assertEquals(splitMoodTag(raw), { text: "Aw", mood: "blush" }, raw);
  }
  // Every mood, and the aliases of the companion's states.
  for (const mood of MOODS) {
    assertEquals(splitMoodTag(`[mood: ${mood}] x`).mood, mood);
  }
  assertEquals(splitMoodTag("[mood: error] x").mood, "sad");
  // An unknown mood: the tag still goes, no mood.
  assertEquals(splitMoodTag("[mood: smug] Heh."), { text: "Heh." });
  assertEquals(splitMoodTag("[mood: constructor] x"), { text: "x" });
  assertEquals(splitMoodTag("[mood:] x"), { text: "x" });
});

Deno.test("mood tag: text without a leading tag is left alone", () => {
  for (
    const raw of [
      "",
      "Tile 1 is a shell.",
      "[1] is the first footnote.",
      "Hello [mood: blush] there",
      "[moody] is a word",
      "[x]",
    ]
  ) {
    assertEquals(splitMoodTag(raw), { text: raw }, raw);
    assertEquals(splitMoodTag(raw, true).text, raw, `${raw} (streaming)`);
  }
});

Deno.test("mood tag: a tag still streaming in shows as nothing until it is whole", () => {
  for (
    const raw of ["[", "[m", "[mo", "[mood", "[mood:", "[mood: ", "[mood: bl"]
  ) {
    assertEquals(splitMoodTag(raw, true), { text: "" }, raw);
    // Done: whatever it was, it is shown as it is.
    assertEquals(splitMoodTag(raw, false), { text: raw }, raw);
  }
  assertEquals(splitMoodTag("[mood: blush]", true), {
    text: "",
    mood: "blush",
  });
  assertEquals(splitMoodTag("[mood: blush] Aw", true), {
    text: "Aw",
    mood: "blush",
  });
});

Deno.test("mood tag: the system prompt asks for it, blush when flattered, in the companion's moods", () => {
  assertStringIncludes(
    COMPANION_SYSTEM_PROMPT,
    "[mood: blush] when the user compliments",
  );
  const named = [...COMPANION_SYSTEM_PROMPT.matchAll(/\[mood:\s*(\w+)\]/g)].map(
    (
      m,
    ) => m[1],
  );
  assert(named.length >= 10, `moods named: ${named}`);
  for (const mood of named) {
    assert((MOODS as readonly string[]).includes(mood), mood);
  }
  assert(
    !/\[mood:\s*\n/.test(COMPANION_SYSTEM_PROMPT),
    "no tag split over lines",
  );
  assertStringIncludes(COMPANION_SYSTEM_PROMPT, "never mention it");
});

/** A runtime over a brain that answers each turn with the next of `replies`, in small deltas. */
function runtimeReplying(replies: string[]) {
  const updates: CompanionUpdate[] = [];
  let sink: BrainSink | undefined;
  const mailbox = new Mailboxes((owner) => {
    if (owner === COMPANION && mailbox.unread(COMPANION) > 0) {
      runtime.mailArrived();
    }
  });
  const runtime = new CompanionRuntime({
    mailbox,
    adapter: "Scripted",
    textThrottleMs: 0,
    emit: (u) => updates.push(u),
    createBrain: () => ({
      label: "scripted",
      start: (s) => {
        sink = s;
        return Promise.resolve();
      },
      send: () => {
        const text = replies.shift() ?? "";
        queueMicrotask(async () => {
          for (let i = 0; i < text.length; i += 3) {
            sink!.event({ kind: "text", delta: text.slice(i, i + 3) });
            await new Promise((r) => setTimeout(r, 2));
          }
          sink!.event({ kind: "turnEnd", text, isError: false });
        });
        return Promise.resolve();
      },
      stop: () => {},
    }),
  });
  const turns = () =>
    updates.filter((u): u is Extract<CompanionUpdate, { kind: "turn" }> =>
      u.kind === "turn"
    );
  return { runtime, mailbox, turns };
}

Deno.test("mood tag: the runtime takes it off every turn update and carries the mood", async () => {
  const t = runtimeReplying(["[mood: blush] Aw, stop it… thank you!"]);
  t.runtime.userSays("you're cute");
  await waitUntil(() => t.turns().some((u) => u.done), 2000, "the reply");
  for (const u of t.turns()) {
    assert(!u.text.includes("["), `no tag shown: ${JSON.stringify(u.text)}`);
    assert(!u.text.includes("mood"), `no tag shown: ${JSON.stringify(u.text)}`);
  }
  const done = t.turns().find((u) => u.done)!;
  assertEquals([done.text, done.mood], ["Aw, stop it… thank you!", "blush"]);
  assert(
    t.turns().some((u) => !u.done && u.mood === "blush"),
    "the mood shows while the reply streams",
  );
  t.runtime.stop();
});

Deno.test("mood tag: a tagged (quiet) agents' turn is still quiet; an untagged reply has no mood", async () => {
  const t = runtimeReplying(["[mood: neutral] (quiet)", "Tile 1 is a shell."]);
  t.mailbox.post({
    from: "pty-2",
    fromName: "codex",
    to: COMPANION,
    text: "hi",
  });
  await waitUntil(() => t.turns().some((u) => u.done), 2000, "the mail turn");
  const mail = t.turns().find((u) => u.done)!;
  assertEquals([mail.source, mail.quiet, mail.text], ["mail", true, "(quiet)"]);
  t.runtime.userSays("what's in tile 1?");
  await waitUntil(
    () => t.turns().filter((u) => u.done).length === 2,
    2000,
    "the user turn",
  );
  const reply = t.turns().filter((u) => u.done)[1];
  assertEquals([reply.text, reply.mood], ["Tile 1 is a shell.", undefined]);
  t.runtime.stop();
});
