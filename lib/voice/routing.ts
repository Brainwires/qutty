/**
 * Where a transcript goes. With "Dictate into focused tile" on, it is typed into the focused tile
 * as it is, with no model involved. Otherwise it goes to the companion (`userSays(text, "voice")`),
 * which decides whether to answer, act on a tile (`write_tile`) or forward it to an agent
 * (`send_message`); "summarize the window" (or "what's going on?") becomes the summary request the
 * Summarize button sends.
 *
 * Client-safe and pure.
 *
 * @module
 */

import { DEFAULT_COMPANION_NAME } from "../companion/settings.ts";

/** What to do with a transcript. */
export type VoiceRoute =
  /** Nothing was heard. */
  | { kind: "empty" }
  /** Type `text` into the focused tile (no model). */
  | { kind: "dictate"; text: string }
  /** Ask the companion for a short spoken summary of every tile. */
  | { kind: "summarize" }
  /** Hand `text` to the companion. */
  | { kind: "companion"; text: string };

/**
 * What the companion is asked by the Summarize button and the summary phrases. It answers briefly:
 * the answer may be read aloud.
 */
export const SUMMARIZE_PROMPT =
  "Summarize the window: read every tile (list_peers, then read_screen for each) and tell me in " +
  "two or three short sentences what is going on, most important first. Plain sentences, no " +
  "lists or markdown: this is read aloud.";

/** `text` with every regular expression metacharacter escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * The phrases that ask for the summary ("summarize the window", "what's going on?"), optionally
 * addressed to the companion by `name`, "qutty" or "companion" ("hey Companion, what's going on?").
 */
function summaryPhrase(name: string): RegExp {
  const names = [name.trim(), "qutty", "companion"].filter((n) => n !== "")
    .map(escapeRegExp).join("|");
  return new RegExp(
    `^(?:(?:hey |ok |okay )?(?:${names})[,.]?\\s+)?(?:please\\s+)?(?:summari[sz]e(?: (?:the|this|my))? (?:window|tiles|screens?|terminals?)|give me a summary|status report|what(?:'s| is) (?:going on|happening))(?: (?:here|now|in (?:the|this) window))?(?: please)?[.!?]*$`,
    "i",
  );
}

/**
 * Whether `text` asks for the window summary; `name` is the companion's (Settings → Companion →
 * Name), which it may be addressed by.
 */
export function isSummaryRequest(
  text: string,
  name: string = DEFAULT_COMPANION_NAME,
): boolean {
  return summaryPhrase(name).test(text.trim());
}

/** Whisper's markers for no speech (`[BLANK_AUDIO]`, `(silence)`, `[Music]`…). */
const NON_SPEECH = /\[[^\]]*\]|\((?:silence|music|inaudible|noise)[^)]*\)/gi;

/** A transcript cleaned up: non-speech markers dropped, whitespace collapsed. */
export function cleanTranscript(text: string): string {
  return text.replace(NON_SPEECH, " ").replace(/\s+/g, " ").trim();
}

/**
 * Text to type into a terminal: one line (a newline would run a half-dictated command), and the
 * sentence's final full stop dropped (`ls -la.` is not what was meant). Never adds Enter.
 */
export function dictationText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/(?<!\.)\.$/, "").trim();
}

/**
 * Route transcript `raw`: dictate mode types it; otherwise a summary request (addressed by
 * `opts.name`, the companion's name, or none) or the companion.
 */
export function routeTranscript(
  raw: string,
  opts: { dictate: boolean; name?: string },
): VoiceRoute {
  const text = cleanTranscript(raw);
  if (!text) return { kind: "empty" };
  if (opts.dictate) {
    const typed = dictationText(text);
    return typed ? { kind: "dictate", text: typed } : { kind: "empty" };
  }
  if (isSummaryRequest(text, opts.name)) return { kind: "summarize" };
  return { kind: "companion", text };
}
