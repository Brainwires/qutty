/**
 * Which window speaks (voice mode and Speak answers), so there is never a double voice with several
 * windows open: the floating companion while it shows (the workspace windows stay quiet), else the
 * one workspace window that holds the speaker claim in shared storage — the focused or last-active
 * one: a window claims it when it gets the focus or the user's input, and gives it up when it
 * closes. With no claim at all, the focused window speaks. The DOM side: app/use-voice-speaker.ts.
 *
 * Client-safe and pure (storage is passed in).
 *
 * @module
 */

/** The part of `Storage` used here. */
export type SpeakerStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Shared storage: the id of the workspace window that speaks. */
export const SPEAKER_KEY = "qutty.voice.speaker";

/** The window holding the claim, or `null`. */
export function readSpeaker(store: SpeakerStore): string | null {
  try {
    return store.getItem(SPEAKER_KEY) || null;
  } catch {
    return null;
  }
}

/** Window `id` takes the claim (it got the focus or the user's input). */
export function claimSpeaker(store: SpeakerStore, id: string): void {
  try {
    if (store.getItem(SPEAKER_KEY) !== id) store.setItem(SPEAKER_KEY, id);
  } catch {
    // No shared storage: each window decides alone (isSpeaker's no-claim rule).
  }
}

/** Window `id` closes: it gives the claim up, if it holds it. */
export function releaseSpeaker(store: SpeakerStore, id: string): void {
  try {
    if (store.getItem(SPEAKER_KEY) === id) store.removeItem(SPEAKER_KEY);
  } catch {
    // As above.
  }
}

/** What decides whether a workspace window speaks. */
export interface SpeakerInputs {
  /** This window's id. */
  readonly self: string;
  /** The window holding the claim (`null`: none). */
  readonly holder: string | null;
  /** The floating companion shows: it speaks, no workspace window does. */
  readonly floatingShowing: boolean;
  /** This window has the focus. */
  readonly focused: boolean;
}

/** Whether this workspace window speaks. */
export function isSpeaker(i: SpeakerInputs): boolean {
  if (i.floatingShowing) return false;
  return i.holder === null ? i.focused : i.holder === i.self;
}
