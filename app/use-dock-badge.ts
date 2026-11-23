// The app icon's badge (the Dock on macOS): how many tiles have an agent waiting for the user,
// across every window (lib/hub/badge.ts says what counts). Each window's page follows the hub's
// app-wide `tiles` event and sets the badge whenever its count changes; every page gets the same
// snapshot and the same synced settings, so they all set the same number. Settings → Agents →
// "Badge the app icon" off clears it. The backend skips a runtime with no badge
// (`appCapabilities().badge`), and the browser demo has none.

import { useEffect, useState } from "denext";
import type { TileInfo } from "../lib/hub/protocol.ts";
import { badgeCount } from "../lib/hub/badge.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";

export function useDockBadge(
  manager: TerminalManager | null,
  enabled: boolean,
): void {
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
