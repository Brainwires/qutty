/**
 * Settings → Voice, as persisted with the workspace settings (lib/workspace/store.ts): whether the
 * companion's answers are read aloud and how (engine, voice, rate, volume), which spoken event
 * alerts are on, the speech-to-text engine, the push-to-talk key, whether a transcript is shown
 * for review before it is sent, and the "Dictate into focused tile" mode.
 *
 * Nothing goes to a cloud service unless the user picks a cloud engine here: the defaults are the
 * OS's speech (`speak()` in `denext/mobile`) and the on-device Whisper engine.
 *
 * Client-safe and pure.
 *
 * @module
 */

/**
 * Who reads answers aloud: the OS (`speak()` from denext/mobile), or Deepgram Aura (cloud, your
 * key), played on this Mac through the native audio library.
 */
export type TtsEngineId = "system" | "deepgram";
/** Every TTS engine, as Settings lists them. */
export const TTS_ENGINES: readonly TtsEngineId[] = ["system", "deepgram"];

/**
 * Who turns speech into text: on-device Whisper (rullama-hardware through FFI), Deepgram or
 * ElevenLabs (cloud, your key), or the webview's own Web Speech recognition where it has one.
 */
export type SttEngineId = "local" | "deepgram" | "elevenlabs" | "web";
/** Every STT engine, as Settings lists them. */
export const STT_ENGINES: readonly SttEngineId[] = [
  "local",
  "deepgram",
  "elevenlabs",
  "web",
];

/** The engines that send audio or text to a cloud service. */
const CLOUD_ENGINES: readonly (TtsEngineId | SttEngineId)[] = [
  "elevenlabs",
  "deepgram",
];

/** Whether `engine` is a cloud engine (it needs a key and sends data out). */
export function isCloudEngine(engine: TtsEngineId | SttEngineId): boolean {
  return CLOUD_ENGINES.includes(engine);
}

/**
 * The hold-to-talk shortcut. `Mod` is ⌘ on macOS and Ctrl elsewhere, always with Shift: the
 * app's shortcut space (lib/workspace/keys.ts), never a key a terminal program receives. Space is
 * offered on macOS only (Ctrl+Shift+Space reaches the terminal as NUL elsewhere).
 */
export type PttKey = "Mod+Shift+M" | "Mod+Shift+K" | "Mod+Shift+Space" | "off";
/** Every push-to-talk choice. */
export const PTT_KEYS: readonly PttKey[] = [
  "Mod+Shift+M",
  "Mod+Shift+K",
  "Mod+Shift+Space",
  "off",
];

export interface VoiceSettings {
  /** Read the companion's answers aloud. */
  speakAnswers: boolean;
  ttsEngine: TtsEngineId;
  /** A voice name (the OS's) or model (Deepgram: `aura-asteria-en`); `""` is the default. */
  voice: string;
  /** 0.5–2, 1 is normal. */
  rate: number;
  /** 0–1. */
  volume: number;
  /** Spoken alert: an agent finished its turn (busy → idle). */
  alertFinished: boolean;
  /** Spoken alert: an agent needs you (a permission prompt, a question: → waiting). */
  alertPermission: boolean;
  /** Spoken alert: a tile reported a failed build (`set_status` with a failure note). */
  alertBuildFailed: boolean;
  sttEngine: SttEngineId;
  pttKey: PttKey;
  /** Show the transcript in the chat box (Send / Edit / Cancel) before it is sent. */
  review: boolean;
  /** Type transcripts into the focused tile, with no model involved. */
  dictate: boolean;
}

export const DEFAULT_VOICE: VoiceSettings = {
  speakAnswers: false,
  ttsEngine: "system",
  voice: "",
  rate: 1,
  volume: 1,
  alertFinished: false,
  alertPermission: false,
  alertBuildFailed: false,
  sttEngine: "local",
  pttKey: "Mod+Shift+M",
  review: true,
  dictate: false,
};

const BOOLEAN_KEYS = [
  "speakAnswers",
  "alertFinished",
  "alertPermission",
  "alertBuildFailed",
  "review",
  "dictate",
] as const;

/** A finite number clamped to [min, max], or `undefined`. */
function clamped(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v * 100) / 100));
}

/** `raw` (from storage, or a patch) onto `base`, each field checked. */
export function sanitizeVoice(
  raw: unknown,
  base: VoiceSettings = DEFAULT_VOICE,
): VoiceSettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof VoiceSettings, unknown>>;
  for (const k of BOOLEAN_KEYS) {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  }
  if (TTS_ENGINES.includes(r.ttsEngine as TtsEngineId)) {
    out.ttsEngine = r.ttsEngine as TtsEngineId;
  }
  if (STT_ENGINES.includes(r.sttEngine as SttEngineId)) {
    out.sttEngine = r.sttEngine as SttEngineId;
  }
  if (PTT_KEYS.includes(r.pttKey as PttKey)) out.pttKey = r.pttKey as PttKey;
  if (typeof r.voice === "string" && r.voice.length <= 128) {
    out.voice = r.voice;
  }
  out.rate = clamped(r.rate, 0.5, 2) ?? out.rate;
  out.volume = clamped(r.volume, 0, 1) ?? out.volume;
  return out;
}

/** Whether two settings are the same (the store skips a no-op patch). */
export function sameVoice(a: VoiceSettings, b: VoiceSettings): boolean {
  return (Object.keys(a) as (keyof VoiceSettings)[]).every((k) =>
    a[k] === b[k]
  );
}
