// Where Qutty's local channels live and how a connection to one is made: the agent hub's per-tile
// sockets (desktop/hub.ts, `QUTTY_SOCK`) and the PTY daemon's (desktop/ptyd.ts, `ptyd-<v>`).
//
// The paths come from Denext 4.22's `localIpcPath`: on macOS and Linux `<dir>/<name>.sock` in the
// user's private socket folder (`/tmp/qutty-<uid>`, desktop/hub-socket.ts `privateUserDir`, short
// enough for `sun_path`; a path too long is refused here rather than at `bind`), on Windows a named
// pipe `\\.\pipe\org.qutty.Qutty.<user hash>.<name>`. So `QUTTY_SOCK` stays a unix socket path on
// macOS and Linux, which the agent shims reach with `nc -U` / socat (lib/hub/scripts.ts).
//
// The transport: on macOS and Linux the sockets are still bound, accepted and read through libc
// (desktop/hub-socket.ts). Denext's `listenLocalIpc` / `connectLocalIpc` go through the runtime's
// `node:net`, which checks read and write access to the socket path and an `unix:<path>` network
// grant; the packaged app bakes no `--allow-write`, and a `unix:` grant must be an absolute path
// with no folder token (Denext 4.22), so a per-user folder cannot be granted at package time. FFI
// is already full trust and needs neither. On Windows, which has neither libc nor unix sockets for
// Qutty, a pipe path goes through `connectLocalIpc` ({@linkcode connectIpc}); the hub and the
// daemon are not served on Windows yet (TODO.md, the Windows port). Pure apart from the connect.

import {
  connectLocalIpc,
  type LocalIpcConnection,
  localIpcPath,
} from "denext/desktop";

/** `desktop.app.identifier`: a Windows pipe name's app part. */
export const QUTTY_APP_ID = "org.qutty.Qutty";

/** An OS in `localIpcPath`'s spelling (any other Unix takes Linux's shape). */
export type IpcOs = "darwin" | "linux" | "windows";

/** The running OS as {@linkcode IpcOs}. */
export function ipcOs(os: string = Deno.build.os): IpcOs {
  return os === "darwin" || os === "windows" ? os : "linux";
}

/** How a channel is reached on `os`: libc unix sockets, or Denext's local IPC (named pipes). */
export function ipcTransport(os: string = Deno.build.os): "libc" | "local-ipc" {
  return ipcOs(os) === "windows" ? "local-ipc" : "libc";
}

/** Options for {@linkcode ipcChannelPath}. */
export interface IpcChannelPathOptions {
  /** macOS / Linux: the private folder the socket goes in (required there; ignored on Windows). */
  dir?: string;
  /** The OS whose shape to compute (default: the running one). */
  os?: IpcOs;
  /** Windows: the per-user part of the pipe name (default: Denext's hash of the profile folder). */
  user?: string;
}

/**
 * Where channel `name` (1 to 64 of `[A-Za-z0-9._-]`, a letter or digit first: `pty-3`, `ptyd-2`)
 * lives: `<dir>/<name>.sock` on macOS / Linux, a named pipe on Windows (`localIpcPath`).
 *
 * @throws TypeError for a bad name, a Unix path without `dir`, or one longer than `sun_path`.
 */
export function ipcChannelPath(
  name: string,
  opts: IpcChannelPathOptions = {},
): string {
  const os = opts.os ?? ipcOs();
  if (os === "windows") {
    return localIpcPath(name, {
      os,
      appId: QUTTY_APP_ID,
      ...(opts.user !== undefined ? { user: opts.user } : {}),
    });
  }
  if (!opts.dir) {
    throw new TypeError(`ipc: the socket ${name} needs its private folder`);
  }
  return localIpcPath(name, { os, dir: opts.dir });
}

/** Whether `path` is a Windows named pipe (`\\.\pipe\…`). */
export function isPipePath(path: string): boolean {
  return /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(path);
}

/**
 * A byte connection as the hub's MCP transport (`StreamServerTransport.from`) and the daemon's
 * client (desktop/ptyd-client.ts `PtydConnection`) take it.
 */
export interface IpcEndpoint {
  readonly readable: ReadableStream<Uint8Array>;
  /** Write all of `bytes`; resolves with how many were written. */
  write(bytes: Uint8Array): Promise<number>;
  close(): Promise<void>;
}

/** A Denext local IPC connection (a pair of web streams) as an {@linkcode IpcEndpoint}. */
export function ipcEndpoint(
  conn: Pick<LocalIpcConnection, "readable" | "writable" | "close">,
): IpcEndpoint {
  const writer = conn.writable.getWriter();
  let closed = false;
  return {
    readable: conn.readable,
    write: async (bytes) => {
      await writer.write(bytes);
      return bytes.length;
    },
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      conn.close();
      return Promise.resolve();
    },
  };
}

/**
 * Connect to the channel at `path` over Denext's local IPC (a Windows pipe). A unix socket path
 * goes through libc instead (desktop/hub-socket.ts `connectUnix`, see the module docs).
 */
export async function connectIpc(
  path: string,
  connect: typeof connectLocalIpc = connectLocalIpc,
): Promise<IpcEndpoint> {
  return ipcEndpoint(await connect(path, { timeoutMs: 2000 }));
}
