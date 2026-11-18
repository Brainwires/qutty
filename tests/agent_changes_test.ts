// The Changes tab's model (lib/agent/changes.ts): the session's file changes from its tool rows
// (finished Edit / MultiEdit / Write only, per file, "accepted" ones left out), and reverting
// them — back to the original when the file is as the agent left it, else edit by edit; refused
// when the file changed in a way that cannot be undone, outside the session's folder, or not
// changed by it. Plus the demo adapter's edits on its file system, reverted end to end.

import { assert, assertEquals } from "@std/assert";
import {
  absPath,
  firstLine,
  isInside,
  revertFiles,
  revertPlan,
  sessionChanges,
  shortPath,
} from "../lib/agent/changes.ts";
import type { Row } from "../lib/agent/transcript.ts";
import { DemoAgentAdapter, DemoFiles } from "../lib/agent/demo.ts";
import { AgentSessions } from "../lib/agent/sessions.ts";
import { waitUntil } from "./hub_helpers.ts";

const CWD = "/p";

function edit(
  id: string,
  path: string,
  oldText: string,
  newText: string,
  extra: Partial<Extract<Row, { type: "tool" }>> = {},
): Row {
  return {
    type: "tool",
    id,
    name: "Edit",
    input: { file_path: path, old_string: oldText, new_string: newText },
    status: "done",
    at: 0,
    ...extra,
  };
}

function write(
  id: string,
  path: string,
  content: string,
  original?: string | null,
): Row {
  return {
    type: "tool",
    id,
    name: "Write",
    input: { file_path: path, content },
    status: "done",
    ...(original !== undefined ? { detail: { original } } : {}),
    at: 0,
  };
}

/** An in-memory file system with a write log. */
function memFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files));
  const log: string[] = [];
  return {
    map,
    log,
    read: (p: string) => Promise.resolve(map.get(p) ?? null),
    write: (p: string, c: string) => {
      log.push(`write ${p}`);
      map.set(p, c);
      return Promise.resolve();
    },
    remove: (p: string) => {
      log.push(`remove ${p}`);
      map.delete(p);
      return Promise.resolve();
    },
  };
}

Deno.test("paths: absolute, inside, short", () => {
  assertEquals(absPath("src/../a.ts", "/p"), "/p/a.ts");
  assertEquals(absPath("/x/./y"), "/x/y");
  assert(isInside("/p/a/b.ts", "/p"));
  assert(!isInside("/p2/a.ts", "/p"));
  assert(!isInside("/p/../etc/passwd", "/p"));
  assertEquals(shortPath("/p/a/b.ts", "/p"), "a/b.ts");
  assertEquals(shortPath("/q/b.ts", "/p"), "/q/b.ts");
});

Deno.test("sessionChanges: finished edits and writes per file, in order; accepted ones left out", () => {
  const rows: Row[] = [
    { type: "user", id: "u0", text: "go", at: 0 },
    edit("t1", "/p/a.ts", "x", "y", {
      detail: {
        patch: [{ oldStart: 3, newStart: 3, lines: ["-x", "+y"] }],
        original: "x\n",
      },
    }),
    edit("t2", "/p/b.ts", "1", "2", { status: "denied" }),
    write("t3", "new.md", "# hi\nthere\n", null),
    edit("t4", "a.ts", "y", "z"),
    {
      type: "tool",
      id: "t5",
      name: "Read",
      input: { file_path: "/p/c" },
      status: "done",
      at: 0,
    },
  ];
  const files = sessionChanges(rows, CWD);
  assertEquals(files.map((f) => f.path), ["/p/a.ts", "/p/new.md"]);
  assertEquals(files[0].changes.map((c) => c.rowId), ["t1", "t4"]);
  assertEquals([files[0].added, files[0].removed], [2, 2]);
  assertEquals(files[0].changes[0].original, "x\n");
  assertEquals(firstLine(files[0]), 3);
  assert(files[1].created);
  assertEquals([files[1].added, files[1].removed], [2, 0]);
  // Accepted up to t1: only t4 is left for a.ts.
  const after = sessionChanges(rows, CWD, { "/p/a.ts": "t1" });
  assertEquals(
    after.map((f) => [f.path, f.changes.map((c) => c.rowId)]),
    [["/p/new.md", ["t3"]], ["/p/a.ts", ["t4"]]],
  );
  // Accepted up to its last change: the file is gone from the list.
  assertEquals(
    sessionChanges(rows, CWD, { "/p/a.ts": "t4" }).map((f) => f.path),
    ["/p/new.md"],
  );
});

Deno.test("revertPlan: back to the original when the file is as the agent left it", () => {
  const [file] = sessionChanges([
    edit("t1", "/p/a", "hello", "bye", {
      detail: { original: "hello world\nhello again\n" },
    }),
    edit("t2", "/p/a", "again", "twice"),
  ], CWD);
  assertEquals(revertPlan(file.changes, "bye world\nhello twice\n"), {
    ok: true,
    content: "hello world\nhello again\n",
  });
});

Deno.test("revertPlan: edit by edit when someone else changed the file elsewhere", () => {
  const [file] = sessionChanges([
    edit("t1", "/p/a", "hello", "bye", { detail: { original: "hello\n" } }),
  ], CWD);
  // The user added a line since: the agent's edit is undone, the user's line stays.
  assertEquals(revertPlan(file.changes, "bye\nmine\n"), {
    ok: true,
    content: "hello\nmine\n",
  });
  // The agent's text is gone: nothing is written.
  const no = revertPlan(file.changes, "rewritten\n");
  assertEquals(no.ok, false);
  assert(!no.ok && /changed since/.test(no.reason));
});

Deno.test("revertPlan: a created file is removed; a rewritten one is refused", () => {
  const [created] = sessionChanges([write("t1", "/p/n", "new\n", null)], CWD);
  assertEquals(revertPlan(created.changes, "new\n"), {
    ok: true,
    content: null,
  });
  // Changed after the write, original unknown: refused.
  const [unknown] = sessionChanges([write("t1", "/p/n", "new\n")], CWD);
  assertEquals(revertPlan(unknown.changes, "new\n").ok, false);
  assertEquals(revertPlan(created.changes, "edited\n").ok, false);
});

Deno.test("revertFiles: only this session's files, inside its folder; each file on its own", async () => {
  const rows: Row[] = [
    edit("t1", "/p/a", "x", "y", { detail: { original: "x\n" } }),
    edit("t2", "/etc/hosts", "a", "b", { detail: { original: "a\n" } }),
    write("t3", "/p/n", "n\n", null),
    edit("t4", "/p/c", "q", "r", { detail: { original: "q\n" } }),
  ];
  const fs = memFs({
    "/p/a": "y\n",
    "/etc/hosts": "b\n",
    "/p/n": "n\n",
    "/p/c": "changed by hand\n",
  });
  const results = await revertFiles(rows, CWD, [
    { path: "/p/a" },
    { path: "/etc/hosts" },
    { path: "n" },
    { path: "/p/other" },
    { path: "/p/c" },
  ], fs);
  assertEquals(results.map((r) => [r.path, r.ok, r.through ?? r.reason]), [
    ["/p/a", true, "t1"],
    ["/etc/hosts", false, "outside the session's folder"],
    ["/p/n", true, "t3"],
    ["/p/other", false, "not changed by this session"],
    ["/p/c", false, "the file changed since the agent's edit"],
  ]);
  assertEquals(fs.map.get("/p/a"), "x\n");
  assertEquals(fs.map.has("/p/n"), false);
  assertEquals(fs.map.get("/etc/hosts"), "b\n");
  assertEquals(fs.map.get("/p/c"), "changed by hand\n");
  assertEquals(fs.log, ["write /p/a", "remove /p/n"]);
  // Accepted already (after its last change): nothing left to revert.
  const again = await revertFiles(
    rows,
    CWD,
    [{ path: "/p/a", after: "t1" }],
    fs,
  );
  assertEquals(again[0].ok, false);
});

Deno.test("the demo agent edits its files for real; the session's changes revert them", async () => {
  const files = new DemoFiles();
  const sessions = new AgentSessions({
    emit: () => {},
    createAdapter: () => new DemoAgentAdapter({ files }),
  });
  sessions.start({
    cwd: "/Users/demo/project",
    permissionMode: "acceptEdits",
  });
  sessions.send("agent-1", { text: "edit and write a summary" });
  const t = (await waitUntil(
    () => {
      const t = sessions.snapshot("agent-1")!.transcript;
      return t.rows.some((r) => r.type === "footer") ? t : undefined;
    },
    5000,
    "the turn",
  ))!;
  // Accept edits: no question was asked.
  assertEquals(t.rows.filter((r) => r.type === "permission").length, 0);
  assertEquals(
    files.get("/Users/demo/project/notes.md"),
    "goodbye from a file\nsecond line\n",
  );
  assertEquals(
    files.get("/Users/demo/project/summary.md"),
    "# Summary\n\nThe greeting now says goodbye.\n",
  );
  const changed = sessionChanges(t.rows, "/Users/demo/project");
  assertEquals(
    changed.map((f) => [shortPath(f.path, "/Users/demo/project"), f.created]),
    [
      ["notes.md", false],
      ["summary.md", true],
    ],
  );
  const results = await revertFiles(
    t.rows,
    "/Users/demo/project",
    changed.map((f) => ({ path: f.path })),
    files,
  );
  assert(results.every((r) => r.ok), JSON.stringify(results));
  assertEquals(
    files.get("/Users/demo/project/notes.md"),
    "hello from a file\nsecond line\n",
  );
  assertEquals(files.get("/Users/demo/project/summary.md"), null);
  // The session layer notes it in the transcript.
  assert(sessions.notice("agent-1", "Reverted notes.md, summary.md"));
  const last = sessions.snapshot("agent-1")!.transcript.rows.at(-1);
  assertEquals(
    last?.type === "notice" ? last.text : last?.type,
    "Reverted notes.md, summary.md",
  );
  sessions.stopAll();
});
