// Shared helpers for the `+` menu's submenus (app/launch-menu.tsx): Web Browser, Shell, SSH,
// Terminal and Coding (not a test module itself).

import type { App } from "./harness.ts";

/** The `+` menu's arrow, and the menu. */
export const ARROW = "[data-testid=bar-new-menu]";
export const MENU = "[data-testid=launch-menu]";

/** The `+` menu's submenus. */
export type LaunchSub = "web" | "shell" | "ssh" | "terminal" | "coding";

/** The row that opens submenu `sub`. */
export const subRow = (sub: LaunchSub) =>
  `[data-testid=launch-sub][data-sub="${sub}"]`;

/** Submenu `sub`, while it is open. */
export const submenu = (sub: LaunchSub) =>
  `[data-testid=launch-submenu][data-sub="${sub}"]`;

/** The submenu a launch entry is in, by its id (`shell:`, `agent:`, `ssh:`, `ollama:`). */
function subOf(entryId: string): LaunchSub {
  if (entryId.startsWith("shell:")) return "shell";
  if (entryId.startsWith("ssh:")) return "ssh";
  return "terminal";
}

/** Open the `+` menu (unless open) and its submenu `sub` (unless open), with clicks. */
export async function openSub(app: App, sub: LaunchSub): Promise<void> {
  if (!(await app.exists(MENU))) await app.click(ARROW);
  if (!(await app.exists(submenu(sub)))) await app.click(subRow(sub));
}

/** Click `selector` (a row of submenu `sub`) in the `+` menu, opening what it needs. */
export async function pickInSub(
  app: App,
  sub: LaunchSub,
  selector: string,
): Promise<void> {
  await openSub(app, sub);
  await app.click(`${submenu(sub)} ${selector}`);
}

/** Click launch entry `entryId` in its submenu of the `+` menu. */
export function pickEntry(app: App, entryId: string): Promise<void> {
  return pickInSub(
    app,
    subOf(entryId),
    `[data-testid=launch-item][data-id="${entryId}"]`,
  );
}
