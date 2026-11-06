/**
 * What goes into Loopy's bubble, besides `qutty-hook say` messages: an agent's `ask_user`
 * question (buttons that answer the waiting caller) and the companion's own replies (streamed in
 * as the brain writes them). Pure mappings from the hub's shapes to the bubble's
 * {@linkcode LoopyMessage}, so the overlay stays thin and the rules are unit-tested.
 *
 * Client-safe.
 *
 * @module
 */

import type { AskRequest } from "../hub/protocol.ts";
import { type LoopyMessage, readingTimeMs } from "./messages.ts";
import type { CompanionUpdate } from "./protocol.ts";

/** The longest text a bubble shows (it scrolls; a reply is cut here). */
const MAX_BUBBLE_TEXT = 4000;
/** The longest button label. */
const MAX_LABEL = 40;
/** The longest a finished reply stays up by itself. */
const MAX_REPLY_MS = 30_000;

/** The bubble id of `ask_user` question `askId`. */
export const askBubbleId = (askId: string) => `ask:${askId}`;
/** The `ask_user` question id of a bubble, if it is one. */
export const askIdOf = (bubbleId: string) =>
  bubbleId.startsWith("ask:") ? bubbleId.slice(4) : undefined;
/** The bubble id of the companion's turn `turn`. */
const turnBubbleId = (turn: number) => `turn:${turn}`;

/** An `ask_user` question as a bubble: who asks, the text, one button per action. */
export function askBubble(request: AskRequest): LoopyMessage {
  const labels = request.actions.length > 0 ? request.actions : ["OK"];
  return {
    id: askBubbleId(request.id),
    kind: "ask",
    from: request.fromName,
    text: request.text.slice(0, MAX_BUBBLE_TEXT),
    mood: "attention",
    actions: labels.map((label, i) => ({
      id: `a${i}`,
      label: label.slice(0, MAX_LABEL),
    })),
    timeoutMs: 0,
  };
}

/** The answer a button of an `ask_user` bubble gives: the question's own label (not the cut one). */
export function askAnswer(
  request: AskRequest | undefined,
  bubble: LoopyMessage,
  actionId: string | null,
): string | null {
  if (actionId === null) return null;
  const i = Number(actionId.slice(1));
  const labels = request && request.actions.length > 0
    ? request.actions
    : ["OK"];
  return labels[i] ?? bubble.actions.find((a) => a.id === actionId)?.label ??
    null;
}

/** How long a finished reply stays up: twice the reading time, at most 30 s. */
export function replyTimeoutMs(text: string): number {
  return Math.min(MAX_REPLY_MS, readingTimeMs(text) * 2);
}

/**
 * The bubble for a `turn` update: the whole message to show (`enqueue` when new, `update` when
 * on screen already), or `null` when the turn shows nothing — a turn on agents' messages shows
 * only once it is done, and not when the brain said `(quiet)`. A user turn shows at once: `…`
 * while the brain thinks, then the text as it streams.
 */
export function turnBubble(
  update: Extract<CompanionUpdate, { kind: "turn" }>,
): LoopyMessage | null {
  if (update.source === "mail" && (!update.done || update.quiet)) return null;
  const text = (update.text || (update.done ? "" : "…")).slice(
    0,
    MAX_BUBBLE_TEXT,
  );
  if (!text) return null;
  return {
    id: turnBubbleId(update.turn),
    kind: "reply",
    text,
    mood: !update.done ? "thinking" : update.isError ? "attention" : "neutral",
    actions: [],
    timeoutMs: update.done ? replyTimeoutMs(text) : 0,
  };
}
