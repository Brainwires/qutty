/**
 * Workspace windows: a window's key is the id of the workspace it shows (desktop/workspace-host.ts),
 * so a window reopened with the same key — Reopen Closed Window, the session restored at launch,
 * the Dock, the Workspaces menu — shows the same workspace. Used by desktop.ts and by the page
 * (which opens a detached workspace's window itself). Client-safe and pure.
 *
 * @module
 */

import type { AppMenuItem } from "denext/desktop/app";

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

/** The id of the Window menu's "Close Window and End Its Shells" item. */
export const CLOSE_AND_END_ITEM = "qutty:window:close-end";

/**
 * The page's application menu: a "Window" submenu with "Close Window and End Its Shells" (no
 * keyboard shortcut), which Denext's own Window items (`desktop.menu.window`: New Window, Reopen
 * Closed Window, the open windows) join after a separator. `desktop.menu.window` takes no custom
 * items, so the page adds this one through `setAppMenu`.
 */
export function windowMenu(): AppMenuItem[] {
  return [{
    label: "Window",
    submenu: [{
      id: CLOSE_AND_END_ITEM,
      label: "Close Window and End Its Shells",
      destructive: true,
    }],
  }];
}

/** A workspace window's title (its label in the Window menu's lists). */
export function workspaceTitle(name: string): string {
  return `Qutty — ${name}`;
}
