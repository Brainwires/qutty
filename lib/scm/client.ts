/**
 * The page's Source Control client in the desktop app: the `scm` desktop extension
 * (desktop/scm.ts) through Denext's bridge, its `changed` and `progress` events through the
 * desktop event stream. Client-safe: the extension is imported for its types only.
 *
 * @module
 */

import type {
  desktopExtension as DesktopExtension,
  onDesktopEvent as OnDesktopEvent,
} from "denext/desktop/client";
import type scmExtension from "../../desktop/scm.ts";
import type { ScmChanged, ScmClient, ScmProgress } from "./types.ts";

/** The `scm` extension as a {@linkcode ScmClient}. */
export function createDesktopScm(
  desktopExtension: typeof DesktopExtension,
  onDesktopEvent: typeof OnDesktopEvent,
): ScmClient {
  const scm = desktopExtension<typeof scmExtension>("scm");
  const changed = new Set<(e: ScmChanged) => void>();
  const progress = new Set<(e: ScmProgress) => void>();
  let listening = false;
  const listen = () => {
    if (listening) return;
    listening = true;
    onDesktopEvent<ScmChanged>("scm", "changed", (e) => {
      for (const cb of [...changed]) cb(e);
    });
    onDesktopEvent<ScmProgress>("scm", "progress", (e) => {
      for (const cb of [...progress]) cb(e);
    });
  };
  return {
    repoRoot: (path) => scm.repoRoot({ path }),
    status: (root) => scm.status({ root }),
    diff: (request) => scm.diff(request),
    stage: (request) => scm.stage(request),
    unstage: (request) => scm.unstage(request),
    discard: (request) => scm.discard(request),
    discardUntracked: (request) => scm.discardUntracked(request),
    applyPatch: (request) => scm.applyPatch(request),
    commit: (request) => scm.commit(request),
    lastMessage: (root) => scm.lastMessage({ root }),
    branches: (root) => scm.branches({ root }),
    checkout: (request) => scm.checkout(request),
    remote: (request) => scm.remote(request),
    cancel: (opId) => scm.cancel({ opId }),
    log: (root, limit) => scm.log({ root, limit }),
    commitFiles: (root, oid) => scm.commitFiles({ root, oid }),
    commitDiff: (root, oid, path) => scm.commitDiff({ root, oid, path }),
    stashes: (root) => scm.stashes({ root }),
    stashPush: (request) => scm.stashPush(request),
    stashAction: (request) => scm.stashAction(request),
    worktrees: (root) => scm.worktrees({ root }),
    worktreeAdd: (request) => scm.worktreeAdd(request),
    worktreeRemove: (request) => scm.worktreeRemove(request),
    watch: async (root) => {
      listen();
      const id = await scm.watch({ root });
      return () => void scm.unwatch({ id }).catch(() => {});
    },
    onChanged: (cb) => {
      listen();
      changed.add(cb);
      return () => void changed.delete(cb);
    },
    onProgress: (cb) => {
      listen();
      progress.add(cb);
      return () => void progress.delete(cb);
    },
  };
}
