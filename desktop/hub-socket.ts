// Unix-domain sockets for the agent hub, through libc FFI.
//
// Why not `Deno.listen({ transport: "unix" })` (or @rullama/mcp-server's
// `UnixSocketServerTransport`, which is built on it): Deno checks `--allow-write` for the socket
// path, and the packaged app has none (see denext.config.ts) — tried in the real app, it fails
// with NotCapable. A `write` grant cannot be scoped to a per-user folder at package time (any
// entry bakes a broad --allow-write on the current runtime), while FFI is already full trust.
// So, like desktop/pty.ts does its PTY I/O, the hub binds, accepts and does its socket I/O through
// libc, and hands each connection to @rullama/mcp-server as a `ServerTransport`.
//
// One poll loop serves every socket (`FdReactor`): `poll` runs on Deno's blocking thread pool,
// then the ready fds are accepted / read without blocking. Writes go through `send` on the
// thread pool as well (a client that reads slowly blocks a pool thread, never the event loop),
// with SIGPIPE suppressed (SO_NOSIGPIPE on macOS, MSG_NOSIGNAL on Linux).

import { LineReader, type ServerTransport } from "@rullama/mcp-server";
import { errno } from "./pty.ts";

const IS_DARWIN = Deno.build.os === "darwin";
const LIBC_PATH = IS_DARWIN ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const MODE_T = IS_DARWIN ? "u16" : "u32";

const AF_UNIX = 1;
const SOCK_STREAM = 1;
const SOL_SOCKET = IS_DARWIN ? 0xffff : 1;
const SO_NOSIGPIPE = 0x1022;
const MSG_NOSIGNAL = IS_DARWIN ? 0 : 0x4000;
const SHUT_RDWR = 2;
const POLLIN = 0x1;
const POLLERR = 0x8;
const POLLHUP = 0x10;
const POLLNVAL = 0x20;
const EINTR = 4;
const EAGAIN = IS_DARWIN ? 35 : 11;
const ESRCH = 3;
/** `sun_path` capacity, NUL included: 104 on macOS, 108 on Linux. */
export const SUN_PATH_MAX = IS_DARWIN ? 104 : 108;

const SYMBOLS = {
  socket: { parameters: ["i32", "i32", "i32"], result: "i32" },
  bind: { parameters: ["i32", "buffer", "u32"], result: "i32" },
  listen: { parameters: ["i32", "i32"], result: "i32" },
  accept: { parameters: ["i32", "pointer", "pointer"], result: "i32" },
  read: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  send: {
    parameters: ["i32", "buffer", "usize", "i32"],
    result: "isize",
    nonblocking: true,
  },
  shutdown: { parameters: ["i32", "i32"], result: "i32" },
  close: { parameters: ["i32"], result: "i32" },
  unlink: { parameters: ["buffer"], result: "i32" },
  rmdir: { parameters: ["buffer"], result: "i32" },
  mkdir: { parameters: ["buffer", MODE_T], result: "i32" },
  chmod: { parameters: ["buffer", MODE_T], result: "i32" },
  setsockopt: {
    parameters: ["i32", "i32", "i32", "buffer", "u32"],
    result: "i32",
  },
  poll: {
    parameters: ["buffer", "u32", "i32"],
    result: "i32",
    nonblocking: true,
  },
  getuid: { parameters: [], result: "u32" },
  pipe: { parameters: ["buffer"], result: "i32" },
  write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  kill: { parameters: ["i32", "i32"], result: "i32" },
} as const;

let libcCache: Deno.DynamicLibrary<typeof SYMBOLS>["symbols"] | undefined;
function libc() {
  return (libcCache ??= Deno.dlopen(LIBC_PATH, SYMBOLS).symbols);
}

const encoder = new TextEncoder();
const cstr = (s: string) => encoder.encode(`${s}\0`);

/** The real user id (`Deno.uid()` needs `--allow-sys`, which the app does not have). */
export function getuid(): number {
  return libc().getuid();
}

/** `mkdir(path, mode)`; true when it was created (false: it exists, or failed). */
export function makeDir(path: string, mode: number): boolean {
  return libc().mkdir(cstr(path), mode) === 0;
}

export function chmodPath(path: string, mode: number): boolean {
  return libc().chmod(cstr(path), mode) === 0;
}

export function unlinkPath(path: string): boolean {
  return libc().unlink(cstr(path)) === 0;
}

export function removeDir(path: string): boolean {
  return libc().rmdir(cstr(path)) === 0;
}

/** Whether process `pid` exists (`kill(pid, 0)`; EPERM still means it exists). */
export function processAlive(pid: number): boolean {
  if (libc().kill(pid, 0) === 0) return true;
  return errno() !== ESRCH;
}

/** A `struct sockaddr_un` for `path` (throws when it is too long for `sun_path`). */
function sockaddrUn(path: string): Uint8Array {
  const bytes = encoder.encode(path);
  if (bytes.length >= SUN_PATH_MAX) {
    throw new Error(`socket path too long (${bytes.length} bytes): ${path}`);
  }
  const size = 2 + SUN_PATH_MAX; // sun_len + sun_family (macOS) or sun_family (Linux)
  const buf = new Uint8Array(size);
  if (IS_DARWIN) {
    buf[0] = size; // sun_len
    buf[1] = AF_UNIX;
  } else {
    new DataView(buf.buffer).setUint16(0, AF_UNIX, true);
  }
  buf.set(bytes, 2);
  return buf;
}

// ---------------------------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------------------------

const POLL_MS = 100;

/**
 * One poll loop over many fds: calls a watcher when its fd is readable (or hung up). A self-pipe
 * wakes the poll in flight when a new fd is watched, so a fresh connection is read at once
 * rather than after the poll's timeout.
 */
export class FdReactor {
  #watch = new Map<number, (revents: number) => void>();
  #closeAfterPoll: number[] = [];
  #polling = false;
  #running = false;
  #wake: { read: number; write: number } | null | undefined;

  /** Call `onReady` whenever `fd` is readable or hung up, until {@link close}. */
  watch(fd: number, onReady: (revents: number) => void): void {
    this.#watch.set(fd, onReady);
    if (!this.#running) void this.#loop();
    else if (this.#polling) this.#poke();
  }

  /** The self-pipe (created on first use; `null` if it could not be). */
  #wakePipe(): { read: number; write: number } | null {
    if (this.#wake !== undefined) return this.#wake;
    const fds = new Int32Array(2);
    this.#wake = libc().pipe(new Uint8Array(fds.buffer)) === 0
      ? { read: fds[0], write: fds[1] }
      : null;
    return this.#wake;
  }

  #poke(): void {
    const w = this.#wakePipe();
    if (w) libc().write(w.write, new Uint8Array(1), 1n);
  }

  /** Stop watching `fd` (it stays open). */
  unwatch(fd: number): void {
    this.#watch.delete(fd);
  }

  /** Stop watching `fd` and close it (after the poll in flight, so the fd is never reused under it). */
  close(fd: number): void {
    this.#watch.delete(fd);
    if (this.#polling) this.#closeAfterPoll.push(fd);
    else libc().close(fd);
  }

  get size(): number {
    return this.#watch.size;
  }

  async #loop(): Promise<void> {
    this.#running = true;
    const c = libc();
    try {
      while (this.#watch.size > 0) {
        const wake = this.#wakePipe();
        const fds = [...this.#watch.keys(), ...(wake ? [wake.read] : [])];
        const buf = new Uint8Array(8 * fds.length);
        const view = new DataView(buf.buffer);
        fds.forEach((fd, i) => {
          view.setInt32(i * 8, fd, true);
          view.setInt16(i * 8 + 4, POLLIN, true);
        });
        this.#polling = true;
        let r: number;
        try {
          r = await c.poll(buf, fds.length, POLL_MS);
        } finally {
          this.#polling = false;
          for (const fd of this.#closeAfterPoll.splice(0)) c.close(fd);
        }
        if (r <= 0) continue;
        fds.forEach((fd, i) => {
          const revents = view.getInt16(i * 8 + 6, true);
          if (revents === 0) return;
          if (fd === wake?.read) {
            libc().read(fd, new Uint8Array(64), 64n); // drain the pokes
            return;
          }
          const cb = this.#watch.get(fd);
          if (!cb) return;
          try {
            cb(revents);
          } catch (e) {
            console.error("hub: socket handler failed", e);
          }
        });
      }
    } finally {
      this.#running = false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Listener and connections
// ---------------------------------------------------------------------------------------------

const READ_CHUNK = 64 * 1024;

/** One accepted connection: a newline-delimited JSON-RPC `ServerTransport`. */
export class FdConnection implements ServerTransport {
  readonly fd: number;
  #reactor: FdReactor;
  #lines: LineReader;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  #writing: Promise<void> = Promise.resolve();
  #closed = false;
  /** Lines pushed back by a peek (read again before the socket). */
  #pushback: string[] = [];

  constructor(fd: number, reactor: FdReactor) {
    this.fd = fd;
    this.#reactor = reactor;
    if (IS_DARWIN) {
      const one = new Uint8Array(4);
      new DataView(one.buffer).setInt32(0, 1, true);
      libc().setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, one, 4);
    }
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => void this.close(),
    });
    this.#lines = new LineReader(stream);
    reactor.watch(fd, (revents) => this.#onReady(revents));
  }

  get closed(): boolean {
    return this.#closed;
  }

  #onReady(revents: number): void {
    if (this.#closed) return;
    const buf = new Uint8Array(READ_CHUNK);
    if (revents & POLLIN) {
      const n = Number(libc().read(this.fd, buf, BigInt(buf.length)));
      if (n > 0) {
        this.#controller.enqueue(buf.slice(0, n));
        return;
      }
      if (n < 0) {
        const e = errno();
        if (e === EINTR || e === EAGAIN) return;
      }
    } else if (!(revents & (POLLHUP | POLLERR | POLLNVAL))) {
      return;
    }
    // EOF or error: no more input. The fd stays open until close() (pending writes still go
    // out, and a closed fd number could be reused by another file under a late write).
    this.#reactor.unwatch(this.fd);
    this.#closed = true;
    try {
      this.#controller.close();
    } catch { /* already closed */ }
  }

  /** Put a line back so the next {@linkcode readRequest} returns it. */
  unread(line: string): void {
    this.#pushback.unshift(line);
  }

  readRequest(): Promise<string | null> {
    const back = this.#pushback.shift();
    if (back !== undefined) return Promise.resolve(back);
    return this.#lines.read();
  }

  writeResponse(response: string): Promise<void> {
    const data = encoder.encode(`${response}\n`);
    const next = this.#writing.then(() => this.#sendAll(data));
    this.#writing = next.catch(() => {});
    return next;
  }

  async #sendAll(data: Uint8Array): Promise<void> {
    for (let off = 0; off < data.length;) {
      if (this.#shutdown) throw new Error("connection closed");
      const n = Number(
        await libc().send(
          this.fd,
          data.subarray(off),
          BigInt(data.length - off),
          MSG_NOSIGNAL,
        ),
      );
      if (n <= 0) throw new Error("connection lost");
      off += n;
    }
  }

  #shutdown = false;

  /** Close the connection (idempotent): pending reads end, the fd is closed after the writes. */
  async close(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    await this.#writing;
    libc().shutdown(this.fd, SHUT_RDWR);
    this.#reactor.close(this.fd);
    if (!this.#closed) {
      this.#closed = true;
      try {
        this.#controller.close();
      } catch { /* already closed */ }
    }
  }
}

/**
 * A listening unix socket at `path` (mode 0600). A stale socket file is replaced; the file is
 * removed on {@linkcode close}. Accepted connections go to `onConnection`.
 */
export class FdUnixListener {
  readonly path: string;
  readonly fd: number;
  #reactor: FdReactor;
  #closed = false;

  private constructor(path: string, fd: number, reactor: FdReactor) {
    this.path = path;
    this.fd = fd;
    this.#reactor = reactor;
  }

  static listen(
    path: string,
    reactor: FdReactor,
    onConnection: (conn: FdConnection) => void,
  ): FdUnixListener {
    const c = libc();
    const addr = sockaddrUn(path);
    const fd = c.socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) throw new Error(`socket() failed (errno ${errno()})`);
    // A leftover from a crashed run (each run has its own folder, so it is never a live one).
    c.unlink(cstr(path));
    if (c.bind(fd, addr, addr.length) !== 0) {
      const e = errno();
      c.close(fd);
      throw new Error(`cannot bind ${path} (errno ${e})`);
    }
    c.chmod(cstr(path), 0o600);
    if (c.listen(fd, 16) !== 0) {
      const e = errno();
      c.close(fd);
      c.unlink(cstr(path));
      throw new Error(`cannot listen on ${path} (errno ${e})`);
    }
    const listener = new FdUnixListener(path, fd, reactor);
    reactor.watch(fd, () => {
      if (listener.#closed) return;
      const conn = c.accept(fd, null, null);
      if (conn < 0) return; // EAGAIN / ECONNABORTED: the client gave up
      try {
        onConnection(new FdConnection(conn, reactor));
      } catch (e) {
        c.close(conn);
        console.error("hub: connection setup failed", e);
      }
    });
    return listener;
  }

  /** Stop listening and remove the socket file. Connections already accepted stay open. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reactor.close(this.fd);
    libc().unlink(cstr(this.path));
  }
}
