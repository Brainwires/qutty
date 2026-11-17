// Where another window's tile would land if it were released here (app/use-tile-move.ts): the
// slot under the pointer (tiled, tiles in place), the rect it would take (free-form), or the whole
// area (it arrives focused, in the main spot), with the tile's title.

import type { LayoutTile, Rect } from "../lib/layout/mod.ts";
import type { ViewMode } from "../lib/workspace/freeform.ts";
import { arrivalPlace } from "../lib/workspace/tile-move.ts";
import type { DropHover } from "./use-tile-move.ts";
import { useHtmlOverlay } from "./use-html-overlay.ts";

export function WindowDrop(props: {
  hover: DropHover;
  view: ViewMode;
  keepsPlaces: boolean;
  tiles: readonly LayoutTile[];
  bounds: Rect;
  cluster: HTMLElement | null;
}) {
  // A native web view draws above all HTML: it shows its snapshot while the mark is up.
  useHtmlOverlay();
  const box = props.cluster?.getBoundingClientRect();
  const place = arrivalPlace({
    at: { x: props.hover.x, y: props.hover.y },
    view: props.view,
    keepsPlaces: props.keepsPlaces,
    tiles: props.tiles,
    cluster: { left: box?.left ?? 0, top: box?.top ?? 0 },
    bounds: props.bounds,
  });
  const rect = place.rect ??
    props.tiles.find((t) => t.id === place.before)?.rect ??
    { x: 0, y: 0, w: props.bounds.w, h: props.bounds.h };
  return (
    <div
      class="window-drop"
      data-testid="window-drop"
      aria-hidden="true"
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
      }}
    >
      <span class="window-drop-label">{props.hover.title || "Tile"}</span>
    </div>
  );
}
