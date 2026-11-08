// The SSH backend: a second desktop extension (`ssh`), next to `pty`. It owns what is not a
// terminal: the host list (OpenSSH config + ~/.ssh/qutty.conf), the recents, the ssh argv a tile
// is spawned with, and the scp/sftp transfers that ride the shared connection. The page reaches
// it through `lib/pty-client.ts` (`desktopExtension("ssh")` + `onDesktopEvent("ssh", "transfer")`).
// Port forwards are added to and removed from a tile's live connection with `ssh -O forward` /
// `-O cancel` on its control socket, in a hidden PTY like the transfers (lib/ssh-forward.ts).
//
// Nothing here speaks SSH: the system `ssh`, `scp` and `sftp` do, and every prompt (password,
// 2FA, host key) appears in the tile, where the user answers it.
//
// How scp/sftp run, and why not `Deno.Command`
// --------------------------------------------
// The packaged app bakes its permissions at build time and has no `--allow-run` (see
// denext.config.ts): desktop/pty.ts starts shells through node-pty's native fork and does its I/O
// through libc FFI for that reason. Transfers take the same path: scp/sftp run in a hidden PTY of
// their own (a `PtyHost` this module owns, never shown in a tile) and their output is parsed here.
// That costs nothing we would not want anyway: scp draws its progress meter only when stdout is a
// tty, so the hidden PTY is what makes progress reporting possible, and the exit code arrives
// through the same exit callback a shell's does. The transfers pass `BatchMode=yes`, so a lost
// master connection makes them fail at once instead of prompting into a PTY nobody sees.
//
// Files are written through the libc helpers pty.ts exports (no `--allow-write` either): only
// ~/.ssh/qutty.conf, the recents file in the app-support folder, and the single `Include` line
// (plus a backup) in the user's ~/.ssh/config. See lib/ssh-config.ts for the rules.

import { defineDesktopExtension, DesktopCapError } from "denext/desktop";
import { expandGlob } from "@std/fs";
import {
  emptyInput,
  type Issue,
  objectSchema,
  optBool,
  optInt,
  optStr,
  optStrList,
  str,
  strList,
} from "./schema.ts";
import {
  ensureDir,
  type PtyDataEvent,
  type PtyExitEvent,
  PtyHost,
  writeFileAtomic,
} from "./pty.ts";
import {
  deleteHost,
  ensureInclude,
  isSafeAlias,
  isSafeConfigValue,
  isSafeHost,
  isSafeProxyJump,
  isSafeUser,
  loadSshHosts,
  quttyConfPath,
  setHostForwards,
  type SshHost,
  type SshHostInput,
  type SshTarget,
  targetLabel,
  targetProblem,
  upsertHost,
  userConfigPath,
} from "../lib/ssh-config.ts";
import {
  addForward,
  favoriteText,
  forwardProblem,
  removeForward,
  type SshForward,
} from "../lib/ssh-forward.ts";
import {
  controlArgv,
  type ControlOp,
  controlPathFor,
  lastErrorLine,
  masterRunning,
  parseScpProgress,
  parseSftpListing,
  pushRecent,
  remoteBaseName,
  scpArgv,
  sftpArgv,
  sftpListBatch,
  sshArgv,
  type SshConnectionOptions,
  type SshListing,
  type SshRecent,
  uniqueName,
} from "../lib/ssh-command.ts";

// ---------------------------------------------------------------------------------------------
// Public shapes (the page sees these through the typed client)
// ---------------------------------------------------------------------------------------------

/** `sshHosts` result. */
export interface SshHostsResult {
  hosts: SshHost[];
  recents: SshRecent[];
}

/** `sshCommand` result: what to pass to `pty.spawn` as `program` + `args`. */
export interface SshCommand {
  program: string;
  args: string[];
  /** The alias, or `user@host:port`: the tile's label. */
  label: string;
  /** The saved host, when the target is an alias Qutty knows. */
  host?: SshHost;
}

/** `sshUpload` arguments. */
export interface SshUploadArgs {
  target: SshTarget;
  /** Absolute local paths (files or folders). */
  localPaths: string[];
  /** The remote folder (`~` is the home). */
  remoteDir: string;
}

/** `sshDownload` arguments. */
export interface SshDownloadArgs {
  target: SshTarget;
  /** The remote file or folder. */
  remotePath: string;
  /** Where to save it (default `~/Downloads`). Never overwrites: `name (1)` and so on. */
  localDir?: string;
}

/** `sshList` arguments. */
export interface SshListArgs {
  target: SshTarget;
  /** The remote folder (default `~`). */
  path?: string;
}

/** `sshForwardAdd` / `sshForwardCancel` arguments. */
export interface SshForwardArgs {
  target: SshTarget;
  forward: SshForward;
}

/** `sshSaveForwards` arguments: a Qutty host's favourite forwards (replacing the old ones). */
export interface SshSaveForwardsArgs {
  alias: string;
  forwards: SshForward[];
}

/**
 * A connection's forwards: whether its master is up (`ssh -O check`), and the forwards added on
 * it from the panel. ssh cannot list forwards, so those are what Qutty added and ssh accepted.
 */
export interface SshForwardStatus {
  master: boolean;
  active: SshForward[];
}

/** A started transfer. */
export interface SshTransferStarted {
  transferId: string;
  /** Downloads: where the file will land. */
  localPath?: string;
}

/**
 * The `transfer` event: progress, then completion. `seq` increases by 1 per event per transfer
 * (the desktop event stream is at-least-once; the client drops repeats).
 */
export interface SshTransferEvent {
  transferId: string;
  seq: number;
  kind: "upload" | "download";
  /** The file in flight (as scp's meter shows it, truncated when long). */
  file?: string;
  /** Percent of the current file. */
  percent: number;
  /** Files finished so far. */
  filesDone: number;
  /** How many files there are (uploads only: counted locally). */
  fileCount?: number;
  done: boolean;
  /** Set with `done` when the transfer failed; `"cancelled"` after `sshCancel`. */
  error?: string;
}

// ---------------------------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------------------------

const MAX_PATH = 4096;
const MAX_UPLOAD_PATHS = 256;
const TINT = /^[a-z][a-z0-9-]{0,31}$/;
const TAG = /^[A-Za-z0-9._-]{1,32}$/;

/** A string that may go into qutty.conf (or an scp operand): no newline, NUL or `"`. */
function configValue(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
): string | undefined {
  const s = optStr(v, key, issues, MAX_PATH);
  if (s !== undefined && !isSafeConfigValue(s)) {
    issues.push({
      message: `${key} holds a character ssh config cannot`,
      path: [key],
    });
    return undefined;
  }
  return s;
}

function checked(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
  ok: (s: string) => boolean,
  what: string,
): string | undefined {
  const s = optStr(v, key, issues, MAX_PATH);
  if (s !== undefined && !ok(s)) {
    issues.push({ message: `${key} must be ${what}`, path: [key] });
    return undefined;
  }
  return s;
}

const SAFE_ALIAS_WHAT =
  "letters, digits, `.`, `_` or `-`, not starting with `-`";

function alias(
  v: Record<string, unknown>,
  key: string,
  issues: Issue[],
): string {
  const s = str(v, key, issues, 255);
  if (s && !isSafeAlias(s)) {
    issues.push({ message: `${key} must be ${SAFE_ALIAS_WHAT}`, path: [key] });
  }
  return s;
}

/** `v.target`: `{ alias }` or `{ host, user?, port? }`. */
function target(v: Record<string, unknown>, issues: Issue[]): SshTarget {
  const t = v.target;
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    issues.push({ message: "target must be an object", path: ["target"] });
    return { alias: "" };
  }
  const o = t as Record<string, unknown>;
  if (typeof o.alias === "string") return { alias: alias(o, "alias", issues) };
  if (o.host === undefined) {
    issues.push({
      message: "target needs an alias or a host",
      path: ["target"],
    });
  }
  return {
    host: checked(o, "host", issues, isSafeHost, "a host name or address") ??
      "",
    user: checked(o, "user", issues, isSafeUser, "a user name"),
    port: optInt(o, "port", issues, 1, 65535),
  };
}

/** An absolute local path. */
function absolutePath(
  s: string,
  key: string,
  i: number | undefined,
  issues: Issue[],
) {
  if (s && !s.startsWith("/")) {
    issues.push({
      message: `${key} must be absolute`,
      path: i === undefined ? [key] : [key, i],
    });
  }
}

const hostInput = objectSchema<SshHostInput>((v, issues) => {
  const tags = optStrList(v, "tags", issues, 16, 32);
  if (tags?.some((t) => !TAG.test(t))) {
    issues.push({ message: "tags must be short words", path: ["tags"] });
  }
  const previousAlias = v.previousAlias === undefined
    ? undefined
    : alias(v, "previousAlias", issues);
  return {
    alias: alias(v, "alias", issues),
    previousAlias,
    hostName: checked(
      v,
      "hostName",
      issues,
      (s) => isSafeConfigValue(s) && !/\s/.test(s) && !s.startsWith("-"),
      "a host name",
    ),
    user: checked(v, "user", issues, isSafeUser, "a user name"),
    port: optInt(v, "port", issues, 1, 65535),
    identityFile: configValue(v, "identityFile", issues),
    proxyJump: checked(v, "proxyJump", issues, isSafeProxyJump, "a jump host"),
    tint: checked(v, "tint", issues, (s) => TINT.test(s), "a color id"),
    tags,
    favorite: optBool(v, "favorite", issues),
    tmux: optBool(v, "tmux", issues),
    remoteCommand: optStr(v, "remoteCommand", issues, MAX_PATH),
  };
});

const aliasInput = objectSchema<{ alias: string }>((v, issues) => ({
  alias: alias(v, "alias", issues),
}));

const targetInput = objectSchema<{ target: SshTarget }>((v, issues) => ({
  target: target(v, issues),
}));

const uploadInput = objectSchema<SshUploadArgs>((v, issues) => {
  const localPaths = strList(
    v,
    "localPaths",
    issues,
    MAX_UPLOAD_PATHS,
    MAX_PATH,
  );
  localPaths.forEach((p, i) => absolutePath(p, "localPaths", i, issues));
  if (
    localPaths.length === 0 && !issues.some((i) => i.path?.[0] === "localPaths")
  ) {
    issues.push({
      message: "localPaths must not be empty",
      path: ["localPaths"],
    });
  }
  return {
    target: target(v, issues),
    localPaths,
    remoteDir: configValue(v, "remoteDir", issues) ?? "~",
  };
});

const downloadInput = objectSchema<SshDownloadArgs>((v, issues) => {
  const localDir = configValue(v, "localDir", issues);
  if (localDir !== undefined) {
    absolutePath(localDir, "localDir", undefined, issues);
  }
  return {
    target: target(v, issues),
    remotePath: str(v, "remotePath", issues, MAX_PATH),
    localDir,
  };
});

const listInput = objectSchema<SshListArgs>((v, issues) => ({
  target: target(v, issues),
  path: configValue(v, "path", issues),
}));

const MAX_FAVORITE_FORWARDS = 32;

/** `v[key]`: a forward, every field checked (lib/ssh-forward.ts `forwardProblem`). */
function forwardAt(
  value: unknown,
  path: (string | number)[],
  issues: Issue[],
): SshForward {
  const problem = forwardProblem(value);
  if (problem) {
    issues.push({ message: `forward: ${problem}`, path });
    return { kind: "dynamic", port: 1 };
  }
  const f = value as SshForward;
  return f.kind === "dynamic"
    ? { kind: f.kind, ...(f.bind ? { bind: f.bind } : {}), port: f.port }
    : {
      kind: f.kind,
      ...(f.bind ? { bind: f.bind } : {}),
      port: f.port,
      host: f.host,
      hostPort: f.hostPort,
    };
}

const forwardInput = objectSchema<SshForwardArgs>((v, issues) => ({
  target: target(v, issues),
  forward: forwardAt(v.forward, ["forward"], issues),
}));

const saveForwardsInput = objectSchema<SshSaveForwardsArgs>((v, issues) => {
  const list = Array.isArray(v.forwards) ? v.forwards : undefined;
  if (!list || list.length > MAX_FAVORITE_FORWARDS) {
    issues.push({
      message: `forwards must be a list of at most ${MAX_FAVORITE_FORWARDS}`,
      path: ["forwards"],
    });
  }
  return {
    alias: alias(v, "alias", issues),
    forwards: (list ?? []).slice(0, MAX_FAVORITE_FORWARDS).map((f, i) =>
      forwardAt(f, ["forwards", i], issues)
    ),
  };
});

const transferIdInput = objectSchema<{ transferId: string }>((v, issues) => ({
  transferId: str(v, "transferId", issues, 64),
}));

// ---------------------------------------------------------------------------------------------
// The service (exported for tests; the extension below wraps one)
// ---------------------------------------------------------------------------------------------

/** How the service reports events (the extension passes `ctx.emit`). */
export type SshEmit = (event: "transfer", data: SshTransferEvent) => void;

/** Options for {@linkcode SshService}. */
export interface SshServiceOptions {
  /** The home whose `~/.ssh` is read and written (tests use a temporary one). */
  home: string;
  /** Where the recents live and where pty.ts may copy spawn-helper. */
  appSupportDir?: string;
  /** An ssh config to use instead of `~/.ssh/config` (`-F`; ssh never reads `$HOME`'s). */
  configFile?: string;
  /** Overrides the ControlPath (tests keep it short). */
  controlPath?: string;
  emit: SshEmit;
}

interface Transfer {
  id: string;
  ptyId: string;
  kind: "upload" | "download";
  owner: string;
  seq: number;
  /** Output since the last line break (a meter update can straddle two chunks). */
  tail: string;
  /** All output (bounded), for the error message. */
  text: string;
  file?: string;
  percent: number;
  filesDone: number;
  fileCount?: number;
  cancelled: boolean;
}

/** A hidden-PTY run whose whole output is wanted at its exit (an sftp listing, an `ssh -O`). */
interface Capture {
  ptyId: string;
  text: string;
  max: number;
  resolve: (result: { exitCode: number | null; text: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Output kept per transfer for the error message (the meter repeats a lot). */
const MAX_TRANSFER_TEXT = 32 * 1024;
/** Output kept for a listing (a big folder). */
const MAX_LISTING_TEXT = 8 * 1024 * 1024;
const LIST_TIMEOUT_MS = 45_000;
/** An `ssh -O` answers at once from the local socket (a forward is set up by the master). */
const CONTROL_TIMEOUT_MS = 20_000;
const MAX_CONTROL_TEXT = 16 * 1024;
/** How many files an upload's folder walk counts before giving up on a total. */
const MAX_COUNTED_FILES = 5000;
const RECENTS_FILE = "ssh-recents.json";

const notFound = (what: string) =>
  new DesktopCapError("not_found", `no such ${what}`, { status: 404 });

/** Host list, config edits, recents, argv and transfers for one home. */
export class SshService {
  readonly #home: string;
  readonly #appSupportDir?: string;
  readonly #conn: SshConnectionOptions;
  #emit: SshEmit;
  readonly #pty: PtyHost;
  readonly #transfers = new Map<string, Transfer>();
  readonly #byPty = new Map<string, Transfer | Capture>();
  /** The forwards added through the panel, per connection (`targetLabel`), while its master lives. */
  readonly #forwards = new Map<string, SshForward[]>();
  #nextId = 0;

  constructor(opts: SshServiceOptions) {
    this.#home = opts.home;
    this.#appSupportDir = opts.appSupportDir;
    this.#conn = {
      controlPath: opts.controlPath ?? controlPathFor(opts.home),
      configFile: opts.configFile,
    };
    this.#emit = opts.emit;
    this.#pty = new PtyHost((event, data) => this.#onPty(event, data));
  }

  /** Replace the event sink (the extension re-binds to the latest handler's `ctx.emit`). */
  setEmit(emit: SshEmit): void {
    this.#emit = emit;
  }

  /** How many transfers and listings are running. */
  get size(): number {
    return this.#byPty.size;
  }

  // --- hosts ---------------------------------------------------------------------------------

  async hosts(): Promise<SshHostsResult> {
    const hosts = await loadSshHosts(this.#home, {
      readText: readTextOrUndefined,
      glob: async (pattern) => {
        const files: string[] = [];
        try {
          for await (const e of expandGlob(pattern, { includeDirs: false })) {
            files.push(e.path);
          }
        } catch { /* an unreadable folder: nothing matched */ }
        return files.sort();
      },
    });
    return { hosts, recents: await this.#recents() };
  }

  async saveHost(input: SshHostInput): Promise<SshHost> {
    this.#ensureSshDir();
    const path = quttyConfPath(this.#home);
    const text = await readTextOrUndefined(path) ?? "";
    write(path, encode(upsertHost(text, input)), 0o600);
    await this.#ensureInclude();
    const saved = await this.#findHost(input.alias, true);
    if (!saved) throw new DesktopCapError("internal", "the host was not saved");
    return saved;
  }

  async deleteHost(alias: string): Promise<void> {
    const path = quttyConfPath(this.#home);
    const text = await readTextOrUndefined(path);
    if (text === undefined) throw notFound("host");
    const next = deleteHost(text, alias);
    if (next === text) throw notFound("host");
    write(path, encode(next), 0o600);
  }

  /**
   * The one edit ever made to the user's own config: `Include ~/.ssh/qutty.conf` at the top,
   * once, after copying the original to `config.qutty-backup` (an existing backup is kept).
   * Mode is preserved; a symlinked config is rewritten through its target, so the link stays.
   */
  async #ensureInclude(): Promise<void> {
    const path = userConfigPath(this.#home);
    const original = await readTextOrUndefined(path);
    const { text, changed } = ensureInclude(original ?? "", this.#home);
    if (!changed) return;
    let mode = 0o600;
    let writeTo = path;
    if (original !== undefined) {
      const st = await Deno.stat(path);
      mode = (st.mode ?? 0o600) & 0o777;
      writeTo = await Deno.realPath(path);
      const backup = `${path}.qutty-backup`;
      if (await readTextOrUndefined(backup) === undefined) {
        write(backup, encode(original), mode);
      }
    }
    write(writeTo, encode(text), mode);
  }

  #ensureSshDir(): void {
    ensureDir(`${this.#home}/.ssh`, 0o700);
  }

  /** The saved host for `alias` (qutty.conf first: with the Include at the top, ssh reads it first). */
  async #findHost(
    alias: string,
    editableOnly = false,
  ): Promise<SshHost | undefined> {
    const { hosts } = await this.hosts();
    const matches = hosts.filter((h) => h.aliases.includes(alias));
    return matches.find((h) => h.editable) ??
      (editableOnly ? undefined : matches[0]);
  }

  // --- recents -------------------------------------------------------------------------------

  async #recents(): Promise<SshRecent[]> {
    if (!this.#appSupportDir) return [];
    const text = await readTextOrUndefined(
      `${this.#appSupportDir}/${RECENTS_FILE}`,
    );
    if (text === undefined) return [];
    try {
      const raw = JSON.parse(text);
      if (!Array.isArray(raw)) return [];
      return raw.filter((r): r is SshRecent =>
        typeof r === "object" && r !== null && typeof r.label === "string" &&
        typeof r.at === "number" && typeof r.target === "object" &&
        r.target !== null && targetProblem(r.target) === undefined
      );
    } catch {
      return [];
    }
  }

  async #recordRecent(target: SshTarget): Promise<void> {
    if (!this.#appSupportDir) return;
    const next = pushRecent(await this.#recents(), target, Date.now());
    ensureDir(this.#appSupportDir, 0o755);
    write(
      `${this.#appSupportDir}/${RECENTS_FILE}`,
      encode(JSON.stringify(next)),
      0o600,
    );
  }

  // --- connecting ----------------------------------------------------------------------------

  /** The ssh argv for a tile; records the connection as recent. */
  async command(target: SshTarget): Promise<SshCommand> {
    const problem = targetProblem(target);
    if (problem) throw new DesktopCapError("validation", problem);
    const host = "alias" in target
      ? await this.#findHost(target.alias)
      : undefined;
    // The ControlPath socket lives in ~/.ssh; ssh only warns and goes on without multiplexing
    // when the folder is missing, which would make every tile authenticate again.
    this.#ensureSshDir();
    const args = sshArgv(target, this.#conn, host ?? {});
    await this.#recordRecent(target);
    return {
      program: "ssh",
      args,
      label: targetLabel(target),
      ...(host ? { host } : {}),
    };
  }

  // --- transfers -----------------------------------------------------------------------------

  async upload(
    req: SshUploadArgs,
    owner = "main",
  ): Promise<SshTransferStarted> {
    let fileCount: number | undefined = 0;
    for (const p of req.localPaths) {
      const n = await countFiles(p, MAX_COUNTED_FILES - (fileCount ?? 0));
      if (n === undefined) throw notFound("local file");
      fileCount = fileCount === undefined || n === null
        ? undefined
        : fileCount + n;
    }
    const args = scpArgv(req.target, this.#conn, {
      kind: "upload",
      localPaths: req.localPaths,
      remoteDir: req.remoteDir,
    });
    const transferId = await this.#startTransfer(
      "upload",
      args,
      owner,
      fileCount,
    );
    return { transferId };
  }

  async download(
    req: SshDownloadArgs,
    owner = "main",
  ): Promise<SshTransferStarted> {
    const dir = req.localDir ?? `${this.#home}/Downloads`;
    try {
      if (!(await Deno.stat(dir)).isDirectory) throw new Error();
    } catch {
      throw notFound("download folder");
    }
    const name = uniqueName(remoteBaseName(req.remotePath), (candidate) => {
      try {
        Deno.lstatSync(`${dir}/${candidate}`);
        return true;
      } catch {
        return false;
      }
    });
    const localPath = `${dir}/${name}`;
    const args = scpArgv(req.target, this.#conn, {
      kind: "download",
      remotePath: req.remotePath,
      localPath,
    });
    const transferId = await this.#startTransfer("download", args, owner);
    return { transferId, localPath };
  }

  async #startTransfer(
    kind: Transfer["kind"],
    args: string[],
    owner: string,
    fileCount?: number,
  ): Promise<string> {
    const id = `transfer-${++this.#nextId}`;
    const spawned = await this.#spawn("scp", args, owner);
    const t: Transfer = {
      id,
      ptyId: spawned.id,
      kind,
      owner,
      seq: 0,
      tail: "",
      text: "",
      percent: 0,
      filesDone: 0,
      fileCount,
      cancelled: false,
    };
    this.#transfers.set(id, t);
    this.#byPty.set(spawned.id, t);
    return id;
  }

  cancel(transferId: string): void {
    const t = this.#transfers.get(transferId);
    if (!t) return;
    t.cancelled = true;
    this.#pty.kill(t.ptyId);
  }

  /** List a remote folder through `sftp -b -` on the shared connection. */
  async list(req: SshListArgs, owner = "main"): Promise<SshListing> {
    const args = sftpArgv(req.target, this.#conn);
    const r = await this.#capture("sftp", args, owner, {
      timeoutMs: LIST_TIMEOUT_MS,
      max: MAX_LISTING_TEXT,
      what: "the listing",
      stdin: sftpListBatch(req.path ?? "~"),
    });
    const listing = parseSftpListing(r.text);
    if (r.exitCode === 0 && listing) return listing;
    throw new DesktopCapError(
      "ssh_failed",
      lastErrorLine(r.text) || "sftp failed",
    );
  }

  /**
   * Run `program` in a hidden PTY and answer its exit code and output (bounded to `max`, the
   * end kept). `stdin` is typed into it once it runs. Killed, and rejected, after `timeoutMs`.
   */
  async #capture(
    program: string,
    args: string[],
    owner: string,
    o: { timeoutMs: number; max: number; what: string; stdin?: string },
  ): Promise<{ exitCode: number | null; text: string }> {
    const spawned = await this.#spawn(program, args, owner);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#byPty.delete(spawned.id);
        this.#pty.kill(spawned.id);
        reject(new DesktopCapError("timeout", `${o.what} took too long`));
      }, o.timeoutMs);
      this.#byPty.set(spawned.id, {
        ptyId: spawned.id,
        text: "",
        max: o.max,
        resolve,
        timer,
      });
      if (o.stdin !== undefined) {
        this.#pty.write(spawned.id, o.stdin).catch(() => {});
      }
    });
  }

  // --- port forwards (ssh -O on the control socket) ------------------------------------------

  /** Send a control command to `target`'s master; its exit code and output. */
  #control(target: SshTarget, cmd: ControlOp, owner: string) {
    return this.#capture("ssh", controlArgv(target, this.#conn, cmd), owner, {
      timeoutMs: CONTROL_TIMEOUT_MS,
      max: MAX_CONTROL_TEXT,
      what: "ssh -O",
    });
  }

  /**
   * Whether `target`'s shared connection is up, and the forwards added on it from the panel.
   * When the master is gone, so are its forwards: the list is cleared.
   */
  async forwards(target: SshTarget, owner = "main"): Promise<SshForwardStatus> {
    const key = targetLabel(target);
    const r = await this.#control(target, { op: "check" }, owner);
    const master = masterRunning(r.exitCode, r.text);
    if (!master) this.#forwards.delete(key);
    return { master, active: [...(this.#forwards.get(key) ?? [])] };
  }

  /** Add a forward to the running master (`ssh -O forward`); ssh's error when it refuses. */
  async addForward(
    req: SshForwardArgs,
    owner = "main",
  ): Promise<SshForwardStatus> {
    const key = targetLabel(req.target);
    const r = await this.#control(
      req.target,
      { op: "forward", forward: req.forward },
      owner,
    );
    if (r.exitCode !== 0) {
      throw new DesktopCapError(
        "ssh_failed",
        lastErrorLine(r.text) || `ssh exited with status ${r.exitCode}`,
      );
    }
    this.#forwards.set(
      key,
      addForward(this.#forwards.get(key) ?? [], req.forward),
    );
    return { master: true, active: [...this.#forwards.get(key)!] };
  }

  /** Stop a forward (`ssh -O cancel`). One ssh no longer knows is dropped from the list too. */
  async cancelForward(
    req: SshForwardArgs,
    owner = "main",
  ): Promise<SshForwardStatus> {
    const key = targetLabel(req.target);
    const r = await this.#control(
      req.target,
      { op: "cancel", forward: req.forward },
      owner,
    );
    const left = removeForward(this.#forwards.get(key) ?? [], req.forward);
    this.#forwards.set(key, left);
    if (r.exitCode !== 0) {
      const status = await this.forwards(req.target, owner);
      if (status.master) {
        throw new DesktopCapError(
          "ssh_failed",
          lastErrorLine(r.text) || `ssh exited with status ${r.exitCode}`,
        );
      }
      return status;
    }
    return { master: true, active: left };
  }

  /** Save a Qutty host's favourite forwards in its `# qutty:` metadata (qutty.conf only). */
  async saveForwards(req: SshSaveForwardsArgs): Promise<SshHost> {
    const path = quttyConfPath(this.#home);
    const text = await readTextOrUndefined(path);
    if (text === undefined) throw notFound("Qutty host");
    const next = setHostForwards(
      text,
      req.alias,
      req.forwards.map(favoriteText),
    );
    if (next === text && !(await this.#findHost(req.alias, true))) {
      throw notFound("Qutty host");
    }
    if (next !== text) write(path, encode(next), 0o600);
    const saved = await this.#findHost(req.alias, true);
    if (!saved) throw notFound("Qutty host");
    return saved;
  }

  async #spawn(program: string, args: string[], owner: string) {
    try {
      return await this.#pty.spawn(
        { cols: 160, rows: 24, program, args, cwd: this.#home },
        { appSupportDir: this.#appSupportDir, owner },
      );
    } catch (err) {
      if (err instanceof DesktopCapError) throw err;
      throw new DesktopCapError("spawn_failed", `could not start ${program}`);
    }
  }

  #onPty(event: "data" | "exit", data: PtyDataEvent | PtyExitEvent): void {
    const target = this.#byPty.get(data.id);
    if (!target) return;
    if ("resolve" in target) {
      if (event === "data") {
        target.text = (target.text + (data as PtyDataEvent).data).slice(
          -target.max,
        );
        return;
      }
      this.#byPty.delete(data.id);
      clearTimeout(target.timer);
      target.resolve({
        exitCode: (data as PtyExitEvent).exitCode,
        text: target.text,
      });
      return;
    }
    if (event === "data") {
      this.#onTransferData(target, (data as PtyDataEvent).data);
    } else this.#onTransferExit(target, data as PtyExitEvent);
  }

  #onTransferData(t: Transfer, chunk: string): void {
    t.text = (t.text + chunk).slice(-MAX_TRANSFER_TEXT);
    const text = t.tail + chunk;
    const cut = Math.max(text.lastIndexOf("\r"), text.lastIndexOf("\n"));
    t.tail = cut < 0 ? text : text.slice(cut + 1);
    let changed = false;
    for (const p of parseScpProgress(text.slice(0, cut < 0 ? 0 : cut + 1))) {
      if (p.percent === 100 && (t.file !== p.file || t.percent < 100)) {
        t.filesDone++;
      }
      if (p.file !== t.file || p.percent !== t.percent) changed = true;
      t.file = p.file;
      t.percent = p.percent;
    }
    if (changed) this.#emitTransfer(t, false);
  }

  #onTransferExit(t: Transfer, exit: PtyExitEvent): void {
    this.#byPty.delete(t.ptyId);
    this.#transfers.delete(t.id);
    let error: string | undefined;
    if (t.cancelled) error = "cancelled";
    else if (exit.exitCode !== 0) {
      error = lastErrorLine(t.text) ||
        `scp exited with status ${exit.exitCode}`;
    }
    this.#emitTransfer(t, true, error);
  }

  #emitTransfer(t: Transfer, done: boolean, error?: string): void {
    const event: SshTransferEvent = {
      transferId: t.id,
      seq: ++t.seq,
      kind: t.kind,
      ...(t.file !== undefined ? { file: t.file } : {}),
      percent: t.percent,
      filesDone: t.filesDone,
      ...(t.fileCount !== undefined ? { fileCount: t.fileCount } : {}),
      done,
      ...(error !== undefined ? { error } : {}),
    };
    try {
      this.#emit("transfer", event);
    } catch (err) {
      console.error("ssh: emit failed", err);
    }
  }

  /** Cancel the transfers a window owns (its page reloaded or navigated away). */
  killOwnedBy(owner: string): void {
    for (const t of this.#transfers.values()) {
      if (t.owner === owner) this.cancel(t.id);
    }
    this.#pty.killOwnedBy(owner);
  }

  /** Synchronous teardown for process exit. */
  killAllNow(): void {
    this.#pty.killAllNow();
  }

  /** Graceful teardown (tests): cancel everything and wait for the exits. */
  async dispose(timeoutMs = 5000): Promise<void> {
    for (const t of this.#transfers.values()) t.cancelled = true;
    await this.#pty.dispose(timeoutMs);
  }
}

const encode = (s: string) => new TextEncoder().encode(s);

/**
 * `writeFileAtomic` for the page's sake: a failure answers with a code and no path (an error
 * message crosses to the page, and the libc helper names the file it could not create).
 */
function write(path: string, bytes: Uint8Array, mode: number): void {
  try {
    writeFileAtomic(path, bytes, mode);
  } catch (err) {
    console.error("ssh: write failed", err);
    throw new DesktopCapError(
      "write_failed",
      `could not write ${
        path.endsWith(".json") ? "the recents" : "the ssh config"
      }`,
    );
  }
}

async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
}

/**
 * How many regular files `path` holds (itself, or everything under a folder), at most `budget`
 * before it answers `null` (unknown); `undefined` when `path` does not exist.
 */
async function countFiles(
  path: string,
  budget: number,
): Promise<number | null | undefined> {
  let st: Deno.FileInfo;
  try {
    st = await Deno.stat(path);
  } catch {
    return undefined;
  }
  if (!st.isDirectory) return 1;
  let n = 0;
  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory) stack.push(`${dir}/${e.name}`);
        else if (++n > budget) return null;
      }
    } catch { /* unreadable: scp will say so */ }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------------------------

let service: SshService | undefined;

function getService(ctx: { emit: SshEmit; appSupportDir: string }): SshService {
  if (!service) {
    service = new SshService({
      home: Deno.env.get("HOME") ?? "/",
      appSupportDir: ctx.appSupportDir || undefined,
      emit: ctx.emit,
    });
    globalThis.addEventListener("unload", () => service?.killAllNow());
  } else {
    service.setEmit(ctx.emit);
  }
  return service;
}

export default defineDesktopExtension({
  name: "ssh",
  events: ["transfer"],
  perWindow: true,
  onPageLoad: (windowId?: string) => {
    service?.killOwnedBy(windowId ?? "main");
  },
  methods: {
    sshHosts: {
      input: emptyInput,
      handler: (_args: unknown, ctx): Promise<SshHostsResult> =>
        getService(ctx).hosts(),
    },
    sshSaveHost: {
      input: hostInput,
      handler: (args: unknown, ctx): Promise<SshHost> =>
        getService(ctx).saveHost(args as SshHostInput),
    },
    sshDeleteHost: {
      input: aliasInput,
      handler: (args: unknown, ctx): Promise<void> =>
        getService(ctx).deleteHost((args as { alias: string }).alias),
    },
    sshCommand: {
      input: targetInput,
      handler: (args: unknown, ctx): Promise<SshCommand> =>
        getService(ctx).command((args as { target: SshTarget }).target),
    },
    sshUpload: {
      input: uploadInput,
      handler: (args: unknown, ctx): Promise<SshTransferStarted> =>
        getService(ctx).upload(args as SshUploadArgs, ctx.windowId ?? "main"),
    },
    sshDownload: {
      input: downloadInput,
      handler: (args: unknown, ctx): Promise<SshTransferStarted> =>
        getService(ctx).download(
          args as SshDownloadArgs,
          ctx.windowId ?? "main",
        ),
    },
    sshList: {
      input: listInput,
      timeoutMs: LIST_TIMEOUT_MS + 5_000,
      handler: (args: unknown, ctx): Promise<SshListing> =>
        getService(ctx).list(args as SshListArgs, ctx.windowId ?? "main"),
    },
    sshCancel: {
      input: transferIdInput,
      handler: (args: unknown, ctx): void => {
        getService(ctx).cancel((args as { transferId: string }).transferId);
      },
    },
    sshForwards: {
      input: targetInput,
      timeoutMs: CONTROL_TIMEOUT_MS + 5_000,
      handler: (args: unknown, ctx): Promise<SshForwardStatus> =>
        getService(ctx).forwards(
          (args as { target: SshTarget }).target,
          ctx.windowId ?? "main",
        ),
    },
    sshForwardAdd: {
      input: forwardInput,
      timeoutMs: CONTROL_TIMEOUT_MS + 5_000,
      handler: (args: unknown, ctx): Promise<SshForwardStatus> =>
        getService(ctx).addForward(
          args as SshForwardArgs,
          ctx.windowId ?? "main",
        ),
    },
    sshForwardCancel: {
      input: forwardInput,
      timeoutMs: 2 * CONTROL_TIMEOUT_MS + 5_000,
      handler: (args: unknown, ctx): Promise<SshForwardStatus> =>
        getService(ctx).cancelForward(
          args as SshForwardArgs,
          ctx.windowId ?? "main",
        ),
    },
    sshSaveForwards: {
      input: saveForwardsInput,
      handler: (args: unknown, ctx): Promise<SshHost> =>
        getService(ctx).saveForwards(args as SshSaveForwardsArgs),
    },
  },
});
