// The app icon's badge (the Dock on macOS): how many tiles have an agent waiting for the user,
// across every window (lib/hub/badge.ts says what counts). Each window's page follows the hub's
// app-wide `tiles` event and sets the badge whenever its count changes; every page gets the same
// snapshot and the same synced settings, so they all set the same number. Settings → Agents →
// "Badge the app icon with waiting agents" off clears it. The backend skips a runtime with no
// badge (`appCapabilities().badge`), and the browser demo has none.
//
// It also tells the hub what the user has seen: while this window has the focus, its focused
// tile's finished turn (`attention`) is cleared in the hub (`hubSeen`), as soon as it is set or
// when the tile or the window gets the focus. The flag lives in the hub, so every window agrees.

import { useEffect, useState } from "denext";
import type { TileInfo } from "../lib/hub/protocol.ts";
import { badgeCount } from "../lib/hub/badge.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";

/** Whether this window has the focus now. */
function windowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

export function useDockBadge(
  manager: TerminalManager | null,
  enabled: boolean,
  /** The hub tile of this window's focused tile (`undefined`: none, or no agent hub). */
  focused: TileInfo | undefined,
): void {
  const [active, setActive] = useState(windowFocused);
  useEffect(() => {
    const sync = () => setActive(windowFocused());
    sync();
    globalThis.addEventListener("focus", sync);
    globalThis.addEventListener("blur", sync);
    return () => {
      globalThis.removeEventListener("focus", sync);
      globalThis.removeEventListener("blur", sync);
    };
  }, []);

  // The user is looking at the focused tile: its finished turn has been seen.
  const seenId = active && focused?.attention ? focused.id : null;
  useEffect(() => {
    if (!manager || seenId === null) return;
    void manager.backend.hubSeen(seenId).catch(() => {});
  }, [manager, seenId]);

  // `null` until the hub has said: a new window must not clear the others' badge while it loads.
  const [tiles, setTiles] = useState<readonly TileInfo[] | null>(null);

  useEffect(() => {
    if (!manager) return;
    let live = true;
    let heard = false;
    const off = manager.backend.onHubTiles((snapshot) => {
      heard = true;
      setTiles(snapshot.tiles);
    });
    // The snapshot only fills in what no event has told us yet (an event is newer).
    manager.backend.hubSnapshot().then(
      (snapshot) => {
        if (live && !heard) setTiles(snapshot.tiles);
      },
      () => {},
    );
    return () => {
      live = false;
      off();
    };
  }, [manager]);

  const count = tiles === null ? null : badgeCount(tiles, enabled);
  // Set once the tiles are known (a reload puts the current count back), then on each change.
  useEffect(() => {
    if (!manager || count === null) return;
    void manager.backend.setAppBadge(count).catch(() => {});
  }, [manager, count]);
}
