/**
 * Agent presets (roles): a name and what an agent tile starts with — a system prompt added to
 * the harness's own, a model, a permission mode, the tools allowed without asking. Kept in
 * Settings (`settings.agentPresets`, edited in Settings → Agents), picked in the `+` menu and
 * the new-agent dialog; a tile copies its preset into its entry (`chat`), so it runs the same
 * after a restart even when the preset changes or goes.
 *
 * Harness-agnostic: the fields are the session spec's (lib/agent/adapter.ts); an adapter that
 * cannot take one ignores it.
 *
 * Client-safe and pure.
 *
 * @module
 */

import { PERMISSION_MODES, type PermissionMode } from "./adapter.ts";
import { isModelName } from "./claude-stream.ts";

/** One preset. */
export interface AgentPreset {
  /** Stable id (`p1`, …). */
  id: string;
  /** What the menu shows (`Reviewer`). */
  name: string;
  /** A model alias or name (absent: the user's default). */
  model?: string;
  /** Absent: default. */
  mode?: PermissionMode;
  /** Added to the harness's system prompt. */
  systemPrompt?: string;
  /** Allowed without asking (`Read`, `Bash(git diff:*)`). */
  allowedTools?: string[];
}

/** The most presets kept. */
export const MAX_PRESETS = 30;
/** The longest preset name. */
export const MAX_PRESET_NAME = 40;
/** The longest system prompt (characters). */
export const MAX_SYSTEM_PROMPT = 20_000;
/** The most allowed-tool patterns. */
const MAX_TOOLS = 40;

/** A tool name or permission pattern (`Read`, `mcp__qutty__read_screen`, `Bash(git diff:*)`). */
export function isToolPattern(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,99}(\([^()\n]{1,200}\))?$/.test(s);
}

/**
 * A typed list of tools (commas, spaces or new lines between them; a pattern's parentheses keep
 * their spaces): the well-formed ones, at most {@linkcode MAX_TOOLS}, without repeats.
 */
export function parseToolList(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const flush = () => {
    const t = cur.trim();
    cur = "";
    if (t && isToolPattern(t) && !out.includes(t)) out.push(t);
  };
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) flush();
    else cur += ch;
  }
  flush();
  return out.slice(0, MAX_TOOLS);
}

/** A system prompt kept (trimmed, at most {@linkcode MAX_SYSTEM_PROMPT}; empty: none). */
export function cleanSystemPrompt(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().slice(0, MAX_SYSTEM_PROMPT);
  return s || undefined;
}

/** Stored allowed tools kept: each a well-formed pattern, no repeats (none: `undefined`). */
export function cleanTools(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const tools: string[] = [];
  for (const t of raw) {
    const s = typeof t === "string" ? t.trim() : "";
    if (isToolPattern(s) && !tools.includes(s)) tools.push(s);
    if (tools.length >= MAX_TOOLS) break;
  }
  return tools.length ? tools : undefined;
}

/** One stored / untrusted preset, or `undefined`. */
function sanitizePreset(raw: unknown): AgentPreset | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(r.id)) {
    return undefined;
  }
  const name = typeof r.name === "string"
    ? r.name.trim().slice(0, MAX_PRESET_NAME)
    : "";
  if (!name) return undefined;
  const mode = PERMISSION_MODES.find((m) => m === r.mode);
  const systemPrompt = cleanSystemPrompt(r.systemPrompt);
  const allowedTools = cleanTools(r.allowedTools);
  return {
    id: r.id,
    name,
    ...(typeof r.model === "string" && r.model && isModelName(r.model)
      ? { model: r.model }
      : {}),
    ...(mode && mode !== "default" ? { mode } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

/** Stored / untrusted presets: the well-formed ones, ids unique, at most {@linkcode MAX_PRESETS}. */
export function sanitizePresets(raw: unknown): AgentPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentPreset[] = [];
  for (const r of raw) {
    const p = sanitizePreset(r);
    if (p && !out.some((o) => o.id === p.id)) out.push(p);
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/** A new preset's id, not one of `presets`'. */
export function nextPresetId(presets: readonly AgentPreset[]): string {
  let n = presets.length + 1;
  while (presets.some((p) => p.id === `p${n}`)) n++;
  return `p${n}`;
}
