/**
 * What the switcher bar shows, computed from the store and the layout: the chip order (MRU or
 * creation), each chip's bar ordinal (⌘1..9), its MRU rank, and whether its terminal is tiled
 * in the cluster, lives only in the bar (overflow), or was minimized there.
 *
 * @module
 */

import type { LayoutResult } from "../layout/mod.ts";
import {
  barOrderIds,
  type TerminalEntry,
  type WorkspaceState,
} from "./store.ts";

/** One chip. */
export interface BarChip {
  id: string;
  entry: TerminalEntry;
  /** 1-based position in the bar; `⌘<ordinal>` focuses it when ≤ 9. */
  ordinal: number;
  /** MRU rank (0 = focused). */
  rank: number;
  /** Whether the cluster currently tiles this terminal. */
  tiled: boolean;
  /** Minimized: in the bar by the user's choice (never tiled; its chip restores it). */
  minimized: boolean;
  focused: boolean;
}

/** The chips in bar order. `visible` is the set of tiled ids (from `computeLayout(...).tiles`). */
export function barChips(
  state: WorkspaceState,
  visible: ReadonlySet<string>,
): BarChip[] {
  const byId = new Map(state.terminals.map((t) => [t.id, t]));
  const chips: BarChip[] = [];
  for (const id of barOrderIds(state)) {
    const entry = byId.get(id);
    if (!entry) continue;
    chips.push({
      id,
      entry,
      ordinal: chips.length + 1,
      rank: state.mru.indexOf(id),
      tiled: visible.has(id) && !entry.minimized,
      minimized: entry.minimized === true,
      focused: id === state.focusedId,
    });
  }
  return chips;
}

/** The tiled-id set from a layout result. */
export function visibleIdSet(layout: Pick<LayoutResult, "tiles">): Set<string> {
  return new Set(layout.tiles.map((t) => t.id));
}

/**
 * Split the chips into the ones the cluster shows, the ones only the bar shows (overflow) and the
 * minimized ones.
 */
export function splitChips(
  chips: BarChip[],
): { tiled: BarChip[]; overflow: BarChip[]; minimized: BarChip[] } {
  return {
    tiled: chips.filter((c) => c.tiled),
    overflow: chips.filter((c) => !c.tiled && !c.minimized),
    minimized: chips.filter((c) => c.minimized),
  };
}

/**
 * Where the chip strip must scroll to show a chip, or `null` when it is in view. All in one axis
 * and in the strip's content coordinates: the chip spans `start..end` where it is laid out (its
 * FLIP transform aside), the strip shows `scroll..scroll + size` of a content `content` long. A
 * chip longer than the strip shows its start. The answer is an absolute position (clamped to the
 * strip's range), so asking again while a smooth scroll runs aims at the same place instead of
 * adding a second step to the first.
 */
export function chipScrollTarget(
  chip: { start: number; end: number },
  strip: { scroll: number; size: number; content: number },
): number | null {
  const lo = strip.scroll;
  const hi = strip.scroll + strip.size;
  // Half a pixel either way is in view (fractional layouts).
  if (chip.start >= lo - 0.5 && chip.end <= hi + 0.5) return null;
  const want = chip.start < lo || chip.end - chip.start > strip.size
    ? chip.start
    : chip.end - strip.size;
  const max = Math.max(0, strip.content - strip.size);
  return Math.min(max, Math.max(0, Math.round(want)));
}
