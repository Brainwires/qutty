/**
 * Worktrees as workspaces (modelled on Herdr): a linked git worktree opens as a workspace of its
 * own (a Qutty window), with a terminal in its folder. Pure helpers:
 *
 * - {@linkcode WorktreeMark}: what a worktree workspace remembers (in its snapshot,
 *   lib/workspace/session.ts), so the switcher bar and the Workspaces menu show "⑂ branch" and
 *   the repository it belongs to, and new agent tiles start in its folder;
 * - {@linkcode worktreeQuery} / {@linkcode worktreeFromQuery}: how the window that opens one
 *   tells the new window's page which worktree it is (a URL parameter, read once at its start);
 * - {@linkcode checkoutPath}: where "New Worktree…" puts the checkout, by default
 *   `<repo-parent>/.qutty-worktrees/<repo>/<branch-slug>`, or under Settings → Source Control →
 *   Worktree folder.
 *
 * @module
 */

import { repoName } from "./tile.ts";

/** A worktree workspace's worktree. */
export interface WorktreeMark {
  /** The checkout's folder. */
  path: string;
  /** Its branch. */
  branch: string;
  /** The repository it belongs to (its main checkout's folder). */
  repo: string;
}

/** Settings → Source Control. */
export interface ScmSettings {
  /** Where new worktrees go (`<folder>/<repo>/<branch>`); empty: beside the repository. */
  worktreeFolder: string;
}

export const DEFAULT_SCM_SETTINGS: ScmSettings = { worktreeFolder: "" };

const MAX_PATH = 4096;

const isPath = (v: unknown): v is string =>
  typeof v === "string" && v.startsWith("/") && v.length <= MAX_PATH &&
  !v.includes("\0");

/** Settings → Source Control from storage (anything unusable falls back to `base`). */
export function sanitizeScmSettings(
  v: unknown,
  base: ScmSettings = DEFAULT_SCM_SETTINGS,
): ScmSettings {
  if (typeof v !== "object" || v === null) return { ...base };
  const f = (v as Record<string, unknown>).worktreeFolder;
  if (f === "") return { worktreeFolder: "" };
  return {
    worktreeFolder: isPath(f)
      ? f.replace(/\/+$/, "") || "/"
      : base.worktreeFolder,
  };
}

/** A worktree mark from storage, a URL or a page (untrusted), or `undefined`. */
export function sanitizeWorktreeMark(v: unknown): WorktreeMark | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  if (!isPath(r.path) || !isPath(r.repo)) return undefined;
  if (
    typeof r.branch !== "string" || r.branch.length > 255 ||
    /[\0\n]/.test(r.branch)
  ) {
    return undefined;
  }
  return { path: r.path, branch: r.branch, repo: r.repo };
}

/** The worktree of a saved workspace snapshot, if it is a worktree workspace. */
export function worktreeMarkOf(snapshot: unknown): WorktreeMark | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  return sanitizeWorktreeMark((snapshot as Record<string, unknown>).worktree);
}

/** The URL parameter that opens a window as worktree `mark`'s workspace. */
const WORKTREE_PARAM = "worktree";

/** The query string (`?worktree=…`) for a new window showing worktree `mark`. */
export function worktreeQuery(mark: WorktreeMark): string {
  return `?${WORKTREE_PARAM}=${encodeURIComponent(JSON.stringify(mark))}`;
}

/** The worktree a page's query string (`location.search`) names, if any. */
export function worktreeFromQuery(search: string): WorktreeMark | undefined {
  try {
    const raw = new URLSearchParams(search).get(WORKTREE_PARAM);
    return raw ? sanitizeWorktreeMark(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

/** A branch name as one folder name (`feature/x y` → `feature-x-y`). */
export function branchSlug(branch: string): string {
  return branch.replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "") ||
    "worktree";
}

/**
 * Where a new worktree of `branch` of the repository at `repo` goes: under `folder` (Settings),
 * else `<repo-parent>/.qutty-worktrees`, then `<repo>/<branch-slug>`.
 */
export function checkoutPath(
  repo: string,
  branch: string,
  folder = "",
): string {
  const trimmed = repo.replace(/\/+$/, "");
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"));
  const base = folder
    ? folder.replace(/\/+$/, "")
    : `${parent}/.qutty-worktrees`;
  return `${base}/${repoName(trimmed)}/${branchSlug(branch)}`;
}

/** The label a worktree workspace wears: "⑂ branch", and its repository's name. */
export function worktreeLabel(
  mark: WorktreeMark,
): { badge: string; repo: string } {
  return { badge: `⑂ ${mark.branch}`, repo: repoName(mark.repo) };
}
