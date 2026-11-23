/**
 * The app icon's badge (the Dock on macOS; Denext's `setBadge`): how many tiles have an agent
 * waiting for the user, as iTerm2 counts Claude Code sessions at a prompt. Client-safe and pure:
 * the page (app/use-dock-badge.ts) feeds it the hub's snapshot.
 *
 * A tile counts when either holds:
 *
 * - its status is `waiting`: Claude Code's `Notification` hook for a permission prompt, an
 *   elicitation dialog or `agent_needs_input`, Codex's `PermissionRequest`, an approval prompt
 *   screen detection sees, an open `ask_user` question, or `set_status waiting` (lib/hub/hooks.ts,
 *   core.ts, screen-detect.ts). It counts until the agent leaves `waiting`, seen or not;
 * - its `attention` is set: the agent finished a turn (busy → idle) or Claude Code sent
 *   `idle_prompt`, and it waits at its prompt for a user who has not looked at the tile since. As
 *   iTerm2 does, looking clears it: the tile having the focus in the front window (the hub's
 *   `seen`), or the agent getting busy again.
 *
 * An idle shell and a busy agent do not count. Web tiles have no agent.
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
    if (t.kind !== "web" && (t.status === "waiting" || t.attention === true)) {
      n++;
    }
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
