// The `session` desktop extension: the page's side of the workspace model (desktop/workspace-host.ts).
// A page joins the workspace its window shows (the window's key), gets back what it saved there
// before (tiles, layout, MRU order) and each of its terminals with their replay
// (desktop/terminal-sessions.ts), and saves its snapshot as it changes. The page's Workspaces menu
// lists the workspaces, reopens a detached one (it opens a window with that key itself) and ends
// one for real; `endWindow` ends the calling window's own workspace once the page has closed the
// window (the Window menu's "Close Window and End Its Shells", the Workspaces menu's "End
// workspace").
//
// The quit guard lives here too: Cmd+Q kills every terminal, so with an agent at work the quit is
// cancelled and the OS's own message box asks first (`host.confirm`, app-modal: it works with no
// window open); "Quit Anyway" quits again.
//
// Events: `changed` (the workspace list, to every window).

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

const endWindowInput = objectSchema<{ menu: boolean }>((v, issues) => {
  if (typeof v.menu !== "boolean") {
    issues.push({ message: "menu must be a boolean", path: ["menu"] });
  }
  return { menu: v.menu === true };
});

const windowOf = (ctx: { windowId?: string }) => ctx.windowId ?? "main";

/** How long the `changed` event waits to coalesce a burst of changes. */
const CHANGED_DEBOUNCE_MS = 100;

/** Whether a window still shows the app (the tray panel does not count). */
function hasAppWindow(host: DesktopExtensionHost): boolean {
  return host.windows().some((w) => w.kind !== "panel");
}

/** Quit the app (`Deno.desktop.quit()`): the quit guards run again. */
function quitApp(): void {
  const desktop = (Deno as unknown as { desktop?: { quit?: () => void } })
    .desktop;
  try {
    desktop?.quit?.();
  } catch (err) {
    console.error("session: could not quit", err);
  }
}

/**
 * Off macOS there is no Dock to bring a windowless app back, so closing the last window quits
 * (through the quit guard, which asks when an agent is busy). On macOS the app stays up.
 */
function quitWithLastWindow(host: DesktopExtensionHost): void {
  host.onWindowClosed((info) => {
    if (info.appQuitting || host.os === "darwin" || hasAppWindow(host)) return;
    quitApp();
  });
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
 * The quit guard: a quit with a busy agent is cancelled, and the OS's message box asks (it is
 * app-modal, so it works with no window open). The guard does not wait for the answer, since
 * Denext lets a quit go on once its guards took 5 seconds: "Quit Anyway" confirms the quit and
 * issues it again (`quit`), which the guard then lets through. A second quit while the box is up
 * is cancelled too. Under a runtime without message boxes (`host.confirm` rejects `unsupported`)
 * the quit is cancelled once and the next one, within a few seconds, goes through.
 */
export function guardQuit(
  host: Pick<DesktopExtensionHost, "onBeforeQuit" | "confirm">,
  quit: () => void = quitApp,
): () => void {
  let asking = false;
  const ask = async (busy: BusyTile[]) => {
    try {
      const choice = await host.confirm(quitQuestion(busy));
      workspaces.answerQuit(choice === 0);
      if (choice === 0) quit();
    } catch (err) {
      console.warn(
        "session: could not ask before quitting (quit again to quit)",
        err,
      );
      workspaces.answerQuit(true);
    }
  };
  return host.onBeforeQuit(() => {
    const decision = workspaces.beforeQuit();
    if (decision.allow) return true;
    if (!asking) {
      asking = true;
      void ask(decision.busy).finally(() => asking = false);
    }
    return false;
  });
}

/** How long after a Window-menu close the other windows' copies of that click are ignored. */
const MENU_CLICK_MS = 1000;

/** `endWindow` for one window: whether its page should close it now. */
export type EndWindow = (
  window: string,
  menu: boolean,
) => Promise<SessionEndWindow>;

/**
 * `endWindow`. From the Window menu ("Close Window and End Its Shells", no shortcut) every
 * window's page hears the click (Denext queues an application-menu click for every window), so
 * only the window used last acts, once per click; with a busy agent in its workspace the OS's
 * message box asks first. The workspace is ended once the page has closed the window
 * (`endOnClose`), so the close does not offer it in Reopen Closed Window again.
 */
export function createEndWindow(
  host: Pick<DesktopExtensionHost, "confirm">,
  now: () => number = Date.now,
): EndWindow {
  let asking = false;
  let acceptedAt = -Infinity;
  const fromMenu = async (window: string, id: string): Promise<boolean> => {
    if (
      asking || window !== workspaces.activeWindow() ||
      now() - acceptedAt < MENU_CLICK_MS
    ) {
      return false;
    }
    acceptedAt = now();
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
  return async (window, menu) => {
    const id = workspaces.workspaceOfWindow(window);
    if (id === undefined) return { close: false };
    if (menu && !(await fromMenu(window, id))) return { close: false };
    return { close: workspaces.endOnClose(id) };
  };
}

let endWindow: EndWindow | undefined;

export default defineDesktopExtension({
  name: "session",
  events: ["changed"],
  setup: (host) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    workspaces.onChanged(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        host.emit("changed", { workspaces: workspaces.list() });
      }, CHANGED_DEBOUNCE_MS);
    });
    quitWithLastWindow(host);
    guardQuit(host);
    endWindow = createEndWindow(host);
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
     * it now). `menu`: the Window menu's "Close Window and End Its Shells", heard by every window;
     * only the window used last acts, and a busy agent there is asked about first. Without it the
     * page asked already (the Workspaces menu's "End workspace").
     */
    endWindow: {
      input: endWindowInput,
      handler: (args: unknown, ctx): Promise<SessionEndWindow> => {
        if (!endWindow) {
          throw new DesktopCapError("unavailable", "session is not set up");
        }
        return endWindow(windowOf(ctx), (args as { menu: boolean }).menu);
      },
    },
  },
});
