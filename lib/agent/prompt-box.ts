/**
 * The agent tile's prompt box, the parts without a DOM (app/agent-tile.tsx draws it): the prompt
 * history (↑ / ↓ at the caret's ends, and its menu), the saved prompts, inserting at the caret,
 * and the last reply (what the side rail reads aloud).
 *
 * Both lists are kept oldest first and stored as JSON arrays of strings (the tile keeps them in
 * `localStorage`; {@linkcode parsePromptList} reads them back, whatever was stored).
 *
 * @module
 */

import type { Row } from "./transcript.ts";

/** The localStorage keys (bump the suffix when the shape changes incompatibly). */
export const HISTORY_STORAGE_KEY = "qutty.agentPrompts.history.v1";
export const SAVED_STORAGE_KEY = "qutty.agentPrompts.saved.v1";

/** The most prompts the history keeps. */
export const HISTORY_MAX = 100;
/** The most saved prompts. */
export const SAVED_MAX = 50;
/** The longest prompt kept in either list (characters). */
const ITEM_MAX = 20_000;

/** `text` added as the newest entry of `list` (an equal older one moves up); at most `max`. */
export function pushPrompt(
  list: readonly string[],
  text: string,
  max = HISTORY_MAX,
): string[] {
  const t = text.trim();
  if (!t || t.length > ITEM_MAX) return [...list];
  const out = list.filter((s) => s !== t);
  out.push(t);
  return out.slice(Math.max(0, out.length - max));
}

/**
 * The history ↑ walks: the stored one (every tile's prompts) with this tile's own prompts on top,
 * so its own come back first.
 */
export function mergeHistory(
  stored: readonly string[],
  own: readonly string[],
): string[] {
  return own.reduce((list, p) => pushPrompt(list, p), [...stored]);
}

/** A stored list of prompts (JSON), or `[]`: strings only, trimmed, no repeats, at most `max`. */
export function parsePromptList(
  raw: string | null | undefined,
  max: number,
): string[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.reduce<string[]>(
    (list, v) => typeof v === "string" ? pushPrompt(list, v, max) : list,
    [],
  );
}

/** A saved prompt added (at the end; an equal one moves there). */
export function addSaved(list: readonly string[], text: string): string[] {
  return pushPrompt(list, text, SAVED_MAX);
}

/** Saved prompt `i` removed. */
export function removeSaved(list: readonly string[], i: number): string[] {
  return list.filter((_, j) => j !== i);
}

/**
 * Whether ↑ (`up`) or ↓ (`down`) at this caret walks the history instead of moving the caret:
 * the selection is empty and at the text's start (↑) or end (↓); in one-line text (where the
 * arrow would only jump to an end) either end.
 */
export function recallsHistory(
  dir: "up" | "down",
  value: string,
  start: number,
  end: number,
): boolean {
  if (start !== end) return false;
  const oneLine = !value.includes("\n");
  if (dir === "up") return start === 0 || (oneLine && start === value.length);
  return start === value.length || (oneLine && start === 0);
}

/**
 * One step through `history` (oldest first). `index` counts back from the newest (-1: the draft,
 * what was typed before recalling). `null`: no step (the oldest reached, or ↓ on the draft).
 */
export function historyStep(
  history: readonly string[],
  index: number,
  dir: "up" | "down",
  draft: string,
): { index: number; text: string } | null {
  const next = dir === "up" ? index + 1 : index - 1;
  if (next < -1 || next >= history.length || (dir === "down" && index < 0)) {
    return null;
  }
  return {
    index: next,
    text: next < 0 ? draft : history[history.length - 1 - next],
  };
}

/** `insert` put in place of `value`'s selection; the new text and where the caret goes. */
export function insertAtCaret(
  value: string,
  start: number,
  end: number,
  insert: string,
): { value: string; caret: number } {
  const a = Math.max(0, Math.min(start, value.length));
  const b = Math.max(a, Math.min(end, value.length));
  return {
    value: value.slice(0, a) + insert + value.slice(b),
    caret: a + insert.length,
  };
}

/**
 * The agent's last reply: the run of text rows that ends its latest turn with any (the answer
 * after its last tool call; thinking, notices and the footer between do not break it), as one
 * markdown string; `""` when it has said nothing yet.
 */
export function lastReply(rows: readonly Row[]): string {
  const parts: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.type === "text") {
      if (r.text.trim()) parts.unshift(r.text);
    } else if (
      (r.type === "user" || r.type === "tool" || r.type === "permission") &&
      parts.length > 0
    ) break;
  }
  return parts.join("\n\n");
}
