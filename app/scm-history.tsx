// The Source Control tile's lower sections, each collapsible: History (recent commits with a
// graph lane; a click lists the commit's files, a file's click shows its diff), Stashes (stash
// with a message, apply, pop, drop after asking) and Worktrees (open one in a terminal or a
// Source Control tile of its own; add one for a branch).

import { type ReactNode, useState } from "denext";
import { type GraphRow, graphRows, graphWidth } from "../lib/scm/graph.ts";
import { checkoutPath } from "../lib/scm/worktrees.ts";
import { formatAge } from "../lib/workspace/format.ts";
import type {
  CommitFile,
  ScmCommit,
  ScmRef,
  ScmStash,
  ScmWorktree,
} from "../lib/scm/types.ts";

/** A collapsible section: its heading (with a count and actions) and its body. */
export function Section(props: {
  id: string;
  title: string;
  count?: number;
  open: boolean;
  onToggle(): void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section class="scm-section" data-testid={`scm-section-${props.id}`}>
      <div class="scm-section-head">
        <button
          type="button"
          class="scm-section-toggle"
          aria-expanded={props.open}
          data-testid={`scm-toggle-${props.id}`}
          onClick={props.onToggle}
        >
          <span class="scm-caret" aria-hidden="true">
            {props.open ? "▾" : "▸"}
          </span>
          {props.title}
          {props.count !== undefined && (
            <span class="scm-count">{props.count}</span>
          )}
        </button>
        <span class="scm-spacer" />
        {props.actions}
      </div>
      {props.open && props.children}
    </section>
  );
}

const LANE_W = 10;
const ROW_H = 22;

/** One row's graph: the lanes through it, its dot, its joins. */
function GraphCell(props: { row: GraphRow; width: number }) {
  const { row } = props;
  const x = (l: number) => l * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  return (
    <svg
      class="scm-graph"
      width={props.width * LANE_W}
      height={ROW_H}
      viewBox={`0 0 ${props.width * LANE_W} ${ROW_H}`}
      aria-hidden="true"
    >
      {row.above.map((l) => (
        <line
          key={`a${l}`}
          x1={x(l)}
          y1={0}
          x2={x(l === row.lane || row.merges.includes(l) ? row.lane : l)}
          y2={mid}
        />
      ))}
      {row.below.map((l) => (
        <line
          key={`b${l}`}
          x1={x(row.joins.includes(l) || l === row.lane ? row.lane : l)}
          y1={mid}
          x2={x(l)}
          y2={ROW_H}
        />
      ))}
      <circle cx={x(row.lane)} cy={mid} r={3.2} />
    </svg>
  );
}

export function HistoryList(props: {
  commits: ScmCommit[];
  now: number;
  /** The commit whose files are listed. */
  openOid: string | null;
  files: CommitFile[] | null;
  onOpen(oid: string | null): void;
  onFile(oid: string, path: string): void;
  selectedPath: string | null;
}) {
  const rows = graphRows(props.commits);
  const width = graphWidth(rows);
  if (props.commits.length === 0) {
    return <div class="scm-dim scm-pad">No commits yet.</div>;
  }
  return (
    <div class="scm-history" data-testid="scm-history">
      {props.commits.map((c, i) => (
        <div key={c.oid}>
          <button
            type="button"
            class={`scm-commit${props.openOid === c.oid ? " is-open" : ""}`}
            data-testid="scm-commit"
            data-oid={c.oid}
            title={`${c.oid.slice(0, 10)} · ${c.author}`}
            onClick={() => props.onOpen(props.openOid === c.oid ? null : c.oid)}
          >
            <GraphCell row={rows[i]} width={width} />
            <span class="scm-commit-subject">{c.subject}</span>
            {c.refs.map((r) => (
              <span
                class={`scm-ref${r.startsWith("tag: ") ? " is-tag" : ""}`}
                key={r}
              >
                {r.replace(/^HEAD -> /, "")}
              </span>
            ))}
            <span class="scm-commit-meta">
              {c.author} · {formatAge(props.now, c.time * 1000)}
            </span>
          </button>
          {props.openOid === c.oid && (
            <div class="scm-commit-files" data-testid="scm-commit-files">
              {props.files === null && (
                <div class="scm-dim scm-pad">Loading…</div>
              )}
              {props.files?.length === 0 && (
                <div class="scm-dim scm-pad">No file changes.</div>
              )}
              {props.files?.map((f) => (
                <button
                  type="button"
                  key={f.path}
                  class={`scm-row${
                    props.selectedPath === f.path ? " is-selected" : ""
                  }`}
                  data-testid="scm-commit-file"
                  onClick={() => props.onFile(c.oid, f.path)}
                >
                  <span class="scm-path">
                    {f.origPath ? `${f.origPath} → ${f.path}` : f.path}
                  </span>
                  <span class={`scm-letter is-${f.letter}`}>{f.letter}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function StashList(props: {
  stashes: ScmStash[];
  now: number;
  busy: boolean;
  onAction(stash: ScmStash, action: "apply" | "pop" | "drop"): void;
}) {
  if (props.stashes.length === 0) {
    return <div class="scm-dim scm-pad">No stashes.</div>;
  }
  return (
    <div data-testid="scm-stashes">
      {props.stashes.map((s) => (
        <div
          class="scm-row"
          data-testid="scm-stash"
          data-ref={s.ref}
          key={s.oid}
        >
          <span class="scm-path" title={s.ref}>{s.subject}</span>
          <span class="scm-dim">{formatAge(props.now, s.time * 1000)}</span>
          <span class="scm-row-actions">
            {(["apply", "pop", "drop"] as const).map((a) => (
              <button
                type="button"
                key={a}
                class={`scm-link-btn${a === "drop" ? " is-danger" : ""}`}
                data-testid={`scm-stash-${a}`}
                disabled={props.busy}
                onClick={() => props.onAction(s, a)}
              >
                {a === "apply" ? "Apply" : a === "pop" ? "Pop" : "Drop…"}
              </button>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The "Stash Changes" form: a message and whether untracked files go too. */
export function StashForm(props: {
  busy: boolean;
  onStash(message: string, untracked: boolean): void;
}) {
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(false);
  return (
    <form
      class="scm-form"
      data-testid="scm-stash-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onStash(message, untracked);
        setMessage("");
      }}
    >
      <input
        class="scm-input"
        data-testid="scm-stash-message"
        placeholder="Stash message"
        value={message}
        onInput={(e) => setMessage((e.target as HTMLInputElement).value)}
      />
      <label class="scm-check">
        <input
          type="checkbox"
          checked={untracked}
          onChange={(e) => setUntracked((e.target as HTMLInputElement).checked)}
        />
        Untracked too
      </label>
      <button
        type="submit"
        class="btn-quiet scm-btn"
        data-testid="scm-stash-push"
        disabled={props.busy}
      >
        Stash
      </button>
    </form>
  );
}

export function WorktreeList(props: {
  worktrees: ScmWorktree[];
  root: string;
  busy: boolean;
  onTerminal(path: string): void;
  onScm(path: string): void;
  /** Open it as a workspace of its own (a new window). */
  onWorkspace(tree: ScmWorktree): void;
  /** Remove the checkout (asks first; never the branch). */
  onRemove(tree: ScmWorktree): void;
}) {
  return (
    <div data-testid="scm-worktrees">
      {props.worktrees.map((w, i) => (
        <div
          class="scm-row"
          data-testid="scm-worktree"
          data-path={w.path}
          key={w.path}
        >
          <span class="scm-path" title={w.path}>
            {w.branch
              ? <span class="scm-wt-branch">⑂ {w.branch}</span>
              : w.bare
              ? "(bare)"
              : w.detached
              ? "(detached)"
              : ""} <span class="scm-dim">{w.path}</span>
          </span>
          {i === 0 && <span class="scm-badge">main</span>}
          {w.path === props.root && <span class="scm-badge">this tile</span>}
          {w.locked && <span class="scm-badge">locked</span>}
          {!w.bare && (
            <span class="scm-row-actions">
              {w.branch && (
                <button
                  type="button"
                  class="scm-link-btn"
                  data-testid="scm-worktree-open"
                  title="Open this worktree as a workspace of its own, with a terminal in it"
                  onClick={() => props.onWorkspace(w)}
                >
                  Open as Workspace
                </button>
              )}
              <button
                type="button"
                class="scm-link-btn"
                title="Open a terminal in this worktree, here"
                onClick={() => props.onTerminal(w.path)}
              >
                Terminal
              </button>
              {w.path !== props.root && (
                <button
                  type="button"
                  class="scm-link-btn"
                  title="Open Source Control for this worktree in a new tile"
                  onClick={() => props.onScm(w.path)}
                >
                  Source Control
                </button>
              )}
              {i > 0 && (
                <button
                  type="button"
                  class="scm-link-btn is-danger"
                  data-testid="scm-worktree-remove"
                  title="Remove the checkout (its branch stays)"
                  disabled={props.busy}
                  onClick={() => props.onRemove(w)}
                >
                  Remove…
                </button>
              )}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * "New Worktree": a branch (an existing one, or a new one from HEAD) and its folder, by default
 * `<repo-parent>/.qutty-worktrees/<repo>/<branch>` (or under Settings → Source Control → Worktree
 * folder). The new checkout opens as a workspace of its own.
 */
export function WorktreeForm(props: {
  /** The repository's main checkout (the default folder is derived from it). */
  repo: string;
  /** Settings → Source Control → Worktree folder (empty: beside the repository). */
  folderSetting: string;
  branches: ScmRef[];
  busy: boolean;
  onAdd(path: string, branch: string, create: boolean): void;
}) {
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [edited, setEdited] = useState(false);
  const local = props.branches.filter((b) => !b.remote && !b.current);
  const create = branch !== "" &&
    !props.branches.some((b) => !b.remote && b.name === branch);
  const folder = edited
    ? path
    : branch
    ? checkoutPath(props.repo, branch, props.folderSetting)
    : "";
  return (
    <form
      class="scm-form"
      data-testid="scm-worktree-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (branch && folder) props.onAdd(folder, branch, create);
      }}
    >
      <input
        class="scm-input"
        data-testid="scm-worktree-branch"
        list="scm-worktree-branches"
        placeholder="Branch (existing or new)"
        value={branch}
        onInput={(e) => setBranch((e.target as HTMLInputElement).value.trim())}
      />
      <datalist id="scm-worktree-branches">
        {local.map((b) => <option value={b.name} key={b.name} />)}
      </datalist>
      <input
        class="scm-input"
        data-testid="scm-worktree-folder"
        placeholder="Folder"
        value={folder}
        onInput={(e) => {
          setEdited(true);
          setPath((e.target as HTMLInputElement).value);
        }}
      />
      <button
        type="submit"
        class="btn-quiet scm-btn"
        data-testid="scm-worktree-add"
        disabled={props.busy || !branch || !folder}
      >
        {create ? "Create Branch and Worktree" : "New Worktree"}
      </button>
    </form>
  );
}
