// The voice backend: a desktop extension (`voice`) beside `pty`, `ssh` and `hub`. The page's speech
// layer (lib/voice/) reaches it through lib/voice/client.ts.
//
// - The native audio library: rullama-hardware's audio as the `rullama-audio-ffi` cdylib (cpal
//   capture, Whisper through whisper-rs, webrtc-vad, cpal playback), loaded with `Deno.dlopen`
//   (`--allow-ffi` is already granted) from `QUTTY_AUDIO_LIB`, beside the app, or
//   `<app support>/audio/` (lib/voice/ffi.ts `audioLibCandidates`). Without it, push-to-talk says
//   so and the OS speech still reads answers aloud.
// - The Whisper model: fetched on first use into `<app support>/models/`, its SHA-256 checked
//   (lib/voice/model.ts). The packaged app has no `--allow-net` / `--allow-write` for that, so
//   `curl` runs in a hidden PTY (the pattern desktop/ssh.ts uses for scp) and the final rename is a
//   libc call.
// - Push-to-talk: `sttStart` opens the microphone (the library's capture), `sttStop` stops it and
//   answers with the transcript: on-device Whisper, or the audio sent to the cloud engine the user
//   picked (Deepgram, ElevenLabs; `@rullama/provider-speech`) with the key the page read from the
//   OS keychain. Nothing is sent anywhere else.
// - Cloud speech: Deepgram Aura's WAV, played by the library (`speak` / `speakStop`).
//
// Nothing here may throw into the app's startup: the library and the model are found lazily.

import { defineDesktopExtension, DesktopCapError } from "denext/desktop";
import { DeepgramClient } from "@rullama/provider-speech/deepgram";
import { ElevenLabsClient } from "@rullama/provider-speech/elevenlabs";
import { emptyInput, objectSchema, optStr, str } from "./schema.ts";
import {
  ensureDir,
  PtyHost,
  renamePath,
  resolveProgram,
  writeFileAtomic,
} from "./pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "./pty.ts";
import { unlinkPath } from "./hub-socket.ts";
import {
  AUDIO_SYMBOLS,
  AudioLib,
  audioLibCandidates,
  CaptureState,
} from "../lib/voice/ffi.ts";
import {
  type DownloadJob,
  formatSize,
  hex,
  type ModelFiles,
  type ModelState,
  ModelStore,
} from "../lib/voice/model.ts";
import type { CaptureEngine, VoiceStatus } from "../lib/voice/client.ts";

/** How long a transcription may take. */
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** How often the library's state is polled. */
const POLL_MS = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Terminal escape sequences in curl's output. */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

/** The model's files: reads through Deno (broad read is granted), changes through libc. */
const files: ModelFiles = {
  size: async (path) => {
    try {
      return (await Deno.stat(path)).size;
    } catch {
      return undefined;
    }
  },
  sha256: async (path) =>
    hex(await crypto.subtle.digest("SHA-256", await Deno.readFile(path))),
  ensureDir: (path) => ensureDir(path, 0o755),
  rename: renamePath,
  remove: (path) => void unlinkPath(path),
};

/** `curl -fL` into `dest`, in a hidden PTY (no `--allow-run` / `--allow-net` needed). */
function curlFetcher(
  appSupportDir: string,
): (url: string, dest: string) => DownloadJob {
  return (url, dest) => {
    let host: PtyHost | undefined;
    let id: string | undefined;
    let output = "";
    let cancelled = false;
    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      host = new PtyHost((event, data) => {
        if (event === "data") {
          output = (output + (data as PtyDataEvent).data).slice(-2000);
          return;
        }
        const exit = data as PtyExitEvent;
        if (cancelled) return resolve({ ok: false, error: "cancelled" });
        if (exit.exitCode === 0) return resolve({ ok: true });
        const why = output.replace(ANSI, "").trim()
          .split("\n").at(-1);
        resolve({
          ok: false,
          error: `the download failed (curl exit ${exit.exitCode}${
            why ? `: ${why}` : ""
          })`,
        });
      });
      resolveProgram("curl").then(async (curl) => {
        if (!curl) return resolve({ ok: false, error: "curl was not found" });
        const spawned = await host!.spawn({
          cols: 200,
          rows: 10,
          program: curl,
          args: [
            "-fL",
            "--retry",
            "2",
            "--silent",
            "--show-error",
            "-o",
            dest,
            url,
          ],
        }, { appSupportDir, owner: "voice" });
        id = spawned.id;
        if (cancelled) host!.kill(id);
      }).catch((e) => resolve({ ok: false, error: String(e) }));
    });
    return {
      done,
      cancel() {
        cancelled = true;
        if (host && id) host.kill(id);
      },
    };
  };
}

/** The voice service: the library (once found), the model, the capture in flight. */
class VoiceService {
  readonly model: ModelStore;
  #appSupportDir: string;
  #lib: AudioLib | undefined;
  #libPath = "";
  #libError: { reason: string; searched: string[] } | undefined;
  #capture: { engine: CaptureEngine; key?: string } | undefined;
  #speaking = 0;

  constructor(appSupportDir: string, emit: (state: ModelState) => void) {
    this.#appSupportDir = appSupportDir;
    this.model = new ModelStore({
      appSupportDir,
      files,
      fetch: curlFetcher(appSupportDir),
      onState: emit,
    });
  }

  /** The library, opened on first use. */
  lib(): AudioLib {
    if (this.#lib) return this.#lib;
    const searched = audioLibCandidates({
      os: Deno.build.os,
      env: Deno.env.get("QUTTY_AUDIO_LIB") || undefined,
      execPath: Deno.execPath(),
      appSupportDir: this.#appSupportDir,
    });
    const errors: string[] = [];
    for (const path of searched) {
      try {
        Deno.statSync(path);
      } catch {
        continue;
      }
      try {
        const lib = new AudioLib(Deno.dlopen(path, AUDIO_SYMBOLS).symbols);
        this.#lib = lib;
        this.#libPath = path;
        this.#libError = undefined;
        return lib;
      } catch (e) {
        errors.push(`${path}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.#libError = {
      reason: errors[0] ??
        "not found (run `deno task audio:lib` to build it from Rullama)",
      searched,
    };
    throw new DesktopCapError("unsupported", this.#libError.reason);
  }

  async status(): Promise<VoiceStatus> {
    let lib: VoiceStatus["lib"];
    try {
      lib = { ok: true, version: this.lib().version(), path: this.#libPath };
    } catch {
      lib = { ok: false, ...this.#libError! };
    }
    const state = await this.model.check();
    return {
      lib,
      model: {
        ...state,
        label: this.model.model.label,
        size: formatSize(this.model.model.sizeBytes),
        ...(state.state === "ready" ? { path: this.model.path } : {}),
      },
    };
  }

  async start(engine: CaptureEngine, key?: string): Promise<void> {
    const lib = this.lib();
    if (this.#capture) lib.cancel();
    if (engine === "local") {
      const state = await this.model.check();
      if (state.state !== "ready") {
        throw new DesktopCapError(
          "unavailable",
          "the speech model is not downloaded",
        );
      }
      if (!lib.modelLoaded()) lib.loadModel(this.model.path);
    } else if (!key) {
      throw new DesktopCapError("validation", `${engine} needs an API key`);
    }
    // A finished transcript nobody took (a page reload) would block the next capture.
    if (lib.state() !== CaptureState.idle) lib.cancel();
    lib.startCapture();
    this.#capture = { engine, ...(key ? { key } : {}) };
  }

  async stop(): Promise<string> {
    const capture = this.#capture;
    if (!capture) throw new DesktopCapError("validation", "not listening");
    this.#capture = undefined;
    const lib = this.lib();
    if (capture.engine === "local") {
      lib.stopCapture();
      const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS;
      while (lib.state() === CaptureState.transcribing) {
        if (Date.now() > deadline) {
          lib.cancel();
          throw new Error("transcribing took too long");
        }
        await sleep(POLL_MS);
      }
      return lib.state() === CaptureState.idle ? "" : lib.take();
    }
    const dir = `${this.#appSupportDir}/audio`;
    ensureDir(this.#appSupportDir, 0o755);
    ensureDir(dir, 0o700);
    const wav = `${dir}/capture-${Deno.pid}.wav`;
    const ms = lib.stopCaptureToWav(wav);
    try {
      if (ms < 300) return "";
      return await cloudTranscribe(
        capture.engine,
        capture.key!,
        await Deno.readFile(wav),
      );
    } finally {
      unlinkPath(wav);
    }
  }

  cancel(): void {
    this.#capture = undefined;
    this.#lib?.cancel();
  }

  /** Deepgram Aura's speech, played here; resolves once said (or stopped). */
  async speak(text: string, key: string, model?: string): Promise<void> {
    const lib = this.lib();
    const turn = ++this.#speaking;
    const wavBytes = await new DeepgramClient(key).speak({
      text,
      model: model || "aura-asteria-en",
      encoding: "linear16",
      sample_rate: 24_000,
    });
    if (turn !== this.#speaking) return; // stopped while it was fetched
    const dir = `${this.#appSupportDir}/audio`;
    ensureDir(this.#appSupportDir, 0o755);
    ensureDir(dir, 0o700);
    const wav = `${dir}/speech-${Deno.pid}.wav`;
    writeFileAtomic(wav, wavBytes, 0o600);
    try {
      lib.playWav(wav);
      while (lib.playing() && turn === this.#speaking) await sleep(POLL_MS * 2);
    } finally {
      unlinkPath(wav);
    }
  }

  stopSpeaking(): void {
    this.#speaking++;
    this.#lib?.stopPlayback();
  }
}

/** The transcript of `wav` from the cloud engine the user picked, with their key. */
async function cloudTranscribe(
  engine: Exclude<CaptureEngine, "local">,
  key: string,
  wav: Uint8Array,
): Promise<string> {
  if (engine === "deepgram") {
    const r = await new DeepgramClient(key).listen(wav, {
      model: "nova-2",
      language: "en",
      punctuate: true,
      content_type: "audio/wav",
    });
    return r.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  }
  const r = await new ElevenLabsClient(key).speechToText(wav, {
    model: "scribe_v1",
    language_code: "en",
  });
  return r.text ?? "";
}

/** `QUTTY_VOICE_SELFTEST`: the library, the model (fetched if missing), Whisper on `wav`, playback. */
async function selfTest(voice: VoiceService, wav: string): Promise<void> {
  const log = (m: string) => console.error(`voice self-test: ${m}`);
  const status = await voice.status();
  log(`library ${JSON.stringify(status.lib)}`);
  log(`model ${status.model.state}`);
  if (status.model.state !== "ready") {
    log(`downloading ${voice.model.model.url}`);
    const state = await voice.model.download();
    log(`download ended: ${JSON.stringify(state)}`);
    if (state.state !== "ready") return;
  }
  const lib = voice.lib();
  if (!lib.modelLoaded()) lib.loadModel(voice.model.path);
  const started = Date.now();
  log(
    `transcript ${JSON.stringify(await lib.transcribeWav(wav))} (${
      Date.now() - started
    } ms)`,
  );
  lib.playWav(wav);
  while (lib.playing()) await sleep(50);
  log("played; done");
}

let service: VoiceService | undefined;
let emitModel: (state: ModelState) => void = () => {};

function requireService(): VoiceService {
  if (!service) throw new DesktopCapError("unavailable", "voice is not ready");
  return service;
}

const ENGINES: readonly CaptureEngine[] = ["local", "deepgram", "elevenlabs"];

const startInput = objectSchema<{ engine: CaptureEngine; key?: string }>(
  (v, issues) => {
    if (!ENGINES.includes(v.engine as CaptureEngine)) {
      issues.push({
        message: `engine is one of ${ENGINES.join(", ")}`,
        path: ["engine"],
      });
    }
    const key = optStr(v, "key", issues, 512);
    return { engine: v.engine as CaptureEngine, ...(key ? { key } : {}) };
  },
);

const speakInput = objectSchema<{ text: string; key: string; model?: string }>(
  (v, issues) => {
    const model = optStr(v, "model", issues, 64);
    return {
      text: str(v, "text", issues, 4000),
      key: str(v, "key", issues, 512),
      ...(model ? { model } : {}),
    };
  },
);

export default defineDesktopExtension({
  name: "voice",
  events: ["model"],
  setup: (host) => {
    service = new VoiceService(host.appSupportDir, (s) => emitModel(s));
    emitModel = (state) => host.emit("model", state);
    // A check of the packaged app's voice path without the UI or the microphone (see TODO.md):
    // QUTTY_VOICE_SELFTEST=<a WAV file> logs the library, fetches the model if needed, transcribes
    // the file, and plays it once.
    const wav = Deno.env.get("QUTTY_VOICE_SELFTEST");
    // Once the app is up (the window and the other extensions first).
    if (wav) {
      setTimeout(
        () =>
          selfTest(service!, wav).catch((e) =>
            console.error(`voice self-test: failed: ${e?.message ?? e}`)
          ),
        4000,
      );
    }
  },
  methods: {
    /** The native library and the model. */
    status: {
      input: emptyInput,
      handler: (): Promise<VoiceStatus> => requireService().status(),
    },
    /** Fetch the model (its progress: `model` events); the state it ends in. */
    modelDownload: {
      input: emptyInput,
      timeoutMs: false,
      handler: (): Promise<ModelState> => requireService().model.download(),
    },
    modelCancel: {
      input: emptyInput,
      handler: (): void => requireService().model.cancel(),
    },
    /** Push-to-talk pressed: open the microphone for `engine`. */
    sttStart: {
      input: startInput,
      handler: async (args: unknown): Promise<void> => {
        const { engine, key } = args as { engine: CaptureEngine; key?: string };
        await requireService().start(engine, key);
      },
    },
    /** Push-to-talk released: the transcript. */
    sttStop: {
      input: emptyInput,
      timeoutMs: TRANSCRIBE_TIMEOUT_MS + 10_000,
      handler: async (): Promise<{ text: string }> => ({
        text: await requireService().stop(),
      }),
    },
    sttCancel: {
      input: emptyInput,
      handler: (): void => requireService().cancel(),
    },
    /** Cloud speech (Deepgram Aura) played here. */
    speak: {
      input: speakInput,
      timeoutMs: false,
      handler: async (args: unknown): Promise<void> => {
        const { text, key, model } = args as {
          text: string;
          key: string;
          model?: string;
        };
        await requireService().speak(text, key, model);
      },
    },
    speakStop: {
      input: emptyInput,
      handler: (): void => service?.stopSpeaking(),
    },
  },
});
