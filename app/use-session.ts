// The window's workspace (lib/session-client.ts): on boot the page joins the workspace its window
// shows and rebuilds it — every terminal on its running PTY, redrawn from its replay, with the
// layout, MRU order and focus it had — or, for a new workspace, opens its first shell. As the
// workspace changes its snapshot is saved in the app's process (debounced, and flushed when the
// page goes away). Also: the quit question.

import { useCallback, useEffect, useRef, useState } from "denext";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { QuitRequest, SessionJoined } from "../lib/session-client.ts";
import { planRestore, snapshotOf } from "../lib/workspace/session.ts";
import type {
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
  /** The "agents are busy, quit anyway?" question, when one is open. */
  quit: QuitRequest | null;
  answerQuit(quit: boolean): void;
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
    o.fresh();
  }, []);

  // Join once the manager exists.
  useEffect(() => {
    if (!manager) return;
    const session = manager.backend.session;
    let live = true;
    const offQuit = session.onQuit((r) => setQuit(r));
    session.join().then((joined) => {
      if (!live) return;
      apply(manager, joined);
      setBooted(true);
      setWorkspace(joined.workspace);
      if (joined.quit) setQuit(joined.quit);
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
    quit,
    answerQuit: (yes) => {
      setQuit(null);
      void session?.answerQuit(yes).catch(() => {});
    },
  };
}
