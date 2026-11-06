/**
 * Settings → Ollama, as persisted with the workspace settings (lib/workspace/store.ts): the
 * default harness and model, the recently launched harness × model pairs (the `+` menu lists
 * them first), and when the user last looked at the model library (for its "new" badge).
 *
 * A pair is also a `+` picker entry: `ollama:<harness>:<model>` (the model may itself contain a
 * `:`, the harness never does), so "+ opens" can name one.
 *
 * Client-safe and pure.
 *
 * @module
 */

import { isModelName } from "./cli.ts";
import { isHarnessName } from "./harnesses.ts";

/** A harness on a model. */
export interface OllamaPair {
  harness: string;
  model: string;
}

export interface OllamaSettings {
  /** The harness the Ollama dialog starts on (`null`: the first installed one). */
  harness: string | null;
  /** The model it starts on (`null`: the first pulled one). */
  model: string | null;
  /** Launched pairs, most recent first (at most {@linkcode MAX_RECENTS}). */
  recents: OllamaPair[];
  /** Epoch ms of the last look at the library (`null`: never), for the "new" badge. */
  libraryLookedAt: number | null;
}

/** How many recent pairs are kept. */
export const MAX_RECENTS = 5;

export const DEFAULT_OLLAMA: OllamaSettings = {
  harness: null,
  model: null,
  recents: [],
  libraryLookedAt: null,
};

/** Whether `v` is a usable pair. */
function isPair(v: unknown): v is OllamaPair {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return isHarnessName(p.harness) && isModelName(p.model);
}

/** `pair` put first in `recents` (moved up if it was there), capped. */
export function rememberPair(
  recents: readonly OllamaPair[],
  pair: OllamaPair,
): OllamaPair[] {
  return [
    { harness: pair.harness, model: pair.model },
    ...recents.filter((p) =>
      p.harness !== pair.harness || p.model !== pair.model
    ),
  ].slice(0, MAX_RECENTS);
}

/** `raw` (from storage, the page or a patch) onto `base`, each field checked. */
export function sanitizeOllama(
  raw: unknown,
  base: OllamaSettings = DEFAULT_OLLAMA,
): OllamaSettings {
  const out: OllamaSettings = { ...base, recents: [...base.recents] };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof OllamaSettings, unknown>>;
  if (r.harness === null || isHarnessName(r.harness)) out.harness = r.harness;
  if (r.model === null || isModelName(r.model)) out.model = r.model;
  if (Array.isArray(r.recents)) {
    out.recents = r.recents.filter(isPair).reduce<OllamaPair[]>(
      (acc, p) =>
        acc.some((q) => q.harness === p.harness && q.model === p.model)
          ? acc
          : [...acc, { harness: p.harness, model: p.model }],
      [],
    ).slice(0, MAX_RECENTS);
  }
  if (
    r.libraryLookedAt === null ||
    (typeof r.libraryLookedAt === "number" &&
      Number.isFinite(r.libraryLookedAt) && r.libraryLookedAt >= 0)
  ) {
    out.libraryLookedAt = r.libraryLookedAt;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Picker entry ids
// ---------------------------------------------------------------------------------------------

/** A pair's `+` picker entry id. */
export function pairEntryId(pair: OllamaPair): string {
  return `ollama:${pair.harness}:${pair.model}`;
}

/** The pair an `ollama:` entry id names, if it is one. */
export function pairOfEntryId(id: string): OllamaPair | undefined {
  const m = /^ollama:([a-z0-9-]+):(.+)$/.exec(id);
  if (!m) return undefined;
  const pair = { harness: m[1], model: m[2] };
  return isPair(pair) ? pair : undefined;
}

/** A pair's title: `claude · qwen3.8:27b-mlx`. */
export function pairTitle(pair: OllamaPair): string {
  return `${pair.harness} · ${pair.model}`;
}
