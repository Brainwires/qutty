// A Source Control tile's data and actions (app/scm-tile.tsx): the repository's status, branches,
// history, stashes and worktrees from the ScmClient (desktop/scm.ts, or lib/scm/demo.ts), and
// the actions that change them, each followed by a refresh.
//
// Refreshes come from events, never a timer: the repository's file watch (the backend's debounced
// `changed`), the tile gaining the focus, the tile's own actions, and `tick` (the workspace bumps
// it when an agent finishes a turn). One refresh runs at a time; a request while one runs queues
// exactly one more.

import { useCallback, useEffect, useRef, useState } from "denext";
import type {
  ScmClient,
  ScmCommit,
  ScmRef,
  ScmResult,
  ScmStash,
  ScmStatus,
  ScmWorktree,
} from "../lib/scm/types.ts";

/** What the tile shows of its repository. */
interface ScmData {
  status: ScmStatus | null;
  branches: ScmRef[];
  log: ScmCommit[];
  stashes: ScmStash[];
  worktrees: ScmWorktree[];
}

const EMPTY: ScmData = {
  status: null,
  branches: [],
  log: [],
  stashes: [],
  worktrees: [],
};

/** How many commits the history lists. */
const LOG_LIMIT = 150;

/** A fetch / pull / push / sync under way: its id (for cancel), what it is, git's last line. */
interface ScmOp {
  opId: string;
  op: "fetch" | "pull" | "push" | "sync";
  line: string;
}

/** A result's message for the tile (`null`: it worked). */
function resultMessage(r: ScmResult): string | null {
  if (r.ok) return null;
  return r.error ?? (r.cancelled ? "Cancelled." : "Git failed.");
}

let opSeq = 0;

export function useScm(o: {
  client: ScmClient;
  root: string | null;
  focused: boolean;
  /** Bumped by the workspace to ask for a refresh (an agent's turn ended). */
  tick: number;
}) {
  const { client, root } = o;
  const [data, setData] = useState<ScmData>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  /** Set while an action other than a remote operation runs. */
  const [busy, setBusy] = useState(false);
  const [op, setOp] = useState<ScmOp | null>(null);
  const [loaded, setLoaded] = useState(false);
  const rootRef = useRef(root);
  rootRef.current = root;
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const load = useCallback(async () => {
    const r = rootRef.current;
    if (!r) return;
    const [status, branches, log, stashes, worktrees] = await Promise.all([
      client.status(r),
      client.branches(r).catch(() => []),
      client.log(r, LOG_LIMIT).catch(() => []),
      client.stashes(r).catch(() => []),
      client.worktrees(r).catch(() => []),
    ]);
    if (rootRef.current !== r) return;
    setData({ status, branches, log, stashes, worktrees });
    setLoaded(true);
  }, [client]);

  const refresh = useCallback((): Promise<void> => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const run = async () => {
      do {
        again.current = false;
        try {
          await load();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      } while (again.current);
    };
    running.current = run().finally(() => {
      running.current = null;
    });
    return running.current;
  }, [load]);

  // A new repository: start over, watch it, load it.
  useEffect(() => {
    setData(EMPTY);
    setError(null);
    setLoaded(false);
    if (!root) return;
    void refresh();
    let unwatch: (() => void) | null = null;
    let gone = false;
    client.watch(root).then((off) => {
      if (gone) off();
      else unwatch = off;
    }, () => {});
    const offChanged = client.onChanged((e) => {
      if (e.root === rootRef.current) void refresh();
    });
    return () => {
      gone = true;
      unwatch?.();
      offChanged();
    };
  }, [client, root, refresh]);

  // The tile took the focus, or the workspace asked.
  useEffect(() => {
    if (o.focused && root) void refresh();
  }, [o.focused]);
  useEffect(() => {
    if (o.tick > 0 && root) void refresh();
  }, [o.tick]);

  // Progress lines of this tile's remote operation.
  useEffect(
    () =>
      client.onProgress((e) =>
        setOp((cur) =>
          cur && cur.opId === e.opId ? { ...cur, line: e.line } : cur
        )
      ),
    [client],
  );

  /** Run an action, show its error if it failed, refresh. Resolves to whether it worked. */
  const act = useCallback(
    async (work: () => Promise<ScmResult>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const r = await work();
        setError(resultMessage(r));
        return r.ok;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  /** Fetch, pull, push or sync: progress in `op`, cancellable. */
  const remote = useCallback(async (kind: ScmOp["op"]) => {
    const r = rootRef.current;
    if (!r) return;
    const opId = `scm-${Date.now().toString(36)}-${++opSeq}`;
    setOp({ opId, op: kind, line: "" });
    setError(null);
    try {
      setError(resultMessage(await client.remote({ root: r, op: kind, opId })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOp(null);
      void refresh();
    }
  }, [client, refresh]);

  const cancel = useCallback(() => {
    if (op) void client.cancel(op.opId);
  }, [client, op]);

  return {
    data,
    loaded,
    error,
    setError,
    busy,
    op,
    refresh,
    act,
    remote,
    cancel,
  };
}

export type ScmView = ReturnType<typeof useScm>;
