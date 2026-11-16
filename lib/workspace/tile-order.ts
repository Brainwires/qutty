/**
 * Where tiles sit in the tiled view. By default the focused tile moves to the main (biggest) slot
 * and the others follow in recency order (MRU). With Settings → Layout → "Focused tile moves to
 * the main spot" off, the slots follow the workspace's own tile order instead (`order` in the
 * store): focusing a tile changes only the focus, a new tile goes last, a closed one drops out,
 * and a header drag swaps two tiles (app/use-swap-drag.ts). Turning the setting off seeds the
 * order from the MRU, which is what is on screen, so nothing jumps.
 *
 * More tiles than the layout shows (overflow): the order decides who is shown, and a hidden tile
 * that gets the focus (its chip, the companion) takes the slot of the least recently used shown
 * tile, the two trading places in the order ({@linkcode overflowSwap}). Monocle always shows the
 * focused tile, whatever the order.
 *
 * Ranks stay recency ranks in both modes (0 = focused): they dim older tiles and stack them.
 *
 * Pure, so it is tested without a DOM (tests/ui_tile_order_test.ts).
 *
 * @module
 */

import type { LayoutResult, LayoutTile } from "../layout/mod.ts";
import type { TerminalEntry, WorkspaceState } from "./store.ts";

/** `order` with `id` last (unchanged when it is there already). */
export function appendId(order: readonly string[], id: string): string[] {
  return order.includes(id) ? [...order] : [...order, id];
}

/** `order` with `a` and `b` trading places (the same array when either is missing or a === b). */
export function swapIds(
  order: readonly string[],
  a: string,
  b: string,
): readonly string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0 || i === j) return order;
  const out = [...order];
  out[i] = b;
  out[j] = a;
  return out;
}

/**
 * A tile order from storage, fitted to the tiles there are: the known ids once each (strings
 * only), then every id of `fallback` it left out, in that order (an older snapshot without an
 * order gets the fallback, the MRU, which is what was on screen).
 */
export function sanitizeOrder(
  raw: unknown,
  fallback: readonly string[],
): string[] {
  const ids = new Set(fallback);
  const out: string[] = [];
  for (const id of Array.isArray(raw) ? raw : []) {
    if (typeof id === "string" && ids.has(id) && !out.includes(id)) {
      out.push(id);
    }
  }
  for (const id of fallback) if (!out.includes(id)) out.push(id);
  return out;
}

/** Whether tiles keep their places when focused (the setting is off, a tiled pattern but monocle). */
export function keepsPlaces(state: WorkspaceState): boolean {
  return !state.settings.focusToMain &&
    state.settings.layout.pattern !== "monocle";
}

/** The shown (not minimized) tiles in slot order: what the tiled layout is computed over. */
export function slotOrder(
  state: {
    readonly terminals: readonly TerminalEntry[];
    readonly mru: readonly string[];
    readonly order: readonly string[];
  },
  keep: boolean,
): string[] {
  const min = new Set(
    state.terminals.filter((t) => t.minimized).map((t) => t.id),
  );
  return (keep ? state.order : state.mru).filter((id) => !min.has(id));
}

/**
 * `layout` with each tile's rank its recency among the tiles shown (0 = the focused one), the
 * tiles kept in slot order. With MRU slots this changes nothing (the same object comes back).
 */
export function withRecencyRanks(
  layout: LayoutResult,
  mru: readonly string[],
): LayoutResult {
  const byRecency = layout.tiles.map((t) => t.id).sort((a, b) =>
    mru.indexOf(a) - mru.indexOf(b)
  );
  if (layout.tiles.every((t, i) => byRecency[i] === t.id)) return layout;
  const rank = new Map(byRecency.map((id, i) => [id, i]));
  return {
    ...layout,
    tiles: layout.tiles.map((t) => ({ ...t, rank: rank.get(t.id)! })),
  };
}

/**
 * Tiles in place and the focused tile left out of the layout (overflow): it and the least recently
 * used shown tile, to trade places in the order. `null` when nothing needs to move.
 */
export function overflowSwap(
  state: WorkspaceState,
  layout: LayoutResult,
): [string, string] | null {
  const id = state.focusedId;
  if (
    state.view !== "tiled" || !keepsPlaces(state) || id === null ||
    !layout.overflow.includes(id) || layout.tiles.length === 0
  ) return null;
  let oldest = layout.tiles[0].id;
  for (const t of layout.tiles) {
    if (state.mru.indexOf(t.id) > state.mru.indexOf(oldest)) oldest = t.id;
  }
  return [id, oldest];
}

/** The tile under point (`x`, `y`) (cluster px), other than `except`; `null`: none. */
export function tileAt(
  tiles: readonly LayoutTile[],
  x: number,
  y: number,
  except: string,
): string | null {
  const hit = tiles.find((t) =>
    t.id !== except && x >= t.rect.x && x < t.rect.x + t.rect.w &&
    y >= t.rect.y && y < t.rect.y + t.rect.h
  );
  return hit?.id ?? null;
}
