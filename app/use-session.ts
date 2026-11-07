// The window's workspace (lib/session-client.ts): on boot the page joins the workspace its window
// shows and rebuilds it — every terminal on its running PTY, redrawn from its replay, with the
// layout, MRU order and focus it had — or, for a new workspace, opens its first shell. As the
// workspace changes its snapshot is saved in the app's process (debounced, and flushed when the
// page goes away), and its layout in localStorage for the next launch. Also: the workspace list
// for the Workspaces menu, and the quit question.

import { useCallback, useEffect, useRef, useState } from "denext";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type {
  QuitRequest,
  SessionJoined,
  WorkspaceInfo,
} from "../lib/session-client.ts";
import {
  loadWorkspaceLayout,
  planRestore,
  saveWorkspaceLayout,
  snapshotOf,
} from "../lib/workspace/session.ts";
import type {
  SettingsStorage,
  WorkspaceAction,
  WorkspaceState,
} from "../lib/workspace/store.ts";
import { SHELL_PROFILE } from "../lib/ssh-ui.ts";

/** How long the snapshot waits for a burst of changes to settle before it is saved. */
const SAVE_DEBOUNCE_MS = 250;

export interface SessionView {
  /** The workspace was rebuilt, or its first shell opened (the empty state may show). */
  booted: boolean;
  /** This window's workspace, once joined. */
  workspace: { id: string; name: string } | null;
  /** Every workspace (the Workspaces menu), freshest first. */
  workspaces: WorkspaceInfo[];
  multiWindow: boolean;
  /** The "agents are busy, quit anyway?" question, when one is open. */
  quit: QuitRequest | null;
  answerQuit(quit: boolean): void;
  reopen(id: string): void;
  newWindow(): void;
  /** End workspace `id` for real (this window's: then the window closes too). */
  end(id: string): void;
}

function storage(): SettingsStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function useSession(opts: {
  /** Set once the terminal manager exists (the page is ready). */
  manager: TerminalManager | null;
  state: WorkspaceState;
  /** The tile id counter (`t<n>`). */
  seqRef: { current: number };
  dispatch(action: WorkspaceAction): void;
  focus(id: string): void;
  /** A new workspace: open its first shell. */
  fresh(): void;
}): SessionView {
  const { manager } = opts;
  const [workspace, setWorkspace] = useState<SessionView["workspace"]>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [quit, setQuit] = useState<QuitRequest | null>(null);
  const [booted, setBooted] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** Rebuild the workspace from what `join` brought (or start it). */
  const apply = useCallback((m: TerminalManager, joined: SessionJoined) => {
    const o = optsRef.current;
    const plan = planRestore(joined.snapshot, joined.ptys);
    if (plan) {
      for (const t of plan.tiles) m.adopt(t.id, t.profile, t.pty, t.home);
      o.seqRef.current = Math.max(o.seqRef.current, plan.seq);
      o.dispatch({
        type: "restore",
        terminals: plan.terminals,
        mru: plan.mru,
        ...(plan.layout ? { layout: plan.layout } : {}),
        previousPattern: plan.previousPattern,
      });
      if (plan.mru[0]) o.focus(plan.mru[0]);
      return;
    }
    // A workspace window an earlier launch had open gets its layout back (with a fresh shell).
    // Only with several windows: with one, the settings' own layout is the window's.
    const stored = m.backend.session.multiWindow
      ? loadWorkspaceLayout(joined.workspace.id, storage())
      : null;
    if (stored) {
      o.dispatch({
        type: "restore",
        terminals: [],
        mru: [],
        layout: stored.layout,
        previousPattern: stored.previousPattern,
      });
    }
    o.fresh();
  }, []);

  // Join once the manager exists.
  useEffect(() => {
    if (!manager) return;
    const session = manager.backend.session;
    let live = true;
    const offQuit = session.onQuit((r) => setQuit(r));
    const offChanged = session.onChanged(setWorkspaces);
    session.join().then((joined) => {
      if (!live) return;
      apply(manager, joined);
      setBooted(true);
      setWorkspace(joined.workspace);
      if (joined.quit) setQuit(joined.quit);
      void session.list().then((l) => live && setWorkspaces(l), () => {});
    }, (err) => {
      // No workspace (an old backend): the page works as a plain window.
      console.warn("session: could not join the workspace", err);
      if (!live) return;
      optsRef.current.fresh();
      setBooted(true);
    });
    const onFocus = () => void session.focus().catch(() => {});
    globalThis.addEventListener("focus", onFocus);
    return () => {
      live = false;
      offQuit();
      offChanged();
      globalThis.removeEventListener("focus", onFocus);
    };
  }, [manager, apply]);

  // Save the snapshot as the workspace changes (and flush it when the page goes away).
  const { terminals, mru, previousPattern } = opts.state;
  const layout = opts.state.settings.layout;
  useEffect(() => {
    if (!manager || !workspace) return;
    const save = () => {
      const o = optsRef.current;
      const snap = snapshotOf(o.state, o.seqRef.current, (id) => ({
        ptyId: manager.ptyId(id),
        profile: manager.profile(id) ?? SHELL_PROFILE,
        ...(manager.home(id) !== undefined ? { home: manager.home(id) } : {}),
      }));
      void manager.backend.session.save(snap).catch(() => {});
      if (!manager.backend.session.multiWindow) return;
      saveWorkspaceLayout(workspace.id, {
        layout: snap.layout,
        previousPattern: snap.previousPattern,
      }, storage());
    };
    const timer = setTimeout(save, SAVE_DEBOUNCE_MS);
    globalThis.addEventListener("pagehide", save);
    return () => {
      clearTimeout(timer);
      globalThis.removeEventListener("pagehide", save);
    };
  }, [manager, workspace, terminals, mru, layout, previousPattern]);

  const session = manager?.backend.session;
  return {
    booted,
    workspace,
    workspaces,
    multiWindow: session?.multiWindow === true,
    quit,
    answerQuit: (yes) => {
      setQuit(null);
      void session?.answerQuit(yes).catch(() => {});
    },
    reopen: (id) => void session?.reopen(id).catch(() => {}),
    newWindow: () => void session?.newWindow().catch(() => {}),
    end: (id) => {
      if (!session) return;
      void session.end(id).then(() => {
        if (id === workspace?.id) return session.closeWindow();
      }).catch(() => {});
    },
  };
}
