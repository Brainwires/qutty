/**
 * Workspace windows: a window's key is the id of the workspace it shows (desktop/workspace-host.ts),
 * so a window reopened with the same key — Reopen Closed Window, the session restored at launch,
 * the Dock, the Workspaces menu — shows the same workspace. Used by desktop.ts and by the page
 * (which opens a detached workspace's window itself). Client-safe and pure.
 *
 * @module
 */

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
