// The agent tile's transcript reducer (lib/agent/transcript.ts) on the recorded streams
// (tests/fixtures/agent/) and on hand-made events: deltas into one row, tool calls and their
// results, permission questions and answers, failures, interrupts; what the rows say (titles,
// summaries, the footer, the diff, the read-only runs), the text `read_screen` returns, and the
// capped copy the workspace saves.

import { assert, assertEquals } from "@std/assert";
import { ClaudeStreamParser } from "../lib/agent/claude-stream.ts";
import type { AgentEvent } from "../lib/agent/adapter.ts";
import {
  diffLines,
  displayItems,
  emptyTranscript,
  footerText,
  MAX_ROWS,
  reduceTranscript,
  type Row,
  sanitizeRows,
  savedRows,
  toolName,
  toolSummary,
  toolTitle,
  type Transcript,
  transcriptText,
} from "../lib/agent/transcript.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(
    new URL(`./fixtures/agent/${name}.jsonl`, import.meta.url),
  );

/** A user prompt, then the fixture's stream. */
function replay(name: string, prompt = "go"): Transcript {
  let t = reduceTranscript(emptyTranscript(), {
    kind: "user",
    text: prompt,
    at: 1,
  });
  for (const e of new ClaudeStreamParser(() => 2).push(fixture(name))) {
    t = reduceTranscript(t, e);
  }
  return t;
}

const all = (events: AgentEvent[], t = emptyTranscript()) =>
  events.reduce(reduceTranscript, t);

Deno.test("edit turn: one row per block, tool rows with results, a done footer", () => {
  const t = replay("edit-turn");
  assertEquals(t.rows.map((r) => r.type), [
    "user",
    "thinking",
    "tool",
    "tool",
    "text",
    "footer",
  ]);
  assertEquals(t.running, false);
  assertEquals(t.sessionId, "665799d1-8fd9-4a23-9b59-3ee348bd92e9");
  assertEquals(t.cwd, "/tmp/qutty-agent/work");
  const [read, edit] = t.rows.filter((r) => r.type === "tool") as Extract<
    Row,
    { type: "tool" }
  >[];
  assertEquals([read.name, read.status], ["Read", "done"]);
  assertEquals([edit.name, edit.status], ["Edit", "done"]);
  assertEquals(toolTitle(edit.name, edit.input, t.cwd), {
    name: "Edit",
    arg: "note.txt",
  });
  assertEquals(toolSummary(read), "Read 2 lines");
  assertEquals(toolSummary(edit), "Applied 1-line change (+1 −1)");
  assertEquals(diffLines(edit.detail?.patch), [
    { sign: "@", text: "@@ -1 +1 @@" },
    { sign: "-", text: "hello from a file" },
    { sign: "+", text: "goodbye from a file" },
  ]);
  const footer = t.rows.at(-1)!;
  assert(footer.type === "footer");
  assertEquals(
    footerText(footer),
    "done · 126 tok/s · 487 tok · 3.9s · $0.0035",
  );
  const thinking = t.rows[1];
  assert(thinking.type === "thinking");
  assertEquals(thinking.tokens, 246);
});

Deno.test("interrupted turn: notice, interrupted footer; the next turn's cost is its own", () => {
  const t = replay("interrupt-then-bash");
  const kinds = t.rows.map((r) => r.type);
  assertEquals(kinds, [
    "user",
    "thinking",
    "notice",
    "footer",
    "thinking",
    "tool",
    "text",
    "footer",
  ]);
  const [first, second] = t.rows.filter((r) => r.type === "footer") as Extract<
    Row,
    { type: "footer" }
  >[];
  assertEquals(first.outcome, "interrupted");
  assertEquals(second.outcome, "done");
  // Claude Code reports the session's cost so far; each footer shows its own turn's.
  assertEquals(first.costUsd, 0.00263507);
  assert(Math.abs(second.costUsd! - (0.00511988 - 0.00263507)) < 1e-12);
  assertEquals(t.error, undefined);
  const bash = t.rows.find((r) => r.type === "tool")!;
  assert(bash.type === "tool");
  assertEquals(toolTitle(bash.name, bash.input).arg, "echo hi there");
  assertEquals(toolSummary(bash), "hi there");
});

Deno.test("a permission question, answered with Deny: the tool row is denied", () => {
  let t = all([
    { kind: "user", text: "write it", at: 1 },
    { kind: "toolStart", id: "toolu_1", name: "Write", at: 2 },
    {
      kind: "toolInput",
      id: "toolu_1",
      name: "Write",
      input: { file_path: "/w/new.txt", content: "x\n" },
      at: 2,
    },
    {
      kind: "permission",
      requestId: "agent-1-1",
      toolName: "Write",
      input: { file_path: "/w/new.txt", content: "x\n" },
      toolUseId: "toolu_1",
      at: 3,
    },
  ]);
  assertEquals(t.asking, ["agent-1-1"]);
  t = all([
    {
      kind: "permissionDone",
      requestId: "agent-1-1",
      decision: "deny",
      at: 4,
    },
    {
      kind: "toolResult",
      id: "toolu_1",
      text: "The user denied this tool call in Qutty.",
      isError: true,
      at: 5,
    },
  ], t);
  assertEquals(t.asking, []);
  const perm = t.rows.find((r) => r.type === "permission")!;
  assert(perm.type === "permission");
  assertEquals(perm.decision, "deny");
  const tool = t.rows.find((r) => r.type === "tool")!;
  assert(tool.type === "tool");
  assertEquals([tool.status, toolSummary(tool)], ["denied", "Denied"]);
  // A repeated question (a replayed event) is not added twice.
  const again = reduceTranscript(t, {
    kind: "permission",
    requestId: "agent-1-1",
    toolName: "Write",
    input: {},
    at: 6,
  });
  assertEquals(again.rows.filter((r) => r.type === "permission").length, 1);
});

Deno.test("deltas append to their row; a failed turn shows its error and fails the footer", () => {
  let t = all([
    { kind: "user", text: "hi", at: 1 },
    { kind: "text", id: "m:0", delta: "Hel", at: 2 },
    { kind: "text", id: "m:0", delta: "lo", at: 3 },
    { kind: "toolStart", id: "toolu_9", name: "Bash", at: 4 },
  ]);
  assertEquals(t.rows.filter((r) => r.type === "text").length, 1);
  assertEquals((t.rows[1] as { text: string }).text, "Hello");
  assertEquals(t.turnStartedAt, 1);
  t = reduceTranscript(t, {
    kind: "turnEnd",
    isError: true,
    subtype: "error_during_execution",
    result: "API Error: 529 overloaded",
    durationMs: 1200,
    at: 5,
  });
  assertEquals(t.running, false);
  assertEquals(t.error, "API Error: 529 overloaded");
  assertEquals(t.rows.map((r) => r.type).slice(-2), ["error", "footer"]);
  // The tool call the turn left running ends with it.
  const tool = t.rows.find((r) => r.type === "tool")!;
  assert(tool.type === "tool");
  assertEquals(tool.status, "cancelled");
  const footer = t.rows.at(-1)!;
  assert(footer.type === "footer");
  assertEquals(footerText(footer), "failed · 1.2s");
  // The next message clears the error.
  t = reduceTranscript(t, { kind: "user", text: "again", at: 6 });
  assertEquals([t.error, t.running], [undefined, true]);
});

Deno.test("an error and an exit stop the turn; the queue is the session layer's list", () => {
  let t = all([
    { kind: "user", text: "hi", at: 1 },
    { kind: "queue", items: ["next one"], at: 2 },
    { kind: "error", message: "Claude Code is not installed", at: 3 },
  ]);
  assertEquals([t.running, t.error, t.queue], [
    false,
    "Claude Code is not installed",
    ["next one"],
  ]);
  t = reduceTranscript(t, {
    kind: "exit",
    reason: "Claude Code ended (exit code 1)",
    at: 4,
  });
  assertEquals(t.exited, "Claude Code ended (exit code 1)");
  assertEquals(t.rows.at(-1), {
    type: "notice",
    id: "n2",
    text: "Claude Code ended (exit code 1)",
    at: 4,
  });
});

Deno.test("the rows keep at most MAX_ROWS (the oldest go)", () => {
  let t = emptyTranscript();
  for (let i = 0; i < MAX_ROWS + 10; i++) {
    t = reduceTranscript(t, { kind: "text", id: `m${i}`, delta: "x", at: i });
  }
  assertEquals(t.rows.length, MAX_ROWS);
  assertEquals(t.rows[0].id, "m10");
});

Deno.test("display: two or more finished reads in a row are one item", () => {
  const tool = (id: string, name: string, status = "done"): Row => ({
    type: "tool",
    id,
    name,
    status: status as "done",
    input: { file_path: `/w/${id}` },
    at: 0,
  });
  const items = displayItems([
    tool("a", "Read"),
    { type: "thinking", id: "th", text: "", at: 0 },
    tool("b", "Grep"),
    tool("c", "Read"),
    tool("d", "Edit"),
    tool("e", "Read"),
  ]);
  assertEquals(items.map((i) => i.kind === "group" ? i.label : i.row.id), [
    "Read 2 files, searched 1 pattern",
    "d",
    "e",
  ]);
  // A running read is not grouped yet.
  assertEquals(
    displayItems([tool("a", "Read"), tool("b", "Read", "running")]).length,
    2,
  );
});

Deno.test("titles and summaries: Bash, Glob, MCP tools, output lines", () => {
  assertEquals(
    toolTitle("Bash", { command: "npm test\n--watch" }).arg,
    "npm test",
  );
  assertEquals(
    toolTitle("Glob", { pattern: "**/*.ts", path: "/w/src" }, "/w").arg,
    "**/*.ts in src",
  );
  assertEquals(toolName("mcp__qutty__read_screen"), "read_screen (qutty)");
  assertEquals(toolTitle("TodoWrite", { todos: [1, 2, 3] }).arg, "3 todos");
  const out = (stdout: string): Extract<Row, { type: "tool" }> => ({
    type: "tool",
    id: "x",
    name: "Bash",
    status: "done",
    detail: { stdout },
    at: 0,
  });
  assertEquals(toolSummary(out("")), "(no output)");
  assertEquals(toolSummary(out("a\nb\nc")), "3 lines of output");
  assertEquals(
    toolSummary({
      type: "tool",
      id: "w",
      name: "Write",
      status: "done",
      detail: { wroteLines: 42 },
      at: 0,
    }),
    "Wrote 42 lines",
  );
});

Deno.test("transcriptText: the rows the way Claude Code's terminal UI writes them", () => {
  const lines = transcriptText(replay("edit-turn", "fix note.txt"));
  assertEquals(lines, [
    "",
    "> fix note.txt",
    "",
    "✻ Thinking…",
    "",
    "● Read(note.txt)",
    "  ⎿  Read 2 lines",
    "",
    "● Edit(note.txt)",
    "  ⎿  Applied 1-line change (+1 −1)",
    "",
    '● I replaced "hello" with "goodbye" in note.txt, so the line now reads "goodbye from a file".',
    "  done · 126 tok/s · 487 tok · 3.9s · $0.0035",
  ]);
  const asking = transcriptText({
    rows: [{
      type: "permission",
      id: "p",
      toolName: "Bash",
      input: { command: "rm -rf build" },
      at: 0,
    }],
    running: true,
    queue: ["then test"],
    asking: ["p"],
  });
  assertEquals(asking, [
    "",
    "? Allow Bash(rm -rf build)? [Allow / Allow always / Deny]",
    "",
    "✻ Working…",
    "  (queued) then test",
  ]);
});

Deno.test("savedRows: newest first within the budget, long text cut, open questions dropped", () => {
  const rows: Row[] = [
    { type: "user", id: "u0", text: "a".repeat(20_000), at: 0 },
    {
      type: "permission",
      id: "p",
      toolName: "Bash",
      input: {},
      at: 1,
    },
    {
      type: "tool",
      id: "t",
      name: "Bash",
      status: "running",
      result: "r".repeat(5000),
      at: 2,
    },
    { type: "text", id: "x", text: "end", at: 3 },
  ];
  const saved = savedRows(rows);
  assertEquals(saved.map((r) => r.id), ["u0", "t", "x"]);
  assert((saved[0] as { text: string }).text.length < 9000);
  const tool = saved[1] as Extract<Row, { type: "tool" }>;
  assertEquals(tool.status, "cancelled");
  assert(tool.result!.length < 2100);
  // A tight budget keeps only the newest.
  assertEquals(savedRows(rows, 300).map((r) => r.id), ["t", "x"].slice(-1));
  // From storage: malformed rows are dropped.
  assertEquals(
    sanitizeRows([
      { type: "text", id: "a", text: "ok", at: 1 },
      { type: "text", id: "b", at: 1 },
      { type: "bogus", id: "c", at: 1 },
      null,
      { type: "tool", id: "d", name: "Read", status: "done", at: 1 },
    ]).map((r) => r.id),
    ["a", "d"],
  );
  assertEquals(sanitizeRows("nope"), []);
});
