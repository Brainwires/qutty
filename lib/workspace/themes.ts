/**
 * Colour themes: the app chrome's CSS custom properties and the matching xterm theme, for three
 * dark and three light palettes. `sea-glass` is the default and its chrome tokens are exactly the
 * `:root` block of public/styles.css (a unit test keeps the two in step), so the first paint
 * before any script runs is already correct for it.
 *
 * A theme is applied by `applyChromeTheme` (CSS variables + `data-theme` + `color-scheme` on the
 * document element) and by `TerminalManager.setTheme` (every xterm instance).
 *
 * @module
 */

import type { ITheme } from "../xterm.ts";

/** Every chrome token a theme sets, as CSS custom property names. */
export const CHROME_TOKENS = [
  "--ink", // window canvas
  "--ink-2", // bar
  "--tile", // terminal background (= the xterm theme's background)
  "--head", // tile header strip
  "--line", // hairlines
  "--line-2",
  "--panel", // menus and the settings popover
  "--text",
  "--text-2",
  "--text-3",
  "--accent", // focus
  "--accent-ink", // text on a solid accent
  "--accent-glow",
  "--amber", // activity (not always amber: see Ember)
  "--red", // exited
  "--hi", // the base of hover / raised overlays (white on dark, ink on light)
  "--shadow", // the base of drop shadows
  "--shadow-a", // drop-shadow strength (1 on dark themes; light themes soften them)
] as const;

/**
 * The tokens the stylesheet also uses as bare `r, g, b` triplets (`--accent-rgb` …), for
 * translucent tints: `rgba(var(--accent-rgb), 0.12)`. Legacy `rgba()` rather than `color-mix()`
 * because Chromium composites the two a level apart, and Sea Glass must stay pixel-identical.
 * `applyChromeTheme` derives them; these tokens must be `#rrggbb`.
 */
export const RGB_TOKENS = [
  "--accent",
  "--red",
  "--hi",
  "--text-2",
  "--panel",
  "--shadow",
] as const satisfies readonly ChromeToken[];

/** One chrome token name. */
export type ChromeToken = typeof CHROME_TOKENS[number];

/** A theme id (what is persisted). */
export type ThemeId =
  | "sea-glass"
  | "plum"
  | "ember"
  | "paper"
  | "cloud"
  | "sakura";

/** One colour theme. */
export interface ColorTheme {
  id: ThemeId;
  /** What the picker shows. */
  label: string;
  /** Sets `color-scheme` and the picker group. */
  scheme: "dark" | "light";
  chrome: Record<ChromeToken, string>;
  /** The full xterm theme (background, cursor, selection and all 16 ANSI colours). */
  terminal: Required<
    Omit<
      ITheme,
      | "scrollbarSliderBackground"
      | "scrollbarSliderHoverBackground"
      | "scrollbarSliderActiveBackground"
      | "overviewRulerBorder"
      | "selectionForeground"
      | "extendedAnsi"
    >
  >;
}

/** The 16 ANSI colours, in the order xterm numbers them (0–15). */
type Ansi16 = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** What a palette spells out; `defineTheme` derives the rest. */
interface Palette {
  id: ThemeId;
  label: string;
  scheme: "dark" | "light";
  /** The chrome tokens, in `CHROME_TOKENS` order. */
  chrome: readonly string[];
  /** Selection alpha for the focused and the unfocused terminal. */
  selection: readonly [number, number];
  ansi: Ansi16;
}

/** `#rrggbb` → `rgba(r, g, b, a)`. */
function alpha(hex: string, a: number): string {
  return `rgba(${rgbTriplet(hex)}, ${a})`;
}

function defineTheme(p: Palette): ColorTheme {
  if (p.chrome.length !== CHROME_TOKENS.length) {
    throw new Error(`theme ${p.id}: expected ${CHROME_TOKENS.length} tokens`);
  }
  const chrome = Object.fromEntries(
    CHROME_TOKENS.map((t, i) => [t, p.chrome[i]]),
  ) as Record<ChromeToken, string>;
  const bg = chrome["--tile"];
  const accent = chrome["--accent"];
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = p.ansi;
  return {
    id: p.id,
    label: p.label,
    scheme: p.scheme,
    chrome,
    terminal: {
      background: bg,
      foreground: chrome["--text"],
      cursor: accent,
      cursorAccent: bg,
      selectionBackground: alpha(accent, p.selection[0]),
      selectionInactiveBackground: alpha(accent, p.selection[1]),
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack,
      brightRed,
      brightGreen,
      brightYellow,
      brightBlue,
      brightMagenta,
      brightCyan,
      brightWhite,
    },
  };
}

// Chrome columns: ink, ink-2, tile, head, line, line-2, panel, text, text-2, text-3, accent,
// accent-ink, accent-glow, amber (activity), red, hi, shadow, shadow strength.
// ANSI rows: black red green yellow blue magenta cyan white, then the bright eight.

/** Every theme, dark ones first (the picker's order). */
export const THEMES: readonly ColorTheme[] = [
  defineTheme({
    id: "sea-glass",
    label: "Sea Glass",
    scheme: "dark",
    chrome: [
      "#0d1015",
      "#10141a",
      "#0d1117",
      "#141a22",
      "#222a35",
      "#2d3744",
      "#151b23",
      "#d9e0e8",
      "#8e99a8",
      "#5f6a78",
      "#7fd8c2",
      "#0b1513",
      "rgba(127, 216, 194, 0.22)",
      "#f3c37a",
      "#e07a74",
      "#ffffff",
      "#000000",
      "1",
    ],
    selection: [0.28, 0.16],
    ansi: [
      "#1b222c",
      "#e07a74",
      "#8fd19e",
      "#f3c37a",
      "#7fb4e6",
      "#c7a3e8",
      "#7fd8c2",
      "#c9d1db",
      "#5c6775",
      "#f29a94",
      "#a8e6b5",
      "#ffd79a",
      "#9ccaf5",
      "#dbbdf5",
      "#a2ead8",
      "#eef2f6",
    ],
  }),
  defineTheme({
    id: "plum",
    label: "Plum",
    scheme: "dark",
    chrome: [
      "#14111c",
      "#18141f",
      "#17131f",
      "#1e1828",
      "#2c2438",
      "#3a3048",
      "#1d1726",
      "#e4dcef",
      "#a497b5",
      "#6f6380",
      "#c3a6ff",
      "#1a1030",
      "rgba(195, 166, 255, 0.22)",
      "#f3c37a",
      "#ef8a95",
      "#ffffff",
      "#000000",
      "1",
    ],
    selection: [0.28, 0.16],
    ansi: [
      "#251e31",
      "#f28b9b",
      "#9ad7a4",
      "#f0c987",
      "#8fb3f5",
      "#c3a6ff",
      "#86d4dc",
      "#cfc6dc",
      "#6b5f7d",
      "#ffadb9",
      "#b5ebbd",
      "#ffdea6",
      "#b0cbff",
      "#dac7ff",
      "#a8e7ee",
      "#f4effa",
    ],
  }),
  defineTheme({
    id: "ember",
    label: "Ember",
    scheme: "dark",
    chrome: [
      "#15120f",
      "#1a1612",
      "#18140f",
      "#211b15",
      "#31291f",
      "#3f3528",
      "#201a14",
      "#ece2d6",
      "#a89a8a",
      "#75695c",
      "#ffb86b",
      "#2a1703",
      "rgba(255, 184, 107, 0.22)",
      "#7ccfc0",
      "#ee8572",
      "#ffffff",
      "#000000",
      "1",
    ],
    selection: [0.28, 0.16],
    ansi: [
      "#2a231b",
      "#ee8572",
      "#b5cf7f",
      "#ffc66d",
      "#8db4d9",
      "#d79ab8",
      "#86c9b6",
      "#d6cabb",
      "#786a5a",
      "#ffa593",
      "#cde39b",
      "#ffd896",
      "#aecbea",
      "#ebb7d0",
      "#a6ddcd",
      "#f7efe5",
    ],
  }),
  defineTheme({
    id: "paper",
    label: "Paper",
    scheme: "light",
    chrome: [
      "#f4f1ea",
      "#ebe7de",
      "#fbf9f4",
      "#f0ece3",
      "#ddd7ca",
      "#cbc3b3",
      "#fbf9f4",
      "#2b2a27",
      "#5f5b53",
      "#8a857a",
      "#1a7f6b",
      "#ffffff",
      "rgba(26, 127, 107, 0.18)",
      "#a8690b",
      "#b8392f",
      "#2b2a27",
      "#3c301c",
      "0.4",
    ],
    selection: [0.22, 0.12],
    ansi: [
      "#2b2a27",
      "#b8392f",
      "#3d7f2a",
      "#8a6400",
      "#2f62b0",
      "#8e4aa6",
      "#1a7d70",
      "#8a857a",
      "#6e6a61",
      "#cc4a40",
      "#4c9437",
      "#a07a00",
      "#4277c4",
      "#a35dbb",
      "#279184",
      "#b4aea2",
    ],
  }),
  defineTheme({
    id: "cloud",
    label: "Cloud",
    scheme: "light",
    chrome: [
      "#eef1f5",
      "#e5e9ef",
      "#f8fafc",
      "#edf0f5",
      "#d5dbe4",
      "#c3cbd7",
      "#f8fafc",
      "#1f2733",
      "#536070",
      "#8791a0",
      "#2f6fdb",
      "#ffffff",
      "rgba(47, 111, 219, 0.18)",
      "#a8690b",
      "#c23a33",
      "#1f2733",
      "#142038",
      "0.4",
    ],
    selection: [0.22, 0.12],
    ansi: [
      "#1f2733",
      "#c2362f",
      "#2f7d32",
      "#8a6400",
      "#2f6fdb",
      "#8f45b8",
      "#137b8a",
      "#8791a0",
      "#5f6b7a",
      "#d64a42",
      "#3c943f",
      "#a07800",
      "#4d86e8",
      "#a55ccc",
      "#1c93a3",
      "#b3bcc8",
    ],
  }),
  defineTheme({
    id: "sakura",
    label: "Sakura",
    scheme: "light",
    chrome: [
      "#f8eef1",
      "#f2e4e9",
      "#fdf7f8",
      "#f6eaee",
      "#e6d3da",
      "#d8c0c9",
      "#fdf7f8",
      "#3a2a31",
      "#6e5862",
      "#9c8690",
      "#b8456f",
      "#ffffff",
      "rgba(184, 69, 111, 0.18)",
      "#9a6608",
      "#b5352f",
      "#3a2a31",
      "#461e2d",
      "0.4",
    ],
    selection: [0.2, 0.11],
    ansi: [
      "#3a2a31",
      "#b8352f",
      "#3f7d3a",
      "#8a6200",
      "#3d64b0",
      "#a83e78",
      "#1f7a80",
      "#9c8690",
      "#7a6670",
      "#cc4a44",
      "#4f944a",
      "#a07600",
      "#5079c4",
      "#c0558f",
      "#2a9097",
      "#c4b2ba",
    ],
  }),
];

/** The theme a fresh install (and any unreadable stored value) gets. */
export const DEFAULT_THEME_ID: ThemeId = "sea-glass";

/** Every valid theme id, in picker order. */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((t) => t.id);

/** A stored / untrusted value → a valid theme id (`sea-glass` for anything unknown). */
export function sanitizeThemeId(raw: unknown): ThemeId {
  return typeof raw === "string" && THEME_IDS.includes(raw as ThemeId)
    ? raw as ThemeId
    : DEFAULT_THEME_ID;
}

/** The theme for an id (the default for an unknown one). */
export function themeById(id: string): ColorTheme {
  return THEMES.find((t) => t.id === id) ??
    THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

// ---------------------------------------------------------------------------------------------
// Host tints
// ---------------------------------------------------------------------------------------------

/**
 * The tint ids an SSH host can carry (stored as `tint` in its `# qutty:` comment). Each maps onto
 * the current theme's ANSI palette, which every theme already tunes for legibility on its own
 * background, so a tint reads in all six themes and follows a theme switch.
 */
export const TINT_IDS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
] as const;

/** One tint id. */
export type TintId = typeof TINT_IDS[number];

/** Whether `raw` is a known tint id (a host from another tool may carry anything). */
export function isTintId(raw: unknown): raw is TintId {
  return typeof raw === "string" &&
    (TINT_IDS as readonly string[]).includes(raw);
}

/**
 * `p` (0–1, the midpoint by default) of `#rrggbb` `a` over `b`, as CSS
 * `color-mix(in srgb, a p%, b)` mixes them (the activity tints' contrast is checked with it).
 */
export function mixHex(a: string, b: string, p = 0.5): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const c = ((pa >> shift) & 255) * p + ((pb >> shift) & 255) * (1 - p);
    out |= Math.round(c) << shift;
  }
  return `#${out.toString(16).padStart(6, "0")}`;
}

/** A tint's colour in `theme` (`#rrggbb`). Orange, which ANSI lacks, is red mixed with yellow. */
export function tintColor(theme: ColorTheme, tint: TintId): string {
  const t = theme.terminal;
  switch (tint) {
    case "red":
      return t.red;
    case "orange":
      return mixHex(t.red, t.yellow);
    case "yellow":
      return t.yellow;
    case "green":
      return t.green;
    case "blue":
      return t.blue;
    case "purple":
      return t.magenta;
  }
}

/** What `applyChromeTheme` needs from the document element (a stub in tests). */
export interface ThemeTarget {
  style: {
    setProperty(name: string, value: string): void;
    colorScheme: string;
  };
  setAttribute(name: string, value: string): void;
}

/** `#rrggbb` → `r, g, b` (the `--*-rgb` form). */
export function rgbTriplet(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`;
}

/**
 * Put a theme's chrome tokens (and their `--*-rgb` triplets), the host tints, `data-theme` and
 * `color-scheme` on the document element.
 */
export function applyChromeTheme(el: ThemeTarget, theme: ColorTheme): void {
  for (const t of CHROME_TOKENS) el.style.setProperty(t, theme.chrome[t]);
  for (const t of RGB_TOKENS) {
    el.style.setProperty(`${t}-rgb`, rgbTriplet(theme.chrome[t]));
  }
  // Host tints: `--tint-red` … and their triplets (styles.css maps `[data-tint]` onto them).
  for (const id of TINT_IDS) {
    const hex = tintColor(theme, id);
    el.style.setProperty(`--tint-${id}`, hex);
    el.style.setProperty(`--tint-${id}-rgb`, rgbTriplet(hex));
  }
  el.style.colorScheme = theme.scheme;
  el.setAttribute("data-theme", theme.id);
}
