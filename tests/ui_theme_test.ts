import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import {
  applyChromeTheme,
  CHROME_TOKENS,
  type ColorTheme,
  DEFAULT_THEME_ID,
  isTintId,
  RGB_TOKENS,
  rgbTriplet,
  sanitizeThemeId,
  THEME_IDS,
  themeById,
  THEMES,
  TINT_IDS,
  tintColor,
} from "../lib/workspace/themes.ts";

/** Every xterm ITheme key a theme must define (all but the scrollbar / ruler extras). */
const TERMINAL_KEYS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionInactiveBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const HEX = /^#[0-9a-f]{6}$/;
const RGBA = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\)$/;

/** WCAG 2 relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  assert(HEX.test(hex), `${hex} is not #rrggbb`);
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two `#rrggbb` colours (1–21). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function assertContrast(
  theme: ColorTheme,
  what: string,
  fg: string,
  bg: string,
  min: number,
): void {
  const r = contrast(fg, bg);
  assert(
    r >= min,
    `${theme.id}: ${what} ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1`,
  );
}

Deno.test("themes: three dark then three light, unique ids, Sea Glass the default", () => {
  assertEquals(THEME_IDS, [
    "sea-glass",
    "plum",
    "ember",
    "paper",
    "cloud",
    "sakura",
  ]);
  assertEquals(THEMES.map((t) => t.scheme), [
    "dark",
    "dark",
    "dark",
    "light",
    "light",
    "light",
  ]);
  assertEquals(new Set(THEMES.map((t) => t.label)).size, THEMES.length);
  assertEquals(DEFAULT_THEME_ID, "sea-glass");
});

Deno.test("themes: every theme defines every chrome token and every terminal colour", () => {
  for (const t of THEMES) {
    assertEquals(
      Object.keys(t.chrome).sort(),
      [...CHROME_TOKENS].sort(),
      `${t.id} chrome tokens`,
    );
    for (const k of CHROME_TOKENS) {
      const v = t.chrome[k];
      if (k === "--shadow-a") {
        const a = Number(v);
        assert(a > 0 && a <= 1, `${t.id} ${k} = ${v}`);
      } else if ((RGB_TOKENS as readonly string[]).includes(k)) {
        assert(HEX.test(v), `${t.id} ${k} = ${v} must be #rrggbb`);
      } else {
        assert(HEX.test(v) || RGBA.test(v), `${t.id} ${k} = ${v}`);
      }
    }
    assertEquals(
      Object.keys(t.terminal).sort(),
      [...TERMINAL_KEYS].sort(),
      `${t.id} terminal keys`,
    );
    for (const k of TERMINAL_KEYS) {
      const v = t.terminal[k];
      assert(HEX.test(v) || RGBA.test(v), `${t.id} ${k} = ${v}`);
    }
    // The tile's padding around xterm must be the same colour as the terminal.
    assertEquals(t.terminal.background, t.chrome["--tile"], t.id);
    assertEquals(t.terminal.foreground, t.chrome["--text"], t.id);
  }
});

Deno.test("themes: contrast (WCAG) holds for every theme", () => {
  for (const t of THEMES) {
    const term = t.terminal;
    assertContrast(t, "foreground", term.foreground, term.background, 7);
    for (
      const hue of [
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
      ] as const
    ) {
      assertContrast(t, hue, term[hue], term.background, 3);
    }
    const c = t.chrome;
    assertContrast(t, "--text", c["--text"], c["--ink"], 7);
    assertContrast(t, "--text-2", c["--text-2"], c["--ink"], 4.5);
    assertContrast(t, "--accent-ink", c["--accent-ink"], c["--accent"], 4.5);
  }
});

Deno.test("themes: Sea Glass is exactly the stylesheet's :root and the original terminal colours", async () => {
  const css = await Deno.readTextFile(
    join(import.meta.dirname!, "../public/styles.css"),
  );
  const root = css.match(/:root\s*\{([^}]*)\}/)![1];
  const declared = new Map(
    [...root.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
  );
  const sea = themeById("sea-glass");
  for (const k of CHROME_TOKENS) {
    assertEquals(declared.get(k), sea.chrome[k], `:root ${k}`);
  }
  for (const k of RGB_TOKENS) {
    assertEquals(declared.get(`${k}-rgb`), rgbTriplet(sea.chrome[k]), k);
  }
  assert(/color-scheme:\s*dark;/.test(root));
  // The terminal theme before themes existed (lib/terminal-manager.ts TERMINAL_THEME).
  assertEquals(sea.terminal, {
    background: "#0d1117",
    foreground: "#d9e0e8",
    cursor: "#7fd8c2",
    cursorAccent: "#0d1117",
    selectionBackground: "rgba(127, 216, 194, 0.28)",
    selectionInactiveBackground: "rgba(127, 216, 194, 0.16)",
    black: "#1b222c",
    red: "#e07a74",
    green: "#8fd19e",
    yellow: "#f3c37a",
    blue: "#7fb4e6",
    magenta: "#c7a3e8",
    cyan: "#7fd8c2",
    white: "#c9d1db",
    brightBlack: "#5c6775",
    brightRed: "#f29a94",
    brightGreen: "#a8e6b5",
    brightYellow: "#ffd79a",
    brightBlue: "#9ccaf5",
    brightMagenta: "#dbbdf5",
    brightCyan: "#a2ead8",
    brightWhite: "#eef2f6",
  });
});

Deno.test("themes: sanitizeThemeId and themeById fall back to Sea Glass", () => {
  for (const id of THEME_IDS) assertEquals(sanitizeThemeId(id), id);
  for (const junk of ["", "Sea Glass", "solarized", 3, null, undefined, {}]) {
    assertEquals(sanitizeThemeId(junk), "sea-glass", String(junk));
  }
  assertEquals(themeById("plum").label, "Plum");
  assertStrictEquals(themeById("nope"), themeById("sea-glass"));
});

Deno.test("themes: applyChromeTheme sets every token, color-scheme and data-theme", () => {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const el = {
    style: {
      setProperty: (k: string, v: string) => void props.set(k, v),
      colorScheme: "",
    },
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
  };
  applyChromeTheme(el, themeById("paper"));
  assertEquals(
    props.size,
    CHROME_TOKENS.length + RGB_TOKENS.length + 2 * TINT_IDS.length,
  );
  assertEquals(props.get("--tint-red"), themeById("paper").terminal.red);
  assertEquals(
    props.get("--tint-red-rgb"),
    rgbTriplet(themeById("paper").terminal.red),
  );
  assertEquals(props.get("--ink"), "#f4f1ea");
  assertEquals(props.get("--accent-rgb"), "26, 127, 107");
  assertEquals(el.style.colorScheme, "light");
  assertEquals(attrs.get("data-theme"), "paper");
  applyChromeTheme(el, themeById("ember"));
  assertEquals(props.get("--accent"), "#ffb86b");
  assertEquals(el.style.colorScheme, "dark");
  assertEquals(attrs.get("data-theme"), "ember");
});

Deno.test("themes: every host tint is legible on every theme's tile and header", () => {
  for (const theme of THEMES) {
    const seen = new Set<string>();
    for (const id of TINT_IDS) {
      const hex = tintColor(theme, id);
      assert(/^#[0-9a-f]{6}$/.test(hex), `${theme.id} ${id}: ${hex}`);
      seen.add(hex);
      for (const bg of [theme.chrome["--tile"], theme.chrome["--head"]]) {
        const r = contrast(hex, bg);
        assert(r >= 3, `${theme.id} ${id} on ${bg}: ${r.toFixed(2)}`);
      }
    }
    assertEquals(seen.size, TINT_IDS.length, `${theme.id}: distinct tints`);
  }
});

Deno.test("themes: tints map onto the palette, orange between red and yellow", () => {
  const sea = themeById("sea-glass");
  assertEquals(tintColor(sea, "red"), sea.terminal.red);
  assertEquals(tintColor(sea, "purple"), sea.terminal.magenta);
  assertEquals(tintColor(sea, "blue"), sea.terminal.blue);
  // #e07a74 and #f3c37a → their midpoint.
  assertEquals(tintColor(sea, "orange"), "#ea9f77");
  assert(isTintId("green"));
  assert(!isTintId("pink"));
  assert(!isTintId(undefined));
});
