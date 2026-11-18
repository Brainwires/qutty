// A resumed session's history from Claude Code's own transcript file (lib/agent/claude-history.ts,
// desktop/agent-host.ts `claudeHistory`): the file's lines as tile rows (prompts, text, tool calls
// with their results and diffs, interrupts; subagent, injected and slash-command lines left out),
// where the file is (the folder's slug, else any project folder), and the start request using it
// over the saved copy — falling back to the copy when there is no file. All in temp folders: the
// real ~/.claude is never touched. Plus the demo backend's fake transcript files.

import { assert, assertEquals } from "@std/assert";
import {
  claudeProjectSlug,
  claudeTranscriptPath,
  historyRows,
} from "../lib/agent/claude-history.ts";
import { agentStartRequest, claudeHistory } from "../desktop/agent-host.ts";
import { DemoAgentAdapter, DemoHistory } from "../lib/agent/demo.ts";
import { AgentSessions } from "../lib/agent/sessions.ts";
import type { Row } from "../lib/agent/transcript.ts";
import { waitUntil } from "./hub_helpers.ts";

const SESSION = "0f8e2b1c-1111-4222-8333-944445555666";

const line = (v: Record<string, unknown>, at = "2026-11-18T10:00:00.000Z") =>
  JSON.stringify({ sessionId: SESSION, timestamp: at, ...v });

const TRANSCRIPT = [
  JSON.stringify({ type: "summary", summary: "Greeting change" }),
  line({
    type: "user",
    isMeta: true,
    message: { role: "user", content: "Caveat: injected" },
  }),
  line({
    type: "user",
    message: {
      role: "user",
      content: "<command-name>/model</command-name>",
    },
  }),
  line({
    type: "user",
    message: { role: "user", content: "change the greeting" },
  }),
  line({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "text", text: "I'll edit it." }],
    },
  }),
  line({
    type: "assistant",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_1",
        name: "Edit",
        input: {
          file_path: "/w/notes.md",
          old_string: "hello",
          new_string: "bye",
        },
      }],
    },
  }),
  line({
    type: "assistant",
    isSidechain: true,
    message: {
      id: "msg_sub",
      role: "assistant",
      content: [{ type: "text", text: "subagent chatter" }],
    },
  }),
  line({
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "The file /w/notes.md has been updated.",
      }],
    },
    toolUseResult: {
      filePath: "/w/notes.md",
      originalFile: "hello\n",
      structuredPatch: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-hello", "+bye"],
      }],
    },
  }),
  "{ a line cut short",
  line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "now run it" }, {
        type: "image",
        source: {},
      }],
    },
  }, "2026-11-18T10:01:00.000Z"),
  line({
    type: "assistant",
    message: {
      id: "msg_2",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "toolu_2",
        name: "Bash",
        input: { command: "sleep 100" },
      }],
    },
  }),
  line({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "[Request interrupted by user]" }],
    },
  }),
].join("\n");

Deno.test("the transcript file as rows: prompts, text, tools with diffs; the rest left out", () => {
  const rows = historyRows(TRANSCRIPT);
  const kinds = rows.map((r) =>
    r.type === "tool" ? `tool:${r.name}:${r.status}` : r.type
  );
  assertEquals(kinds, [
    "user",
    "text",
    "tool:Edit:done",
    "footer",
    "user",
    "tool:Bash:cancelled",
    "notice",
    "footer",
  ]);
  const user = rows[0] as Extract<Row, { type: "user" }>;
  assertEquals(user.text, "change the greeting");
  assertEquals(user.at, Date.parse("2026-11-18T10:00:00.000Z"));
  const edit = rows[2] as Extract<Row, { type: "tool" }>;
  assertEquals(edit.detail?.original, "hello\n");
  assertEquals(edit.detail?.patch?.[0].lines, ["-hello", "+bye"]);
  const second = rows[4] as Extract<Row, { type: "user" }>;
  assertEquals(second.attachments, [{ name: "image 1", kind: "image" }]);
  assertEquals(
    (rows.at(-1) as Extract<Row, { type: "footer" }>).outcome,
    "interrupted",
  );
  assert(!JSON.stringify(rows).includes("subagent chatter"));
  assertEquals(historyRows(""), []);
  assertEquals(historyRows("not json\n{}"), []);
});

Deno.test("where Claude Code keeps a session's transcript", () => {
  assertEquals(
    claudeProjectSlug("/Users/me/Source/my.app_x"),
    "-Users-me-Source-my-app-x",
  );
  assertEquals(
    claudeTranscriptPath("/h/.claude/", "/w", SESSION),
    `/h/.claude/projects/-w/${SESSION}.jsonl`,
  );
});

Deno.test("claudeHistory reads the slug's file, else any project's; only reads", async () => {
  const home = await Deno.makeTempDir({ prefix: "qutty-history-" });
  try {
    const work = `${home}/work`;
    await Deno.mkdir(work);
    // Nothing yet: no rows (the saved copy is used).
    assertEquals(await claudeHistory(work, SESSION, { home }), []);
    const dir = `${home}/.claude/projects/${claudeProjectSlug(work)}`;
    await Deno.mkdir(dir, { recursive: true });
    const file = `${dir}/${SESSION}.jsonl`;
    await Deno.writeTextFile(file, TRANSCRIPT);
    const before = (await Deno.stat(file)).mtime?.getTime();
    const rows = await claudeHistory(work, SESSION, { home });
    assertEquals(rows.length, 8);
    assertEquals((await Deno.stat(file)).mtime?.getTime(), before);
    // Under another project's folder (the session ran elsewhere), with $CLAUDE_CONFIG_DIR.
    const config = `${home}/cfg`;
    await Deno.mkdir(`${config}/projects/-elsewhere`, { recursive: true });
    await Deno.writeTextFile(
      `${config}/projects/-elsewhere/${SESSION}.jsonl`,
      TRANSCRIPT,
    );
    assertEquals(
      (await claudeHistory(work, SESSION, { home, configDir: config })).length,
      8,
    );
    // Not a session id: nothing is read.
    assertEquals(await claudeHistory(work, "../../x", { home }), []);

    // The start request: the file's rows over the saved copy; the copy without a file.
    const saved: Row[] = [{ type: "notice", id: "n0", text: "saved", at: 1 }];
    const withFile = await agentStartRequest(
      { cwd: work, resumeId: SESSION, rows: saved },
      home,
      undefined,
      (cwd, id) => claudeHistory(cwd, id, { home }),
    );
    assertEquals(withFile.rows?.length, 8);
    const noFile = await agentStartRequest(
      {
        cwd: work,
        resumeId: "aaaaaaaa-1111-4222-8333-944445555666",
        rows: saved,
      },
      home,
      undefined,
      (cwd, id) => claudeHistory(cwd, id, { home }),
    );
    assertEquals(noFile.rows?.map((r) => r.id), ["n0"]);
    // A reader that fails falls back to the copy too.
    const failing = await agentStartRequest(
      { cwd: work, resumeId: SESSION, rows: saved },
      home,
      undefined,
      () => Promise.reject(new Error("unreadable")),
    );
    assertEquals(failing.rows?.map((r) => r.id), ["n0"]);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("the demo writes each session's transcript as Claude Code does; it reads back as rows", async () => {
  const history = new DemoHistory();
  const sessions = new AgentSessions({
    emit: () => {},
    createAdapter: () => new DemoAgentAdapter({ history }),
  });
  sessions.start({ cwd: "/Users/demo/project", permissionMode: "acceptEdits" });
  sessions.send("agent-1", { text: "change it" });
  const t = (await waitUntil(
    () => {
      const t = sessions.snapshot("agent-1")!.transcript;
      return t.rows.some((r) => r.type === "footer") ? t : undefined;
    },
    5000,
    "the turn",
  ))!;
  const rows = historyRows(history.file(t.sessionId!)!);
  const kinds = (rs: readonly Row[]) =>
    rs.flatMap((r) =>
      r.type === "user" || r.type === "tool"
        ? [`${r.type}:${"name" in r ? r.name : r.text}`]
        : []
    );
  assertEquals(kinds(rows), kinds(t.rows));
  const edit = rows.find((r) => r.type === "tool" && r.name === "Edit");
  assertEquals(
    edit?.type === "tool" ? edit.detail?.original : undefined,
    "hello from a file\nsecond line\n",
  );
  sessions.stopAll();
});
