// The PTY backend: a denext desktop extension (`desktop.capabilities.extensions`) that runs in the
// app's Deno process. The page reaches it through `lib/pty-client.ts` (`desktopExtension("pty")`
// + `onDesktopEvent("pty", "data" | "exit")`).
//
// The terminals: the runtime's `Deno.openPty`
// -------------------------------------------
// Every PTY (a tile's shell, and the hidden ones desktop/ssh.ts, sandbox.ts, voice.ts, ollama.ts,
// links.ts, shell-agent.ts and companion-brain.ts run their helpers in) is opened by denext's Deno
// runtime (`Deno.openPty`, runtime 3.0.0-denext.12 and later; Denext 4.18 pins 3.0.0-denext.22):
// the program, its arguments, its environment (`clearEnv`, so a parent terminal's variables are
// really gone), its folder and its size; `readable` / `writable` streams for the master, `resize`,
// `kill(signal)` and the exit `status`. It is the same runtime API Denext's own `pty` capability
// (`denext desktop add pty`) is built on; that capability is not used as is because it serves the
// page (a shell allow-list, window-owned terminals) while Qutty's terminals are started by the
// backend for workspaces, with any program (ssh, docker, agent tools) and the agent hub's
// environment. Starting programs needs `--allow-run` (unscoped: the user picks the programs).
// Under stock Deno (no `Deno.openPty`) a spawn answers `unsupported`; the tests run on denext's
// toolchain (`deno task test`).
//
// The foreground process and its folder (`info`, the tile's title) come from the OS: `/proc` on
// Linux; `proc_pidinfo` over libc FFI on macOS (the runtime's PTY exposes no master fd, so there
// is no `tcgetpgrp`: the shell's `e_tpgid` names the foreground group instead).
//
// Output coalescing: each terminal's output is buffered and emitted every ~8 ms, or at once when
// 64 KiB are pending, so the page sees a sane number of events. Each `data` event carries a
// per-terminal `seq` because the desktop event stream is at-least-once (a reconnect replays its
// buffer); the client drops repeats.
//
// Lifetime (detachable sessions): a terminal belongs to a workspace (desktop/workspace-host.ts),
// not to a window. Its events go to the window showing that workspace only, through denext's
// `createOwnedResources` (`onOwnerClosed: "detach"`): closing the window detaches the terminal,
// which keeps running, and its output keeps filling a per-terminal replay ring buffer
// (`REPLAY_BYTES`); the window that shows the workspace next attaches it (desktop/session.ts) and
// redraws it from the replay. A page reload attaches it again the same way. The app's quit
// (Cmd+Q) disposes every terminal, and process unload kills what is left. A hard exit also closes
// every master, which makes the kernel hang up the shells.

import {
  defineDesktopExtension,
  DesktopCapError,
  type DesktopExtensionHost,
} from "denext/desktop";
import { workspaces } from "./workspace-host.ts";
import { TerminalSessions } from "./terminal-sessions.ts";
import {
  dim,
  emptyInput,
  objectSchema,
  optStr,
  optStrList,
  str,
} from "./schema.ts";
import {
  AGENT_TOOLS,
  buildAgents,
  buildShells,
  type Launchables,
  parseEtcShells,
  type ShellProbe,
  userBinDirs,
} from "../lib/launcher.ts";

export type { Launchables };

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
  /**
   * A program to run instead of a shell (`ssh`, or a shell picked by the user): an absolute
   * path, or a bare name looked up on `PATH` and the usual bin folders (a Finder-launched app
   * has a minimal `PATH`). Run as is, not as a login shell; `shell` is ignored with it.
   */
  program?: string;
  /** The program's arguments (after its name). */
  args?: string[];
  /**
   * The agent tool `program` is (an `AGENT_TOOLS` name, lib/launcher.ts): the agent hub adds the
   * arguments that connect it (desktop/hub.ts).
   */
  agent?: string;
  /**
   * The agent is started through `ollama launch` (lib/ollama/harnesses.ts), on this model: the
   * hub's arguments then go after a `--` at the end, which ollama hands to the harness, and the
   * hub records the model. Never sandboxed.
   */
  ollamaModel?: string;
  /**
   * Run it in the window's shared Docker sandbox (desktop/sandbox.ts): `docker exec -it` into
   * the window's container. `shell` / `program` then name what runs inside (by command name).
   */
  sandbox?: boolean;
}

/** `spawn` result. */
export interface PtySpawnResult {
  id: string;
  pid: number;
  /** The executable that was started: the shell, or the resolved `program` path. */
  shell: string;
  cwd: string;
}

/** `info` result: best-effort. */
export interface PtyInfo {
  id: string;
  pid: number;
  /** The foreground process's name, e.g. `zsh`, `vim` (the shell's while there is none). */
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
// Input schemas (the helpers live in desktop/schema.ts)
// ---------------------------------------------------------------------------------------------

/** How many arguments a program may be given (an argv, not a payload). */
const MAX_ARGS = 256;

const spawnInput = objectSchema<PtySpawnArgs>((v, issues) => {
  const args = optStrList(v, "args", issues, MAX_ARGS);
  return {
    cols: dim(v, "cols", issues),
    rows: dim(v, "rows", issues),
    cwd: optStr(v, "cwd", issues),
    shell: optStr(v, "shell", issues),
    program: optStr(v, "program", issues),
    ...(args === undefined ? {} : { args }),
    ...(v.agent === undefined ? {} : { agent: str(v, "agent", issues, 64) }),
    ...(v.ollamaModel === undefined
      ? {}
      : { ollamaModel: str(v, "ollamaModel", issues, 200) }),
    ...(v.sandbox === true && v.ollamaModel === undefined
      ? { sandbox: true }
      : {}),
  };
});

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
// libc over FFI: the file writes below (desktop/ssh.ts, companion.ts, voice.ts, hub.ts), errno
// (desktop/hub-socket.ts), the executable check and macOS's process queries
// ---------------------------------------------------------------------------------------------

const IS_DARWIN = Deno.build.os === "darwin";
const EINTR = 4;
const X_OK = 1;
/** `proc_pidinfo` flavors and the layouts read here (`<sys/proc_info.h>`). */
const PROC_PIDTBSDINFO = 3;
const PROC_PIDVNODEPATHINFO = 9;
/** `struct proc_bsdinfo`: `pbi_comm` @48 (16), `pbi_name` @64 (32), `e_tpgid` u32 @112. */
const BSDINFO_SIZE = 136;
const VNODE_INFO_SIZE = 152;
const MAXPATHLEN = 1024;
const VNODEPATHINFO_SIZE = 2 * (VNODE_INFO_SIZE + MAXPATHLEN);

// mode_t is 16-bit on macOS, 32-bit on Linux (a non-variadic argument, so the width matters).
const MODE_T = IS_DARWIN ? "u16" : "u32";

const LIBC_SYMBOLS = {
  write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
  close: { parameters: ["i32"], result: "i32" },
  access: { parameters: ["buffer", "i32"], result: "i32" },
  creat: { parameters: ["buffer", MODE_T], result: "i32" },
  chmod: { parameters: ["buffer", MODE_T], result: "i32" },
  mkdir: { parameters: ["buffer", MODE_T], result: "i32" },
  rename: { parameters: ["buffer", "buffer"], result: "i32" },
} as const;

const DARWIN_SYMBOLS = {
  __error: { parameters: [], result: "pointer" },
  proc_pidinfo: {
    parameters: ["i32", "i32", "u64", "buffer", "i32"],
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
export function errno(): number {
  const ptr = IS_DARWIN
    ? darwinLibc().__error()
    : (linuxCache ??= Deno.dlopen(LIBC_PATH, LINUX_SYMBOLS).symbols)
      .__errno_location();
  return ptr ? new Deno.UnsafePointerView(ptr).getInt32() : 0;
}

const encoder = new TextEncoder();
const cstr = (s: string) => encoder.encode(`${s}\0`);

// ---------------------------------------------------------------------------------------------
// File writes through libc (the app needs no --allow-write; FFI is already full trust). Also
// used by desktop/ssh.ts for ~/.ssh/qutty.conf and the recents file.
// ---------------------------------------------------------------------------------------------

/** `mkdir(path, mode)`; an existing directory is fine (its mode is left alone). */
export function ensureDir(path: string, mode: number): void {
  libc().mkdir(cstr(path), mode);
}

/**
 * Write `bytes` to `path` with `mode`, atomically: a temp file beside it, written, chmod'ed,
 * then renamed over the target (a reader never sees a partial file, and a crash leaves the old
 * one). The target's directory must exist.
 */
export function writeFileAtomic(
  path: string,
  bytes: Uint8Array,
  mode: number,
): void {
  const c = libc();
  const tmp = `${path}.${Deno.pid}.tmp`;
  const fd = c.creat(cstr(tmp), mode);
  if (fd < 0) throw new Error(`cannot create ${tmp} (errno ${errno()})`);
  try {
    let off = 0;
    while (off < bytes.length) {
      const n = Number(
        c.write(fd, bytes.subarray(off), BigInt(bytes.length - off)),
      );
      if (n < 0) {
        if (errno() === EINTR) continue;
        throw new Error(`cannot write ${tmp} (errno ${errno()})`);
      }
      off += n;
    }
  } finally {
    c.close(fd);
  }
  // creat applies the umask; the caller's mode is meant exactly (0600 for ssh files).
  c.chmod(cstr(tmp), mode);
  if (c.rename(cstr(tmp), cstr(path)) !== 0) {
    throw new Error(`cannot install ${path} (errno ${errno()})`);
  }
}

/** `rename(from, to)`, replacing `to` (both in one file system). */
export function renamePath(from: string, to: string): void {
  if (libc().rename(cstr(from), cstr(to)) !== 0) {
    throw new Error(`cannot move ${from} to ${to} (errno ${errno()})`);
  }
}

/** The bin folders a Finder-launched app's `PATH` lacks, searched after `PATH` itself. */
const FALLBACK_BIN = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
];

/**
 * Where a bare program name is looked up, in order and without repeats: `PATH`, then
 * {@linkcode FALLBACK_BIN}, then the user's own bin folders (`~/.local/bin`, where the Claude
 * Code installer puts `claude`, npm and bun globals...: see `USER_BIN_DIRS` in lib/launcher.ts).
 */
function searchDirs(): string[] {
  return [
    ...new Set([
      ...(Deno.env.get("PATH") ?? "").split(":").filter((d) => d !== ""),
      ...FALLBACK_BIN,
      ...userBinDirs(Deno.env.get("HOME")),
    ]),
  ];
}

/**
 * The executable for `program`: an absolute path as given, a bare name found in
 * {@linkcode searchDirs}. A relative path is refused (what it is relative to is unclear).
 */
export async function resolveProgram(
  program: string,
): Promise<string | undefined> {
  if (program.includes("/")) {
    return program.startsWith("/") && await isExecutable(program)
      ? program
      : undefined;
  }
  for (const dir of searchDirs()) {
    const candidate = `${dir}/${program}`;
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The `PATH` a directly started program gets: the app's own, then the program's folder and the
 * search folders. A Finder-launched app's `PATH` is minimal, and an npm-installed tool
 * (`#!/usr/bin/env node`) needs to find `node` next to it or in Homebrew's folder.
 */
function programPath(file: string): string {
  const dir = file.slice(0, file.lastIndexOf("/")) || "/";
  const own = (Deno.env.get("PATH") ?? "").split(":").filter((d) => d !== "");
  return [...new Set([...own, dir, ...searchDirs()])].join(":");
}

/** The default shell: `$SHELL`, else `/bin/zsh` (what `spawn` starts without `shell`). */
function defaultShellPath(): string {
  return Deno.env.get("SHELL") || "/bin/zsh";
}

/** A shell path probed: its real path when it is an executable file. */
async function probeShell(path: string): Promise<ShellProbe> {
  if (!path.startsWith("/") || !(await isExecutable(path))) return { path };
  try {
    return { path, real: await Deno.realPath(path) };
  } catch {
    return { path };
  }
}

/**
 * What the `+` picker can start here: the shells in `/etc/shells` that exist (one per real
 * file, the default marked) and the agent tools found on `PATH` and the user bin folders.
 */
export async function findLaunchables(
  etcShells = "/etc/shells",
): Promise<Launchables> {
  let text = "";
  try {
    text = await Deno.readTextFile(etcShells);
  } catch { /* no /etc/shells: only the default shell */ }
  const probes = await Promise.all(parseEtcShells(text).map(probeShell));
  const shells = buildShells(probes, await probeShell(defaultShellPath()));
  const found = new Map<string, string>();
  for (const tool of AGENT_TOOLS) {
    const path = await resolveProgram(tool.name);
    if (path) found.set(tool.name, path);
  }
  return { shells, agents: buildAgents(found) };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await Deno.stat(path)).isFile) return false;
  } catch {
    return false;
  }
  return libc().access(cstr(path), X_OK) === 0;
}

// ---------------------------------------------------------------------------------------------
// The runtime's PTY (`Deno.openPty`)
// ---------------------------------------------------------------------------------------------

/** `Deno.openPty`'s options (denext's Deno runtime 3.0.0-denext.12 and later). */
export interface DenoPtyOptions {
  readonly cmd: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly clearEnv?: boolean;
  readonly cols: number;
  readonly rows: number;
}

/** How a PTY's program ended (`Deno.CommandStatus`). */
export interface DenoPtyStatus {
  readonly success: boolean;
  readonly code: number;
  readonly signal: string | null;
}

/** `Deno.Pty`: the program's pid, the master's streams, its size, signals and its end. */
export interface DenoPty {
  readonly pid: number;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly status: Promise<DenoPtyStatus>;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** `Deno.openPty`. */
export type OpenPty = (options: DenoPtyOptions) => DenoPty;

/** The runtime's `Deno.openPty`, or `undefined` under a Deno without it (stock Deno). */
export function runtimeOpenPty(): OpenPty | undefined {
  const open = (Deno as unknown as { openPty?: OpenPty }).openPty;
  return typeof open === "function" ? open.bind(Deno) : undefined;
}

/** The signal numbers `PtyExitEvent.signal` reports (the runtime reports names). */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  ...(IS_DARWIN
    ? { SIGBUS: 10, SIGUSR1: 30, SIGUSR2: 31 }
    : { SIGBUS: 7, SIGUSR1: 10, SIGUSR2: 12 }),
};

/** A signal name as its number (an unknown name as 0, still "killed by a signal"). */
function signalNumber(name: string | null): number | null {
  return name === null ? null : SIGNAL_NUMBERS[name] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// The host: every live terminal (exported for tests; the extension below wraps one)
// ---------------------------------------------------------------------------------------------

const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;
/** After the program exits, how long to wait for the master's last output before closing. */
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
  pty: DenoPty;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  shell: string;
  cwd: string;
  owner: string;
  decoder: TextDecoder;
  pending: string[];
  pendingBytes: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  seq: number;
  writeChain: Promise<void>;
  finalized: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
}

/** How the host reports events (the extension passes `ctx.emit`). */
export type PtyEmit = (
  event: "data" | "exit",
  data: PtyDataEvent | PtyExitEvent,
) => void;

/**
 * Observers of the app's terminals: the agent hub (desktop/hub.ts) gives each terminal its socket
 * and environment, mirrors its output and forgets it when it ends. Only the PTY extension's own
 * host is tapped (not the hidden PTYs desktop/ssh.ts runs scp/sftp in). A tap that throws is
 * logged and ignored: the hub must never break a terminal.
 */
export interface PtyTaps {
  /**
   * Before the program starts: extra environment, and arguments put before a program's own (after
   * a final `--` instead for an agent started through `ollama launch`).
   */
  spawning?(
    id: string,
    info: {
      program?: string;
      agent?: string;
      /** Started through `ollama launch` on this model. */
      ollamaModel?: string;
      cwd: string;
      cols: number;
      rows: number;
      /** A sandboxed terminal: its environment goes into the container by name. */
      sandbox?: { alsoOn: readonly string[] };
    },
  ): {
    env?: Record<string, string>;
    /** A folder put first on `PATH`. */
    pathPrepend?: string;
    args?: string[];
  } | undefined;
  /** Output, as the page gets it (decoded, coalesced). */
  data?(id: string, data: string): void;
  resized?(id: string, cols: number, rows: number): void;
  /** The terminal ended (or its spawn failed after `spawning`). */
  ended?(id: string): void;
}

let ptyTaps: PtyTaps | undefined;

/** A sandboxed terminal to start (what {@linkcode SandboxProvider.prepare} is asked). */
export interface SandboxRequest {
  /** The window the terminal belongs to (one container per window). */
  owner: string;
  cwd?: string;
  /** A picked shell (host path; its name runs inside). */
  shell?: string;
  /** An agent tool: its command name and arguments. */
  agent?: { name: string; args: string[] };
}

/** How a sandboxed terminal is started: the docker CLI and its `exec` argv. */
export interface SandboxCommand {
  /** The `docker` executable. */
  file: string;
  /** Where the tile starts inside the container (shown to the hub). */
  cwd: string;
  /** Extra addresses for the hub's TCP endpoint (native Linux: the bridge gateway). */
  alsoOn: string[];
  /**
   * The argv after `docker`: `envNames` are passed into the container by name (their values are
   * in docker's own environment); `hubArgs` go before an agent's own arguments.
   */
  argv(envNames: string[], hubArgs: string[]): string[];
}

/** The shared sandbox (desktop/sandbox.ts): starts the window's container on demand. */
export interface SandboxProvider {
  prepare(req: SandboxRequest): Promise<SandboxCommand>;
}

let sandboxProvider: SandboxProvider | undefined;

/** Install (or with `undefined` remove) the {@linkcode SandboxProvider}. */
export function setSandboxProvider(p: SandboxProvider | undefined): void {
  sandboxProvider = p;
}

/** Install (or with `undefined` remove) the {@linkcode PtyTaps} of the extension's host. */
export function setPtyTaps(taps: PtyTaps | undefined): void {
  ptyTaps = taps;
}

/** Call a tap, logging (not throwing) its failure. */
function tap<T>(name: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    console.error(`pty: ${name} tap failed`, err);
    return undefined;
  }
}

/** Options for {@linkcode PtyHost.spawn}. */
export interface PtySpawnOptions {
  /** Who owns the terminal: the workspace (the extension's host), or a window / a helper's name. */
  owner?: string;
  /**
   * Called with the new terminal's id once it exists, before any of its output can be emitted
   * (the extension registers it for routing and replay there).
   */
  onCreated?: (id: string) => void;
}

/** Options for a {@linkcode PtyHost}. */
export interface PtyHostOptions {
  /** Report to the module's {@linkcode PtyTaps} (the extension's host only). */
  tapped?: boolean;
  /** `Deno.openPty` (default: the runtime's, looked up at each spawn): a fake one in tests. */
  openPty?: OpenPty;
}

/** Every live PTY, the coalescing, and the I/O loops. */
export class PtyHost {
  readonly #terms = new Map<string, Term>();
  #emit: PtyEmit;
  #nextId = 0;
  readonly #tapped: boolean;
  readonly #openPty: OpenPty | undefined;

  constructor(emit: PtyEmit, opts: PtyHostOptions = {}) {
    this.#emit = emit;
    this.#tapped = opts.tapped === true;
    this.#openPty = opts.openPty;
  }

  #taps(): PtyTaps | undefined {
    return this.#tapped ? ptyTaps : undefined;
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
    const open = this.#openPty ?? runtimeOpenPty();
    if (!open) {
      throw new DesktopCapError(
        "unsupported",
        "terminals need denext's Deno runtime (Deno.openPty, 3.0.0-denext.12 or later)",
      );
    }

    const home = Deno.env.get("HOME") ?? "/";
    const shell = args.shell ?? defaultShellPath();
    let file = shell;
    let argv = ["-l"];
    let sandboxed: SandboxCommand | undefined;
    if (args.sandbox) {
      sandboxed = await prepareSandbox(args, opts.owner ?? "main");
      file = sandboxed.file;
    } else if (args.program !== undefined) {
      const resolved = await resolveProgram(args.program);
      if (!resolved) {
        throw new DesktopCapError(
          "spawn_failed",
          `program not found: ${args.program}`,
        );
      }
      file = resolved;
      argv = args.args ?? [];
    } else {
      try {
        if (!(await Deno.stat(shell)).isFile) throw new Error();
      } catch {
        throw new DesktopCapError("spawn_failed", "the shell does not exist");
      }
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
    if (args.program !== undefined || sandboxed) env.PATH = programPath(file);
    // A Finder-launched app has no locale; a UTF-8 one keeps the shell's line editing sane.
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";

    const id = `pty-${++this.#nextId}`;
    const taps = this.#taps();
    const extra = taps?.spawning
      ? tap("spawning", () =>
        taps.spawning!(id, {
          ...(args.program !== undefined ? { program: file } : {}),
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.ollamaModel !== undefined
            ? { ollamaModel: args.ollamaModel }
            : {}),
          cwd: sandboxed?.cwd ?? cwd,
          cols: args.cols,
          rows: args.rows,
          ...(sandboxed ? { sandbox: { alsoOn: sandboxed.alsoOn } } : {}),
        }))
      : undefined;
    Object.assign(env, extra?.env ?? {});
    if (sandboxed) {
      argv = sandboxed.argv(
        Object.keys(extra?.env ?? {}),
        args.program !== undefined ? extra?.args ?? [] : [],
      );
    } else if (extra?.pathPrepend) {
      env.PATH = [extra.pathPrepend, ...(env.PATH ?? "").split(":")]
        .filter((d, i, all) => d !== "" && all.indexOf(d) === i).join(":");
    }
    if (!sandboxed && args.program !== undefined && extra?.args?.length) {
      // `ollama launch <harness> … -- <args>` hands what follows `--` to the harness.
      argv = args.ollamaModel !== undefined
        ? [...argv, "--", ...extra.args]
        : [...extra.args, ...argv];
    }

    let pty: DenoPty;
    try {
      pty = open({
        cmd: file,
        args: argv,
        cwd,
        env,
        clearEnv: true,
        cols: args.cols,
        rows: args.rows,
      });
    } catch (err) {
      if (taps?.ended) tap("ended", () => taps.ended!(id));
      // The runtime's message names the path; it stays in the app's log, not the page.
      console.error(`pty: could not start ${file}`, err);
      const why = err instanceof Error && err.name === "PermissionDenied"
        ? " (not executable)"
        : "";
      throw new DesktopCapError(
        "spawn_failed",
        `could not start ${args.program ? "the program" : "the shell"}${why}`,
      );
    }
    const term: Term = {
      id,
      pid: pty.pid,
      pty,
      writer: pty.writable.getWriter(),
      shell: file,
      cwd,
      owner: opts.owner ?? "main",
      decoder: new TextDecoder("utf-8"),
      pending: [],
      pendingBytes: 0,
      seq: 0,
      writeChain: Promise.resolve(),
      finalized: false,
    };
    this.#terms.set(id, term);
    if (opts.onCreated) opts.onCreated(id);
    const pumped = this.#readLoop(term);
    pty.status.then(
      async (status) => {
        await pumped;
        // A program a signal ended reports exit code 0 and the signal (the runtime's code is
        // 128 + the signal, as a shell's `$?`).
        const sig = signalNumber(status.signal);
        this.#finalize(term, {
          exitCode: sig === null ? status.code : 0,
          signal: sig,
        });
      },
      async () => {
        await pumped;
        this.#finalize(term, { exitCode: -1, signal: null });
      },
    );
    return { id, pid: pty.pid, shell: file, cwd };
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
    if (bytes.length === 0 || t.finalized) return;
    // Ordered: each write waits for the previous one (the stream also waits out a full kernel
    // buffer, a large paste).
    t.writeChain = t.writeChain.then(() => t.writer.write(bytes)).catch(
      () => {},
    );
    await t.writeChain;
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.#get(id);
    if (t.finalized) return;
    try {
      t.pty.resize(cols, rows);
    } catch { /* the pty went away */ }
    const taps = this.#taps();
    if (taps?.resized) tap("resized", () => taps.resized!(id, cols, rows));
  }

  kill(id: string): void {
    const t = this.#terms.get(id);
    if (!t || t.finalized) return;
    signal(t, "SIGHUP");
    if (t.killTimer === undefined) {
      t.killTimer = setTimeout(() => {
        if (!t.finalized) signal(t, "SIGKILL");
      }, KILL_ESCALATE_MS);
      Deno.unrefTimer(t.killTimer as unknown as number);
    }
  }

  async info(id: string): Promise<PtyInfo> {
    const t = this.#get(id);
    const fg = await foregroundOf(t.pid);
    // No foreground process group yet (the shell is still starting): the shell is what runs.
    let process = fg?.process || t.shell;
    // Linux reports argv[0] ("/bin/sh", or "-zsh" for a login shell); macOS the bare name.
    process = process.slice(process.lastIndexOf("/") + 1).replace(/^-/, "");
    const cwd = (fg ? await processCwd(fg.pid) : undefined) ??
      await processCwd(t.pid);
    return { id, pid: t.pid, process, ...(cwd ? { cwd } : {}) };
  }

  /** Whether terminal `id` is still running (not ended, not unknown). */
  isRunning(id: string): boolean {
    const t = this.#terms.get(id);
    return t !== undefined && !t.finalized;
  }

  /** Kill the terminals a window owns (its page reloaded or navigated away). */
  killOwnedBy(owner: string): void {
    for (const t of this.#terms.values()) {
      if (t.owner === owner) this.kill(t.id);
    }
  }

  /** Synchronous teardown for process exit: hang up every shell (the exit closes the masters). */
  killAllNow(): void {
    for (const t of this.#terms.values()) {
      signal(t, "SIGHUP");
      t.finalized = true;
      if (t.killTimer !== undefined) clearTimeout(t.killTimer);
      if (t.flushTimer !== undefined) clearTimeout(t.flushTimer);
      const taps = this.#taps();
      if (taps?.ended) tap("ended", () => taps.ended!(t.id));
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

  #get(id: string): Term {
    const t = this.#terms.get(id);
    if (!t) {
      throw new DesktopCapError("not_found", "no such terminal", {
        status: 404,
      });
    }
    return t;
  }

  /**
   * Read the master until it ends. A background job can hold the PTY open after the program
   * exits: reading stops a little after the exit.
   */
  async #readLoop(t: Term): Promise<void> {
    const reader = t.pty.readable.getReader();
    let finished = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<"exited">((resolve) => {
      const later = () => {
        if (!finished) {
          grace = setTimeout(() => resolve("exited"), EXIT_GRACE_MS);
        }
      };
      t.pty.status.then(later, later);
    });
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), exited]);
        if (next === "exited") {
          reader.cancel().catch(() => {});
          break;
        }
        if (next.done) break;
        this.#push(t, next.value);
      }
    } catch {
      /* the PTY closed */
    } finally {
      finished = true;
      clearTimeout(grace);
    }
  }

  #push(t: Term, bytes: Uint8Array): void {
    if (t.finalized) return;
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
    const taps = this.#taps();
    if (taps?.data) tap("data", () => taps.data!(t.id, data));
    this.#safeEmit("data", { id: t.id, seq: ++t.seq, data });
  }

  /** The program ended and its output is read: the last output, then the `exit`. */
  #finalize(
    t: Term,
    exit: { exitCode: number; signal: number | null },
  ): void {
    if (t.finalized) return;
    const tail = t.decoder.decode();
    if (tail) t.pending.push(tail);
    this.#flush(t);
    t.finalized = true;
    if (t.killTimer !== undefined) clearTimeout(t.killTimer);
    t.writer.close().catch(() => {});
    this.#terms.delete(t.id);
    const taps = this.#taps();
    if (taps?.ended) tap("ended", () => taps.ended!(t.id));
    this.#safeEmit("exit", {
      id: t.id,
      exitCode: exit.exitCode,
      signal: exit.signal,
    });
  }

  #safeEmit(event: "data" | "exit", data: PtyDataEvent | PtyExitEvent): void {
    try {
      this.#emit(event, data);
    } catch (err) {
      console.error("pty: emit failed", err);
    }
  }
}

/** Send `name` to a terminal's program (it may have ended meanwhile). */
function signal(t: Term, name: string): void {
  try {
    t.pty.kill(name);
  } catch { /* gone */ }
}

/**
 * The foreground process of the terminal whose program is `pid`: its process group's leader and
 * name, or `undefined` while there is none (the shell is still starting) or the OS will not say.
 */
async function foregroundOf(
  pid: number,
): Promise<{ pid: number; process: string } | undefined> {
  try {
    if (IS_DARWIN) {
      const shell = bsdInfo(pid);
      if (!shell || shell.tpgid <= 0) return undefined;
      const fg = bsdInfo(shell.tpgid);
      return fg ? { pid: shell.tpgid, process: fg.name } : undefined;
    }
    // `pid (comm) state ppid pgrp session tty_nr tpgid …`; comm may hold spaces and parens.
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    const tpgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
    if (!Number.isInteger(tpgid) || tpgid <= 0) return undefined;
    const comm = (await Deno.readTextFile(`/proc/${tpgid}/comm`)).trim();
    return { pid: tpgid, process: comm };
  } catch {
    return undefined;
  }
}

/** macOS `proc_pidinfo(PROC_PIDTBSDINFO)`: a process's name and its terminal's foreground group. */
function bsdInfo(pid: number): { name: string; tpgid: number } | undefined {
  const buf = new Uint8Array(BSDINFO_SIZE);
  const n = darwinLibc().proc_pidinfo(
    pid,
    PROC_PIDTBSDINFO,
    0n,
    buf,
    buf.length,
  );
  if (n < BSDINFO_SIZE) return undefined;
  const text = (from: number, len: number) => {
    const bytes = buf.subarray(from, from + len);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(
      bytes.subarray(0, end < 0 ? len : end),
    );
  };
  // `pbi_name` is the longer name (32 bytes); `pbi_comm` (16) when it is empty.
  const name = text(64, 32) || text(48, 16);
  return { name, tpgid: new DataView(buf.buffer).getUint32(112, true) };
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

const SESSIONS = Symbol.for("qutty.terminalSessions");

/**
 * The app's terminals (made on first use; the extension's `setup` connects them). On `globalThis`,
 * like the workspace registry, so desktop.ts (the detach self-test) reaches the same one.
 */
export function terminalSessions(): TerminalSessions {
  const g = globalThis as Record<symbol, TerminalSessions | undefined>;
  let s = g[SESSIONS];
  if (!s) {
    s = g[SESSIONS] = new TerminalSessions({
      workspaces,
      host: (emit) => new PtyHost(emit, { tapped: true }),
    });
    const host = s.host;
    globalThis.addEventListener("unload", () => host.killAllNow());
  }
  return s;
}

/** The calling window (`"main"` for a page that cannot say). */
const callerOf = (ctx: { windowId?: string }) => ({
  id: ctx.windowId ?? "main",
});

/** Ask the {@linkcode SandboxProvider} for a sandboxed terminal's command (a clear error otherwise). */
async function prepareSandbox(
  args: PtySpawnArgs,
  owner: string,
): Promise<SandboxCommand> {
  if (!sandboxProvider) {
    throw new DesktopCapError("spawn_failed", "the sandbox is not available");
  }
  try {
    return await sandboxProvider.prepare({
      owner,
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      ...(args.shell !== undefined ? { shell: args.shell } : {}),
      ...(args.program !== undefined
        ? {
          agent: {
            name: args.agent ?? args.program.replace(/^.*\//, ""),
            args: args.args ?? [],
          },
        }
        : {}),
    });
  } catch (e) {
    throw new DesktopCapError(
      "spawn_failed",
      `the sandbox did not start: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** Type into one of the app's terminals (the agent hub's `write_tile`). */
export async function writeTerminal(id: string, data: string): Promise<void> {
  await terminalSessions().host.write(id, data);
}

/** How long the PTY self-test waits for the shell to answer. */
const SELFTEST_TIMEOUT_MS = 20_000;

/**
 * `QUTTY_PTY_SELFTEST=1`: a check of the packaged app's terminal path without the UI. It checks
 * the runtime has `Deno.openPty`, starts the default login shell through a {@linkcode PtyHost} (as
 * a tile does), waits for its prompt, has it compute `$((6*7))`, logs `pty self-test: OK` and exits
 * the app (1 on failure). Run it under a temporary `HOME` so the user's own app folder and shell
 * history are untouched.
 */
async function ptySelfTest(): Promise<void> {
  const log = (m: string) => console.error(`pty self-test: ${m}`);
  if (!runtimeOpenPty()) throw new Error("the runtime has no Deno.openPty");
  log(`Deno.openPty on Deno ${Deno.version.deno}`);
  let output = "";
  let exited: PtyExitEvent | undefined;
  const pty = new PtyHost((event, data) => {
    if (event === "data") output += (data as PtyDataEvent).data;
    else exited = data as PtyExitEvent;
  });
  const started = await pty.spawn({ cols: 80, rows: 24 }, {
    owner: "selftest",
  });
  log(`spawned ${started.shell} (pid ${started.pid}) in ${started.cwd}`);
  const deadline = Date.now() + SELFTEST_TIMEOUT_MS;
  const until = async (done: () => boolean, what: string) => {
    while (!done()) {
      if (exited) {
        throw new Error(`the shell exited: ${JSON.stringify(exited)}`);
      }
      if (Date.now() > deadline) throw new Error(`no ${what} in time`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await until(() => output.length > 0, "prompt");
  await new Promise((r) => setTimeout(r, 300));
  log(`prompt ${JSON.stringify(output.slice(-120))}`);
  // The answer, not the echo of the line typed, proves the shell ran it.
  await pty.write(started.id, "echo QUTTY_PTY_$((6*7))\r");
  await until(() => output.includes("QUTTY_PTY_42"), "answer");
  log("shell answered QUTTY_PTY_42");
  pty.killAllNow();
  log("OK");
}

export default defineDesktopExtension({
  name: "pty",
  events: ["data", "exit"],
  setup: (h: DesktopExtensionHost) => {
    terminalSessions().connect(h);
    // (`QUTTY_PTY_SELFTEST=detach`, the detach / reattach check, runs from desktop.ts: it needs
    // the app's windows.)
    if (Deno.env.get("QUTTY_PTY_SELFTEST") !== "1") return;
    // Once the app is up (the window), as a tile's shell would start.
    setTimeout(() =>
      ptySelfTest().then(
        () => Deno.exit(0),
        (e) => {
          console.error(`pty self-test: FAILED: ${e?.message ?? e}`);
          Deno.exit(1);
        },
      ), 4000);
  },
  // No `onPageLoad` kill: a reloaded page attaches its workspace's terminals again
  // (desktop/session.ts), as a reopened window does.
  methods: {
    spawn: {
      input: spawnInput,
      handler: async (args: unknown, ctx): Promise<PtySpawnResult> => {
        return await terminalSessions().spawn(
          args as PtySpawnArgs,
          callerOf(ctx),
        );
      },
    },
    write: {
      input: writeInput,
      handler: async (args: unknown, ctx): Promise<void> => {
        const { id, data, binary } = args as {
          id: string;
          data: string;
          binary?: boolean;
        };
        await terminalSessions().write(
          id,
          data,
          binary === true,
          callerOf(ctx),
        );
      },
    },
    resize: {
      input: resizeInput,
      handler: (args: unknown, ctx): void => {
        const { id, cols, rows } = args as {
          id: string;
          cols: number;
          rows: number;
        };
        terminalSessions().resize(id, cols, rows, callerOf(ctx));
      },
    },
    kill: {
      input: idInput,
      // The tile closed: the terminal is killed (if it still runs) and forgotten.
      handler: (args: unknown, ctx): void => {
        terminalSessions().kill((args as { id: string }).id, callerOf(ctx));
      },
    },
    info: {
      input: idInput,
      handler: async (args: unknown, ctx): Promise<PtyInfo> => {
        return await terminalSessions().info(
          (args as { id: string }).id,
          callerOf(ctx),
        );
      },
    },
    // What the `+` picker offers: installed shells and agent tools (lib/launcher.ts).
    launchables: {
      input: emptyInput,
      handler: (): Promise<Launchables> => findLaunchables(),
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
