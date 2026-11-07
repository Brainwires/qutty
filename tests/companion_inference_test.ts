// The companion's second brain (lib/companion/inference-brain.ts) over a scripted provider and a
// real hub: it calls the hub's tools in process as the companion (the same handler, permission
// check and audit log as the companion socket), keeps the conversation across turns, ends a turn
// on the provider's failure with the reason, stops quietly, and trims old turns at a user message.
// Also desktop/companion-brain.ts's model lookup and desktop/companion.ts's brain choice.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  ChatOptions,
  type ChatResponse,
  Message,
  type Provider,
  type StreamChunk,
  type Tool,
} from "@rullama/core";
import {
  InferenceBrain,
  MAX_TOOL_TEXT,
  toProviderTool,
  trimConversation,
} from "../lib/companion/inference-brain.ts";
import type { BrainEvent } from "../lib/companion/brain.ts";
import { CompanionRuntime } from "../lib/companion/runtime.ts";
import type { CompanionUpdate } from "../lib/companion/protocol.ts";
import {
  buildToolRegistry,
  companionToolbox,
  createHubHandler,
} from "../lib/hub/tools.ts";
import type { PrivilegedCall } from "../lib/hub/protocol.ts";
import { ScreenMirror } from "../lib/hub/mirror.ts";
import { ollamaHasModel } from "../desktop/companion-brain.ts";
import { CompanionHost } from "../desktop/companion.ts";
import { hubWithTiles, waitUntil } from "./hub_helpers.ts";

type Reply = { text?: string; tools?: { name: string; input: unknown }[] };

/** A provider that answers from a script and records what it was sent. */
class ScriptedProvider implements Provider {
  readonly name = "scripted";
  calls: { messages: Message[]; tools: Tool[] | undefined }[] = [];
  #replies: (Reply | Error | Promise<never>)[];
  #n = 0;

  constructor(replies: (Reply | Error | Promise<never>)[]) {
    this.#replies = replies;
  }

  chat(
    messages: Message[],
    tools: Tool[] | undefined,
    _options: ChatOptions,
  ): Promise<ChatResponse> {
    this.calls.push({ messages: [...messages], tools });
    const r = this.#replies.shift() ?? { text: "(out of script)" };
    if (r instanceof Error) return Promise.reject(r);
    if (r instanceof Promise) return r;
    const content = [
      ...(r.text ? [{ type: "text" as const, text: r.text }] : []),
      ...(r.tools ?? []).map((t) => ({
        type: "tool_use" as const,
        id: `call-${++this.#n}`,
        name: t.name,
        input: t.input,
      })),
    ];
    return Promise.resolve({
      message: new Message({ role: "assistant", content }),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      finish_reason: r.tools ? "tool_calls" : "stop",
    });
  }

  // deno-lint-ignore require-yield
  async *streamChat(): AsyncIterable<StreamChunk> {
    throw new Error("not streamed");
  }
}

function setup(replies: (Reply | Error | Promise<never>)[]) {
  const { core, env } = hubWithTiles();
  env.mirrors.set("pty-2", new ScreenMirror(40, 5));
  const audit: PrivilegedCall[] = [];
  const handler = createHubHandler(core, buildToolRegistry(core), {
    audit: (c) => audit.push(c),
  });
  const provider = new ScriptedProvider(replies);
  const brain = new InferenceBrain({
    label: "Test (scripted)",
    provider,
    tools: companionToolbox(handler),
  });
  const events: BrainEvent[] = [];
  const sink = { event: (e: BrainEvent) => events.push(e), exited() {} };
  return { core, env, audit, provider, brain, events, sink };
}

const turnEnd = (events: BrainEvent[]) =>
  events.find((e) => e.kind === "turnEnd") as
    | Extract<BrainEvent, { kind: "turnEnd" }>
    | undefined;

Deno.test("inference brain: calls the hub's tools as the companion and answers from them", async () => {
  const { env, audit, provider, brain, events, sink } = setup([
    { tools: [{ name: "list_peers", input: {} }] },
    {
      text: "Two agents.",
      tools: [{ name: "write_tile", input: { tile: "codex", text: "ls\r" } }],
    },
    { text: "Tiles: claude, codex and a shell. I ran ls in codex." },
  ]);
  await brain.start(sink);
  assertEquals(events[0], { kind: "ready" });
  await brain.send("what tiles exist?");
  await waitUntil(() => turnEnd(events), 2000);

  // The hub's tools were offered with their schemas.
  const offered = provider.calls[0].tools!.map((t) => t.name);
  assert(offered.includes("list_peers") && offered.includes("write_tile"));
  // list_peers ran as the companion; its result went back to the model.
  const second = provider.calls[1].messages;
  const result = second.at(-1)!;
  assertEquals(result.role, "tool");
  assertStringIncludes(JSON.stringify(result.content), '"you\\": \\"companion');
  assertStringIncludes(JSON.stringify(result.content), "pty-2");
  // A companion-only tool is allowed, carried out and audited as the companion.
  assertEquals(env.writes, [{ tileId: "pty-2", text: "ls\r" }]);
  assertEquals(audit.map((c) => [c.tool, c.by, c.ok]), [[
    "write_tile",
    "companion",
    true,
  ]]);
  assertEquals(
    events.filter((e) => e.kind === "toolUse").map((e) =>
      (e as { name: string }).name
    ),
    ["list_peers", "write_tile"],
  );
  assertEquals(turnEnd(events), {
    kind: "turnEnd",
    text: "Two agents.\n\nTiles: claude, codex and a shell. I ran ls in codex.",
    isError: false,
  });

  // The next turn continues the same conversation.
  events.length = 0;
  await brain.send("thanks");
  await waitUntil(() => turnEnd(events), 2000);
  const third = provider.calls.at(-1)!.messages;
  assertEquals(third[0].content, "what tiles exist?");
  assertEquals(third.at(-1)!.content, "thanks");
});

Deno.test("inference brain: a provider failure ends the turn with the reason; a tool error goes back to the model", async () => {
  const { brain, events, sink, provider } = setup([
    { tools: [{ name: "read_screen", input: { tile: "nope" } }] },
    new Error("Ollama API error (500): model crashed"),
  ]);
  await brain.start(sink);
  await brain.send("look at tile nope");
  await waitUntil(() => turnEnd(events), 2000);
  const end = turnEnd(events)!;
  assert(end.isError);
  assertStringIncludes(end.text, "model crashed");
  const toolResult = provider.calls[1].messages.at(-1)!;
  assertStringIncludes(JSON.stringify(toolResult.content), "is_error");
  assertStringIncludes(JSON.stringify(toolResult.content), "no tile is called");
});

Deno.test("inference brain: stop() mid-call ends the session quietly; start fails with the check's reason", async () => {
  const hang = new Promise<never>(() => {});
  const { brain, events, sink } = setup([hang]);
  await brain.start(sink);
  await brain.send("hello");
  await new Promise((r) => setTimeout(r, 10));
  brain.stop();
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(turnEnd(events), undefined);

  const failing = new InferenceBrain({
    label: "x",
    provider: new ScriptedProvider([]),
    tools: { list: () => [], call: () => Promise.reject(new Error("unused")) },
    check: () => Promise.reject(new Error('Ollama has no model "m"')),
  });
  let reason = "";
  await failing.start(sink).catch((e) => reason = e.message);
  assertEquals(reason, 'Ollama has no model "m"');
});

Deno.test("inference brain: long tool results are cut; schemas keep their required fields", async () => {
  const { events, sink, provider } = setup([
    { tools: [{ name: "big", input: {} }] },
    { text: "done" },
  ]);
  // The same provider, with a toolbox of one tool whose result is huge.
  const huge = new InferenceBrain({
    label: "x",
    provider,
    tools: {
      list: () => [{
        name: "big",
        description: "big",
        inputSchema: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
      }],
      call: () =>
        Promise.resolve({
          text: "x".repeat(MAX_TOOL_TEXT * 2),
          isError: false,
        }),
    },
  });
  await huge.start(sink);
  await huge.send("go");
  await waitUntil(() => turnEnd(events), 2000);
  const result = provider.calls[1].messages.at(-1)!.content as {
    content: string;
  }[];
  assertEquals(result[0].content.length, MAX_TOOL_TEXT);
  assertEquals(
    toProviderTool({
      name: "t",
      description: "d",
      inputSchema: { type: "object", properties: { x: {} }, required: ["x"] },
    }).input_schema,
    { type: "object", properties: { x: {} }, required: ["x"] },
  );
});

Deno.test("inference brain: old turns are dropped at a user message, never between a call and its result", () => {
  const turn = (n: number) => [
    Message.user(`q${n}`),
    new Message({
      role: "assistant",
      content: [{
        type: "tool_use",
        id: `c${n}`,
        name: "list_peers",
        input: {},
      }],
    }),
    Message.toolResult(`c${n}`, "{}"),
    Message.assistant(`a${n}`),
  ];
  const all = [1, 2, 3, 4, 5].flatMap(turn);
  const kept = trimConversation(all, 10);
  assertEquals(kept[0].content, "q4");
  assertEquals(kept.length, 8);
  assertEquals(trimConversation(all.slice(0, 4), 10).length, 4);
  // One turn longer than the limit: it is kept from its user message.
  assertEquals(trimConversation(turn(9), 2)[0].content, "q9");
});

Deno.test("inference brain: the runtime runs it like any adapter (status, streamed text, turn end)", async () => {
  const { brain } = setup([{ text: "Hi there." }]);
  const updates: CompanionUpdate[] = [];
  const runtime = new CompanionRuntime({
    mailbox: { unread: () => 0, take: () => [], requeue: () => 0 },
    adapter: "Ollama (test)",
    createBrain: () => brain,
    emit: (u) => updates.push(u),
    textThrottleMs: 0,
  });
  runtime.userSays("hello");
  await waitUntil(
    () => updates.find((u) => u.kind === "turn" && u.done),
    2000,
  );
  const done = updates.find((u) => u.kind === "turn" && u.done) as Extract<
    CompanionUpdate,
    { kind: "turn" }
  >;
  assertEquals(done.text, "Hi there.");
  assertEquals(runtime.status().adapter, "Ollama (test)");
  runtime.setAdapter("Claude Code");
  assertEquals(runtime.status().adapter, "Claude Code");
  runtime.stop();
});

Deno.test("brain choice: Ollama's model lookup; Settings switches the adapter and restarts the brain", async () => {
  assert(ollamaHasModel(["qwen3.8:27b-mlx"], "qwen3.8:27b-mlx"));
  assert(ollamaHasModel(["llama3:latest"], "llama3"));
  assert(!ollamaHasModel(["llama3:8b"], "llama3"));

  const { core } = hubWithTiles();
  const made: { engine?: string; model?: string }[] = [];
  const host = new CompanionHost({
    core,
    socketDir: "/nonexistent",
    mcpShim: "/bin/false",
    quttyDir: "/nonexistent",
    emit: () => {},
    listen: () => {},
    createBrain: (cfg) => {
      made.push({
        ...(cfg.engine ? { engine: cfg.engine } : {}),
        ...(cfg.model ? { model: cfg.model } : {}),
      });
      return {
        label: "fake",
        start: () => Promise.reject(new Error("no")),
        send: () => Promise.resolve(),
        stop: () => {},
      };
    },
  });
  assertEquals(
    host.configure(true, "qwen3.8:27b-mlx", "ollama").adapter,
    "Ollama (qwen3.8:27b-mlx)",
  );
  host.runtime.userSays("hi");
  await waitUntil(() => made.length > 0, 1000);
  assertEquals(made[0], { engine: "ollama", model: "qwen3.8:27b-mlx" });
  assertEquals(host.configure(true, "", "claude").adapter, "Claude Code");
  host.runtime.stop();
});
