// Shared helpers for the PTY daemon tests (not a test module itself): a fake `Deno.openPty` whose
// terminals the test drives, and an in-memory connection pair (the fake transport).

import type { DenoPty, DenoPtyOptions, DenoPtyStatus } from "../desktop/pty.ts";
import type { PtydConnection } from "../desktop/ptyd.ts";

const utf8 = new TextEncoder();
const text = new TextDecoder();

/** A terminal of {@linkcode fakeOpenPty}: the test prints into it and ends it. */
class FakePty implements DenoPty {
  static #next = 1000;
  readonly pid = FakePty.#next++;
  readonly options: DenoPtyOptions;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly status: Promise<DenoPtyStatus>;
  /** What was written to it, decoded. */
  input = "";
  sizes: [number, number][] = [];
  signals: string[] = [];
  #out!: ReadableStreamDefaultController<Uint8Array>;
  #end!: (s: DenoPtyStatus) => void;
  #ended = false;

  constructor(options: DenoPtyOptions) {
    this.options = options;
    this.readable = new ReadableStream({ start: (c) => (this.#out = c) });
    this.writable = new WritableStream({
      write: (bytes) => {
        this.input += text.decode(bytes);
      },
    });
    this.status = new Promise((r) => (this.#end = r));
  }

  /** The program prints `s`. */
  print(s: string): void {
    if (!this.#ended) this.#out.enqueue(utf8.encode(s));
  }

  /** The program ends. */
  exit(code = 0, signal: string | null = null): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#out.close();
    } catch { /* cancelled */ }
    this.#end({ success: code === 0 && signal === null, code, signal });
  }

  get ended(): boolean {
    return this.#ended;
  }

  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }

  /** A signal ends it (as a shell without traps). */
  kill(signal = "SIGTERM"): void {
    this.signals.push(signal);
    this.exit(0, signal);
  }
}

/**
 * A fake `Deno.openPty` and the terminals it opened. `greeting`: what each prints the moment it
 * starts (before the daemon has answered the spawn).
 */
export function fakeOpenPty(greeting?: string) {
  const opened: FakePty[] = [];
  return {
    opened,
    open: (options: DenoPtyOptions): FakePty => {
      const p = new FakePty(options);
      if (greeting) p.print(greeting);
      opened.push(p);
      return p;
    },
  };
}

/** Two connected in-memory byte streams (the daemon's end and the app's end). */
export function pipePair(): [PtydConnection, PtydConnection] {
  const side = () => {
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (x) => (c = x) });
    return { readable, c };
  };
  const a = side();
  const b = side();
  let closed = false;
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    for (const s of [a, b]) {
      try {
        s.c.close();
      } catch { /* closed */ }
    }
    return Promise.resolve();
  };
  const end = (
    readable: ReadableStream<Uint8Array>,
    into: ReadableStreamDefaultController<Uint8Array>,
  ): PtydConnection => ({
    readable,
    write: (bytes) => {
      if (closed) return Promise.reject(new Error("closed"));
      into.enqueue(bytes.slice());
      return Promise.resolve(bytes.length);
    },
    close,
  });
  return [end(a.readable, b.c), end(b.readable, a.c)];
}
