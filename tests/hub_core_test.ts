// The agent hub's logic (lib/hub/): the registry's names, message routing, mailbox states,
// ask_user, the permission matrix through the MCP handler, and the hook responses.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { HubError } from "../lib/hub/core.ts";
import { Mailboxes } from "../lib/hub/mailbox.ts";
import { nameProblem, Registry } from "../lib/hub/registry.ts";
import {
  canCall,
  COMPANION_TOOLS,
  type HubMessage,
  TILE_TOOLS,
} from "../lib/hub/protocol.ts";
import {
  buildToolRegistry,
  createHubHandler,
  harnessOfClient,
} from "../lib/hub/tools.ts";
import { formatMessages, notificationStatus } from "../lib/hub/hooks.ts";
import { ScreenMirror } from "../lib/hub/mirror.ts";
import {
  COMPANION_ID,
  ctxFor,
  FakeEnv,
  hubWithTiles,
  resultText,
  tile,
} from "./hub_helpers.ts";
import { HubCore } from "../lib/hub/core.ts";

// --- registry ------------------------------------------------------------------------------------

Deno.test("registry: default names from the harness, unique, shell-<n> otherwise", () => {
  const r = new Registry();
  assertEquals(r.add({ id: "pty-1", harness: "claude" }).name, "claude");
  assertEquals(r.add({ id: "pty-2", harness: "claude" }).name, "claude-2");
  assertEquals(r.add({ id: "pty-3" }).name, "shell-3");
  assertEquals(r.resolve("CLAUDE-2")?.id, "pty-2");
  assertEquals(r.resolve("pty-3")?.name, "shell-3");
  assertEquals(r.resolve("nobody"), undefined);
});

Deno.test("registry: a default-named tile takes its harness's name once known; a renamed one keeps its name", () => {
  const r = new Registry();
  r.add({ id: "pty-1" });
  r.add({ id: "pty-2" });
  r.setHarness("pty-1", "claude");
  assertEquals(r.get("pty-1")?.name, "claude");
  r.rename("pty-2", "reviewer");
  r.setHarness("pty-2", "codex");
  assertEquals(r.get("pty-2")?.name, "reviewer");
  assertEquals(r.get("pty-2")?.harness, "codex");
});

Deno.test("registry: rename refuses taken, reserved and malformed names", () => {
  const r = new Registry();
  r.add({ id: "pty-1", harness: "claude" });
  r.add({ id: "pty-2" });
  assertThrows(() => r.rename("pty-2", "Claude"), Error, "already");
  for (
    const bad of [
      "companion",
      "ALL",
      "user",
      "pty-9",
      "",
      "has space",
      "-dash",
      "x".repeat(41),
    ]
  ) {
    assert(nameProblem(bad) !== null, bad);
    assertThrows(() => r.rename("pty-2", bad));
  }
  assertEquals(r.rename("pty-2", "tests.runner_2").name, "tests.runner_2");
  // Renaming to its own name (other case) is fine.
  assertEquals(r.rename("pty-2", "TESTS.runner_2").name, "TESTS.runner_2");
});

// --- mailboxes -----------------------------------------------------------------------------------

Deno.test("mailbox: queued → delivered (hook) or read (pull); each message handed over once", () => {
  const changes: string[] = [];
  const m = new Mailboxes((o) => changes.push(o));
  const a = m.post({ from: "pty-1", fromName: "a", to: "pty-2", text: "one" });
  m.post({ from: "pty-1", fromName: "a", to: "pty-2", text: "two" });
  assertEquals(a.state, "queued");
  assertEquals(m.unread("pty-2"), 2);
  const delivered = m.take("pty-2", "delivered");
  assertEquals(delivered.map((x) => [x.text, x.state]), [["one", "delivered"], [
    "two",
    "delivered",
  ]]);
  assertEquals(m.unread("pty-2"), 0);
  assertEquals(m.take("pty-2", "read"), []);
  m.post({ from: "pty-1", fromName: "a", to: "pty-2", text: "three" });
  assertEquals(m.take("pty-2", "read").map((x) => x.state), ["read"]);
  assertEquals(m.history("pty-2").map((x) => x.state), [
    "delivered",
    "delivered",
    "read",
  ]);
  assert(changes.every((o) => o === "pty-2"));
});

Deno.test("mailbox: waitFor resolves on a post, on timeout (empty) and on abort (empty)", async () => {
  const m = new Mailboxes();
  const waiting = m.waitFor("pty-2", 5000);
  setTimeout(
    () => m.post({ from: "pty-1", fromName: "a", to: "pty-2", text: "hi" }),
    20,
  );
  assertEquals((await waiting).map((x) => [x.text, x.state]), [["hi", "read"]]);
  assertEquals(await m.waitFor("pty-2", 30), []);
  const ac = new AbortController();
  const aborted = m.waitFor("pty-2", 5000, ac.signal);
  setTimeout(() => ac.abort(), 20);
  assertEquals(await aborted, []);
  // A message already waiting returns at once.
  m.post({ from: "pty-1", fromName: "a", to: "pty-2", text: "ready" });
  assertEquals((await m.waitFor("pty-2", 5000)).length, 1);
});

// --- routing -------------------------------------------------------------------------------------

Deno.test("routing: tile → tile by name and by id, with replyTo", () => {
  const { core } = hubWithTiles();
  const [m] = core.send(tile("pty-1"), "codex", "run the tests");
  assertEquals([m.from, m.fromName, m.to], ["pty-1", "claude", "pty-2"]);
  const [r] = core.send(tile("pty-2"), "pty-1", "green", m.id);
  assertEquals([r.to, r.replyTo], ["pty-1", m.id]);
  assertEquals(core.registry.get("pty-2")?.unread, 1);
  assertEquals(core.read(tile("pty-2")).map((x) => x.text), ["run the tests"]);
  assertEquals(core.registry.get("pty-2")?.unread, 0);
});

Deno.test("routing: → companion, and the companion → a tile", () => {
  const { core } = hubWithTiles();
  core.send(tile("pty-3"), "companion", "help");
  assertEquals(core.read(COMPANION_ID).map((x) => [x.from, x.text]), [[
    "pty-3",
    "help",
  ]]);
  core.send(COMPANION_ID, "claude", "hello");
  assertEquals(core.read(tile("pty-1")).map((x) => [x.from, x.fromName]), [[
    "companion",
    "companion",
  ]]);
});

Deno.test("routing: broadcast reaches every other tile, not the sender or the companion", () => {
  const { core } = hubWithTiles();
  const sent = core.send(tile("pty-1"), "all", "heads up");
  assertEquals(sent.map((m) => m.to).sort(), ["pty-2", "pty-3"]);
  assertEquals(core.mailboxes.unread("companion"), 0);
  assertEquals(core.mailboxes.unread("pty-1"), 0);
});

Deno.test("routing: unknown target, self, empty and oversized messages are refused", () => {
  const { core } = hubWithTiles();
  assertThrows(
    () => core.send(tile("pty-1"), "nobody", "x"),
    HubError,
    "no tile",
  );
  assertThrows(
    () => core.send(tile("pty-1"), "claude", "x"),
    HubError,
    "itself",
  );
  assertThrows(() => core.send(tile("pty-1"), "codex", ""), HubError, "empty");
  assertThrows(
    () => core.send(tile("pty-1"), "codex", "x".repeat(40_000)),
    HubError,
  );
  const lonely = new HubCore(new FakeEnv());
  lonely.addTile({ id: "pty-1" });
  assertThrows(
    () => lonely.send(tile("pty-1"), "all", "x"),
    HubError,
    "no other",
  );
});

Deno.test("routing: a closed tile's mailbox and waiters go away", async () => {
  const { core } = hubWithTiles();
  const waiting = core.wait(tile("pty-2"), 5000);
  core.removeTile("pty-2");
  assertEquals(await waiting, []);
  assertThrows(() => core.send(tile("pty-1"), "codex", "x"), HubError);
});

// --- ask_user ------------------------------------------------------------------------------------

Deno.test("ask_user: a waited question resolves with the button the user picked", async () => {
  const { core, env } = hubWithTiles();
  const { id, answer } = core.ask(tile("pty-1"), "Deploy?", ["Yes", "No"], {
    wait: true,
  });
  assertEquals(env.asks[0], {
    id,
    from: "pty-1",
    fromName: "claude",
    text: "Deploy?",
    actions: ["Yes", "No"],
  });
  assertEquals(core.openAsks().length, 1);
  assert(core.answer(id, "Yes"));
  assertEquals(await answer, "Yes");
  assertEquals(env.closed, [id]);
  assertEquals(core.openAsks(), []);
  assertEquals(core.answer(id, "No"), false);
});

Deno.test("ask_user: not waited → the answer arrives as a message from the user; default button OK", () => {
  const { core, env } = hubWithTiles();
  const { id, answer } = core.ask(tile("pty-2"), "FYI", [], { wait: false });
  assertEquals(answer, null);
  assertEquals(env.asks[0].actions, ["OK"]);
  core.answer(id, "OK");
  const [m] = core.read(tile("pty-2"));
  assertEquals([m.from, m.replyTo], ["user", id]);
  assert(m.text.includes("OK"));
});

Deno.test("ask_user: cancellation, timeout and the asker's tile closing all resolve null", async () => {
  const { core } = hubWithTiles();
  const ac = new AbortController();
  const a = core.ask(tile("pty-1"), "?", [], { wait: true, signal: ac.signal });
  ac.abort();
  assertEquals(await a.answer, null);
  const b = core.ask(tile("pty-1"), "?", [], { wait: true, timeoutMs: 20 });
  assertEquals(await b.answer, null);
  const c = core.ask(tile("pty-3"), "?", [], { wait: true });
  core.removeTile("pty-3");
  assertEquals(await c.answer, null);
  assertEquals(core.openAsks(), []);
});

// --- permissions ---------------------------------------------------------------------------------

Deno.test("permission matrix: tiles get the tile tools; only the companion gets the rest", () => {
  for (const t of TILE_TOOLS) {
    assert(canCall(tile("pty-1"), t), t);
    assert(canCall(COMPANION_ID, t), t);
  }
  for (const t of COMPANION_TOOLS) {
    assertEquals(canCall(tile("pty-1"), t), false, t);
    assert(canCall(COMPANION_ID, t), t);
  }
  assertEquals(canCall(COMPANION_ID, "rm_rf"), false);
});

Deno.test("MCP handler: every tool is listed; a tile calling write_tile is refused, the companion is allowed", async () => {
  const { core, env } = hubWithTiles();
  const handler = createHubHandler(core, buildToolRegistry(core));
  const names = handler.listTools().map((t) => t.name).sort();
  assertEquals(names, [...TILE_TOOLS, ...COMPANION_TOOLS].sort());
  for (const t of handler.listTools()) {
    assertEquals(t.inputSchema.type, "object");
  }

  const denied = await handler.callTool("write_tile", {
    tile: "codex",
    text: "ls\r",
  }, ctxFor(tile("pty-1")));
  assert(denied.isError);
  assert(resultText(denied).includes("companion only"));
  assertEquals(env.writes, []);

  const allowed = await handler.callTool("write_tile", {
    tile: "codex",
    text: "ls\r",
  }, ctxFor(COMPANION_ID));
  assertEquals(allowed.isError, undefined);
  assertEquals(env.writes, [{ tileId: "pty-2", text: "ls\r" }]);

  for (const t of ["spawn_tile", "close_tile", "focus_tile", "deliver"]) {
    const r = await handler.callTool(
      t,
      { tile: "codex" },
      ctxFor(tile("pty-3")),
    );
    assert(r.isError, t);
  }
  assertEquals(env.controls, []);
  await handler.callTool("focus_tile", { tile: "codex" }, ctxFor(COMPANION_ID));
  await handler.callTool("close_tile", { tile: "pty-3" }, ctxFor(COMPANION_ID));
  assertEquals(env.controls, [{ kind: "focus", tileId: "pty-2" }, {
    kind: "close",
    tileId: "pty-3",
  }]);
});

Deno.test("MCP handler: identity comes from the connection, not the arguments", async () => {
  const { core } = hubWithTiles();
  const handler = createHubHandler(core, buildToolRegistry(core));
  const me = JSON.parse(
    resultText(
      await handler.callTool(
        "whoami",
        { tileId: "pty-2" },
        ctxFor(tile("pty-1")),
      ),
    ),
  );
  assertEquals([me.id, me.name], ["pty-1", "claude"]);
  const anon = await handler.callTool("whoami", {}, ctxFor(undefined as never));
  assert(anon.isError);
});

Deno.test("MCP handler: send_message / read_messages / set_name / set_status / bad arguments", async () => {
  const { core } = hubWithTiles();
  const h = createHubHandler(core, buildToolRegistry(core));
  const call = async (
    who: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const r = await h.callTool(name, args, ctxFor(tile(who)));
    return { r, text: resultText(r) };
  };
  assertEquals(
    (await call("pty-3", "set_name", { name: "runner" })).r.isError,
    undefined,
  );
  const sent = JSON.parse(
    (await call("pty-1", "send_message", { to: "runner", text: "go" })).text,
  );
  assertEquals(sent.sent[0].to, "pty-3");
  const got = JSON.parse((await call("pty-3", "read_messages", {})).text);
  assertEquals(got.messages.map((m: HubMessage) => m.text), ["go"]);
  assertEquals(
    JSON.parse((await call("pty-3", "read_messages", {})).text).messages,
    [],
  );
  assertEquals(
    JSON.parse((await call("pty-3", "read_messages", { all: true })).text)
      .messages.length,
    1,
  );
  await call("pty-3", "set_status", { status: "waiting" });
  assertEquals(core.registry.get("pty-3")?.status, "waiting");
  assert((await call("pty-3", "set_status", { status: "sleeping" })).r.isError);
  // A note says how it went (spoken alerts read it), and the next status clears it.
  await call("pty-3", "set_status", { status: "idle", note: "build  failed" });
  assertEquals(core.registry.get("pty-3")?.note, "build failed");
  await call("pty-3", "set_status", { status: "busy" });
  assertEquals(core.registry.get("pty-3")?.note, undefined);
  assert(
    (await call("pty-3", "set_status", {
      status: "idle",
      note: "x".repeat(121),
    }))
      .r.isError,
  );
  assert((await call("pty-1", "send_message", { to: "runner" })).r.isError);
  assert((await call("pty-1", "set_name", { name: "codex" })).r.isError);
  assert((await call("pty-1", "nope", {})).r.isError);
  const peers = JSON.parse((await call("pty-1", "list_peers", {})).text);
  assertEquals(peers.you, "pty-1");
  assertEquals(peers.tiles.map((t: { name: string }) => t.name), [
    "claude",
    "codex",
    "runner",
  ]);
});

Deno.test("MCP handler: wait_for_message honours the call's cancellation signal", async () => {
  const { core } = hubWithTiles();
  const h = createHubHandler(core, buildToolRegistry(core));
  const ac = new AbortController();
  const pending = h.callTool(
    "wait_for_message",
    { timeoutMs: 60_000 },
    ctxFor(tile("pty-1"), ac.signal),
  );
  setTimeout(() => ac.abort(), 20);
  assertEquals(JSON.parse(resultText(await pending)).messages, []);
});

Deno.test("MCP handler: read_screen / read_scrollback go through the tile's mirror", async () => {
  const { core, env } = hubWithTiles();
  const mirror = new ScreenMirror(20, 3);
  env.mirrors.set("pty-2", mirror);
  for (let i = 1; i <= 6; i++) mirror.write(`line ${i}\r\n`);
  mirror.write("$ ");
  const h = createHubHandler(core, buildToolRegistry(core));
  const screen = JSON.parse(
    resultText(
      await h.callTool("read_screen", { tile: "codex" }, ctxFor(tile("pty-1"))),
    ),
  );
  assertEquals(screen.screen, "line 5\nline 6\n$");
  const page = JSON.parse(resultText(
    await h.callTool(
      "read_scrollback",
      { tile: "pty-2", grep: "line [24]" },
      ctxFor(tile("pty-1")),
    ),
  ));
  assertEquals(page.text, "1: line 2\n3: line 4");
  const none = await h.callTool(
    "read_screen",
    { tile: "pty-3" },
    ctxFor(tile("pty-1")),
  );
  assert(none.isError);
  mirror.dispose();
});

Deno.test("MCP handler: ask_user waits for the page's answer", async () => {
  const { core, env } = hubWithTiles();
  const h = createHubHandler(core, buildToolRegistry(core));
  const pending = h.callTool("ask_user", {
    text: "Ship it?",
    actions: ["Ship", "Wait"],
  }, ctxFor(tile("pty-1")));
  await Promise.resolve();
  core.answer(env.asks[0].id, "Ship");
  assertEquals(JSON.parse(resultText(await pending)), {
    id: env.asks[0].id,
    answered: true,
    action: "Ship",
  });
  const bad = await h.callTool(
    "ask_user",
    { text: "x", actions: "Yes" },
    ctxFor(tile("pty-1")),
  );
  assert(bad.isError);
});

Deno.test("MCP handler: the client name from initialize sets the harness", async () => {
  const { core } = hubWithTiles();
  const h = createHubHandler(core, buildToolRegistry(core));
  await h.onInitialize!(
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2" },
    },
    ctxFor(tile("pty-3")),
  );
  assertEquals(core.registry.get("pty-3")?.harness, "claude");
  assertEquals(core.registry.get("pty-3")?.name, "claude-2");
  assertEquals(harnessOfClient("codex-mcp-client"), "codex");
  assertEquals(harnessOfClient("my-client"), undefined);
});

// --- hooks ---------------------------------------------------------------------------------------

Deno.test("hooks: SessionStart registers the harness and introduces the tile", () => {
  const env = new FakeEnv();
  const core = new HubCore(env);
  core.addTile({ id: "pty-1" });
  core.addTile({ id: "pty-2", harness: "codex" });
  const out = core.hook("pty-1", "SessionStart", {
    cwd: "/repo",
    source: "startup",
  }, "claude");
  assertEquals(core.registry.get("pty-1")?.harness, "claude");
  assertEquals(core.registry.get("pty-1")?.cwd, "/repo");
  const ctx = (out as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  })
    .hookSpecificOutput;
  assertEquals(ctx.hookEventName, "SessionStart");
  assert(ctx.additionalContext.includes('tile "claude" (pty-1)'));
  assert(ctx.additionalContext.includes("codex (codex)"));
});

Deno.test("hooks: UserPromptSubmit / PostToolUse mark busy and deliver pending messages as context", () => {
  const { core } = hubWithTiles();
  assertEquals(core.hook("pty-1", "UserPromptSubmit", { prompt: "hi" }), {});
  assertEquals(core.registry.get("pty-1")?.status, "busy");
  const [m] = core.send(tile("pty-2"), "claude", "please review");
  const out = core.hook("pty-1", "PostToolUse", { tool_name: "Bash" }) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  assertEquals(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert(
    out.hookSpecificOutput.additionalContext.includes(
      `from codex (pty-2, ${m.id}): please review`,
    ),
  );
  assertEquals(core.mailboxes.history("pty-1")[0].state, "delivered");
  assertEquals(core.hook("pty-1", "PostToolUse", {}), {});
});

Deno.test("hooks: Stop blocks only when messages are pending, else marks idle", () => {
  const { core } = hubWithTiles();
  core.hook("pty-1", "UserPromptSubmit", {});
  assertEquals(core.hook("pty-1", "Stop", { stop_hook_active: false }), {});
  assertEquals(core.registry.get("pty-1")?.status, "idle");
  core.send(tile("pty-2"), "claude", "one more thing");
  const out = core.hook("pty-1", "Stop", { stop_hook_active: false }) as {
    decision: string;
    reason: string;
  };
  assertEquals(out.decision, "block");
  assert(out.reason.includes("one more thing"));
  assertEquals(core.registry.get("pty-1")?.status, "busy");
  // Delivered once: the next Stop lets it stop.
  assertEquals(core.hook("pty-1", "Stop", { stop_hook_active: true }), {});
});

Deno.test("hooks: Notification sets waiting / idle by notification_type", () => {
  const { core } = hubWithTiles();
  core.hook("pty-1", "Notification", {
    notification_type: "permission_prompt",
    message: "?",
  });
  assertEquals(core.registry.get("pty-1")?.status, "waiting");
  core.hook("pty-1", "Notification", { notification_type: "idle_prompt" });
  assertEquals(core.registry.get("pty-1")?.status, "idle");
  core.hook("pty-1", "Notification", { notification_type: "auth_success" });
  assertEquals(core.registry.get("pty-1")?.status, "idle");
  assertEquals(notificationStatus("agent_needs_input"), "waiting");
});

Deno.test("hooks: unknown events and unknown tiles answer {}", () => {
  const { core } = hubWithTiles();
  assertEquals(core.hook("pty-1", "PreToolUse", {}), {});
  assertEquals(core.hook("pty-9", "Stop", {}), {});
});

Deno.test("formatMessages: names, ids and reply hints", () => {
  const text = formatMessages([
    {
      id: "msg-1",
      from: "pty-2",
      fromName: "codex",
      to: "pty-1",
      text: "a",
      at: 0,
      state: "queued",
    },
    {
      id: "msg-2",
      from: "user",
      fromName: "user",
      to: "pty-1",
      text: "b",
      replyTo: "ask-1",
      at: 0,
      state: "queued",
    },
  ]);
  assert(text.startsWith("[Qutty] 2 messages"));
  assert(text.includes("from codex (pty-2, msg-1): a"));
  assert(text.includes("reply to ask-1"));
});

Deno.test("companion deliver: types a nudge only when messages wait", async () => {
  const { core, env } = hubWithTiles();
  assertEquals(await core.deliver("codex"), 0);
  core.send(tile("pty-1"), "codex", "x");
  assertEquals(await core.deliver("codex"), 1);
  assert(env.writes[0].text.includes("read_messages"));
  await assertRejects(() => core.writeTile("nobody", "x"), HubError);
});
