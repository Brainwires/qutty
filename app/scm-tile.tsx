// The Source Control tile (VS Code's Source Control view, a sensible subset): one repository per
// tile (a worktree counts as one), its root in the entry's `scm` (lib/scm/tile.ts). No PTY: git
// runs in the `scm` desktop extension (desktop/scm.ts), or the demo's in-memory repository.
//
// - Header: the repository's name, the branch picker (switch, with a warning when the tree is
//   dirty; create from HEAD), ahead / behind, Fetch / Pull / Push / Sync (progress and Cancel
//   while one runs), Refresh, "Follow focused terminal" and Change Repository.
// - Commit box: the message (⌘↩ / Ctrl+Enter in the box commits: the box takes that key from
//   the workspace's Maximize Tile while it has the keyboard, nowhere else), Commit, and a menu
//   with Commit Staged, Commit All and Amend. With nothing staged, Commit offers to stage
//   everything and commit (VS Code's smart commit).
// - Change groups: Merge Changes, Staged Changes, Changes, Untracked. A row shows its letter and
//   path, and on hover Open File, Reveal, Stage / Unstage and Discard (asks; untracked files go to
//   the Trash where there is one, else a delete is confirmed). Each group has Stage All / Unstage
//   All / Discard All. A row an agent tile in this repository changed (and nobody reviewed yet)
//   wears an "agent" badge.
// - A row's click shows its diff in the tile (app/scm-diff.tsx), with hunk staging.
// - History, Stashes and Worktrees below (app/scm-history.tsx).
//
// Data and refreshes: app/use-scm.ts (file watch, focus, own actions, agents' turns; no timer).

import { type ReactNode, useEffect, useRef, useState } from "denext";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import type { KeyPlatform } from "../lib/workspace/keys.ts";
import {
  changeKey,
  changePaths,
  commitPlan,
  GROUPS,
  LETTER_NAMES,
  repoName,
  type ScmTile,
} from "../lib/scm/tile.ts";
import { hunkPatch } from "../lib/scm/patch.ts";
import type {
  CommitFile,
  DiffFile,
  ScmChange,
  ScmClient,
  ScmGroup,
  ScmStash,
} from "../lib/scm/types.ts";
import { type ScmView, useScm } from "./use-scm.ts";
import type { WorktreeMark } from "../lib/scm/worktrees.ts";
import { type DiffTarget, DiffView, type HunkAction } from "./scm-diff.tsx";
import {
  HistoryList,
  Section,
  StashForm,
  StashList,
  WorktreeForm,
  WorktreeList,
} from "./scm-history.tsx";

/** What Source Control tiles are drawn with (the workspace's). */
export interface ScmTileHooks {
  client: ScmClient;
  platform: KeyPlatform;
  /** Change the tile's repository or its follow setting. */
  setTile(id: string, patch: Partial<ScmTile>): void;
  /** The repository of the terminal focused last (for "Follow focused terminal"). */
  followRoot: string | null;
  /** Bumped when an agent's turn ends: refresh. */
  tick: number;
  /** The folders of the open terminals (Change Repository suggests their repositories). */
  terminalFolders(): Promise<string[]>;
  /** Paths (relative to `root`) agent tiles in `root` changed and nobody reviewed yet. */
  agentPaths(root: string): ReadonlySet<string>;
  /** Open a file in the editor (Settings → Links); absent: no editor. */
  openFile?: (path: string) => void;
  /** Show a file or folder in Finder / the file manager. */
  reveal(path: string): void;
  /** A terminal in `cwd`, beside this tile. */
  openTerminal(cwd: string): void;
  /** A Source Control tile for `root`, beside this one. */
  openScm(root: string): void;
  /** Open a worktree as a workspace of its own (a new window with a terminal in it). */
  openWorktree(mark: WorktreeMark): void;
  /** Settings → Source Control → Worktree folder (empty: beside the repository). */
  worktreeFolder: string;
}

/** Give Source Control tile `id` the keyboard: its commit box (unless it has it already). */
export function focusScmTile(id: string): void {
  const tile = document.querySelector(`[data-testid=tile][data-id="${id}"]`);
  if (!tile || tile.contains(document.activeElement)) return;
  tile.querySelector<HTMLElement>("[data-commit-box], [data-scm-focus]")?.focus(
    {
      preventScroll: true,
    },
  );
}

/** A question the tile asks before a destructive or surprising action. */
interface Confirm {
  text: ReactNode;
  label: string;
  danger?: boolean;
  run(): void;
}

export function ScmBody(props: {
  entry: TerminalEntry;
  hooks: ScmTileHooks;
  focused: boolean;
}) {
  const { entry, hooks } = props;
  const tile = entry.scm ?? { root: null };
  const root = tile.root;
  const view = useScm({
    client: hooks.client,
    root,
    focused: props.focused,
    tick: hooks.tick,
  });
  const [choosing, setChoosing] = useState(false);

  // Follow the focused terminal's repository.
  useEffect(() => {
    if (tile.follow && hooks.followRoot && hooks.followRoot !== root) {
      hooks.setTile(entry.id, { root: hooks.followRoot });
    }
  }, [tile.follow, hooks.followRoot]);

  return (
    <div
      class="scm"
      data-testid="scm"
      data-part="scm-body"
      data-root={root ?? ""}
    >
      {!root || choosing
        ? (
          <Chooser
            hooks={hooks}
            current={root}
            onPick={(r) => {
              setChoosing(false);
              hooks.setTile(entry.id, { root: r, follow: false });
            }}
            {...(root ? { onCancel: () => setChoosing(false) } : {})}
          />
        )
        : (
          <Panel
            id={entry.id}
            root={root}
            follow={tile.follow === true}
            show={tile.show}
            hooks={hooks}
            view={view}
            onChoose={() => setChoosing(true)}
          />
        )}
    </div>
  );
}

/** Pick the repository: a typed folder, or one of the open terminals' repositories. */
function Chooser(props: {
  hooks: ScmTileHooks;
  current: string | null;
  onPick(root: string): void;
  onCancel?: () => void;
}) {
  const { hooks } = props;
  const [path, setPath] = useState(props.current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    let gone = false;
    void hooks.terminalFolders().then(async (dirs) => {
      const roots = await Promise.all(
        dirs.map((d) => hooks.client.repoRoot(d).catch(() => null)),
      );
      if (!gone) setRepos([...new Set(roots.filter((r): r is string => !!r))]);
    });
    return () => void (gone = true);
  }, [hooks]);
  const open = async (p: string) => {
    setError(null);
    const r = await hooks.client.repoRoot(p.trim()).catch(() => null);
    if (r) props.onPick(r);
    else setError(`${p.trim() || "That folder"} is not in a git repository.`);
  };
  return (
    <div class="scm-chooser" data-testid="scm-chooser">
      <div class="scm-chooser-title">Choose a repository</div>
      <form
        class="scm-form"
        onSubmit={(e) => {
          e.preventDefault();
          void open(path);
        }}
      >
        <input
          class="scm-input"
          data-testid="scm-chooser-path"
          data-scm-focus
          placeholder="/path/to/a/folder in a repository"
          value={path}
          onInput={(e) => setPath((e.target as HTMLInputElement).value)}
        />
        <button
          type="submit"
          class="btn-primary scm-btn"
          data-testid="scm-chooser-open"
        >
          Open
        </button>
        {props.onCancel && (
          <button
            type="button"
            class="btn-quiet scm-btn"
            onClick={props.onCancel}
          >
            Cancel
          </button>
        )}
      </form>
      {error && (
        <div class="scm-error" data-testid="scm-chooser-error">{error}</div>
      )}
      {repos.length > 0 && (
        <div class="scm-chooser-list">
          <div class="scm-dim">Repositories of the open terminals</div>
          {repos.map((r) => (
            <button
              type="button"
              class="scm-row"
              data-testid="scm-chooser-repo"
              key={r}
              onClick={() => props.onPick(r)}
            >
              <span class="scm-path">
                <b>{repoName(r)}</b> <span class="scm-dim">{r}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A file's name and its folder, for a row. */
function PathLabel(props: { change: ScmChange }) {
  const { path, origPath } = props.change;
  const slash = path.lastIndexOf("/");
  return (
    <span class="scm-path" title={origPath ? `${origPath} → ${path}` : path}>
      <span class="scm-name">{path.slice(slash + 1)}</span>
      {slash > 0 && <span class="scm-dir">{path.slice(0, slash)}</span>}
      {origPath && <span class="scm-dir">← {origPath}</span>}
    </span>
  );
}

/** What a row of `group` offers: stage, unstage, discard. */
const ROW_ACTIONS: Record<ScmGroup, ("stage" | "unstage" | "discard")[]> = {
  merge: ["stage"],
  staged: ["unstage"],
  changes: ["discard", "stage"],
  untracked: ["discard", "stage"],
};

const ACTION_TEXT = { stage: "Stage", unstage: "Unstage", discard: "Discard" };

function Panel(props: {
  id: string;
  root: string;
  follow: boolean;
  show?: "worktrees";
  hooks: ScmTileHooks;
  view: ScmView;
  onChoose(): void;
}) {
  const { root, hooks, view } = props;
  const { client } = hooks;
  const status = view.data.status;
  const changes = status?.changes ?? [];
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [menu, setMenu] = useState<"commit" | "branch" | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [target, setTarget] = useState<DiffTarget | null>(null);
  const [diff, setDiff] = useState<{ file: DiffFile | null; message?: string }>(
    { file: null },
  );
  const [split, setSplit] = useState(false);
  const [open, setOpen] = useState({
    history: true,
    stashes: false,
    worktrees: false,
  });
  const [openOid, setOpenOid] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[] | null>(null);
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Partial<Record<ScmGroup, boolean>>>({});
  // "New Worktree…" / "Open Worktree…" opened this tile on its worktrees.
  useEffect(() => {
    if (props.show !== "worktrees") return;
    setOpen((o) => ({ ...o, worktrees: true }));
    hooks.setTile(props.id, { show: undefined });
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(
        `[data-testid=tile][data-id="${props.id}"] [data-testid=scm-section-worktrees]`,
      )?.scrollIntoView({ block: "nearest" })
    );
  }, [props.show]);
  const now = Date.now();
  const agent = hooks.agentPaths(root);
  const mainRepo = view.data.worktrees[0]?.path ?? root;
  const removeWorktree = (path: string) => {
    const remove = (force: boolean) =>
      void view.act(async () => {
        const r = await client.worktreeRemove({
          root,
          path,
          ...(force ? { force } : {}),
        });
        if (r.dirty && !force) {
          ask({
            text: (
              <>
                <b>{path}</b>{" "}
                has uncommitted changes. Remove it anyway (--force)? Those
                changes are lost; its branch stays.
              </>
            ),
            label: "Remove Anyway",
            danger: true,
            run: () => remove(true),
          });
          return { ok: true };
        }
        return r;
      });
    ask({
      text: (
        <>
          Remove the worktree at{" "}
          <b>{path}</b>? Its branch stays, and so do its commits.
        </>
      ),
      label: "Remove Worktree",
      danger: true,
      run: () => remove(false),
    });
  };
  const abs = (p: string) => `${root}/${p}`;
  const busy = view.busy || view.op !== null;

  // The diff shown follows the repository: reloaded after every refresh.
  const diffSeq = useRef(0);
  useEffect(() => {
    if (!target) return;
    const seq = ++diffSeq.current;
    const load = target.kind === "commit"
      ? client.commitDiff(root, target.oid!, target.path)
      : client.diff({ root, path: target.path, kind: target.kind });
    load.then(
      (file) => {
        if (seq !== diffSeq.current) return;
        setDiff(
          file
            ? { file }
            : { file: null, message: "No changes in this file now." },
        );
      },
      (e) =>
        seq === diffSeq.current &&
        setDiff({ file: null, message: String(e?.message ?? e) }),
    );
  }, [target, view.data, root, client]);

  // A file that left its group (staged, committed) closes its diff.
  useEffect(() => {
    if (!target || target.kind === "commit" || !status) return;
    if (
      !changes.some((c) => c.path === target.path && c.group === target.kind)
    ) {
      const moved = changes.find((c) =>
        c.path === target.path && c.group !== "merge"
      );
      setTarget(
        moved
          ? { path: moved.path, kind: moved.group as DiffTarget["kind"] }
          : null,
      );
    }
  }, [status]);

  // A commit's files, when one is opened.
  useEffect(() => {
    setCommitFiles(null);
    if (!openOid) return;
    let gone = false;
    client.commitFiles(root, openOid).then(
      (f) => !gone && setCommitFiles(f),
      () => !gone && setCommitFiles([]),
    );
    return () => void (gone = true);
  }, [openOid, root, client]);

  const ask = (c: Confirm) => setConfirm(c);
  const files = (list: ScmChange[]) =>
    list.length === 1 ? list[0].path : `${list.length} files`;

  const stage = (list: ScmChange[]) =>
    void view.act(() => client.stage({ root, paths: changePaths(list) }));
  const unstage = (list: ScmChange[]) =>
    void view.act(() => client.unstage({ root, paths: changePaths(list) }));
  const discardUntracked = (list: ScmChange[]) => {
    const paths = list.map((c) => c.path);
    void view.act(async () => {
      const r = await client.discardUntracked({ root, paths });
      if (r.needsConfirm) {
        ask({
          text: (
            <>
              There is no Trash here. Delete <b>{files(list)}</b>{" "}
              for good? This cannot be undone.
            </>
          ),
          label: "Delete",
          danger: true,
          run: () =>
            void view.act(() =>
              client.discardUntracked({ root, paths, confirmDelete: true })
            ),
        });
        return { ok: true };
      }
      return r;
    });
  };
  const discard = (list: ScmChange[], group: ScmGroup) => {
    if (group === "untracked") {
      ask({
        text: (
          <>
            Move <b>{files(list)}</b> to the Trash?
          </>
        ),
        label: "Move to Trash",
        danger: true,
        run: () => discardUntracked(list),
      });
      return;
    }
    ask({
      text: (
        <>
          Discard the changes in{" "}
          <b>{files(list)}</b>? They cannot be brought back.
        </>
      ),
      label: "Discard",
      danger: true,
      run: () =>
        void view.act(() =>
          client.discard({ root, paths: list.map((c) => c.path) })
        ),
    });
  };
  const rowAction = (a: "stage" | "unstage" | "discard", c: ScmChange) =>
    a === "stage"
      ? stage([c])
      : a === "unstage"
      ? unstage([c])
      : discard([c], c.group);

  const commit = async (mode: "staged" | "all", stageAll = false) => {
    const ok = await view.act(() =>
      client.commit({
        root,
        message,
        mode,
        ...(amend ? { amend: true } : {}),
        ...(stageAll ? { stageAll: true } : {}),
      })
    );
    if (ok) {
      setMessage("");
      setAmend(false);
    }
  };
  const tryCommit = (mode: "staged" | "all") => {
    setMenu(null);
    if (!message.trim()) {
      view.setError("Type a commit message first.");
      return;
    }
    if (amend) return void commit(mode);
    const plan = commitPlan(changes, mode);
    if (plan === "conflicts") {
      view.setError(
        "Resolve the merge conflicts first: stage each resolved file.",
      );
    } else if (plan === "nothing") {
      view.setError("There are no changes to commit.");
    } else if (plan === "stage-all") {
      ask({
        text: (
          <>
            There are no staged changes to commit. Stage all your changes and
            commit them?
          </>
        ),
        label: "Stage All and Commit",
        run: () => void commit(mode, true),
      });
    } else void commit(mode);
  };
  const toggleAmend = async () => {
    setMenu(null);
    const next = !amend;
    setAmend(next);
    if (next && !message.trim()) {
      setMessage(await client.lastMessage(root).catch(() => ""));
    }
  };

  const onHunk = (action: HunkAction, index: number) => {
    const file = diff.file;
    if (!file) return;
    const patch = hunkPatch(file, index, action !== "stage");
    if (!patch) return;
    const run = () =>
      void view.act(() => client.applyPatch({ root, patch, action }));
    if (action !== "discard") return run();
    ask({
      text: (
        <>
          Discard this hunk of <b>{target?.path}</b>?
        </>
      ),
      label: "Discard Hunk",
      danger: true,
      run,
    });
  };

  const branch = status?.branch;
  const dirty = changes.some((c) => c.group !== "untracked");
  const checkout = (name: string, create = false) => {
    setMenu(null);
    setFilter("");
    const go = () =>
      void view.act(() =>
        client.checkout({ root, name, ...(create ? { create: true } : {}) })
      );
    if (!create && dirty) {
      ask({
        text: (
          <>
            You have uncommitted changes. Git carries them to <b>{name}</b>{" "}
            when they do not conflict with it, and refuses to switch when they
            do. Switch anyway?
          </>
        ),
        label: "Switch",
        run: go,
      });
    } else go();
  };

  const groups = GROUPS.map((g) => ({
    ...g,
    list: changes.filter((c) => c.group === g.id),
  }))
    .filter((g) => g.list.length > 0);
  const opLabel = view.op
    ? `${view.op.op[0].toUpperCase()}${view.op.op.slice(1)}ing…`
    : "";

  return (
    <div class={`scm-panel${target ? " has-diff" : ""}`}>
      <div class="scm-head">
        <span class="scm-repo" title={root} data-testid="scm-repo">
          {repoName(root)}
        </span>
        <div class="menu-anchor">
          <button
            type="button"
            class="scm-branch"
            data-testid="scm-branch"
            aria-expanded={menu === "branch"}
            title="Switch or create a branch"
            onClick={() => setMenu(menu === "branch" ? null : "branch")}
          >
            <span aria-hidden="true">⎇</span> {branch?.head ??
              (branch?.oid ? `detached at ${branch.oid.slice(0, 7)}` : "…")}
          </button>
          {menu === "branch" && (
            <BranchMenu
              view={view}
              filter={filter}
              onFilter={setFilter}
              onPick={(name) => checkout(name)}
              onCreate={(name) => checkout(name, true)}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
        {branch?.upstream && (
          <span
            class="scm-ab"
            data-testid="scm-ab"
            title={`Against ${branch.upstream}: ahead ${branch.ahead}, behind ${branch.behind}`}
          >
            ↑{branch.ahead} ↓{branch.behind}
          </span>
        )}
        <span class="scm-spacer" />
        {(["fetch", "pull", "push", "sync"] as const).map((op) => (
          <button
            type="button"
            key={op}
            class="scm-tool"
            data-testid={`scm-${op}`}
            disabled={busy}
            title={op === "sync"
              ? "Pull, then push"
              : `${op[0].toUpperCase()}${op.slice(1)}`}
            onClick={() => void view.remote(op)}
          >
            {op === "fetch"
              ? "Fetch"
              : op === "pull"
              ? "Pull"
              : op === "push"
              ? "Push"
              : "Sync"}
          </button>
        ))}
        <button
          type="button"
          class="scm-tool"
          data-testid="scm-refresh"
          title="Refresh"
          aria-label="Refresh"
          onClick={() => void view.refresh()}
        >
          ⟳
        </button>
      </div>
      <div class="scm-subhead">
        <label
          class="scm-check"
          title="Show the repository of the terminal you focus"
        >
          <input
            type="checkbox"
            data-testid="scm-follow"
            checked={props.follow}
            onChange={(e) =>
              hooks.setTile(props.id, {
                follow: (e.target as HTMLInputElement).checked,
              })}
          />
          Follow focused terminal
        </label>
        <span class="scm-spacer" />
        <button
          type="button"
          class="scm-link-btn"
          data-testid="scm-change-repo"
          onClick={props.onChoose}
        >
          Change Repository…
        </button>
      </div>
      {view.op && (
        <div class="scm-progress" data-testid="scm-progress" role="status">
          <span class="scm-spinner" aria-hidden="true" />
          <span class="scm-progress-line">{view.op.line || opLabel}</span>
          <button
            type="button"
            class="scm-link-btn"
            data-testid="scm-cancel"
            onClick={view.cancel}
          >
            Cancel
          </button>
        </div>
      )}
      {view.error && (
        <div class="scm-error" data-testid="scm-error" role="alert">
          <span>{view.error}</span>
          <button
            type="button"
            class="scm-icon-btn"
            aria-label="Dismiss"
            onClick={() =>
              view.setError(null)}
          >
            ×
          </button>
        </div>
      )}
      {confirm && (
        <div class="scm-confirm" role="alertdialog" data-testid="scm-confirm">
          <span>{confirm.text}</span>
          <button
            type="button"
            class={`btn-primary scm-btn${confirm.danger ? " is-danger" : ""}`}
            data-testid="scm-confirm-yes"
            onClick={() => {
              setConfirm(null);
              confirm.run();
            }}
          >
            {confirm.label}
          </button>
          <button
            type="button"
            class="btn-quiet scm-btn"
            data-testid="scm-confirm-no"
            onClick={() =>
              setConfirm(null)}
          >
            Cancel
          </button>
        </div>
      )}
      <div class="scm-main">
        <div class="scm-list" data-testid="scm-list">
          <div class="scm-commit-box">
            <textarea
              class="scm-message"
              data-testid="scm-message"
              data-commit-box
              rows={3}
              placeholder={`Message (${
                hooks.platform === "mac" ? "⌘↩" : "Ctrl+Enter"
              } to commit${branch?.head ? ` on "${branch.head}"` : ""})`}
              value={message}
              onInput={(e) =>
                setMessage((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                const mod = hooks.platform === "mac" ? e.metaKey : e.ctrlKey;
                if (e.key === "Enter" && mod && !e.shiftKey && !e.altKey) {
                  e.preventDefault();
                  tryCommit("staged");
                }
              }}
            />
            <div class="scm-commit-row">
              <button
                type="button"
                class="btn-primary scm-commit-btn"
                data-testid="scm-commit"
                disabled={busy}
                onClick={() => tryCommit("staged")}
              >
                {amend ? "Amend" : "Commit"}
              </button>
              <div class="menu-anchor">
                <button
                  type="button"
                  class="btn-primary scm-commit-more"
                  data-testid="scm-commit-menu"
                  aria-label="More commit actions"
                  aria-expanded={menu === "commit"}
                  disabled={busy}
                  onClick={() => setMenu(menu === "commit" ? null : "commit")}
                >
                  ▾
                </button>
                {menu === "commit" && (
                  <div
                    class="menu scm-menu"
                    role="menu"
                    data-testid="scm-commit-items"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      data-testid="scm-commit-staged"
                      onClick={() => tryCommit("staged")}
                    >
                      <span class="menu-label">Commit Staged</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="menu-item"
                      data-testid="scm-commit-all"
                      onClick={() => tryCommit("all")}
                    >
                      <span class="menu-label">Commit All</span>
                    </button>
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={amend}
                      class="menu-item"
                      data-testid="scm-amend"
                      onClick={() => void toggleAmend()}
                    >
                      <span class="menu-check" aria-hidden="true">
                        {amend ? "✓" : ""}
                      </span>
                      <span class="menu-label">Amend Last Commit</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {view.loaded && changes.length === 0 && (
            <div class="scm-dim scm-pad" data-testid="scm-clean">
              No changes: the working tree is clean.
            </div>
          )}
          {!view.loaded && <div class="scm-dim scm-pad">Loading…</div>}
          {groups.map((g) => (
            <div
              class="scm-group"
              data-testid="scm-group"
              data-group={g.id}
              key={g.id}
            >
              <div class="scm-group-head">
                <button
                  type="button"
                  class="scm-section-toggle"
                  aria-expanded={!closed[g.id]}
                  onClick={() =>
                    setClosed({ ...closed, [g.id]: !closed[g.id] })}
                >
                  <span class="scm-caret" aria-hidden="true">
                    {closed[g.id] ? "▸" : "▾"}
                  </span>
                  {g.label}
                  <span class="scm-count">{g.list.length}</span>
                </button>
                <span class="scm-spacer" />
                <span class="scm-row-actions">
                  {g.id !== "staged" && g.id !== "merge" && (
                    <button
                      type="button"
                      class="scm-link-btn is-danger"
                      data-testid="scm-group-discard"
                      disabled={busy}
                      onClick={() => discard(g.list, g.id)}
                    >
                      Discard All…
                    </button>
                  )}
                  {g.id === "staged"
                    ? (
                      <button
                        type="button"
                        class="scm-link-btn"
                        data-testid="scm-group-unstage"
                        disabled={busy}
                        onClick={() => unstage(g.list)}
                      >
                        Unstage All
                      </button>
                    )
                    : (
                      <button
                        type="button"
                        class="scm-link-btn"
                        data-testid="scm-group-stage"
                        disabled={busy}
                        onClick={() => stage(g.list)}
                      >
                        Stage All
                      </button>
                    )}
                </span>
              </div>
              {!closed[g.id] && g.list.map((c) => (
                <div
                  class={`scm-row scm-file${
                    target && target.kind === c.group && target.path === c.path
                      ? " is-selected"
                      : ""
                  }`}
                  data-testid="scm-file"
                  data-path={c.path}
                  data-group={c.group}
                  key={changeKey(c)}
                  role="button"
                  tabIndex={0}
                  title={c.conflict
                    ? `Conflict (${c.conflict})`
                    : LETTER_NAMES[c.letter]}
                  onClick={() =>
                    setTarget(
                      c.group === "merge"
                        ? { path: c.path, kind: "changes" }
                        : { path: c.path, kind: c.group as DiffTarget["kind"] },
                    )}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.target === e.currentTarget) {
                      setTarget({
                        path: c.path,
                        kind: c.group === "merge"
                          ? "changes"
                          : c.group as DiffTarget["kind"],
                      });
                    }
                  }}
                >
                  <PathLabel change={c} />
                  {agent.has(c.path) && (
                    <span
                      class="scm-badge is-agent"
                      data-testid="scm-agent-badge"
                      title="An agent tile changed this file (not reviewed yet)"
                    >
                      agent
                    </span>
                  )}
                  <span
                    class="scm-row-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {hooks.openFile && c.letter !== "D" && (
                      <button
                        type="button"
                        class="scm-icon-btn"
                        title="Open File"
                        aria-label="Open File"
                        onClick={() => hooks.openFile!(abs(c.path))}
                      >
                        ↗
                      </button>
                    )}
                    {c.letter !== "D" && (
                      <button
                        type="button"
                        class="scm-icon-btn"
                        title="Reveal in the file manager"
                        aria-label="Reveal"
                        onClick={() => hooks.reveal(abs(c.path))}
                      >
                        ⌕
                      </button>
                    )}
                    {ROW_ACTIONS[c.group].map((a) => (
                      <button
                        type="button"
                        key={a}
                        class={`scm-icon-btn${
                          a === "discard" ? " is-danger" : ""
                        }`}
                        data-testid={`scm-file-${a}`}
                        title={ACTION_TEXT[a]}
                        aria-label={`${ACTION_TEXT[a]} ${c.path}`}
                        disabled={busy}
                        onClick={() => rowAction(a, c)}
                      >
                        {a === "stage" ? "+" : a === "unstage" ? "−" : "↺"}
                      </button>
                    ))}
                  </span>
                  <span
                    class={`scm-letter is-${c.letter}`}
                    data-testid="scm-letter"
                  >
                    {c.letter}
                  </span>
                </div>
              ))}
            </div>
          ))}
          <Section
            id="history"
            title="History"
            count={view.data.log.length}
            open={open.history}
            onToggle={() => setOpen({ ...open, history: !open.history })}
          >
            <HistoryList
              commits={view.data.log}
              now={now}
              openOid={openOid}
              files={commitFiles}
              onOpen={setOpenOid}
              onFile={(oid, path) => setTarget({ path, kind: "commit", oid })}
              selectedPath={target?.kind === "commit" ? target.path : null}
            />
          </Section>
          <Section
            id="stashes"
            title="Stashes"
            count={view.data.stashes.length}
            open={open.stashes}
            onToggle={() => setOpen({ ...open, stashes: !open.stashes })}
          >
            <StashForm
              busy={busy}
              onStash={(m, untracked) =>
                void view.act(() =>
                  client.stashPush({
                    root,
                    message: m,
                    ...(untracked ? { untracked } : {}),
                  })
                )}
            />
            <StashList
              stashes={view.data.stashes}
              now={now}
              busy={busy}
              onAction={(s: ScmStash, action) => {
                const run = () =>
                  void view.act(() =>
                    client.stashAction({ root, ref: s.ref, oid: s.oid, action })
                  );
                if (action !== "drop") return run();
                ask({
                  text: (
                    <>
                      Drop the stash{" "}
                      <b>{s.subject}</b>? It cannot be brought back.
                    </>
                  ),
                  label: "Drop",
                  danger: true,
                  run,
                });
              }}
            />
          </Section>
          <Section
            id="worktrees"
            title="Worktrees"
            count={view.data.worktrees.length}
            open={open.worktrees}
            onToggle={() => setOpen({ ...open, worktrees: !open.worktrees })}
          >
            <WorktreeList
              worktrees={view.data.worktrees}
              root={root}
              busy={busy}
              onTerminal={hooks.openTerminal}
              onScm={hooks.openScm}
              onWorkspace={(w) =>
                w.branch &&
                hooks.openWorktree({
                  path: w.path,
                  branch: w.branch,
                  repo: mainRepo,
                })}
              onRemove={(w) => removeWorktree(w.path)}
            />
            <WorktreeForm
              repo={mainRepo}
              folderSetting={hooks.worktreeFolder}
              branches={view.data.branches}
              busy={busy}
              onAdd={async (path, b, create) => {
                const ok = await view.act(() =>
                  client.worktreeAdd({
                    root,
                    path,
                    branch: b,
                    ...(create ? { create } : {}),
                  })
                );
                if (ok) hooks.openWorktree({ path, branch: b, repo: mainRepo });
              }}
            />
          </Section>
        </div>
        {target && (
          <DiffView
            target={target}
            file={diff.file}
            {...(diff.message ? { message: diff.message } : {})}
            sideBySide={split}
            onSideBySide={setSplit}
            busy={busy}
            onHunk={onHunk}
            onClose={() => setTarget(null)}
            actions={target.kind !== "commit" && (
              <DiffFileActions
                target={target}
                hooks={hooks}
                root={root}
                busy={busy}
                changes={changes}
                stage={stage}
                unstage={unstage}
              />
            )}
          />
        )}
      </div>
    </div>
  );
}

/** The diff bar's Stage File / Unstage File and Open File. */
function DiffFileActions(props: {
  target: DiffTarget;
  hooks: ScmTileHooks;
  root: string;
  busy: boolean;
  changes: ScmChange[];
  stage(list: ScmChange[]): void;
  unstage(list: ScmChange[]): void;
}) {
  const { target } = props;
  const change = props.changes.find((c) =>
    c.path === target.path && c.group === target.kind
  );
  return (
    <>
      {props.hooks.openFile && (
        <button
          type="button"
          class="scm-link-btn"
          onClick={() => props.hooks.openFile!(`${props.root}/${target.path}`)}
        >
          Open File
        </button>
      )}
      {change && (
        <button
          type="button"
          class="scm-link-btn"
          data-testid={target.kind === "staged"
            ? "scm-diff-unstage"
            : "scm-diff-stage"}
          disabled={props.busy}
          onClick={() =>
            (target.kind === "staged" ? props.unstage : props.stage)([change])}
        >
          {target.kind === "staged" ? "Unstage File" : "Stage File"}
        </button>
      )}
    </>
  );
}

/** The branch picker's menu: filter, local then remote branches, and "Create branch". */
function BranchMenu(props: {
  view: ScmView;
  filter: string;
  onFilter(v: string): void;
  onPick(name: string): void;
  onCreate(name: string): void;
  onClose(): void;
}) {
  const f = props.filter.trim();
  const refs = props.view.data.branches.filter((b) =>
    b.name.toLowerCase().includes(f.toLowerCase())
  );
  const exists = props.view.data.branches.some((b) => b.name === f);
  return (
    <div
      class="menu scm-menu scm-branch-menu"
      role="menu"
      data-testid="scm-branch-menu"
    >
      <input
        class="scm-input"
        data-testid="scm-branch-filter"
        placeholder="Branch name: filter, or a new branch"
        value={props.filter}
        autoFocus
        onInput={(e) => props.onFilter((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          } else if (e.key === "Enter" && f) {
            e.preventDefault();
            if (exists) props.onPick(f);
            else props.onCreate(f);
          }
        }}
      />
      {f && !exists && (
        <button
          type="button"
          role="menuitem"
          class="menu-item"
          data-testid="scm-branch-create"
          onClick={() => props.onCreate(f)}
        >
          <span class="menu-label">Create branch “{f}” from HEAD</span>
        </button>
      )}
      <div class="scm-branch-list">
        {refs.map((b) => (
          <button
            type="button"
            role="menuitem"
            class={`menu-item${b.current ? " is-active" : ""}`}
            data-testid="scm-branch-item"
            data-name={b.name}
            key={`${b.remote ? "r" : "l"}:${b.name}`}
            disabled={b.current}
            onClick={() => props.onPick(b.name)}
          >
            <span class="menu-check" aria-hidden="true">
              {b.current ? "✓" : ""}
            </span>
            <span class="menu-label">{b.name}</span>
            <span class="scm-dim">{b.remote ? "remote" : b.oid}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
