// Voice mode on the companion (Settings → Voice / Companion → Voice mode): what its bubble shows is
// said aloud, one voice at a time, in bubble order (lib/voice/bubble-speech.ts holds the rules,
// `planBubbleSpeech`).
//
// - A new bubble on screen cuts off what the old one was saying, and is said itself: whole, or
//   (a reply streaming in) sentence by sentence as the sentences arrive.
// - Closing a bubble by hand (its close button or a button) stops its speech (`dismissed`); a
//   bubble that times out is left to finish its sentence unless another replaces it.
// - Barge-in (talking, push-to-talk, the stop button) stops it, and the rest of a streaming reply
//   stays quiet.
// - Only where this overlay is the window that speaks (`on`: app/use-voice-speaker.ts elects one
//   window, the floating companion while it shows), so there is never a double voice.

import { useEffect, useRef } from "denext";
import type { CompanionMessage } from "../../lib/companion/messages.ts";
import {
  type BubbleSaying,
  planBubbleSpeech,
} from "../../lib/voice/bubble-speech.ts";
import type { VoiceApi } from "../use-voice.ts";

export interface BubbleSpeech {
  /** Bubble `id` was closed by hand: stop saying it. */
  dismissed(id: string): void;
}

export function useBubbleSpeech(
  current: CompanionMessage | undefined,
  on: boolean,
  voice: VoiceApi | undefined,
): BubbleSpeech {
  const saying = useRef<BubbleSaying | null>(null);
  const active = on && voice !== undefined;

  useEffect(() => {
    if (!active) {
      // Turned off (or no longer the speaking window) mid-sentence: quiet now.
      if (saying.current) voice?.stopSpeaking();
      saying.current = null;
      return;
    }
    const plan = planBubbleSpeech(saying.current, current, voice.speechCut());
    saying.current = plan.saying;
    for (const step of plan.steps) voice.speak(step.text, step.replace);
  }, [active, current?.id, current?.text, current?.timeoutMs]);

  return {
    dismissed(id) {
      if (saying.current?.id !== id || !voice) return;
      saying.current = null;
      voice.stopSpeaking();
    },
  };
}
