/**
 * Settings → Companion, as persisted with the workspace settings (lib/workspace/store.ts): where
 * Loopy is drawn, which corner, whether its brain may run, and the brain's model.
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

export interface CompanionSettings {
  /** In the window, floating (not available yet: Denext multi-window), or off. */
  mode: CompanionMode;
  corner: CompanionCorner;
  /** Whether the brain (headless Claude Code) may run; Loopy still shows messages without it. */
  brain: boolean;
  model: BrainModel;
}

export const DEFAULT_COMPANION: CompanionSettings = {
  mode: "window",
  corner: "bottom-right",
  brain: true,
  model: "",
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
  if (COMPANION_MODELS.includes(r.model as BrainModel)) {
    out.model = r.model as BrainModel;
  }
  return out;
}

/** How Loopy is drawn today: floating falls back to the window. */
export function effectiveMode(mode: CompanionMode): "window" | "off" {
  return mode === "off" ? "off" : "window";
}
