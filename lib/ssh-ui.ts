/**
 * The page-side rules for SSH tiles, kept pure so they are unit-testable without a DOM: what a
 * terminal runs (its profile), what happens when it ends, which OSC 7 reports are trusted, the
 * wording of the overlays, the per-tile transfer list and remote path arithmetic for the
 * download picker.
 *
 * @module
 */

import { parseOsc7 } from "./osc7.ts";
import type { SshTarget } from "./ssh-config.ts";
import type { SshDirEntry } from "./ssh-command.ts";
import type { SshTransferEvent } from "../desktop/ssh.ts";

// ---------------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------------

/** An SSH terminal: the system `ssh` to `target`, labelled and tinted like its host. */
export interface SshProfile {
  kind: "ssh";
  target: SshTarget;
  /** The host label (alias, or `user@host:port`): the tile's and the chip's title. */
  label: string;
  /** A tint id (see `TINT_IDS` in workspace/themes.ts). */
  tint?: string;
}

/** What a terminal runs: the login shell, or ssh to a host. */
export type TerminalProfile = { kind: "shell" } | SshProfile;

/** The profile every terminal had before SSH. */
export const SHELL_PROFILE: TerminalProfile = { kind: "shell" };

/** The profile's SSH half, or `undefined` for a shell. */
export function sshOf(profile: TerminalProfile): SshProfile | undefined {
  return profile.kind === "ssh" ? profile : undefined;
}

/**
 * Whether Enter on an exited terminal starts it again. A shell does (the long-standing
 * behaviour); an SSH tile does not: it shows the Disconnected overlay and waits for Reconnect,
 * so a stray Enter never reconnects to a production box.
 */
export function restartsOnEnter(profile: TerminalProfile): boolean {
  return profile.kind === "shell";
}

/** How a terminal ended. */
export interface ExitLike {
  exitCode: number | null;
  signal?: number | null;
}

/** `signal 9`, `code 255`: the short form the banner and the overlay show. */
export function exitReason(exit: ExitLike): string {
  if (exit.signal !== undefined && exit.signal !== null && exit.signal !== 0) {
    return `signal ${exit.signal}`;
  }
  return exit.exitCode === null ? "not started" : `code ${exit.exitCode}`;
}

/** The dim line written into the terminal when its process ends. */
export function exitBanner(profile: TerminalProfile, exit: ExitLike): string {
  const why = exitReason(exit);
  return profile.kind === "ssh"
    ? `[disconnected (${why})]`
    : `[process exited (${why}) — press Enter to restart or ⌘W to close]`;
}

/** The Disconnected overlay's explanation of why the session ended. */
export function disconnectMessage(
  exit: ExitLike & { message?: string },
): string {
  if (exit.message) return exit.message;
  if (exit.signal !== undefined && exit.signal !== null && exit.signal !== 0) {
    return `ssh was ended by signal ${exit.signal}.`;
  }
  if (exit.exitCode === 0) return "The session ended.";
  if (exit.exitCode === 255) {
    return "ssh could not connect, or the connection dropped.";
  }
  return `The remote side exited with code ${exit.exitCode}.`;
}

/**
 * The remote working directory an OSC 7 report gives, for an SSH tile only: a local shell's
 * report is about this machine and says nothing about where an upload should land. The URL's
 * host is the remote machine's own name, which need not match the alias or the HostName we
 * connected to, so it is not compared.
 */
export function trustedRemoteCwd(
  profile: TerminalProfile,
  payload: string,
): string | undefined {
  if (profile.kind !== "ssh") return undefined;
  return parseOsc7(payload)?.path;
}

// ---------------------------------------------------------------------------------------------
// Overlay wording
// ---------------------------------------------------------------------------------------------

/** `1 item`, `3 items`. */
export function itemCount(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

/** The last path component, for showing a dropped or remote path compactly. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

// ---------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------

/** One transfer as a tile shows it. */
export interface TransferView {
  transferId: string;
  /** The tile it belongs to (unknown until the start call resolves: events can come first). */
  terminalId?: string;
  kind: "upload" | "download";
  file?: string;
  percent: number;
  filesDone: number;
  fileCount?: number;
  done: boolean;
  error?: string;
  /** Downloads: where the file is saved. */
  localPath?: string;
  /** Uploads: the remote folder. */
  remoteDir?: string;
}

/** What a started transfer is bound to. */
export interface TransferBinding {
  terminalId: string;
  kind: "upload" | "download";
  localPath?: string;
  remoteDir?: string;
  fileCount?: number;
}

/** Fold one `transfer` event into the list (a new id is added, unbound). */
export function applyTransferEvent(
  list: readonly TransferView[],
  ev: SshTransferEvent,
): TransferView[] {
  const patch = {
    kind: ev.kind,
    percent: ev.percent,
    filesDone: ev.filesDone,
    done: ev.done,
    ...(ev.file !== undefined ? { file: ev.file } : {}),
    ...(ev.fileCount !== undefined ? { fileCount: ev.fileCount } : {}),
    ...(ev.error !== undefined ? { error: ev.error } : {}),
  };
  const i = list.findIndex((t) => t.transferId === ev.transferId);
  if (i < 0) return [...list, { transferId: ev.transferId, ...patch }];
  return list.map((t, j) => (j === i ? { ...t, ...patch } : t));
}

/**
 * Bind a started transfer to its tile. Progress that arrived before the start call resolved is
 * kept; the binding fills in what only the caller knows.
 */
export function bindTransfer(
  list: readonly TransferView[],
  transferId: string,
  binding: TransferBinding,
): TransferView[] {
  const i = list.findIndex((t) => t.transferId === transferId);
  if (i < 0) {
    return [...list, {
      transferId,
      percent: 0,
      filesDone: 0,
      done: false,
      ...binding,
    }];
  }
  return list.map((t, j) =>
    j === i
      ? { ...binding, ...t, terminalId: binding.terminalId, kind: binding.kind }
      : t
  );
}

/** Drop a finished transfer from the list (the user dismissed it). */
export function dismissTransfer(
  list: readonly TransferView[],
  transferId: string,
): TransferView[] {
  return list.filter((t) => t.transferId !== transferId);
}

/** The state a transfer row is drawn in. */
export type TransferState = "running" | "done" | "cancelled" | "failed";

export function transferState(t: TransferView): TransferState {
  if (!t.done) return "running";
  if (t.error === "cancelled") return "cancelled";
  return t.error ? "failed" : "done";
}

/** The row's main text: what is moving, how far along, or how it ended. */
export function transferText(t: TransferView): string {
  const verb = t.kind === "upload" ? "Upload" : "Download";
  switch (transferState(t)) {
    case "cancelled":
      return `${verb} cancelled`;
    case "failed":
      return `${verb} failed: ${t.error}`;
    case "done":
      return t.kind === "download"
        ? `Saved to ${t.localPath ?? "Downloads"}`
        : `Uploaded ${itemCount(t.fileCount ?? t.filesDone)}${
          t.remoteDir ? ` to ${t.remoteDir}` : ""
        }`;
    case "running":
      return t.file === undefined
        ? `Starting ${t.kind}…`
        : `${t.kind === "upload" ? "Uploading" : "Downloading"} ${t.file}`;
  }
}

/** `2/3` for a multi-file upload, `""` otherwise. */
export function transferCount(t: TransferView): string {
  if (t.fileCount === undefined || t.fileCount < 2) return "";
  return `${
    Math.min(t.filesDone + (t.done ? 0 : 1), t.fileCount)
  }/${t.fileCount}`;
}

// ---------------------------------------------------------------------------------------------
// Remote paths (the download picker)
// ---------------------------------------------------------------------------------------------

/** `dir` + `name` for an absolute remote `dir`. */
export function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** The parent of an absolute remote path (`/` stays `/`). */
export function parentRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** Folders first, then by name (case-insensitive), dotfiles after the rest. */
export function sortEntries(entries: readonly SshDirEntry[]): SshDirEntry[] {
  const rank = (e: SshDirEntry) =>
    (e.kind === "dir" ? 0 : 2) + (e.name.startsWith(".") ? 1 : 0);
  return [...entries].sort((a, b) =>
    rank(a) - rank(b) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/** `1.4 KB`, `50 MB`: a compact size for the picker's rows. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}
