/**
 * The binding to rullama-hardware's audio, built as the `rullama-audio-ffi` cdylib in the Rullama
 * repo (crates/rullama-audio-ffi: cpal capture, Whisper through whisper-rs, webrtc-vad trimming,
 * cpal playback, Kokoro text-to-speech; its C header is include/rullama_audio.h). Loaded with
 * `Deno.dlopen` by desktop/voice.ts; the symbol table and the typed wrapper live here so they are
 * tested against a fake library where the real one is not built (Linux CI).
 *
 * The speech symbols (`rla_abi_version`, `rla_tts_*`: ABI version 2) are optional: a library built
 * before them still loads and does everything else ({@linkcode AudioLib.ttsAvailable} says no).
 *
 * @module
 */

/** The library's symbols, exactly as rullama_audio.h declares them. */
export const AUDIO_SYMBOLS = {
  rla_version: { parameters: [], result: "pointer" },
  rla_last_error: { parameters: ["buffer", "usize"], result: "i32" },
  rla_stt_load: { parameters: ["buffer"], result: "i32" },
  rla_stt_loaded: { parameters: [], result: "i32" },
  rla_capture_start: { parameters: [], result: "i32" },
  rla_capture_stop: { parameters: [], result: "i32" },
  rla_capture_stop_wav: { parameters: ["buffer"], result: "i32" },
  rla_cancel: { parameters: [], result: "i32" },
  rla_state: { parameters: [], result: "i32" },
  rla_level: { parameters: [], result: "f32" },
  rla_captured_ms: { parameters: [], result: "u32" },
  rla_take_transcript: { parameters: ["buffer", "usize"], result: "i32" },
  // Whisper on a file: seconds of CPU, so it runs on Deno's blocking pool.
  rla_transcribe_wav: {
    parameters: ["buffer", "buffer", "usize"],
    result: "i32",
    nonblocking: true,
  },
  rla_play_wav: { parameters: ["buffer"], result: "i32" },
  rla_play_stop: { parameters: [], result: "i32" },
  rla_playing: { parameters: [], result: "i32" },
  // ABI version 2: Kokoro speech. Optional, so an older library still loads.
  rla_abi_version: { parameters: [], result: "i32", optional: true },
  rla_tts_available: { parameters: [], result: "i32", optional: true },
  // Reads the ONNX model (hundreds of MB): on Deno's blocking pool.
  rla_tts_load: {
    parameters: ["buffer", "buffer"],
    result: "i32",
    nonblocking: true,
    optional: true,
  },
  rla_tts_list_voices: {
    parameters: ["buffer", "buffer", "usize"],
    result: "i32",
    optional: true,
  },
  rla_tts_free: { parameters: ["i32"], result: "i32", optional: true },
  rla_tts_voices: {
    parameters: ["i32", "buffer", "usize"],
    result: "i32",
    optional: true,
  },
  rla_tts_speak: {
    parameters: ["i32", "buffer", "buffer", "f32", "f32"],
    result: "i32",
    optional: true,
  },
  rla_tts_cancel: { parameters: ["i32"], result: "i32", optional: true },
  rla_tts_speaking: { parameters: ["i32"], result: "i32", optional: true },
} as const satisfies Deno.ForeignLibraryInterface;

/** The symbols a library has only from ABI version 2 on (all optional in the table). */
export const TTS_SYMBOLS = [
  "rla_abi_version",
  "rla_tts_available",
  "rla_tts_load",
  "rla_tts_list_voices",
  "rla_tts_free",
  "rla_tts_voices",
  "rla_tts_speak",
  "rla_tts_cancel",
  "rla_tts_speaking",
] as const satisfies readonly (keyof typeof AUDIO_SYMBOLS)[];

/** What `Deno.dlopen(path, AUDIO_SYMBOLS).symbols` gives (a fake implements the same). */
export type AudioSymbols = Deno.DynamicLibrary<typeof AUDIO_SYMBOLS>["symbols"];

/** `rla_state` values. */
export const CaptureState = {
  idle: 0,
  capturing: 1,
  transcribing: 2,
  done: 3,
  error: 4,
} as const;

/** The library's error codes. */
export const AudioCode = {
  error: -1,
  wrongState: -2,
  noModel: -3,
  noDevice: -4,
} as const;

/** The library's file name on `os`. */
export function audioLibFile(os: typeof Deno.build.os): string {
  return os === "darwin"
    ? "librullama_audio_ffi.dylib"
    : os === "windows"
    ? "rullama_audio_ffi.dll"
    : "librullama_audio_ffi.so";
}

/** The library's name in `desktop.bundle.libraries` (denext.config.ts) and `bundledLibraryPath`. */
export const AUDIO_LIB_NAME = "rullama_audio_ffi";

/** The `desktop.bundle.libraries` target of `os` / `arch` (`darwin-arm64`), or `undefined`. */
export function audioLibTarget(
  os: typeof Deno.build.os,
  arch: typeof Deno.build.arch,
): string | undefined {
  const a = arch === "aarch64"
    ? "arm64"
    : arch === "x86_64"
    ? "x64"
    : undefined;
  return a && (os === "darwin" || os === "linux" || os === "windows")
    ? `${os}-${a}`
    : undefined;
}

/**
 * Where the library is looked for, in order:
 * 1. `QUTTY_AUDIO_LIB` (a developer's build);
 * 2. the app's bundled copy (`desktop.bundle.libraries`: Denext's `bundledLibraryPath`, in
 *    `Contents/Frameworks/` of a macOS bundle, `lib/` beside a Linux binary, beside the Windows
 *    `.exe`, or the project's `native/<target>/` file under `denext desktop run`);
 * 3. `<app support>/audio/`, where `deno task audio:lib` installs a local build.
 */
export function audioLibCandidates(opts: {
  os: typeof Deno.build.os;
  env?: string;
  /** `bundledLibraryPath(AUDIO_LIB_NAME)`: `null` when this build bundles none for the host. */
  bundled?: string | null;
  appSupportDir?: string;
}): string[] {
  const file = audioLibFile(opts.os);
  const out: string[] = [];
  if (opts.env) out.push(opts.env);
  if (opts.bundled) out.push(opts.bundled);
  if (opts.appSupportDir) out.push(`${opts.appSupportDir}/audio/${file}`);
  return [...new Set(out)];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `s` as a NUL-terminated UTF-8 buffer. */
function cString(s: string): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(`${s}\0`);
  return bytes as Uint8Array<ArrayBuffer>;
}

/** The text a call wrote into `buf` (NUL-terminated, at most `len` bytes). */
function bufText(buf: Uint8Array, len: number): string {
  const end = Math.min(len, buf.length - 1);
  const nul = buf.indexOf(0);
  return decoder.decode(buf.subarray(0, nul >= 0 && nul < end ? nul : end));
}

/** The largest transcript read (64 KiB is ~10 minutes of speech). */
const TEXT_CAP = 64 * 1024;

/** What a library without the speech symbols says when asked to speak. */
const NO_TTS = "this audio library has no text-to-speech";

/** A failed library call, with its code and the library's message. */
export class AudioError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "AudioError";
  }
}

/** The typed library: every call checked, errors thrown with the library's own message. */
export class AudioLib {
  #s: AudioSymbols;
  #pointerText: (p: Deno.PointerValue) => string;

  constructor(
    symbols: AudioSymbols,
    pointerText: (p: Deno.PointerValue) => string = (p) =>
      p === null ? "" : new Deno.UnsafePointerView(p).getCString(),
  ) {
    this.#s = symbols;
    this.#pointerText = pointerText;
  }

  version(): string {
    return this.#pointerText(this.#s.rla_version());
  }

  /** The last error's message. */
  lastError(): string {
    const buf = new Uint8Array(1024);
    const len = this.#s.rla_last_error(buf, BigInt(buf.length));
    return bufText(buf, len) || "unknown error";
  }

  #check(code: number, what: string): number {
    if (code >= 0) return code;
    const reason = code === AudioCode.wrongState
      ? "not now (another capture is in progress)"
      : code === AudioCode.noModel
      ? "no speech model is loaded"
      : code === AudioCode.noDevice
      ? "no microphone was found"
      : this.lastError();
    throw new AudioError(code, `${what}: ${reason}`);
  }

  loadModel(path: string): void {
    this.#check(this.#s.rla_stt_load(cString(path)), "loading the model");
  }

  modelLoaded(): boolean {
    return this.#s.rla_stt_loaded() === 1;
  }

  startCapture(): void {
    this.#check(this.#s.rla_capture_start(), "starting the microphone");
  }

  /** Stop and transcribe on the library's worker; poll {@linkcode state}, then {@linkcode take}. */
  stopCapture(): void {
    this.#check(this.#s.rla_capture_stop(), "stopping the microphone");
  }

  /** Stop and write the audio to a WAV file instead (for a cloud engine): its length in ms. */
  stopCaptureToWav(path: string): number {
    return this.#check(
      this.#s.rla_capture_stop_wav(cString(path)),
      "saving the recording",
    );
  }

  cancel(): void {
    this.#s.rla_cancel();
  }

  state(): number {
    return this.#s.rla_state();
  }

  level(): number {
    return this.#s.rla_level();
  }

  capturedMs(): number {
    return this.#s.rla_captured_ms();
  }

  /** The finished transcript (state `done`); throws the library's error in state `error`. */
  take(): string {
    const buf = new Uint8Array(TEXT_CAP);
    const len = this.#check(
      this.#s.rla_take_transcript(buf, BigInt(buf.length)),
      "transcribing",
    );
    return bufText(buf, len).trim();
  }

  /** Whisper on a WAV file (on Deno's blocking pool). */
  async transcribeWav(path: string): Promise<string> {
    const buf = new Uint8Array(TEXT_CAP);
    const len = this.#check(
      await this.#s.rla_transcribe_wav(cString(path), buf, BigInt(buf.length)),
      "transcribing",
    );
    return bufText(buf, len).trim();
  }

  playWav(path: string): void {
    this.#check(this.#s.rla_play_wav(cString(path)), "playing");
  }

  stopPlayback(): void {
    this.#s.rla_play_stop();
  }

  playing(): boolean {
    return this.#s.rla_playing() === 1;
  }

  /** The library's ABI version: 1 before `rla_abi_version` existed, 2 with speech. */
  abiVersion(): number {
    return this.#s.rla_abi_version?.() ?? 1;
  }

  /** Whether the library can speak: it has the `rla_tts_*` symbols and was built with Kokoro. */
  ttsAvailable(): boolean {
    const s = this.#s;
    return TTS_SYMBOLS.every((name) => typeof s[name] === "function") &&
      s.rla_tts_available?.() === 1;
  }

  /** A speech symbol, or an {@linkcode AudioError} when the library predates it. */
  #tts<K extends typeof TTS_SYMBOLS[number]>(
    name: K,
  ): NonNullable<AudioSymbols[K]> {
    const fn = this.#s[name];
    if (!fn) throw new AudioError(AudioCode.error, NO_TTS);
    return fn as NonNullable<AudioSymbols[K]>;
  }

  /**
   * Load a Kokoro model and its voices (on Deno's blocking pool: about a second): the handle the
   * other speech calls take.
   */
  async ttsLoad(modelPath: string, voicesPath: string): Promise<number> {
    const load = this.#tts("rla_tts_load");
    // Named, so the buffers live until the call settles.
    const model = cString(modelPath);
    const voices = cString(voicesPath);
    return this.#check(await load(model, voices), "loading the voice model");
  }

  /** The voices of a voices file, as JSON, without loading a model. */
  ttsListVoices(voicesPath: string): string {
    const buf = new Uint8Array(TEXT_CAP);
    const len = this.#check(
      this.#tts("rla_tts_list_voices")(
        cString(voicesPath),
        buf,
        BigInt(buf.length),
      ),
      "reading the voices",
    );
    return bufText(buf, len);
  }

  /** A loaded model's voices, as JSON. */
  ttsVoices(handle: number): string {
    const buf = new Uint8Array(TEXT_CAP);
    const len = this.#check(
      this.#tts("rla_tts_voices")(handle, buf, BigInt(buf.length)),
      "reading the voices",
    );
    return bufText(buf, len);
  }

  /**
   * Start saying `text` on the default output (returns at once; poll {@linkcode ttsSpeaking}),
   * replacing whatever the handle is saying. `voice` `""` is the library's default; `speed` is
   * 0.5–2, `volume` 0–1.
   */
  ttsSpeak(
    handle: number,
    text: string,
    opts: { voice?: string; speed?: number; volume?: number } = {},
  ): void {
    this.#check(
      this.#tts("rla_tts_speak")(
        handle,
        cString(text),
        cString(opts.voice ?? ""),
        opts.speed ?? 1,
        opts.volume ?? 1,
      ),
      "speaking",
    );
  }

  /** Whether the handle is still speaking; throws the error of a speech that failed (once). */
  ttsSpeaking(handle: number): boolean {
    return this.#check(
      this.#tts("rla_tts_speaking")(handle),
      "speaking",
    ) === 1;
  }

  /** Stop what the handle is saying, now (barge-in). Never throws. */
  ttsCancel(handle: number): void {
    this.#s.rla_tts_cancel?.(handle);
  }

  /** Stop the handle and unload its model. Never throws. */
  ttsFree(handle: number): void {
    this.#s.rla_tts_free?.(handle);
  }
}
