// Test-only hooks for the end-to-end suite (tests/e2e/). Installed only when the page is opened
// with `?test=1`; a normal run never touches any of this.
//
// - `window.__e2e.terminal(id)`: a terminal's buffer text, grid size, PTY id and exit state, read
//   straight from xterm (the DOM/WebGL renderers are not a reliable text source).
// - `window.__e2e.kills`: every PTY id the backend was asked to kill, in order.
// - `window.__e2e.resizes`: every PTY resize the backend was asked for, in order.
// - `window.__e2e.links`: every link the backend was asked to open or edit, in order, and
//   `window.__e2e.linkState(id)`: what terminal `id`'s pointer is over (lib/terminal-links.ts).

import type { PtyBackend } from "./pty-client.ts";
import type { LinkEditRequest, LinkOpenRequest } from "./links.ts";
import type {
  TerminalDebugState,
  TerminalManager,
} from "./terminal-manager.ts";
import type { LinkHoverState } from "./terminal-links.ts";

/** One `resize` call the backend received. */
interface PtyResize {
  ptyId: string;
  cols: number;
  rows: number;
}

/** What the spy records of the backend calls. */
export interface BackendSpy {
  kills: string[];
  resizes: PtyResize[];
  /** `linkOpen` and `linkEdit` calls (`kind: "edit"` marks the latter). */
  links: (LinkOpenRequest | ({ kind: "edit" } & LinkEditRequest))[];
}

/** What the e2e suite reads from `window.__e2e`. */
interface E2eHooks extends BackendSpy {
  terminal(id: string): TerminalDebugState | null;
  linkState(id: string): LinkHoverState | null;
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

/** Wrap a backend so every `kill` and `resize` is recorded in `spy` (then forwarded). */
export function withBackendSpy(
  backend: PtyBackend,
  spy: BackendSpy,
): PtyBackend {
  return {
    kind: backend.kind,
    session: backend.session,
    spawn: (o) => backend.spawn(o),
    write: (id, data, options) => backend.write(id, data, options),
    resize: (id, cols, rows) => {
      spy.resizes.push({ ptyId: id, cols, rows });
      return backend.resize(id, cols, rows);
    },
    kill: (id) => {
      spy.kills.push(id);
      return backend.kill(id);
    },
    info: (id) => backend.info(id),
    keyBindings: () => backend.keyBindings(),
    launchables: () => backend.launchables(),
    sandboxStatus: () => backend.sandboxStatus(),
    sandboxConfigure: (s) => backend.sandboxConfigure(s),
    sandboxCheck: () => backend.sandboxCheck(),
    sandboxEnsure: (s) => backend.sandboxEnsure(s),
    sandboxAction: (a) => backend.sandboxAction(a),
    ollamaStatus: () => backend.ollamaStatus(),
    ollamaLibrary: (q, o) => backend.ollamaLibrary(q, o),
    ollamaLibraryModel: (name) => backend.ollamaLibraryModel(name),
    ollamaOpenApp: () => backend.ollamaOpenApp(),
    linkResolve: (cwd, paths) => backend.linkResolve(cwd, paths),
    linkOpen: (request) => {
      spy.links.push(request);
      return backend.linkOpen(request);
    },
    linkEditors: () => backend.linkEditors(),
    linkEdit: (request) => {
      spy.links.push({ kind: "edit", ...request });
      return backend.linkEdit(request);
    },
    sysSample: () => backend.sysSample(),
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
    sshForwards: (target) => backend.sshForwards(target),
    sshForwardAdd: (args) => backend.sshForwardAdd(args),
    sshForwardCancel: (args) => backend.sshForwardCancel(args),
    sshSaveForwards: (args) => backend.sshSaveForwards(args),
    onTransfer: (cb) => backend.onTransfer(cb),
    hubSnapshot: () => backend.hubSnapshot(),
    hubAnswer: (id, action) => backend.hubAnswer(id, action),
    hubSetLabel: (ptyId, label) => backend.hubSetLabel(ptyId, label),
    onHubTiles: (cb) => backend.onHubTiles(cb),
    onHubAsk: (cb) => backend.onHubAsk(cb),
    onHubAskClosed: (cb) => backend.onHubAskClosed(cb),
    integrationStatus: () => backend.integrationStatus(),
    integrationInstall: (target) => backend.integrationInstall(target),
    integrationUninstall: (target) => backend.integrationUninstall(target),
    companionStatus: () => backend.companionStatus(),
    companionSend: (text, via) => backend.companionSend(text, via),
    companionConfigure: (enabled, model, engine) =>
      backend.companionConfigure(enabled, model, engine),
    companionSayDone: (id, action) => backend.companionSayDone(id, action),
    hubControlDone: (requestId, result) =>
      backend.hubControlDone(requestId, result),
    onCompanion: (cb) => backend.onCompanion(cb),
    onHubSay: (cb) => backend.onHubSay(cb),
    onHubControl: (cb) => backend.onHubControl(cb),
  };
}

/** Publish the hooks on `window.__e2e`. */
export function installE2eHooks(
  manager: TerminalManager,
  spy: BackendSpy,
): void {
  const hooks: E2eHooks = {
    terminal: (id) => manager.debugState(id),
    linkState: (id) => manager.linkState(id),
    kills: spy.kills,
    resizes: spy.resizes,
    links: spy.links,
  };
  (globalThis as { __e2e?: E2eHooks }).__e2e = hooks;
}
