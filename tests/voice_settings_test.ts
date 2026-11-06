// Settings → Voice (lib/voice/settings.ts) through the workspace store, and the hold-to-talk key
// (lib/workspace/keys.ts): always the app's Mod+Shift space, never a workspace shortcut, never a
// key the terminal receives.

import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_VOICE,
  isCloudEngine,
  PTT_KEYS,
  sanitizeVoice,
} from "../lib/voice/settings.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";
import {
  commandForKey,
  isPushToTalk,
  isPushToTalkRelease,
  type KeyLike,
  pttAvailable,
} from "../lib/workspace/keys.ts";

Deno.test("voice settings: defaults are local and quiet", () => {
  assertEquals(DEFAULT_SETTINGS.voice, DEFAULT_VOICE);
  assertEquals(DEFAULT_VOICE.sttEngine, "local");
  assertEquals(DEFAULT_VOICE.ttsEngine, "system");
  assertEquals(DEFAULT_VOICE.speakAnswers, false);
  assertEquals(DEFAULT_VOICE.review, true);
  assert(!isCloudEngine(DEFAULT_VOICE.sttEngine));
  assert(!isCloudEngine(DEFAULT_VOICE.ttsEngine));
  assert(isCloudEngine("deepgram") && isCloudEngine("elevenlabs"));
});

Deno.test("voice settings: each field checked, junk ignored", () => {
  const s = sanitizeVoice({
    speakAnswers: true,
    ttsEngine: "deepgram",
    sttEngine: "web",
    voice: "Samantha",
    rate: 9,
    volume: -1,
    pttKey: "Mod+Shift+K",
    alertBuildFailed: true,
    review: "yes",
    dictate: 1,
  });
  assertEquals(s, {
    ...DEFAULT_VOICE,
    speakAnswers: true,
    ttsEngine: "deepgram",
    sttEngine: "web",
    voice: "Samantha",
    rate: 2,
    volume: 0,
    pttKey: "Mod+Shift+K",
    alertBuildFailed: true,
  });
  assertEquals(
    sanitizeVoice({ ttsEngine: "festival", sttEngine: "siri", pttKey: "F5" }),
    DEFAULT_VOICE,
  );
  assertEquals(sanitizeVoice({ voice: "x".repeat(200) }).voice, "");
  assertEquals(sanitizeVoice(null), DEFAULT_VOICE);
});

Deno.test("voice settings: the store patches, persists and skips no-ops", () => {
  const s0 = initialState();
  const s1 = reduce(s0, { type: "setVoice", patch: { speakAnswers: true } });
  assertEquals(s1.settings.voice.speakAnswers, true);
  assert(
    reduce(s1, { type: "setVoice", patch: { speakAnswers: true } }) === s1,
  );
  assert(reduce(s1, { type: "setVoice", patch: { rate: Number.NaN } }) === s1);
  const saved = JSON.parse(JSON.stringify(s1.settings));
  assertEquals(sanitizeSettings(saved).voice.speakAnswers, true);
  // Old saved settings (before Voice) get the defaults.
  const { voice: _gone, ...old } = saved;
  assertEquals(sanitizeSettings(old).voice, DEFAULT_VOICE);
});

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: code.replace(/^Key/, "").toLowerCase(),
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

Deno.test("push-to-talk key: Mod+Shift only, per platform", () => {
  const macDown = key("KeyM", { metaKey: true, shiftKey: true });
  assert(isPushToTalk(macDown, "Mod+Shift+M", "mac"));
  assert(!isPushToTalk(macDown, "Mod+Shift+M", "other"));
  assert(!isPushToTalk(macDown, "Mod+Shift+K", "mac"));
  assert(!isPushToTalk(macDown, "off", "mac"));
  assert(
    isPushToTalk(
      key("KeyM", { ctrlKey: true, shiftKey: true }),
      "Mod+Shift+M",
      "other",
    ),
  );
  // Without Shift, or with Alt, it is the terminal's (or another shortcut's).
  assert(!isPushToTalk(key("KeyM", { metaKey: true }), "Mod+Shift+M", "mac"));
  assert(
    !isPushToTalk(
      key("KeyM", { metaKey: true, shiftKey: true, altKey: true }),
      "Mod+Shift+M",
      "mac",
    ),
  );
  // Space only on macOS: Ctrl+Shift+Space reaches a terminal as NUL elsewhere.
  assert(pttAvailable("Mod+Shift+Space", "mac"));
  assert(!pttAvailable("Mod+Shift+Space", "other"));
  assert(
    !isPushToTalk(
      key("Space", { ctrlKey: true, shiftKey: true }),
      "Mod+Shift+Space",
      "other",
    ),
  );
  // Letting go of the key, Shift or the modifier ends the hold.
  assert(isPushToTalkRelease({ key: "m", code: "KeyM" }, "Mod+Shift+M", "mac"));
  assert(
    isPushToTalkRelease(
      { key: "Shift", code: "ShiftLeft" },
      "Mod+Shift+M",
      "mac",
    ),
  );
  assert(
    isPushToTalkRelease(
      { key: "Meta", code: "MetaLeft" },
      "Mod+Shift+M",
      "mac",
    ),
  );
  assert(
    !isPushToTalkRelease({ key: "a", code: "KeyA" }, "Mod+Shift+M", "mac"),
  );
});

Deno.test("push-to-talk key: no choice is a workspace shortcut", () => {
  for (const platform of ["mac", "other"] as const) {
    for (const k of PTT_KEYS) {
      if (!pttAvailable(k, platform)) continue;
      const code = k === "Mod+Shift+Space" ? "Space" : `Key${k.at(-1)}`;
      const e = key(code, {
        shiftKey: true,
        ...(platform === "mac" ? { metaKey: true } : { ctrlKey: true }),
      });
      assert(isPushToTalk(e, k, platform), `${k} on ${platform}`);
      assertEquals(commandForKey(e, platform), null, `${k} on ${platform}`);
    }
  }
});
