// The companion's half of the hub without sockets: the privileged tools for real (a tile is
// refused, the companion allowed; spawn_tile types its command into the new tile; the page's
// failures come back as tool errors), deliver's rules, the audit log (in memory, the JSONL file,
// rotation), and desktop/companion.ts's page round trips (`qutty-hook say` lines, `--wait`
// answers, control commands).

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { buildToolRegistry, createHubHandler } from "../lib/hub/tools.ts";
import { HubError } from "../lib/hub/core.ts";
import type { PrivilegedCall } from "../lib/hub/protocol.ts";
import {
  auditLine,
  AuditLog,
  parseAuditLines,
  summarizeArgs,
} from "../lib/companion/audit.ts";
import {
  appendAudit,
  AUDIT_FILE,
  CompanionHost,
} from "../desktop/companion.ts";
import { parseSayLine } from "../desktop/hub.ts";
import { SayError } from "../lib/companion/messages.ts";
import { UsageError } from "../lib/companion/say-args.ts";
import {
  COMPANION_ID,
  ctxFor,
  hubWithTiles,
  resultText,
  tile,
  waitUntil,
} from "./hub_helpers.ts";

function handlerWithAudit() {
  const { core, env } = hubWithTiles();
  const calls: PrivilegedCall[] = [];
  const handler = createHubHandler(core, buildToolRegistry(core), {
    audit: (c) => calls.push(c),
  });
  return { core, env, calls, handler };
}

Deno.test("privileged tools: a tile is refused (and logged); the companion writes, spawns, closes, focuses", async () => {
  const { core, env, calls, handler } = handlerWithAudit();
  const denied = await handler.callTool("write_tile", {
    tile: "codex",
    text: "rm -rf /\r",
  }, ctxFor(tile("pty-1")));
  assert(denied.isError);
  assertEquals(env.writes, []);
  assertEquals(calls[0], {
    tool: "write_tile",
    by: "pty-1",
    args: { tile: "codex", text: "rm -rf /\r" },
    ok: false,
    error: "refused: companion only",
  });

  const ok = await handler.callTool("write_tile", {
    tile: "codex",
    text: "npm test\r",
  }, ctxFor(COMPANION_ID));
  assertEquals(ok.isError, undefined);
  assertEquals(env.writes, [{ tileId: "pty-2", text: "npm test\r" }]);
  assertEquals(calls[1].by, "companion");
  assertEquals(calls[1].ok, true);

  // spawn_tile: the page opens it (pty-9), then the command is typed into it.
  core.addTile({ id: "pty-9" });
  const spawned = await handler.callTool("spawn_tile", {
    command: "npm run dev",
    profile: "shell:/bin/zsh",
  }, ctxFor(COMPANION_ID));
  assertEquals(JSON.parse(resultText(spawned)), {
    tile: "pty-9",
    name: "shell-9",
  });
  assertEquals(env.controls.at(-1), {
    kind: "spawn",
    command: "npm run dev",
    profile: "shell:/bin/zsh",
  });
  assertEquals(env.writes.at(-1), { tileId: "pty-9", text: "npm run dev\r" });

  // A command the page could not carry out is the tool's error (and logged as such).
  env.controlResult = () => ({
    ok: false,
    error: "that tile is not in this window",
  });
  const failed = await handler.callTool(
    "close_tile",
    { tile: "pty-3" },
    ctxFor(COMPANION_ID),
  );
  assert(failed.isError);
  assertEquals(resultText(failed), "that tile is not in this window");
  assertEquals(calls.at(-1)!.ok, false);
  assertEquals(calls.at(-1)!.error, "that tile is not in this window");
  env.controlResult = () => ({ ok: true });
  const focused = await handler.callTool(
    "focus_tile",
    { tile: "claude" },
    ctxFor(COMPANION_ID),
  );
  assertEquals(resultText(focused), "focused");
  assertEquals(env.controls.at(-1), { kind: "focus", tileId: "pty-1" });

  // Tile tools are not audited.
  const before = calls.length;
  await handler.callTool("list_peers", {}, ctxFor(COMPANION_ID));
  assertEquals(calls.length, before);
});

Deno.test("deliver: only an agent tile that is not busy; it presses Enter so the agent takes a turn", async () => {
  const { core, env } = hubWithTiles();
  core.send(tile("pty-1"), "shell-3", "hi");
  await assertRejects(
    () => core.deliver("shell-3"),
    HubError,
    "not an agent tile",
  );
  core.send(tile("pty-1"), "codex", "hi");
  core.registry.setStatus("pty-2", "busy");
  await assertRejects(() => core.deliver("codex"), HubError, "busy");
  core.registry.setStatus("pty-2", "idle");
  assertEquals(await core.deliver("codex"), 1);
  assert(env.writes.at(-1)!.text.endsWith("read_messages tool.\r"));
});

Deno.test("audit log: entries kept newest first, long arguments cut, every line appended in order", async () => {
  const lines: string[] = [];
  const seen: string[] = [];
  const log = new AuditLog(
    (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    (e) => seen.push(e.tool),
  );
  log.seed([{
    at: 1,
    tool: "focus_tile",
    by: "companion",
    args: {},
    ok: true,
  }]);
  log.record({
    tool: "write_tile",
    by: "companion",
    args: { tile: "a", text: "x".repeat(400) },
    ok: true,
  }, 2);
  log.record({
    tool: "close_tile",
    by: "pty-3",
    args: { tile: "a" },
    ok: false,
    error: "refused",
  }, 3);
  await log.flush();
  assertEquals(log.recent().map((e) => e.tool), [
    "close_tile",
    "write_tile",
    "focus_tile",
  ]);
  assertEquals(seen, ["write_tile", "close_tile"]);
  assertEquals(lines.length, 2, "seeded entries are not written again");
  const back = parseAuditLines(lines.join("") + "{torn\n\n");
  assertEquals(back.map((e) => [e.at, e.tool, e.ok]), [
    [2, "write_tile", true],
    [3, "close_tile", false],
  ]);
  assertStringIncludes(String(back[0].args.text), "… (400 chars)");
  assertEquals(summarizeArgs({ n: 3, s: "short" }), { n: 3, s: "short" });
  assertEquals(auditLine(back[1]).endsWith("\n"), true);
  // A failing writer never breaks the log.
  const broken = new AuditLog(() => Promise.reject(new Error("disk full")));
  broken.record({ tool: "deliver", by: "companion", args: {}, ok: true });
  await broken.flush();
  assertEquals(broken.recent().length, 1);
});

Deno.test("audit file: appended as JSONL (mode 0600), rotated past its limit", async () => {
  const dir = await Deno.makeTempDir({ prefix: "qutty-audit" });
  try {
    const path = `${dir}/${AUDIT_FILE}`;
    await appendAudit(path, '{"at":1,"tool":"a"}\n');
    await appendAudit(path, '{"at":2,"tool":"b"}\n');
    assertEquals(
      await Deno.readTextFile(path),
      '{"at":1,"tool":"a"}\n{"at":2,"tool":"b"}\n',
    );
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
    await Deno.writeTextFile(path, "x".repeat((1 << 20) + 1));
    await appendAudit(path, '{"at":3,"tool":"c"}\n');
    assertEquals(await Deno.readTextFile(path), '{"at":3,"tool":"c"}\n');
    assertEquals(
      (await Deno.readTextFile(`${dir}/companion-audit.1.jsonl`)).length,
      (1 << 20) + 1,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A CompanionHost (not started: no socket) with its page events recorded. */
function host(appSupportDir?: string) {
  const { core, env } = hubWithTiles();
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const h = new CompanionHost({
    core,
    socketDir: "/tmp/none",
    mcpShim: "/x/qutty-mcp",
    quttyDir: "/x/.qutty",
    ...(appSupportDir ? { appSupportDir } : {}),
    emit: (event, data) =>
      events.push({ event, data: data as Record<string, unknown> }),
    listen: () => {},
  });
  return { core, env, h, events };
}

Deno.test("qutty-hook say: parsed from its line, shown with the sender's name; --wait gets the button pressed", async () => {
  assertEquals(
    parseSayLine('{"qutty":"say","args":["Tests passed","--mood","success"]}'),
    [
      "Tests passed",
      "--mood",
      "success",
    ],
  );
  assertEquals(parseSayLine('{"qutty":"hook","input":{}}'), undefined);
  assertEquals(parseSayLine("nope"), undefined);
  assertEquals(parseSayLine('{"qutty":"say","args":["a",7,"b"]}'), ["a", "b"]);

  const { h, events } = host();
  const quick = await h.say(["Build", "done", "--mood", "success"], "claude");
  assertEquals(events[0].event, "say");
  const shown = events[0].data.message as Record<string, unknown>;
  assertEquals([shown.text, shown.mood, shown.from, events[0].data.wait], [
    "Build done",
    "success",
    "claude",
    false,
  ]);
  assertEquals(quick, { id: String(shown.id) });

  const waiting = h.say([
    "Deploy?",
    "--action",
    "yes:Deploy",
    "--action",
    "no:Later",
    "--wait",
  ], "codex");
  await waitUntil(() => events.length === 2);
  const asked = events[1].data.message as { id: string };
  assertEquals(h.sayDone("nope", "yes"), false);
  assertEquals(h.sayDone(asked.id, "yes"), true);
  assertEquals(await waiting, { id: asked.id, action: "yes" });

  await assertRejects(() => h.say([], "x"), UsageError);
  await assertRejects(() => h.say(["hi", "--mood", "angry"], "x"), SayError);
});

Deno.test("control commands: sent to the page with a request id, answered by controlDone", async () => {
  const { h, events } = host();
  const pending = h.control({ kind: "focus", tileId: "pty-2" });
  const sent = events.find((e) => e.event === "control")!.data as {
    requestId: string;
    command: unknown;
  };
  assertEquals(sent.command, { kind: "focus", tileId: "pty-2" });
  assertEquals(h.controlDone("ctl-999", { ok: true }), false);
  assertEquals(
    h.controlDone(sent.requestId, { ok: true, tileId: "pty-2" }),
    true,
  );
  assertEquals(await pending, { ok: true, tileId: "pty-2" });
});

Deno.test("companion host: privileged calls go to the audit file in the app-support folder and to the page", async () => {
  const dir = await Deno.makeTempDir({ prefix: "qutty-support" });
  try {
    const { h, events } = host(dir);
    h.record({
      tool: "write_tile",
      by: "companion",
      args: { tile: "pty-1", text: "ls\r" },
      ok: true,
    });
    await h.audit.flush();
    const text = await Deno.readTextFile(`${dir}/${AUDIT_FILE}`);
    assertEquals(parseAuditLines(text).map((e) => e.tool), ["write_tile"]);
    const activity = events.find((e) => e.event === "companion")!.data;
    assertEquals(activity.kind, "activity");
    assertEquals(h.status().activity.length, 1);
    assertEquals(
      h.status().status.enabled,
      false,
      "off until the page sends its settings",
    );
    assertEquals(h.configure(true, "haiku").enabled, true);
    await h.stop();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
