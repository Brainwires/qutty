// The workspace's agent tiles, wired in one place so app/workspace.tsx only plugs them in: the
// store (app/use-agents.ts) with its events turned into workspace actions (the session saved in
// the entry, the name as the title, a finished turn and new output as the tile's activity), the
// hooks the tiles draw with (app/agent-tile.tsx: the terminal font and colours, links, "Open in
// terminal"), the + menu's "Claude Code (chat)" with its folder question, and the lookups the hub
// badges, the companion and dictation need.

import { useCallback, useMemo, useState } from "denext";
import type { ReactNode } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TerminalProfile } from "../lib/ssh-ui.ts";
import type {
  WorkspaceAction,
  WorkspaceState,
} from "../lib/workspace/store.ts";
import { terminalFontOptions } from "../lib/workspace/fonts.ts";
import { themeById } from "../lib/workspace/themes.ts";
import { type AgentStore, type AgentSummary, useAgents } from "./use-agents.ts";
import { AgentLaunchDialog, type AgentTileHooks } from "./agent-tile.tsx";

export interface AgentTilesView {
  store: AgentStore | null;
  summaries: AgentSummary[];
  hooks: AgentTileHooks | undefined;
  /** The hub tile of agent tile `id` (its session). */
  hubIdOf(id: string): string | undefined;
  /** The agent tile whose session is hub tile `hubId`. */
  tileOfHub(hubId: string): string | undefined;
  /** "Claude Code (chat)": ask for the folder, then open the tile. */
  openLaunch(): void;
  /** The folder question, while it is open. */
  dialog: ReactNode;
}

export function useAgentTiles(o: {
  backend: PtyBackend | null;
  manager: TerminalManager | null;
  state: WorkspaceState;
  dispatch(action: WorkspaceAction): void;
  /** Dispatch and move the keyboard (the workspace's `run`). */
  run(action: WorkspaceAction): void;
  /** The next tile id. */
  nextId(): string;
  openTile(profile: TerminalProfile): string | null;
  openUrl(url: string): void;
  closeTile(id: string): void;
  /** The keyboard goes back to the focused tile (a dialog closed). */
  refocus(): void;
  dictation?: AgentTileHooks["dictation"];
}): AgentTilesView {
  const { dispatch } = o;
  const { store, summaries } = useAgents({
    backend: o.backend,
    terminals: o.state.terminals,
    focusedId: o.state.focusedId,
    events: {
      meta: (id, patch) => dispatch({ type: "chatMeta", id, patch }),
      named: (id, title) => dispatch({ type: "title", id, title }),
      turnEnded: (id, ok) =>
        dispatch({
          type: "commandDone",
          id,
          exitCode: ok ? 0 : 1,
          now: Date.now(),
        }),
      output: (id) => dispatch({ type: "activity", id }),
    },
  });

  const [asking, setAsking] = useState<{ cwd: string } | null>(null);
  const { manager, state } = o;
  const openLaunch = useCallback(() => {
    // The folder of the focused tile when it is known (shell marks, OSC 7, the process's), else
    // the home folder.
    const focused = state.terminals.find((t) => t.id === state.focusedId);
    if (focused?.chat) return setAsking({ cwd: focused.chat.cwd });
    if (!focused || focused.web || !manager) return setAsking({ cwd: "~" });
    void manager.cwd(focused.id).then(
      (cwd) => setAsking({ cwd: cwd ?? "~" }),
      () => setAsking({ cwd: "~" }),
    );
  }, [manager, state.terminals, state.focusedId]);

  const { fontFamily, fontFamilyCustom, fontSize, lineHeight, fontWeight } =
    state.settings;
  const themeId = state.settings.theme;
  const { run, openTile, openUrl, closeTile } = o;
  const hooks = useMemo<AgentTileHooks | undefined>(() => {
    if (!store) return undefined;
    const font = terminalFontOptions({
      fontFamily,
      fontFamilyCustom,
      fontSize,
      lineHeight,
      fontWeight,
    });
    const term = themeById(themeId).terminal;
    return {
      store,
      font: {
        family: font.fontFamily,
        size: font.fontSize,
        lineHeight: font.lineHeight,
      },
      palette: {
        "--agent-fg": term.foreground,
        "--agent-red": term.red,
        "--agent-green": term.green,
        "--agent-yellow": term.yellow,
        "--agent-blue": term.blue,
        "--agent-magenta": term.magenta,
        "--agent-cyan": term.cyan,
        "--agent-dim": term.brightBlack,
      },
      openUrl,
      openInTerminal: (id) => {
        const t = state.terminals.find((e) => e.id === id);
        const session = store.get(id)?.snap?.transcript.sessionId ??
          t?.chat?.session;
        if (!t?.chat || !session) return;
        openTile({
          kind: "agent",
          program: "claude",
          name: "claude",
          label: "Claude Code",
          args: ["--resume", session],
          cwd: store.get(id)?.snap?.spec.cwd ?? t.chat.cwd,
          sandbox: false,
        });
      },
      rename: async (id, name) => {
        const got = await store.rename(id, name);
        dispatch({ type: "title", id, title: got });
      },
      close: closeTile,
      ...(o.dictation ? { dictation: o.dictation } : {}),
    };
  }, [
    store,
    fontFamily,
    fontFamilyCustom,
    fontSize,
    lineHeight,
    fontWeight,
    themeId,
    openUrl,
    openTile,
    closeTile,
    state.terminals,
    o.dictation,
  ]);

  const hubIdOf = useCallback((id: string) => store?.agentOf(id), [store]);
  const tileOfHub = useCallback((hubId: string) => store?.tileOf(hubId), [
    store,
  ]);

  const dialog = asking && (
    <AgentLaunchDialog
      initialCwd={asking.cwd}
      onCancel={() => {
        setAsking(null);
        o.refocus();
      }}
      onOpen={(cwd) => {
        setAsking(null);
        run({
          type: "add",
          id: o.nextId(),
          now: Date.now(),
          chat: { cwd },
          title: "claude",
        });
      }}
    />
  );

  return { store, summaries, hooks, hubIdOf, tileOfHub, openLaunch, dialog };
}
