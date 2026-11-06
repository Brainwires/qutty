// The workspace's view of the agent hub: the hub's tiles (from its snapshot, then every `tiles`
// event), looked up by workspace terminal id for the tile badges. The hub keys tiles by PTY id
// (`pty-3`), the workspace by its own ids (`t2`); the terminal manager knows which PTY runs in
// which terminal (and that changes on a restart), so the lookup goes through it at render time.
//
// It also keeps the hub's labels in step with the tiles' titles (agents see them in
// `list_peers`): a title that differs from the hub's label is sent after a short pause, so a
// title that changes on every poll does not flood the bridge.

import { useCallback, useEffect, useMemo, useState } from "denext";
import type { TileInfo } from "../lib/hub/protocol.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";

/** How long a new title must hold before it is sent to the hub. */
const LABEL_DEBOUNCE_MS = 500;
/** The hub's limit for a label. */
const MAX_LABEL = 200;

/** The hub tile for workspace terminal `id` (`undefined`: none, or the hub is not running). */
export type HubTileOf = (id: string) => TileInfo | undefined;

export function useHub(
  manager: TerminalManager | null,
  terminals: TerminalEntry[],
): HubTileOf {
  const [tiles, setTiles] = useState<TileInfo[]>([]);

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

  const byPty = useMemo(
    () => new Map(tiles.map((t) => [t.id, t])),
    [tiles],
  );

  // Send titles the hub does not have yet (keyed on the titles, not on every activity flag).
  const titles = terminals.map((t) => `${t.id}\u0000${t.title}`).join("\u0001");
  useEffect(() => {
    if (!manager) return;
    const stale: [string, string][] = [];
    for (const entry of terminals) {
      const ptyId = manager.ptyId(entry.id);
      const tile = ptyId ? byPty.get(ptyId) : undefined;
      const label = entry.title.slice(0, MAX_LABEL);
      if (ptyId && tile && label !== "" && tile.label !== label) {
        stale.push([ptyId, label]);
      }
    }
    if (stale.length === 0) return;
    const timer = setTimeout(() => {
      for (const [ptyId, label] of stale) {
        void manager.backend.hubSetLabel(ptyId, label).catch(() => {});
      }
    }, LABEL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `terminals` is read through `titles`: only a title change matters here.
  }, [manager, byPty, titles]);

  return useCallback((id: string) => {
    const ptyId = manager?.ptyId(id);
    return ptyId ? byPty.get(ptyId) : undefined;
  }, [manager, byPty]);
}
