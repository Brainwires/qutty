/**
 * The page's speech engines behind the adapters (lib/voice/tts.ts `TtsEngine`, lib/voice/controller.ts
 * `SttEngine`):
 *
 * - TTS `system` (the default): `speak()` / `stopSpeaking()` from `denext/mobile`, the engine Loopy
 *   in Denext's example uses — the window's Web Speech, else the OS's (`Deno.desktop.speech`).
 * - TTS `deepgram`: Deepgram Aura through the voice extension, played by the native library.
 * - STT `local` (the default): on-device Whisper in the native library (rullama-hardware).
 * - STT `deepgram` / `elevenlabs`: the native library records, the extension sends the audio.
 * - STT `web`: the webview's own `SpeechRecognition`, only where it really has one.
 *
 * Cloud keys live in the OS keychain (Denext's `secureStore` capability), only in the desktop app,
 * and are read when they are used. Nothing is sent to a cloud service unless the user picked it.
 *
 * @module
 */

import { secureStore, speak, stopSpeaking } from "denext/mobile";
import type { CaptureEngine, DemoVoiceScript, VoiceBackend } from "./client.ts";
import type { SttEngine, SttUnavailable } from "./controller.ts";
import type { SpeakOptions, TtsEngine } from "./tts.ts";
import type { SttEngineId } from "./settings.ts";

/** The cloud services a key can be kept for. */
export type CloudService = "deepgram" | "elevenlabs";

/** The secure-store key of a service's API key. */
export const cloudKeyName = (service: CloudService) =>
  `voice.${service}.apiKey`;

/** Keeping cloud keys: in the OS keychain, desktop only (the web has no secret store). */
export interface KeyStore {
  get(service: CloudService): Promise<string | null>;
  set(service: CloudService, key: string): Promise<void>;
  remove(service: CloudService): Promise<void>;
}

/**
 * Why cloud keys cannot be kept in this build, or `undefined` once they can. Denext's `secureStore`
 * capability makes the packager bake `--allow-run=security` and `--allow-sys` (its fallback for
 * runtimes without their own keychain store), which Qutty's packaged permissions rule out (no
 * run, write or sys). Until Denext drops those for its pinned runtime, the cloud engines stay
 * off: no key is ever asked for or stored, and nothing goes to a cloud service. Turning them on
 * is this constant plus `secureStore` and the two `netConnect` hosts in denext.config.ts.
 */
export const CLOUD_KEYS_UNAVAILABLE: string | undefined =
  "cloud voices are off in this build: keeping their keys needs Denext's secure store, which would add run and sys permissions to the app";

/** The OS keychain through Denext's `secureStore` capability (refused while it is off). */
export const keychain: KeyStore = CLOUD_KEYS_UNAVAILABLE
  ? {
    get: () => Promise.reject(new Error(CLOUD_KEYS_UNAVAILABLE)),
    set: () => Promise.reject(new Error(CLOUD_KEYS_UNAVAILABLE)),
    remove: () => Promise.resolve(),
  }
  : {
    get: (service) => secureStore.get(cloudKeyName(service)),
    async set(service, key) {
      await secureStore.set(cloudKeyName(service), key);
    },
    remove: (service) => secureStore.delete(cloudKeyName(service)),
  };

/** The OS's speech: `speak()` from denext/mobile. */
export function systemTts(): TtsEngine {
  return {
    id: "system",
    speak: (text, o) =>
      speak(text, {
        ...(o.voice ? { voice: o.voice } : {}),
        ...(o.rate !== undefined ? { rate: o.rate } : {}),
        ...(o.volume !== undefined ? { volume: o.volume } : {}),
      }),
    stop: () => stopSpeaking(),
  };
}

/** Deepgram Aura (cloud), played on this machine. */
export function cloudTts(voice: VoiceBackend, keys: KeyStore): TtsEngine {
  return {
    id: "deepgram",
    async speak(text: string, o: SpeakOptions) {
      const key = await keys.get("deepgram");
      if (!key) throw new Error("no Deepgram key (Settings → Voice)");
      await voice.speak(text, { key, ...(o.voice ? { model: o.voice } : {}) });
    },
    stop: () => voice.stopSpeaking(),
  };
}

/** The demo's TTS (e2e): it records what it says and takes a while, so barge-in can be seen. */
export function demoTts(script: DemoVoiceScript): TtsEngine {
  let stop: (() => void) | undefined;
  return {
    id: "demo",
    speak(text) {
      script.spoken.push(text);
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, text.length * script.msPerChar);
        function done() {
          clearTimeout(timer);
          stop = undefined;
          resolve();
        }
        stop = done;
      });
    },
    stop() {
      if (stop) {
        script.stops++;
        stop();
      }
      return Promise.resolve();
    },
  };
}

/** What a model or library problem tells the user. */
function libProblem(
  status: Awaited<ReturnType<VoiceBackend["status"]>>,
  needsModel: boolean,
): SttUnavailable | undefined {
  if (!status.lib.ok) {
    return {
      ok: false,
      reason:
        `the on-device audio library is not installed (${status.lib.reason})`,
      fix: "build-lib",
    };
  }
  if (needsModel && status.model.state !== "ready") {
    return {
      ok: false,
      reason: status.model.state === "error"
        ? `the speech model failed: ${status.model.error}`
        : `the speech model (${status.model.size}) is not downloaded yet`,
      fix: "download-model",
    };
  }
  return undefined;
}

/** Push-to-talk through the native library: on-device Whisper, or a cloud engine's upload. */
export function nativeStt(
  voice: VoiceBackend,
  engine: CaptureEngine,
  keys?: KeyStore,
): SttEngine {
  let key: string | undefined;
  return {
    id: engine,
    async probe() {
      const problem = libProblem(await voice.status(), engine === "local");
      if (problem) return problem;
      if (engine !== "local") {
        try {
          key = (voice.kind === "desktop" && keys)
            ? await keys.get(engine) ?? undefined
            : undefined;
        } catch (e) {
          return {
            ok: false,
            reason: e instanceof Error ? e.message : String(e),
          };
        }
        if (!key) {
          return {
            ok: false,
            reason: `no ${
              engine === "deepgram" ? "Deepgram" : "ElevenLabs"
            } key (Settings → Voice)`,
            fix: "set-key",
          };
        }
      }
      return { ok: true };
    },
    start: () => voice.sttStart(engine, key),
    stop: () => voice.sttStop(),
    cancel: () => voice.sttCancel(),
  };
}

/** The webview's `SpeechRecognition` constructor, when it has one. */
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

/** The webview's speech recognition, if it really has one. */
export function webRecognition(
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): RecognitionCtor | undefined {
  const ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof ctor === "function" ? ctor as RecognitionCtor : undefined;
}

/** Web Speech recognition (only offered where {@linkcode webRecognition} finds it). */
export function webSpeechStt(ctor = webRecognition()): SttEngine {
  let rec: RecognitionLike | undefined;
  let text = "";
  let ended: Promise<void> = Promise.resolve();
  let error: string | undefined;
  return {
    id: "web",
    probe: () =>
      Promise.resolve(
        ctor ? { ok: true as const } : {
          ok: false as const,
          reason: "this window has no Web Speech recognition",
        },
      ),
    start() {
      if (!ctor) throw new Error("no Web Speech recognition here");
      text = "";
      error = undefined;
      const r = new ctor();
      r.lang = "en-US";
      r.continuous = true;
      r.interimResults = false;
      r.onresult = (e) => {
        text = Array.from(e.results, (res) => res[0]?.transcript ?? "").join(
          " ",
        );
      };
      r.onerror = (e) => {
        if (e.error && e.error !== "no-speech" && e.error !== "aborted") {
          error = e.error;
        }
      };
      ended = new Promise((resolve) => (r.onend = () => resolve()));
      rec = r;
      r.start();
      return Promise.resolve();
    },
    async stop() {
      rec?.stop();
      await ended;
      rec = undefined;
      if (error) throw new Error(`speech recognition failed: ${error}`);
      return text;
    },
    cancel() {
      rec?.abort();
      rec = undefined;
      return Promise.resolve();
    },
  };
}

/** The STT engine for `id`. */
export function sttEngine(
  id: SttEngineId,
  voice: VoiceBackend,
  keys: KeyStore,
): SttEngine {
  return id === "web" ? webSpeechStt() : nativeStt(voice, id, keys);
}
