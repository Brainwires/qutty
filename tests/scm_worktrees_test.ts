// Worktrees as workspaces (lib/scm/worktrees.ts) and Source Control tiles in the workspace state:
// the checkout path, the window's URL parameter, the worktree mark through a snapshot and the
// Workspaces menu, the Source Control tile's entry, which checkout a hub tile's folder is in
// (lib/scm/worktree-info.ts, also against a real temp repository), and the hub tagging tiles.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  branchSlug,
  checkoutPath,
  sanitizeScmSettings,
  sanitizeWorktreeMark,
  worktreeFromQuery,
  type WorktreeMark,
  worktreeMarkOf,
  worktreeQuery,
} from "../lib/scm/worktrees.ts";
import { denoWorktreeFs, worktreeOf } from "../lib/scm/worktree-info.ts";
import { sanitizeScmTile, scmTitle } from "../lib/scm/tile.ts";
import { initialState, reduce } from "../lib/workspace/store.ts";
import {
  movedTileOf,
  planRestore,
  snapshotOf,
} from "../lib/workspace/session.ts";
import { WorkspaceRegistry } from "../desktop/workspace-host.ts";
import { Registry } from "../lib/hub/registry.ts";
import { workspaceWindow } from "../lib/workspace/windows.ts";
import { defaultMembers } from "../lib/broadcast.ts";

const MARK: WorktreeMark = {
  path: "/src/.qutty-worktrees/qutty/feature-x",
  branch: "feature/x",
  repo: "/src/qutty",
};

Deno.test("worktrees: the default checkout folder, the setting's, and branch slugs", () => {
  assertEquals(
    checkoutPath("/src/qutty", "feature/x"),
    "/src/.qutty-worktrees/qutty/feature-x",
  );
  assertEquals(
    checkoutPath("/src/qutty/", "main", "/wt/"),
    "/wt/qutty/main",
  );
  assertEquals(branchSlug("feat/a b:c"), "feat-a-b-c");
  assertEquals(branchSlug("../x"), "x");
  assertEquals(branchSlug("///"), "worktree");
  assertEquals(sanitizeScmSettings({ worktreeFolder: "/wt/" }), {
    worktreeFolder: "/wt",
  });
  assertEquals(sanitizeScmSettings({ worktreeFolder: "relative" }), {
    worktreeFolder: "",
  });
  assertEquals(sanitizeScmSettings({ worktreeFolder: "" }), {
    worktreeFolder: "",
  });
});

Deno.test("worktrees: a mark travels in a new window's URL and is checked on the way in", () => {
  const q = worktreeQuery(MARK);
  assert(q.startsWith("?worktree="));
  assertEquals(worktreeFromQuery(q), MARK);
  assertEquals(worktreeFromQuery(""), undefined);
  assertEquals(worktreeFromQuery("?worktree=%7Bbad"), undefined);
  assertEquals(
    worktreeFromQuery(
      `?worktree=${
        encodeURIComponent(JSON.stringify({ ...MARK, path: "rel" }))
      }`,
    ),
    undefined,
  );
  assertEquals(sanitizeWorktreeMark({ ...MARK, branch: "a\nb" }), undefined);
  assertEquals(workspaceWindow("ws-1", true, q).url, `/${q}`);
  assertEquals(workspaceWindow("ws-1").url, "/");
});

Deno.test("worktrees: the workspace keeps its mark through a snapshot, and the Workspaces menu shows it", () => {
  let s = initialState();
  s = reduce(s, { type: "setWorktree", mark: MARK });
  assertEquals(s.worktree, MARK);
  assertEquals(reduce(s, { type: "setWorktree", mark: MARK }), s);
  s = reduce(s, { type: "add", id: "t1", now: 1 });
  const snap = JSON.parse(JSON.stringify(snapshotOf(s, 1, () => ({
    ptyId: "pty-1",
    profile: { kind: "shell" as const, cwd: MARK.path },
  }))));
  assertEquals(worktreeMarkOf(snap), MARK);
  const plan = planRestore(snap, [])!;
  assertEquals(plan.worktree, MARK);
  const restored = reduce(initialState(), {
    type: "restore",
    terminals: plan.terminals,
    mru: plan.mru,
    previousPattern: null,
    ...(plan.worktree ? { worktree: plan.worktree } : {}),
  });
  assertEquals(restored.worktree, MARK);
  assertEquals(
    reduce(s, { type: "setWorktree", mark: null }).worktree,
    undefined,
  );

  const reg = new WorkspaceRegistry();
  const { id } = reg.join("win-1", "ws-a");
  reg.save(id, snap);
  reg.join("win-2", "ws-b");
  const listed = reg.list();
  assertEquals(listed.find((w) => w.id === "ws-a")?.worktree, {
    branch: "feature/x",
    repo: "qutty",
  });
  assertEquals(listed.find((w) => w.id === "ws-b")?.worktree, undefined);
});

Deno.test("scm tile: its entry, title, snapshot and move; never a broadcast member", () => {
  assertEquals(sanitizeScmTile({ root: "/src/qutty", follow: true }), {
    root: "/src/qutty",
    follow: true,
  });
  assertEquals(sanitizeScmTile({ root: null }), { root: null });
  assertEquals(sanitizeScmTile({ root: "rel" }), undefined);
  assertEquals(sanitizeScmTile({}), undefined);
  assertEquals(scmTitle({ root: "/src/qutty" }), "Source Control — qutty");

  let s = initialState();
  s = reduce(s, { type: "add", id: "t1", now: 1, scm: { root: "/src/qutty" } });
  assertEquals(s.terminals[0].title, "Source Control — qutty");
  s = reduce(s, {
    type: "scmTile",
    id: "t1",
    patch: { root: "/src/other", follow: true },
  });
  assertEquals(s.terminals[0].scm, { root: "/src/other", follow: true });
  assertEquals(s.terminals[0].title, "Source Control — other");
  // A terminal's title poll never renames it.
  assertEquals(reduce(s, { type: "title", id: "t1", title: "zsh" }), s);
  assertEquals(defaultMembers(s.terminals, new Set(["t1"])), []);

  const snap = JSON.parse(JSON.stringify(snapshotOf(s, 1, () => undefined)));
  assertEquals(snap.tiles.t1, { scm: { root: "/src/other", follow: true } });
  const plan = planRestore(snap, [])!;
  assertEquals(plan.tiles, [{
    id: "t1",
    scm: { root: "/src/other", follow: true },
  }]);
  assertEquals(plan.terminals[0].scm?.root, "/src/other");
  const moved = movedTileOf({ entry: s.terminals[0], tile: snap.tiles.t1 });
  assertEquals(moved?.entry.scm, { root: "/src/other", follow: true });
});

/** A fake file system: folders and files by path. */
function fakeFs(dirs: string[], files: Record<string, string>) {
  return {
    isDir: (p: string) => dirs.includes(p),
    readText: (p: string) => files[p] ?? null,
  };
}

Deno.test("worktree info: the main checkout, a linked worktree, detached, and no repository", () => {
  const fs = fakeFs(["/src/qutty/.git"], {
    "/src/qutty/.git/HEAD": "ref: refs/heads/main\n",
    "/wt/feature/.git": "gitdir: /src/qutty/.git/worktrees/feature\n",
    "/src/qutty/.git/worktrees/feature/HEAD": "ref: refs/heads/feature/x\n",
    "/wt/detached/.git": "gitdir: /src/qutty/.git/worktrees/d\n",
    "/src/qutty/.git/worktrees/d/HEAD": "0123456789abcdef\n",
  });
  assertEquals(worktreeOf("/src/qutty/lib/scm", fs), {
    path: "/src/qutty",
    branch: "main",
    linked: false,
  });
  assertEquals(worktreeOf("/wt/feature/src", fs), {
    path: "/wt/feature",
    branch: "feature/x",
    linked: true,
  });
  assertEquals(worktreeOf("/wt/detached", fs), {
    path: "/wt/detached",
    linked: true,
  });
  assertEquals(worktreeOf("/elsewhere", fs), undefined);
  assertEquals(worktreeOf("relative", fs), undefined);
});

Deno.test("hub registry: each tile's worktree and branch, updated when its folder changes, none in the sandbox", () => {
  const fs = fakeFs(["/r/.git"], {
    "/r/.git/HEAD": "ref: refs/heads/main\n",
    "/w/.git": "gitdir: /r/.git/worktrees/w\n",
    "/r/.git/worktrees/w/HEAD": "ref: refs/heads/topic\n",
  });
  const reg = new Registry(() => {}, (cwd) => worktreeOf(cwd, fs));
  reg.add({ id: "pty-1", cwd: "/r/src" });
  reg.add({ id: "pty-2", cwd: "/w", harness: "claude" });
  reg.add({ id: "pty-3", cwd: "/r", sandbox: true });
  const byId = (id: string) => reg.list().find((t) => t.id === id);
  assertEquals(byId("pty-1")?.worktree, {
    path: "/r",
    branch: "main",
    linked: false,
  });
  assertEquals(byId("pty-2")?.worktree, {
    path: "/w",
    branch: "topic",
    linked: true,
  });
  assertEquals(byId("pty-3")?.worktree, undefined);
  reg.setMeta("pty-1", { cwd: "/w/x" });
  assertEquals(byId("pty-1")?.worktree?.branch, "topic");
  reg.setMeta("pty-1", { cwd: "/tmp" });
  assertEquals(byId("pty-1")?.worktree, undefined);
});

const GIT = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
  .find((p) => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      return false;
    }
  });

Deno.test({
  name: "worktree info: a real repository and a linked worktree (temp folders)",
  ignore: !GIT || Deno.build.os === "windows",
  fn: async () => {
    const base = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "qutty-wt-info-" }),
    );
    const env = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: base,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const git = async (cwd: string, ...args: string[]) => {
      const r = await new Deno.Command(GIT!, {
        args,
        cwd,
        env,
        stderr: "piped",
      })
        .output();
      assert(r.success, new TextDecoder().decode(r.stderr));
    };
    try {
      const repo = join(base, "repo");
      await Deno.mkdir(repo);
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "commit", "-q", "--allow-empty", "-m", "x");
      const wt = checkoutPath(repo, "topic/one");
      await git(repo, "worktree", "add", "-q", "-b", "topic/one", wt);
      const fs = denoWorktreeFs;
      assertEquals(worktreeOf(repo, fs), {
        path: repo,
        branch: "main",
        linked: false,
      });
      assertEquals(worktreeOf(wt, fs), {
        path: wt,
        branch: "topic/one",
        linked: true,
      });
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});
