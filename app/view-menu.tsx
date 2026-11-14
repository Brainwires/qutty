// The in-app View menu's model-driven parts, in the switcher bar's layout menu: the View choice
// (Tiled View / Free-form View), the free-form arrange commands (greyed in the tiled view) and
// the Tiles list (every tile, the focused one checked; a click focuses it, restoring a minimized
// one). Drawn from the menu model (lib/workspace/mdi-menu.ts) as it is, so the in-app menu, the
// static Window-menu items and Denext's coming dynamic menus say the same thing.

import {
  menuCommand,
  type MenuItem,
  type MenuTile,
  viewMenu,
  type WindowAppItem,
  windowAppItems,
} from "../lib/workspace/mdi-menu.ts";
import type { ViewMode } from "../lib/workspace/freeform.ts";

/** One item of the model as a menu row. */
function ModelItem(props: {
  item: MenuItem | WindowAppItem;
  testid: string;
  onPick(id: string): void;
}) {
  const { item } = props;
  if (item.type === "separator") {
    return <div class="menu-sep" role="separator" />;
  }
  const checked = item.checked === true;
  const role = item.type === "radio"
    ? "menuitemradio"
    : item.checked !== undefined
    ? "menuitemcheckbox"
    : "menuitem";
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === "menuitem" ? undefined : checked}
      disabled={item.enabled === false}
      class={`menu-item${checked ? " is-active" : ""}`}
      data-testid={props.testid}
      data-item={item.id}
      onClick={() => props.onPick(item.id)}
    >
      <span class="menu-check" aria-hidden="true">{checked ? "✓" : ""}</span>
      <span class="menu-label">{item.label}</span>
    </button>
  );
}

/** The View choice and the arrange commands (before the tiled view's patterns). */
export function ViewMenuSection(props: {
  view: ViewMode;
  tiles: readonly MenuTile[];
  onPick(id: string): void;
}) {
  const items = viewMenu({ view: props.view, tiles: props.tiles });
  return (
    <div class="menu-section" data-testid="view-menu">
      <div class="menu-heading">View</div>
      {items.map((item) => (
        <ModelItem
          key={item.id}
          item={item}
          testid="view-item"
          onPick={props.onPick}
        />
      ))}
    </div>
  );
}

/** The Tiles list: the window's tiles, the focused one checked (no arrange items: they are above). */
export function TilesMenuSection(props: {
  view: ViewMode;
  tiles: readonly MenuTile[];
  onPick(id: string): void;
}) {
  const items = windowAppItems({ view: props.view, tiles: props.tiles })
    .filter((item) => {
      const what = menuCommand(item.id);
      return what !== null && "focus" in what;
    });
  if (items.length === 0) return null;
  return (
    <div class="menu-section menu-tiles" data-testid="tiles-menu">
      <div class="menu-heading">Tiles</div>
      {items.map((item) => (
        <ModelItem
          key={item.id}
          item={item}
          testid="tiles-item"
          onPick={props.onPick}
        />
      ))}
    </div>
  );
}
