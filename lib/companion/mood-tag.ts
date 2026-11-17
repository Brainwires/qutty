/**
 * The brain's mood tag: a reply may start with `[mood: blush]` (any of the companion's moods, or
 * an alias of one: lib/companion/messages.ts), which sets the face the companion wears while the
 * reply is on screen. The tag is never shown or read aloud: the runtime (lib/companion/runtime.ts)
 * takes it off the text before the bubble, the voice and the activity see it, and hides a tag that
 * is still streaming in (`[mo`, `[mood: bl`).
 *
 * Client-safe and pure.
 *
 * @module
 */

import { type FaceMood, MOODS } from "./face-machine.ts";
import { MOOD_ALIASES } from "./messages.ts";

/** A reply with its mood tag taken off. */
export interface MoodTagged {
  /** The text to show (without the tag and the space after it). */
  readonly text: string;
  /** The mood the tag names, when it names one. */
  readonly mood?: FaceMood;
}

/** A whole tag at the start: `[mood: blush]`, `[Mood=love]`, `[mood blush]`. */
const TAG = /^\s*\[\s*mood(?:\s*[:=]|\s)\s*([A-Za-z-]*)\s*\]\s*/i;

/** The start of a tag still streaming in: `[`, `[mo`, `[mood:`, `[mood: bl`. */
const PARTIAL =
  /^\s*\[\s*(?:m(?:o(?:o(?:d(?:(?:\s*[:=]|\s)\s*[A-Za-z-]*\s*)?)?)?)?)?$/i;

/** `name` as one of the companion's moods (or an alias of one), else `undefined`. */
function moodNamed(name: string): FaceMood | undefined {
  const key = name.toLowerCase();
  if ((MOODS as readonly string[]).includes(key)) return key as FaceMood;
  return Object.hasOwn(MOOD_ALIASES, key) ? MOOD_ALIASES[key] : undefined;
}

/**
 * The reply `raw` without its leading mood tag, and the mood the tag names. An unknown mood's tag
 * is still taken off (no mood). While a reply streams in (`streaming`), a beginning that may yet
 * become a tag shows as nothing; once the reply is done it shows as it is.
 */
export function splitMoodTag(raw: string, streaming = false): MoodTagged {
  const m = TAG.exec(raw);
  if (m) {
    const mood = moodNamed(m[1]);
    const text = raw.slice(m[0].length);
    return mood ? { text, mood } : { text };
  }
  if (streaming && PARTIAL.test(raw)) return { text: "" };
  return { text: raw };
}
