// The PTY backend: a denext desktop extension (`desktop.capabilities.extensions`) that runs in the
// app's Deno process. The page reaches it through `lib/pty-client.ts` (`desktopExtension("pty")`
// + `onDesktopEvent("pty", "data" | "exit")`).
//
// How it uses node-pty, and why not its JS `IPty` object
// -------------------------------------------------------
// node-pty's native addon (`pty.node`, prebuilt for darwin-arm64/x64) works under Deno: its `fork`
// opens the PTY, starts the shell through `spawn-helper`, and reports the exit from a waitpid
// thread. Its JS wrapper does NOT: on Deno 2.9.8 (stock and denext's 3.0.0-denext.7 toolchain)
// `new tty.ReadStream(fd)` never delivers the master's output and `fs.write(fd, …)` on the raw
// master fd fails with EBADF, so a spawned shell can neither be read nor typed into. So this module
// calls the addon directly (`native.fork` / `native.resize` / `native.process`, which node-pty
// exports on Unix) and does the master-fd I/O itself through libc FFI: `poll` (on Deno's blocking
// thread pool, so the event loop never blocks) + non-blocking `read` / `write`.
//
// FFI is already required (a Node-API addon needs `--allow-ffi`), so signals (`kill`) and the
// spawn-helper copy (below) also go through libc instead of asking for `--allow-run` /
// `--allow-write`.
//
// spawn-helper: node-pty execs it from its own package folder. In `deno run` that is the npm cache
// (made executable here, as t3code's NodePtyAdapter does); in a packaged app it lives in the
// compiled binary's embedded file system, which the OS cannot exec — then it is copied once into
// the app-support folder and run from there.
//
// Output coalescing: each terminal's output is buffered and emitted every ~8 ms, or at once when
// 64 KiB are pending, so the page sees a sane number of events. Each `data` event carries a
// per-terminal `seq` because the desktop event stream is at-least-once (a reconnect replays its
// buffer); the client drops repeats.
//
// Lifetime: a page reload/navigation of the window that spawned a terminal kills it
// (`onPageLoad`), and process unload kills every terminal. A hard exit also closes every master
// fd, which makes the kernel hang up the shells.

import { defineDesktopExtension, DesktopCapError } from "denext/desktop";

// ---------------------------------------------------------------------------------------------
// Public shapes (the page sees these through the typed client)
// ---------------------------------------------------------------------------------------------

/** `spawn` arguments. */
export interface PtySpawnArgs {
  cols: number;
  rows: number;
  /** Working directory (default `$HOME`; an unusable one falls back to `$HOME`). */
  cwd?: string;
  /** The shell program (default `$SHELL`, else `/bin/zsh`). It is started as a login shell (`-l`). */
  shell?: string;
}

/** `spawn` result. */
export interface PtySpawnResult {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
}

/** `info` result: best-effort. */
export interface PtyInfo {
  id: string;
  pid: number;
  /** The foreground process name (node-pty's `process`), e.g. `zsh`, `vim`. */
  process: string;
  /** The foreground process's working directory (falls back to the shell's), if it can be read. */
  cwd?: string;
}

/** The `data` event: coalesced output. `seq` increases by 1 per event per terminal. */
export interface PtyDataEvent {
  id: string;
  seq: number;
  data: string;
}

/** The `exit` event. `signal` is the terminating signal number, or `null`. */
export interface PtyExitEvent {
  id: string;
  exitCode: number;
  signal: number | null;
}

// ---------------------------------------------------------------------------------------------
// Tiny Standard Schema validators (no schema library dependency)
// ---------------------------------------------------------------------------------------------

type Issue = { message: string; path?: PropertyKey[] };

/** A Standard Schema v1 (structurally what `DesktopCapabilityMethod.input` takes), typed for the page. */
interface Schema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => { readonly value: T; readonly issues?: undefined } | {
      readonly issues: readonly Issue[];
    };
    readonly types?: { readonly input: T; readonly output: T };
  };
}

function objectSchema<T>(
  parse: (v: Record<string, unknown>, issues: Issue[]) => T,
): Schema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "qutty",
      validate(value: unknown) {
        if (
          typeof value !== "object" || value === null || Array.isArray(value)
        ) {
          return { issues: [{ message: "expected an object" }] };
        }
        const issues: Issue[] = [];
        const out = parse(value as Record<string, unknown>, issues);
        return issues.length > 0 ? { issues } : { value: out };
      },
    },
  };
}

const MAX_DIM = 10_000;

function dim(v: Record<string, unknown>, key: string, issues: Issue[]): number {
  const n = v[key];
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_DIM) {
    issues.push({
      message: `${key} must be an integer in 1..${MAX_DIM}`,
      path: [key],
    });
    return 1;
  }
  return n;
}

function str(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
  max = 4096,
): string {
  const s = v[key];
  if (typeof s !== "string" || s === "" || s.length > max) {
    issues.push({ message: `${key} must be a non-empty string`, path: [key] });
    return "";
  }
  return s;
}

function optStr(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
): string | undefined {
  return v[key] === undefined ? undefined : str(v, key, issues);
}

const spawnInput = objectSchema<PtySpawnArgs>((v, issues) => ({
  cols: dim(v, "cols", issues),
  rows: dim(v, "rows", issues),
  cwd: optStr(v, "cwd", issues),
  shell: optStr(v, "shell", issues),
}));

const emptyInput = objectSchema<Record<string, never>>(() => ({}));

const idInput = objectSchema<{ id: string }>((v, issues) => ({
  id: str(v, "id", issues, 64),
}));

const writeInput = objectSchema<{ id: string; data: string; binary?: boolean }>(
  (v, issues) => {
    const data = v.data;
    if (typeof data !== "string" || data.length > 1 << 20) {
      issues.push({
        message: "data must be a string (at most 1 MiB)",
        path: ["data"],
      });
    }
    const binary = v.binary;
    if (binary !== undefined && typeof binary !== "boolean") {
      issues.push({ message: "binary must be a boolean", path: ["binary"] });
    } else if (
      binary === true && typeof data === "string" &&
      [...data].some((ch) => ch.charCodeAt(0) > 0xff)
    ) {
      issues.push({
        message: "binary data must hold only byte values (U+0000..U+00FF)",
        path: ["data"],
      });
    }
    return {
      id: str(v, "id", issues, 64),
      data: typeof data === "string" ? data : "",
      ...(binary === true ? { binary: true } : {}),
    };
  },
);

const resizeInput = objectSchema<{ id: string; cols: number; rows: number }>((
  v,
  issues,
) => ({
  id: str(v, "id", issues, 64),
  cols: dim(v, "cols", issues),
  rows: dim(v, "rows", issues),
}));

// ---------------------------------------------------------------------------------------------
// libc over FFI
// ---------------------------------------------------------------------------------------------

const IS_DARWIN = Deno.build.os === "darwin";
const EAGAIN = IS_DARWIN ? 35 : 11;
const EINTR = 4;
const POLLIN = 0x1;
const POLLOUT = 0x4;
const POLLERR = 0x8;
const POLLHUP = 0x10;
const POLLNVAL = 0x20;
const SIGHUP = 1;
const SIGKILL = 9;
const X_OK = 1;
/** `proc_pidinfo` flavor PROC_PIDVNODEPATHINFO and the layout of `struct proc_vnodepathinfo`. */
const PROC_PIDVNODEPATHINFO = 9;
const VNODE_INFO_SIZE = 152;
const MAXPATHLEN = 1024;
const VNODEPATHINFO_SIZE = 2 * (VNODE_INFO_SIZE + MAXPATHLEN);

// mode_t is 16-bit on macOS, 32-bit on Linux (a non-variadic argument, so the width matters).
const MODE_T = IS_DARWIN ? "u16" : "u32";

const LIBC_SYMBOLS = {
  read: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  poll: {
    parameters: ["buffer", "u32", "i32"],
    result: "i32",
    nonblocking: true,
  },
  close: { parameters: ["i32"], result: "i32" },
  kill: { parameters: ["i32", "i32"], result: "i32" },
  tcgetpgrp: { parameters: ["i32"], result: "i32" },
  access: { parameters: ["buffer", "i32"], result: "i32" },
  creat: { parameters: ["buffer", MODE_T], result: "i32" },
  chmod: { parameters: ["buffer", MODE_T], result: "i32" },
  mkdir: { parameters: ["buffer", MODE_T], result: "i32" },
  rename: { parameters: ["buffer", "buffer"], result: "i32" },
} as const;

// The 64-bit-inode `struct stat` entry points (plain `fstat`/`stat` are the legacy ones on x64).
const STAT_SUFFIX = Deno.build.arch === "x86_64" ? "$INODE64" : "";

const DARWIN_SYMBOLS = {
  __error: { parameters: [], result: "pointer" },
  proc_pidinfo: {
    parameters: ["i32", "i32", "u64", "buffer", "i32"],
    result: "i32",
  },
  fstat: {
    name: `fstat${STAT_SUFFIX}`,
    parameters: ["i32", "buffer"],
    result: "i32",
  },
  stat: {
    name: `stat${STAT_SUFFIX}`,
    parameters: ["buffer", "buffer"],
    result: "i32",
  },
} as const;

const LINUX_SYMBOLS = {
  __errno_location: { parameters: [], result: "pointer" },
} as const;

const LIBC_PATH = IS_DARWIN ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

type Libc = Deno.DynamicLibrary<typeof LIBC_SYMBOLS>["symbols"];
let libcCache: Libc | undefined;
let darwinCache:
  | Deno.DynamicLibrary<typeof DARWIN_SYMBOLS>["symbols"]
  | undefined;
let linuxCache:
  | Deno.DynamicLibrary<typeof LINUX_SYMBOLS>["symbols"]
  | undefined;

/** libc, opened on first use (nothing runs at import). */
function libc(): Libc {
  return (libcCache ??= Deno.dlopen(LIBC_PATH, LIBC_SYMBOLS).symbols);
}

function darwinLibc() {
  return (darwinCache ??= Deno.dlopen(LIBC_PATH, DARWIN_SYMBOLS).symbols);
}

/** The calling thread's errno (read right after the failing call, on the same JS thread). */
function errno(): number {
  const ptr = IS_DARWIN
    ? darwinLibc().__error()
    : (linuxCache ??= Deno.dlopen(LIBC_PATH, LINUX_SYMBOLS).symbols)
      .__errno_location();
  return ptr ? new Deno.UnsafePointerView(ptr).getInt32() : 0;
}

const encoder = new TextEncoder();
const cstr = (s: string) => encoder.encode(`${s}\0`);

/** One `struct pollfd` for `fd`. */
function pollFd(
  fd: number,
  events: number,
): { buf: Uint8Array; revents: () => number } {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setInt32(0, fd, true);
  view.setInt16(4, events, true);
  return { buf, revents: () => view.getInt16(6, true) };
}

/** Darwin `struct stat` (64-bit inode): st_mode u16 @4, st_ino u64 @8, st_rdev i32 @24. */
const STAT_SIZE = 144;
const S_IFMT = 0o170000;
const S_IFCHR = 0o020000;

interface FdStat {
  chr: boolean;
  ino: bigint;
  rdev: number;
}

function parseStat(buf: Uint8Array): FdStat {
  const v = new DataView(buf.buffer);
  return {
    chr: (v.getUint16(4, true) & S_IFMT) === S_IFCHR,
    ino: v.getBigUint64(8, true),
    rdev: v.getInt32(24, true),
  };
}

/** `fstat(fd)` (macOS), or `undefined` when `fd` is not open. */
function fdStat(fd: number): FdStat | undefined {
  const buf = new Uint8Array(STAT_SIZE);
  return darwinLibc().fstat(fd, buf) === 0 ? parseStat(buf) : undefined;
}

/** The lowest fd that is not open (what the next `open` returns), macOS. */
function lowestFreeFd(): number {
  let fd = 0;
  while (fdStat(fd) !== undefined) fd++;
  return fd;
}

/**
 * node-pty 1.1.0's macOS `fork` leaks two descriptors into this process per terminal:
 *
 * - `pty_posix_spawn` opens a spare `/dev/ptmx` (`low_fds[0]`, meant to keep the master off fds
 *   0..2) and its clean-up loop never closes index 0;
 * - it opens the slave tty to configure it and never closes it in the parent (which also keeps
 *   the master from seeing EOF when the shell exits).
 *
 * Close both: the spare is the ptmx clone that took `lowFree` (the lowest free fd just before
 * `fork`) and is not a live master; the slave is the one fd whose device is `ttyPath`'s. (A third
 * leak, the kqueue its exit thread never closes, cannot be told apart from Deno's own and stays
 * until node-pty fixes it.)
 */
function closeForkLeaks(
  forked: { fd: number; pty: string },
  lowFree: number,
  liveMasters: Set<number>,
): void {
  const c = libc();
  const master = fdStat(forked.fd);
  if (!master) return;
  const spare = lowFree === forked.fd ? undefined : fdStat(lowFree);
  if (
    spare?.chr && spare.ino === master.ino && !liveMasters.has(lowFree)
  ) {
    c.close(lowFree);
  }
  const ttyBuf = new Uint8Array(STAT_SIZE);
  if (darwinLibc().stat(cstr(forked.pty), ttyBuf) !== 0) return;
  const tty = parseStat(ttyBuf);
  if (!tty.chr) return;
  // The slave was opened right after the master, but not necessarily near it: when the fd table
  // has holes (a long-lived process), the master fills a low hole and the slave can land far
  // above it. Scan the whole table, ending after a long run of unused fds past the master.
  const GAP = 256;
  for (let fd = 0, unused = 0; fd <= forked.fd || unused < GAP; fd++) {
    if (fd === forked.fd) continue;
    const st = fdStat(fd);
    if (!st) {
      unused++;
      continue;
    }
    unused = 0;
    if (st.chr && st.rdev === tty.rdev) c.close(fd);
  }
}

// ---------------------------------------------------------------------------------------------
// node-pty
// ---------------------------------------------------------------------------------------------

/** The Unix half of node-pty's native addon (`require("node-pty").native`, not in its typings). */
interface NodePtyNative {
  fork(
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helperPath: string,
    onexit: (code: number, signal: number) => void,
  ): { fd: number; pid: number; pty: string };
  resize(fd: number, cols: number, rows: number): void;
  /** macOS: `process(fd)`; Linux: `process(fd, ptyName)`. */
  process(fd: number, tty?: string): string;
}

let nativeCache: Promise<{ native: NodePtyNative; dir: URL }> | undefined;

function loadNodePty(): Promise<{ native: NodePtyNative; dir: URL }> {
  nativeCache ??= (async () => {
    const mod = await import("node-pty") as unknown as {
      native?: NodePtyNative;
      default?: { native?: NodePtyNative };
    };
    const native = mod.native ?? mod.default?.native;
    if (!native) {
      throw new Error("node-pty has no native module on this platform");
    }
    // node-pty's `main` is lib/index.js; the package root is one level up.
    const dir = new URL("../", import.meta.resolve("node-pty"));
    return { native, dir };
  })();
  nativeCache.catch(() => (nativeCache = undefined));
  return nativeCache;
}

let helperCache: string | undefined;

/**
 * An executable spawn-helper path: the package's own (made executable), or a copy in
 * `appSupportDir` when the package's cannot be executed (a compiled app's embedded file system).
 */
async function spawnHelper(
  dir: URL,
  appSupportDir: string | undefined,
): Promise<string> {
  if (helperCache) return helperCache;
  const arch = Deno.build.arch === "aarch64" ? "arm64" : "x64";
  const candidates = [
    "build/Release/spawn-helper",
    "build/Debug/spawn-helper",
    `prebuilds/${Deno.build.os}-${arch}/spawn-helper`,
  ].map((rel) => new URL(rel, dir));
  let source: URL | undefined;
  for (const c of candidates) {
    try {
      await Deno.stat(c);
      source = c;
      break;
    } catch { /* next */ }
  }
  if (!source) throw new Error("node-pty spawn-helper not found");
  const path = decodeURIComponent(source.pathname);
  // Deno.chmod is VFS-aware; access(2) asks the real file system, which is what exec uses.
  await Deno.chmod(path, 0o755).catch(() => {});
  const c = libc();
  if (c.access(cstr(path), X_OK) === 0) return (helperCache = path);

  if (!appSupportDir) {
    throw new Error(
      "spawn-helper is not executable and there is nowhere to copy it",
    );
  }
  const bytes = await Deno.readFile(path);
  const destDir = `${appSupportDir}/node-pty`;
  const dest = `${destDir}/spawn-helper`;
  try {
    const existing = await Deno.readFile(dest);
    if (
      existing.length === bytes.length && existing.every((b, i) =>
        b === bytes[i]
      ) &&
      c.access(cstr(dest), X_OK) === 0
    ) return (helperCache = dest);
  } catch { /* not there yet */ }
  // Written through libc so the app needs no --allow-write (FFI is already full trust).
  c.mkdir(cstr(appSupportDir), 0o755);
  c.mkdir(cstr(destDir), 0o755);
  const tmp = `${dest}.${Deno.pid}.tmp`;
  const fd = c.creat(cstr(tmp), 0o755);
  if (fd < 0) {
    throw new Error(`cannot create spawn-helper copy (errno ${errno()})`);
  }
  try {
    let off = 0;
    while (off < bytes.length) {
      const n = Number(
        c.write(fd, bytes.subarray(off), BigInt(bytes.length - off)),
      );
      if (n < 0) {
        if (errno() === EINTR) continue;
        throw new Error(`cannot write spawn-helper copy (errno ${errno()})`);
      }
      off += n;
    }
  } finally {
    c.close(fd);
  }
  c.chmod(cstr(tmp), 0o755);
  if (c.rename(cstr(tmp), cstr(dest)) !== 0) {
    throw new Error(`cannot install spawn-helper copy (errno ${errno()})`);
  }
  return (helperCache = dest);
}

// ---------------------------------------------------------------------------------------------
// The host: every live terminal (exported for tests; the extension below wraps one)
// ---------------------------------------------------------------------------------------------

const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;
const READ_CHUNK = 64 * 1024;
const POLL_MS = 100;
/** After the shell exits, how long to wait for the master to report EOF before closing. */
const EXIT_GRACE_MS = 250;
/** After `kill`, how long before SIGHUP escalates to SIGKILL. */
const KILL_ESCALATE_MS = 3000;

/** Parent-terminal variables a child shell must not inherit (as node-pty's `_sanitizeEnv`). */
const STRIP_ENV = [
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "WINDOWID",
  "TERMCAP",
  "COLUMNS",
  "LINES",
];

interface Term {
  id: string;
  pid: number;
  fd: number;
  tty: string;
  shell: string;
  cwd: string;
  owner: string;
  decoder: TextDecoder;
  pending: string[];
  pendingBytes: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  seq: number;
  writeChain: Promise<void>;
  stopping: boolean;
  readerDone: boolean;
  exit?: { exitCode: number; signal: number | null };
  finalized: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
}

/** How the host reports events (the extension passes `ctx.emit`). */
export type PtyEmit = (
  event: "data" | "exit",
  data: PtyDataEvent | PtyExitEvent,
) => void;

/** Options for {@linkcode PtyHost.spawn}. */
export interface PtySpawnOptions {
  /** Where to copy spawn-helper when the package's copy cannot be executed. */
  appSupportDir?: string;
  /** The window that owns the terminal (killed when that window's page reloads). */
  owner?: string;
}

/** Every live PTY, the coalescing, and the I/O loops. */
export class PtyHost {
  readonly #terms = new Map<string, Term>();
  #emit: PtyEmit;
  #nextId = 0;

  constructor(emit: PtyEmit) {
    this.#emit = emit;
  }

  /** Replace the event sink (the extension re-binds to the latest handler's `ctx.emit`). */
  setEmit(emit: PtyEmit): void {
    this.#emit = emit;
  }

  /** How many terminals are live. */
  get size(): number {
    return this.#terms.size;
  }

  async spawn(
    args: PtySpawnArgs,
    opts: PtySpawnOptions = {},
  ): Promise<PtySpawnResult> {
    if (Deno.build.os === "windows") {
      throw new DesktopCapError(
        "unsupported",
        "PTYs are not supported on Windows yet",
      );
    }
    const { native, dir } = await loadNodePty();
    this.#nativeCache = { native };
    const helper = await spawnHelper(dir, opts.appSupportDir);

    const home = Deno.env.get("HOME") ?? "/";
    const shell = args.shell ?? Deno.env.get("SHELL") ?? "/bin/zsh";
    try {
      if (!(await Deno.stat(shell)).isFile) throw new Error();
    } catch {
      throw new DesktopCapError("spawn_failed", "the shell does not exist");
    }
    let cwd = args.cwd ?? home;
    try {
      if (!(await Deno.stat(cwd)).isDirectory) cwd = home;
    } catch {
      cwd = home;
    }

    const env: Record<string, string> = { ...Deno.env.toObject() };
    for (const k of STRIP_ENV) delete env[k];
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.TERM_PROGRAM = "qutty";
    env.PWD = cwd;
    env.SHELL ??= shell;
    // A Finder-launched app has no locale; a UTF-8 one keeps the shell's line editing sane.
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";
    const envList = Object.entries(env).map(([k, v]) => `${k}=${v}`);

    const id = `pty-${++this.#nextId}`;
    // Assigned once after fork; the exit callback reads it first (it can fire before then).
    // deno-lint-ignore prefer-const
    let term: Term | undefined;
    let earlyExit: { exitCode: number; signal: number | null } | undefined;
    let forked: { fd: number; pid: number; pty: string };
    const lowFree = IS_DARWIN ? lowestFreeFd() : -1;
    try {
      forked = native.fork(
        shell,
        ["-l"],
        envList,
        cwd,
        args.cols,
        args.rows,
        -1,
        -1,
        true,
        helper,
        (code, signal) => {
          const exit = { exitCode: code, signal: signal ? signal : null };
          if (term) this.#onExit(term, exit);
          else earlyExit = exit;
        },
      );
    } catch (err) {
      throw new DesktopCapError(
        "spawn_failed",
        `could not start the shell: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (IS_DARWIN) {
      closeForkLeaks(
        forked,
        lowFree,
        new Set([...this.#terms.values()].map((t) => t.fd)),
      );
    }
    term = {
      id,
      pid: forked.pid,
      fd: forked.fd,
      tty: forked.pty,
      shell,
      cwd,
      owner: opts.owner ?? "main",
      decoder: new TextDecoder("utf-8"),
      pending: [],
      pendingBytes: 0,
      seq: 0,
      writeChain: Promise.resolve(),
      stopping: false,
      readerDone: false,
      finalized: false,
    };
    this.#terms.set(id, term);
    void this.#readLoop(term);
    if (earlyExit) this.#onExit(term, earlyExit);
    return { id, pid: forked.pid, shell, cwd };
  }

  /**
   * Write input to the shell. Text is UTF-8 encoded; `binary` data (xterm's `onBinary`: legacy
   * X10/normal mouse reports, whose coordinates are raw bytes) is written one byte per char.
   */
  async write(id: string, data: string, binary = false): Promise<void> {
    const t = this.#get(id);
    const bytes = binary
      ? Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff)
      : encoder.encode(data);
    if (bytes.length === 0) return;
    // Ordered: each write waits for the previous one (a paste can hit EAGAIN).
    t.writeChain = t.writeChain.then(() => this.#writeAll(t, bytes)).catch(
      () => {},
    );
    await t.writeChain;
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.#get(id);
    if (t.finalized) return;
    const { native } = this.#nativeSync();
    try {
      native.resize(t.fd, cols, rows);
    } catch { /* the pty went away */ }
  }

  kill(id: string): void {
    const t = this.#terms.get(id);
    if (!t || t.finalized) return;
    libc().kill(t.pid, SIGHUP);
    if (t.killTimer === undefined) {
      t.killTimer = setTimeout(() => {
        if (!t.finalized) libc().kill(t.pid, SIGKILL);
      }, KILL_ESCALATE_MS);
      Deno.unrefTimer(t.killTimer as unknown as number);
    }
  }

  async info(id: string): Promise<PtyInfo> {
    const t = this.#get(id);
    const { native } = await loadNodePty();
    let process = "";
    const fg = libc().tcgetpgrp(t.fd);
    if (fg > 0) {
      try {
        process = IS_DARWIN
          ? native.process(t.fd)
          : native.process(t.fd, t.tty);
      } catch { /* gone */ }
    }
    // No foreground process group yet (the shell is still starting): node-pty would look up pid
    // 0 and answer `kernel_task` on macOS. The shell is what runs.
    if (!process) process = t.shell.slice(t.shell.lastIndexOf("/") + 1);
    const cwd = (fg > 0 ? await processCwd(fg) : undefined) ??
      await processCwd(t.pid);
    return { id, pid: t.pid, process, ...(cwd ? { cwd } : {}) };
  }

  /** Kill the terminals a window owns (its page reloaded or navigated away). */
  killOwnedBy(owner: string): void {
    for (const t of this.#terms.values()) {
      if (t.owner === owner) this.kill(t.id);
    }
  }

  /** Synchronous teardown for process exit: hang up every shell and close every master. */
  killAllNow(): void {
    for (const t of this.#terms.values()) {
      t.stopping = true;
      try {
        libc().kill(t.pid, SIGHUP);
        libc().close(t.fd);
      } catch { /* best effort */ }
      t.finalized = true;
    }
    this.#terms.clear();
  }

  /** Graceful teardown (tests): kill every terminal and wait for their `exit`. */
  async dispose(timeoutMs = 5000): Promise<void> {
    const ids = [...this.#terms.keys()];
    for (const id of ids) this.kill(id);
    const deadline = Date.now() + timeoutMs;
    while (this.#terms.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (this.#terms.size > 0) this.killAllNow();
  }

  #nativeCache?: { native: NodePtyNative };
  #nativeSync(): { native: NodePtyNative } {
    // Only reached for a live terminal, so node-pty is loaded already.
    if (!this.#nativeCache) {
      throw new DesktopCapError("internal", "node-pty is not loaded");
    }
    return this.#nativeCache;
  }

  #get(id: string): Term {
    const t = this.#terms.get(id);
    if (!t) {
      throw new DesktopCapError("not_found", "no such terminal", {
        status: 404,
      });
    }
    return t;
  }

  async #readLoop(t: Term): Promise<void> {
    const c = libc();
    const pfd = pollFd(t.fd, POLLIN);
    const buf = new Uint8Array(READ_CHUNK);
    try {
      outer: while (!t.stopping) {
        const r = await c.poll(pfd.buf, 1, POLL_MS);
        if (t.stopping) break;
        // poll ran on another thread, so errno is not readable here; a failed poll is EINTR /
        // EAGAIN / ENOMEM (a bad fd answers POLLNVAL in revents instead): try again.
        if (r < 0) continue;
        if (r === 0) continue;
        const revents = pfd.revents();
        if (revents & POLLIN) {
          // Drain what is there (bounded, so one chatty terminal cannot starve the others).
          for (let i = 0; i < 16; i++) {
            const n = Number(c.read(t.fd, buf, BigInt(buf.length)));
            if (n > 0) {
              this.#push(t, buf.subarray(0, n));
              if (n < buf.length) break;
              continue;
            }
            if (n < 0) {
              const e = errno();
              if (e === EAGAIN || e === EINTR) break;
            }
            break outer; // 0 = EOF, EIO = every slave closed
          }
        } else if (revents & (POLLHUP | POLLERR | POLLNVAL)) {
          break;
        }
      }
    } finally {
      t.readerDone = true;
      if (t.exit) this.#finalize(t);
    }
  }

  #push(t: Term, bytes: Uint8Array): void {
    const text = t.decoder.decode(bytes, { stream: true });
    if (text) t.pending.push(text);
    t.pendingBytes += bytes.length;
    if (t.pendingBytes >= FLUSH_BYTES) this.#flush(t);
    else if (t.flushTimer === undefined) {
      t.flushTimer = setTimeout(() => this.#flush(t), FLUSH_MS);
    }
  }

  #flush(t: Term): void {
    if (t.flushTimer !== undefined) {
      clearTimeout(t.flushTimer);
      t.flushTimer = undefined;
    }
    t.pendingBytes = 0;
    if (t.pending.length === 0) return;
    const data = t.pending.join("");
    t.pending = [];
    this.#safeEmit("data", { id: t.id, seq: ++t.seq, data });
  }

  #onExit(t: Term, exit: { exitCode: number; signal: number | null }): void {
    if (t.exit) return;
    t.exit = exit;
    if (t.readerDone) {
      this.#finalize(t);
      return;
    }
    // Usually the reader sees EOF right away; a background job holding the slave open (or the
    // macOS case where the master never reports it) must not keep the terminal alive.
    const timer = setTimeout(() => {
      t.stopping = true;
    }, EXIT_GRACE_MS);
    Deno.unrefTimer(timer as unknown as number);
  }

  #finalize(t: Term): void {
    if (t.finalized) return;
    t.finalized = true;
    if (t.killTimer !== undefined) clearTimeout(t.killTimer);
    const tail = t.decoder.decode();
    if (tail) t.pending.push(tail);
    this.#flush(t);
    libc().close(t.fd);
    this.#terms.delete(t.id);
    const exit = t.exit ?? { exitCode: -1, signal: null };
    this.#safeEmit("exit", {
      id: t.id,
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
  }

  async #writeAll(t: Term, bytes: Uint8Array): Promise<void> {
    const c = libc();
    let off = 0;
    while (off < bytes.length && !t.finalized) {
      const n = Number(
        c.write(t.fd, bytes.subarray(off), BigInt(bytes.length - off)),
      );
      if (n >= 0) {
        off += n;
        continue;
      }
      const e = errno();
      if (e === EINTR) continue;
      if (e !== EAGAIN) return; // the pty is gone
      // The kernel buffer is full (a large paste): wait until the master is writable.
      const pfd = pollFd(t.fd, POLLOUT);
      await c.poll(pfd.buf, 1, POLL_MS);
    }
  }

  #safeEmit(event: "data" | "exit", data: PtyDataEvent | PtyExitEvent): void {
    try {
      this.#emit(event, data);
    } catch (err) {
      console.error("pty: emit failed", err);
    }
  }
}

/** A process's working directory, best-effort (macOS: proc_pidinfo; Linux: /proc). */
async function processCwd(pid: number): Promise<string | undefined> {
  try {
    if (IS_DARWIN) {
      const buf = new Uint8Array(VNODEPATHINFO_SIZE);
      const n = darwinLibc().proc_pidinfo(
        pid,
        PROC_PIDVNODEPATHINFO,
        0n,
        buf,
        buf.length,
      );
      if (n <= 0) return undefined;
      const path = buf.subarray(VNODE_INFO_SIZE, VNODE_INFO_SIZE + MAXPATHLEN);
      const end = path.indexOf(0);
      const s = new TextDecoder().decode(
        path.subarray(0, end < 0 ? path.length : end),
      );
      return s || undefined;
    }
    return await Deno.readLink(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------------------------

let host: PtyHost | undefined;

function getHost(emit: PtyEmit): PtyHost {
  if (!host) {
    host = new PtyHost(emit);
    globalThis.addEventListener("unload", () => host?.killAllNow());
  } else {
    host.setEmit(emit);
  }
  return host;
}

function requireHost(): PtyHost {
  if (!host) {
    throw new DesktopCapError("not_found", "no such terminal", { status: 404 });
  }
  return host;
}

export default defineDesktopExtension({
  name: "pty",
  events: ["data", "exit"],
  perWindow: true,
  onPageLoad: (windowId?: string) => {
    host?.killOwnedBy(windowId ?? "main");
  },
  methods: {
    spawn: {
      input: spawnInput,
      handler: async (args: unknown, ctx): Promise<PtySpawnResult> => {
        const h = getHost((event, data) => ctx.emit(event, data));
        return await h.spawn(args as PtySpawnArgs, {
          appSupportDir: ctx.appSupportDir || undefined,
          owner: ctx.windowId ?? "main",
        });
      },
    },
    write: {
      input: writeInput,
      handler: async (args: unknown): Promise<void> => {
        const { id, data, binary } = args as {
          id: string;
          data: string;
          binary?: boolean;
        };
        await requireHost().write(id, data, binary === true);
      },
    },
    resize: {
      input: resizeInput,
      handler: (args: unknown): void => {
        const { id, cols, rows } = args as {
          id: string;
          cols: number;
          rows: number;
        };
        requireHost().resize(id, cols, rows);
      },
    },
    kill: {
      input: idInput,
      handler: (args: unknown): void => {
        requireHost().kill((args as { id: string }).id);
      },
    },
    info: {
      input: idInput,
      handler: async (args: unknown): Promise<PtyInfo> => {
        return await requireHost().info((args as { id: string }).id);
      },
    },
    // The user's macOS key bindings (~/Library/KeyBindings/DefaultKeyBinding.dict), which the
    // terminal honors the way native text fields do (lib/key-bindings.ts). null when absent.
    keyBindings: {
      input: emptyInput,
      handler: async (): Promise<string | null> => {
        const home = Deno.env.get("HOME");
        if (!IS_DARWIN || !home) return null;
        try {
          return await Deno.readTextFile(
            `${home}/Library/KeyBindings/DefaultKeyBinding.dict`,
          );
        } catch {
          return null;
        }
      },
    },
  },
});
