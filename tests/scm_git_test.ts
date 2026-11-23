// Source Control against real git (desktop/scm.ts's ScmService through the PTY wrapper): each
// test makes its own temporary repository under a throwaway HOME and global config, so the
// user's git config, hooks and signing never apply and nothing outside the temp folder changes.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { PtyProgramRunner, ScmService } from "../desktop/scm.ts";
import { runtimeOpenPty } from "../desktop/pty.ts";
import { hunkPatch } from "../lib/scm/patch.ts";
import type { ScmChange } from "../lib/scm/types.ts";

const GIT = (() => {
  for (
    const p of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
  ) {
    try {
      if (Deno.statSync(p).isFile) return p;
    } catch { /* not here */ }
  }
  return undefined;
})();

const ignore = !GIT || Deno.build.os === "windows" || !runtimeOpenPty();

const ENV_KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
let savedEnv: Record<string, string | undefined> = {};

/** Put back the environment {@linkcode isolate} changed. */
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

/**
 * A temp HOME with its own global config and a fixed identity, for the PTYs this test starts (they
 * copy this process's environment); {@linkcode restoreEnv} puts the real one back.
 */
async function isolate(): Promise<string> {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  const base = await Deno.makeTempDir({ prefix: "qutty-scm-test-" });
  const home = join(base, "home");
  await Deno.mkdir(home);
  const config = join(home, ".gitconfig");
  await Deno.writeTextFile(
    config,
    "[user]\n\tname = Qutty Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
  );
  Deno.env.set("HOME", home);
  Deno.env.set("GIT_CONFIG_GLOBAL", config);
  Deno.env.set("GIT_CONFIG_NOSYSTEM", "1");
  return base;
}

/** Run plain git (setup only) in `cwd`. */
async function sh(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command(GIT!, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

const TEN = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") +
  "\n";

async function repo(): Promise<
  { root: string; base: string; scm: ScmService }
> {
  const base = await isolate();
  const root = join(base, "repo");
  await Deno.mkdir(root);
  await sh(root, "init", "-q");
  await Deno.writeTextFile(join(root, "a.txt"), TEN);
  await sh(root, "add", "a.txt");
  await sh(root, "commit", "-q", "-m", "first");
  const scm = new ScmService({
    runner: new PtyProgramRunner(),
    find: () => Promise.resolve(GIT),
  });
  // macOS reports the temp folder under /private.
  return { root: await Deno.realPath(root), base, scm };
}

const find = (changes: ScmChange[], group: string, path: string) =>
  changes.find((c) => c.group === group && c.path === path);

Deno.test({
  name: "scm (real git): status, stage one hunk, unstage it, commit",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { root, base, scm } = await repo();
    try {
      assertEquals(await scm.repoRoot(join(root)), root);
      // Two separate hunks: line 2 and line 28.
      const lines = TEN.split("\n");
      lines[1] = "line 2 changed";
      lines[27] = "line 28 changed";
      await Deno.writeTextFile(join(root, "a.txt"), lines.join("\n"));
      await Deno.writeTextFile(join(root, "new.txt"), "hello\n");

      let st = await scm.status(root);
      assertEquals(st.branch.head, "main");
      assert(find(st.changes, "changes", "a.txt"));
      assertEquals(find(st.changes, "untracked", "new.txt")?.letter, "U");

      const diff = (await scm.diff({ root, path: "a.txt", kind: "changes" }))!;
      assertEquals(diff.hunks.length, 2);
      const patch = hunkPatch(diff, 1)!;
      assertEquals(
        (await scm.applyPatch({ root, patch, action: "stage" })).ok,
        true,
      );
      const staged = (await scm.diff({ root, path: "a.txt", kind: "staged" }))!;
      assertEquals(staged.hunks.length, 1);
      assert(staged.hunks[0].lines.includes("+line 28 changed"));
      const left = (await scm.diff({ root, path: "a.txt", kind: "changes" }))!;
      assertEquals(left.hunks.length, 1);
      assert(left.hunks[0].lines.includes("+line 2 changed"));

      // Unstage that hunk again (reverse-applied to the index).
      const back = hunkPatch(staged, 0, true)!;
      assertEquals(
        (await scm.applyPatch({ root, patch: back, action: "unstage" })).ok,
        true,
      );
      st = await scm.status(root);
      assertEquals(find(st.changes, "staged", "a.txt"), undefined);

      // Stage the first hunk and commit only it.
      const again = (await scm.diff({ root, path: "a.txt", kind: "changes" }))!;
      assertEquals(
        (await scm.applyPatch({
          root,
          patch: hunkPatch(again, 0)!,
          action: "stage",
        })).ok,
        true,
      );
      const done = await scm.commit({
        root,
        message: "second",
        mode: "staged",
      });
      assertEquals(done, { ok: true });
      const log = await scm.log(root, 10);
      assertEquals(log.map((c) => c.subject), ["second", "first"]);
      assertEquals(log[0].parents, [log[1].oid]);
      assert(log[0].refs.some((r) => r.includes("main")));
      const files = await scm.commitFiles(root, log[0].oid);
      assertEquals(files, [{ path: "a.txt", letter: "M" }]);
      const cd = (await scm.commitDiff(root, log[0].oid, "a.txt"))!;
      assert(cd.hunks[0].lines.includes("+line 2 changed"));
      // Line 28 is still a change in the worktree.
      st = await scm.status(root);
      assert(find(st.changes, "changes", "a.txt"));

      // An empty message is refused; Amend keeps one commit.
      assertEquals(
        (await scm.commit({ root, message: " ", mode: "staged" })).ok,
        false,
      );
      assertEquals(await scm.lastMessage(root), "second");
      assertEquals(
        (await scm.commit({
          root,
          message: "second, amended",
          mode: "all",
          amend: true,
        })).ok,
        true,
      );
      assertEquals((await scm.log(root, 10)).map((c) => c.subject), [
        "second, amended",
        "first",
      ]);
    } finally {
      restoreEnv();
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "scm (real git): stage, unstage and discard files; stage all and commit",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { root, base, scm } = await repo();
    try {
      await Deno.writeTextFile(join(root, "a.txt"), "changed\n");
      await Deno.writeTextFile(join(root, "b.txt"), "new\n");
      assertEquals(
        (await scm.stage({ root, paths: ["a.txt", "b.txt"] })).ok,
        true,
      );
      let st = await scm.status(root);
      assertEquals(find(st.changes, "staged", "b.txt")?.letter, "A");
      assertEquals((await scm.unstage({ root, paths: ["a.txt"] })).ok, true);
      st = await scm.status(root);
      assertEquals(find(st.changes, "changes", "a.txt")?.letter, "M");
      assertEquals((await scm.discard({ root, paths: ["a.txt"] })).ok, true);
      assertEquals(await Deno.readTextFile(join(root, "a.txt")), TEN);
      // A path outside the repository is refused before git runs.
      assertEquals((await scm.stage({ root, paths: ["../x"] })).ok, false);
      // An untracked file, deleted once confirmed.
      await Deno.writeTextFile(join(root, "junk.txt"), "x\n");
      const gone = await scm.discardUntracked({
        root,
        paths: ["junk.txt"],
        confirmDelete: true,
      });
      assertEquals(gone.ok, true);
      await Deno.stat(join(root, "junk.txt")).then(
        () => assert(false, "junk.txt is still there"),
        () => {},
      );
      // Rename shows as R with its old path once staged.
      await sh(root, "mv", "a.txt", "c.txt");
      st = await scm.status(root);
      const r = find(st.changes, "staged", "c.txt");
      assertEquals(r?.letter, "R");
      assertEquals(r?.origPath, "a.txt");
      // Stage everything (untracked too) and commit.
      await Deno.writeTextFile(join(root, "d.txt"), "d\n");
      assertEquals(
        (await scm.commit({
          root,
          message: "all",
          mode: "staged",
          stageAll: true,
        })).ok,
        true,
      );
      st = await scm.status(root);
      assertEquals(st.changes, []);
    } finally {
      restoreEnv();
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "scm (real git): branches, switch, create; stash push / apply / drop; worktree add",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { root, base, scm } = await repo();
    try {
      assertEquals(
        (await scm.checkout({ root, name: "feature", create: true })).ok,
        true,
      );
      assertEquals((await scm.status(root)).branch.head, "feature");
      assertEquals((await scm.checkout({ root, name: "main" })).ok, true);
      const refs = await scm.branches(root);
      assertEquals(refs.map((r) => r.name).sort(), ["feature", "main"]);
      assert(refs.find((r) => r.name === "main")?.current);
      assertEquals(
        (await scm.checkout({ root, name: "bad..name", create: true })).ok,
        false,
      );
      assertEquals((await scm.checkout({ root, name: "nope" })).ok, false);

      await Deno.writeTextFile(join(root, "a.txt"), "stashed\n");
      assertEquals(
        (await scm.stashPush({ root, message: "my stash" })).ok,
        true,
      );
      assertEquals(await Deno.readTextFile(join(root, "a.txt")), TEN);
      const [s] = await scm.stashes(root);
      assertEquals(s.ref, "stash@{0}");
      assert(s.subject.endsWith("my stash"));
      // A stale oid is refused: the stack changed since it was shown.
      const stale = await scm.stashAction({
        root,
        ref: s.ref,
        oid: "0".repeat(40),
        action: "drop",
      });
      assertEquals(stale.ok, false);
      assertEquals(
        (await scm.stashAction({
          root,
          ref: s.ref,
          oid: s.oid,
          action: "apply",
        })).ok,
        true,
      );
      assertEquals(await Deno.readTextFile(join(root, "a.txt")), "stashed\n");
      assertEquals(
        (await scm.stashAction({
          root,
          ref: s.ref,
          oid: s.oid,
          action: "drop",
        })).ok,
        true,
      );
      assertEquals(await scm.stashes(root), []);

      const wt = join(base, "repo-feature");
      assertEquals(
        (await scm.worktreeAdd({ root, path: wt, branch: "feature" })).ok,
        true,
      );
      const trees = await scm.worktrees(root);
      assertEquals(trees.length, 2);
      assertEquals(trees[1].branch, "feature");
      assertEquals(await scm.repoRoot(wt), await Deno.realPath(wt));
      assertEquals(
        (await scm.status(await Deno.realPath(wt))).branch.head,
        "feature",
      );
      // Remove: a dirty checkout is refused unless forced; the branch always stays.
      const real = await Deno.realPath(wt);
      await Deno.writeTextFile(join(real, "dirty.txt"), "x\n");
      const refused = await scm.worktreeRemove({ root, path: real });
      assertEquals([refused.ok, refused.dirty], [false, true]);
      assert(await Deno.stat(real));
      assertEquals(
        (await scm.worktreeRemove({ root, path: real, force: true })).ok,
        true,
      );
      await Deno.stat(real).then(
        () => assert(false, "the worktree folder is still there"),
        () => {},
      );
      assertEquals((await scm.worktrees(root)).length, 1);
      assert((await scm.branches(root)).some((b) => b.name === "feature"));
      // A clean one goes without asking.
      const wt2 = join(base, "wt2");
      assertEquals(
        (await scm.worktreeAdd({ root, path: wt2, branch: "w2", create: true }))
          .ok,
        true,
      );
      assertEquals(
        (await scm.worktreeRemove({ root, path: await Deno.realPath(wt2) })).ok,
        true,
      );
      assert((await scm.branches(root)).some((b) => b.name === "w2"));
    } finally {
      restoreEnv();
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "scm (real git): push publishes a branch to its remote, fetch and pull report clearly",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { root, base, scm } = await repo();
    try {
      // No remote yet.
      const none = await scm.remote({ root, op: "push", opId: "op1" });
      assertEquals(none.ok, false);
      const bare = join(base, "origin.git");
      await sh(base, "init", "-q", "--bare", bare);
      await sh(root, "remote", "add", "origin", bare);
      const progress: string[] = [];
      scm.setEmit((event, data) => {
        if (event === "progress") {
          progress.push((data as { line: string }).line);
        }
      });
      assertEquals(await scm.remote({ root, op: "push", opId: "op2" }), {
        ok: true,
      });
      const st = await scm.status(root);
      assertEquals(st.branch.upstream, "origin/main");
      assertEquals([st.branch.ahead, st.branch.behind], [0, 0]);
      assertEquals(await scm.remote({ root, op: "fetch", opId: "op3" }), {
        ok: true,
      });
      assertEquals(await scm.remote({ root, op: "sync", opId: "op4" }), {
        ok: true,
      });
      // A remote that does not exist: git's own message.
      await sh(root, "remote", "set-url", "origin", join(base, "missing.git"));
      const bad = await scm.remote({ root, op: "fetch", opId: "op5" });
      assertEquals(bad.ok, false);
      assert(bad.error && bad.error.length > 0);
    } finally {
      restoreEnv();
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "scm (real git): the watch reports a change in the worktree, debounced, until unwatched",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { root, base, scm } = await repo();
    try {
      let changed = 0;
      scm.setEmit((event, data) => {
        if (event === "changed" && (data as { root: string }).root === root) {
          changed++;
        }
      });
      const id = await scm.watch(root, "test-window");
      // FSEvents and inotify need a moment before the first event is seen.
      await new Promise((r) => setTimeout(r, 300));
      await Deno.writeTextFile(join(root, "a.txt"), "edited\n");
      await Deno.writeTextFile(join(root, "b.txt"), "new\n");
      const deadline = Date.now() + 5000;
      while (changed === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(changed >= 1, "no change reported");
      // Several writes in a burst are one event (or very few).
      assert(changed <= 2, `${changed} events for one burst`);
      scm.unwatchOwnedBy("test-window");
      const before = changed;
      await Deno.writeTextFile(join(root, "c.txt"), "after\n");
      await new Promise((r) => setTimeout(r, 900));
      assertEquals(changed, before);
      scm.unwatch(id);
    } finally {
      restoreEnv();
      await Deno.remove(base, { recursive: true });
    }
  },
});
