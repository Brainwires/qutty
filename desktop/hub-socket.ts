// Unix-domain sockets for the agent hub, through libc FFI.
//
// Why not `Deno.listen({ transport: "unix" })` (or @rullama/mcp-server's
// `UnixSocketServerTransport`, which is built on it): Deno checks `--allow-write` for the socket
// path, and the packaged app has none (see denext.config.ts) — tried in the real app, it fails
// with NotCapable. A `write` grant cannot be scoped to a per-user folder at package time (any
// entry bakes a broad --allow-write on the current runtime), while FFI is already full trust.
// So, like desktop/pty.ts does its PTY I/O, the hub binds, accepts and does its socket I/O through
// libc, and hands each connection to @rullama/mcp-server as a byte endpoint
// (`StreamServerTransport.from(conn)`), which does the line framing and write ordering.
//
// The same goes for the TCP loopback listener the shared Docker sandbox reaches the hub through
// (`FdTcpListener`): `Deno.listen` would need a `net` permission the packaged app does not have,
// and libc needs none beyond FFI.
//
// One poll loop serves every socket (`FdReactor`): `poll` runs on Deno's blocking thread pool,
// then the ready fds are accepted / read without blocking. Writes go through `send` on the
// thread pool as well (a client that reads slowly blocks a pool thread, never the event loop),
// with SIGPIPE suppressed (SO_NOSIGPIPE on macOS, MSG_NOSIGNAL on Linux).

import type { ByteStreamEndpoint, StreamConnection } from "@rullama/mcp-server";
import { errno } from "./pty.ts";

const IS_DARWIN = Deno.build.os === "darwin";
const LIBC_PATH = IS_DARWIN ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
const MODE_T = IS_DARWIN ? "u16" : "u32";

const AF_UNIX = 1;
const AF_INET = 2;
const SO_REUSEADDR = IS_DARWIN ? 0x4 : 0x2;
const SOCK_STREAM = 1;
const SOL_SOCKET = IS_DARWIN ? 0xffff : 1;
const SO_NOSIGPIPE = 0x1022;
const MSG_NOSIGNAL = IS_DARWIN ? 0 : 0x4000;
const MSG_DONTWAIT = IS_DARWIN ? 0x80 : 0x40;
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
  recv: { parameters: ["i32", "buffer", "usize", "i32"], result: "isize" },
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
  /** `poll` on the calling thread, for a zero-timeout check. */
  pollNow: {
    name: "poll",
    parameters: ["buffer", "u32", "i32"],
    result: "i32",
  },
  getsockname: { parameters: ["i32", "buffer", "buffer"], result: "i32" },
  getuid: { parameters: [], result: "u32" },
  getgid: { parameters: [], result: "u32" },
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

/** Whether `fd` is readable right now (a zero-timeout `poll`, on this thread). */
function readableNow(fd: number): boolean {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setInt32(0, fd, true);
  view.setInt16(4, POLLIN, true);
  return libc().pollNow(buf, 1, 0) > 0 &&
    (view.getInt16(6, true) & POLLIN) !== 0;
}

/** The real user id (`Deno.uid()` needs `--allow-sys`, which the app does not have). */
export function getuid(): number {
  return libc().getuid();
}

/** The real group id (`Deno.gid()` needs `--allow-sys` too). */
export function getgid(): number {
  return libc().getgid();
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
  /** A `poll` is in flight (a new fd needs a poke to be polled at once). */
  #polling = false;
  /** A round is in progress (polling, or handing out its revents): its fds must stay open. */
  #inRound = false;
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

  /** Stop watching `fd` and close it (after the round in flight, so the fd is never reused under it). */
  close(fd: number): void {
    this.#watch.delete(fd);
    if (this.#inRound) this.#closeAfterPoll.push(fd);
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
        // The watchers this round polls for: its revents go to these and no others.
        const round = [...this.#watch];
        const fds = [...round.map(([fd]) => fd), ...(wake ? [wake.read] : [])];
        const buf = new Uint8Array(8 * fds.length);
        const view = new DataView(buf.buffer);
        fds.forEach((fd, i) => {
          view.setInt32(i * 8, fd, true);
          view.setInt16(i * 8 + 4, POLLIN, true);
        });
        // Closes wait until the round's revents are handed out, not just until the poll returns:
        // an fd closed before then could come back from an `accept` in the same round under its
        // old number, and get the old file's revents (a POLLIN on a socket with nothing to read).
        this.#inRound = true;
        try {
          this.#polling = true;
          let r: number;
          try {
            r = await c.poll(buf, fds.length, POLL_MS);
          } finally {
            this.#polling = false;
          }
          if (r > 0) this.#dispatch(round, view, wake?.read);
        } finally {
          this.#inRound = false;
          for (const fd of this.#closeAfterPoll.splice(0)) c.close(fd);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** Hand one poll round's revents to the watchers it polled for (still watching, same callback). */
  #dispatch(
    round: [number, (revents: number) => void][],
    view: DataView,
    wakeFd: number | undefined,
  ): void {
    const n = round.length + (wakeFd === undefined ? 0 : 1);
    for (let i = 0; i < n; i++) {
      const revents = view.getInt16(i * 8 + 6, true);
      if (revents === 0) continue;
      if (i === round.length) {
        libc().read(wakeFd!, new Uint8Array(64), 64n); // drain the pokes
        continue;
      }
      const [fd, cb] = round[i];
      // Unwatched, or watched anew (a new connection on a reused fd number) since the poll began.
      if (this.#watch.get(fd) !== cb) continue;
      try {
        cb(revents);
      } catch (e) {
        console.error("hub: socket handler failed", e);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Listeners and connections
// ---------------------------------------------------------------------------------------------

const READ_CHUNK = 64 * 1024;

/**
 * One accepted connection as a byte endpoint (`readable`, `write`, `close`): hand it to
 * `StreamServerTransport.from` for newline-delimited JSON-RPC.
 */
export class FdConnection implements ByteStreamEndpoint {
  readonly fd: number;
  readonly readable: ReadableStream<Uint8Array>;
  #reactor: FdReactor;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  /** The send in flight (the fd is closed only after it). */
  #inflight: Promise<unknown> = Promise.resolve();
  /** No more input (EOF, error or closed). */
  #ended = false;
  #shutdown = false;

  constructor(fd: number, reactor: FdReactor) {
    this.fd = fd;
    this.#reactor = reactor;
    if (IS_DARWIN) {
      const one = new Uint8Array(4);
      new DataView(one.buffer).setInt32(0, 1, true);
      libc().setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, one, 4);
    }
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => this.close(),
    });
    reactor.watch(fd, (revents) => this.#onReady(revents));
  }

  #onReady(revents: number): void {
    if (this.#ended) return;
    const buf = new Uint8Array(READ_CHUNK);
    if (revents & POLLIN) {
      // Never blocks the event loop, whatever the revents said.
      const n = Number(
        libc().recv(this.fd, buf, BigInt(buf.length), MSG_DONTWAIT),
      );
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
    this.#endInput();
  }

  #endInput(): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#controller.close();
    } catch { /* already closed or cancelled */ }
  }

  /** One `send` on the thread pool: the bytes written (the transport writes the rest). */
  write(bytes: Uint8Array): Promise<number> {
    if (this.#shutdown) return Promise.reject(new Error("connection closed"));
    const sent = libc().send(
      this.fd,
      bytes,
      BigInt(bytes.length),
      MSG_NOSIGNAL,
    ).then((r) => {
      const n = Number(r);
      if (n <= 0) throw new Error("connection lost");
      return n;
    });
    this.#inflight = sent.catch(() => {});
    return sent;
  }

  /** Close the connection (idempotent): input ends, the fd is closed after the send in flight. */
  async close(): Promise<void> {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.#endInput();
    await this.#inflight;
    libc().shutdown(this.fd, SHUT_RDWR);
    this.#reactor.close(this.fd);
  }
}

/** Accept on listening socket `fd` whenever it is readable, until `closed()`. */
function acceptOn(
  fd: number,
  reactor: FdReactor,
  closed: () => boolean,
  onConnection: (conn: FdConnection) => void,
): void {
  const c = libc();
  reactor.watch(fd, () => {
    // `accept` blocks on a socket with nothing pending: check first, it runs on the event loop.
    if (closed() || !readableNow(fd)) return;
    const conn = c.accept(fd, null, null);
    if (conn < 0) return; // EAGAIN / ECONNABORTED: the client gave up
    try {
      onConnection(new FdConnection(conn, reactor));
    } catch (e) {
      c.close(conn);
      console.error("hub: connection setup failed", e);
    }
  });
}

/** `bind` + `listen` on a fresh socket, or throw (the socket closed) with what failed. */
function bindAndListen(
  family: number,
  addr: Uint8Array,
  what: string,
  beforeListen?: (fd: number) => void,
): number {
  const c = libc();
  const fd = c.socket(family, SOCK_STREAM, 0);
  if (fd < 0) throw new Error(`socket() failed (errno ${errno()})`);
  if (family === AF_INET) {
    const one = new Uint8Array(4);
    new DataView(one.buffer).setInt32(0, 1, true);
    c.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, one, 4);
  }
  if (c.bind(fd, addr, addr.length) !== 0) {
    const e = errno();
    c.close(fd);
    throw new Error(`cannot bind ${what} (errno ${e})`);
  }
  beforeListen?.(fd);
  if (c.listen(fd, 16) !== 0) {
    const e = errno();
    c.close(fd);
    throw new Error(`cannot listen on ${what} (errno ${e})`);
  }
  return fd;
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
    // A leftover from a crashed run (each run has its own folder, so it is never a live one).
    c.unlink(cstr(path));
    let fd: number;
    try {
      fd = bindAndListen(
        AF_UNIX,
        addr,
        path,
        () => void c.chmod(cstr(path), 0o600),
      );
    } catch (e) {
      c.unlink(cstr(path));
      throw e;
    }
    const listener = new FdUnixListener(path, fd, reactor);
    acceptOn(fd, reactor, () => listener.#closed, onConnection);
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

/** A `struct sockaddr_in` for an IPv4 address and port (network byte order). */
function sockaddrIn(host: string, port: number): Uint8Array {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    throw new Error(`not an IPv4 address: ${host}`);
  }
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  if (IS_DARWIN) {
    buf[0] = 16; // sin_len
    buf[1] = AF_INET;
  } else {
    view.setUint16(0, AF_INET, true);
  }
  view.setUint16(2, port, false);
  buf.set(parts, 4);
  return buf;
}

/**
 * A listening TCP socket on an IPv4 address (`127.0.0.1`; on Linux also Docker's bridge
 * gateway). Port 0 picks a free one ({@linkcode port} says which). Anyone who can reach the
 * address can connect: the hub admits a connection only with a tile's token as its first line.
 */
export class FdTcpListener {
  readonly host: string;
  readonly port: number;
  readonly fd: number;
  #reactor: FdReactor;
  #closed = false;

  private constructor(
    host: string,
    port: number,
    fd: number,
    reactor: FdReactor,
  ) {
    this.host = host;
    this.port = port;
    this.fd = fd;
    this.#reactor = reactor;
  }

  static listen(
    host: string,
    port: number,
    reactor: FdReactor,
    onConnection: (conn: FdConnection) => void,
  ): FdTcpListener {
    const fd = bindAndListen(
      AF_INET,
      sockaddrIn(host, port),
      `${host}:${port}`,
    );
    const addr = new Uint8Array(16);
    const len = new Uint32Array([addr.length]);
    if (libc().getsockname(fd, addr, new Uint8Array(len.buffer)) !== 0) {
      const e = errno();
      libc().close(fd);
      throw new Error(`getsockname failed (errno ${e})`);
    }
    const bound = new DataView(addr.buffer).getUint16(2, false);
    const listener = new FdTcpListener(host, bound, fd, reactor);
    acceptOn(fd, reactor, () => listener.#closed, onConnection);
    return listener;
  }

  /** Stop listening. Connections already accepted stay open. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reactor.close(this.fd);
  }
}

/**
 * Accepted connections as the `AsyncIterable<StreamConnection>` a `StreamServerListener` reads
 * (each tagged with an id, so the connection can be found again by the `info.id` it yields).
 */
export class ConnectionQueue implements AsyncIterable<StreamConnection> {
  #waiting: ((r: IteratorResult<StreamConnection>) => void)[] = [];
  #buffered: StreamConnection[] = [];
  #byId = new Map<string, FdConnection>();
  #ended = false;

  /** Queue an accepted connection (bound: pass it to a listener as its callback). */
  push = (conn: FdConnection): void => {
    if (this.#ended) return void conn.close();
    const id = `tcp-${conn.fd}-${++connectionSeq}`;
    this.#byId.set(id, conn);
    const item: StreamConnection = {
      readable: conn.readable,
      write: (bytes) => conn.write(bytes),
      close: () => {
        this.#byId.delete(id);
        return conn.close();
      },
      info: { id },
    };
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#buffered.push(item);
  };

  /** The connection behind a yielded `info.id` (forgotten once taken). */
  take(id: string): FdConnection | undefined {
    const conn = this.#byId.get(id);
    this.#byId.delete(id);
    return conn;
  }

  /** No more connections: iteration ends, queued ones are closed. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const item of this.#buffered.splice(0)) void item.close?.();
    for (const w of this.#waiting.splice(0)) {
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamConnection> {
    return {
      next: () => {
        const item = this.#buffered.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.#ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

let connectionSeq = 0;
