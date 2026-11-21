/**
 * The demo backend's repository (browser dev mode and the e2e suite): a small project kept in
 * memory, with HEAD, an index and a worktree per file, so the Source Control tile can stage
 * (files and hunks), commit, switch branches, stash and "push" with nothing on disk and no git.
 * Every folder is in it: whatever terminal opens Source Control lands here.
 *
 * Diffs are made with a plain LCS line diff and hunk patches are applied by parsing them back
 * (lib/scm/parse.ts), so the tile's own patch path runs here as it does against real git.
 *
 * @module
 */

import { parseDiff } from "./parse.ts";
import type {
  CommitFile,
  DiffFile,
  DiffHunk,
  ScmChange,
  ScmChanged,
  ScmClient,
  ScmCommit,
  ScmProgress,
  ScmRef,
  ScmResult,
  ScmStash,
  ScmStatus,
  ScmWorktree,
} from "./types.ts";

/** The demo repository's root. */
const DEMO_REPO = "/Users/demo/Source/qutty-demo";

type Files = Map<string, string>;

interface DemoCommit {
  oid: string;
  parents: string[];
  author: string;
  time: number;
  subject: string;
  message: string;
  files: Files;
}

/** A unified diff of `a` → `b` (each a file's text, `null` when absent) for `path`. */
function unified(path: string, a: string | null, b: string | null): string {
  const x = a === null ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === null ? [] : b.replace(/\n$/, "").split("\n");
  if (a === "") x.length = 0;
  if (b === "") y.length = 0;
  // LCS table, then a walk that emits the edit script.
  const n = x.length, m = y.length;
  const lcs = Array.from(
    { length: n + 1 },
    () => new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: { sign: " " | "-" | "+"; text: string; i: number; j: number }[] =
    [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ sign: " ", text: x[i++], i, j: j++ });
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      ops.push({ sign: "+", text: y[j++], i, j });
    } else ops.push({ sign: "-", text: x[i++], i, j });
  }
  // Hunks: each change with up to 3 lines of context, close ones merged.
  const CONTEXT = 3;
  const hunks: string[] = [];
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k].sign === " ") k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    let quiet = 0;
    while (end < ops.length && quiet <= 2 * CONTEXT) {
      quiet = ops[end].sign === " " ? quiet + 1 : 0;
      end++;
    }
    end = Math.min(ops.length, end - Math.max(0, quiet - CONTEXT));
    const slice = ops.slice(start, end);
    const oldLines = slice.filter((o) => o.sign !== "+").length;
    const newLines = slice.filter((o) => o.sign !== "-").length;
    let oldStart = 0, newStart = 0;
    for (const o of ops.slice(0, start)) {
      if (o.sign !== "+") oldStart++;
      if (o.sign !== "-") newStart++;
    }
    hunks.push(
      `@@ -${oldLines ? oldStart + 1 : oldStart},${oldLines} +${
        newLines ? newStart + 1 : newStart
      },${newLines} @@`,
      ...slice.map((o) => o.sign + o.text),
    );
    k = end;
  }
  if (hunks.length === 0) return "";
  return [
    `diff --git a/${path} b/${path}`,
    ...(a === null ? ["new file mode 100644"] : []),
    ...(b === null ? ["deleted file mode 100644"] : []),
    `--- ${a === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${b === null ? "/dev/null" : `b/${path}`}`,
    ...hunks,
    "",
  ].join("\n");
}

/** `text` with `hunk` applied (or taken back, `reverse`), or `null` when it does not fit. */
function applyHunk(
  text: string,
  hunk: DiffHunk,
  reverse: boolean,
): string | null {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const from = hunk.lines.filter((l) =>
    l[0] === " " || l[0] === (reverse ? "+" : "-")
  )
    .map((l) => l.slice(1));
  const to = hunk.lines.filter((l) =>
    l[0] === " " || l[0] === (reverse ? "-" : "+")
  )
    .map((l) => l.slice(1));
  const start = reverse ? hunk.newStart : hunk.oldStart;
  const at = from.length === 0 ? start : start - 1;
  if (lines.slice(at, at + from.length).join("\n") !== from.join("\n")) {
    return null;
  }
  lines.splice(at, from.length, ...to);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

const ok: ScmResult = { ok: true };
const fail = (error: string): ScmResult => ({ ok: false, error });

const README = `# qutty-demo

A small project for the Source Control demo.

## Build

Run the tasks:

    deno task build
    deno task test

## Notes

Everything here lives in memory.
`;

const APP = `export function greet(name: string): string {
  return "Hello, " + name;
}
`;

/** A fake commit id from a counter (40 hex digits). */
const oidOf = (n: number) =>
  (n * 2654435761).toString(16).padStart(8, "0").repeat(5);

/** A Source Control client over an in-memory repository. */
export function createDemoScm(): ScmClient {
  let seq = 1;
  const now = Math.floor(Date.now() / 1000);
  const commits = new Map<string, DemoCommit>();
  const add = (
    parents: string[],
    subject: string,
    files: Files,
    ago: number,
  ): string => {
    const oid = oidOf(seq++);
    commits.set(oid, {
      oid,
      parents,
      author: "Demo User",
      // New commits are a second apart, so the history's order is their order.
      time: ago === 0 ? Math.floor(Date.now() / 1000) + seq : now - ago,
      subject,
      message: subject,
      files: new Map(files),
    });
    return oid;
  };
  const c1 = add(
    [],
    "Initial commit",
    new Map([["README.md", "# qutty-demo\n"]]),
    86400 * 5,
  );
  const c2 = add(
    [c1],
    "Add the app",
    new Map([["README.md", "# qutty-demo\n"], ["src/app.ts", APP]]),
    86400 * 4,
  );
  const c3 = add(
    [c2],
    "Feature: a greeting",
    new Map([...commits.get(c2)!.files, ["src/greet.ts", "export {};\n"]]),
    86400 * 3,
  );
  const c4 = add(
    [c2],
    "Write the README",
    new Map([...commits.get(c2)!.files, ["README.md", README]]),
    86400 * 2,
  );
  const c5 = add(
    [c4, c3],
    "Merge branch 'feature/greet'",
    new Map([...commits.get(c4)!.files, ["src/greet.ts", "export {};\n"]]),
    86400,
  );
  const branches = new Map<string, string>([["main", c5], [
    "feature/greet",
    c3,
  ]]);
  const remotes = new Map<string, string>([["origin/main", c4]]);
  let current: string | null = "main";
  let head = c5;
  const headFiles = () => commits.get(head)?.files ?? new Map<string, string>();
  const index: Files = new Map(headFiles());
  const work: Files = new Map(headFiles());
  // Changes to show: README edited in two places, app.ts staged, a new file.
  work.set(
    "README.md",
    README.replace("A small project", "A tiny project").replace(
      "Everything here",
      "Everything shown here",
    ),
  );
  const app = APP.replace("Hello", "Hi there");
  index.set("src/app.ts", app);
  work.set("src/app.ts", app);
  work.set("notes.txt", "Remember to push.\n");
  const stashes: {
    oid: string;
    subject: string;
    time: number;
    work: Files;
    index: Files;
  }[] = [];

  const changed = new Set<(e: ScmChanged) => void>();
  const progress = new Set<(e: ScmProgress) => void>();
  const notify = () => {
    for (const cb of [...changed]) cb({ root: DEMO_REPO });
  };
  const running = new Map<string, () => void>();

  const status = (): ScmStatus => {
    const h = headFiles();
    const changes: ScmChange[] = [];
    const paths = [...new Set([...h.keys(), ...index.keys(), ...work.keys()])]
      .sort();
    for (const path of paths) {
      const [hv, iv, wv] = [h.get(path), index.get(path), work.get(path)];
      if (iv !== hv) {
        changes.push({
          path,
          group: "staged",
          letter: hv === undefined ? "A" : iv === undefined ? "D" : "M",
        });
      }
      if (iv === undefined && wv !== undefined) {
        changes.push({ path, group: "untracked", letter: "U" });
      } else if (iv !== undefined && wv !== iv) {
        changes.push({
          path,
          group: "changes",
          letter: wv === undefined ? "D" : "M",
        });
      }
    }
    const upstream = current === "main" ? "origin/main" : undefined;
    const counts = upstream
      ? aheadBehind(head, remotes.get(upstream)!)
      : [0, 0];
    return {
      root: DEMO_REPO,
      branch: {
        head: current,
        oid: head,
        ...(upstream ? { upstream } : {}),
        ahead: counts[0],
        behind: counts[1],
      },
      changes,
    };
  };

  /** Every commit reachable from `oid`. */
  const reach = (oid: string): Set<string> => {
    const seen = new Set<string>();
    const todo = [oid];
    while (todo.length) {
      const o = todo.pop()!;
      if (seen.has(o)) continue;
      seen.add(o);
      todo.push(...(commits.get(o)?.parents ?? []));
    }
    return seen;
  };
  const aheadBehind = (a: string, b: string): [number, number] => {
    const [ra, rb] = [reach(a), reach(b)];
    return [
      [...ra].filter((o) => !rb.has(o)).length,
      [...rb].filter((o) => !ra.has(o)).length,
    ];
  };

  const refsOf = (oid: string): string[] => {
    const out: string[] = [];
    for (const [name, o] of branches) {
      if (o !== oid) continue;
      out.push(name === current ? `HEAD -> ${name}` : name);
    }
    for (const [name, o] of remotes) if (o === oid) out.push(name);
    if (current === null && head === oid) out.unshift("HEAD");
    return out;
  };

  const commitNow = (
    subject: string,
    parents: string[],
    files: Files,
  ): string => {
    const oid = add(parents, subject.split("\n")[0], files, 0);
    commits.get(oid)!.message = subject;
    head = oid;
    if (current) branches.set(current, oid);
    return oid;
  };

  const later = <T>(value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), 30));

  const done = (): Promise<ScmResult> => {
    notify();
    return later(ok);
  };

  const fileDiff = (
    path: string,
    a: string | null,
    b: string | null,
  ): DiffFile | null => parseDiff(unified(path, a, b))[0] ?? null;

  return {
    repoRoot: (path) =>
      later(path.startsWith("/") || path.startsWith("~") ? DEMO_REPO : null),
    status: () => later(status()),
    diff: (req) => {
      const h = headFiles();
      const [a, b] = req.kind === "staged"
        ? [h.get(req.path) ?? null, index.get(req.path) ?? null]
        : req.kind === "changes"
        ? [index.get(req.path) ?? null, work.get(req.path) ?? null]
        : [null, work.get(req.path) ?? null];
      return later(fileDiff(req.path, a, b));
    },
    stage: (req) => {
      for (const p of req.paths) {
        const w = work.get(p);
        if (w === undefined) index.delete(p);
        else index.set(p, w);
      }
      return done();
    },
    unstage: (req) => {
      const h = headFiles();
      for (const p of req.paths) {
        const v = h.get(p);
        if (v === undefined) index.delete(p);
        else index.set(p, v);
      }
      return done();
    },
    discard: (req) => {
      for (const p of req.paths) {
        const v = index.get(p);
        if (v !== undefined) work.set(p, v);
      }
      return done();
    },
    discardUntracked: (req) => {
      // No Trash in the demo: it asks, then deletes.
      if (!req.confirmDelete) return later({ ok: false, needsConfirm: true });
      for (const p of req.paths) if (!index.has(p)) work.delete(p);
      return done();
    },
    applyPatch: (req) => {
      const [file] = parseDiff(req.patch);
      const path = file?.newPath;
      const hunk = file?.hunks[0];
      if (!path || !hunk) return later(fail("error: corrupt patch"));
      const target = req.action === "discard" ? work : index;
      const next = applyHunk(
        target.get(path) ?? "",
        hunk,
        req.action !== "stage",
      );
      if (next === null) return later(fail(`error: patch failed: ${path}`));
      target.set(path, next);
      return done();
    },
    commit: (req) => {
      if (!req.message.trim()) {
        return later(fail("The commit message is empty."));
      }
      if (req.stageAll) { for (const [p, v] of work) index.set(p, v); }
      if (req.mode === "all") {
        for (const p of index.keys()) {
          const w = work.get(p);
          if (w === undefined) index.delete(p);
          else index.set(p, w);
        }
      }
      const prev = commits.get(head);
      if (req.amend && prev) {
        commitNow(req.message, prev.parents, index);
      } else {
        const same = [...index].length === headFiles().size &&
          [...index].every(([p, v]) => headFiles().get(p) === v);
        if (same) return later(fail("nothing to commit, working tree clean"));
        commitNow(req.message, [head], index);
      }
      return done();
    },
    lastMessage: () => later(commits.get(head)?.message ?? ""),
    branches: () => {
      const refs: ScmRef[] = [...branches].map(([name, oid]) => ({
        name,
        remote: false,
        oid: oid.slice(0, 7),
        ...(name === "main" ? { upstream: "origin/main" } : {}),
        current: name === current,
      }));
      for (const [name, oid] of remotes) {
        refs.push({ name, remote: true, oid: oid.slice(0, 7), current: false });
      }
      return later(refs);
    },
    checkout: (req) => {
      if (!/^[\w./-]+$/.test(req.name) || req.name.includes("..")) {
        return later(fail(`"${req.name}" is not a valid branch name.`));
      }
      if (req.create) {
        if (branches.has(req.name)) {
          return later(
            fail(`fatal: a branch named '${req.name}' already exists`),
          );
        }
        branches.set(req.name, head);
        current = req.name;
        return done();
      }
      const name = branches.has(req.name)
        ? req.name
        : req.name.replace(/^origin\//, "");
      const oid = branches.get(name) ?? remotes.get(req.name);
      if (!oid) return later(fail(`There is no branch "${req.name}".`));
      branches.set(name, oid);
      current = name;
      head = oid;
      // Switching carries uncommitted changes, as git does when they do not conflict.
      for (const [p, v] of headFiles()) {
        if (!index.has(p) || index.get(p) === commits.get(oid)?.files.get(p)) {
          index.set(p, v);
        }
        if (!work.has(p)) work.set(p, v);
      }
      return done();
    },
    remote: (req) =>
      new Promise((resolve) => {
        const steps = [
          "Enumerating objects: 5, done.",
          "Counting objects: 100% (5/5), done.",
          "Writing objects: 100% (3/3), done.",
        ];
        let n = 0;
        const timer = setInterval(() => {
          if (n < steps.length) {
            for (const cb of [...progress]) {
              cb({ opId: req.opId, line: steps[n++] });
            }
            return;
          }
          clearInterval(timer);
          running.delete(req.opId);
          if (current === "main" && (req.op === "push" || req.op === "sync")) {
            remotes.set("origin/main", head);
          }
          notify();
          resolve(ok);
        }, 150);
        running.set(req.opId, () => {
          clearInterval(timer);
          running.delete(req.opId);
          resolve({ ok: false, cancelled: true, error: "Cancelled." });
        });
      }),
    cancel: (opId) => {
      running.get(opId)?.();
      return later(undefined);
    },
    log: (_root, limit) => {
      const out: ScmCommit[] = [];
      const seen = new Set<string>();
      const todo = [head, ...branches.values(), ...remotes.values()];
      // Newest first, by time.
      while (todo.length) {
        const oid = todo.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const c = commits.get(oid);
        if (!c) continue;
        out.push({
          oid,
          parents: [...c.parents],
          author: c.author,
          time: c.time,
          refs: refsOf(oid),
          subject: c.subject,
        });
        todo.push(...c.parents);
      }
      return later(
        out.sort((a, b) => b.time - a.time).slice(
          0,
          limit,
        ),
      );
    },
    commitFiles: (_root, oid) => {
      const c = commits.get(oid);
      if (!c) return later([]);
      const before = commits.get(c.parents[0])?.files ??
        new Map<string, string>();
      const files: CommitFile[] = [];
      for (
        const p of [...new Set([...before.keys(), ...c.files.keys()])].sort()
      ) {
        const [a, b] = [before.get(p), c.files.get(p)];
        if (a === b) continue;
        files.push({
          path: p,
          letter: a === undefined ? "A" : b === undefined ? "D" : "M",
        });
      }
      return later(files);
    },
    commitDiff: (_root, oid, path) => {
      const c = commits.get(oid);
      if (!c) return later(null);
      const before = commits.get(c.parents[0])?.files;
      return later(
        fileDiff(path, before?.get(path) ?? null, c.files.get(path) ?? null),
      );
    },
    stashes: () =>
      later(
        stashes.map((s, i): ScmStash => ({
          ref: `stash@{${i}}`,
          oid: s.oid,
          subject: s.subject,
          time: s.time,
        })),
      ),
    stashPush: (req) => {
      const st = status();
      if (!st.changes.some((c) => c.group !== "untracked" || req.untracked)) {
        return later(fail("No local changes to save"));
      }
      stashes.unshift({
        oid: oidOf(seq++),
        subject: `On ${current ?? "(no branch)"}: ${
          req.message || "Stashed from Qutty"
        }`,
        time: Math.floor(Date.now() / 1000),
        work: new Map(work),
        index: new Map(index),
      });
      const h = headFiles();
      for (const p of [...work.keys()]) {
        if (!index.has(p) && !req.untracked) continue;
        if (h.has(p)) work.set(p, h.get(p)!);
        else work.delete(p);
      }
      index.clear();
      for (const [p, v] of h) index.set(p, v);
      return done();
    },
    stashAction: (req) => {
      const i = stashes.findIndex((s) => s.oid === req.oid);
      if (i < 0 || req.ref !== `stash@{${i}}`) {
        return later(
          fail(
            "The stash list changed since it was shown. Refresh and try again.",
          ),
        );
      }
      const s = stashes[i];
      if (req.action !== "drop") {
        for (const [p, v] of s.work) work.set(p, v);
      }
      if (req.action !== "apply") stashes.splice(i, 1);
      return done();
    },
    worktrees: () => {
      const trees: ScmWorktree[] = [{
        path: DEMO_REPO,
        head,
        ...(current ? { branch: current } : {}),
        bare: false,
        detached: current === null,
        locked: false,
        prunable: false,
      }];
      return later(trees);
    },
    worktreeAdd: () => later(fail("Worktrees need the desktop app.")),
    worktreeRemove: () => later(fail("Worktrees need the desktop app.")),
    watch: () => later(() => {}),
    onChanged: (cb) => {
      changed.add(cb);
      return () => void changed.delete(cb);
    },
    onProgress: (cb) => {
      progress.add(cb);
      return () => void progress.delete(cb);
    },
  };
}
