// The `session` desktop extension: the page's side of the workspace model (desktop/workspace-host.ts).
// A page joins the workspace its window shows (the window's key), gets back what it saved there
// before (tiles, layout, MRU order) and each of its terminals with their replay
// (desktop/terminal-sessions.ts), and saves its snapshot as it changes. The page's Workspaces menu
// lists the workspaces, reopens a detached one (it opens a window with that key itself) and ends
// one for real; `endWindow` ends the calling window's own workspace once the page has closed the
// window (the Workspaces menu's "End workspace", the close button set to end its shells).
//
// The Window menu's "Close Window and End Its Shells" (`desktop.menu.window.items`) arrives here
// once per click with the key window (`host.onWindowMenuItem`): its workspace is ended and the
// window closed, after asking when an agent there is busy. Its tile items ("Minimize Tile",
// "Zoom Tile") go on to the key window's page as a `tileMenu` event (`tileMenuToPage`): the page
// acts on its focused tile.
//
// The quit guard lives here too: Cmd+Q kills every terminal, so with an agent at work the OS's own
// message box asks first (`host.confirm`, app-modal: it works with no window open), and the guard
// answers with the user's choice.
//
// The window lifecycle goes to tray mode (desktop/tray.ts): closing the last window leaves the app
// in the menu bar / tray while terminals run, and quits when none does.
//
// Events: `changed` (the workspace list, to every window); `tileMenu` (a Window-menu tile item,
// to the key window only).

import {
  defineDesktopExtension,
  DesktopCapError,
  type DesktopConfirmOptions,
  type DesktopExtensionHost,
} from "denext/desktop";
import { emptyInput, objectSchema, str } from "./schema.ts";
import {
  type BusyTile,
  type WorkspaceInfo,
  workspaces,
} from "./workspace-host.ts";
import { terminalSessions } from "./pty.ts";
import { type TrayMode, trayMode } from "./tray.ts";
import { closeAppWindow } from "./windows.ts";
import {
  CLOSE_AND_END_ITEM,
  isTileMenuItem,
} from "../lib/workspace/windows.ts";
import type { PtyReplay } from "./terminal-sessions.ts";

export type { PtyReplay, WorkspaceInfo };

/** What `join` answers. */
export interface SessionJoin {
  workspace: { id: string; name: string };
  /** The page's last snapshot of this workspace (`null`: a new workspace, or a new launch). */
  snapshot: unknown;
  /** Its terminals, attached to the calling window, with their replay. */
  ptys: PtyReplay[];
}

/** What `endWindow` answers: whether the page should close its window now. */
export interface SessionEndWindow {
  close: boolean;
}

/** The biggest snapshot a page may save (its tiles, layout and order: a few KiB in practice). */
const MAX_SNAPSHOT_CHARS = 256 * 1024;

const saveInput = objectSchema<{ snapshot: unknown }>((v, issues) => {
  let size = Infinity;
  try {
    size = JSON.stringify(v.snapshot ?? null).length;
  } catch { /* not JSON */ }
  if (
    typeof v.snapshot !== "object" || v.snapshot === null ||
    size > MAX_SNAPSHOT_CHARS
  ) {
    issues.push({
      message:
        `snapshot must be an object (at most ${MAX_SNAPSHOT_CHARS} characters of JSON)`,
      path: ["snapshot"],
    });
  }
  return { snapshot: v.snapshot };
});

const idInput = objectSchema<{ id: string }>((v, issues) => ({
  id: str(v, "id", issues, 64),
}));

const endWindowInput = objectSchema<{ confirm: boolean }>((v, issues) => {
  if (v.confirm !== undefined && typeof v.confirm !== "boolean") {
    issues.push({ message: "confirm must be a boolean", path: ["confirm"] });
  }
  return { confirm: v.confirm === true };
});

const windowOf = (ctx: { windowId?: string }) => ctx.windowId ?? "main";

/** How long the `changed` event waits to coalesce a burst of changes. */
const CHANGED_DEBOUNCE_MS = 100;

/** Whether a window still shows the app (the tray panel does not count). */
function hasAppWindow(host: Pick<DesktopExtensionHost, "windows">): boolean {
  return host.windows().some((w) => w.kind !== "panel");
}

/**
 * Tell tray mode (desktop/tray.ts) about the window lifecycle: a window opening brings the Dock
 * icon back, and once the last window has closed (not for a quit) the app lives on in the tray
 * while terminals run, or quits through the quit guard. Where there is no tray, closing the last
 * window quits off macOS (no Dock to bring the app back) and keeps a Dock app on macOS. The
 * decision waits a turn, so every close hook (the PTY host's detaches or ends the closed window's
 * workspace, desktop/terminal-sessions.ts) has run by then.
 */
export function followWindows(
  host: Pick<
    DesktopExtensionHost,
    "onWindowOpened" | "onWindowClosed" | "windows"
  >,
  mode: Pick<TrayMode, "windowOpened" | "lastWindowClosed"> = trayMode,
): () => void {
  const offOpened = host.onWindowOpened((info) => {
    if (info.kind !== "panel") mode.windowOpened();
  });
  const offClosed = host.onWindowClosed((info) => {
    if (info.appQuitting) return;
    setTimeout(() => {
      if (!hasAppWindow(host)) mode.lastWindowClosed();
    }, 0);
  });
  return () => {
    offOpened();
    offClosed();
  };
}

/** "claude, codex": the busy agents' names, each once. */
function namesOf(busy: readonly BusyTile[]): string {
  return [...new Set(busy.map((t) => t.name))].join(", ");
}

/** "An agent is still working" / "3 agents are still working", plus `where`. */
function headline(busy: readonly BusyTile[], where = ""): string {
  const who = busy.length === 1 ? "An agent is" : `${busy.length} agents are`;
  return `${who} still working${where}`;
}

/** A question for the OS's message box: `yes` (0) or Cancel (1, the default and Escape). */
function question(title: string, message: string, detail: string, yes: string) {
  return {
    title,
    message,
    detail,
    buttons: [yes, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    kind: "warning" as const,
  };
}

/** The quit question: Quit Anyway (0) or Cancel (1). */
export function quitQuestion(busy: readonly BusyTile[]): DesktopConfirmOptions {
  return question(
    "Quit Qutty?",
    headline(busy),
    `Quitting ends every terminal, in every window, including ${
      namesOf(busy)
    }.`,
    "Quit Anyway",
  );
}

/** The close question of "Close Window and End Its Shells": Close and End (0) or Cancel (1). */
export function closeQuestion(
  busy: readonly BusyTile[],
): DesktopConfirmOptions {
  return question(
    "Close Window and End Its Shells?",
    headline(busy, " in this window"),
    `Closing this window ends its terminals, including ${namesOf(busy)}.`,
    "Close and End",
  );
}

/**
 * The quit guard: with a busy agent the OS's message box asks (it is app-modal, so it works with no
 * window open) and the guard answers with the user's choice: "Quit Anyway" lets the quit go on,
 * Cancel (or Escape) cancels it. Denext stops the guards' 5 seconds while the box is up (4.16), so
 * the guard waits for the answer. A second quit while the box is up is cancelled without a second
 * box. Under a runtime without message boxes (`host.confirm` rejects `unsupported`) the quit is
 * cancelled once and the next one, within a few seconds, goes through.
 */
export function guardQuit(
  host: Pick<DesktopExtensionHost, "onBeforeQuit" | "confirm">,
): () => void {
  let asking = false;
  return host.onBeforeQuit(async () => {
    const decision = workspaces.beforeQuit();
    if (decision.allow) return true;
    if (asking) return false;
    asking = true;
    try {
      return await host.confirm(quitQuestion(decision.busy)) === 0;
    } catch (err) {
      console.warn(
        "session: could not ask before quitting (quit again to quit)",
        err,
      );
      workspaces.answerQuit(true);
      return false;
    } finally {
      asking = false;
    }
  });
}

/**
 * Whether workspace `id` may be ended: yes when no agent there is busy, else the OS's message box
 * asks ({@linkcode closeQuestion}). One box at a time: while one is up, the answer is no.
 */
export type AskEnd = (id: string) => Promise<boolean>;

/** The {@linkcode AskEnd} that asks through `host`. */
export function createAskEnd(
  host: Pick<DesktopExtensionHost, "confirm">,
): AskEnd {
  let asking = false;
  return async (id) => {
    if (asking) return false;
    const busy = workspaces.busyIn(id);
    if (busy.length === 0) return true;
    asking = true;
    try {
      return await host.confirm(closeQuestion(busy)) === 0;
    } catch (err) {
      console.warn("session: could not ask before ending the window", err);
      return false;
    } finally {
      asking = false;
    }
  };
}

/**
 * `endWindow` for one window: whether its page should close it now. `confirm`: ask first when an
 * agent there is busy.
 */
export type EndWindow = (
  window: string,
  confirm?: boolean,
) => Promise<SessionEndWindow>;

/**
 * `endWindow`, from the window's page: the Workspaces menu's "End workspace" (asked in the page)
 * or, with `confirm`, the close button set to end its shells (or the page's close question answered
 * "End Shells"), which asks about busy agents first. The workspace is ended once the page has
 * closed the window (`endOnClose`), so the close does not offer it in Reopen Closed Window again.
 */
export function createEndWindow(ask: AskEnd): EndWindow {
  return async (window, confirm = false) => {
    const id = workspaces.workspaceOfWindow(window);
    if (id === undefined) return { close: false };
    if (confirm && !(await ask(id))) return { close: false };
    return { close: workspaces.endOnClose(id) };
  };
}

/**
 * The Window menu's "Close Window and End Its Shells" (`desktop.menu.window.items`): each click
 * arrives once, with the key window. Its workspace is ended (after asking when an agent there is
 * busy) once `close` has closed the window, without its page's close guard. With no window open,
 * or a window that shows no workspace, nothing happens. Returns the unsubscribe.
 */
export function closeAndEndFromMenu(
  host: Pick<DesktopExtensionHost, "onWindowMenuItem">,
  ask: AskEnd,
  close: (windowId: string) => void = closeAppWindow,
): () => void {
  return host.onWindowMenuItem(async (item, { keyWindow }) => {
    if (item !== CLOSE_AND_END_ITEM || !keyWindow) return;
    const id = workspaces.workspaceOfWindow(keyWindow.id);
    if (id === undefined || !(await ask(id))) return;
    // The window may have closed, or come to show another workspace, while the box was up.
    if (workspaces.workspaceOfWindow(keyWindow.id) !== id) return;
    if (workspaces.endOnClose(id)) close(keyWindow.id);
  });
}

/** What the key window's page gets for a Window-menu tile item. */
export interface TileMenuEvent {
  item: string;
  /**
   * When it was sent (ms since the epoch). Denext replays retained events to a page that
   * subscribes later (a reload), so the page drops one older than `TILE_MENU_MAX_AGE_MS`
   * (lib/workspace/windows.ts) rather than act on a stale click.
   */
  at: number;
}

/**
 * The Window menu's tile items ("Minimize Tile", "Zoom Tile"): each click is handed to the key
 * window's page (`tileMenu`), which acts on its focused tile. With no window open nothing happens.
 * Returns the unsubscribe.
 */
export function tileMenuToPage(
  host: Pick<DesktopExtensionHost, "onWindowMenuItem" | "emit">,
  now: () => number = Date.now,
): () => void {
  return host.onWindowMenuItem((item, { keyWindow }) => {
    if (!isTileMenuItem(item) || !keyWindow) return;
    const event: TileMenuEvent = { item, at: now() };
    host.emit("tileMenu", event, { window: keyWindow.id });
  });
}

let endWindow: EndWindow | undefined;

export default defineDesktopExtension({
  name: "session",
  events: ["changed", "tileMenu"],
  setup: (host) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    workspaces.onChanged(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        host.emit("changed", { workspaces: workspaces.list() });
      }, CHANGED_DEBOUNCE_MS);
    });
    followWindows(host);
    guardQuit(host);
    const ask = createAskEnd(host);
    endWindow = createEndWindow(ask);
    closeAndEndFromMenu(host, ask);
    tileMenuToPage(host);
  },
  methods: {
    /** Show the calling window's workspace: its snapshot and its terminals, attached here. */
    join: {
      input: emptyInput,
      handler: (_args: unknown, ctx): SessionJoin => {
        const window = windowOf(ctx);
        const sessions = terminalSessions();
        const joined = workspaces.join(window, sessions.keyOf(window));
        return {
          workspace: { id: joined.id, name: joined.name },
          snapshot: joined.snapshot,
          ptys: sessions.attachWorkspace(joined.id, window),
        };
      },
    },
    /** The page's snapshot of its workspace (sent as it changes, debounced). */
    save: {
      input: saveInput,
      handler: (args: unknown, ctx): void => {
        const id = workspaces.workspaceOfWindow(windowOf(ctx));
        if (id === undefined) {
          throw new DesktopCapError(
            "not_found",
            "this window has not joined a workspace",
          );
        }
        workspaces.save(id, (args as { snapshot: unknown }).snapshot);
      },
    },
    /** Every workspace (the page's Workspaces menu). */
    list: {
      input: emptyInput,
      handler: (): WorkspaceInfo[] => workspaces.list(),
    },
    /** End a workspace for real: its terminals are killed and its sandbox container stopped. */
    end: {
      input: idInput,
      handler: (args: unknown): { ended: number } => ({
        ended: workspaces.end((args as { id: string }).id).length,
      }),
    },
    /** The calling window took the focus (the companion talks to the active window). */
    focus: {
      input: emptyInput,
      handler: (_args: unknown, ctx): void => workspaces.focused(windowOf(ctx)),
    },
    /**
     * End the calling window's workspace once the page has closed the window (`close: true`: close
     * it now). The page asked already (the Workspaces menu's "End workspace"); `confirm` still asks
     * about a busy agent (the window's close button, set to end its shells or answered "End
     * Shells").
     */
    endWindow: {
      input: endWindowInput,
      handler: (args: unknown, ctx): Promise<SessionEndWindow> => {
        if (!endWindow) {
          throw new DesktopCapError("unavailable", "session is not set up");
        }
        const { confirm } = args as { confirm: boolean };
        return endWindow(windowOf(ctx), confirm);
      },
    },
  },
});
