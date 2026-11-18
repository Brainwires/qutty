// The `session` desktop extension: the page's side of the workspace model (desktop/workspace-host.ts).
// A page joins the workspace its window shows (the window's key), gets back what it saved there
// before (tiles, layout, MRU order) and each of its terminals with their replay
// (desktop/terminal-sessions.ts), and saves its snapshot as it changes. The page's Workspaces menu
// lists the workspaces, reopens a detached one (it opens a window with that key itself) and ends
// one for real; `endWindow` ends the calling window's own workspace once the page has closed the
// window (the Workspaces menu's "End workspace", the close button set to end its shells).
//
// The Shell menu's "Close Window and End Its Shells" (the native menus, lib/workspace/menus.ts)
// arrives here once per click with the key window (`host.onAppMenuItem`): its workspace is ended
// and the window closed, after asking when an agent there is busy. The menus' other items reach
// the key window's page itself (app/use-native-menus.ts).
//
// The quit guard lives here too: Cmd+Q kills every terminal, so with an agent at work the OS's own
// message box asks first (`host.confirm`, app-modal: it works with no window open), and the guard
// answers with the user's choice.
//
// The window lifecycle goes to tray mode (desktop/tray.ts): closing the last window leaves the app
// in the menu bar / tray while terminals run, and quits when none does.
//
// Tiles move between windows here too (desktop/tile-move.ts): `moveTargets`, `moveTile`,
// `arrivals`, `dragOver` / `dragEnd`; a page joining takes its workspace's pending arrivals into
// its snapshot, and a save names the arrivals it shows and drops the tiles that moved away.
// `requestTileMove` / `tileMoveTargets` are for a native Window-menu "Move Tile to".
//
// Events: `changed` (the workspace list, to every window); `tileArrived`, `tileLeft`,
// `dragHover`, `moveRequest` (one-shot, to one window: desktop/tile-move.ts).

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
import { type QuitKeeper, shellKeeper } from "./kept-shells.ts";
import { type TrayMode, trayMode } from "./tray.ts";
import { appWindowBounds, closeAppWindow } from "./windows.ts";
import { isCompanionWindow } from "./companion-window.ts";
import { CLOSE_AND_END_ITEM } from "../lib/workspace/windows.ts";
import type { PtyReplay } from "./terminal-sessions.ts";
import {
  snapshotHasTile,
  withArrivals,
  withoutTile,
} from "../lib/workspace/session.ts";
import {
  type DragHover,
  dragOverInput,
  moveInput,
  type MoveRequest,
  type MoveResult,
  type MoveTarget,
  type TileArrival,
  TileMover,
} from "./tile-move.ts";

export type {
  DragHover,
  MoveResult,
  MoveTarget,
  PtyReplay,
  TileArrival,
  WorkspaceInfo,
};

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

const saveInput = objectSchema<
  { snapshot: unknown; arrived?: string[] }
>((v, issues) => {
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
  // The tiles moved here that this snapshot shows now (desktop/tile-move.ts).
  const arrived = Array.isArray(v.arrived)
    ? v.arrived.filter((m): m is string => typeof m === "string").slice(0, 64)
    : undefined;
  return { snapshot: v.snapshot, ...(arrived ? { arrived } : {}) };
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

const keepInput = objectSchema<{ on: boolean }>((v, issues) => {
  if (typeof v.on !== "boolean") {
    issues.push({ message: "on must be a boolean", path: ["on"] });
  }
  return { on: v.on === true };
});

const windowOf = (ctx: { windowId?: string }) => ctx.windowId ?? "main";

/** How long the `changed` event waits to coalesce a burst of changes. */
const CHANGED_DEBOUNCE_MS = 100;

/**
 * Whether a window of the app's own is open: the tray panel and the floating companion's window
 * (desktop/companion-window.ts) do not count.
 */
function isAppWindow(w: { id: string; kind: string }): boolean {
  return w.kind !== "panel" && !isCompanionWindow(w.id);
}

/** Whether a window still shows the app ({@linkcode isAppWindow}). */
function hasAppWindow(host: Pick<DesktopExtensionHost, "windows">): boolean {
  return host.windows().some(isAppWindow);
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
    if (isAppWindow(info)) mode.windowOpened();
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

/** The keep question's buttons, in order. */
export const KEEP_SHELLS = 0;
export const END_SHELLS = 1;
export const CANCEL_QUIT = 2;

/**
 * The quit question while shells can be kept (Settings → "Keep shells running after quitting"):
 * Keep Shells Running (0, the default), End Shells (1) or Cancel (2). Keeping is the default
 * because it loses nothing: the next launch shows every shell as it was, while ending one cannot
 * be undone. A busy agent is named (keeping lets it work on).
 */
export function keepQuestion(
  shells: number,
  busy: readonly BusyTile[],
): DesktopConfirmOptions {
  const what = shells === 1 ? "A shell is" : `${shells} shells are`;
  return {
    title: "Quit Qutty?",
    message: busy.length > 0 ? headline(busy) : `${what} running`,
    detail:
      (busy.length > 0
        ? `Keep the shells running and ${
          namesOf(busy)
        } works on while Qutty is closed; end them and it stops. `
        : "") +
      "Kept shells come back, as they are, the next time Qutty opens.",
    buttons: ["Keep Shells Running", "End Shells", "Cancel"],
    defaultId: KEEP_SHELLS,
    cancelId: CANCEL_QUIT,
    kind: busy.length > 0 ? "warning" : "info",
  };
}

/**
 * The quit guard. With shells the PTY daemon can keep (desktop/kept-shells.ts), the OS's message
 * box asks whether to keep them running ({@linkcode keepQuestion}, which also names a busy
 * agent); Keep lets the shells go to the daemon before the quit goes on. Otherwise, with a busy
 * agent it asks as before: "Quit Anyway" lets the quit go on, Cancel (or Escape) cancels it.
 * The box is app-modal, so it works with no window open; Denext stops the guards' 5 seconds while
 * it is up (4.16), so the guard waits for the answer. A second quit while the box is up is
 * cancelled without a second box. Under a runtime without message boxes (`host.confirm` rejects
 * `unsupported`) shells that can be kept are kept, and a busy agent's quit is cancelled once and
 * the next one, within a few seconds, goes through.
 */
export function guardQuit(
  host: Pick<DesktopExtensionHost, "onBeforeQuit" | "confirm">,
  keeper: QuitKeeper = shellKeeper(),
): () => void {
  let asking = false;
  return host.onBeforeQuit(async () => {
    const decision = workspaces.beforeQuit();
    const shells = keeper.keepable();
    if (shells > 0) {
      if (asking) return false;
      asking = true;
      try {
        const busy = decision.allow ? [] : decision.busy;
        const choice = await host.confirm(keepQuestion(shells, busy)).catch(
          (err) => {
            console.warn("session: could not ask before quitting", err);
            return KEEP_SHELLS;
          },
        );
        if (choice === CANCEL_QUIT || choice === null) return false;
        if (choice === KEEP_SHELLS) await keeper.keepForNextLaunch();
        return true;
      } finally {
        asking = false;
      }
    }
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
 * The Shell menu's "Close Window and End Its Shells" (the native menus): each click arrives once,
 * with the key window. Its workspace is ended (after asking when an agent there is
 * busy) once `close` has closed the window, without its page's close guard. With no window open,
 * or a window that shows no workspace, nothing happens. Returns the unsubscribe.
 */
export function closeAndEndFromMenu(
  host: Pick<DesktopExtensionHost, "onAppMenuItem">,
  ask: AskEnd,
  close: (windowId: string) => void = closeAppWindow,
): () => void {
  return host.onAppMenuItem(async (item, { keyWindow }) => {
    if (item !== CLOSE_AND_END_ITEM || !keyWindow) return;
    const id = workspaces.workspaceOfWindow(keyWindow.id);
    if (id === undefined || !(await ask(id))) return;
    // The window may have closed, or come to show another workspace, while the box was up.
    if (workspaces.workspaceOfWindow(keyWindow.id) !== id) return;
    if (workspaces.endOnClose(id)) close(keyWindow.id);
  });
}

let endWindow: EndWindow | undefined;
let mover: TileMover | undefined;
let pageEmit: DesktopExtensionHost["emit"] | undefined;

/** The tile mover over the extension's host (desktop/tile-move.ts). */
export function createTileMover(
  host: Pick<
    DesktopExtensionHost,
    "emit" | "windows" | "openWindow" | "onWindowClosed"
  >,
  bounds: (id: string) => ReturnType<typeof appWindowBounds> = appWindowBounds,
  close: (id: string) => void = closeAppWindow,
): TileMover {
  const m = new TileMover({
    workspaces,
    sessions: terminalSessions(),
    emit: (event, data, window) =>
      host.emit(event, data, { window, retain: false }),
    windows: () => host.windows(),
    bounds,
    openWindow: (options) => host.openWindow(options),
    closeWindow: close,
  });
  // A window that closes mid-drag: whatever it hovered is told it was left.
  host.onWindowClosed((info) => m.dragEnd(info.id));
  return m;
}

/** What a page gets to move its focused tile (`moveRequest`). */
export interface MoveRequestEvent {
  /** A window's id, or `"new"`: a new window. */
  to: string;
  /** When it was asked (ms since the epoch): a page drops an old one. */
  at: number;
}

/**
 * Move window `windowId`'s focused tile to window `to` (or `"new"`: a new window), as its tile
 * header's "Move to Window" does: for the Window menu (desktop.ts / the native menus), which knows
 * the key window and the others. The page moves it (it knows which tile is focused). Nothing
 * happens before the extension is set up.
 */
export function requestTileMove(windowId: string, to: string): void {
  const event: MoveRequestEvent = { to, at: Date.now() };
  pageEmit?.("moveRequest", event, { window: windowId, retain: false });
}

/** The other windows window `windowId` can move a tile to (for a Window-menu "Move Tile to" list). */
export function tileMoveTargets(windowId: string): MoveTarget[] {
  return mover?.targets(windowId) ?? [];
}

const requireMover = (): TileMover => {
  if (!mover) throw new DesktopCapError("unavailable", "session is not set up");
  return mover;
};

/** Move a tile of window `windowId` as its page's `moveTile` does (the self-test's). */
export function moveTileFrom(
  windowId: string,
  request: MoveRequest,
): MoveResult {
  return requireMover().move(windowId, request);
}

export default defineDesktopExtension({
  name: "session",
  events: [
    "changed",
    "tileArrived",
    "tileLeft",
    "dragHover",
    "moveRequest",
  ],
  setup: (host) => {
    mover = createTileMover(host);
    pageEmit = (event, data, options) => host.emit(event, data, options);
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
  },
  methods: {
    /** Show the calling window's workspace: its snapshot and its terminals, attached here. */
    join: {
      input: emptyInput,
      handler: async (_args: unknown, ctx): Promise<SessionJoin> => {
        // The shells the last quit kept are adopted first (desktop/kept-shells.ts).
        await shellKeeper().ready;
        const window = windowOf(ctx);
        const sessions = terminalSessions();
        const joined = workspaces.join(window, sessions.keyOf(window));
        // Tiles moved here that no page has shown yet join the snapshot (desktop/tile-move.ts).
        const pending = workspaces.takeArrivals(joined.id);
        const snapshot = withArrivals(
          joined.snapshot,
          TileMover.pendingTiles(pending),
        );
        if (pending.length > 0) workspaces.save(joined.id, snapshot);
        return {
          workspace: { id: joined.id, name: joined.name },
          snapshot,
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
        const { snapshot, arrived } = args as {
          snapshot: unknown;
          arrived?: string[];
        };
        workspaces.ackArrivals(id, arrived ?? []);
        // A save sent before a tile moved away may still have it: it is gone from here.
        let snap = snapshot;
        for (const tile of workspaces.departures(id)) {
          if (snapshotHasTile(snap, tile)) snap = withoutTile(snap, tile);
        }
        workspaces.save(id, snap);
      },
    },
    /** The other windows a tile can move to (the tile header's "Move to Window"). */
    moveTargets: {
      input: emptyInput,
      handler: (_args: unknown, ctx): MoveTarget[] =>
        requireMover().targets(windowOf(ctx)),
    },
    /** Move one of the calling window's tiles to another window, or a new one. */
    moveTile: {
      input: moveInput,
      handler: (args: unknown, ctx): MoveResult =>
        requireMover().move(windowOf(ctx), args as MoveRequest),
    },
    /** The tiles moved to the calling window, waiting for its page (each with its terminal). */
    arrivals: {
      input: emptyInput,
      handler: (_args: unknown, ctx): TileArrival[] =>
        requireMover().arrivals(windowOf(ctx)),
    },
    /** A tile dragged out of the calling window: which window is under the pointer. */
    dragOver: {
      input: dragOverInput,
      handler: (args: unknown, ctx): { target: string | null } =>
        requireMover().dragOver(
          windowOf(ctx),
          args as Parameters<TileMover["dragOver"]>[1],
        ),
    },
    /** The calling window's tile drag ended. */
    dragEnd: {
      input: emptyInput,
      handler: (_args: unknown, ctx): void =>
        requireMover().dragEnd(windowOf(ctx)),
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
    /** Settings → "Keep shells running after quitting" (desktop/kept-shells.ts). */
    keepShells: {
      input: emptyInput,
      handler: (): boolean => shellKeeper().keepShells,
    },
    setKeepShells: {
      input: keepInput,
      handler: (args: unknown): boolean => {
        shellKeeper().setKeepShells((args as { on: boolean }).on);
        return shellKeeper().keepShells;
      },
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
