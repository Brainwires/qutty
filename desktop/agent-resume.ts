// What the shell keeper (desktop/kept-shells.ts, in the `pty` extension) needs from the agent hub
// (desktop/hub.ts, the `hub` extension) to resume agents after a restart: the agent session each
// terminal runs (recorded at the quit), the arguments that join a resumed agent to the hub, and a
// way to mark a tile "resumed". The hub installs it when it starts; the keeper asks for it when it
// needs it, so neither extension imports the other (lib/agent/resume.ts has the logic).

import type { TileAgentState } from "../lib/agent/resume.ts";

/** The hub's side. */
export interface AgentResumeProvider {
  /** What the hub knows about terminal `ptyId`'s agent (`undefined`: no such tile). */
  agentOf(ptyId: string): TileAgentState | undefined;
  /** The arguments that join `harness` to the hub (none when the user-scope integration does). */
  hubArgs(harness: string): string[];
  /** Terminal `ptyId` resumed an agent: its tile says so until the agent gets busy. */
  resumed(ptyId: string): void;
}

const KEY = Symbol.for("qutty.agentResumeProvider");

/** Install (or with `undefined` remove) the hub's side. */
export function setAgentResumeProvider(
  p: AgentResumeProvider | undefined,
): void {
  (globalThis as Record<symbol, AgentResumeProvider | undefined>)[KEY] = p;
}

/** The hub's side, when the hub runs. */
export function agentResumeProvider(): AgentResumeProvider | undefined {
  return (globalThis as Record<symbol, AgentResumeProvider | undefined>)[KEY];
}
