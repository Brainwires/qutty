// The Codex adapter's pure half (lib/agent/codex-app-server.ts) against a fake `codex app-server`
// (lib/agent/codex-demo.ts `FakeCodexServer`, the demo's scripted server) and raw JSON-RPC lines:
// the handshake and thread (new, resumed, a resume Codex refuses), items mapped to the transcript's
// rows (text, reasoning, reads as `Read`, file changes as `Edit` with their diff, commands as
// `Bash`, MCP calls), approvals through `hooks.approve` (accept / acceptForSession / decline), a
// failed turn, interrupts (also before `turn/start` answered), errors, the server going away, and
// the session layer on the demo Codex end to end.

import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  AgentEvent,
  AgentHooks,
  PermissionDecision,
  PermissionRequest,
} from "../lib/agent/adapter.ts";
import {
  CODEX_READY,
  codexAgentArgv,
  CodexAppServer,
  codexInput,
  codexPatch,
  codexPolicy,
} from "../lib/agent/codex-app-server.ts";
import { DemoCodexAdapter, FakeCodexServer } from "../lib/agent/codex-demo.ts";
import {
  emptyTranscript,
  reduceTranscript,
  type Row,
  type Transcript,
} from "../lib/agent/transcript.ts";
import { AgentSessions, type AgentUpdate } from "../lib/agent/sessions.ts";
import { agentModels, sanitizeChat } from "../lib/agent/tile.ts";
import { revertPlan, sessionChanges } from "../lib/agent/changes.ts";
import { agentStartInput } from "../desktop/agent-host.ts";
import { waitUntil } from "./hub_helpers.ts";

/** A client wired to the fake server; what each side sent, the events, the questions. */
function wired(answer: PermissionDecision | (() => Promise<never>) = "allow") {
  const events: AgentEvent[] = [];
  const asked: PermissionRequest[] = [];
  const toServer: Record<string, unknown>[] = [];
  let client: CodexAppServer | undefined = undefined;
  const server = new FakeCodexServer((line) =>
    queueMicrotask(() => client?.line(line))
  );
  const hooks: AgentHooks = {
    approve: (req) => {
      asked.push(req);
      return typeof answer === "string" ? Promise.resolve(answer) : answer();
    },
  };
  client = new CodexAppServer({
    write: (line) => {
      toServer.push(JSON.parse(line));
      queueMicrotask(() => server.receive(line));
      return Promise.resolve();
    },
    sink: { event: (e) => events.push(e) },
    hooks,
    version: "9.9.9",
  });
  const transcript = (): Transcript =>
    events.reduce(reduceTranscript, emptyTranscript());
  const ended = () => events.some((e) => e.kind === "turnEnd");
  return { client, server, events, asked, toServer, transcript, ended };
}

const tools = (rows: readonly Row[]) =>
  rows.filter((r): r is Extract<Row, { type: "tool" }> => r.type === "tool");

Deno.test("codex: the command line runs `codex app-server` behind the ready line", () => {
  const { program, args } = codexAgentArgv({
    codex: "/opt/homebrew/bin/codex",
    env: { QUTTY_SOCK: "/tmp/s.sock", QUTTY_TILE_ID: "agent-1" },
  });
  assertEquals(program, "/usr/bin/env");
  assertEquals(args.slice(0, 4), [
    "QUTTY_SOCK=/tmp/s.sock",
    "QUTTY_TILE_ID=agent-1",
    "/bin/bash",
    "-c",
  ]);
  assert(args[4].includes(CODEX_READY));
  assert(args[4].includes("stty raw -echo"));
  assertEquals(args.slice(5), ["/opt/homebrew/bin/codex", "app-server"]);
});

Deno.test("codex: permission modes map to approval policy and sandbox", () => {
  assertEquals(codexPolicy(undefined), {
    approvalPolicy: "untrusted",
    sandbox: "workspace-write",
  });
  assertEquals(codexPolicy("acceptEdits").approvalPolicy, "on-request");
  assertEquals(codexPolicy("plan").sandbox, "read-only");
  assertEquals(codexPolicy("bypassPermissions"), {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
});

Deno.test("codex: a message becomes text and image inputs", () => {
  assertEquals(codexInput({ text: "hi" }), [
    { type: "text", text: "hi", text_elements: [] },
  ]);
  assertEquals(
    codexInput({
      text: "look",
      attachments: [
        { name: "a.png", kind: "image", mediaType: "image/png", data: "AAA=" },
        { name: "b.txt", kind: "text", mediaType: "text/plain", data: "B" },
      ],
    }),
    [
      { type: "image", url: "data:image/png;base64,AAA=" },
      {
        type: "text",
        text: "Attached file b.txt:\n\nB\n\nlook",
        text_elements: [],
      },
    ],
  );
});

Deno.test("codex: unified diffs become hunks; new and deleted files one hunk", () => {
  assertEquals(
    codexPatch(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn\n a\n-b\n+c\n+d\n\\ No newline at end of file\n@@ -10 +11 @@\n-z\n+y\n",
    ),
    [
      { oldStart: 3, newStart: 3, lines: [" a", "-b", "+c", "+d"] },
      { oldStart: 10, newStart: 11, lines: ["-z", "+y"] },
    ],
  );
  assertEquals(codexPatch("one\ntwo\n", "add"), [
    { oldStart: 0, newStart: 1, lines: ["+one", "+two"] },
  ]);
  assertEquals(codexPatch("gone", "delete"), [
    { oldStart: 1, newStart: 0, lines: ["-gone"] },
  ]);
  assertEquals(codexPatch("no hunks here"), []);
});

Deno.test("codex: the handshake, a new thread, the session and the models", async () => {
  const w = wired();
  await w.client.open({ cwd: "/p", model: "gpt-demo", permissionMode: "plan" });
  assertEquals(w.toServer[0].method, "initialize");
  assertEquals(
    (w.toServer[0].params as { clientInfo: unknown }).clientInfo,
    { name: "qutty", title: "Qutty", version: "9.9.9" },
  );
  assertEquals(w.toServer[1], { method: "initialized" });
  const start = w.server.requests.find((r) => r.method === "thread/start")!;
  assertEquals(start.params, {
    cwd: "/p",
    model: "gpt-demo",
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });
  assertEquals(w.client.threadId, "019a0000-0000-7000-8000-00000000c0de");
  const session = w.events.find((e) => e.kind === "session");
  assertEquals(
    session && session.kind === "session" && session.model,
    "gpt-demo",
  );
  await waitUntil(() => w.events.some((e) => e.kind === "models"));
  const t = w.transcript();
  assertEquals(t.sessionId, "019a0000-0000-7000-8000-00000000c0de");
  // The hidden model is left out; the default comes first.
  assertEquals(agentModels("codex", t.models).map((m) => m.id), [
    "",
    "gpt-demo",
    "gpt-demo-mini",
  ]);
  // Until Codex listed them, only the default.
  assertEquals(agentModels("codex").map((m) => m.id), [""]);
});

Deno.test("codex: resume goes on in the thread; a thread Codex does not know is an error", async () => {
  const w = wired();
  await w.client.open({
    cwd: "/p",
    resumeId: "019a1111-2222-7333-8444-555566667777",
  });
  const resume = w.server.requests.find((r) => r.method === "thread/resume");
  assertEquals(resume?.params.threadId, "019a1111-2222-7333-8444-555566667777");
  assertEquals(w.client.threadId, "019a1111-2222-7333-8444-555566667777");

  const bad = wired();
  bad.server.resumeError = "no rollout found for thread id 019a";
  await assertRejects(
    () =>
      bad.client.open({
        cwd: "/p",
        resumeId: "019abcde-0000-7000-8000-000000000000",
      }),
    Error,
    "Codex could not resume thread 019abcde: no rollout found",
  );
});

Deno.test("codex: a turn's items become rows; Allow applies the change", async () => {
  const w = wired("allow");
  await w.client.open({ cwd: "/Users/demo/project" });
  await w.client.send({ text: "change the greeting" });
  await waitUntil(w.ended);
  const t = w.transcript();
  assertEquals(w.asked.length, 1);
  assertEquals(w.asked[0].toolName, "Edit");
  assertEquals(w.asked[0].input.file_path, "/Users/demo/project/notes.md");
  const answer = w.toServer.find((m) =>
    m.result && "decision" in (m.result as object)
  );
  assertEquals(answer?.result, { decision: "accept" });
  assertEquals(
    t.rows.map((r) =>
      r.type === "tool" ? `tool:${r.name}:${r.status}` : r.type
    ),
    [
      "thinking",
      "text",
      "tool:Read:done",
      "tool:Edit:done",
      "tool:Bash:done",
      "text",
      "footer",
    ],
  );
  const [read, edit, bash] = tools(t.rows);
  assertEquals(read.detail?.readLines, 2);
  assertEquals(edit.detail?.patch?.[0].lines, [
    "-hello from a file",
    "+goodbye from a file",
    " second line",
  ]);
  assertEquals(bash.input?.command, "git diff --stat");
  assertEquals(bash.detail?.stdout, " notes.md | 2 +-\n 1 file changed\n");
  assertEquals(
    t.rows.find((r) => r.type === "thinking")?.type === "thinking" &&
      (t.rows.find((r) => r.type === "thinking") as { text: string }).text,
    "Looking at notes.md",
  );
  const texts = t.rows.filter((r) => r.type === "text").map((r) =>
    (r as { text: string }).text
  );
  assertEquals(texts[0], "I'll read the notes first.");
  const footer = t.rows.at(-1) as Extract<Row, { type: "footer" }>;
  assertEquals(footer.outcome, "done");
  assertEquals(footer.durationMs, 1200);
  assertEquals(footer.outputTokens, 180);
  assert(!t.running);
});

Deno.test("codex: Allow always answers acceptForSession; Deny declines and the row is denied", async () => {
  const always = wired("always");
  await always.client.open({ cwd: "/p" });
  await always.client.send({ text: "go" });
  await waitUntil(always.ended);
  assert(
    always.toServer.some((m) =>
      (m.result as { decision?: string } | undefined)?.decision ===
        "acceptForSession"
    ),
  );

  const no = wired("deny");
  await no.client.open({ cwd: "/p" });
  await no.client.send({ text: "go" });
  await waitUntil(no.ended);
  assert(
    no.toServer.some((m) =>
      (m.result as { decision?: string } | undefined)?.decision === "decline"
    ),
  );
  // The session layer's permission row (its decision) is what marks the tool row denied.
  const events: AgentEvent[] = [
    ...no.events.slice(0, 1),
    {
      kind: "permission",
      requestId: "q1",
      toolName: "Edit",
      input: {},
      toolUseId: no.asked[0].toolUseId!,
      at: 0,
    },
    { kind: "permissionDone", requestId: "q1", decision: "deny", at: 0 },
    ...no.events.slice(1),
  ];
  const t = events.reduce(reduceTranscript, emptyTranscript());
  const edit = tools(t.rows).find((r) => r.name === "Edit")!;
  assertEquals(edit.status, "denied");
  assertEquals(edit.result, "The user declined this change.");
  assertEquals(
    (t.rows.filter((r) => r.type === "text").at(-1) as { text: string }).text,
    "You declined the change, so nothing changed.",
  );
});

Deno.test("codex: a failed turn ends with Codex's reason", async () => {
  const w = wired();
  await w.client.open({ cwd: "/p" });
  await w.client.send({ text: "fail please" });
  await waitUntil(w.ended);
  const end = w.events.find((e) => e.kind === "turnEnd");
  assert(end?.kind === "turnEnd");
  assertEquals(end.isError, true);
  assertEquals(end.result, "stream disconnected before completion (demo)");
  const t = w.transcript();
  assertEquals(t.error, "stream disconnected before completion (demo)");
  assertEquals((t.rows.at(-1) as { outcome: string }).outcome, "failed");
});

Deno.test("codex: interrupt sends turn/interrupt; the turn ends interrupted, its open tool cancelled", async () => {
  // The question is never answered (the session layer withdraws it on an interrupt).
  const w = wired(() => new Promise<never>(() => {}));
  await w.client.open({ cwd: "/p" });
  await w.client.send({ text: "slow change" });
  await waitUntil(() => w.asked.length === 1, 5000);
  await w.client.interrupt();
  await waitUntil(w.ended);
  const req = w.server.requests.find((r) => r.method === "turn/interrupt");
  assertEquals(req?.params, {
    threadId: "019a0000-0000-7000-8000-00000000c0de",
    turnId: "turn-1",
  });
  const t = w.transcript();
  assertEquals((t.rows.at(-1) as { outcome: string }).outcome, "interrupted");
  assertEquals(
    tools(t.rows).find((r) => r.name === "Edit")?.status,
    "cancelled",
  );
  // The next turn runs.
  await w.client.send({ text: "hello" });
  await waitUntil(() =>
    w.events.filter((e) => e.kind === "turnEnd").length === 2
  );
  w.server.stop();
});

Deno.test("codex: an interrupt before turn/start answered goes out once it does", async () => {
  const lines: string[] = [];
  const events: AgentEvent[] = [];
  const client = new CodexAppServer({
    write: (l) => {
      lines.push(l);
      return Promise.resolve();
    },
    sink: { event: (e) => events.push(e) },
    hooks: { approve: () => Promise.resolve("allow") },
  });
  const open = client.open({ cwd: "/p" });
  client.line('{"id":1,"result":{}}');
  await waitUntil(() => lines.some((l) => l.includes('"thread/start"')));
  const startId =
    JSON.parse(lines.find((l) => l.includes('"thread/start"'))!).id;
  client.line(
    JSON.stringify({
      id: startId,
      result: { thread: { id: "th-1" }, model: "m" },
    }),
  );
  await open;
  const sent = client.send({ text: "x" });
  await client.interrupt(); // turn/start has not answered
  assert(!lines.some((l) => l.includes("turn/interrupt")));
  const turnStart =
    JSON.parse(lines.find((l) => l.includes('"turn/start"'))!).id;
  client.line(
    JSON.stringify({ id: turnStart, result: { turn: { id: "tu-1" } } }),
  );
  await waitUntil(() => lines.some((l) => l.includes("turn/interrupt")));
  const interrupt = JSON.parse(
    lines.find((l) => l.includes("turn/interrupt"))!,
  );
  assertEquals(interrupt.params, { threadId: "th-1", turnId: "tu-1" });
  client.line(JSON.stringify({ id: interrupt.id, result: {} }));
  await sent;
});

Deno.test("codex: raw lines (chunked, escape codes, MCP calls, unknown requests, errors)", async () => {
  const lines: string[] = [];
  const events: AgentEvent[] = [];
  const client = new CodexAppServer({
    write: (l) => {
      lines.push(l);
      return Promise.resolve();
    },
    sink: { event: (e) => events.push(e) },
    hooks: { approve: () => Promise.resolve("deny") },
  });
  // Diagnostics (stderr shares the terminal) are logged.
  client.push("\x1b[2m2026-11-18\x1b[0m WARN something\r\n");
  assertEquals(events.at(-1), {
    kind: "log",
    message: "2026-11-18 WARN something",
    at: (events.at(-1) as { at: number }).at,
  });
  // An MCP call, its line split across chunks.
  const item = {
    type: "mcpToolCall",
    id: "m1",
    server: "qutty",
    tool: "list_peers",
    status: "completed",
    arguments: { all: true },
    result: { content: [{ type: "text", text: "pty-1 zsh" }] },
    error: null,
  };
  const line = JSON.stringify({
    method: "item/completed",
    params: { threadId: "t", turnId: "u", item },
  }) + "\n";
  client.push(line.slice(0, 20));
  client.push(line.slice(20));
  const t = events.reduce(reduceTranscript, emptyTranscript());
  const row = tools(t.rows)[0];
  assertEquals(row.name, "mcp__qutty__list_peers");
  assertEquals(row.input, { all: true });
  assertEquals(row.result, "pty-1 zsh");
  // A failing command: an error row with its output.
  client.line(JSON.stringify({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "c1",
        command: "false",
        commandActions: [],
        status: "failed",
        aggregatedOutput: "",
        exitCode: 1,
      },
    },
  }));
  const failed = tools(events.reduce(reduceTranscript, emptyTranscript()).rows)
    .find((r) => r.id === "c1");
  assertEquals(failed?.status, "error");
  assertEquals(failed?.result, "Exit code 1");
  // A server request Qutty does not answer: a JSON-RPC error back.
  client.line('{"id":77,"method":"item/tool/requestUserInput","params":{}}');
  await waitUntil(() => lines.some((l) => l.includes('"id":77')));
  assertEquals(JSON.parse(lines.at(-1)!).error.code, -32601);
  // A command approval: Bash with the command, answered `decline`.
  client.line(JSON.stringify({
    id: 78,
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "c2",
      command: "rm -rf build",
      cwd: "/p",
      reason: "clean",
    },
  }));
  await waitUntil(() => lines.some((l) => l.includes('"id":78')));
  assertEquals(JSON.parse(lines.at(-1)!), {
    id: 78,
    result: { decision: "decline" },
  });
  // A request Codex refuses rejects with its message; closing rejects the rest.
  const refused = client.request("thread/start", {});
  const id = JSON.parse(lines.at(-1)!).id;
  client.line(JSON.stringify({ id, error: { code: -32600, message: "nope" } }));
  await assertRejects(() => refused, Error, "nope");
  const pending = client.request("model/list", {});
  client.close("Codex ended (exit code 1)");
  await assertRejects(() => pending, Error, "Codex ended (exit code 1)");
  await assertRejects(() => client.request("x", {}), Error, "Codex ended");
  await assertRejects(() => client.send({ text: "x" }), Error, "not running");
});

Deno.test("codex: the session layer on the demo Codex (a hub tile named codex, Allow, the footer)", async () => {
  const updates: AgentUpdate[] = [];
  const opened: { id: string; agent?: string }[] = [];
  const sessions = new AgentSessions({
    emit: (u) => updates.push(u),
    createAdapter: (spec) => {
      assertEquals(spec.agent, "codex");
      return new DemoCodexAdapter();
    },
    hub: {
      open: (id, info) => {
        opened.push({ id, ...(info.agent ? { agent: info.agent } : {}) });
        return { env: {}, name: info.agent ?? "claude" };
      },
      close() {},
      setStatus() {},
      rename: (_id, name) => name,
    },
  });
  const snap = sessions.start({ agent: "codex", cwd: "/Users/demo/project" });
  assertEquals(snap.name, "codex");
  assertEquals(snap.spec.agent, "codex");
  assertEquals(opened, [{ id: snap.id, agent: "codex" }]);
  assert(sessions.send(snap.id, { text: "change it" }));
  await waitUntil(
    () => (sessions.snapshot(snap.id)?.transcript.asking.length ?? 0) > 0,
    5000,
  );
  const t0 = sessions.snapshot(snap.id)!.transcript;
  assert(sessions.answer(snap.id, t0.asking[0], "allow"));
  await waitUntil(() => !sessions.snapshot(snap.id)!.transcript.running, 5000);
  const t = sessions.snapshot(snap.id)!.transcript;
  assertEquals((t.rows.at(-1) as { outcome: string }).outcome, "done");
  assertEquals(tools(t.rows).find((r) => r.name === "Edit")?.status, "done");
  assertEquals(t.sessionId, "019a0000-0000-7000-8000-00000000c0de");
  sessions.stopAll();
});

Deno.test("agent kinds: the tile's chat and the start request keep the backend", async () => {
  assertEquals(sanitizeChat({ cwd: "/p", agent: "codex" }), {
    agent: "codex",
    cwd: "/p",
  });
  // Claude Code is the default (not stored); an unknown backend is dropped.
  assertEquals(sanitizeChat({ cwd: "/p", agent: "claude" }), { cwd: "/p" });
  assertEquals(sanitizeChat({ cwd: "/p", agent: "gemini" }), { cwd: "/p" });
  const ok = await agentStartInput["~standard"].validate({
    cwd: "/p",
    agent: "ollama",
    model: "qwen3:8b",
  });
  assertEquals("value" in ok && ok.value, {
    agent: "ollama",
    cwd: "/p",
    model: "qwen3:8b",
  });
  const bad = await agentStartInput["~standard"].validate({
    cwd: "/p",
    agent: "gemini",
  });
  assert("issues" in bad && bad.issues?.[0].path?.[0] === "agent");
});

Deno.test("codex: Allow always is Codex's acceptForSession for that request only; a later command still asks", async () => {
  for (const agent of ["codex", undefined] as const) {
    const sessions = new AgentSessions({
      emit() {},
      createAdapter: () => new DemoCodexAdapter(),
      hub: {
        open: (_id, info) => ({ env: {}, name: info.agent ?? "claude" }),
        close() {},
        setStatus() {},
        rename: (_id, name) => name,
      },
    });
    const snap = sessions.start({ ...(agent ? { agent } : {}), cwd: "/p" });
    const asking = () => sessions.snapshot(snap.id)!.transcript.asking;
    const first = sessions.approve(snap.id, {
      toolName: "Bash",
      input: { command: "ls" },
    });
    assertEquals(asking().length, 1);
    assert(sessions.answer(snap.id, asking()[0], "always"));
    // The adapter gets "always" (Codex's client sends `acceptForSession`).
    assertEquals(await first, "always");
    let settled = false;
    const second = sessions.approve(snap.id, {
      toolName: "Bash",
      input: { command: "rm -rf build" },
    }).then((d) => {
      settled = true;
      return d;
    });
    await Promise.resolve();
    if (agent === "codex") {
      // No rule per tool name: a different command is asked again.
      assertEquals(settled, false);
      assertEquals(asking().length, 1);
      assert(sessions.answer(snap.id, asking()[0], "deny"));
      assertEquals(await second, "deny");
    } else {
      // Claude Code: "Allow always" is remembered for the tool, as before.
      assertEquals(await second, "allow");
      assertEquals(asking().length, 0);
    }
    sessions.stopAll();
  }
});

Deno.test("codex: a change to several files is one diff per file in the Changes tab, with no revert", () => {
  const events: AgentEvent[] = [];
  const client = new CodexAppServer({
    write: () => Promise.resolve(),
    sink: { event: (e) => events.push(e) },
    hooks: { approve: () => Promise.resolve("deny") },
  });
  client.line(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "t",
      turnId: "u",
      item: {
        type: "fileChange",
        id: "fc1",
        status: "completed",
        changes: [
          {
            path: "/p/a.txt",
            kind: { type: "update" },
            diff: "@@ -1 +1 @@\n-a\n+A\n",
          },
          { path: "/p/b.txt", kind: { type: "add" }, diff: "new\n" },
        ],
      },
    },
  }));
  const rows = events.reduce(reduceTranscript, emptyTranscript()).rows;
  const files = sessionChanges(rows, "/p");
  assertEquals(files.map((f) => [f.path, f.added, f.removed]), [
    ["/p/a.txt", 1, 1],
    ["/p/b.txt", 1, 0],
  ]);
  // Known only as diffs: revert refuses instead of "succeeding" with nothing undone.
  assertEquals(revertPlan(files[0].changes, "A\n"), {
    ok: false,
    reason: "the agent's change is only known as a diff",
  });
});
