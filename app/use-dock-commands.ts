// The Dock menu's commands, the page's half (desktop/dock-menu.ts has the app process's): New
// Terminal, Terminal → Claude Code / Codex and Coding → Claude Code / Codex chosen in the Dock
// menu reach the frontmost window's page, which takes them once it is up (a window the Dock menu
// just opened included) and whenever it is told more wait. Each command is taken once, so a
// reload never runs one again.

import { useEffect, useRef } from "denext";
import type { DockCommand, DockCommands } from "../lib/session-client.ts";

/** What each command does in this window. */
export interface DockCommandHandlers {
  /** New Terminal: what ⌘T does. */
  newTerminal(): void;
  /** Coding → Claude Code: a new agent tile (its folder asked first). */
  agentChat(): void;
  /** Coding → Codex: a new agent tile on Codex (its folder asked first). */
  codexChat(): void;
  /** Terminal → Claude Code or Codex: the tool in a new terminal, as the `+` menu starts it. */
  agentTerminal(name: "claude" | "codex"): void;
}

/**
 * Run `commands` through `handlers`, in order. While a modal dialog has the keyboard they are
 * dropped, as the native menus' items are (lib/workspace/menus.ts `menuActionAllowed`).
 */
export function runDockCommands(
  commands: readonly DockCommand[],
  handlers: DockCommandHandlers,
  modalOpen: boolean,
): void {
  if (modalOpen) return;
  for (const command of commands) {
    if (command === "newTerminal") handlers.newTerminal();
    else if (command === "agentChat") handlers.agentChat();
    else if (command === "codexChat") handlers.codexChat();
    else if (command === "claudeTerminal") handlers.agentTerminal("claude");
    else if (command === "codexTerminal") handlers.agentTerminal("codex");
  }
}

/** Take this window's Dock menu commands from `source` (absent: no Dock menu) and run them. */
export function useDockCommands(opts: {
  source: DockCommands | undefined;
  handlers: DockCommandHandlers;
  modalOpen: boolean;
}): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { source } = opts;
  useEffect(() => {
    if (!source) return;
    let live = true;
    const drain = () => {
      source.take().then((commands) => {
        if (!live) return;
        const o = optsRef.current;
        runDockCommands(commands, o.handlers, o.modalOpen);
      }, (err) => console.warn("dock menu: could not take the commands", err));
    };
    const off = source.onWaiting(drain);
    drain();
    return () => {
      live = false;
      off();
    };
  }, [source]);
}
