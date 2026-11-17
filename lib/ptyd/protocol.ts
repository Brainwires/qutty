/**
 * The PTY daemon's wire protocol (desktop/ptyd.ts serves it, desktop/ptyd-client.ts speaks it):
 * newline-delimited JSON over a unix socket in the user's private folder (`/tmp/qutty-<uid>/`).
 *
 * - A request is `{ id, op, ...args }`; its answer `{ re: id, ok: true, ...result }` or
 *   `{ re: id, ok: false, error }`.
 * - Events go to the clients attached to a terminal: `{ ev: "data", sid, data }` (output, decoded
 *   as UTF-8) and `{ ev: "exit", sid, code, signal }` (the program ended).
 * - `hello` and `shutdown` keep their shape in every version, so an app can tell an older or newer
 *   daemon apart (`hello` answers its `v`) and end it. Every other op belongs to {@linkcode
 *   PTYD_PROTOCOL}; the socket's name carries it (`ptyd-<v>.sock`), so daemons of two versions
 *   never share one.
 *
 * Also here, pure and shared by both sides: the line framing ({@linkcode LineDecoder}), the
 * replay ring ({@linkcode ReplayRing}) and the plain-text history of a replay ({@linkcode
 * plainHistory}).
 *
 * @module
 */

/** The protocol version: bump it when an op or event changes shape. */
export const PTYD_PROTOCOL = 1;

/** The socket's file name in the user's private folder, for protocol `v`. */
export function ptydSocketName(v: number = PTYD_PROTOCOL): string {
  return `ptyd-${v}.sock`;
}

/** The protocol version a socket file name is for, or `undefined`. */
export function ptydSocketVersion(name: string): number | undefined {
  const m = /^ptyd-(\d+)\.sock$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

/** The longest line either side accepts (a 1 MiB paste, JSON-escaped, fits). */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** The most bytes of output a daemon keeps per terminal for the next attach. */
export const PTYD_REPLAY_BYTES = 1024 * 1024;

/** The largest opaque state (the app's workspaces) the daemon keeps. */
export const MAX_STATE_CHARS = 4 * 1024 * 1024;

/** How a terminal's program ended (`signal`: its name, `SIGHUP`, or `null`). */
export interface PtydExit {
  code: number;
  signal: string | null;
}

/** One terminal as `list` reports it. */
export interface PtydSession {
  sid: string;
  pid: number;
  cols: number;
  rows: number;
  /** Set once its program has ended (it stays until a client releases it). */
  exit?: PtydExit;
  /** A client is attached (gets its events). */
  attached: boolean;
}

/** What `spawn` starts (the app has built the whole environment already). */
export interface PtydSpawn {
  sid: string;
  cmd: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** The requests, by op (`hello` and `shutdown` are the same in every version). */
export type PtydRequest =
  | { op: "hello"; v: number }
  | { op: "shutdown" }
  | { op: "list" }
  | ({ op: "spawn" } & PtydSpawn)
  | { op: "attach"; sid: string }
  | { op: "detach"; sid: string }
  | { op: "peek"; sid: string; maxBytes: number }
  | { op: "write"; sid: string; data: string; binary?: boolean }
  | { op: "resize"; sid: string; cols: number; rows: number }
  | { op: "kill"; sid: string; signal: string }
  | { op: "release"; sid: string }
  | { op: "getState" }
  | { op: "setState"; state: unknown };

/** The answers' results, by op. */
export interface PtydResults {
  hello: { v: number; pid: number };
  shutdown: Record<string, never>;
  list: { sessions: PtydSession[] };
  spawn: { pid: number };
  attach: { replay: string; truncated: boolean; exit?: PtydExit };
  detach: Record<string, never>;
  peek: { text: string; truncated: boolean };
  write: Record<string, never>;
  resize: Record<string, never>;
  kill: Record<string, never>;
  release: Record<string, never>;
  getState: { state: unknown };
  setState: Record<string, never>;
}

/** An event to an attached client. */
export type PtydEvent =
  | { ev: "data"; sid: string; data: string }
  | { ev: "exit"; sid: string; code: number; signal: string | null };

/** Signals `kill` sends. */
const PTYD_SIGNALS: readonly string[] = [
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGTERM",
  "SIGKILL",
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isSid = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 64;

const isDim = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_000;

const isStrings = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max &&
  v.every((s) => typeof s === "string" && !s.includes("\0"));

/**
 * A request line, checked: `{ id, req }`, or `{ id, error }` for a malformed one (`id` is `null`
 * when even that is missing).
 */
export function parseRequest(
  line: string,
): { id: number; req: PtydRequest } | { id: number | null; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { id: null, error: "not JSON" };
  }
  if (!isObject(v) || !Number.isInteger(v.id)) {
    return { id: null, error: "no request id" };
  }
  const id = v.id as number;
  const bad = (what: string) => ({ id, error: `bad ${what}` });
  switch (v.op) {
    case "hello":
      return Number.isInteger(v.v)
        ? { id, req: { op: "hello", v: v.v as number } }
        : bad("version");
    case "shutdown":
    case "list":
    case "getState":
      return { id, req: { op: v.op } };
    case "spawn": {
      if (!isSid(v.sid)) return bad("sid");
      if (typeof v.cmd !== "string" || !v.cmd.startsWith("/")) {
        return bad("cmd");
      }
      if (!isStrings(v.args, 4096)) return bad("args");
      if (v.cwd !== undefined && typeof v.cwd !== "string") return bad("cwd");
      if (
        !isObject(v.env) ||
        !Object.values(v.env).every((s) => typeof s === "string")
      ) return bad("env");
      if (!isDim(v.cols) || !isDim(v.rows)) return bad("size");
      return {
        id,
        req: {
          op: "spawn",
          sid: v.sid,
          cmd: v.cmd,
          args: v.args,
          ...(v.cwd !== undefined ? { cwd: v.cwd as string } : {}),
          env: v.env as Record<string, string>,
          cols: v.cols,
          rows: v.rows,
        },
      };
    }
    case "attach":
    case "detach":
    case "release":
      return isSid(v.sid) ? { id, req: { op: v.op, sid: v.sid } } : bad("sid");
    case "peek":
      return isSid(v.sid) && Number.isInteger(v.maxBytes) &&
          (v.maxBytes as number) > 0
        ? {
          id,
          req: { op: "peek", sid: v.sid, maxBytes: v.maxBytes as number },
        }
        : bad("peek");
    case "write":
      if (!isSid(v.sid) || typeof v.data !== "string") return bad("write");
      return {
        id,
        req: {
          op: "write",
          sid: v.sid,
          data: v.data,
          ...(v.binary === true ? { binary: true } : {}),
        },
      };
    case "resize":
      return isSid(v.sid) && isDim(v.cols) && isDim(v.rows)
        ? { id, req: { op: "resize", sid: v.sid, cols: v.cols, rows: v.rows } }
        : bad("resize");
    case "kill":
      return isSid(v.sid) && typeof v.signal === "string" &&
          PTYD_SIGNALS.includes(v.signal)
        ? { id, req: { op: "kill", sid: v.sid, signal: v.signal } }
        : bad("kill");
    case "setState":
      return { id, req: { op: "setState", state: v.state ?? null } };
    default:
      return { id, error: `unknown op ${JSON.stringify(v.op)}` };
  }
}

/** One JSON line (the terminator included). */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Bytes in, complete lines out: UTF-8 decoded across chunk boundaries. A line longer than
 * {@linkcode MAX_LINE_CHARS} makes {@linkcode push} throw (the peer is broken: drop it).
 */
export class LineDecoder {
  #decoder = new TextDecoder();
  #pending = "";

  push(bytes: Uint8Array): string[] {
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    if (this.#pending.length > MAX_LINE_CHARS) {
      throw new Error("line too long");
    }
    return lines.filter((l) => l !== "");
  }
}

const utf8 = new TextEncoder();

/**
 * A terminal's recent output, at most `maxBytes` of it (UTF-8), oldest dropped first.
 * {@linkcode text} says whether anything was dropped (the first line is then cut).
 */
export class ReplayRing {
  #chunks: { text: string; bytes: number }[] = [];
  #bytes = 0;
  #truncated = false;
  readonly maxBytes: number;

  constructor(maxBytes: number = PTYD_REPLAY_BYTES) {
    this.maxBytes = maxBytes;
  }

  push(text: string): void {
    if (text === "") return;
    const bytes = utf8.encode(text).length;
    this.#chunks.push({ text, bytes });
    this.#bytes += bytes;
    while (this.#bytes > this.maxBytes && this.#chunks.length > 1) {
      this.#bytes -= this.#chunks.shift()!.bytes;
      this.#truncated = true;
    }
    if (this.#bytes > this.maxBytes) {
      // One chunk bigger than the ring: keep its tail.
      const only = this.#chunks[0];
      const tail = only.text.slice(only.text.length - this.maxBytes);
      this.#chunks = [{ text: tail, bytes: utf8.encode(tail).length }];
      this.#bytes = this.#chunks[0].bytes;
      this.#truncated = true;
    }
  }

  /** Everything kept, and whether older output was dropped. */
  text(): { text: string; truncated: boolean } {
    return {
      text: this.#chunks.map((c) => c.text).join(""),
      truncated: this.#truncated,
    };
  }

  /**
   * The last `maxBytes` (about: counted in characters) of what is kept, and whether it lacks the
   * start of the output.
   */
  tail(maxBytes: number): { text: string; truncated: boolean } {
    const all = this.#chunks.map((c) => c.text).join("");
    return all.length <= maxBytes
      ? { text: all, truncated: this.#truncated }
      : { text: all.slice(all.length - maxBytes), truncated: true };
  }
}

/**
 * A replay that lost its start begins mid-line (and maybe mid-escape): drop up to the first line
 * break, as the app's own replay fold does.
 */
export function cutToLine(text: string, truncated: boolean): string {
  if (!truncated) return text;
  const nl = text.indexOf("\n");
  return nl < 0 ? "" : text.slice(nl + 1);
}

// The escapes a terminal's output carries: OSC (to BEL or ST), DCS / APC / PM / SOS strings, CSI
// sequences, and two-character escapes.
// deno-lint-ignore no-control-regex
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// deno-lint-ignore no-control-regex
const STRING_SEQ = /\x1b[P_^X][^\x1b]*(?:\x1b\\)?/g;
// deno-lint-ignore no-control-regex
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// deno-lint-ignore no-control-regex
const ESC2 = /\x1b[@-Z\\-_()*+][0-9A-Za-z]?/g;
// What is left of the other C0 controls (BEL, backspace, ...), CR, DEL.
// deno-lint-ignore no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * A replay as plain text for a restored terminal's dimmed history: escapes and control
 * characters stripped, a carriage-return overwrite reduced to what was written last, the last
 * `maxLines` non-empty-trailing lines.
 */
export function plainHistory(raw: string, maxLines = 200): string {
  const stripped = raw
    .replace(OSC, "")
    .replace(STRING_SEQ, "")
    .replace(CSI, "")
    .replace(ESC2, "");
  const lines = stripped.split("\n").map((line) => {
    // `progress 10%\rprogress 20%` shows the last write.
    const parts = line.replace(/\r+$/, "").split("\r");
    return parts[parts.length - 1].replace(CONTROLS, "").trimEnd();
  });
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

/**
 * The dimmed history a restored shell shows above its new prompt: the old text in faint
 * (SGR 2), then a rule saying what happened.
 */
export function historyPrelude(history: string, note: string): string {
  if (history === "") return "";
  const body = history.split("\n").join("\r\n");
  return `\x1b[2m${body}\r\n── ${note} ──\x1b[0m\r\n`;
}
