// A worktree workspace's badge (lib/scm/worktrees.ts): "⑂ branch" and the repository it belongs
// to, in the switcher bar (this window's) and the Workspaces menu (each worktree workspace's).

import { worktreeLabel, type WorktreeMark } from "../lib/scm/worktrees.ts";

export function WorktreeBadge(props: {
  mark: Pick<WorktreeMark, "branch"> & { repo: string };
  /** The repository's name is given already (the Workspaces menu's facts); else it is derived. */
  repoName?: boolean;
}) {
  const label = props.repoName
    ? { badge: `⑂ ${props.mark.branch}`, repo: props.mark.repo }
    : worktreeLabel(props.mark as WorktreeMark);
  return (
    <span
      class="wt-badge"
      data-testid="worktree-badge"
      title={`A worktree of ${label.repo}, on ${props.mark.branch}`}
    >
      <span class="wt-branch">{label.badge}</span>
      <span class="wt-repo">{label.repo}</span>
    </span>
  );
}
