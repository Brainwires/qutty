// Source Control's pure parts: git's porcelain parsed (lib/scm/parse.ts), hunk patches
// (lib/scm/patch.ts), the PTY wrapper's output (lib/scm/run.ts), the graph lanes
// (lib/scm/graph.ts) and which file events matter (desktop/scm.ts `watchedPath`).

import { assert, assertEquals } from "@std/assert";
import {
  parseDiff,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseStatus,
  parseWorktrees,
} from "../lib/scm/parse.ts";
import { hunkPatch, hunksApply } from "../lib/scm/patch.ts";
import {
  authFailure,
  authPrompt,
  END_MARK,
  errorMessage,
  OUT_MARK,
  parseWrapped,
  progressLine,
  terminalText,
  wrapperArgs,
} from "../lib/scm/run.ts";
import { graphRows, graphWidth } from "../lib/scm/graph.ts";
import { sideBySide, unifiedLines } from "../lib/scm/rows.ts";
import { watchedPath } from "../desktop/scm.ts";

const Z = "\0";

Deno.test("scm parse: status v2 with the branch, changes, a rename, a conflict and untracked files", () => {
  const out = [
    "# branch.oid 1234567890abcdef1234567890abcdef12345678",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaaa bbbb src/a b.ts",
    "1 MM N... 100644 100644 100644 aaaa bbbb both.ts",
    "1 A. N... 000000 100644 100644 0000 bbbb added.ts",
    "1 .D N... 100644 100644 000000 aaaa aaaa gone.ts",
    "2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.ts",
    "old name.ts",
    "u UU N... 100644 100644 100644 100644 a1 a2 a3 conflict.ts",
    "? untracked/file.txt",
    "! ignored.log",
    "",
  ].join(Z);
  const st = parseStatus("/repo", out);
  assertEquals(st.root, "/repo");
  assertEquals(st.branch, {
    head: "feature/x",
    oid: "1234567890abcdef1234567890abcdef12345678",
    upstream: "origin/feature/x",
    ahead: 2,
    behind: 1,
  });
  assertEquals(st.changes, [
    { path: "src/a b.ts", group: "changes", letter: "M" },
    { path: "both.ts", group: "staged", letter: "M" },
    { path: "both.ts", group: "changes", letter: "M" },
    { path: "added.ts", group: "staged", letter: "A" },
    { path: "gone.ts", group: "changes", letter: "D" },
    {
      path: "new name.ts",
      origPath: "old name.ts",
      group: "staged",
      letter: "R",
    },
    { path: "conflict.ts", group: "merge", letter: "C", conflict: "UU" },
    { path: "untracked/file.txt", group: "untracked", letter: "U" },
  ]);
});

Deno.test("scm parse: status before the first commit, and detached", () => {
  const initial = parseStatus(
    "/r",
    ["# branch.oid (initial)", "# branch.head main", ""].join(Z),
  );
  assertEquals(initial.branch, {
    head: "main",
    oid: null,
    ahead: 0,
    behind: 0,
  });
  const detached = parseStatus(
    "/r",
    ["# branch.oid abc", "# branch.head (detached)", ""].join(Z),
  );
  assertEquals(detached.branch.head, null);
  assertEquals(detached.branch.oid, "abc");
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ function f()
 one
--- two
+++ two
 three
 four
@@ -10,2 +10,3 @@
 ten
+ten and a half
 eleven
\\ No newline at end of file
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/old.ts b/renamed.ts
similarity index 90%
rename from old.ts
rename to renamed.ts
`;

Deno.test("scm parse: a diff's files, headers, hunks (content that looks like a header), binary and renames", () => {
  const files = parseDiff(DIFF);
  assertEquals(files.length, 4);
  const [a, created, bin, renamed] = files;
  assertEquals([a.oldPath, a.newPath], ["src/a.ts", "src/a.ts"]);
  assertEquals(a.header.length, 4);
  assertEquals(a.hunks.length, 2);
  assertEquals(a.hunks[0], {
    header: "@@ -1,4 +1,4 @@ function f()",
    oldStart: 1,
    oldLines: 4,
    newStart: 1,
    newLines: 4,
    lines: [" one", "--- two", "+++ two", " three", " four"],
  });
  assertEquals(a.hunks[1].lines, [
    " ten",
    "+ten and a half",
    " eleven",
    "\\ No newline at end of file",
  ]);
  assertEquals([created.oldPath, created.newPath], [null, "new.txt"]);
  assertEquals(created.hunks[0].oldLines, 0);
  assertEquals(created.hunks[0].newLines, 1);
  assertEquals(bin.binary, true);
  assertEquals(bin.hunks, []);
  assertEquals([renamed.oldPath, renamed.newPath], ["old.ts", "renamed.ts"]);
  assertEquals(parseDiff(""), []);
});

Deno.test("scm patch: one hunk alone, with its other side's start made consistent", () => {
  const [a, created, bin, renamed] = parseDiff(DIFF);
  assert(hunksApply(a));
  assert(!hunksApply(created));
  assert(!hunksApply(bin));
  assert(!hunksApply(renamed));
  assertEquals(
    hunkPatch(a, 1),
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      " ten",
      "+ten and a half",
      " eleven",
      "\\ No newline at end of file",
      "",
    ].join("\n"),
  );
  assertEquals(hunkPatch(created, 0), null);
  assertEquals(hunkPatch(a, 5), null);
  // Earlier hunks shifted the new side: a solo patch anchors on the side it applies to.
  const [shifted] = parseDiff(`diff --git a/f b/f
--- a/f
+++ b/f
@@ -20,3 +25,2 @@ x
 a
-b
 c
@@ -40,0 +44,2 @@
+new 1
+new 2
@@ -50,2 +55,0 @@
-gone 1
-gone 2
`);
  const header = (i: number, reverse = false) =>
    hunkPatch(shifted, i, reverse)!.split("\n")[3];
  assertEquals(header(0), "@@ -20,3 +20,2 @@ x");
  assertEquals(header(0, true), "@@ -25,3 +25,2 @@ x");
  assertEquals(header(1), "@@ -40,0 +41,2 @@");
  assertEquals(header(1, true), "@@ -43,0 +44,2 @@");
  assertEquals(header(2), "@@ -50,2 +49,0 @@");
  assertEquals(header(2, true), "@@ -56,2 +55,0 @@");
});

Deno.test("scm parse: log records with parents, refs and subjects", () => {
  const rec = (...f: string[]) => f.join(Z);
  const out = [
    rec(
      "a".repeat(40),
      `${"b".repeat(40)} ${"c".repeat(40)}`,
      "Ada",
      "1700000000",
      "HEAD -> main, origin/main, tag: v1",
      "Merge branch x",
    ),
    rec("b".repeat(40), "", "Bo", "1690000000", "", "root: with\ttab"),
  ].join(Z) + Z;
  const log = parseLog(out);
  assertEquals(log.length, 2);
  assertEquals(log[0].parents.length, 2);
  assertEquals(log[0].refs, ["HEAD -> main", "origin/main", "tag: v1"]);
  assertEquals(log[0].time, 1700000000);
  assertEquals(log[1], {
    oid: "b".repeat(40),
    parents: [],
    author: "Bo",
    time: 1690000000,
    refs: [],
    subject: "root: with\ttab",
  });
  assertEquals(parseLog(""), []);
});

Deno.test("scm parse: name-status of a commit, renames included", () => {
  assertEquals(
    parseNameStatus(
      ["M", "a.ts", "R087", "old.ts", "new.ts", "A", "b c.ts", "D", "gone", ""]
        .join(Z),
    ),
    [
      { path: "a.ts", letter: "M" },
      { path: "new.ts", origPath: "old.ts", letter: "R" },
      { path: "b c.ts", letter: "A" },
      { path: "gone", letter: "D" },
    ],
  );
});

Deno.test("scm parse: refs (local, remote, current; no remote HEAD) and stashes", () => {
  const refs = parseRefs(
    [
      ["refs/heads/main", "abc1234", "origin/main", "*"].join(Z),
      ["refs/heads/feat/x", "def5678", "", " "].join(Z),
      ["refs/remotes/origin/HEAD", "abc1234", "", " "].join(Z),
      ["refs/remotes/origin/main", "abc1234", "", " "].join(Z),
      ["refs/tags/v1", "abc1234", "", " "].join(Z),
      "",
    ].join("\n"),
  );
  assertEquals(refs, [
    {
      name: "main",
      remote: false,
      oid: "abc1234",
      upstream: "origin/main",
      current: true,
    },
    { name: "feat/x", remote: false, oid: "def5678", current: false },
    { name: "origin/main", remote: true, oid: "abc1234", current: false },
  ]);
  const stashes = parseStashes(
    [
      "stash@{0}",
      "f".repeat(40),
      "On main: wip",
      "1700000000",
      "stash@{1}",
      "e".repeat(40),
      "WIP on main: abc first",
      "1600000000",
      "",
    ].join(Z),
  );
  assertEquals(stashes.map((s) => s.ref), ["stash@{0}", "stash@{1}"]);
  assertEquals(stashes[0].subject, "On main: wip");
});

Deno.test("scm parse: worktree list --porcelain", () => {
  const trees = parseWorktrees(`worktree /src/repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /src/repo-feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature/x
locked reason here

worktree /src/repo-detached
HEAD 3333333333333333333333333333333333333333
detached
prunable gitdir file points to non-existent location

`);
  assertEquals(trees.map((t) => [t.path, t.branch, t.detached, t.locked]), [
    ["/src/repo", "main", false, false],
    ["/src/repo-feature", "feature/x", false, true],
    ["/src/repo-detached", undefined, true, false],
  ]);
  assert(trees[2].prunable);
  assertEquals(parseWorktrees("worktree /bare\nbare\n")[0].bare, true);
});

Deno.test("scm run: the wrapper's argv and its output back as stderr and exact stdout", () => {
  const args = wrapperArgs("/usr/bin/git", ["status", "--", "a; rm -rf /"], "");
  assertEquals(args[0], "-c");
  assertEquals(args.slice(2, 5), ["sh", "/usr/bin/git", ""]);
  // Every value is one argument (the shell never parses it).
  assertEquals(args.at(-1), "a; rm -rf /");
  const stdout = "a\0b\r\ncé\n";
  const b64 = btoa(
    String.fromCharCode(...new TextEncoder().encode(stdout)),
  ).replace(/(.{8})/g, "$1\r\n");
  const raw =
    `Receiving objects:  10%\rReceiving objects: 100% (3/3)\r\nwarning: x\r\n\r\n${OUT_MARK}\r\n${b64}\r\n\r\n${END_MARK}\r\n`;
  const out = parseWrapped(raw);
  assertEquals(out.complete, true);
  assertEquals(out.stdout, stdout);
  assertEquals(out.stderr, "Receiving objects: 100% (3/3)\nwarning: x");
  // Killed before the marker: nothing from stdout, the terminal text as stderr.
  assertEquals(parseWrapped("fatal: no\r\n"), {
    stderr: "fatal: no",
    stdout: "",
    complete: false,
  });
  assertEquals(terminalText("\x1b[1mbold\x1b[0m a\r\nx\rb\r\n"), "bold a\nb\n");
  assertEquals(
    progressLine("x\r\nCounting: 5%\rCounting: 50%"),
    "Counting: 50%",
  );
});

Deno.test("scm run: credential questions and failures, and git's message", () => {
  assert(authPrompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': "));
  assert(authPrompt("Password: "));
  assert(authPrompt("Username for 'https://github.com': "));
  assert(
    authPrompt(
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
    ),
  );
  assert(!authPrompt("Receiving objects: 100%"));
  assert(
    authFailure(
      "fatal: could not read Username for 'https://x': terminal prompts disabled",
    ),
  );
  assert(authFailure("git@github.com: Permission denied (publickey)."));
  assert(!authFailure("fatal: not a git repository"));
  assertEquals(
    errorMessage("hint: a\nerror: pathspec 'x' did not match\nhint: b", 1),
    "error: pathspec 'x' did not match",
  );
  assertEquals(errorMessage("", 3), "git exited with 3");
});

Deno.test("scm graph: lanes for a branch and its merge", () => {
  // m merges b into a; a and b both come from r.
  const rows = graphRows([
    { oid: "m", parents: ["a", "b"] },
    { oid: "b", parents: ["r"] },
    { oid: "a", parents: ["r"] },
    { oid: "r", parents: [] },
  ]);
  assertEquals(rows.map((r) => r.lane), [0, 1, 0, 0]);
  assertEquals(rows[0].joins, [1]);
  assertEquals(rows[0].above, []);
  assertEquals(rows[1].above, [0, 1]);
  // r: lane 1 (b's) ends in r's dot.
  assertEquals(rows[3].merges, [1]);
  assertEquals(rows[3].below, []);
  assertEquals(graphWidth(rows), 2);
});

Deno.test("scm watch: worktree changes matter, git internals only for HEAD, index and refs", () => {
  const g = "/r/.git";
  assert(watchedPath("/r/src/a.ts", g, g));
  assert(watchedPath("/r/.git/HEAD", g, g));
  assert(watchedPath("/r/.git/index", g, g));
  assert(watchedPath("/r/.git/refs/heads/main", g, g));
  assert(!watchedPath("/r/.git/index.lock", g, g));
  assert(!watchedPath("/r/.git/objects/ab/cdef", g, g));
  assert(!watchedPath("/r/sub/.git/x", g, g));
  // A linked worktree: its own git folder and the common one.
  assert(watchedPath("/r/.git/worktrees/w/HEAD", "/r/.git/worktrees/w", g));
  assert(watchedPath("/r/.git/refs/heads/x", "/r/.git/worktrees/w", g));
});

Deno.test("scm rows: a hunk unified with line numbers, and side by side with paired runs", () => {
  const [file] = parseDiff(`diff --git a/f b/f
--- a/f
+++ b/f
@@ -3,4 +3,4 @@
 keep
-old 1
-old 2
+new 1
 tail
+added
\\ No newline at end of file
`);
  const hunk = file.hunks[0];
  assertEquals(unifiedLines(hunk).map((l) => [l.kind, l.oldNo, l.newNo]), [
    ["ctx", 3, 3],
    ["del", 4, undefined],
    ["del", 5, undefined],
    ["add", undefined, 4],
    ["ctx", 6, 5],
    ["add", undefined, 6],
    ["note", undefined, undefined],
  ]);
  const rows = sideBySide(hunk);
  assertEquals(
    rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]),
    [
      ["keep", "keep"],
      ["old 1", "new 1"],
      ["old 2", null],
      ["tail", "tail"],
      [null, "added"],
      ["No newline at end of file", "No newline at end of file"],
    ],
  );
  assertEquals(rows[1].left?.no, 4);
  assertEquals(rows[1].right?.no, 4);
});
