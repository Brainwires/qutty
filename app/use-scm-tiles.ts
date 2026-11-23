// The workspace's half of Source Control (app/scm-tile.tsx) and of worktree workspaces
// (lib/scm/worktrees.ts):
//
// - opening a Source Control tile: for a terminal's folder (its header menu), for the focused
//   terminal (the `+` menu, the View menu, the Workspaces menu's worktree items), or with the
//   repository chooser when there is no folder to go by;
// - "Follow focused terminal": the repository of the terminal focused last, read when the focus
//   or the focused terminal's title (its folder) changes, never on a timer;
// - the agent badges: the files agent tiles in a repository changed and nobody reviewed yet
//   (lib/agent/changes.ts), and a refresh when an agent finishes a turn;
// - worktrees as workspaces: "Open as Workspace" opens a new window (a workspace of its own)
//   whose page reads the worktree from its URL (`openedFor`) and starts its first terminal there.
//   Where there is one window only (the demo) the worktree opens as a terminal tile here instead.

import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type {
  WorkspaceAction,
  WorkspaceState,
} from "../lib/workspace/store.ts";
import type { KeyPlatform } from "../lib/workspace/keys.ts";
import type { TerminalProfile } from "../lib/ssh-ui.ts";
import type { ScmTile } from "../lib/scm/tile.ts";
import {
  worktreeFromQuery,
  type WorktreeMark,
  worktreeQuery,
} from "../lib/scm/worktrees.ts";
import { isInside, sessionChanges } from "../lib/agent/changes.ts";
import type { ScmTileHooks } from "./scm-tile.tsx";
import type { AgentTilesView } from "./use-agent-tiles.tsx";

/** The worktree this page's window was opened for (its URL's `?worktree=`), read once. */
function openedForWorktree(): WorktreeMark | undefined {
  try {
    return worktreeFromQuery(globalThis.location?.search ?? "");
  } catch {
    return undefined;
  }
}

/** Whether tile entry `t` is a terminal on this machine (it has a folder to go by). */
const localTerminal = (
  t: {
    web?: unknown;
    chat?: unknown;
    scm?: unknown;
    ssh?: unknown;
    sandbox?: boolean;
  },
) => !t.web && !t.chat && !t.scm && !t.ssh && !t.sandbox;

export function useScmTiles(o: {
  backend: PtyBackend | null;
  manager: TerminalManager | null;
  state: WorkspaceState;
  platform: KeyPlatform;
  dispatch(action: WorkspaceAction): void;
  run(action: WorkspaceAction): void;
  nextId(): string;
  openTile(profile: TerminalProfile): string | null;
  openInEditor(path: string, line?: number): void;
  agents: RefObject<AgentTilesView | null>;
}) {
  const { backend, manager, state, dispatch, run, nextId, openTile } = o;
  const client = backend?.scm;
  const [openedFor] = useState(openedForWorktree);
  const [followRoot, setFollowRoot] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  /** The repository root of tile `id`'s folder (`null`: not in one, or no folder). */
  const rootOf = useCallback(async (id: string): Promise<string | null> => {
    if (!manager || !client) return null;
    const cwd = await manager.cwd(id).catch(() => undefined);
    return cwd ? await client.repoRoot(cwd).catch(() => null) : null;
  }, [manager, client]);

  /** A Source Control tile for `root` (`null`: the chooser), beside the focused tile. */
  const openScm = useCallback((root: string | null, show?: ScmTile["show"]) => {
    const scm: ScmTile = { root, ...(show ? { show } : {}) };
    run({ type: "add", id: nextId(), now: Date.now(), scm });
  }, [run, nextId]);

  /** Source Control for terminal `id`'s folder. */
  const openFor = useCallback((id: string, show?: ScmTile["show"]) => {
    void rootOf(id).then((root) => openScm(root, show));
  }, [rootOf, openScm]);

  /**
   * Source Control for what is focused: a Source Control tile shows `show` itself, a terminal's
   * repository opens, else this worktree workspace's, else the chooser.
   */
  const openForFocused = useCallback((show?: ScmTile["show"]) => {
    const focused = state.terminals.find((t) => t.id === state.focusedId);
    if (focused?.scm?.root && show) {
      dispatch({ type: "scmTile", id: focused.id, patch: { show } });
      return;
    }
    if (focused && localTerminal(focused)) return openFor(focused.id, show);
    openScm(state.worktree?.path ?? null, show);
  }, [
    state.terminals,
    state.focusedId,
    state.worktree,
    dispatch,
    openFor,
    openScm,
  ]);

  // "Follow focused terminal": the focused terminal's repository, when the focus or its folder
  // (its title) changes.
  const focused = state.terminals.find((t) => t.id === state.focusedId);
  const followKey = focused && localTerminal(focused)
    ? `${focused.id}\n${focused.title}`
    : null;
  useEffect(() => {
    if (!followKey || !focused) return;
    let gone = false;
    void rootOf(focused.id).then((root) => {
      if (!gone && root) setFollowRoot(root);
    });
    return () => void (gone = true);
  }, [followKey, rootOf]);

  /** Open worktree `mark` as a workspace of its own (one window only: a terminal here). */
  const openWorktree = useCallback((mark: WorktreeMark) => {
    const session = backend?.session;
    if (session?.multiWindow) {
      void session.newWindow(worktreeQuery(mark)).catch((e) =>
        console.warn("scm: could not open the worktree's window", e)
      );
      return;
    }
    openTile({ kind: "shell", sandbox: false, cwd: mark.path });
  }, [backend, openTile]);

  const { openInEditor, agents, platform } = o;
  const terminals = state.terminals;
  const hooks = useMemo<ScmTileHooks | undefined>(() => {
    if (!client || !backend) return undefined;
    return {
      client,
      platform,
      setTile: (id, patch) => dispatch({ type: "scmTile", id, patch }),
      followRoot,
      tick,
      terminalFolders: async () => {
        if (!manager) return [];
        const dirs = await Promise.all(
          terminals.filter(localTerminal).map((t) =>
            manager.cwd(t.id).catch(() => undefined)
          ),
        );
        return [...new Set(dirs.filter((d): d is string => !!d))];
      },
      agentPaths: (root) => {
        const out = new Set<string>();
        const store = agents.current?.store;
        if (!store) return out;
        for (const t of terminals) {
          if (!t.chat) continue;
          const st = store.get(t.id);
          const tr = st?.snap?.transcript;
          if (!tr) continue;
          const cwd = tr.cwd ?? t.chat.cwd;
          for (const f of sessionChanges(tr.rows, cwd, st?.reviewed)) {
            if (isInside(f.path, root)) out.add(f.path.slice(root.length + 1));
          }
        }
        return out;
      },
      openFile: (path) => openInEditor(path),
      reveal: (path) =>
        void backend.linkOpen({ kind: "reveal", path }).catch((e) =>
          console.warn("scm: reveal failed", e)
        ),
      openTerminal: (cwd) =>
        void openTile({ kind: "shell", sandbox: false, cwd }),
      openScm: (root) => openScm(root),
      openWorktree,
      worktreeFolder: state.settings.scm.worktreeFolder,
    };
  }, [
    client,
    backend,
    manager,
    platform,
    dispatch,
    followRoot,
    tick,
    terminals,
    agents,
    openInEditor,
    openTile,
    openScm,
    openWorktree,
    state.settings.scm.worktreeFolder,
  ]);

  return {
    hooks,
    openedFor,
    openFor,
    openForFocused,
    /** An agent finished a turn: Source Control tiles refresh. */
    agentTurnEnded: () => setTick((n) => n + 1),
  };
}
