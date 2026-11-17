// The agent tiles' session layer (lib/agent/sessions.ts) with a fake adapter and the real hub
// core: a session is a hub tile (name, status), a message starts the adapter, messages typed
// while it works wait in the queue, the permission round trip through the hub's `approve_tool`
// (listed only on an agent tile's own connection, answered from the page, Allow always
// remembered), interrupts, restarts, renames, `write_tile` as a prompt, and the scripted demo
// adapter driving the real parser end to end.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentHooks,
  type AgentMessage,
  type AgentSessionSpec,
  type AgentSink,
  sanitizeMessage,
} from "../lib/agent/adapter.ts";
import {
  type AgentHubSide,
  AgentSessions,
  type AgentUpdate,
} from "../lib/agent/sessions.ts";
import { HubCore } from "../lib/hub/core.ts";
import { buildToolRegistry, createHubHandler } from "../lib/hub/tools.ts";
import { DemoAgentAdapter } from "../lib/agent/demo.ts";
import {
  approveToolArgs,
  approveToolReply,
  PermissionBroker,
} from "../lib/agent/permissions.ts";
import { ctxFor, FakeEnv, resultText, tile, waitUntil } from "./hub_helpers.ts";

/** An adapter the test drives: what it was sent, and its sink to report events. */
class FakeAdapter implements AgentAdapter {
  readonly label = "fake";
  readonly images = true;
  sink: AgentSink | undefined;
  hooks: AgentHooks | undefined;
  spec: AgentSessionSpec | undefined;
  sent: AgentMessage[] = [];
  interrupts = 0;
  stopped = false;
  failStart: string | undefined;

  start(spec: AgentSessionSpec, sink: AgentSink, hooks: AgentHooks) {
    if (this.failStart) return Promise.reject(new Error(this.failStart));
    this.spec = spec;
    this.sink = sink;
    this.hooks = hooks;
    return Promise.resolve();
  }
  send(message: AgentMessage) {
    this.sent.push(message);
    return Promise.resolve();
  }
  interrupt() {
    this.interrupts++;
    this.emit({ kind: "interrupted", at: 0 });
    this.emit({
      kind: "turnEnd",
      isError: true,
      subtype: "error_during_execution",
      at: 0,
    });
    return Promise.resolve();
  }
  stop() {
    this.stopped = true;
  }
  emit(e: AgentEvent) {
    this.sink?.event(e);
  }
  end(ok = true) {
    this.emit({
      kind: "turnEnd",
      isError: !ok,
      subtype: ok ? "success" : "error_during_execution",
      ...(ok ? {} : { result: "boom" }),
      at: 0,
    });
  }
}

/** Sessions on fake adapters, with the real hub core behind them. */
function setup() {
  const env = new FakeEnv();
  const core = new HubCore(env);
  core.addTile({ id: "pty-1", harness: "claude" });
  const updates: AgentUpdate[] = [];
  const adapters: FakeAdapter[] = [];
  const hub: AgentHubSide = {
    open: (id, info) => {
      core.addTile({ id, cwd: info.cwd, harness: "claude" });
      return { env: { QUTTY_TILE_ID: id }, name: core.registry.get(id)!.name };
    },
    close: (id) => core.removeTile(id),
    setStatus: (id, status, note) => core.registry.setStatus(id, status, note),
    rename: (id, name) => core.registry.rename(id, name).name,
  };
  const sessions = new AgentSessions({
    emit: (u) => updates.push(u),
    hub,
    now: () => 5,
    createAdapter: () => {
      const a = new FakeAdapter();
      adapters.push(a);
      return a;
    },
  });
  const handler = createHubHandler(core, buildToolRegistry(core), {
    agents: {
      has: (id) => sessions.has(id),
      approve: (id, req) => sessions.approve(id, req),
    },
  });
  const events = () =>
    updates.flatMap((u) => "event" in u ? [u.event.kind] : []);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { core, sessions, updates, adapters, handler, events, flush };
}

Deno.test("a session is a hub tile; its first message starts the adapter and goes out", async () => {
  const { core, sessions, adapters, events, flush } = setup();
  const snap = sessions.start({ cwd: "/w", model: "opus" });
  assertEquals(snap.id, "agent-1");
  assertEquals(snap.name, "claude-2");
  assertEquals(core.registry.get("agent-1")?.harness, "claude");
  assertEquals(adapters.length, 0);
  assert(sessions.send("agent-1", { text: "hello" }));
  await flush();
  assertEquals(adapters.length, 1);
  assertEquals(adapters[0].spec, { cwd: "/w", model: "opus" });
  assertEquals(adapters[0].sent, [{ text: "hello" }]);
  assertEquals(core.registry.get("agent-1")?.status, "busy");
  adapters[0].emit({ kind: "session", sessionId: "s-1", at: 0 });
  adapters[0].end();
  assertEquals(core.registry.get("agent-1")?.status, "idle");
  assertEquals(events(), ["user", "session", "turnEnd"]);
  assertEquals(sessions.snapshot("agent-1")?.transcript.sessionId, "s-1");
  // Nothing to send, an unknown session: refused.
  assertEquals(sessions.send("agent-1", { text: "  " }), false);
  assertEquals(sessions.send("agent-9", { text: "x" }), false);
});

Deno.test("messages typed while a turn runs wait in the queue, then go one per turn", async () => {
  const { sessions, adapters, updates, flush } = setup();
  sessions.start({ cwd: "/w" });
  sessions.send("agent-1", { text: "one" });
  sessions.send("agent-1", { text: "two" });
  sessions.send("agent-1", { text: "three" });
  await flush();
  const a = adapters[0];
  assertEquals(a.sent.map((m) => m.text), ["one"]);
  assertEquals(sessions.snapshot("agent-1")?.transcript.queue, [
    "two",
    "three",
  ]);
  a.end();
  await flush();
  assertEquals(a.sent.map((m) => m.text), ["one", "two"]);
  assertEquals(sessions.snapshot("agent-1")?.transcript.queue, ["three"]);
  a.end();
  await flush();
  a.end();
  await flush();
  assertEquals(a.sent.map((m) => m.text), ["one", "two", "three"]);
  // Every update is numbered in order (a page that attaches drops what it has).
  const seqs = updates.map((u) => u.seq);
  assertEquals(seqs, [...seqs].sort((x, y) => x - y));
});

Deno.test("permission round trip through the hub: approve_tool → the tile → the answer", async () => {
  const { core, sessions, handler, updates, flush } = setup();
  sessions.start({ cwd: "/w" });
  sessions.send("agent-1", { text: "edit" });
  await flush();
  // Only the agent tile's own connection lists approve_tool.
  const names = (id: string) =>
    handler.listTools(ctxFor(tile(id))).map((t) => t.name);
  assert(names("agent-1").includes("approve_tool"));
  assert(!names("pty-1").includes("approve_tool"));
  const refused = await handler.callTool(
    "approve_tool",
    { tool_name: "Bash", input: {} },
    ctxFor(tile("pty-1")),
  );
  assert(refused.isError);
  // Claude Code asks (as it did when recorded: tool_name, input, tool_use_id).
  const input = {
    file_path: "/w/note.txt",
    old_string: "hello",
    new_string: "goodbye",
  };
  const call = handler.callTool(
    "approve_tool",
    { tool_name: "Edit", input, tool_use_id: "toolu_1" },
    ctxFor(tile("agent-1")),
  );
  await flush();
  const asked = updates.findLast((u) => "event" in u)!;
  assert("event" in asked && asked.event.kind === "permission");
  assertEquals(asked.event.toolName, "Edit");
  assertEquals(asked.event.toolUseId, "toolu_1");
  assertEquals(core.registry.get("agent-1")?.status, "waiting");
  assertEquals(sessions.snapshot("agent-1")?.transcript.asking, [
    asked.event.requestId,
  ]);
  assert(sessions.answer("agent-1", asked.event.requestId, "allow"));
  const reply = JSON.parse(resultText(await call));
  assertEquals(reply, { behavior: "allow", updatedInput: input });
  assertEquals(core.registry.get("agent-1")?.status, "busy");
  // A second answer to the same question does nothing.
  assertEquals(
    sessions.answer("agent-1", asked.event.requestId, "deny"),
    false,
  );

  // Deny.
  const denied = handler.callTool(
    "approve_tool",
    { tool_name: "Bash", input: { command: "rm -rf /" } },
    ctxFor(tile("agent-1")),
  );
  await flush();
  const q2 = sessions.snapshot("agent-1")!.transcript.asking[0];
  sessions.answer("agent-1", q2, "deny");
  const no = JSON.parse(resultText(await denied));
  assertEquals(no.behavior, "deny");
  assert(no.message.includes("denied"));

  // Allow always: the next call to that tool is answered without asking.
  const always = handler.callTool(
    "approve_tool",
    { tool_name: "Write", input: { file_path: "/w/a" } },
    ctxFor(tile("agent-1")),
  );
  await flush();
  sessions.answer(
    "agent-1",
    sessions.snapshot("agent-1")!.transcript.asking[0],
    "always",
  );
  await always;
  const before = updates.length;
  const again = JSON.parse(resultText(
    await handler.callTool(
      "approve_tool",
      { tool_name: "Write", input: { file_path: "/w/b" } },
      ctxFor(tile("agent-1")),
    ),
  ));
  assertEquals(again, {
    behavior: "allow",
    updatedInput: { file_path: "/w/b" },
  });
  assertEquals(updates.length, before);
});

Deno.test("interrupt: open questions are denied, the queue dropped, the adapter told", async () => {
  const { sessions, adapters, flush } = setup();
  sessions.start({ cwd: "/w" });
  sessions.send("agent-1", { text: "work" });
  sessions.send("agent-1", { text: "later" });
  await flush();
  const a = adapters[0];
  const answer = a.hooks!.approve({ toolName: "Bash", input: {} });
  await flush();
  assert(await sessions.interrupt("agent-1"));
  assertEquals(await answer, "deny");
  assertEquals(a.interrupts, 1);
  const t = sessions.snapshot("agent-1")!.transcript;
  assertEquals([t.running, t.queue, t.asking], [false, [], []]);
  const footer = t.rows.at(-1)!;
  assert(footer.type === "footer");
  assertEquals(footer.outcome, "interrupted");
  // Nothing runs: nothing to interrupt.
  assertEquals(await sessions.interrupt("agent-1"), false);
});

Deno.test("a failed turn: the tile waits for the user with a note; a start that fails is an error row", async () => {
  const { core, sessions, adapters, flush } = setup();
  sessions.start({ cwd: "/w" });
  sessions.send("agent-1", { text: "go" });
  await flush();
  adapters[0].end(false);
  assertEquals(core.registry.get("agent-1")?.status, "waiting");
  assertEquals(core.registry.get("agent-1")?.note, "error");
  assertEquals(sessions.snapshot("agent-1")!.transcript.error, "boom");
  // The process ends: the next message starts a new adapter that resumes the session.
  adapters[0].emit({ kind: "session", sessionId: "s-7", at: 0 });
  adapters[0].emit({ kind: "exit", reason: "Claude Code ended", at: 0 });
  sessions.send("agent-1", { text: "again" });
  await flush();
  assertEquals(adapters.length, 2);
  assertEquals(adapters[1].spec?.resumeId, "s-7");

  const fail = new FakeAdapter();
  fail.failStart = "Claude Code is not installed";
  const failing = new AgentSessions({
    emit: () => {},
    createAdapter: () => fail,
  });
  failing.start({ cwd: "/w" });
  failing.send("agent-1", { text: "x" });
  await flush();
  const t = failing.snapshot("agent-1")!.transcript;
  assertEquals(t.error, "Claude Code is not installed");
  assertEquals(t.rows.at(-1)?.type, "error");
});

Deno.test("restart: another model resumes the session; a new session starts over", async () => {
  const { sessions, adapters, updates, flush } = setup();
  sessions.start({ cwd: "/w", model: "sonnet" });
  sessions.send("agent-1", { text: "hi" });
  await flush();
  adapters[0].emit({ kind: "session", sessionId: "s-1", at: 0 });
  adapters[0].end();
  const snap = sessions.restart("agent-1", { model: "opus" })!;
  assertEquals(snap.spec.model, "opus");
  assert(adapters[0].stopped);
  assert("snapshot" in updates.at(-1)!);
  sessions.send("agent-1", { text: "next" });
  await flush();
  assertEquals(adapters[1].spec, { cwd: "/w", model: "opus", resumeId: "s-1" });
  adapters[1].end();
  const fresh = sessions.restart("agent-1", { fresh: true })!;
  assertEquals(fresh.transcript.sessionId, undefined);
  assertEquals(fresh.transcript.rows.map((r) => r.type), ["notice"]);
  sessions.send("agent-1", { text: "new" });
  await flush();
  assertEquals(adapters[2].spec?.resumeId, undefined);
  // The default model.
  assertEquals(
    sessions.restart("agent-1", { model: "" })!.spec.model,
    undefined,
  );
});

Deno.test("rename, attach, resume with saved rows, write_tile as a prompt, stop", async () => {
  const { core, sessions, adapters, updates, flush } = setup();
  sessions.start({ cwd: "/w", owner: "ws-1" });
  assertEquals(sessions.rename("agent-1", "builder"), "builder");
  assertEquals(core.registry.get("agent-1")?.name, "builder");
  assertThrows(() => sessions.rename("agent-1", "companion"));
  // Attaching to a running session returns it as it is.
  assertEquals(
    sessions.start({ cwd: "/x", attach: "agent-1" }).name,
    "builder",
  );
  // A session that is gone: a new one resumes, under the saved rows.
  const resumed = sessions.start({
    cwd: "/w",
    attach: "agent-77",
    resumeId: "665799d1-8fd9-4a23-9b59-3ee348bd92e9",
    rows: [{ type: "text", id: "x", text: "before", at: 0 }],
    name: "builder",
  });
  assertEquals(resumed.id, "agent-2");
  // Its old name is taken (the session it had still runs here): it keeps its default one.
  assertEquals(resumed.name, "claude-2");
  assertEquals(resumed.transcript.rows.map((r) => r.type), ["text", "notice"]);
  assertEquals(
    resumed.transcript.sessionId,
    "665799d1-8fd9-4a23-9b59-3ee348bd92e9",
  );
  // The companion's write_tile: a prompt once it presses Enter, refused without.
  sessions.typed("agent-1", "run the tests\r");
  await flush();
  assertEquals(adapters[0].sent, [{ text: "run the tests" }]);
  assertThrows(() => sessions.typed("agent-1", "half a line"));
  assertEquals(sessions.screen("agent-1")?.includes("> run the tests"), true);
  // The workspace ends: its sessions end, their hub tiles go.
  sessions.stopOwnedBy("ws-1");
  assert(!sessions.has("agent-1") && sessions.has("agent-2"));
  assert(adapters[0].stopped);
  assertEquals(core.registry.get("agent-1"), undefined);
  assert(updates.some((u) => u.id === "agent-1" && "closed" in u));
  sessions.stopAll();
  assertEquals(sessions.ids(), []);
});

Deno.test("the demo adapter drives the real parser: a question, Allow, a footer", async () => {
  const updates: AgentUpdate[] = [];
  const sessions = new AgentSessions({
    emit: (u) => updates.push(u),
    createAdapter: () => new DemoAgentAdapter(),
  });
  sessions.start({ cwd: "/Users/demo/project" });
  sessions.send("agent-1", { text: "edit the notes" });
  const t1 = (await waitUntil(
    () => {
      const t = sessions.snapshot("agent-1")!.transcript;
      return t.asking.length > 0 ? t : undefined;
    },
    5000,
    "the question",
  ))!;
  sessions.answer("agent-1", t1.asking[0], "allow");
  const t = (await waitUntil(
    () => {
      const t = sessions.snapshot("agent-1")!.transcript;
      return t.running ? undefined : t;
    },
    5000,
    "the end",
  ))!;
  const tools = t.rows.flatMap((r) =>
    r.type === "tool" ? [`${r.name}:${r.status}`] : []
  );
  assertEquals(tools, ["Read:done", "Grep:done", "Edit:done", "Bash:done"]);
  assertEquals(t.rows.at(-1)?.type, "footer");
  sessions.stopAll();
});

Deno.test("messages and permission arguments from outside are checked", () => {
  assertEquals(sanitizeMessage({ text: "hi", attachments: "x" }), {
    text: "hi",
  });
  assertEquals(sanitizeMessage({ text: "" }), undefined);
  assertEquals(sanitizeMessage(null), undefined);
  const img = sanitizeMessage({
    text: "",
    attachments: [
      { name: "a.png", kind: "image", mediaType: "image/png", data: "QQ==" },
      { name: "a.svg", kind: "image", mediaType: "image/svg+xml", data: "x" },
      { name: "b", kind: "exe", mediaType: "x", data: "x" },
    ],
  });
  assertEquals(img?.attachments?.map((a) => a.name), ["a.png"]);
  assertEquals(approveToolArgs({ input: {} }), undefined);
  assertEquals(approveToolArgs({ tool_name: "Bash", input: "rm" }), {
    toolName: "Bash",
    input: {},
  });
  assertEquals(approveToolReply("always", { a: 1 }), {
    behavior: "allow",
    updatedInput: { a: 1 },
  });
  const b = new PermissionBroker("p");
  const q = b.ask({ toolName: "X", input: {} });
  assertEquals(b.open().map((o) => o.requestId), [q.requestId]);
  assertEquals(b.withdrawAll(), [q.requestId]);
});

Deno.test("an adapter that cannot start rejects the hub's question as deny", async () => {
  const { sessions } = setup();
  const broken = new FakeAdapter();
  broken.failStart = "no claude";
  await assertRejects(
    () =>
      broken.start({ cwd: "/w" }, { event: () => {} }, {
        approve: () => Promise.resolve("deny"),
      }),
    Error,
    "no claude",
  );
  assertEquals(
    await sessions.approve("agent-9", { toolName: "Bash", input: {} }),
    "deny",
  );
});
