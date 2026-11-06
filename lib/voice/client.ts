/**
 * The page's side of the voice extension (desktop/voice.ts): the native audio library's and the
 * Whisper model's status, the model download, push-to-talk capture with the on-device or a cloud
 * engine, and cloud speech played on this machine. In the browser demo a fake stands in, which the
 * e2e suite scripts (`window.__e2eVoice`).
 *
 * Client-safe: the extension is imported for its types only.
 *
 * @module
 */

import { desktopExtension, onDesktopEvent } from "denext/desktop/client";
import type voiceExtension from "../../desktop/voice.ts";
import type { ModelState } from "./model.ts";
import { formatSize, WHISPER_BASE_EN } from "./model.ts";

/** How long the page waits for a transcript. */
const TRANSCRIBE_WAIT_MS = 135_000;

/** The engines that capture through the native library. */
export type CaptureEngine = "local" | "deepgram" | "elevenlabs";

/** The native library, and the model. */
export interface VoiceStatus {
  lib:
    | { ok: true; version: string; path: string }
    | { ok: false; reason: string; searched: string[] };
  model: ModelState & { label: string; size: string; path?: string };
}

/** The voice backend: the desktop extension or the demo's fake. */
export interface VoiceBackend {
  readonly kind: "desktop" | "demo";
  status(): Promise<VoiceStatus>;
  /** Fetch the model (progress arrives through {@linkcode onModel}); the state it ends in. */
  downloadModel(): Promise<ModelState>;
  cancelDownload(): Promise<void>;
  onModel(cb: (state: ModelState) => void): () => void;
  /** Start capturing for `engine` (a cloud engine gets its key from the secure store). */
  sttStart(engine: CaptureEngine, key?: string): Promise<void>;
  /** Stop and transcribe. */
  sttStop(): Promise<string>;
  sttCancel(): Promise<void>;
  /** Cloud speech (Deepgram Aura) played here; settles when it has been said or stopped. */
  speak(text: string, opts: { key: string; model?: string }): Promise<void>;
  stopSpeaking(): Promise<void>;
}

/** The desktop backend, over the `voice` extension. */
export function createDesktopVoice(): VoiceBackend {
  const voice = desktopExtension<typeof voiceExtension>("voice");
  const subs = new Set<(state: ModelState) => void>();
  let listening = false;
  return {
    kind: "desktop",
    status: () => voice.status({}),
    downloadModel: () => voice.modelDownload({}, { timeoutMs: false }),
    cancelDownload: () => voice.modelCancel({}),
    onModel(cb) {
      if (!listening) {
        listening = true;
        onDesktopEvent<ModelState>("voice", "model", (s) => {
          for (const sub of [...subs]) sub(s);
        });
      }
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    sttStart: (engine, key) =>
      voice.sttStart({ engine, ...(key ? { key } : {}) }),
    sttStop: async () =>
      (await voice.sttStop({}, { timeoutMs: TRANSCRIBE_WAIT_MS })).text,
    sttCancel: () => voice.sttCancel({}),
    speak: (text, opts) =>
      voice.speak({
        text,
        key: opts.key,
        ...(opts.model ? { model: opts.model } : {}),
      }, { timeoutMs: false }),
    stopSpeaking: () => voice.speakStop({}),
  };
}

/** What the e2e suite scripts in the demo (`window.__e2eVoice`). */
export interface DemoVoiceScript {
  /** The transcripts the next captures return, in order (then `"what's going on?"`). */
  transcripts: string[];
  /** Every capture start, with its engine. */
  starts: string[];
  /** How many captures were cancelled. */
  cancels: number;
  /** The demo TTS: every text it began to say, and how many times it was stopped. */
  spoken: string[];
  stops: number;
  /** How long the demo TTS takes per character (ms). */
  msPerChar: number;
}

/** The fake voice backend of the browser demo: no microphone, scripted transcripts. */
export function createDemoVoice(
  script: DemoVoiceScript = demoVoiceScript(),
): VoiceBackend {
  let capturing: string | undefined;
  const ready: ModelState = { state: "ready" };
  const model = {
    ...ready,
    label: WHISPER_BASE_EN.label,
    size: formatSize(WHISPER_BASE_EN.sizeBytes),
  };
  return {
    kind: "demo",
    status: () =>
      Promise.resolve({
        lib: { ok: true, version: "demo (no microphone)", path: "" },
        model,
      }),
    downloadModel: () => Promise.resolve(ready),
    cancelDownload: () => Promise.resolve(),
    onModel: () => () => {},
    sttStart(engine) {
      if (capturing) return Promise.reject(new Error("already listening"));
      capturing = engine;
      script.starts.push(engine);
      return Promise.resolve();
    },
    sttStop() {
      if (!capturing) return Promise.reject(new Error("not listening"));
      capturing = undefined;
      return Promise.resolve(script.transcripts.shift() ?? "what's going on?");
    },
    sttCancel() {
      if (capturing) script.cancels++;
      capturing = undefined;
      return Promise.resolve();
    },
    speak: () => Promise.reject(new Error("cloud voices need the desktop app")),
    stopSpeaking: () => Promise.resolve(),
  };
}

/** A fresh demo script (published as `window.__e2eVoice` in test mode). */
export function demoVoiceScript(): DemoVoiceScript {
  return {
    transcripts: [],
    starts: [],
    cancels: 0,
    spoken: [],
    stops: 0,
    msPerChar: 20,
  };
}
