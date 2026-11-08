/**
 * Loopy's reactions to the tiles' work (Settings → Companion → Reactions): a hop of joy (the
 * example's `success` mood, its `celebrate` move) when a long job finishes well, a brief sad face
 * when one fails. Two signals:
 *
 * - shell tiles: the shell integration marks (OSC 133, lib/shell-marks.ts) say when a command
 *   ended, with its exit status and how long it ran. Only commands that ran at least the minimum
 *   (default 20 s) count, and only build- or test-like ones ({@linkcode isBuildLike}) unless
 *   "any long command" is on; full-screen and interactive programs (an editor, `ssh`, `top`)
 *   never count, and neither does a command the user stopped (Ctrl-C: exit 130, or another
 *   signal's 128 + n);
 * - agent tiles: the hub's `set_status` notes (lib/hub/core.ts): a note that reports success
 *   ("tests passed", "build ok") or failure ("build failed", lib/voice/alerts.ts
 *   `isFailureNote`), when it changes.
 *
 * At most one reaction of a kind this often ({@linkcode REACT_EVERY_MS}), so a loop of failing
 * builds does not keep Loopy sad. Whether it shows at all is the face's priority
 * (lib/companion/loopy-priority.ts): never over a question, thinking or a voice turn.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { TileInfo } from "../hub/protocol.ts";
import { isFailureNote, seenBefore } from "../voice/alerts.ts";
import type { CommandDone } from "../shell-marks.ts";

/** What Loopy does about a finished job. */
export type ReactionKind = "celebrate" | "sad";

/** A reaction, as the overlay receives it. */
export interface Reaction {
  /** Unique per reaction (the overlay plays each once). */
  readonly id: string;
  readonly kind: ReactionKind;
  /** The tile's name, as the bubble says it. */
  readonly tile: string;
  /** The bubble's line: `✓ shell-2: cargo test (1m 4s)`, `✗ shell-2: make failed (exit 2)`. */
  readonly text: string;
  /** The spoken line (Settings → Voice alerts). */
  readonly spoken: string;
  /** Where it came from: a shell command, or an agent's status note. */
  readonly source: "shell" | "agent";
}

/** Settings → Companion → Reactions, as the rules read them. */
export interface ReactionRules {
  readonly celebrate: boolean;
  readonly sad: boolean;
  /** Seconds a shell command must run to count. */
  readonly minDurationS: number;
  /** Count every long command, not only build- and test-like ones. */
  readonly anyLongCommand: boolean;
}

/** Programs that build, test, check or install: their long runs are worth a reaction. */
const BUILD_LIKE = new RegExp(
  "^(?:" + [
    "make",
    "gmake",
    "cmake",
    "ninja",
    "meson",
    "bazel(?:isk)?",
    "buck2?",
    "cargo",
    "rustc",
    "go",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "bun",
    "bunx",
    "deno",
    "node",
    "tsc",
    "jest",
    "vitest",
    "mocha",
    "playwright",
    "cypress",
    "pytest",
    "py\\.test",
    "tox",
    "nox",
    "python3?",
    "pip3?",
    "uv",
    "poetry",
    "gradlew?",
    "mvnw?",
    "sbt",
    "ant",
    "xcodebuild",
    "swift",
    "xcrun",
    "fastlane",
    "pod",
    "dotnet",
    "msbuild",
    "mix",
    "rebar3",
    "rake",
    "bundle",
    "rspec",
    "rails",
    "php",
    "composer",
    "phpunit",
    "ctest",
    "flutter",
    "dart",
    "zig",
    "stack",
    "cabal",
    "nix",
    "nix-build",
    "docker",
    "podman",
    "terraform",
    "ansible-playbook",
    "brew",
    "apt(?:-get)?",
    "dnf",
    "pacman",
  ].join("|") + ")$",
);

/** A word in the command line that says it builds or tests (`./run-tests.sh`, `just build`). */
const BUILD_WORD =
  /\b(?:build|test|tests|check|lint|compile|bundle|install|ci|release|deploy|e2e|bench)\b/i;

/** Programs that hold the terminal for as long as you use them: how long they ran says nothing. */
const INTERACTIVE = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "emacs",
  "hx",
  "helix",
  "micro",
  "less",
  "more",
  "man",
  "top",
  "htop",
  "btop",
  "ssh",
  "mosh",
  "telnet",
  "tmux",
  "screen",
  "zellij",
  "watch",
  "tail",
  "journalctl",
  "claude",
  "codex",
  "gemini",
  "aider",
  "ollama",
  "python",
  "python3",
  "node",
  "deno",
  "irb",
  "ghci",
  "psql",
  "mysql",
  "sqlite3",
  "redis-cli",
  "lazygit",
  "tig",
  "ranger",
  "nnn",
  "yazi",
  "mc",
  "fzf",
  "sleep",
  "read",
  "cat",
]);

/** Leading words that run the next one (`sudo make`, `time cargo test`, `env A=1 npm test`). */
const WRAPPERS = new Set([
  "sudo",
  "time",
  "env",
  "nice",
  "nohup",
  "command",
  "exec",
  "caffeinate",
]);

/** The program a command line runs: the first word after wrappers and `VAR=value`s. */
export function programOf(
  command: string,
): { program: string; rest: string[] } {
  const words = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (
    i < words.length &&
    (WRAPPERS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) ||
      (words[i].startsWith("-") && i > 0 && WRAPPERS.has(words[i - 1])))
  ) i++;
  const program = (words[i] ?? "").replace(/^.*\//, "");
  return { program, rest: words.slice(i + 1) };
}

/** Whether a command line looks like a build, a test run, a check or an install. */
export function isBuildLike(command: string): boolean {
  const { program, rest } = programOf(command);
  if (!program) return false;
  // A bare REPL (`node`, `python`, `deno` alone) is not a build.
  if (INTERACTIVE.has(program) && rest.length === 0) return false;
  if (BUILD_LIKE.test(program)) return true;
  return BUILD_WORD.test(command);
}

/**
 * Whether a command holds the terminal interactively (an editor, a pager, a remote shell, an
 * agent, a REPL): its run time is how long it was used, not a job.
 */
export function isInteractive(command: string): boolean {
  const { program, rest } = programOf(command);
  if (!INTERACTIVE.has(program)) return false;
  // `node build.js`, `python -m pytest`, `deno task test` run something: not interactive.
  const scriptLike = ["node", "deno", "python", "python3"].includes(program);
  return !scriptLike || rest.length === 0;
}

/** Whether an exit status means the user stopped it (Ctrl-C's 130, a signal's 128 + n). */
export function stoppedByUser(exitCode: number): boolean {
  return exitCode === 130 || exitCode === 143 || exitCode === 137 ||
    exitCode === 129 || exitCode === 131;
}

/** "45 s", "1m 4s", "2h 3m". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The command as the bubble shows it: its first 40 characters. */
function shortCommand(command: string): string {
  return command.length > 40 ? `${command.slice(0, 39)}…` : command;
}

/** Whether a finished shell command earns a reaction, and which. */
export function commandReactionKind(
  done: CommandDone,
  rules: ReactionRules,
): ReactionKind | null {
  const command = done.command?.trim();
  if (!command || done.durationMs === null || done.exitCode === null) {
    return null;
  }
  if (done.durationMs < rules.minDurationS * 1000) return null;
  if (isInteractive(command)) return null;
  if (!rules.anyLongCommand && !isBuildLike(command)) return null;
  if (done.exitCode === 0) return rules.celebrate ? "celebrate" : null;
  if (stoppedByUser(done.exitCode)) return null;
  return rules.sad ? "sad" : null;
}

/** The reaction to a finished shell command in tile `tile` (`null`: none). */
export function commandReaction(
  done: CommandDone,
  tile: string,
  rules: ReactionRules,
  id: string,
): Reaction | null {
  const kind = commandReactionKind(done, rules);
  if (!kind) return null;
  const cmd = shortCommand(done.command!.trim());
  const took = formatDuration(done.durationMs!);
  return kind === "celebrate"
    ? {
      id,
      kind,
      tile,
      source: "shell",
      text: `✓ ${tile}: ${cmd} (${took})`,
      spoken: `${spokenTile(tile)}: ${spokenProgram(cmd)} finished.`,
    }
    : {
      id,
      kind,
      tile,
      source: "shell",
      text: `✗ ${tile}: ${cmd} failed (exit ${done.exitCode})`,
      spoken: `${spokenTile(tile)}: ${spokenProgram(cmd)} failed.`,
    };
}

/** A note that reports success: "tests passed", "build ok", "all green", "deployed". */
const SUCCESS =
  /\b(?:pass(?:ed|es|ing)?|succeed(?:ed|s)?|success(?:ful(?:ly)?)?|ok(?:ay)?|green|done|finished|complete[d]?|deployed|merged|shipped|built)\b|✓|✅/i;

/** Whether a status note reports success (and no failure: "2 passed, 1 failed" is a failure). */
export function isSuccessNote(note: string | undefined): boolean {
  return note !== undefined && !isFailureNote(note) && SUCCESS.test(note);
}

/** A tile's name as it is said: `shell-2` → "shell 2". */
function spokenTile(tile: string): string {
  return tile.replace(/[-_]+/g, " ").trim() || "a tile";
}

/** The program as it is said: `cargo test --release` → "cargo test". */
function spokenProgram(cmd: string): string {
  return cmd.split(/\s+/).slice(0, 2).join(" ");
}

/**
 * The reactions between two hub snapshots: an agent tile whose status note changed to one that
 * reports success or failure. A tile seen for the first time gives none (opening the app is not
 * news).
 */
export function tileReactions(
  prev: readonly TileInfo[],
  next: readonly TileInfo[],
  rules: Pick<ReactionRules, "celebrate" | "sad">,
  idFor: (tile: TileInfo) => string,
): Reaction[] {
  const out: Reaction[] = [];
  for (const [was, tile] of seenBefore(prev, next)) {
    if (tile.note === was.note || !tile.note) continue;
    const kind: ReactionKind | null = isFailureNote(tile.note)
      ? (rules.sad ? "sad" : null)
      : isSuccessNote(tile.note)
      ? (rules.celebrate ? "celebrate" : null)
      : null;
    if (!kind) continue;
    const name = tile.name;
    out.push({
      id: idFor(tile),
      kind,
      tile: name,
      source: "agent",
      text: `${kind === "celebrate" ? "✓" : "✗"} ${name}: ${tile.note}`,
      spoken: `${spokenTile(tile.name)}: ${tile.note}.`,
    });
  }
  return out;
}

// --- rate limit -----------------------------------------------------------------------------

/** At most one reaction of a kind this often, ms. */
export const REACT_EVERY_MS: Readonly<Record<ReactionKind, number>> = {
  celebrate: 15_000,
  sad: 60_000,
};

/** When each kind last played (ms; `null`: never). */
export type ReactionClock = Readonly<Record<ReactionKind, number | null>>;

export const NEVER_REACTED: ReactionClock = { celebrate: null, sad: null };

/** Whether a reaction of `kind` may play at `now`, and the clock after it does. */
export function mayReact(
  clock: ReactionClock,
  kind: ReactionKind,
  now: number,
): { ok: boolean; clock: ReactionClock } {
  const last = clock[kind];
  if (last !== null && now - last < REACT_EVERY_MS[kind]) {
    return { ok: false, clock };
  }
  return { ok: true, clock: { ...clock, [kind]: now } };
}

/** How long each reaction's face stays, ms (the hop is the `celebrate` move's 1.2 s, then a smile). */
export const REACTION_MS: Readonly<Record<ReactionKind, number>> = {
  celebrate: 2_400,
  sad: 3_200,
};

/** Whether the reaction is said aloud: only with the matching voice alert on, and nothing being said. */
export function maySpeakReaction(
  reaction: Pick<Reaction, "kind" | "source">,
  alerts: { alertFinished: boolean; alertBuildFailed: boolean },
  speaking: boolean,
): boolean {
  // Agents' notes already have their own spoken alerts (lib/voice/alerts.ts).
  if (reaction.source !== "shell" || speaking) return false;
  return reaction.kind === "celebrate"
    ? alerts.alertFinished
    : alerts.alertBuildFailed;
}
