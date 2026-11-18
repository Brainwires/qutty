/**
 * An agent's avatar: a small symmetric pattern (5 × 5 cells, mirrored left to right) worked out
 * from its name, in its harness's brand colour — the same name always gets the same picture, so
 * two tiles of one harness tell apart at a glance (the tile header, the Agents panel).
 *
 * Client-safe and pure.
 *
 * @module
 */

/** A harness an agent runs on. */
export type AgentHarness = "claude" | "codex" | "gemini";

/** Each harness's brand colour. */
export const HARNESS_COLORS: Readonly<Record<AgentHarness, string>> = {
  claude: "#d97757",
  codex: "#10a37f",
  gemini: "#4c8df6",
};

/** `harness`'s brand colour (an unknown harness gets Claude's). */
function harnessColor(harness: string | undefined): string {
  return HARNESS_COLORS[harness as AgentHarness] ?? HARNESS_COLORS.claude;
}

/** The grid's size (cells per side). */
export const AVATAR_CELLS = 5;

/** FNV-1a, 32 bits. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** An avatar: its colour and which cells are filled (row by row, `AVATAR_CELLS`² of them). */
export interface AgentAvatar {
  color: string;
  cells: boolean[];
  /** How strong the filled cells are (0.55–1), from the name too. */
  shade: number;
}

/** The avatar of agent `name` on `harness`. */
export function agentAvatar(name: string, harness?: string): AgentAvatar {
  const key = name.trim().toLowerCase() || "agent";
  let h = hash(key);
  const half = Math.ceil(AVATAR_CELLS / 2);
  const cells: boolean[] = new Array(AVATAR_CELLS * AVATAR_CELLS).fill(false);
  let filled = 0;
  for (let y = 0; y < AVATAR_CELLS; y++) {
    for (let x = 0; x < half; x++) {
      const on = (h & 1) === 1;
      h = h >>> 1 || hash(`${key}:${y}:${x}`);
      cells[y * AVATAR_CELLS + x] = on;
      cells[y * AVATAR_CELLS + (AVATAR_CELLS - 1 - x)] = on;
      if (on) filled++;
    }
  }
  // Never blank: the middle column at least.
  if (filled === 0) {
    for (let y = 0; y < AVATAR_CELLS; y++) {
      cells[y * AVATAR_CELLS + (half - 1)] = true;
    }
  }
  const shade = 0.55 + (hash(`${key}#shade`) % 46) / 100;
  return { color: harnessColor(harness), cells, shade };
}
