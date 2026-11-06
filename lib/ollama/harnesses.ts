/**
 * The terminal harnesses `ollama launch` can start (Ollama 0.40: `ollama launch --help`), how a
 * tile's command line is built, and which harnesses the picker offers for a model.
 *
 * `ollama launch <harness> --model <model> [-- <extra args>]` configures the harness for the
 * local Ollama server (environment variables, its own config files, or flags) and starts it,
 * passing the extra arguments after `--` on to the harness verbatim: that is where Qutty's hub
 * flags go (desktop/pty.ts appends them; lib/hub/wiring.ts says which). The desktop and GUI
 * integrations (`chatgpt`, `hermes-desktop`, `vscode`, `claude-desktop`) are not terminal
 * harnesses and are left out.
 *
 * Every harness's program has the integration's own name (`ollama launch` looks it up on `PATH`
 * and offers to install a missing one, which needs a confirmation the tile can answer).
 *
 * Pure and client-safe.
 *
 * @module
 */

import type { AgentProfile } from "../ssh-ui.ts";

/** A terminal harness of `ollama launch`. */
export interface OllamaHarnessSpec {
  /** The integration name, which is also its program's name. */
  name: string;
  /** What `ollama launch --help` calls it. */
  label: string;
}

/** In menu order: the first-class harnesses (Claude Code, Codex, OpenCode, Hermes, OpenClaw) first. */
export const OLLAMA_HARNESSES: readonly OllamaHarnessSpec[] = [
  { name: "claude", label: "Claude Code" },
  { name: "codex", label: "Codex" },
  { name: "opencode", label: "OpenCode" },
  { name: "hermes", label: "Hermes Agent" },
  { name: "openclaw", label: "OpenClaw" },
  { name: "qwen", label: "Qwen Code" },
  { name: "copilot", label: "Copilot CLI" },
  { name: "droid", label: "Droid" },
  { name: "kimi", label: "Kimi Code CLI" },
  { name: "pi", label: "Pi" },
  { name: "cline", label: "Cline" },
  { name: "omp", label: "OMP" },
  { name: "dsh", label: "DeepSeek Harness" },
  { name: "muse", label: "Muse Code" },
  { name: "pool", label: "Pool" },
];

/** Whether `v` is one of {@linkcode OLLAMA_HARNESSES}. */
export function isHarnessName(v: unknown): v is string {
  return typeof v === "string" && OLLAMA_HARNESSES.some((h) => h.name === v);
}

/** The menu's name for a harness (its integration name when unknown). */
export function harnessLabel(name: string): string {
  return OLLAMA_HARNESSES.find((h) => h.name === name)?.label ?? name;
}

/** `ollama launch` arguments for one harness on one model (the hub's own go after `--`). */
export function launchArgs(harness: string, model: string): string[] {
  return ["launch", harness, "--model", model];
}

/**
 * The script a "pull, then launch" tile runs with `/bin/sh -c`: `$1` is the `ollama` path, `$2`
 * the model, the rest the `launch` arguments (the hub's flags appended after them still reach
 * the harness). `ollama launch` alone only offers to pull a missing model, so the tile pulls it
 * first, showing the progress bar, and launches once that succeeded.
 */
export const PULL_THEN_LAUNCH =
  'o="$1"; m="$2"; shift 2; "$o" pull "$m" && exec "$o" "$@"';

/** What a tile runs: the program and its arguments. */
export interface OllamaCommand {
  program: string;
  args: string[];
}

/** The tile's command: `ollama launch …`, or pull first when the model is not here yet. */
export function ollamaCommand(
  ollama: string,
  harness: string,
  model: string,
  pullFirst = false,
): OllamaCommand {
  const launch = launchArgs(harness, model);
  return pullFirst
    ? {
      program: "/bin/sh",
      args: ["-c", PULL_THEN_LAUNCH, "qutty-ollama", ollama, model, ...launch],
    }
    : { program: ollama, args: launch };
}

/** A "Pull a model…" tile: `ollama pull <name>` (it ends when the pull does). */
export function pullCommand(ollama: string, model: string): OllamaCommand {
  return { program: ollama, args: ["pull", model] };
}

/**
 * The tile profile for a harness on a model (lib/ssh-ui.ts `AgentProfile`): the harness is its
 * name (the hub wires it, the badge shows it), the model rides along for the hub and the title.
 */
export function ollamaProfile(
  ollama: string,
  pair: { harness: string; model: string },
  pullFirst = false,
): AgentProfile {
  const cmd = ollamaCommand(ollama, pair.harness, pair.model, pullFirst);
  return {
    kind: "agent",
    program: cmd.program,
    args: cmd.args,
    name: pair.harness,
    label: harnessLabel(pair.harness),
    ollamaModel: pair.model,
  };
}

/** The tile profile for `ollama pull <model>` (a plain command; its tile closes when done). */
export function pullProfile(ollama: string, model: string): AgentProfile {
  const cmd = pullCommand(ollama, model);
  return {
    kind: "agent",
    program: cmd.program,
    args: cmd.args,
    name: `ollama pull ${model}`,
    label: "ollama pull",
    plain: true,
  };
}

/** One harness as the picker shows it for a model. */
export interface HarnessChoice {
  name: string;
  label: string;
  installed: boolean;
  /** The model's library page lists it under Applications. */
  listed: boolean;
}

/**
 * The harnesses to offer for a model: every installed one, plus the ones the model's library page
 * lists (greyed while not installed, so the user sees what to install). Without a page (a local
 * model, or the library unreachable) every harness is shown, the uninstalled ones greyed.
 * Listed ones come first, then {@linkcode OLLAMA_HARNESSES} order.
 */
export function harnessChoices(
  installed: ReadonlySet<string>,
  applications: readonly string[] | undefined,
): HarnessChoice[] {
  const listed = new Set(applications ?? []);
  const all = OLLAMA_HARNESSES.map((h) => ({
    name: h.name,
    label: h.label,
    installed: installed.has(h.name),
    listed: listed.has(h.name),
  }));
  const shown = applications === undefined || applications.length === 0
    ? all
    : all.filter((h) => h.installed || h.listed);
  return shown.sort((a, b) =>
    Number(b.listed) - Number(a.listed) ||
    Number(b.installed) - Number(a.installed)
  );
}
