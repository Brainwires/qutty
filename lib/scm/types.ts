/**
 * Source Control, the shapes both sides share: what the `scm` desktop extension (desktop/scm.ts)
 * answers and the demo repository (lib/scm/demo.ts) imitates, and the client the Source Control
 * tile (app/scm-tile.tsx) talks to. Parsing lives in lib/scm/parse.ts, hunk patches in
 * lib/scm/patch.ts.
 *
 * Paths in a status, a diff or a commit are relative to the repository's root (git's own, with
 * `/` separators); the root is absolute.
 *
 * @module
 */

/** The four change groups, in the order the tile lists them (VS Code's). */
export type ScmGroup = "merge" | "staged" | "changes" | "untracked";

/**
 * The letter a file row shows (VS Code's): Modified, Added, Deleted, Renamed, Type changed,
 * Untracked, Conflicted.
 */
export type ScmLetter = "M" | "A" | "D" | "R" | "T" | "U" | "C";

/** One changed file in one group. A file staged and changed again is in both groups. */
export interface ScmChange {
  /** The path now (a rename's new path). */
  path: string;
  /** A rename's or copy's old path. */
  origPath?: string;
  group: ScmGroup;
  letter: ScmLetter;
  /** A conflict's two-letter code (`UU`, `AA`, `DU`…), for the merge group. */
  conflict?: string;
}

/** The branch line of a status (`git status --porcelain=v2 --branch`). */
export interface ScmBranch {
  /** The branch checked out; `null` when HEAD is detached. */
  head: string | null;
  /** HEAD's commit; `null` before the first commit. */
  oid: string | null;
  /** Its upstream (`origin/main`), when it has one. */
  upstream?: string;
  /** Commits ahead of and behind the upstream (0 without one). */
  ahead: number;
  behind: number;
}

/** A repository's status. */
export interface ScmStatus {
  /** The worktree's root (absolute). */
  root: string;
  branch: ScmBranch;
  changes: ScmChange[];
}

/** One hunk of a unified diff. */
export interface DiffHunk {
  /** The `@@ -a,b +c,d @@ …` line as git printed it. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Its lines, each with its prefix (` `, `+`, `-`, or `\` for "No newline at end of file"). */
  lines: string[];
}

/** One file of a unified diff. */
export interface DiffFile {
  /** `null` for a created file. */
  oldPath: string | null;
  /** `null` for a deleted file. */
  newPath: string | null;
  /** The lines before the first hunk (`diff --git`, `index`, modes, `---`, `+++`). */
  header: string[];
  /** Git said "Binary files … differ": no hunks to show. */
  binary: boolean;
  hunks: DiffHunk[];
}

/** One commit of the history (`git log`). */
export interface ScmCommit {
  oid: string;
  parents: string[];
  author: string;
  /** Author date, in seconds since the epoch. */
  time: number;
  /** Its ref names (`HEAD -> main`, `origin/main`, `tag: v1`), as `%D` lists them. */
  refs: string[];
  subject: string;
}

/** A file a commit changed (`--name-status`). */
export interface CommitFile {
  path: string;
  origPath?: string;
  letter: ScmLetter;
}

/** A local or remote-tracking branch (`git for-each-ref`). */
export interface ScmRef {
  /** `main`, or `origin/main` for a remote one. */
  name: string;
  remote: boolean;
  /** Its short commit id. */
  oid: string;
  /** Its upstream (`origin/main`), for a local branch that has one. */
  upstream?: string;
  /** It is checked out here. */
  current: boolean;
}

/** One stash entry (`git stash list`). */
export interface ScmStash {
  /** `stash@{0}`: only valid until the stack changes; actions check `oid` first. */
  ref: string;
  oid: string;
  /** `On main: message`. */
  subject: string;
  /** Seconds since the epoch. */
  time: number;
}

/** One worktree (`git worktree list --porcelain`). */
export interface ScmWorktree {
  path: string;
  /** Its HEAD commit (absent for a bare repository). */
  head?: string;
  /** Its branch (`main`), absent when detached or bare. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** What a git command answered. `ok` is false when it exited non-zero (`error` says why). */
export interface ScmResult {
  ok: boolean;
  /** Git's own message (its last lines of stderr), on failure. */
  error?: string;
  /** Git asked for credentials: the message says how to set them up. */
  auth?: boolean;
  /** It was cancelled. */
  cancelled?: boolean;
}

/** A long operation's progress line (fetch, pull, push), as an event. */
export interface ScmProgress {
  opId: string;
  /** Git's latest progress line (`Receiving objects:  42% (21/50)`). */
  line: string;
}

/** The repository at `root` changed on disk (its worktree, HEAD, the index, a ref). */
export interface ScmChanged {
  root: string;
}

/** What a commit takes: the message, and which changes. */
export interface CommitRequest {
  root: string;
  message: string;
  /** `staged` commits the index; `all` stages every tracked change first (`commit -a`). */
  mode: "staged" | "all";
  amend?: boolean;
  /** Stage everything, untracked files too, first (the "nothing staged" offer). */
  stageAll?: boolean;
}

/** Which files a stage, unstage or discard takes. */
export interface PathsRequest {
  root: string;
  paths: string[];
}

/** A hunk to stage, unstage or discard, as the patch lib/scm/patch.ts made of it. */
export interface PatchRequest {
  root: string;
  patch: string;
  /** `stage`: apply to the index; `unstage`: apply reversed to the index; `discard`: reversed to the worktree. */
  action: "stage" | "unstage" | "discard";
}

/** A diff to show. */
export interface DiffRequest {
  root: string;
  path: string;
  /** `staged`: HEAD → index; `changes`: index → worktree; `untracked`: the whole new file. */
  kind: "staged" | "changes" | "untracked";
}

/** A long operation: fetch, pull, push, or pull then push (Sync). */
export interface RemoteRequest {
  root: string;
  op: "fetch" | "pull" | "push" | "sync";
  /** The caller's id for it, for progress events and `cancel`. */
  opId: string;
}

/** Removing a worktree: `dirty` when it has uncommitted changes and `force` was not given. */
export interface WorktreeRemoveResult extends ScmResult {
  dirty?: boolean;
}

/** Discarding untracked files: to the Trash when the OS offers one, else deleted on `confirmDelete`. */
export interface DiscardUntrackedResult extends ScmResult {
  /** No Trash was available: nothing was deleted (ask, then call again with `confirmDelete`). */
  needsConfirm?: boolean;
}

/** The Source Control client the tile uses: the desktop extension, or the demo repository. */
export interface ScmClient {
  /** The worktree root of the repository `path` is in, or `null` (not a repository; no git). */
  repoRoot(path: string): Promise<string | null>;
  status(root: string): Promise<ScmStatus>;
  diff(request: DiffRequest): Promise<DiffFile | null>;
  stage(request: PathsRequest): Promise<ScmResult>;
  unstage(request: PathsRequest): Promise<ScmResult>;
  /** Put tracked files back as the index has them (their unstaged changes are lost). */
  discard(request: PathsRequest): Promise<ScmResult>;
  /** Untracked files: to the Trash, or (with `confirmDelete`) deleted. */
  discardUntracked(
    request: PathsRequest & { confirmDelete?: boolean },
  ): Promise<DiscardUntrackedResult>;
  applyPatch(request: PatchRequest): Promise<ScmResult>;
  commit(request: CommitRequest): Promise<ScmResult>;
  /** HEAD's message (for Amend). */
  lastMessage(root: string): Promise<string>;
  branches(root: string): Promise<ScmRef[]>;
  /** Switch to `name` (a remote one gets a tracking branch), or create it (from HEAD) and switch. */
  checkout(
    request: { root: string; name: string; create?: boolean },
  ): Promise<ScmResult>;
  remote(request: RemoteRequest): Promise<ScmResult>;
  cancel(opId: string): Promise<void>;
  log(root: string, limit: number): Promise<ScmCommit[]>;
  commitFiles(root: string, oid: string): Promise<CommitFile[]>;
  commitDiff(root: string, oid: string, path: string): Promise<DiffFile | null>;
  stashes(root: string): Promise<ScmStash[]>;
  stashPush(
    request: { root: string; message: string; untracked?: boolean },
  ): Promise<ScmResult>;
  /** Apply, pop or drop stash `oid`, found at `ref` (refused if `ref` no longer names it). */
  stashAction(
    request: {
      root: string;
      ref: string;
      oid: string;
      action: "apply" | "pop" | "drop";
    },
  ): Promise<ScmResult>;
  worktrees(root: string): Promise<ScmWorktree[]>;
  worktreeAdd(
    request: { root: string; path: string; branch: string; create?: boolean },
  ): Promise<ScmResult>;
  /**
   * `git worktree remove` of the checkout at `path` (never its branch). A checkout with
   * uncommitted changes is refused with `dirty` unless `force` (then `--force`).
   */
  worktreeRemove(
    request: { root: string; path: string; force?: boolean },
  ): Promise<WorktreeRemoveResult>;
  /** Watch `root` (debounced): `onChanged` hears it. Resolves to the unwatch. */
  watch(root: string): Promise<() => void>;
  onChanged(cb: (e: ScmChanged) => void): () => void;
  onProgress(cb: (e: ScmProgress) => void): () => void;
}
