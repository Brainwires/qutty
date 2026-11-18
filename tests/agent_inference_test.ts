// The in-process coding agent (lib/agent/inference-agent.ts) over a scripted provider and an
// in-memory file system and shell: its tools as the transcript's rows (`Read`, `Edit` with its
// diff, `Write`, `Bash` with its output), approvals by permission mode through `hooks.approve`
// (Allow, Deny, plan mode refusing, accept-edits not asking for edits), a provider failure, an
// interrupt that kills the running command and forgets the turn, and desktop/agent-inference.ts's
// backends (an Ollama with no such model, no API key) and adapter choice. No model is ever called.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ChatOptions,
  type ChatResponse,
  type ContentBlock,
  Message,
  type Provider,
  type StreamChunk,
  type Tool,
} from "@rullama/core";
import type {
  AgentEvent,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "../lib/agent/adapter.ts";
import {
  CODING_TOOLS,
  type CodingHost,
  codingSystemPrompt,
  InferenceAgentAdapter,
  needsApproval,
  resolvePath,
} from "../lib/agent/inference-agent.ts";
import {
  emptyTranscript,
  reduceTranscript,
  type Row,
} from "../lib/agent/transcript.ts";
import {
  ANTHROPIC_AGENT_MODELS,
  anthropicAgent,
  deferredOllamaAgent,
} from "../desktop/agent-inference.ts";
import { createAgentAdapter } from "../desktop/agent-host.ts";
import { waitUntil } from "./hub_helpers.ts";

/** One scripted model reply: text, tool calls, a failure, or one that never comes. */
type Step =
  | { say?: string; call?: [name: string, input: Record<string, unknown>][] }
  | Error
  | "hang";

/** A provider that plays `steps` and records the conversations it was sent. */
class PlayedProvider implements Provider {
  readonly name = "played";
  seen: Message[][] = [];
  #steps: Step[];
  #ids = 0;

  constructor(steps: Step[]) {
    this.#steps = steps;
  }

  chat(
    messages: Message[],
    _tools: Tool[] | undefined,
    _options: ChatOptions,
  ): Promise<ChatResponse> {
    this.seen.push([...messages]);
    const step = this.#steps.shift() ?? { say: "(end of script)" };
    if (step === "hang") return new Promise<never>(() => {});
    if (step instanceof Error) return Promise.reject(step);
    const blocks: ContentBlock[] = [];
    if (step.say) blocks.push({ type: "text", text: step.say });
    for (const [name, input] of step.call ?? []) {
      blocks.push({ type: "tool_use", id: `use-${++this.#ids}`, name, input });
    }
    return Promise.resolve({
      message: new Message({ role: "assistant", content: blocks }),
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      finish_reason: step.call ? "tool_calls" : "stop",
    });
  }

  // deno-lint-ignore require-yield
  async *streamChat(): AsyncIterable<StreamChunk> {
    throw new Error("the agent does not stream");
  }
}

/** Files in memory, and a shell whose commands are scripted. */
class MemoryHost implements CodingHost {
  files = new Map<string, string>();
  commands: string[] = [];
  /** A command that runs until it is stopped. */
  hang = false;
  killed = 0;

  readFile(path: string): Promise<string> {
    const text = this.files.get(path);
    return text === undefined
      ? Promise.reject(new Error(`No such file: ${path}`))
      : Promise.resolve(text);
  }
  writeFile(path: string, text: string): Promise<void> {
    this.files.set(path, text);
    return Promise.resolve();
  }
  run(command: string, _cwd: string, signal: AbortSignal) {
    this.commands.push(command);
    if (this.hang) {
      return new Promise<{ stdout: string; stderr: string; code: number }>(
        (resolve) =>
          signal.addEventListener("abort", () => {
            this.killed++;
            resolve({ stdout: "", stderr: "(interrupted)", code: 130 });
          }),
      );
    }
    return Promise.resolve(
      command.startsWith("exit")
        ? { stdout: "", stderr: "bad", code: 2 }
        : { stdout: `ran ${command}\n`, stderr: "", code: 0 },
    );
  }
}

function session(
  steps: Step[],
  opts: {
    mode?: PermissionMode;
    answer?: PermissionDecision | "never";
  } = {},
) {
  const provider = new PlayedProvider(steps);
  const host = new MemoryHost();
  host.files.set("/p/notes.md", "hello from a file\nsecond line\n");
  const events: AgentEvent[] = [];
  const asked: PermissionRequest[] = [];
  const adapter = new InferenceAgentAdapter({
    label: "Test",
    provider,
    host,
    check: () => Promise.resolve([{ id: "m", label: "m" }]),
  });
  const start = adapter.start(
    {
      cwd: "/p",
      ...(opts.mode ? { permissionMode: opts.mode } : {}),
    },
    { event: (e) => events.push(e) },
    {
      approve: (req) => {
        asked.push(req);
        const a = opts.answer ?? "allow";
        return a === "never" ? new Promise(() => {}) : Promise.resolve(a);
      },
    },
  );
  const transcript = () => events.reduce(reduceTranscript, emptyTranscript());
  const turns = () => events.filter((e) => e.kind === "turnEnd").length;
  return { adapter, start, provider, host, events, asked, transcript, turns };
}

const toolRows = (rows: readonly Row[]) =>
  rows.filter((r): r is Extract<Row, { type: "tool" }> => r.type === "tool");

Deno.test("inference agent: its tools, and which of them ask in each mode", () => {
  assertEquals(CODING_TOOLS.map((t) => t.name), [
    "Read",
    "Write",
    "Edit",
    "Bash",
  ]);
  assertEquals(needsApproval("Read", undefined), false);
  assertEquals(needsApproval("Edit", undefined), true);
  assertEquals(needsApproval("Bash", "acceptEdits"), true);
  assertEquals(needsApproval("Write", "acceptEdits"), false);
  assertEquals(needsApproval("Edit", "plan"), "refuse");
  assertEquals(needsApproval("Read", "plan"), false);
  assertEquals(needsApproval("Bash", "bypassPermissions"), false);
  assertEquals(resolvePath("/p/q", "../x/./y.ts"), "/p/x/y.ts");
  assertEquals(resolvePath("/p", "/abs"), "/abs");
  assert(codingSystemPrompt("/p").includes("/p"));
});

Deno.test("inference agent: a turn reads, edits (asked, allowed), runs a command, answers", async () => {
  const s = session([
    { say: "Reading.", call: [["Read", { file_path: "notes.md" }]] },
    {
      call: [["Edit", {
        file_path: "notes.md",
        old_string: "hello",
        new_string: "goodbye",
      }]],
    },
    { call: [["Bash", { command: "git diff --stat" }]] },
    { say: "Changed the greeting." },
  ]);
  await s.start;
  assertEquals(s.events[0], {
    kind: "models",
    models: [{ id: "m", label: "m" }],
    at: s.events[0].at,
  });
  await s.adapter.send({ text: "change it" });
  await waitUntil(() => s.turns() === 1);
  const t = s.transcript();
  assertEquals(
    t.rows.map((r) =>
      r.type === "tool" ? `tool:${r.name}:${r.status}` : r.type
    ),
    [
      "text",
      "tool:Read:done",
      "tool:Edit:done",
      "tool:Bash:done",
      "text",
      "footer",
    ],
  );
  assertEquals(
    s.host.files.get("/p/notes.md"),
    "goodbye from a file\nsecond line\n",
  );
  assertEquals(s.asked.map((a) => a.toolName), ["Edit", "Bash"]);
  const [read, edit, bash] = toolRows(t.rows);
  assertEquals(read.detail?.readLines, 2);
  assertEquals(read.result, "1\thello from a file\n2\tsecond line");
  assertEquals(edit.detail?.patch, [
    { oldStart: 1, newStart: 1, lines: ["-hello", "+goodbye"] },
  ]);
  assertEquals(s.asked[0].toolUseId, edit.id);
  assertEquals(bash.detail?.stdout, "ran git diff --stat\n");
  assertEquals((t.rows.at(-1) as { outcome: string }).outcome, "done");
  // The model saw each tool's result.
  const last = s.provider.seen.at(-1)!;
  assert(JSON.stringify(last).includes("ran git diff --stat"));
});

Deno.test("inference agent: Deny refuses the tool; the model hears it", async () => {
  const s = session([
    { call: [["Write", { file_path: "new.txt", content: "x" }]] },
    { say: "OK, not writing." },
  ], { answer: "deny" });
  await s.start;
  await s.adapter.send({ text: "write" });
  await waitUntil(() => s.turns() === 1);
  assert(!s.host.files.has("/p/new.txt"));
  const row = toolRows(s.transcript().rows)[0];
  assertEquals(row.status, "error");
  assertEquals(row.result, "The user denied this tool call in Qutty.");
  assert(JSON.stringify(s.provider.seen.at(-1)).includes("denied"));
});

Deno.test("inference agent: plan mode refuses edits without asking; accept-edits writes without asking", async () => {
  const plan = session([
    {
      call: [["Edit", {
        file_path: "notes.md",
        old_string: "a",
        new_string: "b",
      }]],
    },
    { say: "Plan only." },
  ], { mode: "plan" });
  await plan.start;
  await plan.adapter.send({ text: "x" });
  await waitUntil(() => plan.turns() === 1);
  assertEquals(plan.asked.length, 0);
  assertEquals(
    toolRows(plan.transcript().rows)[0].result?.startsWith("Plan mode"),
    true,
  );

  const edits = session([
    { call: [["Write", { file_path: "a/b.txt", content: "one\ntwo\n" }]] },
    { say: "Wrote it." },
  ], { mode: "acceptEdits" });
  await edits.start;
  await edits.adapter.send({ text: "x" });
  await waitUntil(() => edits.turns() === 1);
  assertEquals(edits.asked.length, 0);
  assertEquals(edits.host.files.get("/p/a/b.txt"), "one\ntwo\n");
  assertEquals(toolRows(edits.transcript().rows)[0].detail?.wroteLines, 2);
});

Deno.test("inference agent: tool errors are rows; a failing command is an error with its code", async () => {
  const s = session([
    {
      call: [
        ["Edit", {
          file_path: "notes.md",
          old_string: "missing",
          new_string: "x",
        }],
        ["Bash", { command: "exit 2" }],
        ["Nope", {}],
      ],
    },
    { say: "Hmm." },
  ], { mode: "bypassPermissions" });
  await s.start;
  await s.adapter.send({ text: "x" });
  await waitUntil(() => s.turns() === 1);
  const rows = toolRows(s.transcript().rows);
  assertEquals(rows.map((r) => r.status), ["error", "error", "error"]);
  assertEquals(rows[0].result, "old_string is not in /p/notes.md");
  assertEquals(rows[1].result, "bad\n(exit code 2)");
  assertEquals(rows[2].result, "No such tool: Nope");
});

Deno.test("inference agent: a provider failure ends the turn failed with the reason", async () => {
  const s = session([new Error("Anthropic API: 529 overloaded")]);
  await s.start;
  await s.adapter.send({ text: "x" });
  await waitUntil(() => s.turns() === 1);
  const t = s.transcript();
  assertEquals((t.rows.at(-1) as { outcome: string }).outcome, "failed");
  assertEquals(t.error, "Anthropic API: 529 overloaded");
});

Deno.test("inference agent: interrupt stops the command, ends the turn and forgets it", async () => {
  const s = session([
    { call: [["Bash", { command: "sleep 100" }]] },
    { say: "fresh answer" },
  ], { mode: "bypassPermissions" });
  await s.start;
  s.host.hang = true;
  await s.adapter.send({ text: "first" });
  await waitUntil(() => s.host.commands.length === 1);
  await s.adapter.interrupt();
  assertEquals(s.host.killed, 1);
  const end = s.events.find((e) => e.kind === "turnEnd");
  assert(end?.kind === "turnEnd");
  assertEquals(end.subtype, "error_during_execution");
  assertEquals(
    (s.transcript().rows.at(-1) as { outcome: string }).outcome,
    "interrupted",
  );
  // The next turn starts from before the interrupted one: no tool call without its result.
  s.host.hang = false;
  await s.adapter.send({ text: "second" });
  await waitUntil(() => s.turns() === 2);
  const sent = s.provider.seen.at(-1)!;
  assertEquals(sent.length, 1);
  assert(JSON.stringify(sent[0]).includes("second"));
  // Nothing the stopped turn did arrives after it ended.
  assertEquals(s.events.filter((e) => e.kind === "toolResult").length, 0);
  s.adapter.stop();
});

Deno.test("inference agent: an interrupt while a question is open ends the turn", async () => {
  const s = session([
    { call: [["Bash", { command: "rm -rf build" }]] },
  ], { answer: "never" });
  await s.start;
  await s.adapter.send({ text: "x" });
  await waitUntil(() => s.asked.length === 1);
  await s.adapter.interrupt();
  assertEquals(s.turns(), 1);
  assertEquals(s.host.commands.length, 0);
});

Deno.test("inference backends: no key, no Ollama, no model; the adapter for each kind", async () => {
  const noKey = anthropicAgent({ cwd: "/p", model: "sonnet" }, {
    anthropicKey: () => Promise.resolve(null),
  });
  assertEquals(noKey.label, "Anthropic API (claude-sonnet-5-5)");
  const sink = { event() {} };
  const hooks = { approve: () => Promise.resolve("deny" as const) };
  await assertRejects(
    () => noKey.start({ cwd: "/p" }, sink, hooks),
    Error,
    "no Anthropic API key is saved",
  );
  const events: AgentEvent[] = [];
  const keyed = anthropicAgent({ cwd: "/p" }, {
    anthropicKey: () => Promise.resolve("sk-test"),
  });
  await keyed.start({ cwd: "/p" }, { event: (e) => events.push(e) }, hooks);
  assertEquals(
    events.find((e) => e.kind === "models"),
    { kind: "models", models: ANTHROPIC_AGENT_MODELS, at: events[0].at },
  );
  keyed.stop();

  const down = deferredOllamaAgent({ cwd: "/p" }, {
    anthropicKey: () => Promise.resolve(null),
    detect: () => Promise.resolve(undefined),
  });
  await assertRejects(
    () => down.start({ cwd: "/p" }, sink, hooks),
    Error,
    "no Ollama answers",
  );
  const missing = deferredOllamaAgent({ cwd: "/p", model: "nope:1b" }, {
    anthropicKey: () => Promise.resolve(null),
    detect: () => Promise.resolve(["qwen3:8b"]),
  });
  await assertRejects(
    () => missing.start({ cwd: "/p", model: "nope:1b" }, sink, hooks),
    Error,
    'Ollama has no model "nope:1b"',
  );
  const listed: AgentEvent[] = [];
  const first = deferredOllamaAgent({ cwd: "/p" }, {
    anthropicKey: () => Promise.resolve(null),
    detect: () => Promise.resolve(["qwen3:8b", "llama4:latest"]),
  });
  await first.start({ cwd: "/p" }, { event: (e) => listed.push(e) }, hooks);
  const models = listed.find((e) => e.kind === "models");
  assertEquals(
    models?.kind === "models" && models.models.map((m) => m.id),
    ["", "qwen3:8b", "llama4:latest"],
  );
  first.stop();

  const tile = { id: "agent-1", env: {} };
  const opts = { hubArgs: () => [] };
  assertEquals(
    createAgentAdapter({ cwd: "/p" }, tile, opts).label,
    "Claude Code",
  );
  assertEquals(
    createAgentAdapter({ cwd: "/p", agent: "codex" }, tile, opts).label,
    "Codex",
  );
  assertEquals(
    createAgentAdapter({ cwd: "/p", agent: "ollama" }, tile, opts).label,
    "Ollama",
  );
  assert(
    createAgentAdapter({ cwd: "/p", agent: "anthropic" }, tile, opts).label
      .startsWith("Anthropic API"),
  );
});
