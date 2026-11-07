/**
 * Workspace windows: a window's key is the id of the workspace it shows (desktop/workspace-host.ts),
 * so a window reopened with the same key — Reopen Closed Window, the Dock — shows the same
 * workspace. Used by desktop.ts. Client-safe and pure.
 *
 * @module
 */

/** What a workspace window opens with (denext's `windows.open` / `openWindow`). */
export interface WorkspaceWindowOptions {
  url: string;
  key: string;
  title: string;
}

/** The main window's workspace (`desktop.window.key`). */
export const MAIN_WORKSPACE = "main";

/** The window that shows workspace `key` (denext restores the frame it last had). */
export function workspaceWindow(key: string): WorkspaceWindowOptions {
  return { url: "/", key, title: "Qutty" };
}
