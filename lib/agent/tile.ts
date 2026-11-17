/**
 * An agent tile as the workspace keeps it: the entry's `chat` (where it runs, which model, which
 * Claude Code session, which hub session it had) and what is saved of it; the models the header
 * offers; and which group the Agents panel lists a tile under (Needs you, To review, Working).
 *
 * Client-safe and pure.
 *
 * @module
 */

import { PERMISSION_MODES, type PermissionMode } from "./adapter.ts";
import { isModelName, isSessionId } from "./claude-stream.ts";
import type { Transcript } from "./transcript.ts";

/** An agent tile's entry data (lib/workspace/store.ts `TerminalEntry.chat`). */
export interface AgentChat {
  /** Its working folder (`~` until the backend says where). */
  cwd: string;
  /** The model alias picked in the header (absent: the user's default). */
  model?: string;
  /** Claude Code's session id, once the first turn reported it (`--resume` on reopen). */
  session?: string;
  /** The hub session it had (`agent-3`): a page that comes back attaches to it. */
  agentId?: string;
  /** Its permission mode (absent: default). */
  mode?: PermissionMode;
  /** Turns finished (each one saves the workspace: its transcript changed). */
  turns?: number;
}

/** A stored / untrusted `chat`, or `undefined`. */
export function sanitizeChat(raw: unknown): AgentChat | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.cwd !== "string" || !r.cwd || r.cwd.length > 4096) {
    return undefined;
  }
  const mode = PERMISSION_MODES.find((m) => m === r.mode);
  return {
    cwd: r.cwd,
    ...(typeof r.model === "string" && isModelName(r.model)
      ? { model: r.model }
      : {}),
    ...(typeof r.session === "string" && isSessionId(r.session)
      ? { session: r.session }
      : {}),
    ...(typeof r.agentId === "string" && /^agent-\d+$/.test(r.agentId)
      ? { agentId: r.agentId }
      : {}),
    ...(mode && mode !== "default" ? { mode } : {}),
    ...(typeof r.turns === "number" && Number.isFinite(r.turns)
      ? { turns: r.turns }
      : {}),
  };
}

/** A model the header's picker offers. */
export interface AgentModel {
  /** What goes to `--model` (`""`: the user's default). */
  id: string;
  label: string;
}

/**
 * The picker's models: Claude Code's aliases (`claude --help`: "an alias for the latest model
 * (e.g. 'fable', 'opus', or 'sonnet') or a model's full name"), with the 1M-context variants.
 */
export const AGENT_MODELS: readonly AgentModel[] = [
  { id: "", label: "default" },
  { id: "fable", label: "fable" },
  { id: "opus", label: "opus" },
  { id: "opus[1m]", label: "opus 1M" },
  { id: "sonnet", label: "sonnet" },
  { id: "sonnet[1m]", label: "sonnet 1M" },
  { id: "haiku", label: "haiku" },
];

/** The header's short name for `model` (an alias's label, else the name without `claude-`). */
export function modelLabel(model: string | undefined): string {
  if (!model) return "default";
  const known = AGENT_MODELS.find((m) => m.id === model);
  if (known) return known.label;
  return model.replace(/^claude-/, "").replace(/\[1m\]$/, " 1M");
}

/** The Agents panel's groups, in its order. */
export type AgentGroup = "needs" | "review" | "working" | "idle";

export const AGENT_GROUPS: readonly { id: AgentGroup; label: string }[] = [
  { id: "needs", label: "Needs you" },
  { id: "review", label: "To review" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
];

/**
 * Where an agent tile goes: it needs you while it asks a question or after a failure; it works
 * while a turn runs; it is to review when a turn finished and you have not looked since.
 */
export function agentGroup(
  t: Pick<Transcript, "asking" | "running" | "error" | "exited"> | undefined,
  review: boolean,
): AgentGroup {
  if (!t) return "idle";
  if (t.asking.length > 0 || (!t.running && t.error)) return "needs";
  if (t.running) return "working";
  if (review) return "review";
  return "idle";
}

/** A tile's status in a few words ("asks to run Bash", "working", "to review"). */
export function groupText(group: AgentGroup): string {
  switch (group) {
    case "needs":
      return "needs you";
    case "review":
      return "to review";
    case "working":
      return "working";
    case "idle":
      return "idle";
  }
}
