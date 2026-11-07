/**
 * Settings → Companion, as persisted with the workspace settings (lib/workspace/store.ts): where
 * Loopy is drawn, which corner, whether its brain may run, which brain (Claude Code, or a local
 * Ollama model) and its model, and whether Loopy is lively (idle expressions, eyes that follow the pointer: lib/companion/loopy-life.ts).
 *
 * Client-safe and pure.
 *
 * @module
 */

import {
  COMPANION_CORNERS,
  COMPANION_MODES,
  type CompanionCorner,
  type CompanionMode,
} from "./protocol.ts";

/** The brain's model: the user's Claude Code default, or an alias. */
export type BrainModel = "" | "haiku" | "sonnet" | "opus";
/** Every model choice, as Settings lists them. */
export const COMPANION_MODELS: readonly BrainModel[] = [
  "",
  "haiku",
  "sonnet",
  "opus",
];

/**
 * Which brain: headless Claude Code (the user's own login), or a local Ollama model through
 * `@rullama/inference` (lib/companion/inference-brain.ts). An API key brain is not offered: the
 * key would need Denext's `secureStore`, which still bakes `--allow-run=security` and
 * `--allow-sys` into the app (Denext 4.13.1).
 */
export type BrainEngine = "claude" | "ollama";
/** Every brain, as Settings lists them. */
export const BRAIN_ENGINES: readonly BrainEngine[] = ["claude", "ollama"];

/** An Ollama model name (`qwen3.8:27b-mlx`, `user/model:tag`), or "" for none chosen. */
export function isOllamaModelName(name: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})?$/.test(name);
}

export interface CompanionSettings {
  /** In the window, floating (not available yet: Denext multi-window), or off. */
  mode: CompanionMode;
  corner: CompanionCorner;
  /** Whether the brain (headless Claude Code) may run; Loopy still shows messages without it. */
  brain: boolean;
  /** Which brain runs. */
  engine: BrainEngine;
  /** Claude Code's model. */
  model: BrainModel;
  /** The Ollama model (one that can call tools), when `engine` is `ollama`. */
  ollamaModel: string;
  /** Idle micro-expressions, eyes that follow the pointer, and excitement when it comes near. */
  lively: boolean;
}

export const DEFAULT_COMPANION: CompanionSettings = {
  mode: "window",
  corner: "bottom-right",
  brain: true,
  engine: "claude",
  model: "",
  ollamaModel: "",
  lively: true,
};

/**
 * `raw` (from storage, or a patch) onto `base`, each field checked. `floating` is kept as
 * chosen but drawn as `window` until floating windows exist ({@linkcode effectiveMode}).
 */
export function sanitizeCompanion(
  raw: unknown,
  base: CompanionSettings = DEFAULT_COMPANION,
): CompanionSettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof CompanionSettings, unknown>>;
  if (COMPANION_MODES.includes(r.mode as CompanionMode)) {
    out.mode = r.mode as CompanionMode;
  }
  if (COMPANION_CORNERS.includes(r.corner as CompanionCorner)) {
    out.corner = r.corner as CompanionCorner;
  }
  if (typeof r.brain === "boolean") out.brain = r.brain;
  if (typeof r.lively === "boolean") out.lively = r.lively;
  if (COMPANION_MODELS.includes(r.model as BrainModel)) {
    out.model = r.model as BrainModel;
  }
  if (BRAIN_ENGINES.includes(r.engine as BrainEngine)) {
    out.engine = r.engine as BrainEngine;
  }
  if (typeof r.ollamaModel === "string" && isOllamaModelName(r.ollamaModel)) {
    out.ollamaModel = r.ollamaModel;
  }
  return out;
}

/** The brain and model the hub is configured with (`model` "": the engine's default). */
export function brainChoice(
  s: CompanionSettings,
): { engine: BrainEngine; model: string } {
  return s.engine === "ollama"
    ? { engine: "ollama", model: s.ollamaModel }
    : { engine: "claude", model: s.model };
}

/** How Loopy is drawn today: floating falls back to the window. */
export function effectiveMode(mode: CompanionMode): "window" | "off" {
  return mode === "off" ? "off" : "window";
}
