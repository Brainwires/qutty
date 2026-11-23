/**
 * The app icon's badge (the Dock on macOS; Denext's `setBadge`): how many tiles have an agent
 * waiting for the user, as iTerm2 counts Claude Code sessions at a prompt. Client-safe and pure:
 * the page (app/use-dock-badge.ts) feeds it the hub's snapshot.
 *
 * What counts is the hub's `waiting` status and nothing else: Claude Code's `Notification` hook
 * for a permission prompt, an elicitation dialog or `agent_needs_input`, Codex's
 * `PermissionRequest`, an approval prompt screen detection sees, or `set_status waiting`
 * (lib/hub/hooks.ts, core.ts, screen-detect.ts). Claude Code's `idle_prompt` (finished, at its
 * prompt) is `idle` there and is not counted, nor is an idle shell or a busy agent. A tile stays
 * counted until its agent leaves `waiting`, focused or not. Web tiles have no agent.
 *
 * The hub's snapshot holds every tile of the app (every window, and workspaces running with
 * their window closed), and every window gets the same `tiles` event, so every page works out
 * the same count: the badge is app-wide and their calls agree.
 *
 * @module
 */

import type { TileInfo } from "./protocol.ts";

/** How many tiles have an agent waiting for the user. */
export function waitingCount(tiles: readonly TileInfo[]): number {
  let n = 0;
  for (const t of tiles) {
    if (t.kind !== "web" && t.status === "waiting") n++;
  }
  return n;
}

/** The count the badge shows: {@linkcode waitingCount}, or 0 (no badge) while it is turned off. */
export function badgeCount(
  tiles: readonly TileInfo[],
  enabled: boolean,
): number {
  return enabled ? waitingCount(tiles) : 0;
}
