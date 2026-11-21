/**
 * A Source Control tile's saved state (its entry's `scm`, lib/workspace/store.ts): the repository
 * it shows and whether it follows the focused terminal. Pure, with the small helpers the tile
 * (app/scm-tile.tsx) and the workspace share.
 *
 * @module
 */

import type { ScmChange, ScmGroup } from "./types.ts";

/** What a Source Control tile keeps. */
export interface ScmTile {
  /** The worktree root it shows; `null` until one is chosen. */
  root: string | null;
  /** Re-target to the focused terminal's repository as the focus moves. */
  follow?: boolean;
  /** Open on this section once ("New Worktree…" / "Open Worktree…"), then forgotten. */
  show?: "worktrees";
}

const MAX_PATH = 4096;

/** A Source Control tile's state from storage or a page (untrusted), or `undefined`. */
export function sanitizeScmTile(v: unknown): ScmTile | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const root = typeof r.root === "string" && r.root.startsWith("/") &&
      r.root.length <= MAX_PATH && !r.root.includes("\0")
    ? r.root
    : null;
  if (r.root !== null && root === null) return undefined;
  return {
    root,
    ...(r.follow === true ? { follow: true } : {}),
    ...(r.show === "worktrees" ? { show: "worktrees" as const } : {}),
  };
}

/** A folder's last name (`/src/qutty` → `qutty`). */
export function repoName(root: string): string {
  return root.replace(/\/+$/, "").split("/").pop() || root;
}

/** The tile's title: "Source Control — qutty". */
export function scmTitle(tile: ScmTile): string {
  return tile.root
    ? `Source Control — ${repoName(tile.root)}`
    : "Source Control";
}

/** The groups' headings, in the order they are listed. */
export const GROUPS: readonly { id: ScmGroup; label: string }[] = [
  { id: "merge", label: "Merge Changes" },
  { id: "staged", label: "Staged Changes" },
  { id: "changes", label: "Changes" },
  { id: "untracked", label: "Untracked" },
];

/** What a status letter means (a row's tooltip). */
export const LETTER_NAMES: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  T: "Type changed",
  U: "Untracked",
  C: "Conflict",
};

/** The paths a stage or unstage of `changes` takes: a rename's old path too. */
export function changePaths(changes: readonly ScmChange[]): string[] {
  return [
    ...new Set(
      changes.flatMap((c) => c.origPath ? [c.path, c.origPath] : [c.path]),
    ),
  ];
}

/** A change's key in lists (a file can be staged and changed again). */
export const changeKey = (c: ScmChange) => `${c.group}:${c.path}`;

/** What "Commit" does with nothing staged: stage everything first (VS Code's smart commit). */
export function commitPlan(
  changes: readonly ScmChange[],
  mode: "staged" | "all",
): "commit" | "stage-all" | "nothing" | "conflicts" {
  if (changes.some((c) => c.group === "merge")) return "conflicts";
  if (mode === "all") {
    return changes.some((c) => c.group !== "untracked")
      ? "commit"
      : changes.length
      ? "stage-all"
      : "nothing";
  }
  if (changes.some((c) => c.group === "staged")) return "commit";
  return changes.length > 0 ? "stage-all" : "nothing";
}
