// The command lines Qutty runs for SSH, and the parsers for what they print. Pure and
// client-safe, like lib/ssh-config.ts: the desktop extension (desktop/ssh.ts) spawns what these
// build, and the tests check the argv without starting anything.
//
// Every connection shares one master through `ControlMaster auto` + `ControlPersist`: a second
// tile to the same host, and every scp/sftp transfer, attaches to the socket instead of
// authenticating again. The transfers pass `ControlMaster no` + `BatchMode yes`, so they can
// never prompt (a prompt in a hidden PTY would hang): without a live master they fail at once.

import {
  type SshHostMeta,
  type SshTarget,
  targetLabel,
  targetProblem,
} from "./ssh-config.ts";

// ---------------------------------------------------------------------------------------------
// ControlPath
// ---------------------------------------------------------------------------------------------

/**
 * A unix socket path holds 104 bytes on macOS (108 on Linux), NUL included; ssh expands `%C` to
 * a 40-hex-char hash of the connection, so the directory part may take at most 63 bytes.
 */
const MAX_CONTROL_PATH = 103;
const HASH_LEN = 40;

/**
 * The ControlPath for connections from this home: `~/.ssh/qutty-%C` (next to the user's own
 * sockets, in a 0700 folder), or `/tmp/qutty-%C` when the home path would push the expanded
 * socket name past the limit (a long username).
 */
export function controlPathFor(home: string): string {
  const own = `${home}/.ssh/qutty-%C`;
  return controlPathFits(own) ? own : "/tmp/qutty-%C";
}

/** Whether `path` (with `%C` expanded to its hash) fits the unix socket limit. */
export function controlPathFits(path: string): boolean {
  const expanded = path.replaceAll("%C", "x".repeat(HASH_LEN));
  return new TextEncoder().encode(expanded).length <= MAX_CONTROL_PATH;
}

// ---------------------------------------------------------------------------------------------
// ssh (the tile)
// ---------------------------------------------------------------------------------------------

/** What every ssh/scp/sftp from Qutty shares. */
export interface SshConnectionOptions {
  controlPath: string;
  /** An alternative config file (`-F`): the tests, with a temporary home, use it. */
  configFile?: string;
}

/** The tmux session `tmux` hosts attach to. */
const TMUX_SESSION = "qutty";

/** Quote for a POSIX shell (the remote login shell runs the remote command). */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function assertTarget(target: SshTarget): void {
  const problem = targetProblem(target);
  if (problem) throw new Error(problem);
}

/** The destination word: the alias, or `[user@]host` (an IPv6 literal unbracketed: ssh takes it). */
function destination(target: SshTarget): string {
  return "alias" in target
    ? target.alias
    : `${target.user ? `${target.user}@` : ""}${target.host}`;
}

function portArgs(target: SshTarget, flag: "-p" | "-P"): string[] {
  return "alias" in target || target.port === undefined
    ? []
    : [flag, String(target.port)];
}

function sharedArgs(
  opts: SshConnectionOptions,
  master: "auto" | "no",
): string[] {
  if (!controlPathFits(opts.controlPath)) {
    throw new Error("ControlPath is too long for a unix socket");
  }
  return [
    "-o",
    `ControlMaster=${master}`,
    "-o",
    `ControlPath=${opts.controlPath}`,
    ...(master === "auto"
      ? ["-o", "ControlPersist=10m"]
      : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]),
    ...(opts.configFile ? ["-F", opts.configFile] : []),
  ];
}

/**
 * The argv (after the program) for the interactive tile: the shared master options, the
 * destination after `--` (so a destination can never be read as an option), then, when the
 * host asks for it, `-t` and `tmux new -A -s qutty` or the remote command. With both, the
 * remote command becomes the tmux session's command.
 */
export function sshArgv(
  target: SshTarget,
  opts: SshConnectionOptions,
  meta: Pick<SshHostMeta, "tmux" | "remoteCommand"> = {},
): string[] {
  assertTarget(target);
  const args = [...sharedArgs(opts, "auto"), ...portArgs(target, "-p")];
  const remote: string[] = [];
  if (meta.tmux) {
    remote.push("tmux", "new", "-A", "-s", TMUX_SESSION);
    if (meta.remoteCommand) remote.push(shellQuote(meta.remoteCommand));
  } else if (meta.remoteCommand) {
    remote.push(meta.remoteCommand);
  }
  if (remote.length > 0) args.push("-t");
  args.push("--", destination(target), ...remote);
  return args;
}

// ---------------------------------------------------------------------------------------------
// scp (transfers)
// ---------------------------------------------------------------------------------------------

/** A transfer to build an scp argv for. Local paths are absolute (so scp never reads a `:` as a host). */
export type ScpTransfer =
  | { kind: "upload"; localPaths: string[]; remoteDir: string }
  | { kind: "download"; remotePath: string; localPath: string };

/** The `host:` prefix of a remote operand (an IPv6 literal bracketed, as scp requires). */
function remotePrefix(target: SshTarget): string {
  if ("alias" in target) return `${target.alias}:`;
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${target.user ? `${target.user}@` : ""}${host}:`;
}

/** A remote path as scp's SFTP mode takes it: `~` means the home directory, `~/x` is `x`. */
export function remoteOperandPath(path: string): string {
  if (path === "~" || path === "~/") return "";
  if (path.startsWith("~/")) return path.slice(2);
  return path;
}

/** Escape the characters scp's remote glob would expand, so the path names one file. */
export function escapeRemoteGlob(path: string): string {
  return path.replace(/[*?[\]\\]/g, "\\$&");
}

/**
 * The argv (after `scp`) for a transfer over the shared connection. `-s` forces the SFTP
 * protocol, where the remote path is a path and not a shell word; an scp older than OpenSSH
 * 9.0 rejects the flag, which is better than handing a user-supplied path to a remote shell.
 * `-r` so a folder transfers too (a file is unaffected). `--` ends the options.
 */
export function scpArgv(
  target: SshTarget,
  opts: SshConnectionOptions,
  transfer: ScpTransfer,
): string[] {
  assertTarget(target);
  const prefix = remotePrefix(target);
  const operands = transfer.kind === "upload"
    ? [
      ...transfer.localPaths.map(assertAbsolute),
      `${prefix}${remoteOperandPath(transfer.remoteDir)}`,
    ]
    : [
      `${prefix}${escapeRemoteGlob(remoteOperandPath(transfer.remotePath))}`,
      assertAbsolute(transfer.localPath),
    ];
  return [
    ...sharedArgs(opts, "no"),
    ...portArgs(target, "-P"),
    "-s",
    "-r",
    "--",
    ...operands,
  ];
}

function assertAbsolute(path: string): string {
  if (!path.startsWith("/")) throw new Error("local paths must be absolute");
  return path;
}

/** One update of scp's progress meter. */
export interface ScpProgress {
  /** The file being transferred (the meter truncates long names). */
  file: string;
  percent: number;
}

/**
 * The progress meter updates in a chunk of scp output. The meter (shown because the hidden PTY
 * is a tty) redraws a line as `name   42%  120MB  10.0MB/s   00:12 ETA`, `\r`-separated; the
 * last entry is the current state.
 */
export function parseScpProgress(text: string): ScpProgress[] {
  const out: ScpProgress[] = [];
  const re =
    /(?:^|[\r\n])([^\r\n]*?)\s+(\d{1,3})%\s+[\d.]+\s*[KMGTP]?B?\s+[\d.]+\s*[KMGTP]?B\/s\s+(?:[\d:-]+\s+ETA|[\d:]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ file: m[1].trim(), percent: Math.min(100, Number(m[2])) });
  }
  return out;
}

/**
 * The error scp or sftp reported, from its output: the last non-empty line that is not a
 * progress update or an echoed batch command, control sequences stripped.
 */
export function lastErrorLine(text: string): string {
  const lines = text
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) =>
      l !== "" && !/\d{1,3}%\s+[\d.]+/.test(l) && !l.startsWith("sftp>")
    );
  return lines.at(-1) ?? "";
}

// ---------------------------------------------------------------------------------------------
// sftp (directory listing)
// ---------------------------------------------------------------------------------------------

/** The argv (after `sftp`) for a batch run (`-b -`: commands on stdin) over the shared connection. */
export function sftpArgv(
  target: SshTarget,
  opts: SshConnectionOptions,
): string[] {
  assertTarget(target);
  const dest = "alias" in target
    ? target.alias
    : `${target.user ? `${target.user}@` : ""}${
      target.host.includes(":") ? `[${target.host}]` : target.host
    }`;
  return [
    ...sharedArgs(opts, "no"),
    ...portArgs(target, "-P"),
    "-b",
    "-",
    "--",
    dest,
  ];
}

/** Quote a path for an sftp command line (it splits on whitespace and honors `"` and `\`). */
export function sftpQuote(path: string): string {
  return `"${path.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The batch that lists `path`: change into it (so `pwd` reports the canonical absolute path),
 * print it, list it, leave. A failing `cd` aborts the batch, which is the "no such directory"
 * error. `~` is the remote home.
 */
export function sftpListBatch(path: string): string {
  const p = remoteOperandPath(path);
  return `${p ? `cd ${sftpQuote(p)}\n` : ""}pwd\nls -la\nbye\n`;
}

/** One entry of a remote directory. */
export interface SshDirEntry {
  name: string;
  kind: "dir" | "file" | "link" | "other";
  size: number;
  /** A symlink's target, when the listing shows one. */
  target?: string;
}

/** A listed remote directory. */
export interface SshListing {
  /** The canonical absolute path (`pwd` after `cd`). */
  path: string;
  entries: SshDirEntry[];
}

/**
 * `ls -la` as sftp prints it: a mode, link count (`?` when the server does not say), owner,
 * group, size, date (3 words) and the name.
 */
const LS_LINE =
  /^([-dlcbps])[-rwxsStT]{9}\s+\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$/;
const PWD_LINE = /^Remote working directory:\s+(.+)$/;

/**
 * Parse the batch's output. Both sftp's echo of each command (`sftp> ls -la`) and the PTY's
 * echo of what was typed are in the stream; only the `pwd` answer and the listing lines match.
 * Returns `undefined` when `pwd` never answered (the batch failed before it).
 */
export function parseSftpListing(text: string): SshListing | undefined {
  let path: string | undefined;
  const entries: SshDirEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r/g, "");
    const pwd = PWD_LINE.exec(line);
    if (pwd) {
      path = pwd[1].trim();
      continue;
    }
    const m = LS_LINE.exec(line);
    if (!m) continue;
    const type = m[1];
    let name = m[3];
    let target: string | undefined;
    if (type === "l") {
      const arrow = name.indexOf(" -> ");
      if (arrow > 0) {
        target = name.slice(arrow + 4);
        name = name.slice(0, arrow);
      }
    }
    if (name === "." || name === "..") continue;
    entries.push({
      name,
      kind: type === "d"
        ? "dir"
        : type === "-"
        ? "file"
        : type === "l"
        ? "link"
        : "other",
      size: Number(m[2]),
      ...(target !== undefined ? { target } : {}),
    });
  }
  return path === undefined ? undefined : { path, entries };
}

// ---------------------------------------------------------------------------------------------
// Download naming
// ---------------------------------------------------------------------------------------------

/** The last path component (`download` for the root or the home itself). */
export function remoteBaseName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, "");
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return base === "" || base === "~" ? "download" : base;
}

/**
 * `name`, or `name (1)`, `name (2)`... before the extension, the first that `exists` denies
 * (a download never overwrites what is in the folder already).
 */
export function uniqueName(
  name: string,
  exists: (candidate: string) => boolean,
): string {
  if (!exists(name)) return name;
  const dot = name.startsWith(".") ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1;; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

/** A recent connection, as the manager's "Recent" group lists it. */
export interface SshRecent {
  /** The alias, or `user@host:port`. */
  label: string;
  target: SshTarget;
  /** When it was last connected (epoch ms). */
  at: number;
}

/** How many recents are kept. */
const MAX_RECENTS = 20;

/** `recents` with `target` moved to the front (one entry per label), capped. */
export function pushRecent(
  recents: SshRecent[],
  target: SshTarget,
  at: number,
): SshRecent[] {
  const label = targetLabel(target);
  return [
    { label, target, at },
    ...recents.filter((r) => r.label !== label),
  ].slice(0, MAX_RECENTS);
}
