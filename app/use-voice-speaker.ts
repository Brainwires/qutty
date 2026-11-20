// Whether this workspace window is the one that speaks (voice mode, Speak answers), so several
// windows never talk over each other (lib/voice/speaker.ts holds the rule). The window claims the
// speaker in shared storage when it gets the focus or the user's input (passive listeners that
// only compare an id, writing only when another window held it), follows the other windows' claims
// through `storage` events, and gives the claim up when it goes away. While the floating companion
// shows, no workspace window speaks: the floating one does.

import { useEffect, useMemo, useState } from "denext";
import {
  claimSpeaker,
  isSpeaker,
  readSpeaker,
  releaseSpeaker,
  SPEAKER_KEY,
  type SpeakerStore,
} from "../lib/voice/speaker.ts";

/** The page's shared storage, if it has one. */
function store(): SpeakerStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether the window has the focus now. */
function hasFocus(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

export function useVoiceSpeaker(floatingShowing: boolean): boolean {
  const self = useMemo(() => crypto.randomUUID(), []);
  const [holder, setHolder] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const s = store();
    let held = s ? readSpeaker(s) : null;
    const claim = () => {
      if (!s || held === self) return;
      claimSpeaker(s, self);
      held = self;
      setHolder(self);
    };
    // A new window takes the claim when it has the focus, or when nobody holds it.
    if (hasFocus() || held === null) claim();
    else setHolder(held);
    setFocused(hasFocus());
    const onFocus = () => {
      setFocused(true);
      claim();
    };
    const onBlur = () => setFocused(false);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SPEAKER_KEY) return;
      held = e.newValue || null;
      setHolder(held);
    };
    const onLeave = () => {
      if (s) releaseSpeaker(s, self);
    };
    const opts = { capture: true, passive: true };
    globalThis.addEventListener("focus", onFocus);
    globalThis.addEventListener("blur", onBlur);
    globalThis.addEventListener("pointerdown", claim, opts);
    globalThis.addEventListener("keydown", claim, opts);
    globalThis.addEventListener("storage", onStorage);
    globalThis.addEventListener("pagehide", onLeave);
    return () => {
      onLeave();
      globalThis.removeEventListener("focus", onFocus);
      globalThis.removeEventListener("blur", onBlur);
      globalThis.removeEventListener("pointerdown", claim, opts);
      globalThis.removeEventListener("keydown", claim, opts);
      globalThis.removeEventListener("storage", onStorage);
      globalThis.removeEventListener("pagehide", onLeave);
    };
  }, [self]);

  return isSpeaker({ self, holder, floatingShowing, focused });
}
