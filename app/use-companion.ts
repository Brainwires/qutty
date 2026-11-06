// The workspace's half of the companion: its settings sent to the hub (whether the brain may run,
// and its model), and the commands the companion sends the page — spawn a tile (the login shell
// or a `+` picker entry), close one, focus one — carried out here, where the tiles live, and
// answered with the new tile's PTY id or the reason it could not be done.

import { useEffect, useRef } from "denext";
import { flatEntries, type LaunchSection } from "../lib/launcher.ts";
import type { ControlRequest, PtyBackend } from "../lib/pty-client.ts";
import type { ControlResult } from "../lib/hub/core.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TerminalProfile } from "../lib/ssh-ui.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import {
  type CompanionSettings,
  effectiveMode,
} from "../lib/companion/settings.ts";

/** How long a spawned tile may take to get its PTY. */
const SPAWN_WAIT_MS = 8_000;

export interface UseCompanionOptions {
  manager: TerminalManager | null;
  settings: CompanionSettings;
  terminals(): TerminalEntry[];
  sections: LaunchSection[];
  openTile(profile?: TerminalProfile): string | null;
  /** Start an SSH picker entry (through the Connections flow). */
  launchSsh(entryId: string): boolean;
  closeTile(id: string): void;
  focusTile(id: string): void;
}

/** The workspace terminal whose PTY is `ptyId`. */
function byPty(
  manager: TerminalManager,
  terminals: TerminalEntry[],
  ptyId: string,
): string | undefined {
  return terminals.find((t) => manager.ptyId(t.id) === ptyId)?.id;
}

/** Wait until terminal `id` has a PTY (its spawn resolved); its id, or `null`. */
async function ptyOf(
  manager: TerminalManager,
  id: string,
): Promise<string | null> {
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    const pty = manager.ptyId(id);
    if (pty) return pty;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

export function useCompanion(opts: UseCompanionOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const backend: PtyBackend | undefined = opts.manager?.backend;

  // The brain runs only while the companion is shown and its brain is on.
  const { brain, model, mode } = opts.settings;
  const enabled = brain && effectiveMode(mode) !== "off";
  useEffect(() => {
    if (!backend) return;
    void backend.companionConfigure(enabled, model).catch(() => {});
  }, [backend, enabled, model]);

  useEffect(() => {
    if (!backend) return;
    const run = async ({ command }: ControlRequest): Promise<ControlResult> => {
      const o = optsRef.current;
      const manager = o.manager;
      if (!manager) return { ok: false, error: "the window is not ready" };
      switch (command.kind) {
        case "spawn": {
          const entry = command.profile
            ? flatEntries(o.sections).find((e) => e.id === command.profile)
            : undefined;
          if (command.profile && !entry) {
            return {
              ok: false,
              error:
                `no + picker entry "${command.profile}" (ids look like shell:/bin/zsh, agent:claude, ssh:host)`,
            };
          }
          if (entry?.kind === "ssh") {
            return o.launchSsh(entry.id)
              ? { ok: true }
              : { ok: false, error: "could not open the SSH tile" };
          }
          const profile: TerminalProfile | undefined = entry?.kind === "agent"
            ? {
              kind: "agent",
              program: entry.agent.path,
              name: entry.agent.name,
              label: entry.agent.label,
            }
            : entry?.kind === "shell" && !entry.shell.isDefault
            ? { kind: "shell", shell: entry.shell.path }
            : undefined;
          const id = o.openTile(profile);
          if (!id) return { ok: false, error: "could not open a tile" };
          const pty = await ptyOf(manager, id);
          return pty
            ? { ok: true, tileId: pty }
            : { ok: false, error: "the new tile did not start" };
        }
        case "close":
        case "focus": {
          const id = byPty(manager, o.terminals(), command.tileId);
          if (!id) {
            return { ok: false, error: "that tile is not in this window" };
          }
          if (command.kind === "close") o.closeTile(id);
          else o.focusTile(id);
          return { ok: true };
        }
      }
    };
    return backend.onHubControl((request) => {
      run(request).catch((e) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      })).then((result) =>
        backend.hubControlDone(request.requestId, result).catch(() => {})
      );
    });
  }, [backend]);
}
