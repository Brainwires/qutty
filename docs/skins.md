# Skins

A **theme** sets Qutty's colours. A **skin** changes how the chrome is built and
drawn: fonts, borders and bevels, the title bars and window buttons on tiles,
button and scrollbar shapes, menus, dialogs, the switcher bar. A skin can also
bring colours of its own and say where the window buttons sit.

Pick one in **Settings → Appearance → Skin**. Two are built in:

- **Qutty**: the app's own look.
- **Classic**: a late-90s desktop. Grey bevelled frames, every tile a child
  window with a gradient title bar and square window buttons, a toolbar for the
  switcher bar, flat menus. It is drawn entirely in CSS.

Your own skins are folders in the skins folder. The same Settings group has
**Open skins folder**, **Reload skins** and **Start from Classic**.

## Start from Classic

The quickest way to make a skin: press **Start from Classic** in Settings →
Appearance → Skin. It copies the Classic skin into your skins folder as
`my-classic` (then `my-classic-2`, …), with its selectors already pointed at the
new id. Open the folder, edit `skin.css` and `skin.json`, and press **Reload
skins** to see each change. Classic's source is also in the repository:
[`public/skins/classic/`](../public/skins/classic/).

## Where skins live

| System | Folder                                                     |
| ------ | ---------------------------------------------------------- |
| macOS  | `~/Library/Application Support/org.qutty.Qutty/skins/`     |
| Linux  | the app's data folder, `skins/` inside it                  |
| Either | `~/.qutty/skins/` when the system gives no app data folder |

**Open skins folder** opens the right one (and makes it if it is missing), so
you never need to find it by hand.

Each skin is one folder, and the folder's name is the skin's id:

```
skins/
  my-skin/
    skin.json       required
    skin.css        optional (a skin can be colours and frame options only)
    img/tile.png    optional assets: images and fonts, anywhere inside the folder
    fonts/pixel.woff2
```

## skin.json

```json
{
  "id": "my-skin",
  "name": "My Skin",
  "author": "You",
  "version": "1.0.0",
  "description": "One line about it.",
  "theme": "plum",
  "terminal": {
    "fontFamily": "\"Pixel Mono\", monospace",
    "theme": { "cursor": "#ff00ff" }
  },
  "fonts": [
    { "family": "Pixel Mono", "file": "fonts/pixel.woff2", "weight": 400 }
  ],
  "frame": {
    "buttons": "left",
    "title": "center",
    "buttonOrder": ["close", "minimize", "maximize"]
  }
}
```

| Field         | Required | What it is                                                                                                                                                                           |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | yes      | 1 to 40 lower-case letters, digits or dashes. It must equal the folder's name. `qutty` and `classic` are taken.                                                                      |
| `name`        | yes      | What the picker shows (60 characters at most).                                                                                                                                       |
| `author`      | no       | Shown under the picker.                                                                                                                                                              |
| `version`     | no       | Free text.                                                                                                                                                                           |
| `description` | no       | One line, shown under the picker (300 characters at most).                                                                                                                           |
| `theme`       | no       | The colours the skin brings: a theme id (`sea-glass`, `plum`, `ember`, `paper`, `cloud`, `sakura`), or an object (below). Without it the skin takes whatever theme is chosen.        |
| `terminal`    | no       | `fontFamily`: a font list put ahead of the chosen terminal font. `theme`: xterm colours to replace (`background`, `foreground`, `cursor`, `red`, `brightBlue`, …), each `#rrggbb`.   |
| `fonts`       | no       | Up to 8 fonts to load from the skin folder: `family`, `file` (woff2, woff, ttf or otf), optional `weight` (`normal`, `bold`, 100 to 900) and `style` (`normal`, `italic`).           |
| `frame`       | no       | The skin's defaults for tile frames: `buttons` (`left` or `right`), `title` (`left`, `center`, `right`), `buttonOrder` (all of `minimize`, `maximize`, `close`, in the order drawn). |

A `theme` object starts from one theme (`base`, `sea-glass` when left out) and
replaces some of its tokens:

```json
"theme": {
  "base": "paper",
  "scheme": "light",
  "tokens": { "--panel": "#c0c0c0", "--accent": "#000080", "--shadow-a": 0.5 }
}
```

The tokens are the ones every theme sets: `--ink` (the window canvas), `--ink-2`
(the bar), `--tile` (the terminal's background), `--head` (tile headers),
`--line`, `--line-2`, `--panel` (menus and dialogs), `--text`, `--text-2`,
`--text-3`, `--accent`, `--accent-ink`, `--accent-glow`, `--amber`, `--red`,
`--hi`, `--shadow` and `--shadow-a`. Each is a `#rrggbb` colour, except
`--accent-glow` (which may be an `rgba()`) and `--shadow-a` (a number from 0 to
1). The terminal's background, text, cursor and selection follow `--tile`,
`--text` and `--accent`, and its 16 ANSI colours are the base theme's.

In Settings, **Use the skin's colours and terminal font** turns a skin's `theme`
and `terminal` off, so the skin keeps its shapes and takes the chosen theme. A
skin that should look right either way styles with the tokens (`var(--panel)`,
`var(--text)`) rather than fixed colours, as Classic does.

A skin.json that does not pass these checks is not loaded, and Settings shows
the reason next to the folder's name.

## skin.css

Qutty sets `data-skin="<id>"` on the document element while your skin is on, so
write every rule under `:root[data-skin="<id>"]`:

```css
:root[data-skin="my-skin"] [data-part="tile"] {
  border-radius: 0;
  border-color: var(--accent);
}
:root[data-skin="my-skin"] [data-part="tile-head"] {
  background: linear-gradient(90deg, var(--accent), var(--panel));
  color: var(--accent-ink);
  font-weight: 700;
}
```

Your stylesheet is applied after the app's own, so on a tie your rule wins, and
the `:root[data-skin="…"]` prefix puts most rules ahead anyway. A few of the
app's rules are more specific (a tile's activity tint, for one); repeat a part
of your selector or add the state the base rule names to get past one.
`!important` is rarely needed.

### A minimal skin

`skins/outline/skin.json`:

```json
{ "id": "outline", "name": "Outline", "frame": { "title": "center" } }
```

`skins/outline/skin.css`:

```css
:root[data-skin="outline"] [data-part="tile"] {
  border: 1px dashed var(--line-2);
  border-radius: 0;
  box-shadow: none;
}
:root[data-skin="outline"] [data-part="tile-head"] {
  background: transparent;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

## The contract: what a skin can target

These selectors are the skin API. They stay the same from release to release;
anything else in the page (other class names, the markup inside a part) may
change without notice.

### On the document element

| Attribute or property                                                     | What it is                                                                                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-skin="<id>"`                                                        | The skin in use (`qutty` for the app's own look).                                                                                             |
| `data-theme="<id>"`                                                       | The colour theme in use (a skin's base theme when it brings colours).                                                                         |
| `data-frame-buttons="left"` or `"right"`                                  | Which side of a tile header its window buttons are on.                                                                                        |
| `data-frame-title="left"`, `"center"` or `"right"`                        | How a tile header's title is aligned.                                                                                                         |
| `--frame-order-minimize`, `--frame-order-maximize`, `--frame-order-close` | Each window button's place in the group, 1 to 3 (the buttons' `order`).                                                                       |
| The theme tokens (`--ink`, `--panel`, `--text`, `--accent`, …)            | The colours. Each of `--accent`, `--red`, `--hi`, `--text-2`, `--panel`, `--shadow` also has an `-rgb` form (`rgba(var(--accent-rgb), 0.2)`). |
| `data-chat-size="small"`, `"medium"` or `"large"`                         | Settings → Appearance → Chat text: the agent chat's type scale (below).                                                                       |

### Parts

| Selector                         | What it is                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `[data-part="app"]`              | The window canvas, behind everything.                                                                                                     |
| `[data-part="drag-strip"]`       | The strip the window is dragged by when the bar is not on top (desktop).                                                                  |
| `[data-part="bar"]`              | The switcher bar: a toolbar on any edge of the window (`.bar-top`, `.bar-bottom`, `.bar-left`, `.bar-right`).                             |
| `.bar-btn`                       | A button in the bar (+, layout, settings, …); `.is-open` while its menu is open.                                                          |
| `[data-part="chips"]`            | The strip of tile chips in the bar.                                                                                                       |
| `[data-part="chip"]`             | One tile's chip (a tab); `.is-focused` on the focused tile's, `.is-minimized`, `.is-overflow`.                                            |
| `.chip-close`                    | A chip's close button.                                                                                                                    |
| `[data-part="cluster"]`          | The area the tiles are laid out in.                                                                                                       |
| `[data-part="tile"]`             | A tile's frame. States: `.is-focused`, `[data-maximized]`, `[data-web]`, `[data-agent-tile]`, `[data-harness]`.                           |
| `[data-part="tile-head"]`        | A tile's header: its title bar.                                                                                                           |
| `[data-part="tile-title"]`       | The title in a tile's header.                                                                                                             |
| `.tile-badge`                    | A badge in a tile's header (SSH, SANDBOX).                                                                                                |
| `[data-part="tile-meta"]`        | The far side of a tile's header: age, recency rank, zoom.                                                                                 |
| `[data-part="tile-zoom"]`        | The zoom pill of a tile that is not at 100%.                                                                                              |
| `[data-part="tile-buttons"]`     | The group of window buttons in a tile's header.                                                                                           |
| `[data-part="tile-button"]`      | One window button: `[data-button="minimize"]`, `"maximize"`, `"restore"` or `"close"`.                                                    |
| `[data-part="tile-body"]`        | A terminal tile's body (xterm draws inside it).                                                                                           |
| `.tile-grip`                     | A free-form tile's resize grip (its edges and corners).                                                                                   |
| `[data-part="agent-body"]`       | An agent tile's body: its transcript and prompt.                                                                                          |
| `[data-part="scm-body"]`         | A Source Control tile's body: its panel and diff.                                                                                         |
| `[data-part="agent-message"]`    | A message in an agent tile's transcript: `[data-type="user"]` (a bubble) or `[data-type="text"]` (the agent's).                           |
| `[data-part="agent-tool"]`       | A tool call's card in an agent tile's transcript; `[data-status]`, `[data-open]` once expanded.                                           |
| `[data-part="agent-permission"]` | A permission question's card (Allow, Allow always, Deny); `.is-open` until answered.                                                      |
| `[data-part="agent-welcome"]`    | An agent tile's empty state: the backend's avatar, what to ask, the folder.                                                               |
| `[data-part="agent-jump"]`       | An agent tile's "Jump to latest" pill: centred over the bottom of the transcript, just above the prompt box (the companion keeps off it). |
| `[data-part="composer"]`         | A prompt box: the composer card of an agent tile or a harness overlay. `[data-empty]` while nothing is typed.                             |
| `[data-part="composer-input"]`   | A prompt box's text field.                                                                                                                |
| `[data-part="composer-button"]`  | A button in a prompt box: `.agent-tool-btn` (attach, saved, history, dictate), `.agent-stop`, `.agent-send`.                              |
| `[data-part="web-toolbar"]`      | A web tile's toolbar, in its header.                                                                                                      |
| `.web-btn`                       | A button in a web tile's toolbar.                                                                                                         |
| `[data-part="web-address"]`      | A web tile's address field.                                                                                                               |
| `[data-part="web-chrome"]`       | A web tile's bars under its header (bookmarks, find).                                                                                     |
| `.menu`                          | A menu or popover: the bar's menus, a tile's menus, context menus.                                                                        |
| `.menu-item`                     | A row in a menu; `.is-active` when it is the current choice.                                                                              |
| `.menu-heading`                  | A heading inside a menu.                                                                                                                  |
| `.menu-sep`                      | A separator inside a menu.                                                                                                                |
| `[data-part="dialog-backdrop"]`  | The dimmed layer behind a dialog.                                                                                                         |
| `[data-part="dialog"]`           | A dialog (Settings, Connections, …).                                                                                                      |
| `.settings-dialog`               | The Settings dialog.                                                                                                                      |
| `.settings-tab`                  | A category in the Settings sidebar; `.is-active` on the open one.                                                                         |
| `[data-part="settings-group"]`   | A titled group of settings.                                                                                                               |
| `.field-select`                  | A drop-down.                                                                                                                              |
| `.btn-primary`                   | A primary button.                                                                                                                         |
| `.btn-quiet`                     | A secondary button.                                                                                                                       |
| `.empty`                         | The message shown when no tile is open.                                                                                                   |

### The agent chat's type scale

An agent tile's transcript and every prompt box (an agent tile's, a harness
overlay's) size their text from one property, `--chat-size`: 15px by default,
13px or 17px when Settings → Appearance → Chat text is Small or Large
(`data-chat-size` on the document element). From it, on
`[data-part="agent-body"]` and `[data-part="composer"]`:

| Property           | What it is                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `--chat-size`      | Body text: messages, the prompt box's text field (with `--chat-lh`, 1.6).                      |
| `--chat-text-sm`   | Secondary text (13px at Medium): tool cards, thinking, footers, notices, buttons, the tabs.    |
| `--chat-text-xs`   | Labels and pills (12px at Medium): attachments, the prompt box's key hint.                     |
| `--chat-code-size` | Code blocks, tool output, diffs and permission previews (13px at Medium; the terminal's font). |

Write sizes in your skin with these instead of fixed pixels, so the setting
keeps working (Classic does, in its own typeface). A skin may also set
`--chat-size` itself, on `:root[data-skin="my-skin"]`, to change the whole
scale. The transcript's column is `--chat-col` wide at most (it grows with the
tile, from 720px to 1120px), its prose `--chat-measure` (48em).

Scrollbars are styled with the `::-webkit-scrollbar` pseudo-elements under your
skin's root selector (`:root[data-skin="my-skin"] ::-webkit-scrollbar-thumb`).
The terminal's own scrollbar is drawn by xterm and follows the theme.

### Two things to leave alone

- A tile's **border stays 1px wide** and its **header 26px tall**. The layout
  works out a terminal's size from both (and "scale inactive tiles" draws with
  them). Draw a thicker frame with `box-shadow: inset …`, an overlay
  (`[data-part="tile"]::after`) or a background, as Classic does.
- Keep the window buttons reachable. You can hide one with `display: none`, but
  leave a way to close a tile.

## Tile frame options

Two layout options for tile frames work under every skin:

- **Frame buttons**: a tile's Minimize, Maximize and Close buttons sit on the
  **left** or the **right** of its header.
- **Title**: the header's title is aligned **left**, **center** or **right**.

A skin sets its defaults in `skin.json`:

```json
"frame": { "buttons": "right", "title": "left", "buttonOrder": ["minimize", "maximize", "close"] }
```

Classic uses right-side buttons and a left title. Without `buttonOrder` the
order is the usual one for the side: Close outermost
(`minimize, maximize,
close` on the right; `close, minimize, maximize` on the
left).

The user can override both in Settings → Appearance → Skin: **Frame buttons**
(Skin default / Left / Right) and **Title** (Skin default / Left / Center /
Right). The user's choice wins over the skin's. When the user moves the buttons
to the other side than the skin chose, they take that side's usual order.

Qutty puts the result on the document element as `data-frame-buttons` and
`data-frame-title`, and the app's own stylesheet lays the header out from them,
so your skin does not have to do anything for them to work. If your skin draws
the two sides differently, target them:

```css
:root[data-skin="my-skin"][data-frame-buttons="left"] [data-part="tile-buttons"] {
  margin-right: 8px;
}
```

Notes:

- These cover the headers of tiles: terminals, agent tiles and web tiles. A web
  tile's and an agent tile's header is mostly its toolbar, so the title's
  alignment shows most on terminal tiles.
- On macOS the window's own close, minimize and zoom buttons (the traffic
  lights) are drawn by the system and stay at the top left. Skins and these
  options do not move or restyle them.

## Security rules

A skin is data. It cannot run code and it cannot reach the network:

- **No JavaScript.** A skin is a JSON file, a stylesheet and assets. Nothing in
  a skin folder is ever executed.
- **No network.** The stylesheet is refused when it has `@import`, or a `url()`
  that is anything but a relative path inside the skin's own folder, a
  `#fragment`, or a `data:` URL of an image or font type. So no `http:`,
  `https:`, `//host`, `file:`, absolute paths or `..`.
- **Only these at-rules:** `@media`, `@supports`, `@font-face`, `@keyframes`,
  `@layer`, `@container`, `@property`, `@starting-style`.
- **Not allowed at all:** `image-set()`, `image()`, `src()`, `element()`,
  `expression()`, `behavior`, `-moz-binding`, and backslash escapes outside a
  quoted string or inside a `url()` (they can spell `url` or `@import` in ways a
  reader would not see).
- **Assets are inlined.** Qutty reads each image and font your stylesheet names
  and hands the page a `data:` URL; the page never loads a file from the folder.
  Assets must be png, jpg, gif, webp, svg, woff2, woff, ttf or otf, inside the
  skin's folder (a symlink that leads out of it is refused).
- **Sizes:** skin.json up to 32 KB, skin.css up to 256 KB, each asset up to 768
  KB, a skin's assets up to 2 MB together.

A stylesheet that breaks a rule is refused whole, not repaired: Settings shows
the line and the reason, and Qutty's own look is used until the skin is fixed.
The same checks run twice, once when the skin is read and again in the window
before it is applied. Do not ship fonts or images you have no licence to
redistribute; put the licence file in the skin's folder.

## Limits

- A skin restyles the workspace windows. The floating companion's own window
  keeps Qutty's look and the chosen theme.
- Picking a skin applies it at once; there is no hover preview.
