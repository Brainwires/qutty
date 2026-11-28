/**
 * Kokoro, the on-device neural voice: which files it needs (the ONNX model and the voices, fetched
 * on first use with their SHA-256 checked, like the Whisper model: lib/voice/model.ts), the set of
 * them as one download with one progress, the voices as Settings lists them (grouped by accent:
 * "American English — Heart"), and whether it can speak now. Synthesis runs in the native audio
 * library (rullama-audio-ffi's `rla_tts_*`, lib/voice/ffi.ts); nothing is sent anywhere.
 *
 * Sources and licenses (docs/voice-kokoro.md): Kokoro-82M v1.0 by hexgrad, Apache-2.0; the ONNX
 * export is onnx-community's on Hugging Face (Apache-2.0), pinned to a commit; the voices file is
 * kokoro-onnx's release asset (the same voices as hexgrad's, as one NumPy archive).
 *
 * Client-safe and pure (the file system and the fetcher are injected, as for the Whisper model).
 *
 * @module
 */

import {
  type Fetcher,
  type ModelFile,
  type ModelFiles,
  type ModelState,
  ModelStore,
} from "./model.ts";

/**
 * The Kokoro-82M v1.0 model: onnx-community's full-precision ONNX export (`onnx/model.onnx`), the
 * reference one and the fastest on a CPU (the 8-bit exports are smaller but ran at half the speed
 * here; docs/voice-kokoro.md has the measurements).
 */
export const KOKORO_MODEL: ModelFile = {
  file: "kokoro-82m-v1.0.onnx",
  label: "Kokoro voice model",
  url:
    "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx",
  sizeBytes: 325_532_232,
  sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
};

/** Kokoro v1.0's voices (54 style tables in one NumPy archive; the English ones are used). */
export const KOKORO_VOICES: ModelFile = {
  file: "kokoro-voices-v1.0.bin",
  label: "Kokoro voices",
  url:
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
  sizeBytes: 28_214_398,
  sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
};

/** What Kokoro needs on disk, in download order (the small file first: a quick first failure). */
export const KOKORO_FILES: readonly ModelFile[] = [KOKORO_VOICES, KOKORO_MODEL];

/** A voice, as the native library lists it (`rla_tts_voices` / `rla_tts_list_voices`). */
export interface KokoroVoice {
  /** What synthesis takes: `af_heart`. */
  id: string;
  /** `Heart`. */
  name: string;
  /** `en-US` or `en-GB`. */
  lang: string;
  /** `American English`. */
  language: string;
  gender: "female" | "male";
  /** The library's default voice. */
  default: boolean;
}

/** The library's voices JSON, each entry checked (a malformed one is dropped). */
export function parseKokoroVoices(json: string): KokoroVoice[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: KokoroVoice[] = [];
  for (const v of raw as Record<string, unknown>[]) {
    if (!v || typeof v !== "object") continue;
    const { id, name, lang, language, gender } = v;
    if (
      typeof id !== "string" || !/^[a-z0-9_]{1,64}$/.test(id) ||
      typeof name !== "string" || typeof lang !== "string" ||
      typeof language !== "string" ||
      (gender !== "female" && gender !== "male")
    ) continue;
    out.push({ id, name, lang, language, gender, default: v.default === true });
  }
  return out;
}

/** Voices of one accent, as a Settings `<optgroup>`. */
export interface KokoroVoiceGroup {
  /** `American English`. */
  language: string;
  voices: { id: string; label: string }[];
}

/** A voice as Settings names it: `American English — Heart (female)`. */
export function kokoroVoiceLabel(v: KokoroVoice): string {
  return `${v.language} — ${v.name} (${v.gender})`;
}

/**
 * The voices grouped by accent, American first then by name, each group's women before its men
 * and both by name; an option's own text names the accent too (it is what a closed list shows).
 */
export function groupKokoroVoices(voices: KokoroVoice[]): KokoroVoiceGroup[] {
  const groups = new Map<string, KokoroVoice[]>();
  for (const v of voices) {
    const list = groups.get(v.language);
    if (list) list.push(v);
    else groups.set(v.language, [v]);
  }
  const rank = (language: string) => language.startsWith("American") ? 0 : 1;
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([language, list]) => ({
      language,
      voices: list
        .sort((a, b) =>
          a.gender.localeCompare(b.gender) || a.name.localeCompare(b.name)
        )
        .map((v) => ({ id: v.id, label: kokoroVoiceLabel(v) })),
    }));
}

/**
 * The voice to speak with: the picked one when the library has it, else the library's default
 * (`af_heart`), else its first. `undefined` leaves the choice to the library.
 */
export function pickKokoroVoice(
  picked: string,
  voices: KokoroVoice[],
): string | undefined {
  if (voices.some((v) => v.id === picked)) return picked;
  return (voices.find((v) => v.default) ?? voices[0])?.id;
}

/** Where Kokoro stands: the native library's speech support and the files. */
export interface KokoroStatus {
  /** Whether the audio library is there and was built with speech (`rla_tts_available`). */
  available: boolean;
  /** Why not, when `available` is false. */
  reason?: string;
  /** The files' state, as one. */
  files: ModelState & { size: string };
}

/** Whether Kokoro can speak now: the library has it and the files are downloaded and checked. */
export function kokoroReady(status: KokoroStatus | undefined): boolean {
  return status?.available === true && status.files.state === "ready";
}

/** The states of a set's files, as one: what `active` (a download running) changes is below. */
export function combineStates(
  parts: { state: ModelState; sizeBytes: number }[],
  active: boolean,
): ModelState {
  const failed = parts.find((p) => p.state.state === "error");
  if (failed) return failed.state;
  const total = parts.reduce((n, p) => n + p.sizeBytes, 0);
  if (parts.every((p) => p.state.state === "ready")) return { state: "ready" };
  if (active || parts.some((p) => p.state.state === "downloading")) {
    // One "verifying" file inside a running download is still the download, nearly done.
    const received = parts.reduce(
      (n, p) =>
        n +
        (p.state.state === "ready" || p.state.state === "verifying"
          ? p.sizeBytes
          : p.state.state === "downloading"
          ? Math.min(p.state.received, p.sizeBytes)
          : 0),
      0,
    );
    return { state: "downloading", received, total };
  }
  if (parts.some((p) => p.state.state === "verifying")) {
    return { state: "verifying" };
  }
  return { state: "missing" };
}

/** Whether two states say the same thing (a set only reports a change). */
function sameState(a: ModelState, b: ModelState): boolean {
  if (a.state === "downloading" && b.state === "downloading") {
    return a.received === b.received && a.total === b.total;
  }
  if (a.state === "error" && b.state === "error") return a.error === b.error;
  return a.state === b.state;
}

export interface ModelSetOptions {
  appSupportDir: string;
  models: readonly ModelFile[];
  files: ModelFiles;
  fetch: Fetcher;
  onState?(state: ModelState): void;
  /** How often progress is read (ms). */
  pollMs?: number;
}

/**
 * Several model files as one: checked together, fetched one after the other with one progress
 * (the bytes of all of them), each with its own size and SHA-256 check ({@linkcode ModelStore}).
 */
export class ModelSet {
  readonly stores: ModelStore[];
  #opts: ModelSetOptions;
  #active = false;
  #cancelled = false;
  #state: ModelState = { state: "missing" };

  constructor(opts: ModelSetOptions) {
    this.#opts = opts;
    this.stores = opts.models.map((model) =>
      new ModelStore({
        appSupportDir: opts.appSupportDir,
        model,
        files: opts.files,
        fetch: opts.fetch,
        onState: () => this.#update(),
        ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
      })
    );
  }

  /** The bytes of all the files. */
  get totalBytes(): number {
    return this.stores.reduce((n, s) => n + s.model.sizeBytes, 0);
  }

  /** The files' paths, in the order of `models`. */
  get paths(): string[] {
    return this.stores.map((s) => s.path);
  }

  get state(): ModelState {
    return this.#state;
  }

  #update(): void {
    const next = combineStates(
      this.stores.map((s) => ({
        state: s.state,
        sizeBytes: s.model.sizeBytes,
      })),
      // A cancelled download is over for the page, though its fetch is still winding down.
      this.#active && !this.#cancelled,
    );
    const changed = !sameState(this.#state, next);
    this.#state = next;
    if (changed) this.#opts.onState?.(next);
  }

  /** Whether every file is there and good (each checked once per session). */
  async check(): Promise<ModelState> {
    if (this.#active) return this.#state;
    for (const store of this.stores) await store.check();
    this.#update();
    return this.#state;
  }

  /** Fetch the files that are missing (a no-op while a download runs): the state it ends in. */
  async download(): Promise<ModelState> {
    if (this.#active) return this.#state;
    this.#active = true;
    this.#cancelled = false;
    try {
      for (const store of this.stores) {
        if (this.#cancelled) break;
        if ((await store.check()).state === "ready") continue;
        if (this.#cancelled) break;
        const end = await store.download();
        if (end.state !== "ready") break;
      }
    } finally {
      this.#active = false;
      this.#update();
    }
    return this.#state;
  }

  /** Stop a download in flight; the files already fetched and checked are kept. */
  cancel(): void {
    if (!this.#active) return;
    this.#cancelled = true;
    for (const store of this.stores) store.cancel();
    this.#update();
  }
}
