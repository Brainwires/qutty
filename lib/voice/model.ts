/**
 * The on-device Whisper model: which one, where it lives, and its first-use download — with
 * progress, a size notice before it starts, and a SHA-256 check before it is used. Never bundled
 * in the repo or the app.
 *
 * The download itself and the file system are injected (desktop/voice.ts runs `curl` in a hidden
 * PTY, as desktop/ssh.ts runs scp, since the packaged app has no `--allow-net` or `--allow-write`
 * for it), so the state machine and the checksum rules are unit-tested.
 *
 * @module
 */

/** A Whisper ggml model the app can fetch. */
export interface WhisperModel {
  /** The file name (in `<app support>/models/`). */
  file: string;
  /** What Settings shows. */
  label: string;
  url: string;
  sizeBytes: number;
  /** Lower-case hex SHA-256 of the file (Hugging Face's LFS object id). */
  sha256: string;
}

/**
 * The default: Whisper base.en, 5-bit quantized (whisper.cpp's ggml build on Hugging Face). Small
 * (57 MB) and quick on a CPU, good for short English commands.
 */
export const WHISPER_BASE_EN: WhisperModel = {
  file: "ggml-base.en-q5_1.bin",
  label: "Whisper base.en (q5_1, English)",
  url:
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin",
  sizeBytes: 59_721_011,
  sha256: "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f",
};

/** The size as Settings says it: `57 MB`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Where the models live, under the app-support folder. */
const modelDir = (appSupportDir: string) => `${appSupportDir}/models`;
/** The model's path. */
const modelPath = (appSupportDir: string, model: WhisperModel) =>
  `${modelDir(appSupportDir)}/${model.file}`;

/** Where the model stands. */
export type ModelState =
  | { state: "missing" }
  | { state: "downloading"; received: number; total: number }
  | { state: "verifying" }
  | { state: "ready" }
  | { state: "error"; error: string };

/** What the download needs of the file system. */
export interface ModelFiles {
  /** The file's size, or `undefined` when it is not there. */
  size(path: string): Promise<number | undefined>;
  /** Lower-case hex SHA-256 of the file. */
  sha256(path: string): Promise<string>;
  ensureDir(path: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
}

/** A download in flight. */
export interface DownloadJob {
  /** Settles when the fetch ends: its exit code (0: done). */
  done: Promise<{ ok: boolean; error?: string }>;
  cancel(): void;
}

/** Fetch `url` into `dest` (replacing it). */
export type Fetcher = (url: string, dest: string) => DownloadJob;

export interface ModelStoreOptions {
  appSupportDir: string;
  model?: WhisperModel;
  files: ModelFiles;
  fetch: Fetcher;
  onState?(state: ModelState): void;
  /** How often progress is read (ms). */
  pollMs?: number;
}

/** The model's file, its download and its check. */
export class ModelStore {
  readonly model: WhisperModel;
  #opts: ModelStoreOptions;
  #state: ModelState = { state: "missing" };
  #job: DownloadJob | undefined;
  #verified = false;

  constructor(opts: ModelStoreOptions) {
    this.#opts = opts;
    this.model = opts.model ?? WHISPER_BASE_EN;
  }

  get path(): string {
    return modelPath(this.#opts.appSupportDir, this.model);
  }

  get state(): ModelState {
    return this.#state;
  }

  #set(state: ModelState): void {
    this.#state = state;
    this.#opts.onState?.(state);
  }

  /**
   * Whether the model is there and good. The first call in a session checks the SHA-256 of a file
   * with the right size; a file that fails is removed.
   */
  async check(): Promise<ModelState> {
    if (this.#job) return this.#state;
    const size = await this.#opts.files.size(this.path);
    if (size === undefined) {
      this.#verified = false;
      this.#set({ state: "missing" });
    } else if (this.#verified) {
      this.#set({ state: "ready" });
    } else {
      await this.#verify(this.path);
    }
    return this.#state;
  }

  /** Download the model (a no-op while one runs). Resolves with the final state. */
  async download(): Promise<ModelState> {
    if (this.#job) return this.#state;
    const { files } = this.#opts;
    const part = `${this.path}.part`;
    files.ensureDir(this.#opts.appSupportDir);
    files.ensureDir(modelDir(this.#opts.appSupportDir));
    const total = this.model.sizeBytes;
    this.#set({ state: "downloading", received: 0, total });
    const job = this.#opts.fetch(this.model.url, part);
    this.#job = job;
    const timer = setInterval(async () => {
      const received = await files.size(part).catch(() => undefined) ?? 0;
      if (this.#job === job) {
        this.#set({ state: "downloading", received, total });
      }
    }, this.#opts.pollMs ?? 250);
    let result: { ok: boolean; error?: string };
    try {
      result = await job.done;
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearInterval(timer);
    }
    const cancelled = this.#job !== job;
    this.#job = undefined;
    if (cancelled) return this.#state;
    if (!result.ok) {
      tryRemove(files, part);
      this.#set({ state: "error", error: result.error ?? "download failed" });
      return this.#state;
    }
    if (await this.#verify(part)) {
      files.rename(part, this.path);
      this.#set({ state: "ready" });
    }
    return this.#state;
  }

  /** Stop a download in flight; its partial file is removed. */
  cancel(): void {
    const job = this.#job;
    if (!job) return;
    this.#job = undefined;
    job.cancel();
    tryRemove(this.#opts.files, `${this.path}.part`);
    this.#set({ state: "missing" });
  }

  /** Check `path`'s size and SHA-256; a bad file is removed and the state says why. */
  async #verify(path: string): Promise<boolean> {
    const { files } = this.#opts;
    this.#set({ state: "verifying" });
    const size = await files.size(path);
    const error = size !== this.model.sizeBytes
      ? `the download has ${size ?? 0} bytes, not ${this.model.sizeBytes}`
      : (await files.sha256(path)) !== this.model.sha256
      ? "the download's checksum does not match"
      : undefined;
    if (error) {
      tryRemove(files, path);
      this.#verified = false;
      this.#set({ state: "error", error });
      return false;
    }
    this.#verified = true;
    this.#set({ state: "ready" });
    return true;
  }
}

function tryRemove(files: ModelFiles, path: string): void {
  try {
    files.remove(path);
  } catch { /* already gone */ }
}

/** Lower-case hex of a digest. */
export function hex(digest: ArrayBuffer): string {
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}
