/**
 * Voice mode (Settings → Voice / Companion → Voice mode): what the companion's bubble says aloud.
 * The rules behind app/companion/use-bubble-speech.ts:
 *
 * - {@linkcode bubbleSpeech}: the words for a whole bubble — a `say` message, an agent's question
 *   with its buttons ("codex asks: Deploy now? Options: Yes, No."), the quote of the day with its
 *   author, an encouraging line. Agents' mail turns and errors (`brief`) are read as a short
 *   summary, not the whole text.
 * - {@linkcode StreamSpeech}: a reply streaming in, said sentence by sentence as each one ends
 *   (never in the middle of a code block, which is read as "code omitted"), and cut off after
 *   {@linkcode MAX_STREAM_SPOKEN} characters with a note that the rest is on screen.
 *
 * The text is cleaned first (lib/voice/tts.ts `cleanSpeech`): no markdown, code or URLs read out.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { CompanionMessage } from "../companion/messages.ts";
import { cleanSpeech, cutAtSentence } from "./tts.ts";

/** The longest summary of a brief bubble, characters. */
const BRIEF_MAX = 160;
/** The longest question read out with its buttons, characters. */
const ASK_MAX = 240;
/** The longest whole bubble read out, characters. */
const SAY_MAX = 600;
/** How much of a streamed reply is read before "the rest is on screen", characters. */
export const MAX_STREAM_SPOKEN = 1200;
/** What is said when a streamed reply is cut off. */
export const REST_ON_SCREEN = "The rest is on screen.";

/** Whether a bubble streams in (the companion's replies): read with {@linkcode StreamSpeech}. */
function streamsIn(message: CompanionMessage): boolean {
  return message.kind === "reply" && message.brief !== true;
}

/** A brief bubble's summary: its first sentence or so. */
function summary(text: string): string {
  return cutAtSentence(cleanSpeech(text), BRIEF_MAX);
}

/** The buttons as said ("Options: Yes, No."), or "" for a lone OK. */
function options(message: CompanionMessage): string {
  const labels = message.actions.map((a) => a.label);
  if (labels.length === 0 || (labels.length === 1 && labels[0] === "OK")) {
    return "";
  }
  return ` Options: ${labels.join(", ")}.`;
}

/** The words for a whole bubble (`""`: nothing to say). */
export function bubbleSpeech(message: CompanionMessage): string {
  if (message.kind === "ask") {
    const who = message.from ? `${message.from} asks` : "A question";
    const text = cutAtSentence(cleanSpeech(message.text), ASK_MAX);
    return `${who}: ${text}${options(message)}`;
  }
  if (message.brief) {
    const text = summary(message.text);
    if (!text) return "";
    return message.mood === "sad" ? `Something went wrong: ${text}` : text;
  }
  const text = cutAtSentence(cleanSpeech(message.text), SAY_MAX);
  if (!text) return "";
  return message.cite ? `${text} — ${message.cite}` : text;
}

/** Where a sentence or line ends (the position after it). */
const BOUNDARY = /[.!?](?=\s)|\n/g;

/** Whether `text` up to `end` has an unclosed code fence. */
function insideFence(text: string, end: number): boolean {
  return (text.slice(0, end).match(/```/g)?.length ?? 0) % 2 === 1;
}

/** The end of the last whole sentence of `text` after `from` (outside code), or `from`. */
function lastBoundary(text: string, from: number): number {
  let end = from;
  BOUNDARY.lastIndex = from;
  for (let m = BOUNDARY.exec(text); m; m = BOUNDARY.exec(text)) {
    const at = m.index + m[0].length;
    if (!insideFence(text, at)) end = at;
  }
  return end;
}

/**
 * A streaming reply said as it arrives: give it the whole text so far each time it grows
 * ({@linkcode next}); it answers what to say now — the sentences that ended since — once.
 */
export class StreamSpeech {
  #said = 0;
  #spoken = 0;
  #full = false;

  /**
   * What to say of `text` (the reply so far) now: the sentences finished since the last call, or
   * with `done` everything left. `[]` when nothing new is ready.
   */
  next(text: string, done: boolean): string[] {
    if (this.#full) return [];
    const end = done ? text.length : lastBoundary(text, this.#said);
    if (end <= this.#said) return [];
    const chunk = cleanSpeech(text.slice(this.#said, end));
    this.#said = end;
    if (!chunk || chunk === "…") return [];
    if (this.#spoken + chunk.length > MAX_STREAM_SPOKEN) {
      this.#full = true;
      return [REST_ON_SCREEN];
    }
    this.#spoken += chunk.length;
    return [chunk];
  }
}

/** The bubble being said. */
export interface BubbleSaying {
  readonly id: string;
  /** The user's speech-cut count when it started: once it moves, this bubble says no more. */
  readonly cut: number;
  /** A streaming reply's reader (`null`: said whole, once). */
  readonly stream: StreamSpeech | null;
}

/** One thing to say: `replace` cuts off what is being said first. */
export interface SpeechStep {
  readonly text: string;
  readonly replace: boolean;
}

/**
 * What to say now that the bubble on screen is `current` (after `saying`), with the user's speech
 * cut count at `cut`. A new bubble replacing one that was said cuts it off (with nothing to say
 * yet, an empty step still cuts; an alert said meanwhile with no bubble before is not cut); a
 * bubble said whole is said once; a stream says its new sentences, unless the user cut it off
 * since it began.
 */
export function planBubbleSpeech(
  saying: BubbleSaying | null,
  current: CompanionMessage | undefined,
  cut: number,
): { saying: BubbleSaying | null; steps: SpeechStep[] } {
  if (!current) return { saying, steps: [] };
  let now = saying;
  let replace = false;
  if (now?.id !== current.id) {
    replace = now !== null;
    now = {
      id: current.id,
      cut,
      stream: streamsIn(current) ? new StreamSpeech() : null,
    };
    if (!now.stream) {
      const text = bubbleSpeech(current);
      return { saying: now, steps: text || replace ? [{ text, replace }] : [] };
    }
  }
  if (!now.stream || cut !== now.cut) return { saying: now, steps: [] };
  const parts = now.stream.next(current.text, current.timeoutMs > 0);
  const steps = parts.map((text, i) => ({ text, replace: replace && i === 0 }));
  if (steps.length === 0 && replace) steps.push({ text: "", replace: true });
  return { saying: now, steps };
}
