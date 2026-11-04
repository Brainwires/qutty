// The page side of the PTY backend. `getPtyBackend()` picks, at run time:
//
// - `desktopBackend` inside the Deno Desktop window: calls the `pty` desktop extension
//   (desktop/pty.ts) through denext's gated bridge and listens to its `data` / `exit` events;
// - `demoBackend` in a plain browser (`denext dev`): a fake shell (banner, prompt, echo, line
//   editing, a few commands) so the UI can be built without the desktop app.
//
// Detection: `desktopOs()` from `denext/desktop/client` is defined only in a page the desktop
// runtime served (it reads the runtime-injected `__denext.desktop` marker; no bridge call). A
// `?pty=demo` query parameter forces the demo backend, for testing the UI inside the window.
//
// This module is client-safe: the extension is imported for its types only.

import {
  desktopExtension,
  desktopOs,
  onDesktopEvent,
} from "denext/desktop/client";
import type ptyExtension from "../desktop/pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "../desktop/pty.ts";

/** `spawn` options. */
export interface PtySpawnOptions {
  cols: number;
  rows: number;
  /** Working directory (default: the home folder). */
  cwd?: string;
  /** Shell program (default: `$SHELL`, else `/bin/zsh`; started as a login shell). */
  shell?: string;
}

/** What `spawn` returns. */
export interface PtySpawned {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
}

/** What `info` returns (best-effort). */
export interface PtyProcessInfo {
  id: string;
  pid: number;
  /** The foreground process name, e.g. `zsh` or `vim`. */
  process: string;
  /** The foreground process's working directory, when it could be read. */
  cwd?: string;
}

/** How a terminal ended. `signal` is the terminating signal number, or `null`. */
export interface PtyExit {
  exitCode: number;
  signal: number | null;
}

/** A PTY backend: the desktop extension or the in-browser demo shell. */
export interface PtyBackend {
  readonly kind: "desktop" | "demo";
  spawn(options: PtySpawnOptions): Promise<PtySpawned>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  info(id: string): Promise<PtyProcessInfo>;
  /**
   * Output for terminal `id`. Output that arrived before the first subscriber (between the
   * process starting and `spawn` resolving) is delivered to it. Returns an unsubscribe function.
   */
  onData(id: string, cb: (data: string) => void): () => void;
  /** Called once when terminal `id` ends (immediately if it already has). */
  onExit(id: string, cb: (exit: PtyExit) => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Event fan-out shared by both backends
// ---------------------------------------------------------------------------------------------

/** Per-id output not yet claimed by a subscriber is kept up to this many characters. */
const MAX_UNCLAIMED_CHARS = 512 * 1024;
/** Unclaimed output for an id nobody subscribes to is dropped after this long. */
const UNCLAIMED_TTL_MS = 30_000;

/**
 * Per-id fan-out of `data` / `exit` with the early-output buffer. Exported for tests only (the app
 * goes through a {@linkcode PtyBackend}).
 */
export class PtyEvents {
  #data = new Map<string, Set<(data: string) => void>>();
  #exit = new Map<string, Set<(exit: PtyExit) => void>>();
  #unclaimed = new Map<
    string,
    { chunks: string[]; size: number; timer: ReturnType<typeof setTimeout> }
  >();
  #exited = new Map<string, PtyExit>();

  emitData(id: string, data: string): void {
    const subs = this.#data.get(id);
    if (subs && subs.size > 0) {
      for (const cb of subs) cb(data);
      return;
    }
    let u = this.#unclaimed.get(id);
    if (!u) {
      const timer = setTimeout(
        () => this.#unclaimed.delete(id),
        UNCLAIMED_TTL_MS,
      );
      u = { chunks: [], size: 0, timer };
      this.#unclaimed.set(id, u);
    }
    u.chunks.push(data);
    u.size += data.length;
    while (u.size > MAX_UNCLAIMED_CHARS && u.chunks.length > 1) {
      u.size -= u.chunks.shift()!.length;
    }
  }

  emitExit(id: string, exit: PtyExit): void {
    if (this.#exited.has(id)) return;
    this.#exited.set(id, exit);
    const subs = this.#exit.get(id);
    this.#exit.delete(id);
    if (subs) { for (const cb of subs) cb(exit); }
  }

  onData(id: string, cb: (data: string) => void): () => void {
    let subs = this.#data.get(id);
    if (!subs) this.#data.set(id, subs = new Set());
    subs.add(cb);
    const u = this.#unclaimed.get(id);
    if (u) {
      this.#unclaimed.delete(id);
      clearTimeout(u.timer);
      const backlog = u.chunks.join("");
      if (backlog) cb(backlog);
    }
    return () => {
      subs.delete(cb);
      if (subs.size === 0 && this.#data.get(id) === subs) this.#data.delete(id);
    };
  }

  onExit(id: string, cb: (exit: PtyExit) => void): () => void {
    const done = this.#exited.get(id);
    if (done) {
      queueMicrotask(() => cb(done));
      return () => {};
    }
    let subs = this.#exit.get(id);
    if (!subs) this.#exit.set(id, subs = new Set());
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Desktop backend
// ---------------------------------------------------------------------------------------------

/**
 * The two `denext/desktop/client` functions the desktop backend uses. Injectable so tests can
 * drive the backend with a fake bridge and event source.
 */
export interface DesktopBridgeDeps {
  desktopExtension: typeof desktopExtension;
  onDesktopEvent: typeof onDesktopEvent;
}

/**
 * A new desktop backend (the app uses the {@linkcode desktopBackend} singleton). `deps` defaults
 * to the real `denext/desktop/client`; tests pass a fake.
 */
export function createDesktopBackend(
  deps: DesktopBridgeDeps = { desktopExtension, onDesktopEvent },
): PtyBackend {
  const { desktopExtension, onDesktopEvent } = deps;
  const pty = desktopExtension<typeof ptyExtension>("pty");
  const events = new PtyEvents();
  // The desktop event stream is at-least-once (a reconnect replays its buffer): drop repeats.
  const lastSeq = new Map<string, number>();
  let listening = false;

  const listen = () => {
    if (listening) return;
    listening = true;
    onDesktopEvent<PtyDataEvent>("pty", "data", ({ id, seq, data }) => {
      if (seq <= (lastSeq.get(id) ?? 0)) return;
      lastSeq.set(id, seq);
      events.emitData(id, data);
    });
    onDesktopEvent<PtyExitEvent>("pty", "exit", ({ id, exitCode, signal }) => {
      // `lastSeq` is kept after the exit: a replay of the stream re-sends the dead terminal's
      // output too, and must be dropped like any other repeat (one number per terminal).
      events.emitExit(id, { exitCode, signal });
    });
  };

  return {
    kind: "desktop",
    async spawn(options) {
      // Subscribe first: the shell's first output can arrive before `spawn` resolves.
      listen();
      return await pty.spawn(options);
    },
    async write(id, data) {
      await pty.write({ id, data });
    },
    async resize(id, cols, rows) {
      await pty.resize({ id, cols, rows });
    },
    async kill(id) {
      await pty.kill({ id });
    },
    async info(id) {
      return await pty.info({ id });
    },
    onData: (id, cb) => {
      listen();
      return events.onData(id, cb);
    },
    onExit: (id, cb) => {
      listen();
      return events.onExit(id, cb);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Demo backend: a fake shell for plain-browser development
// ---------------------------------------------------------------------------------------------

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const fg = (n: number) => `${ESC}[38;5;${n}m`;

const DEMO_FILES: { name: string; dir?: boolean; exec?: boolean }[] = [
  { name: "Applications", dir: true },
  { name: "Desktop", dir: true },
  { name: "Documents", dir: true },
  { name: "Downloads", dir: true },
  { name: "Source", dir: true },
  { name: "notes.md" },
  { name: "build.sh", exec: true },
  { name: "todo.txt" },
];

const DEMO_HELP = [
  `${BOLD}Qutty demo shell${RESET} ${DIM}(no real processes — browser dev mode)${RESET}`,
  "",
  `  ${fg(81)}help${RESET}       this list`,
  `  ${fg(81)}ls${RESET}         list files`,
  `  ${fg(81)}date${RESET}       print the date`,
  `  ${fg(81)}echo${RESET} ...   print arguments`,
  `  ${fg(81)}clear${RESET}      clear the screen (also Ctrl+L)`,
  `  ${fg(81)}top${RESET}        ticking process table (q or Ctrl+C to quit)`,
  `  ${fg(81)}colors${RESET}     256-colour palette`,
  `  ${fg(81)}stress${RESET} [n] print n lines fast (default 2000)`,
  `  ${fg(81)}size${RESET}       print rows and columns`,
  `  ${fg(81)}pwd${RESET}, ${fg(81)}cd${RESET}, ${fg(81)}whoami${RESET}, ${
    fg(81)
  }exit${RESET}`,
  "",
];

class DemoShell {
  line = "";
  cwd = "~";
  topTimer: ReturnType<typeof setInterval> | undefined;
  exited = false;

  constructor(
    readonly id: string,
    public cols: number,
    public rows: number,
    readonly out: (data: string) => void,
    readonly exit: (e: PtyExit) => void,
  ) {}

  start(): void {
    this.out(
      `${
        fg(141)
      }${BOLD}Qutty${RESET} ${DIM}demo backend — the desktop app runs a real shell${RESET}\r\n` +
        `Type ${fg(81)}help${RESET} for commands.\r\n\r\n`,
    );
    this.prompt();
  }

  prompt(): void {
    this.out(`${fg(114)}demo${RESET}:${fg(75)}${this.cwd}${RESET}$ `);
  }

  get process(): string {
    return this.topTimer ? "top" : "demo-sh";
  }

  input(data: string): void {
    if (this.exited) return;
    if (this.topTimer) {
      if (data.includes("q") || data.includes("\x03")) this.stopTop();
      return;
    }
    // Drop escape sequences (arrows, function keys); the demo has no history or cursor motion.
    // deno-lint-ignore no-control-regex
    const clean = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO.|\x1b./g, "");
    for (const ch of clean) {
      if (ch === "\r" || ch === "\n") {
        this.out("\r\n");
        const cmd = this.line;
        this.line = "";
        this.run(cmd);
        if (this.exited) return;
        if (!this.topTimer) this.prompt();
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length > 0) {
          this.line = [...this.line].slice(0, -1).join("");
          this.out("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        this.out("^C\r\n");
        this.prompt();
      } else if (ch === "\x0c") {
        this.out(`${ESC}[2J${ESC}[H`);
        this.prompt();
        this.out(this.line);
      } else if (ch === "\x15") {
        // Ctrl+U: kill the line.
        this.out("\b \b".repeat([...this.line].length));
        this.line = "";
      } else if (ch === "\x04") {
        if (this.line === "") {
          this.run("exit");
          return; // nothing after the EOF is read
        }
      } else if (ch >= " " || ch === "\t") {
        const c = ch === "\t" ? " " : ch;
        this.line += c;
        this.out(c);
      }
    }
  }

  run(raw: string): void {
    const [cmd = "", ...args] = raw.trim().split(/\s+/);
    const println = (s = "") => this.out(`${s}\r\n`);
    switch (cmd) {
      case "":
        return;
      case "help":
        for (const l of DEMO_HELP) println(l);
        return;
      case "ls": {
        const names = DEMO_FILES.map((f) =>
          f.dir
            ? `${fg(75)}${BOLD}${f.name}${RESET}`
            : f.exec
            ? `${fg(114)}${f.name}${RESET}`
            : f.name
        );
        println(names.join("  "));
        return;
      }
      case "date":
        println(new Date().toString());
        return;
      case "echo":
        println(args.join(" "));
        return;
      case "clear":
        this.out(`${ESC}[2J${ESC}[3J${ESC}[H`);
        return;
      case "pwd":
        println(this.cwd === "~" ? "/Users/demo" : this.cwd);
        return;
      case "cd":
        this.cwd = args[0] && args[0] !== "~"
          ? (args[0].startsWith("/") ? args[0] : `~/${args[0]}`)
          : "~";
        return;
      case "whoami":
        println("demo");
        return;
      case "size":
        println(`${this.rows} ${this.cols}`);
        return;
      case "colors": {
        let s = "";
        for (let i = 0; i < 256; i++) {
          s += `${ESC}[48;5;${i}m ${String(i).padStart(3)} ${RESET}`;
          if (i === 15 || (i > 15 && (i - 15) % 6 === 0)) s += "\r\n";
        }
        this.out(s);
        println();
        return;
      }
      case "stress": {
        const n = Math.min(Math.max(Number(args[0]) || 2000, 1), 200_000);
        const lines: string[] = [];
        for (let i = 1; i <= n; i++) {
          lines.push(
            `${fg(16 + (i % 216))}line ${i}${RESET} ${"·".repeat(i % 60)}`,
          );
        }
        this.out(lines.join("\r\n") + "\r\n");
        return;
      }
      case "top":
        this.startTop();
        return;
      case "exit":
        this.exited = true;
        this.out("logout\r\n");
        this.exit({ exitCode: Number(args[0]) || 0, signal: null });
        return;
      default:
        println(`demo-sh: command not found: ${cmd}`);
    }
  }

  startTop(): void {
    // The alternate screen, like a real full-screen program.
    this.out(`${ESC}[?1049h${ESC}[?25l`);
    const procs = [
      "WindowServer",
      "kernel_task",
      "deno",
      "Qutty",
      "zsh",
      "node",
      "mds_stores",
      "Safari",
    ];
    const draw = () => {
      const now = new Date().toLocaleTimeString();
      let s = `${ESC}[H${ESC}[2J`;
      s += `${BOLD}demo top${RESET} — ${now}   ${DIM}q to quit${RESET}\r\n`;
      s +=
        `Load Avg: ${(Math.random() * 3).toFixed(2)}, ${
          (Math.random() * 3).toFixed(2)
        }  ` +
        `CPU: ${(Math.random() * 40).toFixed(1)}% user\r\n\r\n`;
      s += `${ESC}[7m${"PID".padEnd(7)}${"COMMAND".padEnd(22)}${
        "%CPU".padStart(6)
      }${"MEM".padStart(8)}${
        " ".repeat(Math.max(0, this.cols - 43))
      }${RESET}\r\n`;
      const rows = procs.map((name, i) => ({
        pid: 100 + i * 37,
        name,
        cpu: Math.random() * 30,
        mem: Math.round(Math.random() * 900),
      }))
        .sort((a, b) => b.cpu - a.cpu);
      for (const p of rows.slice(0, Math.max(1, this.rows - 5))) {
        s += `${String(p.pid).padEnd(7)}${p.name.padEnd(22)}${
          p.cpu.toFixed(1).padStart(6)
        }${`${p.mem}M`.padStart(8)}\r\n`;
      }
      this.out(s);
    };
    draw();
    this.topTimer = setInterval(draw, 1000);
  }

  stopTop(): void {
    clearInterval(this.topTimer);
    this.topTimer = undefined;
    this.out(`${ESC}[?25h${ESC}[?1049l`);
    this.prompt();
  }

  dispose(): void {
    if (this.topTimer) clearInterval(this.topTimer);
    this.topTimer = undefined;
  }
}

/** A new demo backend (the app uses the {@linkcode demoBackend} singleton; tests want fresh ones). */
export function createDemoBackend(): PtyBackend {
  const events = new PtyEvents();
  const shells = new Map<string, DemoShell>();
  let next = 0;
  let pid = 4000;

  const get = (id: string) => {
    const s = shells.get(id);
    if (!s) throw new Error(`no such terminal: ${id}`);
    return s;
  };
  // The interface is promise-based: an unknown id rejects rather than throwing synchronously.
  const attempt = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  };
  const end = (id: string, e: PtyExit) => {
    shells.get(id)?.dispose();
    shells.delete(id);
    events.emitExit(id, e);
  };

  return {
    kind: "demo",
    spawn(options) {
      const id = `demo-${++next}`;
      const shell = new DemoShell(
        id,
        options.cols,
        options.rows,
        (data) => events.emitData(id, data),
        (e) => setTimeout(() => end(id, e), 0),
      );
      shells.set(id, shell);
      // Like a real shell, output arrives after spawn resolves (and is buffered until onData).
      setTimeout(() => {
        if (shells.get(id) === shell) shell.start(); // not if killed already
      }, 0);
      return Promise.resolve({
        id,
        pid: ++pid,
        shell: options.shell ?? "demo-sh",
        cwd: options.cwd ?? "/Users/demo",
      });
    },
    write(id, data) {
      return attempt(() => get(id).input(data));
    },
    resize(id, cols, rows) {
      return attempt(() => {
        const s = get(id);
        s.cols = cols;
        s.rows = rows;
      });
    },
    kill(id) {
      if (shells.has(id)) end(id, { exitCode: 0, signal: 1 });
      return Promise.resolve();
    },
    info(id) {
      return attempt(() => {
        const s = get(id);
        return {
          id,
          pid: 4000 + Number(id.slice(5)),
          process: s.process,
          cwd: s.cwd === "~" ? "/Users/demo" : s.cwd,
        };
      });
    },
    onData: (id, cb) => events.onData(id, cb),
    onExit: (id, cb) => events.onExit(id, cb),
  };
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

/** Whether this page runs inside the Deno Desktop window (the runtime-injected marker). */
export function isDesktop(): boolean {
  return desktopOs() !== undefined;
}

let desktopSingleton: PtyBackend | undefined;
let demoSingleton: PtyBackend | undefined;

/** The desktop-extension backend (only works inside the desktop window). */
export function desktopBackend(): PtyBackend {
  return (desktopSingleton ??= createDesktopBackend());
}

/** The in-browser fake shell. */
export function demoBackend(): PtyBackend {
  return (demoSingleton ??= createDemoBackend());
}

/**
 * The backend for this page: the desktop extension inside the desktop window, else the demo
 * shell. `?pty=demo` forces the demo.
 */
export function getPtyBackend(): PtyBackend {
  let forceDemo = false;
  try {
    forceDemo =
      new URLSearchParams(globalThis.location?.search ?? "").get("pty") ===
        "demo";
  } catch { /* no location (SSR) */ }
  return !forceDemo && isDesktop() ? desktopBackend() : demoBackend();
}
