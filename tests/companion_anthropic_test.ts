// The companion's API key brain (lib/companion/anthropic-provider.ts, desktop/companion-brain.ts
// `anthropicCompanionBrain`) over a fake `fetch`: no request ever leaves the process. The request
// (endpoint, headers, model, no sampling options, tools, the refusal fallback), a reply's own
// blocks (thinking included) sent back exactly as they came, the key read for every request and
// a removed key no longer used, the API's errors and refusals, the abort signal, a whole turn with
// a tool call against a real hub, and desktop/companion.ts choosing it.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ChatOptions, Message } from "@rullama/core";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_URL,
  AnthropicApiProvider,
  wireMessages,
} from "../lib/companion/anthropic-provider.ts";
import { anthropicCompanionBrain } from "../desktop/companion-brain.ts";
import { CompanionHost } from "../desktop/companion.ts";
import type { BrainEvent } from "../lib/companion/brain.ts";
import { companionKeys } from "../lib/companion/keys.ts";
import {
  brainChoice,
  DEFAULT_COMPANION,
  sanitizeCompanion,
} from "../lib/companion/settings.ts";
import {
  buildToolRegistry,
  companionToolbox,
  createHubHandler,
} from "../lib/hub/tools.ts";
import { ScreenMirror } from "../lib/hub/mirror.ts";
import { hubWithTiles, waitUntil } from "./hub_helpers.ts";
import { memorySecureStore } from "./session_helpers.ts";

type Sent = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & {
    messages: { role: string; content: Record<string, unknown>[] }[];
  };
  signal?: AbortSignal;
};

/** A fake `fetch` answering from a script and recording each request. */
function fakeFetch(replies: (Response | (() => Response))[]) {
  const sent: Sent[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      new Headers(init?.headers).entries(),
    );
    sent.push({
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    const next = replies.shift();
    const response = typeof next === "function" ? next() : next;
    return Promise.resolve(
      response ?? new Response("no more", { status: 500 }),
    );
  };
  return { fetch: fn as typeof fetch, sent };
}

const reply = (content: unknown[], stop = "end_turn") =>
  Response.json({
    content,
    stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 5 },
  });

const options = () => new ChatOptions({ system: "be brief", max_tokens: 64 });

Deno.test("Anthropic provider: the request (endpoint, key, model, no sampling, tools, fallback)", async () => {
  const f = fakeFetch([reply([{ type: "text", text: "hi" }])]);
  const provider = new AnthropicApiProvider({
    key: () => Promise.resolve("sk-ant-test"),
    model: ANTHROPIC_MODELS.opus,
    fetch: f.fetch,
  });
  const r = await provider.chat([Message.user("hello")], [{
    name: "list_peers",
    description: "List the tiles",
    input_schema: { type: "object", properties: {}, required: [] },
  }], options());
  assertEquals(r.message.content, [{ type: "text", text: "hi" }]);
  assertEquals(r.usage.total_tokens, 15);
  const [req] = f.sent;
  assertEquals(req.url, ANTHROPIC_URL);
  assertEquals(new URL(req.url).host, "api.anthropic.com");
  assertEquals(req.headers["x-api-key"], "sk-ant-test");
  assertEquals(req.headers["anthropic-version"], "2023-06-01");
  assertEquals(
    req.headers["anthropic-beta"],
    "server-side-fallback-2026-07-01",
  );
  assertEquals(req.body.model, "claude-opus-5-5");
  assertEquals(req.body.system, "be brief");
  assertEquals(req.body.fallbacks, "default");
  assertEquals(req.body.max_tokens, 16_000);
  // ChatOptions defaults a temperature; the current models refuse sampling options.
  assertEquals("temperature" in req.body, false);
  assertEquals("top_p" in req.body, false);
  assertEquals(req.body.tools, [{
    name: "list_peers",
    description: "List the tiles",
    input_schema: { type: "object", properties: {}, required: [] },
  }]);
  assertEquals(req.body.messages, [{
    role: "user",
    content: [{ type: "text", text: "hello" }],
  }]);

  // Haiku has no server-side fallback: neither the header nor the field.
  const h = fakeFetch([reply([{ type: "text", text: "ok" }])]);
  await new AnthropicApiProvider({
    key: () => Promise.resolve("k"),
    model: ANTHROPIC_MODELS.haiku,
    fetch: h.fetch,
  }).chat([Message.user("x")], undefined, options());
  assertEquals(h.sent[0].body.model, "claude-haiku-5-5");
  assertEquals("fallbacks" in h.sent[0].body, false);
  assertEquals(h.sent[0].headers["anthropic-beta"], undefined);
  assertEquals("tools" in h.sent[0].body, false);
});

Deno.test("Anthropic provider: a reply goes back exactly as it came (thinking blocks included)", async () => {
  const blocks = [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "toolu_1", name: "list_peers", input: {} },
  ];
  const f = fakeFetch([
    reply(blocks, "tool_use"),
    reply([{ type: "text", text: "Two." }]),
  ]);
  const provider = new AnthropicApiProvider({
    key: () => Promise.resolve("k"),
    model: ANTHROPIC_MODELS.sonnet,
    fetch: f.fetch,
  });
  const first = await provider.chat(
    [Message.user("tiles?")],
    undefined,
    options(),
  );
  // The loop sees the text and the call, not the thinking.
  assertEquals(first.message.content, [
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "toolu_1", name: "list_peers", input: {} },
  ]);
  const history = [
    Message.user("tiles?"),
    first.message,
    new Message({
      role: "tool",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "a, b",
      }],
    }),
    new Message({
      role: "tool",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_2",
        content: "boom",
        is_error: true,
      }],
    }),
  ];
  await provider.chat(history, undefined, options());
  assertEquals(f.sent[1].body.messages, [
    { role: "user", content: [{ type: "text", text: "tiles?" }] },
    { role: "assistant", content: blocks },
    // Consecutive tool results arrive as one user turn.
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "a, b" },
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: "boom",
          is_error: true,
        },
      ],
    },
  ]);
  // System messages and empty turns are left out.
  assertEquals(wireMessages([Message.system("s"), Message.user("")]), []);
});

Deno.test("Anthropic provider: the key is read for every request; no key, a refused key, a refusal", async () => {
  const store = memorySecureStore();
  const keys = companionKeys(() => store);
  await keys.set("anthropic", "sk-1");
  const f = fakeFetch([
    reply([{ type: "text", text: "a" }]),
    reply([{ type: "text", text: "b" }]),
    new Response(
      JSON.stringify({
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
      { status: 401 },
    ),
    reply([], "refusal"),
    new Response("overloaded", { status: 529 }),
  ]);
  const provider = new AnthropicApiProvider({
    key: () => keys.get("anthropic"),
    model: ANTHROPIC_MODELS[""],
    fetch: f.fetch,
  });
  const ask = () => provider.chat([Message.user("q")], undefined, options());
  await ask();
  await keys.set("anthropic", "sk-2");
  await ask();
  assertEquals(f.sent.map((s) => s.headers["x-api-key"]), ["sk-1", "sk-2"]);
  await assertRejects(
    ask,
    Error,
    "the API key was refused (Settings → Companion): invalid x-api-key",
  );
  await assertRejects(ask, Error, "Claude declined to answer");
  await assertRejects(ask, Error, "Anthropic API error 529: overloaded");
  // Removed: no request at all.
  await keys.clear("anthropic");
  const before = f.sent.length;
  await assertRejects(ask, Error, "no Anthropic API key");
  assertEquals(f.sent.length, before);
});

Deno.test("Anthropic provider: the companion's stop aborts the request", async () => {
  const f = fakeFetch([reply([{ type: "text", text: "a" }])]);
  const provider = new AnthropicApiProvider({
    key: () => Promise.resolve("k"),
    model: ANTHROPIC_MODELS[""],
    fetch: f.fetch,
  });
  const stop = new AbortController();
  await provider.chat(
    [Message.user("q")],
    undefined,
    new ChatOptions({ signal: stop.signal }),
  );
  assert(f.sent[0].signal === stop.signal);
});

Deno.test("API key brain: a whole turn with a hub tool, as the companion", async () => {
  const { core, env } = hubWithTiles();
  env.mirrors.set("pty-2", new ScreenMirror(40, 5));
  const handler = createHubHandler(core, buildToolRegistry(core));
  const store = memorySecureStore({ "companion.anthropic.apiKey": "sk-ant-t" });
  const keys = companionKeys(() => store);
  const f = fakeFetch([
    reply([
      { type: "thinking", thinking: "", signature: "s" },
      { type: "tool_use", id: "toolu_9", name: "list_peers", input: {} },
    ], "tool_use"),
    reply([{ type: "text", text: "Three tiles." }]),
  ]);
  const brain = anthropicCompanionBrain(
    "sonnet",
    () => keys.get("anthropic"),
    companionToolbox(handler),
    f.fetch,
  );
  assertEquals(brain.label, "Anthropic API (claude-sonnet-5-5)");
  const events: BrainEvent[] = [];
  await brain.start({ event: (e) => events.push(e), exited() {} });
  await brain.send("what tiles exist?");
  await waitUntil(() => events.some((e) => e.kind === "turnEnd"), 2000);
  assertEquals(events.find((e) => e.kind === "turnEnd"), {
    kind: "turnEnd",
    text: "Three tiles.",
    isError: false,
  });
  assertEquals(f.sent.length, 2);
  assert(
    (f.sent[0].body.tools as { name: string }[]).some((t) =>
      t.name === "list_peers"
    ),
  );
  const second = f.sent[1].body.messages;
  assertEquals(second[1].content[0], {
    type: "thinking",
    thinking: "",
    signature: "s",
  });
  const result = second[2].content[0] as {
    tool_use_id: string;
    content: string;
  };
  assertEquals(result.tool_use_id, "toolu_9");
  assertStringIncludes(result.content, "pty-2");
});

Deno.test("API key brain: no saved key fails the start, before any request", async () => {
  const f = fakeFetch([]);
  const brain = anthropicCompanionBrain(
    "",
    () => Promise.resolve(null),
    { list: () => [], call: () => Promise.reject(new Error("unused")) },
    f.fetch,
  );
  assertEquals(brain.label, "Anthropic API (claude-opus-5-5)");
  await assertRejects(
    () => brain.start({ event() {}, exited() {} }),
    Error,
    "no Anthropic API key is saved (Settings → Companion)",
  );
  assertEquals(f.sent.length, 0);
});

Deno.test("CompanionHost: Settings' API key brain is built with the hub's key (none: it does not start)", async () => {
  const { core } = hubWithTiles();
  const store = memorySecureStore();
  const keys = companionKeys(() => store);
  const host = new CompanionHost({
    core,
    socketDir: "/nonexistent",
    mcpShim: "/bin/false",
    quttyDir: "/nonexistent",
    emit: () => {},
    listen: () => {},
    tools: () => ({
      list: () => [],
      call: () => Promise.reject(new Error("unused")),
    }),
    anthropicKey: () => keys.get("anthropic"),
  });
  assertEquals(
    host.configure(true, "haiku", "anthropic").adapter,
    "Anthropic API (claude-haiku-5-5)",
  );
  assertEquals(
    host.configure(true, "", "anthropic").adapter,
    "Anthropic API (claude-opus-5-5)",
  );
  // No key saved: the brain refuses to start (the check runs before any request is made).
  host.runtime.userSays("hi");
  await waitUntil(() => host.runtime.status().state === "error", 2000);
  assertStringIncludes(
    host.runtime.status().detail ?? "",
    "no Anthropic API key is saved",
  );
  host.runtime.stop();
});

Deno.test("settings: the API key brain is a brain choice, sharing Claude Code's model", () => {
  const s = sanitizeCompanion({ engine: "anthropic", model: "sonnet" });
  assertEquals(s.engine, "anthropic");
  assertEquals(brainChoice(s), { engine: "anthropic", model: "sonnet" });
  assertEquals(
    sanitizeCompanion({ engine: "openai" }).engine,
    DEFAULT_COMPANION.engine,
  );
});
