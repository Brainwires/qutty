/**
 * The page's side of the voice extension (desktop/voice.ts): the native audio library's and the
 * Whisper model's status, the model download, push-to-talk capture with the on-device or a cloud
 * engine (with the microphone's level while it listens: lib/voice/level.ts), cloud speech played
 * on this machine, and the cloud services' API keys, which the extension keeps in the OS keychain
 * (lib/secrets/api-keys.ts): the page sets or clears a key and asks whether one is set, and never
 * reads one back. In the browser demo a fake stands in, which the e2e suite scripts
 * (`window.__e2eVoice`); its keys live in memory only.
 *
 * Client-safe: the extension is imported for its types only.
 *
 * @module
 */

import { desktopExtension, onDesktopEvent } from "denext/desktop/client";
import type voiceExtension from "../../desktop/voice.ts";
import type { ModelState } from "./model.ts";
import { formatSize, WHISPER_BASE_EN } from "./model.ts";
import { LEVEL_MS } from "./level.ts";
import {
  ApiKeys,
  type KeyPresence,
  memorySecretStore,
  type SecretStore,
} from "../secrets/api-keys.ts";

/** How long the page waits for a transcript. */
const TRANSCRIBE_WAIT_MS = 135_000;

/** The engines that capture through the native library. */
export type CaptureEngine = "local" | "deepgram" | "elevenlabs";

/** The cloud services an API key can be kept for. */
export type CloudService = "deepgram" | "elevenlabs";
/** Every cloud service. */
export const CLOUD_SERVICES: readonly CloudService[] = [
  "deepgram",
  "elevenlabs",
];

/** The secure-store key of a service's API key (in the voice extension's own namespace). */
export const cloudKeyName = (service: CloudService) =>
  `voice.${service}.apiKey`;

/** The cloud services' keys in `store` (the voice extension's secure store, or the demo's). */
export function voiceKeys(
  store: () => SecretStore | undefined,
): ApiKeys<CloudService> {
  return new ApiKeys(store, CLOUD_SERVICES, cloudKeyName);
}

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
  /** The microphone's level (0–1) while capturing, about 20 times a second; 0 when it stops. */
  onLevel(cb: (level: number) => void): () => void;
  /** Start capturing for `engine` (the extension reads a cloud engine's key itself). */
  sttStart(engine: CaptureEngine): Promise<void>;
  /** Stop and transcribe. */
  sttStop(): Promise<string>;
  sttCancel(): Promise<void>;
  /** Cloud speech (Deepgram Aura) played here; settles when it has been said or stopped. */
  speak(text: string, opts: { model?: string }): Promise<void>;
  stopSpeaking(): Promise<void>;
  /** Which cloud services have a key in the OS keychain (the keys themselves never come back). */
  keyStatus(): Promise<KeyPresence<CloudService>>;
  /** Keep `key` as `service`'s key in the OS keychain. */
  keySet(service: CloudService, key: string): Promise<void>;
  /** Remove `service`'s key from the OS keychain. */
  keyClear(service: CloudService): Promise<void>;
}

/** Subscribers to one of the extension's events, which is listened to once, on first use. */
function eventFanOut<T>(event: string): (cb: (value: T) => void) => () => void {
  const subs = new Set<(value: T) => void>();
  let listening = false;
  return (cb) => {
    if (!listening) {
      listening = true;
      onDesktopEvent<T>("voice", event, (v) => {
        for (const sub of [...subs]) sub(v);
      });
    }
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  };
}

/** The desktop backend, over the `voice` extension. */
export function createDesktopVoice(): VoiceBackend {
  const voice = desktopExtension<typeof voiceExtension>("voice");
  const onLevel = eventFanOut<{ level: number }>("level");
  return {
    kind: "desktop",
    status: () => voice.status({}),
    downloadModel: () => voice.modelDownload({}, { timeoutMs: false }),
    cancelDownload: () => voice.modelCancel({}),
    onModel: eventFanOut<ModelState>("model"),
    onLevel: (cb) => onLevel((e) => cb(e.level)),
    sttStart: (engine) => voice.sttStart({ engine }),
    sttStop: async () =>
      (await voice.sttStop({}, { timeoutMs: TRANSCRIBE_WAIT_MS })).text,
    sttCancel: () => voice.sttCancel({}),
    speak: (text, opts) =>
      voice.speak({
        text,
        ...(opts.model ? { model: opts.model } : {}),
      }, { timeoutMs: false }),
    stopSpeaking: () => voice.speakStop({}),
    keyStatus: () => voice.keyStatus({}),
    keySet: async (service, key) => {
      await voice.keySet({ service, key });
    },
    keyClear: async (service) => {
      await voice.keyClear({ service });
    },
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

/** The demo's made-up microphone level for the `tick`th reading: a voice-like wobble, never 0. */
function demoLevel(tick: number): number {
  return 0.45 + 0.35 * Math.sin(tick * 0.9) * Math.cos(tick * 0.37);
}

/**
 * The fake voice backend of the browser demo: no microphone, scripted transcripts, a made-up
 * level ({@linkcode demoLevel}) while it "listens", and cloud keys kept in memory (`store`) the
 * way the extension keeps them in the keychain: set, cleared and asked about, never read back.
 */
export function createDemoVoice(
  script: DemoVoiceScript = demoVoiceScript(),
  store: SecretStore = memorySecretStore(),
): VoiceBackend {
  const keys = voiceKeys(() => store);
  let capturing: string | undefined;
  const levelSubs = new Set<(level: number) => void>();
  let meter: ReturnType<typeof setInterval> | undefined;
  const sendLevel = (level: number) => {
    for (const sub of [...levelSubs]) sub(level);
  };
  const stopMeter = () => {
    if (meter === undefined) return;
    clearInterval(meter);
    meter = undefined;
    sendLevel(0);
  };
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
    onLevel(cb) {
      levelSubs.add(cb);
      return () => {
        levelSubs.delete(cb);
      };
    },
    sttStart(engine) {
      if (capturing) return Promise.reject(new Error("already listening"));
      capturing = engine;
      script.starts.push(engine);
      let tick = 0;
      meter = setInterval(() => sendLevel(demoLevel(tick++)), LEVEL_MS);
      return Promise.resolve();
    },
    sttStop() {
      if (!capturing) return Promise.reject(new Error("not listening"));
      capturing = undefined;
      stopMeter();
      return Promise.resolve(script.transcripts.shift() ?? "what's going on?");
    },
    sttCancel() {
      if (capturing) script.cancels++;
      capturing = undefined;
      stopMeter();
      return Promise.resolve();
    },
    speak: () => Promise.reject(new Error("cloud voices need the desktop app")),
    stopSpeaking: () => Promise.resolve(),
    keyStatus: () => keys.presence(),
    keySet: (service, key) => keys.set(service, key),
    keyClear: (service) => keys.clear(service),
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
