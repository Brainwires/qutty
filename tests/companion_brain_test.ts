// The companion's brain protocol (lib/companion/brain.ts): Claude Code's stream-json output
// parsed from transcripts recorded with Claude Code 2.1.319 (tests/fixtures/companion/: two plain
// turns; a turn that calls read_screen then answers, and a turn on a tile's message that answers
// with send_message and "(quiet)"), in any chunking; and the command line and MCP config the
// hidden PTY starts it with.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BrainEvent,
  claudeBrainArgv,
  claudeBrainFlags,
  COMPANION_SYSTEM_PROMPT,
  companionMcpConfig,
  READY_MARKER,
  StreamJsonParser,
  toolShortName,
  userTurnLine,
} from "../lib/companion/brain.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(
    new URL(`./fixtures/companion/${name}`, import.meta.url),
  );

/** Parse `text` in chunks of `size` characters. */
function parse(text: string, size = Infinity): BrainEvent[] {
  const p = new StreamJsonParser();
  const out: BrainEvent[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(...p.push(text.slice(i, i + size)));
  }
  return out;
}

/** The events without the text deltas, and the text per turn. */
function summary(events: BrainEvent[]) {
  const turns: string[] = [];
  let text = "";
  const shape: string[] = [];
  for (const e of events) {
    if (e.kind === "text") {
      text += e.delta;
      continue;
    }
    if (e.kind === "turnEnd") {
      turns.push(text);
      text = "";
      shape.push(`turnEnd${e.isError ? "!" : ""}`);
    } else if (e.kind === "toolUse") {
      shape.push(`tool:${toolShortName(e.name)}`);
    } else shape.push(e.kind);
  }
  return { turns, shape };
}

Deno.test("stream-json: two plain turns — ready once, the text from the deltas (not twice), a turnEnd each", () => {
  const events = parse(fixture("text-turns.jsonl"));
  const { turns, shape } = summary(events);
  assertEquals(shape, ["ready", "turnEnd", "turnEnd"]);
  assertEquals(turns, ["Hi there, friend!", "Goodbye now!"]);
  const ends = events.filter((e) => e.kind === "turnEnd");
  assertEquals(ends, [
    { kind: "turnEnd", text: "Hi there, friend!", isError: false },
    { kind: "turnEnd", text: "Goodbye now!", isError: false },
  ]);
});

Deno.test("stream-json: a tool call then the answer; a message turn answered with send_message and (quiet)", () => {
  const events = parse(fixture("tool-turns.jsonl"));
  const { turns, shape } = summary(events);
  assertEquals(shape, [
    "ready",
    "tool:read_screen",
    "turnEnd",
    "tool:send_message",
    "turnEnd",
  ]);
  assertStringIncludes(turns[0], "Tile 1 is a plain shell (shell-1)");
  assertStringIncludes(turns[0], "42 tests green");
  assertEquals(turns[1], "(quiet)");
  const tool = events.find((e) => e.kind === "toolUse") as Extract<
    BrainEvent,
    { kind: "toolUse" }
  >;
  assertEquals(tool.name, "mcp__qutty__read_screen");
  assertEquals(tool.input, { tile: "pty-1" });
  const send = events.filter((e) => e.kind === "toolUse")[1] as Extract<
    BrainEvent,
    { kind: "toolUse" }
  >;
  assertEquals((send.input as { text: string }).text, "pong");
});

Deno.test("stream-json: any chunking gives the same events", () => {
  for (const name of ["text-turns.jsonl", "tool-turns.jsonl"]) {
    const whole = parse(fixture(name));
    for (const size of [1, 7, 64, 1000]) {
      assertEquals(
        summary(parse(fixture(name), size)),
        summary(whole),
        `${name} by ${size}`,
      );
    }
  }
});

Deno.test("stream-json: no partial messages → the assistant message's text; messages joined; errors; noise", () => {
  const p = new StreamJsonParser();
  const lines = [
    "\x1b[?25h",
    READY_MARKER,
    '{"type":"system","subtype":"init","session_id":"s"}',
    '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Looking."},{"type":"tool_use","name":"mcp__qutty__list_peers","input":{}}]}}',
    '{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Two tiles."}]}}',
    // A subagent's event is not the companion talking.
    '{"type":"assistant","parent_tool_use_id":"t1","message":{"id":"m3","content":[{"type":"text","text":"sub"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"Two tiles."}',
    "Error: something odd",
    "{not json",
    '{"type":"result","subtype":"error_max_turns","is_error":true}',
  ];
  const events = p.push(lines.join("\n") + "\n");
  assertEquals(events, [
    { kind: "ready" },
    { kind: "text", delta: "Looking." },
    { kind: "toolUse", name: "mcp__qutty__list_peers", input: {} },
    { kind: "text", delta: "\n\nTwo tiles." },
    { kind: "turnEnd", text: "Looking.\n\nTwo tiles.", isError: false },
    { kind: "log", message: "Error: something odd" },
    { kind: "log", message: "{not json" },
    {
      kind: "turnEnd",
      text: "The turn failed (error_max_turns).",
      isError: true,
    },
  ]);
  assertEquals(p.push('{"type":"result"'), [], "a partial line waits");
});

Deno.test("claude flags: stream-json both ways, partial messages, only the hub's tools, the role prompt", () => {
  const flags = claudeBrainFlags({
    claude: "/x/claude",
    mcpConfig: "/tmp/q/companion-mcp.json",
    model: "haiku",
  });
  const after = (flag: string) => flags[flags.indexOf(flag) + 1];
  assertEquals(flags[0], "-p");
  assertEquals(after("--input-format"), "stream-json");
  assertEquals(after("--output-format"), "stream-json");
  assert(flags.includes("--verbose"));
  assert(flags.includes("--include-partial-messages"));
  assertEquals(after("--mcp-config"), "/tmp/q/companion-mcp.json");
  assert(flags.includes("--strict-mcp-config"));
  assertEquals(after("--tools"), "", "no built-in tools");
  assertEquals(after("--allowedTools"), "mcp__qutty");
  assertEquals(after("--append-system-prompt"), COMPANION_SYSTEM_PROMPT);
  assertEquals(after("--model"), "haiku");
  assert(
    !claudeBrainFlags({ claude: "c", mcpConfig: "m" }).includes("--model"),
  );
  for (
    const word of [
      "short",
      "read_screen",
      "write_tile",
      "[Qutty]",
      "(quiet)",
      "ask_user",
    ]
  ) {
    assertStringIncludes(COMPANION_SYSTEM_PROMPT, word);
  }

  const { program, args } = claudeBrainArgv({
    claude: "/x/claude",
    mcpConfig: "/m",
  });
  assertEquals(program, "/bin/bash");
  assertEquals(args[0], "-c");
  for (
    const part of [
      "unset QUTTY_SOCK",
      "stty raw -echo",
      READY_MARKER,
      "< <(exec cat)",
    ]
  ) {
    assertStringIncludes(args[1], part);
  }
  assertEquals(args[2], "/x/claude", "$0 of the script");
  assertEquals(args[3], "-p");
});

Deno.test("claude input: one JSON user message per line; the MCP config points the shim at the companion socket", () => {
  const line = userTurnLine('say "hi"\nnow');
  assert(line.endsWith("\n"));
  assertEquals(line.indexOf("\n"), line.length - 1, "one line");
  assertEquals(JSON.parse(line), {
    type: "user",
    message: { role: "user", content: 'say "hi"\nnow' },
  });
  assertEquals(
    JSON.parse(
      companionMcpConfig("/h/.qutty/bin/qutty-mcp", "/tmp/q/c/x.sock"),
    ),
    {
      mcpServers: {
        qutty: {
          type: "stdio",
          command: "/h/.qutty/bin/qutty-mcp",
          args: [],
          env: { QUTTY_SOCK: "/tmp/q/c/x.sock" },
        },
      },
    },
  );
});
