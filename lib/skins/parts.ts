/**
 * The skin contract: the parts of the chrome a skin's stylesheet may target, each by a selector
 * that stays the same from release to release. Most are `data-part` attributes; things drawn in
 * many places (menus, buttons) keep the class they always had.
 *
 * docs/skins.md lists the same parts for skin authors, and a unit test (tests/skins_test.ts)
 * keeps the three in step: every selector here is in the docs, every `data-part` here is in the
 * app's markup, and every class here is in public/styles.css.
 *
 * @module
 */

/** One part of the chrome a skin can style. */
export interface SkinPart {
  /** The selector to write in a skin. */
  selector: string;
  /** What it is. */
  what: string;
}

const part = (name: string, what: string): SkinPart => ({
  selector: `[data-part="${name}"]`,
  what,
});
const cls = (name: string, what: string): SkinPart => ({
  selector: `.${name}`,
  what,
});

/** Every part, in the order the docs list them. */
export const SKIN_PARTS: readonly SkinPart[] = [
  part("app", "The window canvas, behind everything."),
  part(
    "drag-strip",
    "The strip the window is dragged by when the bar is not on top (desktop).",
  ),
  part("bar", "The switcher bar (a toolbar on any edge of the window)."),
  cls("bar-btn", "A button in the bar (+, layout, settings, …)."),
  part("chips", "The strip of tile chips in the bar."),
  part("chip", "One tile's chip (a tab); `.is-focused` on the focused tile's."),
  cls("chip-close", "A chip's close button."),
  part("cluster", "The area the tiles are laid out in."),
  part(
    "tile",
    "A tile's frame; `.is-focused`, `[data-maximized]`, `[data-web]`, `[data-agent-tile]`, `[data-harness]`.",
  ),
  part("tile-head", "A tile's header (its title bar)."),
  part("tile-title", "The title in a tile's header."),
  cls("tile-badge", "A badge in a tile's header (SSH, SANDBOX)."),
  part("tile-meta", "The right-hand side of a tile's header: age, rank, zoom."),
  part("tile-zoom", "The zoom pill of a tile that is not at 100%."),
  part("tile-buttons", "The group of window buttons in a tile's header."),
  part(
    "tile-button",
    'One window button; `[data-button="minimize" | "maximize" | "restore" | "close"]`.',
  ),
  part("tile-body", "A terminal tile's body (xterm draws inside it)."),
  cls("tile-grip", "A free-form tile's resize grip (edges and corners)."),
  part("agent-body", "An agent tile's body (its transcript and prompt)."),
  part(
    "composer",
    "A prompt box: the composer card of an agent tile or a harness overlay.",
  ),
  part("composer-input", "A prompt box's text field."),
  part(
    "composer-button",
    "A button in a prompt box (attach, saved, history, dictate, stop, Send).",
  ),
  part("web-toolbar", "A web tile's toolbar, in its header."),
  cls("web-btn", "A button in a web tile's toolbar."),
  part("web-address", "A web tile's address field."),
  part("web-chrome", "A web tile's bars under its header (bookmarks, find)."),
  cls("menu", "A menu or popover (bar menus, tile menus, context menus)."),
  cls(
    "menu-item",
    "A row in a menu; `.is-active` when it is the current choice.",
  ),
  cls("menu-heading", "A heading inside a menu."),
  cls("menu-sep", "A separator inside a menu."),
  part("dialog-backdrop", "The dimmed layer behind a dialog."),
  part("dialog", "A dialog (Settings, Connections, …)."),
  cls("settings-dialog", "The Settings dialog."),
  cls("settings-tab", "A category in the Settings sidebar."),
  part("settings-group", "A titled group of settings."),
  cls("field-select", "A drop-down."),
  cls("btn-primary", "A primary button."),
  cls("btn-quiet", "A secondary button."),
  cls("empty", "The message shown when no tile is open."),
];
