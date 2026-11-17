// The workspace's half of the companion's web tools: it tells the hub which web tiles this window
// has (agents see them as tiles `web-<n>`, lib/hub/web-tiles.ts), and carries out the web
// commands the hub sends (open a web tile, navigate, read the page, click, type, …) with
// lib/web/web-control.ts, lending it the tiles, their mounted views and the workspace's actions.
// use-companion.ts hands it every `web` command it receives.

import { useCallback, useEffect, useMemo, useRef } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { ControlResult, WebCommand } from "../lib/hub/core.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import type { WebEngine, WebViewHandle } from "../lib/web/engine.ts";
import type { WebTileReport } from "../lib/hub/web-tiles.ts";
import { runWebCommand } from "../lib/web/web-control.ts";

export interface UseWebControlOptions {
  backend: PtyBackend | undefined;
  manager: TerminalManager | null;
  /** The workspace's tiles (the web ones are reported to the hub). */
  terminals: TerminalEntry[];
  /** The mounted web views by tile id (the workspace keeps them). */
  views: Map<string, WebViewHandle>;
  engine: WebEngine | null;
  /** Settings → Links → Home page. */
  home: string | undefined;
  /** Open a web tile on `url` beside the focused tile; its id. */
  openWebTile(url: string): string;
  closeTile(id: string): void;
  focusTile(id: string): void;
}

/** What the workspace wires in: the commands, and its views coming and going. */
export interface WebControl {
  run(command: WebCommand): Promise<ControlResult>;
  /** Tile `id`'s view mounted (or went: `null`). */
  onView(id: string, view: WebViewHandle | null): void;
}

export function useWebControl(opts: UseWebControlOptions): WebControl {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  /** Commands waiting for a tile's view to mount. */
  const waiters = useRef(new Map<string, Set<() => void>>());

  // The web tiles, sent whenever one comes, goes, or shows another page.
  const reports: WebTileReport[] = opts.terminals.flatMap((t) =>
    t.web
      ? [{
        id: t.id,
        url: t.web.url,
        ...(t.web.title ? { title: t.web.title } : {}),
      }]
      : []
  );
  const key = JSON.stringify(reports);
  const { backend } = opts;
  useEffect(() => {
    if (!backend) return;
    void backend.hubWebTiles(JSON.parse(key)).catch(() => {});
  }, [backend, key]);

  const onView = useCallback((id: string, view: WebViewHandle | null) => {
    if (!view) return;
    for (const wake of [...(waiters.current.get(id) ?? [])]) wake();
  }, []);

  const run = useCallback((command: WebCommand) => {
    const entry = (id: string) =>
      optsRef.current.terminals.find((t) => t.id === id);
    return runWebCommand(command, {
      engine: () => optsRef.current.engine,
      isWebTile: (id) => entry(id)?.web !== undefined,
      page: (id) => entry(id)?.web,
      home: () => optsRef.current.home || undefined,
      view: (id, signal) => {
        const now = optsRef.current.views.get(id);
        if (now || signal.aborted) return Promise.resolve(now);
        return new Promise((resolve) => {
          const set = waiters.current.get(id) ?? new Set();
          waiters.current.set(id, set);
          const done = () => {
            set.delete(done);
            if (set.size === 0) waiters.current.delete(id);
            signal.removeEventListener("abort", done);
            resolve(optsRef.current.views.get(id));
          };
          set.add(done);
          signal.addEventListener("abort", done);
        });
      },
      open: (url, beside) => {
        const o = optsRef.current;
        if (beside !== undefined) {
          // A tile id, or the PTY id of a terminal in this window.
          const near = entry(beside)?.id ??
            o.terminals.find((t) => o.manager?.ptyId(t.id) === beside)?.id;
          if (!near) return null;
          o.focusTile(near);
        }
        return o.openWebTile(url);
      },
      close: (id) => optsRef.current.closeTile(id),
      focus: (id) => optsRef.current.focusTile(id),
    });
  }, []);

  return useMemo(() => ({ run, onView }), [run, onView]);
}
