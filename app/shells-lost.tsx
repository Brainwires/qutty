// The PTY daemon died while the app ran (desktop/kept-shells.ts) and took this window's kept shells
// with it: a strip at the bottom of the tile area (the broadcast banner's look) offers to start
// those tiles' shells again and resume the agents that ran in them. It never blocks: the tiles
// show they ended as before, and Dismiss leaves them so (Enter in a shell tile still restarts it).

import { useCallback, useEffect, useState } from "denext";
import type { LostShells } from "../lib/ptyd/live.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";

/** Listen for lost shells; the banner to show (or nothing). */
export function useShellsLost(
  manager: TerminalManager | null,
  tileIds: () => string[],
) {
  const [lost, setLost] = useState<LostShells | null>(null);
  useEffect(() => {
    if (!manager) return;
    return manager.backend.session.onShellsLost((l) => setLost(l));
  }, [manager]);
  const restart = useCallback(async () => {
    const l = lost;
    setLost(null);
    if (!manager || !l) return;
    const old = new Set(l.ptys);
    for (const id of tileIds()) {
      const before = manager.ptyId(id);
      if (!before || !old.has(before)) continue;
      await manager.restart(id);
      const now = manager.ptyId(id);
      if (now && now !== before) {
        await manager.backend.session.resumeLost(before, now).catch(() =>
          false
        );
      }
    }
  }, [manager, lost, tileIds]);
  if (!lost) return null;
  return (
    <ShellsLostBanner
      lost={lost}
      onRestart={() => void restart()}
      onDismiss={() => setLost(null)}
    />
  );
}

function ShellsLostBanner(
  props: { lost: LostShells; onRestart(): void; onDismiss(): void },
) {
  const { ptys, agents } = props.lost;
  const shells = `${ptys.length} shell${ptys.length === 1 ? "" : "s"}`;
  return (
    <div
      class="bcast-banner is-live"
      role="status"
      data-testid="shells-lost"
      onMouseDown={(e) => e.preventDefault()}
    >
      <span class="bcast-dot" aria-hidden="true" />
      <span class="bcast-text">
        The shell keeper stopped and {shells} ended.
      </span>
      <button
        type="button"
        class="btn-quiet"
        data-testid="shells-lost-restart"
        onClick={props.onRestart}
      >
        {agents > 0
          ? `Restart shells and resume ${agents} agent${
            agents === 1 ? "" : "s"
          }`
          : "Restart shells"}
      </button>
      <button
        type="button"
        class="btn-quiet"
        data-testid="shells-lost-dismiss"
        onClick={props.onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
