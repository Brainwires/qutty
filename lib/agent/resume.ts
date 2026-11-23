/**
 * Resuming coding agents after a full restart (a reboot, or the PTY daemon gone): the shells Qutty
 * kept do not survive that, but the agents' sessions do, on disk. The quit that keeps the shells
 * records, per terminal, the agent session running in it (desktop/kept-shells.ts, from the hub's
 * registry: the `session_id` Claude Code's and Codex's hooks send); the next launch starts the
 * tile's shell afresh and types the agent's resume command into it.
 *
 * The resume commands, checked against the CLIs' own `--help` (2026-11):
 *
 * - Claude Code: `claude --resume <session-id>` (`-r, --resume [value]  Resume a conversation by
 *   session ID`);
 * - Codex: `codex resume <SESSION_ID>` ("Session id (UUID) or session name"), which takes the
 *   same `-c key=value` overrides Qutty's hub wiring uses.
 *
 * Others are left alone: opencode has `--session <id>` but no hook or file that tells Qutty which
 * session a tile runs, and Gemini CLI, Qwen Code, Copilot, Cursor, Amp, Kimi and Droid tell the hub
 * no session id either. A tile the user marked "Don't resume this agent", a tile whose kept shell
 * survived (its agent still runs), and an agent that had quit back to its shell by the quit are
 * never resumed. More than {@linkcode RESUME_CAP} at once are asked about first.
 *
 * Pure.
 *
 * @module
 */

import { shellQuote } from "../hub/launch.ts";
import { isShellProcess } from "../workspace/harness.ts";

/** The agents Qutty can resume, by the hub's harness name. */
const RESUMABLE = ["claude", "codex"] as const;
export type ResumableAgent = typeof RESUMABLE[number];

/** The most agents resumed at once without asking. */
export const RESUME_CAP = 8;
/** How long after its shell starts the first resume command is typed (the shell's rc files). */
const RESUME_FIRST_DELAY_MS = 1500;
/** The gap between two resumes (eight agents starting at once would fight for the CPU). */
const RESUME_STAGGER_MS = 750;

/** One terminal's agent session, as the quit records it. */
export interface AgentIdentity {
  /** The hub's harness name (`claude`, `codex`). */
  harness: ResumableAgent;
  /** Its session id (from the hooks). */
  session: string;
  /** The agent's folder (the hook's `cwd`, else the terminal's). */
  cwd?: string;
  /** The user chose "Don't resume this agent". */
  noResume?: boolean;
}

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Whether `v` is a harness Qutty can resume. */
export function isResumable(v: unknown): v is ResumableAgent {
  return typeof v === "string" &&
    (RESUMABLE as readonly string[]).includes(v);
}

/** An identity from a record (untrusted), checked; `undefined` when it is not one. */
export function identityOf(v: unknown): AgentIdentity | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isResumable(o.harness)) return undefined;
  if (typeof o.session !== "string" || !SESSION_ID.test(o.session)) {
    return undefined;
  }
  return {
    harness: o.harness,
    session: o.session,
    ...(typeof o.cwd === "string" && o.cwd.startsWith("/")
      ? { cwd: o.cwd }
      : {}),
    ...(o.noResume === true ? { noResume: true } : {}),
  };
}

/** What the hub knows about a terminal at the quit. */
export interface TileAgentState {
  harness?: string;
  session?: string;
  cwd?: string;
  noResume?: boolean;
}

/**
 * The identity to record for a terminal at the quit: its hub tile has a resumable harness and a
 * session id, and the agent still runs (`process`, the foreground process, is not a shell: an
 * agent that had quit is not brought back).
 */
export function identityAtQuit(
  tile: TileAgentState | undefined,
  process: string | undefined,
  terminalCwd?: string,
): AgentIdentity | undefined {
  if (process === undefined || isShellProcess(process)) return undefined;
  return liveIdentity(tile, terminalCwd);
}

/**
 * The identity to keep in the live record (written as it changes, for a restart after a crash or
 * power loss): the hub tile's resumable harness and session id. The hub forgets a tile's session
 * when its agent quits back to the shell (lib/hub/screen-detect.ts), so a quit agent drops out.
 */
export function liveIdentity(
  tile: TileAgentState | undefined,
  terminalCwd?: string,
): AgentIdentity | undefined {
  if (!tile) return undefined;
  const cwd = tile.cwd ?? terminalCwd;
  return identityOf({
    harness: tile.harness,
    session: tile.session,
    ...(cwd ? { cwd } : {}),
    ...(tile.noResume ? { noResume: true } : {}),
  });
}

/** The resume arguments of `harness` for session `session`. */
export function resumeArgs(harness: ResumableAgent, session: string): string[] {
  switch (harness) {
    case "claude":
      return ["--resume", session];
    case "codex":
      return ["resume", session];
  }
}

/**
 * The line typed into a fresh shell to resume `agent`: `cd` to its folder, then the agent with
 * the hub's arguments (`hubArgs`, what an agent from the `+` picker gets) and the resume
 * arguments, then Enter. A tile that was the agent itself (`program`, from the `+` picker; its
 * arguments `args`) `exec`s it, so the tile ends with the agent as it did before; a shell tile
 * runs the bare command name, so the user's own alias for it applies.
 */
export function resumeLine(
  agent: AgentIdentity,
  hubArgs: readonly string[],
  program?: { path: string; args?: readonly string[] },
): string {
  const words = [
    ...(program ? ["exec", program.path, ...(program.args ?? [])] : [
      agent.harness,
    ]),
    ...hubArgs,
    ...resumeArgs(agent.harness, agent.session),
  ].map(shellQuote);
  const cd = agent.cwd ? `cd -- ${shellQuote(agent.cwd)} && ` : "";
  return `${cd}${words.join(" ")}\r`;
}

/** A terminal the restore could resume an agent in. */
export interface ResumeCandidate {
  /** Its old PTY id (the snapshot's). */
  ptyId: string;
  agent: AgentIdentity;
  /** Its kept shell survived (the daemon still had it): the agent is still running. */
  survived: boolean;
}

/** What the restore does. */
export interface ResumePlan<T extends ResumeCandidate> {
  /** Resumed without asking, in order. */
  resume: T[];
  /** Past {@linkcode RESUME_CAP}: resumed only if the user says so. */
  ask: T[];
}

/**
 * Which agents a restore resumes: none with the setting off; never one whose kept shell survived
 * or that the user marked "Don't resume"; at most {@linkcode RESUME_CAP} without asking.
 */
export function planResumes<T extends ResumeCandidate>(
  candidates: readonly T[],
  enabled: boolean,
): ResumePlan<T> {
  if (!enabled) return { resume: [], ask: [] };
  const want = candidates.filter((c) => !c.survived && !c.agent.noResume);
  return {
    resume: want.slice(0, RESUME_CAP),
    ask: want.slice(RESUME_CAP),
  };
}

/** When the `i`th resume (0-based) is typed, after its shell started. */
export function resumeDelay(i: number): number {
  return RESUME_FIRST_DELAY_MS + i * RESUME_STAGGER_MS;
}
