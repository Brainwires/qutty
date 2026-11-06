/**
 * The binding to rullama-hardware's audio, built as the `rullama-audio-ffi` cdylib in the Rullama
 * repo (crates/rullama-audio-ffi: cpal capture, Whisper through whisper-rs, webrtc-vad trimming,
 * cpal playback; its C header is include/rullama_audio.h). Loaded with `Deno.dlopen` by
 * desktop/voice.ts; the symbol table and the typed wrapper live here so they are tested against a
 * fake library where the real one is not built (Linux CI).
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
} as const satisfies Deno.ForeignLibraryInterface;

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

/**
 * Where the library is looked for, in order:
 * 1. `QUTTY_AUDIO_LIB` (a developer's build);
 * 2. beside the app: `Contents/Frameworks/` of a macOS bundle, `lib/` beside a Linux binary (for
 *    when Denext's packager can put extra files there; see TODO.md);
 * 3. `<app support>/audio/`, where `deno task audio:lib` installs a local build.
 */
export function audioLibCandidates(opts: {
  os: typeof Deno.build.os;
  env?: string;
  execPath?: string;
  appSupportDir?: string;
}): string[] {
  const file = audioLibFile(opts.os);
  const out: string[] = [];
  if (opts.env) out.push(opts.env);
  if (opts.execPath) {
    const dir = opts.execPath.slice(0, opts.execPath.lastIndexOf("/"));
    if (opts.os === "darwin" && dir.endsWith(".app/Contents/MacOS")) {
      out.push(`${dir.slice(0, -"MacOS".length)}Frameworks/${file}`);
    } else if (dir) {
      out.push(`${dir}/lib/${file}`);
    }
  }
  if (opts.appSupportDir) out.push(`${opts.appSupportDir}/audio/${file}`);
  return out;
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
}
