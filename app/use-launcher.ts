// The workspace's half of the `+` picker (app/launch-menu.tsx): what is installed (the backend's
// `launchables`, read at start-up and again whenever the menu opens), the saved SSH hosts, the
// menu's sections, what plain `+` opens, and starting an entry. The rules live in
// lib/launcher.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "denext";
import {
  flatEntries,
  type Launchables,
  type LaunchEntry,
  type LaunchHost,
  launchSections,
  plusEntry,
  type PlusOpens,
} from "../lib/launcher.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TerminalProfile } from "../lib/ssh-ui.ts";
import type { ConnectRequest } from "./connections-dialog.tsx";

export interface UseLauncherOptions {
  manager: TerminalManager | null;
  plusOpens: PlusOpens;
  lastLaunch: string | null;
  /** Open a tile running `profile` (the default login shell when omitted). */
  openTile(profile?: TerminalProfile): string | null;
  /** Open an SSH tile, as the Connections dialog does. */
  connect(request: ConnectRequest): void;
  /** Remember `entryId` as the last pick. */
  remember(entryId: string): void;
}

const NONE: Launchables = { shells: [], agents: [] };

export function useLauncher(opts: UseLauncherOptions) {
  const { manager } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [found, setFound] = useState<Launchables>(NONE);
  const [hosts, setHosts] = useState<LaunchHost[]>([]);

  /** Read what is installed and the saved hosts again (each failure leaves the old list). */
  const refresh = useCallback(() => {
    const backend = optsRef.current.manager?.backend;
    if (!backend) return;
    void backend.launchables().then(setFound, () => {});
    void backend.sshHosts().then(
      (r) =>
        setHosts(r.hosts.map((h) => ({
          alias: h.alias,
          ...(h.tint ? { tint: h.tint } : {}),
        }))),
      () => {},
    );
  }, []);

  useEffect(() => {
    if (manager) refresh();
  }, [manager, refresh]);

  const sections = useMemo(() => launchSections(found, hosts), [found, hosts]);
  const plus = plusEntry(
    opts.plusOpens,
    opts.lastLaunch,
    flatEntries(sections),
  );

  /** Start `entry` in a new tile; a pick from the menu is remembered as the last one. */
  const launch = useCallback((entry: LaunchEntry, remember = true) => {
    const o = optsRef.current;
    switch (entry.kind) {
      case "shell":
        o.openTile(
          entry.shell.isDefault
            ? { kind: "shell" }
            : { kind: "shell", shell: entry.shell.path },
        );
        break;
      case "agent":
        o.openTile({
          kind: "agent",
          program: entry.agent.path,
          name: entry.agent.name,
          label: entry.agent.label,
        });
        break;
      case "ssh":
        o.connect({
          target: { alias: entry.host.alias },
          label: entry.host.alias,
          ...(entry.host.tint ? { tint: entry.host.tint } : {}),
        });
        break;
    }
    if (remember) o.remember(entry.id);
  }, []);

  const plusRef = useRef(plus);
  plusRef.current = plus;
  /** Plain `+` (and ⌘T): what Settings says, else the default shell. */
  const openPlus = useCallback(() => {
    const entry = plusRef.current;
    if (entry) launch(entry, false);
    else optsRef.current.openTile();
  }, [launch]);

  return { sections, plus, refresh, launch, openPlus };
}
