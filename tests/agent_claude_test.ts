// The Claude Code adapter's pure half (lib/agent/claude-stream.ts): its command line, its input
// lines, and its parser against streams recorded from Claude Code 2.1.326 (tests/fixtures/agent/,
// paths and signatures scrubbed): an edit turn (thinking, Read, Edit with its patch, text, the
// result), an interrupted turn then a Bash turn, and a resumed session whose Write was denied.

import { assert, assertEquals } from "@std/assert";
import {
  AGENT_READY,
  agentUserLine,
  claudeAgentArgv,
  claudeAgentFlags,
  ClaudeStreamParser,
  interruptLine,
  isModelName,
  isSessionId,
  PERMISSION_TOOL,
  toolDetail,
} from "../lib/agent/claude-stream.ts";
import type { AgentEvent } from "../lib/agent/adapter.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(
    new URL(`./fixtures/agent/${name}.jsonl`, import.meta.url),
  );

const parse = (text: string): AgentEvent[] =>
  new ClaudeStreamParser(() => 0).push(text);

Deno.test("argv: stream-json both ways, partial messages, the hub's permission tool", () => {
  const flags = claudeAgentFlags({
    claude: "/bin/claude",
    spec: { cwd: "/w" },
    hubArgs: ["--mcp-config", "/h/claude-mcp.json"],
    env: {},
  });
  assertEquals(flags, [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--mcp-config",
    "/h/claude-mcp.json",
    "--permission-prompt-tool",
    "mcp__qutty__approve_tool",
  ]);
  assertEquals(PERMISSION_TOOL, "mcp__qutty__approve_tool");
});

Deno.test("argv: --model, --resume and --permission-mode when set and well-formed", () => {
  const flags = claudeAgentFlags({
    claude: "/bin/claude",
    spec: {
      cwd: "/w",
      model: "opus[1m]",
      resumeId: "665799d1-8fd9-4a23-9b59-3ee348bd92e9",
      permissionMode: "acceptEdits",
    },
    hubArgs: [],
    env: {},
  });
  assertEquals(flags.slice(9), [
    "--model",
    "opus[1m]",
    "--resume",
    "665799d1-8fd9-4a23-9b59-3ee348bd92e9",
    "--permission-mode",
    "acceptEdits",
  ]);
  // A bad model or id is left out rather than passed through.
  const bad = claudeAgentFlags({
    claude: "/bin/claude",
    spec: {
      cwd: "/w",
      model: "--evil",
      resumeId: "x y",
      permissionMode: "default",
    },
    hubArgs: [],
    env: {},
  });
  assertEquals(bad.includes("--model"), false);
  assertEquals(bad.includes("--resume"), false);
  assertEquals(bad.includes("--permission-mode"), false);
  assert(isModelName("sonnet") && isModelName("claude-opus-5-5"));
  assert(!isModelName("") && !isModelName("-x"));
  assert(isSessionId("665799d1-8fd9-4a23-9b59-3ee348bd92e9"));
  assert(!isSessionId("../etc"));
});

Deno.test("argv: env sets the tile's hub variables, bash goes raw and prints the ready line", () => {
  const { program, args } = claudeAgentArgv({
    claude: "/bin/claude",
    spec: { cwd: "/w" },
    hubArgs: [],
    env: { QUTTY_SOCK: "/tmp/q/agent-1.sock", QUTTY_TILE_ID: "agent-1" },
  });
  assertEquals(program, "/usr/bin/env");
  assertEquals(args.slice(0, 4), [
    "QUTTY_SOCK=/tmp/q/agent-1.sock",
    "QUTTY_TILE_ID=agent-1",
    "/bin/bash",
    "-c",
  ]);
  assert(args[4].includes("stty raw -echo"));
  assert(args[4].includes(AGENT_READY));
  assertEquals(args[5], "/bin/claude");
  assertEquals(args[6], "-p");
});

Deno.test("input: a plain prompt, attachments as image and text blocks, the interrupt", () => {
  assertEquals(JSON.parse(agentUserLine({ text: "hi" })), {
    type: "user",
    message: { role: "user", content: "hi" },
  });
  const line = agentUserLine({
    text: "what is this?",
    attachments: [
      { name: "a.png", kind: "image", mediaType: "image/png", data: "QUJD" },
      { name: "b.txt", kind: "text", mediaType: "text/plain", data: "hello" },
    ],
  });
  assert(line.endsWith("\n") && !line.slice(0, -1).includes("\n"));
  assertEquals(JSON.parse(line).message.content, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUJD" },
    },
    { type: "text", text: "Attached file b.txt:\n\nhello" },
    { type: "text", text: "what is this?" },
  ]);
  assertEquals(JSON.parse(interruptLine("i-1")), {
    type: "control_request",
    request_id: "i-1",
    request: { subtype: "interrupt" },
  });
});

Deno.test("parser: an edit turn — session, thinking, tools with their details, text, the end", () => {
  const events = parse(fixture("edit-turn"));
  assertEquals(events.map((e) => e.kind), [
    "session",
    "thinking",
    "thinking",
    "thinking",
    "toolStart",
    "toolInput",
    "toolResult",
    "toolStart",
    "toolInput",
    "toolResult",
    "text",
    "text",
    "text",
    "text",
    "text",
    "text",
    "turnEnd",
  ]);
  const session = events[0];
  assert(session.kind === "session");
  assertEquals(session.sessionId, "665799d1-8fd9-4a23-9b59-3ee348bd92e9");
  assertEquals(session.model, "claude-haiku-5-5");
  assertEquals(session.cwd, "/tmp/qutty-agent/work");
  const thinking = events.filter((e) => e.kind === "thinking");
  assertEquals(
    thinking.map((t) => t.kind === "thinking" ? t.tokens : null),
    [undefined, 50, 246],
  );
  const edit = events.find((e) => e.kind === "toolInput" && e.name === "Edit");
  assert(edit?.kind === "toolInput");
  assertEquals(edit.input.old_string, "hello from a file");
  const results = events.filter((e) => e.kind === "toolResult");
  assert(results[0].kind === "toolResult" && results[1].kind === "toolResult");
  assertEquals(results[0].detail, { readLines: 2 });
  assertEquals(results[1].detail?.patch, [{
    oldStart: 1,
    newStart: 1,
    lines: ["-hello from a file", "+goodbye from a file"],
  }]);
  // The text came as deltas (one row); its whole copy is not repeated.
  const text = events.filter((e) => e.kind === "text").map((e) =>
    e.kind === "text" ? e.delta : ""
  ).join("");
  assertEquals(
    text,
    'I replaced "hello" with "goodbye" in note.txt, so the line now reads "goodbye from a file".',
  );
  assertEquals(
    new Set(
      events.filter((e) => e.kind === "text").map((e) =>
        e.kind === "text" ? e.id : ""
      ),
    ).size,
    1,
  );
  const end = events.at(-1)!;
  assert(end.kind === "turnEnd");
  assertEquals(
    [end.isError, end.subtype, end.durationMs, end.outputTokens],
    [false, "success", 3868, 487],
  );
  assertEquals(end.costUsd, 0.0035018700000000002);
});

Deno.test("parser: any chunking gives the same events", () => {
  const text = fixture("interrupt-then-bash");
  const whole = parse(text);
  const p = new ClaudeStreamParser(() => 0);
  const pieces: AgentEvent[] = [];
  for (let i = 0; i < text.length; i += 37) {
    pieces.push(...p.push(text.slice(i, i + 37)));
  }
  assertEquals(pieces, whole);
});

Deno.test("parser: an interrupt — the notice, then a failed result; the next turn's Bash output", () => {
  const events = parse(fixture("interrupt-then-bash"));
  const firstEnd = events.findIndex((e) => e.kind === "turnEnd");
  assertEquals(events[firstEnd - 1].kind, "interrupted");
  const end = events[firstEnd];
  assert(end.kind === "turnEnd");
  assertEquals([end.isError, end.subtype], [true, "error_during_execution"]);
  const bash = events.find((e) => e.kind === "toolResult");
  assert(bash?.kind === "toolResult");
  assertEquals(bash.text, "hi there");
  assertEquals(bash.detail, { stdout: "hi there" });
});

Deno.test("parser: a denied Write is an error result; a resumed session reports its old id", () => {
  const events = parse(fixture("resume-deny"));
  const s = events[0];
  assert(s.kind === "session");
  assertEquals(s.sessionId, "665799d1-8fd9-4a23-9b59-3ee348bd92e9");
  const denied = events.find((e) => e.kind === "toolResult");
  assert(denied?.kind === "toolResult");
  assertEquals([denied.isError, denied.text], [true, "The user said no."]);
});

Deno.test("parser: subagent lines, terminal noise and bad JSON", () => {
  const p = new ClaudeStreamParser(() => 7);
  const events = p.push(
    '\x1b[?25h\n{"type":"qutty_agent_ready"}\n' +
      '{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"id":"m","content":[{"type":"text","text":"sub"}]}}\n' +
      "Error: something broke\n{not json\n",
  );
  assertEquals(events, [
    { kind: "log", message: "Error: something broke", at: 7 },
    { kind: "log", message: "{not json", at: 7 },
  ]);
});

Deno.test("parser: without partial messages, whole text blocks are the text", () => {
  const events = parse(
    '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"one"}]}}\n' +
      '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"two"}]}}\n',
  );
  assertEquals(events.map((e) => e.kind === "text" && [e.id, e.delta]), [
    ["m1:t1", "one"],
    ["m1:t2", "two"],
  ]);
});

Deno.test("toolDetail: a Write's lines, stderr kept, nothing for an unknown shape", () => {
  assertEquals(toolDetail({ type: "create", content: "a\nb\n" }), {
    wroteLines: 2,
  });
  assertEquals(
    toolDetail({ stdout: "", stderr: "boom", interrupted: true }),
    { stdout: "", stderr: "boom", interrupted: true },
  );
  assertEquals(toolDetail("Error: no"), undefined);
  assertEquals(toolDetail({ other: 1 }), undefined);
});
