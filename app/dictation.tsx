// Dictation feedback that does not need the companion (the hold-to-dictate key works with the
// companion off): a mic badge in the focused tile's header while a dictation listens or
// transcribes, its bar following the microphone's level, and a short note at the bottom of the tile
// area when what was said could not be typed (no focused tile, a page that can't take text, nothing
// heard, an engine that cannot run). The note fades out on its own: its CSS animation's end removes
// it (no timer).

import { useEffect, useState } from "denext";
import type { VoiceState } from "../lib/voice/controller.ts";

/** Whether `state` is a dictation that is listening or transcribing (the badge shows). */
export function dictating(state: VoiceState): boolean {
  const p = state.phase;
  return state.target === "dictate" &&
    (p === "starting" || p === "listening" || p === "transcribing");
}

/** The mic badge in the focused tile's header while a dictation listens. */
export function DictatingBadge(props: { state: VoiceState; level: number }) {
  const { state, level } = props;
  const transcribing = state.phase === "transcribing";
  return (
    <span
      class="tile-dictating"
      data-testid="tile-dictating"
      data-phase={state.phase}
      title={transcribing
        ? "Transcribing what you said"
        : "Dictating: let go of the key to type what you said here"}
      style={{ "--dictate-level": Math.min(1, Math.max(0, level)) }}
    >
      <svg
        class="tile-dictating-mic"
        viewBox="0 0 16 16"
        width="10"
        height="10"
        aria-hidden="true"
      >
        <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
        <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
      </svg>
      <span class="tile-dictating-level" aria-hidden="true" />
      <span class="tile-dictating-label">
        {transcribing ? "transcribing" : "dictating"}
      </span>
    </span>
  );
}

/**
 * Why the last dictation was not typed (`state.message` of a dictation that ended), shown until
 * its fade-out animation ends or the next capture starts.
 */
export function DictationNote(props: { state: VoiceState }) {
  const { state } = props;
  const message = state.target === "dictate" &&
      (state.phase === "idle" || state.phase === "error")
    ? state.message
    : "";
  // The same message twice in a row still shows: each new state object is a new note.
  const [gone, setGone] = useState<VoiceState | null>(null);
  useEffect(() => {
    if (!message) setGone(null);
  }, [message]);
  if (!message || gone === state) return null;
  return (
    <p
      class="dictation-note"
      data-testid="dictation-note"
      data-phase={state.phase}
      role="status"
      onAnimationEnd={() => setGone(state)}
    >
      {message}
    </p>
  );
}
