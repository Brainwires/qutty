// qutty-ptyd: the per-user PTY daemon that keeps shells running after the app quits.
//
// It holds the terminals the app started through it (`Deno.openPty`, so it needs the runtime's
// PTYs and `--allow-run`, like the app) and a replay ring of each one's output, and serves the app
// over a unix socket (lib/ptyd/protocol.ts): the app spawns, writes, resizes and kills terminals
// here, gets their output while attached, and at its next launch lists them and attaches again
// with their replay. The app also keeps its workspaces here (an opaque `state`), so the next
// launch rebuilds every tile on its running shell.
//
// How it runs: the app's `ptyd` sidecar (desktop/ptyd-sidecar.ts, `desktop.sidecars`) starts it
// as a child of the app's own executable (`denextSidecar.spawnSelf`, a headless launch: no window,
// no web engine), detached from the app's session, at each launch unless one of this protocol
// version already answers. It is not a sidecar itself: Denext ends its sidecars with the app.
//
// Security: the socket is `/tmp/qutty-<uid>/ptyd-<v>.sock`, in the hub's private folder (0700,
// checked to be this user's), mode 0600, and every connection's peer must be this uid
// (`getpeereid` / `SO_PEERCRED`). No network: unix sockets only.
//
// Lifetime: it exits when it holds no running terminal and no client is connected: when the last
// client disconnects with no terminal left, when the last terminal exits with no client
// connected, or (once, at start) when no client came within a minute. No polling timer.

import { type DenoPty, type OpenPty, runtimeOpenPty } from "./pty.ts";
import {
  encodeLine,
  LineDecoder,
  parseRequest,
  PTYD_PROTOCOL,
  PTYD_REPLAY_BYTES,
  type PtydEvent,
  type PtydExit,
  type PtydRequest,
  type PtydSession,
  ptydSocketName,
  ReplayRing,
} from "../lib/ptyd/protocol.ts";
import { MAX_STATE_CHARS } from "../lib/ptyd/protocol.ts";

/** A byte stream to one client: an accepted socket, or an in-memory pair in tests. */
export interface PtydConnection {
  readonly readable: ReadableStream<Uint8Array>;
  /** Write some of `bytes`; resolves with how many were written. */
  write(bytes: Uint8Array): Promise<number>;
  close(): Promise<void>;
}

/** After the program exits, how long to wait for the master's last output. */
const EXIT_GRACE_MS = 250;
/** After SIGHUP at `shutdown`, how long before SIGKILL. */
const KILL_GRACE_MS = 2000;

interface Session {
  sid: string;
  pty: DenoPty;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  writeChain: Promise<void>;
  decoder: TextDecoder;
  ring: ReplayRing;
  cols: number;
  rows: number;
  exit?: PtydExit;
  clients: Set<Client>;
  /** Let go on purpose (`detach`): it runs on with no client. */
  kept: boolean;
}

/** One connected client: its socket, its writes in order, the terminals it is attached to. */
class Client {
  readonly conn: PtydConnection;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;
  readonly #encoder = new TextEncoder();

  constructor(conn: PtydConnection) {
    this.conn = conn;
  }

  /** Send one message (in order; a dead socket drops it). */
  send(message: unknown): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const bytes = this.#encoder.encode(encodeLine(message));
    this.#chain = this.#chain.then(async () => {
      let off = 0;
      while (off < bytes.length && !this.#closed) {
        off += await this.conn.write(bytes.subarray(off));
      }
    }).catch(() => {
      this.#closed = true;
    });
    return this.#chain;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.conn.close().catch(() => {});
  }
}

/** Options for {@linkcode PtyDaemon}. */
export interface PtyDaemonOptions {
  /** `Deno.openPty` (a fake in tests). */
  openPty: OpenPty;
  /** Called once when the daemon has nothing left to do (the server then exits). */
  onIdle?: () => void;
  /** Bytes of output kept per terminal (default 1 MiB). */
  replayBytes?: number;
  /** The pid `hello` reports (default this process's). */
  pid?: number;
}

/** The daemon's state: its terminals, its clients and the app's opaque state. */
export class PtyDaemon {
  readonly #sessions = new Map<string, Session>();
  readonly #clients = new Set<Client>();
  readonly #openPty: OpenPty;
  readonly #replayBytes: number;
  readonly #pid: number;
  #onIdle: (() => void) | undefined;
  #state: unknown = null;
  #idle = false;
  #shuttingDown = false;
  readonly #utf8 = new TextEncoder();

  constructor(opts: PtyDaemonOptions) {
    this.#openPty = opts.openPty;
    this.#onIdle = opts.onIdle;
    this.#replayBytes = opts.replayBytes ?? PTYD_REPLAY_BYTES;
    this.#pid = opts.pid ?? Deno.pid;
  }

  /** How many clients are connected. */
  get clients(): number {
    return this.#clients.size;
  }

  /** How many terminals still run. */
  get running(): number {
    return [...this.#sessions.values()].filter((s) => !s.exit).length;
  }

  /** Serve one client until its stream ends. */
  async serve(conn: PtydConnection): Promise<void> {
    const client = new Client(conn);
    this.#clients.add(client);
    const lines = new LineDecoder();
    const reader = conn.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of lines.push(value)) await this.#handle(client, line);
      }
    } catch {
      /* a broken client: drop it */
    } finally {
      reader.releaseLock();
      this.#clients.delete(client);
      // A terminal the client did not let go (`detach`) ends with it: the app quit without
      // keeping it, or crashed. Only kept shells outlive their app.
      for (const s of this.#sessions.values()) {
        if (!s.clients.delete(client)) continue;
        if (s.clients.size === 0 && !s.kept && !s.exit) signal(s, "SIGHUP");
      }
      client.close();
      this.#checkIdle();
    }
  }

  /** The once-at-start check: no client came, nothing runs. */
  idleCheck(): void {
    this.#checkIdle();
  }

  async #handle(client: Client, line: string): Promise<void> {
    const parsed = parseRequest(line);
    if ("error" in parsed) {
      if (parsed.id !== null) {
        await client.send({ re: parsed.id, ok: false, error: parsed.error });
      }
      return;
    }
    const { id, req } = parsed;
    const answered = this.#run(client, req).then(
      (result) => client.send({ re: id, ok: true, ...result }),
      (err) =>
        client.send({
          re: id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
    // A write waits for the terminal to take the input (a program not reading blocks it); the
    // client's other requests go on meanwhile. The terminal keeps its writes in order itself.
    if (req.op !== "write") await answered;
  }

  async #run(client: Client, req: PtydRequest): Promise<object> {
    switch (req.op) {
      case "hello":
        return { v: PTYD_PROTOCOL, pid: this.#pid };
      case "shutdown":
        this.#shutdown();
        return {};
      case "list":
        return { sessions: this.#list() };
      case "spawn":
        return this.#spawn(client, req);
      case "attach":
        return this.#attach(client, req.sid);
      case "detach": {
        const s = this.#get(req.sid);
        s.clients.delete(client);
        s.kept = true;
        return {};
      }
      case "peek":
        return this.#get(req.sid).ring.tail(req.maxBytes);
      case "write":
        await this.#write(req.sid, req.data, req.binary === true);
        return {};
      case "resize": {
        const s = this.#get(req.sid);
        if (!s.exit) {
          try {
            s.pty.resize(req.cols, req.rows);
          } catch { /* ended meanwhile */ }
        }
        s.cols = req.cols;
        s.rows = req.rows;
        return {};
      }
      case "kill": {
        const s = this.#get(req.sid);
        if (!s.exit) signal(s, req.signal);
        return {};
      }
      case "release": {
        const s = this.#sessions.get(req.sid);
        if (s?.exit) this.#sessions.delete(req.sid);
        else if (s) {
          s.clients.delete(client);
          signal(s, "SIGHUP");
        }
        this.#checkIdle();
        return {};
      }
      case "getState":
        return { state: this.#state };
      case "setState": {
        const size = JSON.stringify(req.state ?? null).length;
        if (size > MAX_STATE_CHARS) throw new Error("state too large");
        this.#state = req.state ?? null;
        return {};
      }
    }
  }

  #get(sid: string): Session {
    const s = this.#sessions.get(sid);
    if (!s) throw new Error("no such terminal");
    return s;
  }

  #list(): PtydSession[] {
    return [...this.#sessions.values()].map((s) => ({
      sid: s.sid,
      pid: s.pty.pid,
      cols: s.cols,
      rows: s.rows,
      ...(s.exit ? { exit: s.exit } : {}),
      attached: s.clients.size > 0,
    }));
  }

  #spawn(
    client: Client,
    req: Extract<PtydRequest, { op: "spawn" }>,
  ): { pid: number } {
    if (this.#shuttingDown) throw new Error("shutting down");
    if (this.#sessions.has(req.sid)) throw new Error("sid in use");
    const pty = this.#openPty({
      cmd: req.cmd,
      args: req.args,
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      env: req.env,
      clearEnv: true,
      cols: req.cols,
      rows: req.rows,
    });
    const s: Session = {
      sid: req.sid,
      pty,
      writer: pty.writable.getWriter(),
      writeChain: Promise.resolve(),
      decoder: new TextDecoder(),
      ring: new ReplayRing(this.#replayBytes),
      cols: req.cols,
      rows: req.rows,
      clients: new Set([client]),
      kept: false,
    };
    this.#sessions.set(req.sid, s);
    const pumped = this.#pump(s);
    pty.status.then(
      async (status) => {
        await pumped;
        this.#finish(s, { code: status.code, signal: status.signal });
      },
      async () => {
        await pumped;
        this.#finish(s, { code: -1, signal: null });
      },
    );
    return { pid: pty.pid };
  }

  #attach(
    client: Client,
    sid: string,
  ): { replay: string; truncated: boolean; exit?: PtydExit } {
    const s = this.#get(sid);
    // One app at a time: a second attach takes the terminal over.
    for (const other of s.clients) {
      if (other !== client) s.clients.delete(other);
    }
    s.clients.add(client);
    s.kept = false;
    const { text, truncated } = s.ring.text();
    return { replay: text, truncated, ...(s.exit ? { exit: s.exit } : {}) };
  }

  async #write(sid: string, data: string, binary: boolean): Promise<void> {
    const s = this.#get(sid);
    if (s.exit) throw new Error("the terminal has ended");
    const bytes = binary
      ? Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff)
      : this.#utf8.encode(data);
    if (bytes.length === 0) return;
    const done = s.writeChain.then(() => s.writer.write(bytes));
    s.writeChain = done.catch(() => {});
    await done;
  }

  /** Read the master until it ends (a little after the program's exit at the latest). */
  async #pump(s: Session): Promise<void> {
    const reader = s.pty.readable.getReader();
    let finished = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<"exited">((resolve) => {
      const later = () => {
        if (!finished) {
          grace = setTimeout(() => resolve("exited"), EXIT_GRACE_MS);
        }
      };
      s.pty.status.then(later, later);
    });
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), exited]);
        if (next === "exited") {
          reader.cancel().catch(() => {});
          break;
        }
        if (next.done) break;
        this.#output(s, s.decoder.decode(next.value, { stream: true }));
      }
    } catch {
      /* the PTY closed */
    } finally {
      finished = true;
      clearTimeout(grace);
    }
  }

  #output(s: Session, text: string): void {
    if (text === "") return;
    s.ring.push(text);
    this.#emit(s, { ev: "data", sid: s.sid, data: text });
  }

  #finish(s: Session, exit: PtydExit): void {
    if (s.exit) return;
    this.#output(s, s.decoder.decode());
    s.exit = exit;
    s.writer.close().catch(() => {});
    this.#emit(s, { ev: "exit", sid: s.sid, ...exit });
    this.#checkIdle();
  }

  #emit(s: Session, event: PtydEvent): void {
    for (const c of s.clients) void c.send(event);
  }

  #shutdown(): void {
    this.#shuttingDown = true;
    const live = [...this.#sessions.values()].filter((s) => !s.exit);
    for (const s of live) signal(s, "SIGHUP");
    if (live.length === 0) {
      this.#idleNow();
      return;
    }
    const timer = setTimeout(() => {
      for (const s of live) if (!s.exit) signal(s, "SIGKILL");
    }, KILL_GRACE_MS);
    Deno.unrefTimer(timer as unknown as number);
    // `#finish` of the last one calls `#checkIdle`, which ends the daemon (no client needed).
  }

  #checkIdle(): void {
    if (this.#idle) return;
    const running = this.running;
    if (running === 0 && (this.#clients.size === 0 || this.#shuttingDown)) {
      this.#idleNow();
    }
  }

  #idleNow(): void {
    if (this.#idle) return;
    this.#idle = true;
    const fn = this.#onIdle;
    this.#onIdle = undefined;
    fn?.();
  }
}

/** Send `name` to a terminal's program (it may have ended meanwhile). */
function signal(s: Session, name: string): void {
  try {
    s.pty.kill(name);
  } catch { /* gone */ }
}

// ---------------------------------------------------------------------------------------------
// The server process
// ---------------------------------------------------------------------------------------------

/** How long a fresh daemon waits for its first client before it gives up. */
const FIRST_CLIENT_MS = 60_000;

/**
 * Run the daemon in this process until it is idle: listen on `ptyd-<v>.sock` in `dir` (the user's
 * private folder), admit only this uid's connections. Resolves when the daemon has exited its
 * loop (the caller then ends the process); resolves at once when a daemon of this version already
 * answers there.
 */
export async function runPtyDaemon(opts: {
  /** The user's private socket folder (`/tmp/qutty-<uid>`). */
  dir: string;
  openPty?: OpenPty;
  log?: (message: string) => void;
  /** Called once the socket listens. */
  onListening?: () => void;
}): Promise<void> {
  const log = opts.log ?? ((m: string) => console.error(`ptyd: ${m}`));
  const {
    FdReactor,
    FdUnixListener,
    getuid,
    peerUid,
    connectUnix,
  } = await import("./hub-socket.ts");
  const open = opts.openPty ?? runtimeOpenPty();
  if (!open) throw new Error("this runtime has no Deno.openPty");
  const path = `${opts.dir}/${ptydSocketName()}`;
  const reactor = new FdReactor();
  // Another daemon of this version answers: leave it be (the listener would replace its socket).
  try {
    const probe = connectUnix(path, reactor);
    await probe.close();
    log(`a daemon already serves ${path}`);
    return;
  } catch { /* none: serve */ }
  const uid = getuid();
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const daemon = new PtyDaemon({ openPty: open, onIdle: () => done() });
  const listener = FdUnixListener.listen(path, reactor, (conn) => {
    const peer = peerUid(conn.fd);
    if (peer !== uid) {
      log(`refused a connection from uid ${peer ?? "?"}`);
      void conn.close();
      return;
    }
    clearTimeout(firstClient);
    void daemon.serve(conn);
  });
  const firstClient = setTimeout(() => daemon.idleCheck(), FIRST_CLIENT_MS);
  log(`serving ${path} (pid ${Deno.pid}, protocol ${PTYD_PROTOCOL})`);
  opts.onListening?.();
  await finished;
  clearTimeout(firstClient);
  listener.close();
  log("idle: exiting");
}
