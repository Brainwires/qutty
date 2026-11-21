// Source Control, the desktop side: a desktop extension (`scm`) beside `links` and `skins` that
// runs git for the Source Control tile (app/scm-tile.tsx).
//
// How git runs: like every program Qutty starts (desktop/links.ts, desktop/ollama.ts), in a hidden
// PTY of its own `PtyHost`, as an argv (no shell parses anything the page sent). A small
// `/bin/sh` wrapper (lib/scm/run.ts) keeps git's stdout byte-exact (to a file, then base64
// through the terminal) and its stderr on the terminal, where git reports progress. Nothing here
// needs a Deno permission the app does not already have: the PTY path has `run`, and the file
// watch reads.
//
// - Reads: status (porcelain v2), diffs, branches, the log, a commit's files and diffs, stashes,
//   worktrees. Writes: stage, unstage, discard (untracked files to the Trash where there is one),
//   apply a hunk's patch, commit, switch or create a branch, stash push / apply / pop / drop,
//   worktree add, fetch / pull / push / sync. Writes on one repository run one at a time.
// - Long operations (fetch, pull, push, sync) stream git's progress line as `progress` events and
//   stop on `cancel`. Credentials are git's: its credential helpers and ssh-agent work, and a
//   question nobody can answer (a passphrase, a password) ends the run with a clear message.
// - `watch`: `Deno.watchFs` on the worktree and its git folder (HEAD, the index, refs), debounced,
//   as `changed` events. A window's watches end when its page reloads.
//
// Every git failure comes back as `{ ok: false, error }` (git's own message), not as a thrown
// error, so the tile can show it.

import { defineDesktopExtension, DesktopCapError } from "denext/desktop";
import {
  asValidation,
  type Issue,
  objectSchema,
  optBool,
  optInt,
  str,
  strList,
} from "./schema.ts";
import {
  type PtyDataEvent,
  type PtyExitEvent,
  PtyHost,
  resolveProgram,
} from "./pty.ts";
import {
  AUTH_HINT,
  authFailure,
  authPrompt,
  errorMessage,
  parseWrapped,
  progressLine,
  wrapperArgs,
} from "../lib/scm/run.ts";
import {
  LOG_FORMAT,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseStatus,
  parseWorktrees,
  REF_FORMAT,
  STASH_FORMAT,
} from "../lib/scm/parse.ts";
import type {
  CommitFile,
  CommitRequest,
  DiffFile,
  DiffRequest,
  DiscardUntrackedResult,
  PatchRequest,
  PathsRequest,
  RemoteRequest,
  ScmChanged,
  ScmCommit,
  ScmProgress,
  ScmRef,
  ScmResult,
  ScmStash,
  ScmStatus,
  ScmWorktree,
  WorktreeRemoveResult,
} from "../lib/scm/types.ts";

const MAX_PATH = 4096;
const MAX_PATHS = 2000;
/** The biggest patch or message the wrapper passes as an argument (well under `ARG_MAX`). */
const MAX_TEXT = 256 * 1024;
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MS = 15 * 60_000;
const WATCH_DEBOUNCE_MS = 400;

/** One finished run: git's exit code, its output, and why it ended early. */
export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
  /** Killed by `cancel` (or a timeout). */
  cancelled: boolean;
  /** Ended because it asked for credentials. */
  auth: boolean;
}

/** Options for one run. */
export interface RunOptions {
  stdin?: string;
  timeoutMs?: number;
  /** An id `cancel` can stop it by. */
  opId?: string;
  /** The terminal's text so far, at each output (progress). */
  onOutput?: (text: string) => void;
}

/** Runs a program in a folder (the PTY wrapper; tests may use the same one). */
export interface ProgramRunner {
  run(
    cwd: string,
    program: string,
    args: readonly string[],
    opts?: RunOptions,
  ): Promise<GitRun>;
  cancel(opId: string): void;
}

interface LiveRun {
  text: string;
  /** It asked for credentials (and was ended). */
  asked?: boolean;
  onOutput?: (text: string) => void;
  exit?: PtyExitEvent;
  finish?: (exit: PtyExitEvent) => void;
}

/** Programs in hidden PTYs under the lib/scm/run.ts wrapper. */
export class PtyProgramRunner implements ProgramRunner {
  #host: PtyHost;
  #live = new Map<string, LiveRun>();
  #ops = new Map<string, string>();
  #cancelled = new Set<string>();

  constructor() {
    this.#host = new PtyHost((event, data) => {
      const id = (data as { id: string }).id;
      let live = this.#live.get(id);
      if (!live) this.#live.set(id, live = { text: "" });
      if (event === "data") {
        live.text += (data as PtyDataEvent).data;
        live.onOutput?.(live.text);
        // A question nobody can answer (a passphrase, a password): end the run now.
        if (!live.asked && authPrompt(live.text)) {
          live.asked = true;
          this.#host.kill(id);
        }
      } else {
        live.exit = data as PtyExitEvent;
        live.finish?.(live.exit);
      }
    });
  }

  async run(
    cwd: string,
    program: string,
    args: readonly string[],
    opts: RunOptions = {},
  ): Promise<GitRun> {
    const { id } = await this.#host.spawn(
      {
        cols: 200,
        rows: 24,
        program: "/bin/sh",
        args: wrapperArgs(program, args, opts.stdin),
        cwd,
      },
      { owner: "scm" },
    );
    if (opts.opId) this.#ops.set(opts.opId, id);
    let live = this.#live.get(id);
    if (!live) this.#live.set(id, live = { text: "" });
    live.onOutput = opts.onOutput;
    const current = live;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await new Promise<PtyExitEvent>((resolve) => {
      if (current.exit) return resolve(current.exit);
      current.finish = resolve;
      timer = setTimeout(() => {
        this.#cancelled.add(id);
        this.#host.kill(id);
      }, opts.timeoutMs ?? READ_TIMEOUT_MS);
    });
    clearTimeout(timer);
    this.#live.delete(id);
    if (opts.opId) this.#ops.delete(opts.opId);
    const cancelled = this.#cancelled.delete(id);
    const out = parseWrapped(current.text);
    const auth = current.asked === true;
    const code = exit.signal ? 128 + exit.signal : exit.exitCode;
    return {
      code: out.complete ? code : code || 1,
      stdout: out.stdout,
      stderr: out.stderr,
      cancelled: cancelled && !auth,
      auth,
    };
  }

  cancel(opId: string): void {
    const id = this.#ops.get(opId);
    if (!id) return;
    this.#cancelled.add(id);
    this.#host.kill(id);
  }
}

/** A path inside the repository: relative, no `..` step out, no option look-alike. */
function safeRel(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.startsWith("-") &&
    !path.split("/").includes("..");
}

const OID = /^[0-9a-f]{4,64}$/;

/** A failed result from a run. */
function failure(r: GitRun): ScmResult {
  if (r.auth || authFailure(r.stderr)) {
    return { ok: false, auth: true, error: AUTH_HINT };
  }
  if (r.cancelled) return { ok: false, cancelled: true, error: "Cancelled." };
  return { ok: false, error: errorMessage(r.stderr, r.code) };
}

const result = (r: GitRun): ScmResult =>
  r.code === 0 ? { ok: true } : failure(r);

/** Options for {@linkcode ScmService}. */
export interface ScmServiceOptions {
  runner: ProgramRunner;
  /** Look a program up (default: desktop/pty.ts `resolveProgram`). */
  find?: (name: string) => Promise<string | undefined>;
  /** Where `progress` and `changed` events go. */
  emit?: (
    event: "progress" | "changed",
    data: ScmProgress | ScmChanged,
  ) => void;
  /** The OS (default: this one): which Trash command there is. */
  os?: string;
}

interface Watch {
  owner: string;
  close(): void;
}

/** The Source Control service (exported for tests, which run real git in temp repositories). */
export class ScmService {
  #runner: ProgramRunner;
  #find: (name: string) => Promise<string | undefined>;
  #emit: NonNullable<ScmServiceOptions["emit"]>;
  #os: string;
  #git: Promise<string | undefined> | undefined;
  #queues = new Map<string, Promise<unknown>>();
  #watches = new Map<string, Watch>();
  #nextWatch = 0;

  constructor(opts: ScmServiceOptions) {
    this.#runner = opts.runner;
    this.#find = opts.find ?? resolveProgram;
    this.#emit = opts.emit ?? (() => {});
    this.#os = opts.os ?? Deno.build.os;
  }

  setEmit(emit: NonNullable<ScmServiceOptions["emit"]>): void {
    this.#emit = emit;
  }

  async #gitPath(): Promise<string> {
    const found = await (this.#git ??= this.#find("git"));
    if (!found) {
      this.#git = undefined;
      throw new Error("git is not installed");
    }
    return found;
  }

  /** Run git in `root`. */
  async git(
    root: string,
    args: readonly string[],
    opts: RunOptions = {},
  ): Promise<GitRun> {
    if (opts.stdin && opts.stdin.length > MAX_TEXT) {
      throw new Error("the change is too big to apply from here");
    }
    return await this.#runner.run(root, await this.#gitPath(), args, {
      timeoutMs: READ_TIMEOUT_MS,
      ...opts,
    });
  }

  /** git's stdout, or a thrown error with its message. */
  async #read(root: string, args: readonly string[]): Promise<string> {
    const r = await this.git(root, args);
    if (r.code !== 0) throw new Error(failure(r).error);
    return r.stdout;
  }

  /** Writes to one repository, one at a time. */
  #serial<T>(root: string, work: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(root) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => {});
    this.#queues.set(root, tail);
    void tail.then(() => {
      if (this.#queues.get(root) === tail) this.#queues.delete(root);
    });
    return next;
  }

  #write(
    root: string,
    args: readonly string[],
    opts: RunOptions = {},
  ): Promise<ScmResult> {
    return this.#serial(
      root,
      async () =>
        result(
          await this.git(root, args, { timeoutMs: WRITE_TIMEOUT_MS, ...opts }),
        ),
    );
  }

  async repoRoot(path: string): Promise<string | null> {
    let dir = path;
    try {
      const s = await Deno.stat(path);
      if (!s.isDirectory) dir = path.slice(0, path.lastIndexOf("/")) || "/";
    } catch {
      return null;
    }
    const r = await this.git(dir, ["rev-parse", "--show-toplevel"]);
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  }

  async status(root: string): Promise<ScmStatus> {
    const out = await this.#read(root, [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
    ]);
    return parseStatus(root, out);
  }

  async diff(req: DiffRequest): Promise<DiffFile | null> {
    if (!safeRel(req.path)) throw new Error("not a path in the repository");
    const base = ["diff", "--no-color", "--no-ext-diff"];
    const args = req.kind === "staged"
      ? [...base, "--cached", "-M", "--", req.path]
      : req.kind === "changes"
      ? [...base, "--", req.path]
      : [...base, "--no-index", "--", "/dev/null", req.path];
    const r = await this.git(req.root, args);
    // `--no-index` exits 1 when the files differ, which they always do.
    if (r.code !== 0 && !(req.kind === "untracked" && r.code === 1)) {
      throw new Error(failure(r).error);
    }
    return parseDiff(r.stdout)[0] ?? null;
  }

  stage(req: PathsRequest): Promise<ScmResult> {
    return this.#paths(req, ["add", "-A", "--"]);
  }

  unstage(req: PathsRequest): Promise<ScmResult> {
    // A path reset: the index entry goes back to HEAD's (works before the first commit too).
    return this.#paths(req, ["reset", "-q", "--"]);
  }

  discard(req: PathsRequest): Promise<ScmResult> {
    return this.#paths(req, ["restore", "--worktree", "--"]);
  }

  #paths(req: PathsRequest, args: string[]): Promise<ScmResult> {
    if (req.paths.length === 0) return Promise.resolve({ ok: true });
    if (!req.paths.every(safeRel)) {
      return Promise.resolve({
        ok: false,
        error: "not a path in the repository",
      });
    }
    return this.#write(req.root, [...args, ...req.paths]);
  }

  /** The Trash command of this OS, if there is one: macOS 15's `trash`, else GLib's `gio trash`. */
  async #trash(): Promise<string[] | null> {
    const trash = await this.#find("trash");
    if (trash) return [trash];
    if (this.#os === "linux") {
      const gio = await this.#find("gio");
      if (gio) return [gio, "trash"];
    }
    return null;
  }

  async discardUntracked(
    req: PathsRequest & { confirmDelete?: boolean },
  ): Promise<DiscardUntrackedResult> {
    if (!req.paths.every(safeRel)) {
      return { ok: false, error: "not a path in the repository" };
    }
    if (req.confirmDelete) {
      return await this.#write(req.root, [
        "clean",
        "-f",
        "-q",
        "--",
        ...req.paths,
      ]);
    }
    const trash = await this.#trash();
    if (!trash) return { ok: false, needsConfirm: true };
    const [program, ...pre] = trash;
    const abs = req.paths.map((p) => `${req.root}/${p}`);
    return await this.#serial(req.root, async () =>
      result(
        await this.#runner.run(req.root, program, [...pre, ...abs], {
          timeoutMs: WRITE_TIMEOUT_MS,
        }),
      ));
  }

  applyPatch(req: PatchRequest): Promise<ScmResult> {
    const how = req.action === "stage"
      ? ["--cached"]
      : req.action === "unstage"
      ? ["--cached", "--reverse"]
      : ["--reverse"];
    return this.#write(
      req.root,
      ["apply", ...how, "--whitespace=nowarn", "-"],
      { stdin: req.patch },
    );
  }

  commit(req: CommitRequest): Promise<ScmResult> {
    if (!req.message.trim()) {
      return Promise.resolve({
        ok: false,
        error: "The commit message is empty.",
      });
    }
    return this.#serial(req.root, async () => {
      if (req.stageAll) {
        const add = await this.git(req.root, ["add", "-A"], {
          timeoutMs: WRITE_TIMEOUT_MS,
        });
        if (add.code !== 0) return failure(add);
      }
      const args = ["commit", "-q", "-m", req.message];
      if (req.mode === "all") args.push("-a");
      if (req.amend) args.push("--amend");
      return result(
        await this.git(req.root, args, { timeoutMs: WRITE_TIMEOUT_MS }),
      );
    });
  }

  async lastMessage(root: string): Promise<string> {
    const r = await this.git(root, ["log", "-1", "--format=%B"]);
    return r.code === 0 ? r.stdout.replace(/\n+$/, "") : "";
  }

  async branches(root: string): Promise<ScmRef[]> {
    return parseRefs(
      await this.#read(root, [
        "for-each-ref",
        `--format=${REF_FORMAT}`,
        "refs/heads",
        "refs/remotes",
      ]),
    );
  }

  async checkout(
    req: { root: string; name: string; create?: boolean },
  ): Promise<ScmResult> {
    const check = await this.git(req.root, [
      "check-ref-format",
      "--branch",
      req.name,
    ]);
    if (check.code !== 0 || req.name.startsWith("-")) {
      return { ok: false, error: `"${req.name}" is not a valid branch name.` };
    }
    if (req.create) {
      return await this.#write(req.root, ["switch", "-c", req.name]);
    }
    const refs = await this.branches(req.root);
    const local = refs.some((r) => !r.remote && r.name === req.name);
    if (local) return await this.#write(req.root, ["switch", req.name]);
    if (refs.some((r) => r.remote && r.name === req.name)) {
      // A remote branch: its local twin, created to track it unless it is there already.
      const short = req.name.slice(req.name.indexOf("/") + 1);
      return refs.some((r) => !r.remote && r.name === short)
        ? await this.#write(req.root, ["switch", short])
        : await this.#write(req.root, ["switch", "--track", req.name]);
    }
    return { ok: false, error: `There is no branch "${req.name}".` };
  }

  /** The args of a push: plain with an upstream, else publishing to `origin` (or the only remote). */
  async #pushArgs(root: string): Promise<string[] | ScmResult> {
    const status = await this.status(root);
    if (status.branch.upstream) return ["push", "--progress"];
    if (!status.branch.head) {
      return {
        ok: false,
        error: "HEAD is detached: there is no branch to push.",
      };
    }
    const remotes = (await this.#read(root, ["remote"])).split("\n").filter(
      Boolean,
    );
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) return { ok: false, error: "This repository has no remote." };
    return ["push", "--progress", "-u", remote, "HEAD"];
  }

  remote(req: RemoteRequest): Promise<ScmResult> {
    const run = async (args: string[]): Promise<ScmResult> =>
      result(
        await this.git(req.root, args, {
          timeoutMs: REMOTE_TIMEOUT_MS,
          opId: req.opId,
          onOutput: (text) => {
            const line = progressLine(text);
            if (line) this.#emit("progress", { opId: req.opId, line });
          },
        }),
      );
    return this.#serial(req.root, async () => {
      if (req.op === "fetch") {
        return await run(["fetch", "--progress", "--prune"]);
      }
      if (req.op === "pull" || req.op === "sync") {
        const pulled = await run(["pull", "--progress"]);
        if (!pulled.ok || req.op === "pull") return pulled;
      }
      const push = await this.#pushArgs(req.root);
      return Array.isArray(push) ? await run(push) : push;
    });
  }

  cancel(opId: string): void {
    this.#runner.cancel(opId);
  }

  async log(root: string, limit: number): Promise<ScmCommit[]> {
    const r = await this.git(root, [
      "log",
      "-z",
      "--topo-order",
      `--format=${LOG_FORMAT}`,
      "-n",
      String(limit),
    ]);
    // A repository with no commit yet has no log.
    return r.code === 0 ? parseLog(r.stdout) : [];
  }

  async commitFiles(root: string, oid: string): Promise<CommitFile[]> {
    if (!OID.test(oid)) throw new Error("not a commit id");
    return parseNameStatus(
      await this.#read(root, [
        "diff-tree",
        "-r",
        "-z",
        "--no-commit-id",
        "--name-status",
        "-M",
        "--root",
        "-m",
        "--first-parent",
        oid,
      ]),
    );
  }

  async commitDiff(
    root: string,
    oid: string,
    path: string,
  ): Promise<DiffFile | null> {
    if (!OID.test(oid)) throw new Error("not a commit id");
    if (!safeRel(path)) throw new Error("not a path in the repository");
    const out = await this.#read(root, [
      "show",
      "--no-color",
      "--no-ext-diff",
      "--format=",
      "-M",
      "-m",
      "--first-parent",
      oid,
      "--",
      path,
    ]);
    return parseDiff(out)[0] ?? null;
  }

  async stashes(root: string): Promise<ScmStash[]> {
    const r = await this.git(root, [
      "stash",
      "list",
      "-z",
      `--format=${STASH_FORMAT}`,
    ]);
    return r.code === 0 ? parseStashes(r.stdout) : [];
  }

  stashPush(
    req: { root: string; message: string; untracked?: boolean },
  ): Promise<ScmResult> {
    const message = req.message.trim() || "Stashed from Qutty";
    const args = ["stash", "push", "-m", message];
    if (req.untracked) args.push("--include-untracked");
    return this.#write(req.root, args);
  }

  stashAction(
    req: {
      root: string;
      ref: string;
      oid: string;
      action: "apply" | "pop" | "drop";
    },
  ): Promise<ScmResult> {
    return this.#serial(req.root, async () => {
      // The stash stack is shared with every other checkout of the repository: act only when
      // `ref` still names the entry the tile showed.
      const at = await this.git(req.root, [
        "rev-parse",
        "-q",
        "--verify",
        req.ref,
      ]);
      if (at.code !== 0 || at.stdout.trim() !== req.oid) {
        return {
          ok: false,
          error:
            "The stash list changed since it was shown. Refresh and try again.",
        };
      }
      return result(
        await this.git(req.root, ["stash", req.action, "-q", req.ref], {
          timeoutMs: WRITE_TIMEOUT_MS,
        }),
      );
    });
  }

  async worktrees(root: string): Promise<ScmWorktree[]> {
    return parseWorktrees(
      await this.#read(root, ["worktree", "list", "--porcelain"]),
    );
  }

  worktreeAdd(
    req: { root: string; path: string; branch: string; create?: boolean },
  ): Promise<ScmResult> {
    if (!req.path.startsWith("/")) {
      return Promise.resolve({
        ok: false,
        error: "The folder must be an absolute path.",
      });
    }
    if (req.branch.startsWith("-")) {
      return Promise.resolve({ ok: false, error: "Not a branch name." });
    }
    return this.#write(
      req.root,
      req.create
        ? ["worktree", "add", "-b", req.branch, req.path]
        : ["worktree", "add", req.path, req.branch],
    );
  }

  /**
   * `git worktree remove` (the branch stays). A checkout with changes is refused (`dirty`) unless
   * `force`, which the tile asks about first.
   */
  async worktreeRemove(
    req: { root: string; path: string; force?: boolean },
  ): Promise<WorktreeRemoveResult> {
    if (!req.path.startsWith("/")) {
      return { ok: false, error: "The folder must be an absolute path." };
    }
    if (!req.force) {
      const st = await this.git(req.path, ["status", "--porcelain"]);
      if (st.code === 0 && st.stdout.trim() !== "") {
        return {
          ok: false,
          dirty: true,
          error: "The worktree has uncommitted changes.",
        };
      }
    }
    return await this.#write(req.root, [
      "worktree",
      "remove",
      ...(req.force ? ["--force"] : []),
      req.path,
    ]);
  }

  /** Watch `root` and its git folder for `owner`; resolves to the watch's id. */
  async watch(root: string, owner: string): Promise<string> {
    const gitDir = (await this.git(root, ["rev-parse", "--absolute-git-dir"]))
      .stdout.trim();
    const commonDir = (await this.git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).stdout.trim();
    const dirs = [
      ...new Set([root, gitDir, commonDir].filter((d) => d.startsWith("/"))),
    ];
    const watchers: Deno.FsWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => this.#emit("changed", { root }),
        WATCH_DEBOUNCE_MS,
      );
    };
    for (const dir of dirs) {
      try {
        const w = Deno.watchFs(dir, { recursive: true });
        watchers.push(w);
        void (async () => {
          for await (const e of w) {
            if (e.paths.some((p) => watchedPath(p, gitDir, commonDir))) fire();
          }
        })().catch(() => {});
      } catch (err) {
        console.warn(`scm: cannot watch ${dir}`, err);
      }
    }
    const id = `w${++this.#nextWatch}`;
    this.#watches.set(id, {
      owner,
      close: () => {
        clearTimeout(timer);
        for (const w of watchers) {
          try {
            w.close();
          } catch { /* closed already */ }
        }
      },
    });
    return id;
  }

  unwatch(id: string): void {
    this.#watches.get(id)?.close();
    this.#watches.delete(id);
  }

  /** End every watch of `owner` (its page reloaded). */
  unwatchOwnedBy(owner: string): void {
    for (const [id, w] of this.#watches) {
      if (w.owner === owner) this.unwatch(id);
    }
  }
}

/**
 * Whether a change at `path` matters: anything in the worktree outside the git folder, and in the
 * git folder only HEAD, the index, refs and the merge / rebase state (not objects, logs, locks).
 */
export function watchedPath(
  path: string,
  gitDir: string,
  commonDir: string,
): boolean {
  for (const dir of [gitDir, commonDir]) {
    if (!dir || (path !== dir && !path.startsWith(`${dir}/`))) continue;
    const rel = path.slice(dir.length + 1);
    if (rel.endsWith(".lock")) return false;
    return /^(HEAD|index|packed-refs|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD)$/
      .test(rel) || rel.startsWith("refs/") || rel.startsWith("rebase-");
  }
  return !path.split("/").includes(".git");
}

// ---------------------------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------------------------

let service: ScmService | undefined;

type Emit = (event: string, data: unknown) => void;

function getService(ctx: { emit: Emit }): ScmService {
  if (Deno.build.os === "windows") {
    throw new DesktopCapError(
      "unsupported",
      "Source Control is not available on Windows yet",
    );
  }
  const emit = (
    event: "progress" | "changed",
    data: ScmProgress | ScmChanged,
  ) => {
    try {
      ctx.emit(event, data);
    } catch (err) {
      console.error("scm: emit failed", err);
    }
  };
  if (!service) {
    service = new ScmService({ runner: new PtyProgramRunner(), emit });
  } else service.setEmit(emit);
  return service;
}

const rootOf = (v: Record<string, unknown>, issues: Issue[]) => {
  const root = str(v, "root", issues, MAX_PATH);
  if (root && !root.startsWith("/")) {
    issues.push({ message: "root must be absolute", path: ["root"] });
  }
  return root;
};

const rootInput = objectSchema<{ root: string }>((v, issues) => ({
  root: rootOf(v, issues),
}));

const pathInput = objectSchema<{ path: string }>((v, issues) => ({
  path: str(v, "path", issues, MAX_PATH),
}));

const pathsInput = objectSchema<PathsRequest & { confirmDelete?: boolean }>(
  (v, issues) => {
    const confirmDelete = optBool(v, "confirmDelete", issues);
    return {
      root: rootOf(v, issues),
      paths: strList(v, "paths", issues, MAX_PATHS, MAX_PATH),
      ...(confirmDelete ? { confirmDelete } : {}),
    };
  },
);

function oneOf<T extends string>(
  v: Record<string, unknown>,
  key: string,
  values: readonly T[],
  issues: Issue[],
): T {
  const s = v[key];
  if (typeof s === "string" && (values as readonly string[]).includes(s)) {
    return s as T;
  }
  issues.push({
    message: `${key} must be one of ${values.join(", ")}`,
    path: [key],
  });
  return values[0];
}

const diffInput = objectSchema<DiffRequest>((v, issues) => ({
  root: rootOf(v, issues),
  path: str(v, "path", issues, MAX_PATH),
  kind: oneOf(v, "kind", ["staged", "changes", "untracked"] as const, issues),
}));

const patchInput = objectSchema<PatchRequest>((v, issues) => ({
  root: rootOf(v, issues),
  patch: str(v, "patch", issues, MAX_TEXT),
  action: oneOf(v, "action", ["stage", "unstage", "discard"] as const, issues),
}));

const commitInput = objectSchema<CommitRequest>((v, issues) => {
  const amend = optBool(v, "amend", issues);
  const stageAll = optBool(v, "stageAll", issues);
  return {
    root: rootOf(v, issues),
    message: str(v, "message", issues, MAX_TEXT),
    mode: oneOf(v, "mode", ["staged", "all"] as const, issues),
    ...(amend ? { amend } : {}),
    ...(stageAll ? { stageAll } : {}),
  };
});

const checkoutInput = objectSchema<
  { root: string; name: string; create?: boolean }
>(
  (v, issues) => {
    const create = optBool(v, "create", issues);
    return {
      root: rootOf(v, issues),
      name: str(v, "name", issues, 255),
      ...(create ? { create } : {}),
    };
  },
);

const remoteInput = objectSchema<RemoteRequest>((v, issues) => ({
  root: rootOf(v, issues),
  op: oneOf(v, "op", ["fetch", "pull", "push", "sync"] as const, issues),
  opId: str(v, "opId", issues, 64),
}));

const opInput = objectSchema<{ opId: string }>((v, issues) => ({
  opId: str(v, "opId", issues, 64),
}));

const logInput = objectSchema<{ root: string; limit: number }>((v, issues) => ({
  root: rootOf(v, issues),
  limit: optInt(v, "limit", issues, 1, 2000) ?? 200,
}));

const commitIdInput = objectSchema<
  { root: string; oid: string; path?: string }
>(
  (v, issues) => {
    const path = v.path === undefined
      ? undefined
      : str(v, "path", issues, MAX_PATH);
    return {
      root: rootOf(v, issues),
      oid: str(v, "oid", issues, 64),
      ...(path !== undefined ? { path } : {}),
    };
  },
);

const stashPushInput = objectSchema<
  { root: string; message: string; untracked?: boolean }
>(
  (v, issues) => {
    const untracked = optBool(v, "untracked", issues);
    const message = v.message === "" ? "" : str(v, "message", issues, 1000);
    return {
      root: rootOf(v, issues),
      message,
      ...(untracked ? { untracked } : {}),
    };
  },
);

const stashActionInput = objectSchema<
  { root: string; ref: string; oid: string; action: "apply" | "pop" | "drop" }
>((v, issues) => {
  const ref = str(v, "ref", issues, 32);
  if (ref && !/^stash@\{\d+\}$/.test(ref)) {
    issues.push({ message: "ref must be stash@{n}", path: ["ref"] });
  }
  return {
    root: rootOf(v, issues),
    ref,
    oid: str(v, "oid", issues, 64),
    action: oneOf(v, "action", ["apply", "pop", "drop"] as const, issues),
  };
});

const worktreeInput = objectSchema<
  { root: string; path: string; branch: string; create?: boolean }
>((v, issues) => {
  const create = optBool(v, "create", issues);
  return {
    root: rootOf(v, issues),
    path: str(v, "path", issues, MAX_PATH),
    branch: str(v, "branch", issues, 255),
    ...(create ? { create } : {}),
  };
});

const worktreeRemoveInput = objectSchema<
  { root: string; path: string; force?: boolean }
>((v, issues) => {
  const force = optBool(v, "force", issues);
  return {
    root: rootOf(v, issues),
    path: str(v, "path", issues, MAX_PATH),
    ...(force ? { force } : {}),
  };
});

const watchIdInput = objectSchema<{ id: string }>((v, issues) => ({
  id: str(v, "id", issues, 32),
}));

type Ctx = { emit: Emit; windowId?: string };

/** A method: a thrown error (a failed read) reaches the page with git's message. */
const call =
  <A, R>(fn: (s: ScmService, a: A, ctx: Ctx) => Promise<R>) =>
  (args: unknown, ctx: Ctx): Promise<R> =>
    asValidation(() => fn(getService(ctx), args as A, ctx));

export default defineDesktopExtension({
  name: "scm",
  events: ["progress", "changed"],
  perWindow: true,
  onPageLoad: (windowId?: string) => {
    service?.unwatchOwnedBy(windowId ?? "main");
  },
  methods: {
    repoRoot: {
      input: pathInput,
      handler: call((s, a: { path: string }) => s.repoRoot(a.path)),
    },
    status: {
      input: rootInput,
      handler: call((s, a: { root: string }) => s.status(a.root)),
    },
    diff: { input: diffInput, handler: call((s, a: DiffRequest) => s.diff(a)) },
    stage: {
      input: pathsInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((s, a: PathsRequest) => s.stage(a)),
    },
    unstage: {
      input: pathsInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((s, a: PathsRequest) => s.unstage(a)),
    },
    discard: {
      input: pathsInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((s, a: PathsRequest) => s.discard(a)),
    },
    discardUntracked: {
      input: pathsInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((s, a: PathsRequest & { confirmDelete?: boolean }) =>
        s.discardUntracked(a)
      ),
    },
    applyPatch: {
      input: patchInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((s, a: PatchRequest) => s.applyPatch(a)),
    },
    commit: {
      input: commitInput,
      timeoutMs: WRITE_TIMEOUT_MS * 2,
      handler: call((s, a: CommitRequest) => s.commit(a)),
    },
    lastMessage: {
      input: rootInput,
      handler: call((s, a: { root: string }) => s.lastMessage(a.root)),
    },
    branches: {
      input: rootInput,
      handler: call((s, a: { root: string }) => s.branches(a.root)),
    },
    checkout: {
      input: checkoutInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((s, a: { root: string; name: string; create?: boolean }) =>
        s.checkout(a)
      ),
    },
    remote: {
      input: remoteInput,
      timeoutMs: REMOTE_TIMEOUT_MS * 2 + 5_000,
      handler: call((s, a: RemoteRequest) => s.remote(a)),
    },
    cancel: {
      input: opInput,
      handler: (args: unknown, ctx: Ctx): void =>
        getService(ctx).cancel((args as { opId: string }).opId),
    },
    log: {
      input: logInput,
      handler: call((s, a: { root: string; limit: number }) =>
        s.log(a.root, a.limit)
      ),
    },
    commitFiles: {
      input: commitIdInput,
      handler: call((s, a: { root: string; oid: string }) =>
        s.commitFiles(a.root, a.oid)
      ),
    },
    commitDiff: {
      input: commitIdInput,
      handler: call((s, a: { root: string; oid: string; path?: string }) =>
        s.commitDiff(a.root, a.oid, a.path ?? "")
      ),
    },
    stashes: {
      input: rootInput,
      handler: call((s, a: { root: string }) => s.stashes(a.root)),
    },
    stashPush: {
      input: stashPushInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((
        s,
        a: { root: string; message: string; untracked?: boolean },
      ) => s.stashPush(a)),
    },
    stashAction: {
      input: stashActionInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((
        s,
        a: {
          root: string;
          ref: string;
          oid: string;
          action: "apply" | "pop" | "drop";
        },
      ) => s.stashAction(a)),
    },
    worktrees: {
      input: rootInput,
      handler: call((s, a: { root: string }) => s.worktrees(a.root)),
    },
    worktreeAdd: {
      input: worktreeInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((
        s,
        a: { root: string; path: string; branch: string; create?: boolean },
      ) => s.worktreeAdd(a)),
    },
    worktreeRemove: {
      input: worktreeRemoveInput,
      timeoutMs: WRITE_TIMEOUT_MS,
      handler: call((
        s,
        a: { root: string; path: string; force?: boolean },
      ) => s.worktreeRemove(a)),
    },
    watch: {
      input: rootInput,
      handler: call((s, a: { root: string }, ctx) =>
        s.watch(a.root, ctx.windowId ?? "main")
      ),
    },
    unwatch: {
      input: watchIdInput,
      handler: (args: unknown, ctx: Ctx): void =>
        getService(ctx).unwatch((args as { id: string }).id),
    },
  },
});
