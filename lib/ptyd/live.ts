/**
 * The live record of the session: the same shape as the record a quit that keeps the shells
 * writes (lib/ptyd/kept.ts: each workspace's page snapshot and its terminals, with the agent
 * session each one runs), but written as it changes (desktop/kept-shells.ts), so a launch after a
 * crash, a kernel panic or a power loss (no quit wrote anything) still finds the tiles and their
 * agents. A clean exit removes it; finding it at launch means the last exit was not clean.
 *
 * Also the plan when the PTY daemon dies while the app runs: which ended tiles to start again and
 * whose agents to resume.
 *
 * Pure.
 *
 * @module
 */

import { planResumes } from "../agent/resume.ts";
import type { KeptRecord } from "./kept.ts";
import { respawnPlan, type ShellRespawn } from "./kept.ts";

/** The live record's file, in the app-support folder. */
export const LIVE_FILE = "live-session.json";
/** How long changes gather before the live record is written (one write for a burst). */
const LIVE_WRITE_MS = 1000;

/**
 * Coalesces writes: the first `poke` schedules one `write` in `ms`; pokes before it runs join it
 * (the write reads the state then, so nothing is lost). After `stop`, nothing more is written.
 */
export class CoalescedWriter {
  #write: () => void;
  #later: (fn: () => void, ms: number) => void;
  #ms: number;
  #pending = false;
  #stopped = false;

  constructor(
    write: () => void,
    later: (fn: () => void, ms: number) => void,
    ms = LIVE_WRITE_MS,
  ) {
    this.#write = write;
    this.#later = later;
    this.#ms = ms;
  }

  /** Something changed. */
  poke(): void {
    if (this.#pending || this.#stopped) return;
    this.#pending = true;
    this.#later(() => {
      this.#pending = false;
      if (!this.#stopped) this.#write();
    }, this.#ms);
  }

  /** No more writes (the app is exiting cleanly). */
  stop(): void {
    this.#stopped = true;
  }
}

/** One workspace's terminals the daemon took with it. */
export interface LostShells {
  workspace: string;
  /** The ended terminals' PTY ids, whose tiles start a fresh shell. */
  ptys: string[];
  /** How many of them get their agent resumed. */
  agents: number;
}

/**
 * The daemon died while the app ran: per workspace, the shell tiles whose terminal was in it
 * (`remote`) and so ended, and the agents to resume in them (the setting on, at most eight; an
 * agent tile from the `+` picker is left ended: its restart would start a new session). From the
 * last live `record`.
 */
export function lostShellsPlan(
  record: KeptRecord,
  remote: ReadonlySet<string>,
  resumeOn: boolean,
): { lost: LostShells[]; resume: ShellRespawn[] } {
  const per = record.workspaces.map((ws) => ({
    ws,
    plan: respawnPlan(ws).filter((r) => remote.has(r.ptyId) && !r.program),
  })).filter((p) => p.plan.length > 0);
  const { resume } = planResumes(
    per.flatMap((p) =>
      p.plan.flatMap((r) =>
        r.agent ? [{ ptyId: r.ptyId, agent: r.agent, survived: false, r }] : []
      )
    ),
    resumeOn,
  );
  const chosen = new Set(resume.map((c) => c.r));
  return {
    lost: per.map(({ ws, plan }) => ({
      workspace: ws.id,
      ptys: plan.map((r) => r.ptyId),
      agents: plan.filter((r) => chosen.has(r)).length,
    })),
    resume: [...chosen],
  };
}
