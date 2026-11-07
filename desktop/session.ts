// The `session` desktop extension: the page's side of the workspace model (desktop/workspace-host.ts).
// A page joins the workspace its window shows (the window's key), gets back what it saved there
// before (tiles, layout, MRU order) and each of its terminals with their replay
// (desktop/terminal-sessions.ts), and saves its snapshot as it changes. The quit question ("agents
// are busy") is answered here; desktop.ts asks it.
//
// Events: `quit` (the question, to one window; desktop.ts sends it).

import {
  defineDesktopExtension,
  DesktopCapError,
  type DesktopExtensionHost,
} from "denext/desktop";
import { emptyInput, objectSchema } from "./schema.ts";
import { type QuitRequest, workspaces } from "./workspace-host.ts";
import { terminalSessions } from "./pty.ts";
import type { PtyReplay } from "./terminal-sessions.ts";

export type { PtyReplay, QuitRequest };

/** What `join` answers. */
export interface SessionJoin {
  workspace: { id: string; name: string };
  /** The page's last snapshot of this workspace (`null`: a new workspace, or a new launch). */
  snapshot: unknown;
  /** Its terminals, attached to the calling window, with their replay. */
  ptys: PtyReplay[];
  /** A quit question waiting for this window. */
  quit?: QuitRequest;
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

const answerInput = objectSchema<{ quit: boolean }>((v, issues) => {
  if (typeof v.quit !== "boolean") {
    issues.push({ message: "quit must be a boolean", path: ["quit"] });
  }
  return { quit: v.quit === true };
});

const windowOf = (ctx: { windowId?: string }) => ctx.windowId ?? "main";

/** Whether a window still shows the app (the tray panel does not count). */
function hasAppWindow(host: DesktopExtensionHost): boolean {
  return host.windows().some((w) => w.kind !== "panel");
}

/**
 * Off macOS there is no Dock to bring a windowless app back, so closing the last window quits
 * (through the quit guard, which asks when an agent is busy). On macOS the app stays up.
 */
function quitWithLastWindow(host: DesktopExtensionHost): void {
  host.onWindowClosed((info) => {
    if (info.appQuitting || host.os === "darwin" || hasAppWindow(host)) return;
    const desktop = (Deno as unknown as { desktop?: { quit?: () => void } })
      .desktop;
    try {
      desktop?.quit?.();
    } catch (err) {
      console.error("session: could not quit with the last window", err);
    }
  });
}

export default defineDesktopExtension({
  name: "session",
  events: ["quit"],
  setup: (host) => quitWithLastWindow(host),
  methods: {
    /** Show the calling window's workspace: its snapshot and its terminals, attached here. */
    join: {
      input: emptyInput,
      handler: (_args: unknown, ctx): SessionJoin => {
        const window = windowOf(ctx);
        const sessions = terminalSessions();
        const joined = workspaces.join(window, sessions.keyOf(window));
        const quit = workspaces.pendingQuit();
        return {
          workspace: { id: joined.id, name: joined.name },
          snapshot: joined.snapshot,
          ptys: sessions.attachWorkspace(joined.id, window),
          ...(quit ? { quit } : {}),
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
    /** The calling window took the focus (the companion talks to the active window). */
    focus: {
      input: emptyInput,
      handler: (_args: unknown, ctx): void => workspaces.focused(windowOf(ctx)),
    },
    /** The user answered the quit question; with `quit: true` the page then calls `quitApp()`. */
    answerQuit: {
      input: answerInput,
      handler: (args: unknown): void =>
        workspaces.answerQuit((args as { quit: boolean }).quit),
    },
  },
});
