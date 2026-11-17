// The agent tile's prompt box without a DOM (lib/agent/prompt-box.ts): the history and when the
// arrows walk it, the saved prompts, inserting at the caret, and the last reply read aloud.

import { assertEquals } from "@std/assert";
import {
  addSaved,
  historyStep,
  insertAtCaret,
  lastReply,
  mergeHistory,
  parsePromptList,
  pushPrompt,
  recallsHistory,
  removeSaved,
  SAVED_MAX,
} from "../lib/agent/prompt-box.ts";
import type { Row } from "../lib/agent/transcript.ts";

Deno.test("pushPrompt: newest last, a repeat moves up, blanks skipped, capped", () => {
  assertEquals(pushPrompt([], "  a  "), ["a"]);
  assertEquals(pushPrompt(["a", "b"], "a"), ["b", "a"]);
  assertEquals(pushPrompt(["a"], "   "), ["a"]);
  assertEquals(pushPrompt(["a", "b", "c"], "d", 3), ["b", "c", "d"]);
  assertEquals(pushPrompt(["a"], "x".repeat(20_001)), ["a"]);
});

Deno.test("mergeHistory: the tile's own prompts come back first", () => {
  assertEquals(mergeHistory(["x", "a", "y"], ["a", "b"]), ["x", "y", "a", "b"]);
  assertEquals(mergeHistory([], []), []);
});

Deno.test("parsePromptList: strings only, no repeats, capped; junk is empty", () => {
  assertEquals(parsePromptList('["a", 1, "b", "a", null, " "]', 10), [
    "b",
    "a",
  ]);
  assertEquals(parsePromptList('["a","b","c"]', 2), ["b", "c"]);
  assertEquals(parsePromptList("{", 10), []);
  assertEquals(parsePromptList('{"a":1}', 10), []);
  assertEquals(parsePromptList(null, 10), []);
});

Deno.test("saved prompts: add (a repeat moves to the end), remove, capped", () => {
  let s = addSaved([], "review this diff");
  s = addSaved(s, "write tests");
  s = addSaved(s, "review this diff");
  assertEquals(s, ["write tests", "review this diff"]);
  assertEquals(removeSaved(s, 0), ["review this diff"]);
  assertEquals(removeSaved(s, 5), s);
  let many: string[] = [];
  for (let i = 0; i < SAVED_MAX + 5; i++) many = addSaved(many, `p${i}`);
  assertEquals(many.length, SAVED_MAX);
  assertEquals(many[0], "p5");
});

Deno.test("recallsHistory: ↑ at the start, ↓ at the end; either end of one line", () => {
  // Empty.
  assertEquals(recallsHistory("up", "", 0, 0), true);
  assertEquals(recallsHistory("down", "", 0, 0), true);
  // One line: either end, not the middle, not a selection.
  assertEquals(recallsHistory("up", "abc", 3, 3), true);
  assertEquals(recallsHistory("up", "abc", 0, 0), true);
  assertEquals(recallsHistory("down", "abc", 0, 0), true);
  assertEquals(recallsHistory("up", "abc", 1, 1), false);
  assertEquals(recallsHistory("up", "abc", 0, 3), false);
  // Several lines: ↑ only at the very start, ↓ only at the very end.
  assertEquals(recallsHistory("up", "ab\ncd", 0, 0), true);
  assertEquals(recallsHistory("up", "ab\ncd", 5, 5), false);
  assertEquals(recallsHistory("down", "ab\ncd", 5, 5), true);
  assertEquals(recallsHistory("down", "ab\ncd", 0, 0), false);
});

Deno.test("historyStep: up to the oldest, down back to the draft", () => {
  const h = ["one", "two", "three"];
  let at = historyStep(h, -1, "up", "draft")!;
  assertEquals(at, { index: 0, text: "three" });
  at = historyStep(h, at.index, "up", "draft")!;
  at = historyStep(h, at.index, "up", "draft")!;
  assertEquals(at, { index: 2, text: "one" });
  assertEquals(historyStep(h, at.index, "up", "draft"), null);
  at = historyStep(h, at.index, "down", "draft")!;
  assertEquals(at, { index: 1, text: "two" });
  at = historyStep(h, 0, "down", "draft")!;
  assertEquals(at, { index: -1, text: "draft" });
  // ↓ on the draft, and ↑ with no history: nothing.
  assertEquals(historyStep(h, -1, "down", "draft"), null);
  assertEquals(historyStep([], -1, "up", ""), null);
});

Deno.test("insertAtCaret: replaces the selection, caret after; out-of-range clamps", () => {
  assertEquals(insertAtCaret("hello world", 6, 11, "there"), {
    value: "hello there",
    caret: 11,
  });
  assertEquals(insertAtCaret("ab", 1, 1, "X"), { value: "aXb", caret: 2 });
  assertEquals(insertAtCaret("ab", 9, 9, "!"), { value: "ab!", caret: 3 });
});

Deno.test("lastReply: the latest turn's answer after its tools, else the turn before", () => {
  const rows: Row[] = [
    { type: "user", id: "u1", text: "hi", at: 1 },
    { type: "text", id: "a1", text: "First answer.", at: 2 },
    { type: "user", id: "u2", text: "more", at: 3 },
    { type: "text", id: "a0", text: "I'll look first.", at: 3 },
    { type: "tool", id: "t", name: "Read", status: "done", at: 3 },
    { type: "text", id: "a2", text: "Part one.", at: 4 },
    { type: "notice", id: "n", text: "x", at: 5 },
    { type: "text", id: "a3", text: "Part two.", at: 6 },
  ] as Row[];
  assertEquals(lastReply(rows), "Part one.\n\nPart two.");
  // A new prompt with no answer yet: the previous answer.
  const asked = [...rows, { type: "user", id: "u3", text: "?", at: 7 } as Row];
  assertEquals(lastReply(asked), "Part one.\n\nPart two.");
  // Only narration so far (a tool after it): the narration.
  assertEquals(lastReply(rows.slice(0, 5)), "I'll look first.");
  assertEquals(lastReply(rows.slice(0, 1)), "");
  assertEquals(lastReply([]), "");
});
