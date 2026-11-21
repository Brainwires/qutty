/**
 * Settings → Companion, as persisted with the workspace settings (lib/workspace/store.ts): its name
 * (default "Companion"), where it is drawn (in the window, in a floating window of its own, or off),
 * which corner, whether the floating window shows on every Space, whether its brain may run, which brain
 * (Claude Code, a local Ollama model, or Anthropic's API with the user's key) and its model,
 * whether the companion is lively (idle expressions, eyes that follow the pointer:
 * lib/companion/face-life.ts), and its reactions (sleepy at night: lib/companion/sleepy.ts;
 * celebrate and sad over finished jobs: lib/companion/reactions.ts), and its own lines (a quote of
 * the day, encouragement now and then: lib/companion/ambient.ts), and its look (the built-in face
 * or a look of the user's: lib/companion/looks.ts).
 *
 * Client-safe and pure.
 *
 * @module
 */

import { BUILTIN_LOOK_ID, isLookId } from "./looks.ts";
import {
  COMPANION_CORNERS,
  COMPANION_MODES,
  type CompanionCorner,
  type CompanionMode,
} from "./protocol.ts";

/** How often the companion says an encouraging line (lib/companion/ambient.ts). */
export type EncourageFrequency = "rarely" | "sometimes" | "often";
/** Every frequency, as Settings lists them. */
export const ENCOURAGE_FREQUENCIES: readonly EncourageFrequency[] = [
  "rarely",
  "sometimes",
  "often",
];

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
 * Which brain: headless Claude Code (the user's own login), a local Ollama model through
 * `@rullama/inference` (lib/companion/inference-brain.ts), or Anthropic's Messages API with the
 * user's API key (lib/companion/anthropic-provider.ts), which the hub extension keeps in the OS
 * keychain (Denext 4.15's extension secure store; the page never reads it back). Claude Code and
 * the API key brain share {@linkcode CompanionSettings.model}.
 */
export type BrainEngine = "claude" | "ollama" | "anthropic";
/** Every brain, as Settings lists them. */
export const BRAIN_ENGINES: readonly BrainEngine[] = [
  "claude",
  "ollama",
  "anthropic",
];

/** An Ollama model name (`qwen3.8:27b-mlx`, `user/model:tag`), or "" for none chosen. */
export function isOllamaModelName(name: string): boolean {
  return /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})?$/.test(name);
}

/** The companion's name when the user has not given it one. */
export const DEFAULT_COMPANION_NAME = "Companion";

/** The longest name the companion may have, in characters. */
export const COMPANION_NAME_MAX = 24;

/**
 * The companion's name from `raw` (storage, a patch, the Settings field): trimmed, inner
 * whitespace and control characters collapsed to single spaces, at most
 * {@linkcode COMPANION_NAME_MAX} characters; {@linkcode DEFAULT_COMPANION_NAME} when that leaves
 * nothing or `raw` is not a string.
 */
export function companionName(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_COMPANION_NAME;
  // deno-lint-ignore no-control-regex
  const clean = raw.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  const name = Array.from(clean).slice(0, COMPANION_NAME_MAX).join("").trim();
  return name || DEFAULT_COMPANION_NAME;
}

export interface CompanionSettings {
  /**
   * What the companion is called: in the chat box, its labels and Settings, its brain's system
   * prompt, and the voice summary's address ("hey <name>, summarize the window").
   */
  name: string;
  /**
   * In the window, floating (a transparent window of its own, app/companion/floating-companion.tsx:
   * drawn in the window where the system cannot float it, {@linkcode companionPlace}), or off.
   */
  mode: CompanionMode;
  /** The corner of the tile area it sits in (in the window). */
  corner: CompanionCorner;
  /** Floating: the companion's window shows on every Space / virtual desktop. */
  floatAllSpaces: boolean;
  /**
   * Whether the brain (headless Claude Code) may run; the companion still shows messages without
   * it.
   */
  brain: boolean;
  /** Which brain runs. */
  engine: BrainEngine;
  /** Claude Code's model, and the API key brain's. */
  model: BrainModel;
  /** The Ollama model (one that can call tools), when `engine` is `ollama`. */
  ollamaModel: string;
  /** Idle micro-expressions, eyes that follow the pointer, and excitement when it comes near. */
  lively: boolean;
  /** Reactions: sleepy between `nightFrom` and `nightTo` (minutes since midnight) when idle. */
  nightSleepy: boolean;
  nightFrom: number;
  nightTo: number;
  /** Reactions: hop of joy when a long job finishes well. */
  celebrate: boolean;
  /** Reactions: a brief sad face when one fails. */
  sad: boolean;
  /** Reactions: seconds a shell command must run to count. */
  reactMinS: number;
  /** Reactions: every long command counts, not only build- and test-like ones. */
  reactAnyCommand: boolean;
  /** Reactions: a short line beside the companion saying what finished. */
  reactBubble: boolean;
  /**
   * A quote of the day in the bubble: at startup, and at the first use after midnight (once a
   * day across every window; lib/companion/ambient.ts).
   */
  quoteOfDay: boolean;
  /** Now and then a short comforting or inspiring line in the bubble. */
  encourage: boolean;
  /** How often {@linkcode CompanionSettings.encourage} speaks up. */
  encourageEvery: EncourageFrequency;
  /**
   * What the companion looks like (Settings → Companion → Look): the built-in face
   * (`loopy`, {@linkcode BUILTIN_LOOK_ID}) or the id of a look in the looks folder
   * (lib/companion/looks.ts). One that is missing or broken shows the built-in face.
   */
  look: string;
}

/** The reactions' number ranges (Settings' fields). */
export const REACTION_RANGES = {
  nightFrom: { min: 0, max: 1439 },
  nightTo: { min: 0, max: 1439 },
  reactMinS: { min: 1, max: 3600 },
} as const;

export const DEFAULT_COMPANION: CompanionSettings = {
  name: DEFAULT_COMPANION_NAME,
  mode: "window",
  corner: "bottom-right",
  floatAllSpaces: true,
  brain: true,
  engine: "claude",
  model: "",
  ollamaModel: "",
  lively: true,
  nightSleepy: true,
  nightFrom: 0,
  nightTo: 6 * 60,
  celebrate: true,
  sad: true,
  reactMinS: 20,
  reactAnyCommand: false,
  reactBubble: true,
  quoteOfDay: true,
  encourage: false,
  encourageEvery: "sometimes",
  look: BUILTIN_LOOK_ID,
};

const FLAGS = [
  "floatAllSpaces",
  "brain",
  "lively",
  "nightSleepy",
  "celebrate",
  "sad",
  "reactAnyCommand",
  "reactBubble",
  "quoteOfDay",
  "encourage",
] as const;

/**
 * `raw` (from storage, or a patch) onto `base`, each field checked. `floating` is kept as
 * chosen even where it cannot float: it is drawn in the window there ({@linkcode companionPlace}).
 */
export function sanitizeCompanion(
  raw: unknown,
  base: CompanionSettings = DEFAULT_COMPANION,
): CompanionSettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof CompanionSettings, unknown>>;
  if ("name" in r) out.name = companionName(r.name);
  if (COMPANION_MODES.includes(r.mode as CompanionMode)) {
    out.mode = r.mode as CompanionMode;
  }
  if (COMPANION_CORNERS.includes(r.corner as CompanionCorner)) {
    out.corner = r.corner as CompanionCorner;
  }
  for (const key of FLAGS) {
    const v = r[key];
    if (typeof v === "boolean") out[key] = v;
  }
  for (const key of ["nightFrom", "nightTo", "reactMinS"] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const { min, max } = REACTION_RANGES[key];
      out[key] = Math.round(Math.min(max, Math.max(min, v)));
    }
  }
  if (ENCOURAGE_FREQUENCIES.includes(r.encourageEvery as EncourageFrequency)) {
    out.encourageEvery = r.encourageEvery as EncourageFrequency;
  }
  if (isLookId(r.look)) out.look = r.look;
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
    : { engine: s.engine, model: s.model };
}

/** Whether the companion is on at all (in the window or floating): its brain may run. */
export function companionOn(mode: CompanionMode): boolean {
  return mode !== "off";
}

/**
 * Whether a workspace window should ask for the floating companion's window: Floating is chosen
 * and this system can float it (lib/companion/floating.ts `floatingSupport`).
 */
export function wantsFloatingWindow(
  mode: CompanionMode,
  supported: boolean,
): boolean {
  return mode === "floating" && supported;
}

/**
 * Where a workspace window's companion is drawn: `off`; `floating` once the floating window shows
 * it (the window then draws none of its own); else `window`, which is also Floating's fallback
 * where the system cannot float it, or while its window is opening or failed to open.
 */
export function companionPlace(
  mode: CompanionMode,
  floating: { readonly supported: boolean; readonly showing: boolean },
): "window" | "floating" | "off" {
  if (mode === "off") return "off";
  return wantsFloatingWindow(mode, floating.supported) && floating.showing
    ? "floating"
    : "window";
}
