// Test-only hooks for the end-to-end suite (tests/e2e/). Installed only when the page is opened
// with `?test=1`; a normal run never touches any of this.
//
// - `window.__e2e.terminal(id)`: a terminal's buffer text, grid size, PTY id and exit state, read
//   straight from xterm (the DOM/WebGL renderers are not a reliable text source).
// - `window.__e2e.kills`: every PTY id the backend was asked to kill, in order.
// - `window.__e2e.resizes`: every PTY resize the backend was asked for, in order.
// - `window.__e2e.links`: every link the backend was asked to open or edit, in order, and
//   `window.__e2e.linkState(id)`: what terminal `id`'s pointer is over (lib/terminal-links.ts).
// - `window.__e2e.setClock(ms | null)`: move the app's clock (`clockNow`), for Loopy's night.
// - `window.__e2e.requestClose(reason)`: a click on the window's close button (or a quit), asked
//   of the page's close guard; `window.__e2e.windowCalls`: the session's `closeWindow` /
//   `endWindow` calls, in order.

import type { PtyBackend } from "./pty-client.ts";
import type { LinkEditRequest, LinkOpenRequest } from "./links.ts";
import type {
  TerminalDebugState,
  TerminalManager,
} from "./terminal-manager.ts";
import type { LinkHoverState } from "./terminal-links.ts";
import type { CloseGuard, SessionBackend } from "./session-client.ts";

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
  /** The session's window calls: `close` (`closeWindow`), `end` / `end:confirm` (`endWindow`). */
  windowCalls: string[];
  /** The page's close guards (the session's `guardClose`, held here instead of by Denext). */
  closeGuards: Set<CloseGuard>;
}

/** An empty spy. */
export function newBackendSpy(): BackendSpy {
  return {
    kills: [],
    resizes: [],
    links: [],
    windowCalls: [],
    closeGuards: new Set(),
  };
}

/** What the e2e suite reads from `window.__e2e`. */
interface E2eHooks extends Omit<BackendSpy, "closeGuards"> {
  terminal(id: string): TerminalDebugState | null;
  linkState(id: string): LinkHoverState | null;
  /** Move the app's clock ({@linkcode clockNow}) to `ms`, or back (`null`). */
  setClock(ms: number | null): void;
  /**
   * A click on the window's close button (`"close"`) or a quit, as Denext asks the page's close
   * guards: whether the window may close.
   */
  requestClose(reason: "close" | "quit"): Promise<boolean>;
}

/**
 * The session with its window calls recorded and its close guard held by `spy` (the demo has no
 * window to close: `window.__e2e.requestClose` stands in for the close button).
 */
function withSessionSpy(
  session: SessionBackend,
  spy: BackendSpy,
): SessionBackend {
  return {
    ...session,
    endWindow: (options) => {
      spy.windowCalls.push(options?.confirm ? "end:confirm" : "end");
      return session.endWindow(options);
    },
    closeWindow: () => {
      spy.windowCalls.push("close");
      return session.closeWindow();
    },
    guardClose: (handler) => {
      spy.closeGuards.add(handler);
      return Promise.resolve(() => void spy.closeGuards.delete(handler));
    },
  };
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
    session: withSessionSpy(backend.session, spy),
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
    companionKeyStatus: () => backend.companionKeyStatus(),
    companionKeySet: (key) => backend.companionKeySet(key),
    companionKeyClear: () => backend.companionKeyClear(),
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
    windowCalls: spy.windowCalls,
    setClock,
    async requestClose(reason) {
      let close = true;
      for (const guard of [...spy.closeGuards]) {
        if ((await guard(reason)) === false) close = false;
      }
      return close;
    },
  };
  (globalThis as { __e2e?: E2eHooks }).__e2e = hooks;
}

// --- the app's clock --------------------------------------------------------------------------

/** How far the e2e suite moved the clock (`window.__e2e.setClock`), ms. 0 outside test mode. */
let clockOffset = 0;

/** The event the window gets when the e2e suite moves the clock. */
export const CLOCK_EVENT = "qutty:clock";

/**
 * Now, for what depends on the time of day (Loopy sleepy at night: lib/companion/sleepy.ts):
 * `Date.now()`, moved by the e2e suite in test mode.
 */
export function clockNow(): number {
  return Date.now() + clockOffset;
}

/** Move the clock to `ms` (since the epoch), or back to the real time (`null`). Test mode only. */
function setClock(ms: number | null): void {
  clockOffset = ms === null ? 0 : ms - Date.now();
  globalThis.dispatchEvent?.(new Event(CLOCK_EVENT));
}
