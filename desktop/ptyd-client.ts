// The app's side of the PTY daemon (desktop/ptyd.ts): one connection, requests matched to their
// answers, and each daemon terminal as a `DenoPty` (`RemotePty`), so the PTY host (desktop/pty.ts)
// runs it exactly as one of its own: output on `readable`, input on `writable`, `resize`, `kill`,
// the exit on `status`.
//
// A terminal the app started (`open`) or took over at launch (`adopt`, with the output it missed)
// is attached to this connection: its events come here. `detach` lets it go without killing it
// (the quit that keeps shells running); the connection's end does the same for all of them.

import type { DenoPty, DenoPtyOptions, DenoPtyStatus } from "./pty.ts";
import type { PtydConnection } from "./ptyd.ts";
import {
  encodeLine,
  LineDecoder,
  PTYD_PROTOCOL,
  type PtydExit,
  type PtydRequest,
  type PtydResults,
  type PtydSession,
  ptydSocketName,
  ptydSocketVersion,
} from "../lib/ptyd/protocol.ts";
import { connectIpc, ipcChannelPath, isPipePath } from "./ipc.ts";

/** A request without its id, by op. */
type RequestOf<K extends PtydRequest["op"]> = Omit<
  Extract<PtydRequest, { op: K }>,
  "op"
>;

const utf8 = new TextEncoder();

/** Bytes as a string of U+0000..U+00FF, one char per byte. */
function byteString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return s;
}

/** A daemon terminal as the PTY host sees it. */
export class RemotePty implements DenoPty {
  readonly sid: string;
  readonly pid: number;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly status: Promise<DenoPtyStatus>;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #resolve!: (s: DenoPtyStatus) => void;
  #client: PtydClient;
  #ended = false;

  constructor(client: PtydClient, sid: string, pid: number) {
    this.#client = client;
    this.sid = sid;
    this.pid = pid;
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#controller = c;
      },
    });
    this.status = new Promise((r) => (this.#resolve = r));
    this.writable = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        if (this.#ended) throw new Error("the terminal has ended");
        // Bytes as one char each (`binary`): the daemon writes them back as they were.
        await client.request("write", {
          sid,
          data: byteString(bytes),
          binary: true,
        });
      },
    });
  }

  resize(cols: number, rows: number): void {
    void this.#client.request("resize", { sid: this.sid, cols, rows })
      .catch(() => {});
  }

  kill(signal = "SIGTERM"): void {
    void this.#client.request("kill", { sid: this.sid, signal })
      .catch(() => {});
  }

  /** Stop getting its events; it keeps running in the daemon. */
  detach(): void {
    this.#client.forget(this.sid);
    void this.#client.request("detach", { sid: this.sid }).catch(() => {});
  }

  /** Output from the daemon. */
  data(text: string): void {
    if (this.#ended) return;
    try {
      this.#controller.enqueue(utf8.encode(text));
    } catch { /* cancelled */ }
  }

  /** The program ended (or the daemon went away: `exit` undefined). */
  exited(exit: PtydExit | undefined): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#controller.close();
    } catch { /* cancelled */ }
    const e = exit ?? { code: -1, signal: null };
    this.#resolve({
      success: e.code === 0 && e.signal === null,
      code: e.code,
      signal: e.signal,
    });
  }
}

/** One connection to the daemon. */
export class PtydClient {
  readonly #conn: PtydConnection;
  #next = 0;
  readonly #waiting = new Map<
    number,
    {
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  readonly #ptys = new Map<string, RemotePty>();
  /** Events of terminals whose `spawn` has not been answered yet, by sid. */
  readonly #early = new Map<string, Record<string, unknown>[]>();
  #chain: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #onClose = new Set<() => void>();
  readonly done: Promise<void>;

  constructor(conn: PtydConnection) {
    this.#conn = conn;
    this.done = this.#read();
  }

  /** Whether the connection has ended. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Call `fn` once the connection ends. */
  onClose(fn: () => void): () => void {
    this.#onClose.add(fn);
    return () => this.#onClose.delete(fn);
  }

  /** Send a request and wait for its answer (rejects with the daemon's error). */
  request<K extends PtydRequest["op"]>(
    op: K,
    args: RequestOf<K>,
  ): Promise<PtydResults[K]> {
    if (this.#closed) return Promise.reject(new Error("ptyd: disconnected"));
    const id = ++this.#next;
    const bytes = utf8.encode(encodeLine({ id, op, ...args }));
    const answer = new Promise<Record<string, unknown>>((resolve, reject) =>
      this.#waiting.set(id, { resolve, reject })
    );
    this.#chain = this.#chain.then(async () => {
      let off = 0;
      while (off < bytes.length) {
        off += await this.#conn.write(bytes.subarray(off));
      }
    }).catch(() => this.#end());
    return answer as Promise<PtydResults[K]>;
  }

  /** `hello`: the daemon's protocol version and pid. */
  hello(): Promise<{ v: number; pid: number }> {
    return this.request("hello", { v: PTYD_PROTOCOL });
  }

  /** Every terminal the daemon holds. */
  async list(): Promise<PtydSession[]> {
    return (await this.request("list", {})).sessions;
  }

  /** Start a terminal in the daemon (attached here) as terminal `sid`. */
  async open(sid: string, o: DenoPtyOptions): Promise<RemotePty> {
    const early: Record<string, unknown>[] = [];
    this.#early.set(sid, early);
    try {
      const { pid } = await this.request("spawn", {
        sid,
        cmd: o.cmd,
        args: o.args ?? [],
        ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
        env: o.env ?? {},
        cols: o.cols,
        rows: o.rows,
      });
      const pty = this.#track(new RemotePty(this, sid, pid));
      for (const m of early) this.#event(pty, m);
      return pty;
    } finally {
      this.#early.delete(sid);
    }
  }

  /**
   * Take over daemon terminal `sid`: its events come here from now on, and the answer has what it
   * printed before (and its exit, when it ended while nobody was attached).
   */
  async adopt(
    sid: string,
    pid: number,
  ): Promise<
    { pty: RemotePty; replay: string; truncated: boolean; exit?: PtydExit }
  > {
    // Tracked first: an event right after the answer must find it.
    const pty = this.#track(new RemotePty(this, sid, pid));
    try {
      const { replay, truncated, exit } = await this.request("attach", { sid });
      if (exit) {
        // It ended while nobody was attached: its replay ends with the exit.
        this.#ptys.delete(sid);
        queueMicrotask(() => pty.exited(exit));
      }
      return { pty, replay, truncated, ...(exit ? { exit } : {}) };
    } catch (err) {
      this.#ptys.delete(sid);
      throw err;
    }
  }

  /** Stop routing `sid`'s events here (it is detached or released). */
  forget(sid: string): void {
    this.#ptys.delete(sid);
  }

  /** Close the connection: every attached terminal is left running in the daemon. */
  async close(): Promise<void> {
    this.#end();
    await this.#conn.close().catch(() => {});
  }

  #track(pty: RemotePty): RemotePty {
    this.#ptys.set(pty.sid, pty);
    return pty;
  }

  async #read(): Promise<void> {
    const lines = new LineDecoder();
    const reader = this.#conn.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of lines.push(value)) this.#dispatch(line);
      }
    } catch {
      /* the daemon went away */
    } finally {
      reader.releaseLock();
      this.#end();
    }
  }

  #dispatch(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m.re === "number") {
      const w = this.#waiting.get(m.re);
      if (!w) return;
      this.#waiting.delete(m.re);
      const { re: _re, ok, error, ...result } = m;
      if (ok === true) w.resolve(result);
      else w.reject(new Error(`ptyd: ${String(error ?? "failed")}`));
      return;
    }
    if (typeof m.sid !== "string") return;
    const pty = this.#ptys.get(m.sid);
    if (pty) this.#event(pty, m);
    // A terminal being started: its first output can come before the answer to `spawn`.
    else this.#early.get(m.sid)?.push(m);
  }

  #event(pty: RemotePty, m: Record<string, unknown>): void {
    if (m.ev === "data" && typeof m.data === "string") pty.data(m.data);
    else if (m.ev === "exit") {
      this.#ptys.delete(pty.sid);
      pty.exited({
        code: typeof m.code === "number" ? m.code : -1,
        signal: typeof m.signal === "string" ? m.signal : null,
      });
    }
  }

  #end(): void {
    if (this.#closed) return;
    this.#closed = true;
    const err = new Error("ptyd: disconnected");
    for (const w of this.#waiting.values()) w.reject(err);
    this.#waiting.clear();
    // The daemon is gone (or this app let go): what is attached here can no longer be reached.
    for (const pty of this.#ptys.values()) pty.exited(undefined);
    this.#ptys.clear();
    for (const fn of [...this.#onClose]) {
      try {
        fn();
      } catch { /* a listener's own problem */ }
    }
  }
}

/**
 * The folder the daemon's socket is in: the user's private `/tmp/qutty-<uid>` (the hub's), or
 * `$QUTTY_PTYD_DIR` (the packaged self-test's, under its temporary home), made 0700 and checked
 * to be this user's and private.
 */
export async function ptydDir(): Promise<string> {
  const { privateDir, privateUserDir } = await import("./hub-socket.ts");
  const own = Deno.env.get("QUTTY_PTYD_DIR");
  return own ? await privateDir(own) : await privateUserDir();
}

/**
 * The daemon's channel for protocol `v`: `ptyd-<v>.sock` in the user's private folder `dir` on
 * macOS / Linux, a named pipe on Windows (desktop/ipc.ts `ipcChannelPath`).
 */
export function ptydSocketPath(dir: string, v: number = PTYD_PROTOCOL): string {
  return ipcChannelPath(ptydSocketName(v).replace(/\.sock$/, ""), { dir });
}

/** Connect to the daemon's channel at `path` (rejects when nothing answers there). */
export async function connectPtyd(path: string): Promise<PtydClient> {
  // A Windows pipe: Denext's local IPC (desktop/ipc.ts); a unix socket: libc.
  if (isPipePath(path)) return new PtydClient(await connectIpc(path));
  const { FdReactor, connectUnix } = await import("./hub-socket.ts");
  return new PtydClient(connectUnix(path, sharedReactor(FdReactor)));
}

let reactor: unknown;
function sharedReactor<T>(make: new () => T): T {
  return (reactor ??= new make()) as T;
}

/**
 * The other protocol versions' daemons that answer in `dir` (an older or newer Qutty's shells):
 * their versions, from the socket names. Only a socket someone listens on counts.
 */
export async function otherDaemons(dir: string): Promise<number[]> {
  const found: number[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const v = ptydSocketVersion(e.name);
      if (v === undefined || v === PTYD_PROTOCOL) continue;
      try {
        const c = await connectPtyd(`${dir}/${e.name}`);
        await c.close();
        found.push(v);
      } catch { /* a stale socket file */ }
    }
  } catch { /* no folder */ }
  return found.sort((a, b) => a - b);
}

/**
 * End the daemon of protocol `v` in `dir` and its shells (`shutdown` has the same shape in every
 * version). Resolves once it was asked.
 */
export async function shutdownDaemon(dir: string, v: number): Promise<void> {
  const c = await connectPtyd(ptydSocketPath(dir, v));
  try {
    await c.request("shutdown", {});
  } finally {
    await c.close();
  }
}
