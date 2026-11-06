// Test-only hooks for the end-to-end suite (tests/e2e/). Installed only when the page is opened
// with `?test=1`; a normal run never touches any of this.
//
// - `window.__e2e.terminal(id)`: a terminal's buffer text, grid size, PTY id and exit state, read
//   straight from xterm (the DOM/WebGL renderers are not a reliable text source).
// - `window.__e2e.kills`: every PTY id the backend was asked to kill, in order.

import type { PtyBackend } from "./pty-client.ts";
import type {
  TerminalDebugState,
  TerminalManager,
} from "./terminal-manager.ts";

/** What the e2e suite reads from `window.__e2e`. */
interface E2eHooks {
  terminal(id: string): TerminalDebugState | null;
  kills: string[];
}

/** Whether the page was opened in test mode (`?test=1`). */
export function isTestMode(): boolean {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "").get(
      "test",
    ) === "1";
  } catch {
    return false;
  }
}

/** Wrap a backend so every `kill` is recorded in `kills` (then forwarded). */
export function withKillSpy(backend: PtyBackend, kills: string[]): PtyBackend {
  return {
    kind: backend.kind,
    spawn: (o) => backend.spawn(o),
    write: (id, data, options) => backend.write(id, data, options),
    resize: (id, cols, rows) => backend.resize(id, cols, rows),
    kill: (id) => {
      kills.push(id);
      return backend.kill(id);
    },
    info: (id) => backend.info(id),
    keyBindings: () => backend.keyBindings(),
    onData: (id, cb) => backend.onData(id, cb),
    onExit: (id, cb) => backend.onExit(id, cb),
    sshHosts: () => backend.sshHosts(),
    sshSaveHost: (host) => backend.sshSaveHost(host),
    sshDeleteHost: (alias) => backend.sshDeleteHost(alias),
    sshCommand: (target) => backend.sshCommand(target),
    sshUpload: (args) => backend.sshUpload(args),
    sshDownload: (args) => backend.sshDownload(args),
    sshList: (args) => backend.sshList(args),
    sshCancel: (transferId) => backend.sshCancel(transferId),
    onTransfer: (cb) => backend.onTransfer(cb),
  };
}

/** Publish the hooks on `window.__e2e`. */
export function installE2eHooks(
  manager: TerminalManager,
  kills: string[],
): void {
  const hooks: E2eHooks = {
    terminal: (id) => manager.debugState(id),
    kills,
  };
  (globalThis as { __e2e?: E2eHooks }).__e2e = hooks;
}
