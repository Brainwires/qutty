/**
 * Source Control: git's porcelain output, parsed. Pure: the desktop extension (desktop/scm.ts)
 * runs git and hands the text here; the tests feed recorded output.
 *
 * - {@linkcode parseStatus}: `git status --porcelain=v2 -z --branch --untracked-files=all`
 * - {@linkcode parseDiff}: `git diff --no-color` (one file or several)
 * - {@linkcode parseLog} and {@linkcode LOG_FORMAT}: `git log -z --format=<LOG_FORMAT>`
 * - {@linkcode parseNameStatus}: `--name-status -z` (a commit's files)
 * - {@linkcode parseRefs} and {@linkcode REF_FORMAT}: `git for-each-ref --format=<REF_FORMAT>`
 * - {@linkcode parseStashes} and {@linkcode STASH_FORMAT}: `git stash list -z --format=<…>`
 * - {@linkcode parseWorktrees}: `git worktree list --porcelain`
 *
 * @module
 */

import type {
  CommitFile,
  DiffFile,
  DiffHunk,
  ScmBranch,
  ScmChange,
  ScmCommit,
  ScmLetter,
  ScmRef,
  ScmStash,
  ScmStatus,
  ScmWorktree,
} from "./types.ts";

/** A status or name-status letter as a row shows it (copies count as added files). */
function letterOf(code: string): ScmLetter {
  switch (code) {
    case "A":
    case "C":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "T":
      return "T";
    default:
      return "M";
  }
}

/** The fields after a status entry's type, split on spaces: the first `n`, then the path. */
function fields(entry: string, n: number): [string[], string] {
  const parts: string[] = [];
  let rest = entry;
  for (let i = 0; i < n; i++) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return [parts, ""];
    parts.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  return [parts, rest];
}

/** A changed entry's staged and unstaged halves (`XY`: index, worktree; `.` is unchanged). */
function halves(
  xy: string,
  path: string,
  origPath: string | undefined,
): ScmChange[] {
  const out: ScmChange[] = [];
  const [x, y] = [xy[0] ?? ".", xy[1] ?? "."];
  const orig = origPath !== undefined ? { origPath } : {};
  if (x !== ".") {
    out.push({
      path,
      ...(x === "R" || x === "C" ? orig : {}),
      group: "staged",
      letter: letterOf(x),
    });
  }
  if (y !== ".") {
    out.push({
      path,
      ...(y === "R" || y === "C" ? orig : {}),
      group: "changes",
      letter: letterOf(y),
    });
  }
  return out;
}

/** `git status --porcelain=v2 -z --branch` of the worktree at `root`. */
export function parseStatus(root: string, out: string): ScmStatus {
  const branch: ScmBranch = { head: null, oid: null, ahead: 0, behind: 0 };
  const changes: ScmChange[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.startsWith("# ")) {
      const [key, ...rest] = e.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") {
        branch.oid = value === "(initial)" ? null : value;
      } else if (key === "branch.head") {
        branch.head = value === "(detached)" ? null : value;
      } else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) [branch.ahead, branch.behind] = [Number(m[1]), Number(m[2])];
      }
    } else if (e.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const [f, path] = fields(e.slice(2), 7);
      if (path) changes.push(...halves(f[0], path, undefined));
    } else if (e.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as its own entry.
      const [f, path] = fields(e.slice(2), 8);
      const orig = entries[++i];
      if (path) changes.push(...halves(f[0], path, orig || undefined));
    } else if (e.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const [f, path] = fields(e.slice(2), 9);
      if (path) {
        changes.push({ path, group: "merge", letter: "C", conflict: f[0] });
      }
    } else if (e.startsWith("? ")) {
      changes.push({ path: e.slice(2), group: "untracked", letter: "U" });
    }
  }
  return { root, branch, changes };
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A `diff --git a/x b/y` line's two paths (unquoted paths; `core.quotePath=false`). */
function gitLinePaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  return m ? [m[1], m[2]] : null;
}

/** A `---` / `+++` line's path (`null` for /dev/null). */
function markerPath(line: string): string | null {
  const p = line.slice(4).replace(/\t.*$/, "");
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/** `git diff --no-color` output: its files, each with its header and hunks. */
export function parseDiff(out: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  // Lines still owed to the current hunk (old side, new side): a hunk's `---` line is content.
  let owed = [0, 0];
  const lines = out.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (hunk && (owed[0] > 0 || owed[1] > 0 || line.startsWith("\\"))) {
      hunk.lines.push(line);
      const c = line[0];
      if (c === " " || c === undefined) owed = [owed[0] - 1, owed[1] - 1];
      else if (c === "-") owed = [owed[0] - 1, owed[1]];
      else if (c === "+") owed = [owed[0], owed[1] - 1];
      continue;
    }
    if (line.startsWith("diff --git ") || line.startsWith("diff --cc ")) {
      const paths = gitLinePaths(line);
      file = {
        oldPath: paths?.[0] ?? null,
        newPath: paths?.[1] ?? null,
        header: [line],
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const m = HUNK.exec(line);
    if (m) {
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      owed = [hunk.oldLines, hunk.newLines];
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) continue;
    file.header.push(line);
    if (line.startsWith("--- ")) file.oldPath = markerPath(line);
    else if (line.startsWith("+++ ")) file.newPath = markerPath(line);
    else if (line.startsWith("new file mode")) file.oldPath = null;
    else if (line.startsWith("deleted file mode")) file.newPath = null;
    else if (line.startsWith("rename from ")) file.oldPath = line.slice(12);
    else if (line.startsWith("rename to ")) file.newPath = line.slice(10);
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      file.binary = true;
    }
  }
  return files;
}

/** `git log -z --format=…`: hash, parents, author, author time, ref names, subject. */
export const LOG_FORMAT = "%H%x00%P%x00%an%x00%at%x00%D%x00%s";
const LOG_FIELDS = 6;

/** `git log -z --format=<LOG_FORMAT>`. */
export function parseLog(out: string): ScmCommit[] {
  const t = out.replace(/\n$/, "").split("\0");
  const commits: ScmCommit[] = [];
  for (let i = 0; i + LOG_FIELDS <= t.length; i += LOG_FIELDS) {
    const [oid, parents, author, time, refs, subject] = t.slice(
      i,
      i + LOG_FIELDS,
    );
    // `-z` separates commits with a NUL, and git puts a newline before each next record.
    const id = oid.replace(/^\n/, "");
    if (!/^[0-9a-f]{7,64}$/.test(id)) continue;
    commits.push({
      oid: id,
      parents: parents ? parents.split(" ") : [],
      author,
      time: Number(time) || 0,
      refs: refs ? refs.split(", ") : [],
      subject,
    });
  }
  return commits;
}

/** `--name-status -z` output: a commit's files (`R100 old new`, `M path`…). */
export function parseNameStatus(out: string): CommitFile[] {
  const t = out.split("\0").map((s) => s.replace(/^\n/, ""));
  const files: CommitFile[] = [];
  for (let i = 0; i < t.length; i++) {
    const code = t[i];
    if (!/^[ACDMRTUX]\d*$/.test(code)) continue;
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const [origPath, path] = [t[i + 1], t[i + 2]];
      i += 2;
      if (path) files.push({ path, origPath, letter: letterOf(kind) });
    } else {
      const path = t[++i];
      if (path) files.push({ path, letter: letterOf(kind) });
    }
  }
  return files;
}

/** `git for-each-ref`: the ref, its short id, its upstream, `*` when checked out. */
export const REF_FORMAT =
  "%(refname)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)";

/** `git for-each-ref --format=<REF_FORMAT> refs/heads refs/remotes`. */
export function parseRefs(out: string): ScmRef[] {
  const refs: ScmRef[] = [];
  for (const line of out.split("\n")) {
    const [ref, oid, upstream, head] = line.split("\0");
    if (!ref || oid === undefined) continue;
    const local = ref.startsWith("refs/heads/");
    const remote = ref.startsWith("refs/remotes/");
    // A remote's HEAD (`origin/HEAD`) is a pointer, not a branch to switch to.
    if ((!local && !remote) || ref.endsWith("/HEAD")) continue;
    refs.push({
      name: ref.slice(local ? 11 : 13),
      remote,
      oid,
      ...(upstream ? { upstream } : {}),
      current: head === "*",
    });
  }
  return refs;
}

/** `git stash list -z`: the ref, the commit, its subject, its time. */
export const STASH_FORMAT = "%gd%x00%H%x00%gs%x00%ct";
const STASH_FIELDS = 4;

/** `git stash list -z --format=<STASH_FORMAT>`. */
export function parseStashes(out: string): ScmStash[] {
  const t = out.split("\0").map((s) => s.replace(/^\n/, ""));
  const stashes: ScmStash[] = [];
  for (let i = 0; i + STASH_FIELDS <= t.length; i += STASH_FIELDS) {
    const [ref, oid, subject, time] = t.slice(i, i + STASH_FIELDS);
    if (!/^stash@\{\d+\}$/.test(ref)) continue;
    stashes.push({ ref, oid, subject, time: Number(time) || 0 });
  }
  return stashes;
}

/** `git worktree list --porcelain`: one block per worktree, blank-line separated. */
export function parseWorktrees(out: string): ScmWorktree[] {
  const trees: ScmWorktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    let tree: ScmWorktree | null = null;
    for (const line of block.split("\n")) {
      const sp = line.indexOf(" ");
      const [key, value] = sp < 0
        ? [line, ""]
        : [line.slice(0, sp), line.slice(sp + 1)];
      if (key === "worktree") {
        tree = {
          path: value,
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
        };
        trees.push(tree);
      } else if (!tree) continue;
      else if (key === "HEAD") tree.head = value;
      else if (key === "branch") {
        tree.branch = value.replace(/^refs\/heads\//, "");
      } else if (key === "bare") tree.bare = true;
      else if (key === "detached") tree.detached = true;
      else if (key === "locked") tree.locked = true;
      else if (key === "prunable") tree.prunable = true;
    }
  }
  return trees;
}
