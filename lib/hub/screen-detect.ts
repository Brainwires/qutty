/**
 * Screen-based agent state, the fallback beside the hooks: which coding agent a terminal runs
 * (its foreground process against the detection manifests' process matchers,
 * lib/agent/detect/manifest.ts) and what it is doing (the bottom of the hub's screen mirror
 * against that manifest's `working` / `blocked` / `idle` matchers). The result goes into the
 * registry's status (busy / idle / waiting), which the badges, the overlay and the companion
 * already read.
 *
 * - Hooks stay authoritative. A tile whose current agent has sent a hook (Claude Code, Codex with
 *   Qutty's hooks) keeps the status its hooks set; the screen only fills in what they are silent
 *   about: an approval prompt on screen while the hooks last said busy makes it `waiting`, and
 *   once that prompt is gone the screen hands the status back (a rejected tool sends no hook).
 * - A tile without hooks (Gemini CLI, aider, opencode, …, or Claude Code without the integration)
 *   gets its status from the screen alone.
 * - Cost: only tiles whose foreground process is a known agent are read; output schedules one read
 *   at most every {@linkcode EVAL_EVERY_MS} (a spinner's steady output does not keep pushing it
 *   back), and a read looks at the bottom `lines` lines only. Nothing runs for a quiet tile.
 * - A harness the detector set from the process is cleared when the process quits back to its
 *   shell (or another program); one a hook or the launch set stays, as before.
 *
 * Pure: desktop/hub.ts gives it the registry, the mirrors and a timer.
 *
 * @module
 */

import {
  agentForProcess,
  type AgentManifest,
  type ForegroundProcess,
  readScreen,
  type ScreenState,
  type ScreenVerdict,
} from "../agent/detect/manifest.ts";
import type { AgentDetectionInfo, TileStatus } from "./protocol.ts";
import { isShellProcess } from "../workspace/harness.ts";

/** The longest a tile's output waits before its screen is read again. */
const EVAL_EVERY_MS = 250;

/** The hub status for a screen state. */
const STATUS_OF: Record<ScreenState, TileStatus> = {
  working: "busy",
  blocked: "waiting",
  idle: "idle",
};

/** What the detector needs (desktop/hub.ts; fakes in tests). */
export interface DetectorDeps {
  /** The manifests in force (the bundled ones under the user's own). */
  manifests(): readonly AgentManifest[];
  /** Tile `id`'s visible screen, top to bottom (`undefined`: it has none). */
  screen(id: string): Promise<string[]> | undefined;
  /** The registry's view of tile `id`. */
  tile(id: string): { harness?: string; status: TileStatus } | undefined;
  setStatus(id: string, status: TileStatus): void;
  setHarness(id: string, harness: string): void;
  clearHarness(id: string): void;
  /** Run `fn` in `ms` (the read's throttle); returns a cancel. */
  later(fn: () => void, ms: number): () => void;
}

/** What the debug command shows for a tile (the hub adds the refused user manifests). */
export type DetectionInfo = Omit<AgentDetectionInfo, "errors">;

interface TileState {
  fg?: ForegroundProcess;
  agent?: AgentManifest;
  via?: "process" | "harness";
  /** The detector set the registry's harness (from the process), so it may clear it. */
  ownsHarness: boolean;
  hooked: boolean;
  /** The status was last set from the screen (the screen may change it back). */
  ownsStatus: boolean;
  verdict?: ScreenVerdict;
  cancel?: () => void;
  /** A read is in flight. */
  reading: boolean;
}

/** The detector: one per hub. */
export class ScreenDetector {
  #deps: DetectorDeps;
  #tiles = new Map<string, TileState>();
  /** Where each manifest came from (`bundled` or a path), for the debug command. */
  #sources: (id: string) => string | undefined;

  constructor(
    deps: DetectorDeps,
    sources: (id: string) => string | undefined = () => "bundled",
  ) {
    this.#deps = deps;
    this.#sources = sources;
  }

  #state(id: string): TileState {
    let s = this.#tiles.get(id);
    if (!s) {
      s = {
        ownsHarness: false,
        hooked: false,
        ownsStatus: false,
        reading: false,
      };
      this.#tiles.set(id, s);
    }
    return s;
  }

  /**
   * Tile `id`'s foreground process changed (`undefined`: unknown). A known agent's process
   * starts the screen reads (and names the tile's harness); a shell or another program stops
   * them.
   */
  foreground(id: string, fg: ForegroundProcess | undefined): void {
    const s = this.#state(id);
    const before = s.agent?.id;
    s.fg = fg;
    const shell = fg !== undefined && isShellProcess(fg.name);
    const manifests = this.#deps.manifests();
    const byProcess = fg && !shell ? agentForProcess(manifests, fg) : undefined;
    const tile = this.#deps.tile(id);
    // A harness the hub has (a hook, the launch: `ollama launch claude` is `ollama` to the OS)
    // still names the agent while something other than a shell runs.
    const byHarness = !byProcess && !shell && fg !== undefined &&
        tile?.harness !== undefined && !s.ownsHarness
      ? manifests.find((m) => m.id === tile.harness)
      : undefined;
    const agent = byProcess ?? byHarness;
    if (agent?.id !== before) s.hooked = false;
    s.agent = agent;
    s.via = byProcess ? "process" : byHarness ? "harness" : undefined;
    s.verdict = agent?.id === before ? s.verdict : undefined;
    if (byProcess && tile && tile.harness !== byProcess.id) {
      this.#deps.setHarness(id, byProcess.id);
      s.ownsHarness = true;
    } else if (!agent && s.ownsHarness) {
      this.#deps.clearHarness(id);
      s.ownsHarness = false;
    }
    if (!agent) {
      s.cancel?.();
      s.cancel = undefined;
      // The agent quit: a status only the screen set goes back to idle.
      if (s.ownsStatus && tile && tile.status !== "idle") {
        this.#deps.setStatus(id, "idle");
      }
      s.ownsStatus = false;
    } else if (agent.id !== before) {
      this.#schedule(id, s);
    }
  }

  /** A hook of `harness` fired in tile `id`: the hooks own its status from now on. */
  hookSeen(id: string, harness?: string): void {
    const s = this.#state(id);
    if (!s.agent || !harness || harness === s.agent.id) {
      s.hooked = true;
      s.ownsStatus = false;
    }
  }

  /** Output arrived in tile `id`: read its screen soon (once per {@linkcode EVAL_EVERY_MS}). */
  data(id: string): void {
    const s = this.#tiles.get(id);
    if (!s?.agent || s.cancel) return;
    this.#schedule(id, s);
  }

  /** Tile `id` ended. */
  forget(id: string): void {
    this.#tiles.get(id)?.cancel?.();
    this.#tiles.delete(id);
  }

  /** Read tile `id`'s screen now (tests; the debug command). */
  async evaluate(id: string): Promise<ScreenVerdict | undefined> {
    const s = this.#tiles.get(id);
    if (!s?.agent) return undefined;
    const agent = s.agent;
    const screen = this.#deps.screen(id);
    if (!screen) return undefined;
    s.reading = true;
    let rows: string[];
    try {
      rows = await screen;
    } finally {
      s.reading = false;
    }
    // The agent changed (or the tile ended) while the screen was read.
    if (this.#tiles.get(id) !== s || s.agent !== agent) return undefined;
    const verdict = readScreen(agent, rows);
    s.verdict = verdict;
    this.#apply(id, s, verdict);
    return verdict;
  }

  #apply(id: string, s: TileState, verdict: ScreenVerdict): void {
    const tile = this.#deps.tile(id);
    if (!tile) return;
    const want = STATUS_OF[verdict.state];
    if (s.hooked) {
      // Hooks own the status: the screen only adds an approval prompt they did not report, and
      // takes back the `waiting` it set once the prompt is gone.
      if (verdict.state === "blocked") {
        if (tile.status !== "waiting") {
          this.#deps.setStatus(id, "waiting");
          s.ownsStatus = true;
        }
      } else if (s.ownsStatus) {
        s.ownsStatus = false;
        if (tile.status !== want) this.#deps.setStatus(id, want);
      }
      return;
    }
    s.ownsStatus = true;
    if (tile.status !== want) this.#deps.setStatus(id, want);
  }

  #schedule(id: string, s: TileState): void {
    if (s.cancel) return;
    s.cancel = this.#deps.later(() => {
      s.cancel = undefined;
      if (s.reading) {
        // The previous read is still going: try again after it.
        this.#schedule(id, s);
        return;
      }
      void this.evaluate(id).catch(() => {});
    }, EVAL_EVERY_MS);
  }

  /** What the debug command shows for tile `id`. */
  info(id: string): DetectionInfo {
    const s = this.#tiles.get(id);
    const tile = this.#deps.tile(id);
    return {
      tileId: id,
      ...(s?.fg ? { process: s.fg.name } : {}),
      ...(s?.fg?.argv ? { argv: [...s.fg.argv] } : {}),
      ...(s?.agent
        ? {
          agent: s.agent.id,
          manifest: this.#sources(s.agent.id) ?? "bundled",
          confidence: s.agent.confidence,
        }
        : {}),
      ...(s?.via ? { via: s.via } : {}),
      ...(s?.verdict ? { verdict: s.verdict } : {}),
      hooked: s?.hooked ?? false,
      ...(tile ? { status: tile.status } : {}),
    };
  }
}
