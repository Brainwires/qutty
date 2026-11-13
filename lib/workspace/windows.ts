/**
 * Workspace windows: a window's key is the id of the workspace it shows (desktop/workspace-host.ts),
 * so a window reopened with the same key — Reopen Closed Window, the session restored at launch,
 * the Dock, the Workspaces menu — shows the same workspace. Used by desktop.ts and by the page
 * (which opens a detached workspace's window itself). Client-safe and pure.
 *
 * @module
 */

import { isMdiItem, type MdiItemId } from "./mdi-menu.ts";

/** What a workspace window opens with (denext's `windows.open` / `openWindow`). */
export interface WorkspaceWindowOptions {
  url: string;
  key: string;
  title: string;
  width?: number;
  height?: number;
}

/** A fresh workspace id (a valid window key: letters, digits and `-`). */
export function newWorkspaceId(
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(4)),
): string {
  const hex = [...random()].map((b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `ws-${hex}`;
}

/** The size a brand-new workspace window opens at. */
const NEW_WINDOW_SIZE = { width: 1400, height: 900 };

/**
 * The window that shows workspace `key`. A new workspace (`fresh`) gets a size; a known one gets
 * none, so denext restores the frame it last had (an explicit size would win over the saved one).
 */
export function workspaceWindow(
  key: string,
  fresh = false,
): WorkspaceWindowOptions {
  return { url: "/", key, title: "Qutty", ...(fresh ? NEW_WINDOW_SIZE : {}) };
}

/**
 * The id of the Window menu's "Close Window and End Its Shells" (no keyboard shortcut): one of
 * the app's own items (`desktop.menu.window.items` in denext.config.ts), whose clicks reach the
 * `session` extension with the key window (desktop/session.ts).
 */
export const CLOSE_AND_END_ITEM = "qutty:window:close-end";

/**
 * The Window menu's "Minimize Tile" (no keyboard shortcut: ⌘M stays the window's): the key
 * window's focused tile goes to the switcher bar. Its click reaches the `session` extension,
 * which hands it to that window's page (`tileMenu`, desktop/session.ts).
 */
export const MINIMIZE_TILE_ITEM = "qutty:tile:minimize";
/**
 * The Window menu's "Zoom Tile" (no shortcut): the focused tile is maximized (shown alone), or
 * restored to the tiled layout when it is maximized already, as the window menu's Zoom does.
 */
export const ZOOM_TILE_ITEM = "qutty:tile:zoom";

/** The tile items of the Window menu, as the page gets them. */
export type TileMenuItem = typeof MINIMIZE_TILE_ITEM | typeof ZOOM_TILE_ITEM;

/** Whether a Window-menu item id is one of the tile items. */
export function isTileMenuItem(id: unknown): id is TileMenuItem {
  return id === MINIMIZE_TILE_ITEM || id === ZOOM_TILE_ITEM;
}

/**
 * A Window-menu item the key window's page acts on: a tile item, or a view / arrange item of the
 * menu model (lib/workspace/mdi-menu.ts: "Tiled View", "Free-form View", "Cascade Tiles", ...).
 */
export type PageMenuItem = TileMenuItem | MdiItemId;

/** Whether a Window-menu item id is one the page acts on (see {@linkcode PageMenuItem}). */
export function isPageMenuItem(id: unknown): id is PageMenuItem {
  return isTileMenuItem(id) || isMdiItem(id);
}

/** A workspace window's title (its label in the Window menu's lists). */
export function workspaceTitle(name: string): string {
  return `Qutty — ${name}`;
}

/**
 * What a click on a window's close button does (Settings → Windows → "When a window closes"):
 * ask each time, keep its shells running for reattachment (the window detaches), or end them.
 */
export type WindowClose = "ask" | "keep" | "end";

/** Every {@linkcode WindowClose} choice, in the order Settings lists them. */
export const WINDOW_CLOSE_CHOICES: readonly WindowClose[] = [
  "ask",
  "keep",
  "end",
];

/** The default: ask each time. */
export const DEFAULT_WINDOW_CLOSE: WindowClose = "ask";

/** A stored (untrusted) choice; anything unknown is the default. */
export function sanitizeWindowClose(v: unknown): WindowClose {
  return WINDOW_CLOSE_CHOICES.includes(v as WindowClose)
    ? v as WindowClose
    : DEFAULT_WINDOW_CLOSE;
}

/** What the page does with a close request: see {@linkcode closeDecision}. */
export type CloseDecision = "allow" | "end" | "ask";

/**
 * What the page does with a close request (`denext/desktop/window`'s `onCloseRequested`):
 * `"allow"` lets the window close (it detaches: its shells keep running), `"end"` keeps it open
 * and ends its shells the way the Window menu's "Close Window and End Its Shells" does, `"ask"`
 * keeps it open and asks in the page.
 *
 * A quit is always allowed (the app's quit guard asks about busy agents). While the page is
 * already asking or ending (`busy`), another close is allowed: a second click on the close
 * button closes the window as before, detaching it.
 */
export function closeDecision(
  setting: WindowClose,
  reason: "close" | "quit",
  busy = false,
): CloseDecision {
  if (reason === "quit" || busy || setting === "keep") return "allow";
  return setting;
}

/** What {@linkcode createCloseGuard} acts through. */
export interface CloseGuardDeps {
  /** The current "When a window closes" setting. */
  setting(): WindowClose;
  /** Show the page's close question (answered through `settle`). */
  ask(): void;
  /** End the window's shells as the Window menu does (it resolves once that is done or declined). */
  end(): Promise<void>;
}

/**
 * The window's close guard: `request` answers a close request (`true`: let the window close)
 * after {@linkcode closeDecision}, and starts the question or the end. The guard stays busy until
 * the question is answered (`settle`) or the end is done, so a second close meanwhile goes
 * through.
 */
export function createCloseGuard(deps: CloseGuardDeps): {
  request(reason: "close" | "quit"): boolean;
  settle(): void;
} {
  let busy = false;
  return {
    request(reason) {
      const decision = closeDecision(deps.setting(), reason, busy);
      if (decision === "allow") return true;
      busy = true;
      if (decision === "ask") deps.ask();
      else {
        void deps.end()
          .catch((err) =>
            console.warn("could not end the window's shells", err)
          )
          .finally(() => busy = false);
      }
      return false;
    },
    settle() {
      busy = false;
    },
  };
}

/**
 * How old a Window-menu tile event may be when the page gets it. Denext replays retained events
 * to a page that subscribes later, so after a reload an old "Minimize Tile" click would otherwise
 * act again.
 */
export const TILE_MENU_MAX_AGE_MS = 2000;

/** Whether a tile menu event sent at `at` is still fresh at `now` (both ms since the epoch). */
export function isFreshTileMenu(at: unknown, now: number): boolean {
  return typeof at === "number" && Number.isFinite(at) &&
    now - at >= -TILE_MENU_MAX_AGE_MS &&
    now - at <= TILE_MENU_MAX_AGE_MS;
}
