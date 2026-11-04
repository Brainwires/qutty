// A tiny live SVG of a layout pattern: the real engine run over five fake terminals, so the
// preview is exactly what the cluster would do (with the current falloff / master ratio).

import {
  computeLayout,
  type LayoutOptions,
  type LayoutPattern,
} from "../lib/layout/mod.ts";
import { DEFAULT_SETTINGS } from "../lib/workspace/store.ts";

const FAKE_IDS = ["a", "b", "c", "d", "e"];

export interface PatternPreviewProps {
  pattern: LayoutPattern;
  /** The decay / master ratio to preview with (defaults are used when omitted). */
  options?: Partial<LayoutOptions>;
  /** The 16px bar-button variant. */
  small?: boolean;
}

export function PatternPreview(
  { pattern, options, small }: PatternPreviewProps,
) {
  const w = small ? 22 : 72;
  const h = small ? 14 : 45;
  const gap = small ? 1.5 : 3;
  const opts: LayoutOptions = {
    ...DEFAULT_SETTINGS.layout,
    ...options,
    pattern,
    gap,
    maxVisible: Math.min(5, Math.max(1, options?.maxVisible ?? 5)),
    minTileW: 2,
    minTileH: 2,
  };
  const { tiles } = computeLayout(FAKE_IDS, { x: 0, y: 0, w, h }, opts);
  return (
    <svg
      class={`pattern-preview${small ? " is-small" : ""}`}
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
    >
      {tiles.map((t) => (
        <rect
          key={t.id}
          x={t.rect.x}
          y={t.rect.y}
          width={Math.max(0, t.rect.w)}
          height={Math.max(0, t.rect.h)}
          rx={small ? 1 : 2}
          class={`pp-tile pp-rank-${Math.min(t.rank, 4)}`}
        />
      ))}
    </svg>
  );
}
