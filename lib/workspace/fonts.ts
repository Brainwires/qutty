/**
 * The terminal font: a curated list of monospace families (plus a free-form "Custom…" entry),
 * the ranges the size / line-height settings are clamped to, the pure `fontStack` helper that
 * builds the CSS `font-family` handed to xterm, and installed-font detection.
 *
 * No web fonts are ever fetched: every family here is looked up on the system, and the stack
 * always ends in the generic `monospace` so a missing family degrades to the platform default.
 *
 * @module
 */

/** One entry of the family picker. */
export interface FontOption {
  /** Stable id (what is persisted). */
  id: string;
  /** What the picker shows. */
  label: string;
  /** The CSS family list, without the trailing `monospace` (see `fontStack`). */
  css: string;
  /** The family tokens probed by `detectInstalledFonts`; any one present counts as installed. */
  probe: string[];
}

/** The id of the free-form entry (the family name is `fontFamilyCustom`). */
export const CUSTOM_FONT_ID = "custom";

/** The curated families, in picker order (before installed-first sorting). */
export const FONT_OPTIONS: readonly FontOption[] = [
  {
    id: "sf-mono",
    label: "SF Mono",
    css: 'ui-monospace, "SF Mono", Menlo',
    probe: ["ui-monospace", '"SF Mono"'],
  },
  { id: "menlo", label: "Menlo", css: "Menlo", probe: ["Menlo"] },
  { id: "monaco", label: "Monaco", css: "Monaco", probe: ["Monaco"] },
  ...[
    ["jetbrains-mono", "JetBrains Mono"],
    ["fira-code", "Fira Code"],
    ["cascadia-code", "Cascadia Code"],
    ["source-code-pro", "Source Code Pro"],
    ["ibm-plex-mono", "IBM Plex Mono"],
  ].map(([id, name]) => ({
    id,
    label: name,
    css: `"${name}"`,
    probe: [`"${name}"`],
  })),
  { id: "hack", label: "Hack", css: "Hack", probe: ["Hack"] },
  { id: "iosevka", label: "Iosevka", css: "Iosevka", probe: ["Iosevka"] },
  {
    id: "courier-new",
    label: "Courier New",
    css: '"Courier New"',
    probe: ['"Courier New"'],
  },
];

/** Every id `fontFamily` may hold (the curated ones plus `custom`). */
export const FONT_IDS: readonly string[] = [
  ...FONT_OPTIONS.map((f) => f.id),
  CUSTOM_FONT_ID,
];

/** A font weight the settings offer. */
export type FontWeightSetting = "normal" | "500";

/** The font fields of the persisted settings. */
export interface FontSettings {
  /** An id from `FONT_IDS`. */
  fontFamily: string;
  /** The family typed into "Custom…" (used when `fontFamily` is `custom`). */
  fontFamilyCustom: string;
  /** Integer px, `FONT_RANGES.fontSize`. */
  fontSize: number;
  /** A multiple of the cell height, `FONT_RANGES.lineHeight`. */
  lineHeight: number;
  fontWeight: FontWeightSetting;
}

export const DEFAULT_FONT_SETTINGS: FontSettings = {
  fontFamily: "sf-mono",
  fontFamilyCustom: "",
  fontSize: 13,
  lineHeight: 1.15,
  fontWeight: "normal",
};

/** The range each numeric font setting is clamped to. */
export const FONT_RANGES = {
  fontSize: { min: 9, max: 32, step: 1 },
  lineHeight: { min: 1, max: 1.6, step: 0.05 },
} as const;

/** The longest custom family name kept. */
export const CUSTOM_FAMILY_MAX = 64;

/** Look a curated family up by id. */
function fontOption(id: string): FontOption | undefined {
  return FONT_OPTIONS.find((f) => f.id === id);
}

/**
 * Clean a user-typed family name so it is safe inside a quoted CSS family: quotes, backslashes
 * and CSS punctuation are dropped, runs of whitespace collapse, and it is capped in length.
 */
export function sanitizeCustomFamily(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/["'\\;{}<>()\[\]:,@!*\/]/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CUSTOM_FAMILY_MAX)
    .trim();
}

function clamp(v: unknown, min: number, max: number, fallback: number) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a (partial, possibly untrusted) font patch onto a base. Absent fields keep the base. */
export function sanitizeFont(
  base: FontSettings,
  patch: Partial<Record<keyof FontSettings, unknown>>,
): FontSettings {
  const out = { ...base };
  if (typeof patch.fontFamily === "string") {
    out.fontFamily = FONT_IDS.includes(patch.fontFamily)
      ? patch.fontFamily
      : DEFAULT_FONT_SETTINGS.fontFamily;
  } else if (patch.fontFamily !== undefined) {
    out.fontFamily = DEFAULT_FONT_SETTINGS.fontFamily;
  }
  if (patch.fontFamilyCustom !== undefined) {
    out.fontFamilyCustom = sanitizeCustomFamily(patch.fontFamilyCustom);
  }
  if (patch.fontSize !== undefined) {
    const r = FONT_RANGES.fontSize;
    out.fontSize = Math.round(
      clamp(patch.fontSize, r.min, r.max, base.fontSize),
    );
  }
  if (patch.lineHeight !== undefined) {
    const r = FONT_RANGES.lineHeight;
    out.lineHeight =
      Math.round(clamp(patch.lineHeight, r.min, r.max, base.lineHeight) * 100) /
      100;
  }
  if (patch.fontWeight !== undefined) {
    const w = String(patch.fontWeight);
    out.fontWeight = w === "500"
      ? "500"
      : w === "normal" || w === "400"
      ? "normal"
      : base.fontWeight;
  }
  return out;
}

/** The size one step bigger (`dir` 1) or smaller (-1), clamped. */
export function stepFontSize(size: number, dir: 1 | -1): number {
  const r = FONT_RANGES.fontSize;
  return Math.min(r.max, Math.max(r.min, Math.round(size) + dir * r.step));
}

/**
 * The CSS `font-family` for the settings: the chosen family, then the generic `monospace`.
 * An unknown id, or "Custom…" with an empty name, uses the default family.
 */
export function fontStack(
  s: Pick<FontSettings, "fontFamily" | "fontFamilyCustom">,
): string {
  if (s.fontFamily === CUSTOM_FONT_ID) {
    const name = sanitizeCustomFamily(s.fontFamilyCustom);
    if (name) return `"${name}", monospace`;
  }
  const opt = fontOption(s.fontFamily) ??
    fontOption(DEFAULT_FONT_SETTINGS.fontFamily)!;
  return `${opt.css}, monospace`;
}

/** The xterm options the settings map to. */
export interface TerminalFontOptions {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: FontWeightSetting;
}

/** The xterm font options for the settings. */
export function terminalFontOptions(s: FontSettings): TerminalFontOptions {
  return {
    fontFamily: fontStack(s),
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    fontWeight: s.fontWeight,
  };
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

/** What detection needs from the environment (a stub in tests). */
export interface FontProbeEnv {
  /** `document.fonts.check`, when there is one. */
  check?: (font: string) => boolean;
  /** The rendered width of `text` in the CSS `font` shorthand (canvas `measureText`). */
  measure?: (font: string, text: string) => number;
}

const PROBE_TEXT = "mmmmmmmmmmlli0O@#WwQq{}";
const PROBE_PX = 48;
const BASES = ["monospace", "serif", "sans-serif"] as const;

/**
 * Whether `font.check` can be trusted: Chromium answers `true` for any family that needs no
 * loading, installed or not, so a made-up name reporting `true` means it cannot.
 */
function checkIsReliable(check: (font: string) => boolean): boolean {
  try {
    return !check(
      `12px "zz-no-such-font-${Math.random().toString(36).slice(2)}"`,
    );
  } catch {
    return false;
  }
}

/**
 * Whether one family token (`Menlo`, `"SF Mono"`, `ui-monospace`) resolves to a real face: its
 * width, with a generic fallback after it, differs from that generic alone for at least one of
 * monospace / serif / sans-serif (a monospace face can match the default monospace, never all
 * three).
 */
function probeMeasure(
  measure: (font: string, text: string) => number,
  token: string,
): boolean {
  for (const base of BASES) {
    const ref = measure(`${PROBE_PX}px ${base}`, PROBE_TEXT);
    const w = measure(`${PROBE_PX}px ${token}, ${base}`, PROBE_TEXT);
    if (Math.abs(w - ref) > 0.5) return true;
  }
  return false;
}

/** Whether one family token is installed, by `check` when reliable, else by measuring. */
export function isFamilyInstalled(env: FontProbeEnv, token: string): boolean {
  if (env.check && checkIsReliable(env.check)) {
    try {
      return env.check(`12px ${token}`);
    } catch { /* fall through to measuring */ }
  }
  return env.measure ? probeMeasure(env.measure, token) : false;
}

/**
 * Installed-ness of every curated family, keyed by id. Without any probe (no DOM) everything
 * reports `true`, so nothing is wrongly greyed out.
 */
export function detectInstalledFonts(
  env: FontProbeEnv,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of FONT_OPTIONS) {
    out[f.id] = !env.check && !env.measure
      ? true
      : f.probe.some((t) => isFamilyInstalled(env, t));
  }
  return out;
}

/** The browser's probe environment (`document.fonts.check` + a 2D canvas), or `{}` without a DOM. */
export function browserFontProbe(): FontProbeEnv {
  const doc = globalThis.document;
  if (!doc) return {};
  const env: FontProbeEnv = {};
  const fonts = doc.fonts;
  if (fonts && typeof fonts.check === "function") {
    env.check = (font) => fonts.check(font);
  }
  try {
    const ctx = doc.createElement("canvas").getContext("2d");
    if (ctx) {
      env.measure = (font, text) => {
        ctx.font = font;
        return ctx.measureText(text).width;
      };
    }
  } catch { /* no canvas */ }
  return env;
}

/** The picker order: installed families first (each group keeps the curated order). */
export function sortByInstalled(
  installed: Record<string, boolean>,
): FontOption[] {
  return [
    ...FONT_OPTIONS.filter((f) => installed[f.id] !== false),
    ...FONT_OPTIONS.filter((f) => installed[f.id] === false),
  ];
}
