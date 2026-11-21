/**
 * Skins: what a skin package is and how one is checked. A colour theme (lib/workspace/themes.ts)
 * sets the chrome's colours; a skin changes its structure and look (fonts, bevels, title bars,
 * button shapes) with a stylesheet written against the documented parts (lib/skins/parts.ts,
 * docs/skins.md).
 *
 * A skin is a folder with a `skin.json` ({@linkcode SkinManifest}) and a `skin.css`. The page
 * sets `data-skin="<id>"` on the document element and the stylesheet is written under
 * `:root[data-skin="<id>"]`.
 *
 * Client-safe and pure. The desktop side (desktop/skins.ts) reads user skins with these
 * functions, and the page checks what it receives with them again: a skin's stylesheet is never
 * applied unless {@linkcode sanitizeSkinCss} passed it.
 *
 * @module
 */

import {
  CHROME_TOKENS,
  type ChromeToken,
  type ColorTheme,
  rgbTriplet,
  THEME_IDS,
  themeById,
  type ThemeId,
} from "../workspace/themes.ts";

/** The skin every install has: Qutty's own look, no stylesheet. */
export const DEFAULT_SKIN_ID = "qutty";

/** The most a `skin.json` may be (bytes). */
export const MAX_MANIFEST_BYTES = 32 * 1024;
/** The most a `skin.css` may be, before and after its assets are inlined (characters). */
export const MAX_CSS_SOURCE = 256 * 1024;
/** The most a stylesheet may be once its assets are inlined as `data:` URLs (characters). */
const MAX_CSS_INLINED = 4 * 1024 * 1024;
/** The most one asset (an image, a font) may be (bytes). */
export const MAX_ASSET_BYTES = 768 * 1024;
/** The most fonts a manifest may declare. */
const MAX_FONTS = 8;

/** Where a tile header's window buttons sit. */
export type FrameButtons = "left" | "right";
/** How a tile header's title is aligned. */
export type FrameTitle = "left" | "center" | "right";
/** A tile header's window buttons (Maximize is also Restore). */
export type FrameButton = "minimize" | "maximize" | "close";

export const FRAME_BUTTONS: readonly FrameButtons[] = ["left", "right"];
export const FRAME_TITLES: readonly FrameTitle[] = ["left", "center", "right"];
export const FRAME_BUTTON_IDS: readonly FrameButton[] = [
  "minimize",
  "maximize",
  "close",
];

/** A skin's defaults for the tile frames (each one optional). */
export interface SkinFrame {
  buttons?: FrameButtons;
  title?: FrameTitle;
  /** All three buttons, in the order they are drawn (left to right). */
  buttonOrder?: FrameButton[];
}

/** The colours a skin brings: a theme to pair with, or one with some tokens replaced. */
export interface SkinThemeSpec {
  /** The theme the tokens start from (and whose ANSI colours the terminal keeps). */
  base: ThemeId;
  /** Absent: the base theme's. */
  scheme?: "dark" | "light";
  /** Chrome tokens to replace. */
  tokens: Partial<Record<ChromeToken, string>>;
}

/** One `@font-face` a skin declares; its file is inlined as a `data:` URL. */
export interface SkinFont {
  family: string;
  /** A path inside the skin folder. */
  file: string;
  weight?: string;
  style?: "normal" | "italic";
}

/** A checked `skin.json`. */
export interface SkinManifest {
  id: string;
  name: string;
  author: string;
  version: string;
  description: string;
  theme?: SkinThemeSpec;
  terminal?: {
    /** Put ahead of the user's terminal font stack. */
    fontFamily?: string;
    /** xterm theme colours to replace. */
    theme?: Record<string, string>;
  };
  fonts?: SkinFont[];
  frame?: SkinFrame;
}

/** A skin ready to apply: its manifest and its sanitized stylesheet. */
export interface Skin {
  manifest: SkinManifest;
  /** Sanitized, assets inlined; "" for a skin with no stylesheet. */
  css: string;
  source: "builtin" | "user";
}

/** A skin folder that could not be used, and why. */
export interface SkinProblem {
  /** The folder's name (the id the skin would have had). */
  folder: string;
  error: string;
}

/** What the desktop side says about the user's skins folder. */
export interface SkinList {
  /** The folder ("" where there is none). */
  dir: string;
  /** The usable skins. */
  skins: SkinManifest[];
  problems: SkinProblem[];
}

/** A skin package to copy into the user's folder (Settings → "Start from Classic"). */
export interface SkinTemplateRequest {
  /** The id wanted for the copy (a number is added when it is taken). */
  id: string;
  name: string;
  /** The id the package has now (its `data-skin` selectors are pointed at the new one). */
  from: string;
  /** The text of its skin.json and skin.css. */
  manifest: string;
  css: string;
}

/** The user's skins folder as the page reaches it (desktop/skins.ts; lib/skins/demo.ts). */
export interface SkinsClient {
  /** The usable skins' manifests, and the folders that are not usable skins. */
  list(): Promise<SkinList>;
  /** One skin with its stylesheet (to be checked again with {@linkcode checkSkin}). */
  get(id: string): Promise<Skin>;
  /** Copy a skin package into the folder; resolves to the copy's id and folder. */
  template(request: SkinTemplateRequest): Promise<{ id: string; dir: string }>;
  /** Show the folder in the file manager. */
  openFolder(): Promise<void>;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({
  ok: false,
  error,
});

/** A skin id: lower-case letters, digits and dashes (it is a folder name and an attribute value). */
export function isSkinId(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
/** `rgb()` / `rgba()` of plain numbers. */
const RGBA = /^rgba?\(\s*[\d.]+\s*(,\s*[\d.]+\s*){2,3}\)$/;

function isColor(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 &&
    (HEX.test(v) || RGBA.test(v));
}

/** A relative path that stays inside the skin folder: plain segments, no `..`, no scheme. */
export function isSkinAssetPath(v: unknown): boolean {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) return false;
  if (!/^[A-Za-z0-9._\-\/ ]+$/.test(v)) return false;
  if (v.startsWith("/") || v.endsWith("/")) return false;
  return v.split("/").every((seg) =>
    seg !== "" && seg !== "." && seg !== ".." && !seg.startsWith(" ") &&
    !seg.endsWith(" ")
  );
}

/** The media type of an asset a skin may ship, by extension (`null`: not one). */
export function assetMediaType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "woff2":
      return "font/woff2";
    case "woff":
      return "font/woff";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    default:
      return null;
  }
}

/** The `data:` media types a skin stylesheet may embed. */
const DATA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-ttf",
  "application/x-font-opentype",
]);

function text(
  r: Record<string, unknown>,
  key: string,
  max: number,
  required: boolean,
): Result<string> {
  const v = r[key];
  if (v === undefined && !required) return { ok: true, value: "" };
  if (typeof v !== "string" || v.trim() === "" && required) {
    return fail(`"${key}" must be a ${required ? "non-empty " : ""}string`);
  }
  if (v.length > max) return fail(`"${key}" is longer than ${max} characters`);
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(v)) {
    return fail(`"${key}" must not contain control characters`);
  }
  return { ok: true, value: v.trim() };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkToken(token: ChromeToken, v: unknown): boolean {
  if (token === "--shadow-a") {
    const n = typeof v === "number" ? v : Number(v);
    return (typeof v === "number" || typeof v === "string") &&
      Number.isFinite(n) && n >= 0 && n <= 1;
  }
  if (token === "--accent-glow") return isColor(v);
  return typeof v === "string" && HEX.test(v);
}

function parseTheme(raw: unknown): Result<SkinThemeSpec> {
  if (typeof raw === "string") {
    if (!THEME_IDS.includes(raw as ThemeId)) {
      return fail(`"theme": there is no theme "${raw.slice(0, 40)}"`);
    }
    return { ok: true, value: { base: raw as ThemeId, tokens: {} } };
  }
  if (!isRecord(raw)) return fail(`"theme" must be a theme id or an object`);
  const base = raw.base === undefined ? "sea-glass" : raw.base;
  if (typeof base !== "string" || !THEME_IDS.includes(base as ThemeId)) {
    return fail(`"theme.base" must be one of ${THEME_IDS.join(", ")}`);
  }
  const out: SkinThemeSpec = { base: base as ThemeId, tokens: {} };
  if (raw.scheme !== undefined) {
    if (raw.scheme !== "dark" && raw.scheme !== "light") {
      return fail(`"theme.scheme" must be "dark" or "light"`);
    }
    out.scheme = raw.scheme;
  }
  if (raw.tokens !== undefined) {
    if (!isRecord(raw.tokens)) return fail(`"theme.tokens" must be an object`);
    for (const [k, v] of Object.entries(raw.tokens)) {
      if (!CHROME_TOKENS.includes(k as ChromeToken)) {
        return fail(`"theme.tokens": there is no token "${k.slice(0, 40)}"`);
      }
      const token = k as ChromeToken;
      if (!checkToken(token, v)) {
        return fail(
          token === "--shadow-a"
            ? `"theme.tokens.--shadow-a" must be a number from 0 to 1`
            : `"theme.tokens.${token}" must be a colour like #c0c0c0`,
        );
      }
      out.tokens[token] = String(v);
    }
  }
  return { ok: true, value: out };
}

/** The xterm theme colours a skin may replace. */
const TERMINAL_KEYS: readonly string[] = Object.keys(
  themeById("sea-glass").terminal,
);

/** A CSS font family list: names, quotes, commas (nothing that could end the declaration). */
function isFontFamilyList(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 &&
    /^[A-Za-z0-9 ,'"_\-.]+$/.test(v);
}

function parseTerminal(raw: unknown): Result<SkinManifest["terminal"]> {
  if (!isRecord(raw)) return fail(`"terminal" must be an object`);
  const out: NonNullable<SkinManifest["terminal"]> = {};
  if (raw.fontFamily !== undefined) {
    if (!isFontFamilyList(raw.fontFamily)) {
      return fail(`"terminal.fontFamily" must be a list of font names`);
    }
    out.fontFamily = raw.fontFamily.trim();
  }
  if (raw.theme !== undefined) {
    if (!isRecord(raw.theme)) return fail(`"terminal.theme" must be an object`);
    out.theme = {};
    for (const [k, v] of Object.entries(raw.theme)) {
      if (!TERMINAL_KEYS.includes(k)) {
        return fail(`"terminal.theme": there is no colour "${k.slice(0, 40)}"`);
      }
      if (!isColor(v)) {
        return fail(`"terminal.theme.${k}" must be a colour like #c0c0c0`);
      }
      out.theme[k] = v;
    }
  }
  return { ok: true, value: out };
}

function parseFonts(raw: unknown): Result<SkinFont[]> {
  if (!Array.isArray(raw)) return fail(`"fonts" must be a list`);
  if (raw.length > MAX_FONTS) {
    return fail(`"fonts" has more than ${MAX_FONTS} entries`);
  }
  const out: SkinFont[] = [];
  for (const [i, f] of raw.entries()) {
    if (!isRecord(f)) return fail(`"fonts[${i}]" must be an object`);
    if (
      typeof f.family !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9 _\-]{0,59}$/.test(f.family)
    ) {
      return fail(`"fonts[${i}].family" must be a plain font name`);
    }
    if (typeof f.file !== "string" || !isSkinAssetPath(f.file)) {
      return fail(`"fonts[${i}].file" must be a path inside the skin folder`);
    }
    if (!assetMediaType(f.file)?.startsWith("font/")) {
      return fail(`"fonts[${i}].file" must be a woff2, woff, ttf or otf file`);
    }
    const font: SkinFont = { family: f.family, file: f.file };
    if (f.weight !== undefined) {
      const w = String(f.weight);
      if (!/^(normal|bold|[1-9]00)$/.test(w)) {
        return fail(`"fonts[${i}].weight" must be normal, bold or 100 to 900`);
      }
      font.weight = w;
    }
    if (f.style !== undefined) {
      if (f.style !== "normal" && f.style !== "italic") {
        return fail(`"fonts[${i}].style" must be normal or italic`);
      }
      font.style = f.style;
    }
    out.push(font);
  }
  return { ok: true, value: out };
}

function parseFrame(raw: unknown): Result<SkinFrame> {
  if (!isRecord(raw)) return fail(`"frame" must be an object`);
  const out: SkinFrame = {};
  if (raw.buttons !== undefined) {
    if (!FRAME_BUTTONS.includes(raw.buttons as FrameButtons)) {
      return fail(`"frame.buttons" must be "left" or "right"`);
    }
    out.buttons = raw.buttons as FrameButtons;
  }
  if (raw.title !== undefined) {
    if (!FRAME_TITLES.includes(raw.title as FrameTitle)) {
      return fail(`"frame.title" must be "left", "center" or "right"`);
    }
    out.title = raw.title as FrameTitle;
  }
  if (raw.buttonOrder !== undefined) {
    const order = raw.buttonOrder;
    if (
      !Array.isArray(order) || order.length !== FRAME_BUTTON_IDS.length ||
      !FRAME_BUTTON_IDS.every((b) => order.includes(b))
    ) {
      return fail(
        `"frame.buttonOrder" must list minimize, maximize and close once each`,
      );
    }
    out.buttonOrder = [...order] as FrameButton[];
  }
  return { ok: true, value: out };
}

/**
 * Check a parsed `skin.json`. `folder`, when given, is the skin's folder name, which the id must
 * equal (so two folders can never claim one id).
 */
export function validateManifest(
  raw: unknown,
  folder?: string,
): Result<SkinManifest> {
  if (!isRecord(raw)) return fail("skin.json must be an object");
  if (!isSkinId(raw.id)) {
    return fail(
      `"id" must be 1 to 40 lower-case letters, digits or dashes`,
    );
  }
  if (folder !== undefined && raw.id !== folder) {
    return fail(`"id" ("${raw.id}") must equal the folder's name`);
  }
  const name = text(raw, "name", 60, true);
  if (!name.ok) return name;
  const author = text(raw, "author", 80, false);
  if (!author.ok) return author;
  const version = text(raw, "version", 24, false);
  if (!version.ok) return version;
  const description = text(raw, "description", 300, false);
  if (!description.ok) return description;
  const out: SkinManifest = {
    id: raw.id,
    name: name.value,
    author: author.value,
    version: version.value,
    description: description.value,
  };
  if (raw.theme !== undefined) {
    const t = parseTheme(raw.theme);
    if (!t.ok) return t;
    out.theme = t.value;
  }
  if (raw.terminal !== undefined) {
    const t = parseTerminal(raw.terminal);
    if (!t.ok) return t;
    if (t.value) out.terminal = t.value;
  }
  if (raw.fonts !== undefined) {
    const f = parseFonts(raw.fonts);
    if (!f.ok) return f;
    out.fonts = f.value;
  }
  if (raw.frame !== undefined) {
    const f = parseFrame(raw.frame);
    if (!f.ok) return f;
    out.frame = f.value;
  }
  return { ok: true, value: out };
}

/** Parse and check the text of a `skin.json`. */
export function parseManifest(
  json: string,
  folder?: string,
): Result<SkinManifest> {
  if (json.length > MAX_MANIFEST_BYTES) {
    return fail(`skin.json is larger than ${MAX_MANIFEST_BYTES / 1024} KB`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail("skin.json is not valid JSON");
  }
  return validateManifest(raw, folder);
}

// ---------------------------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------------------------

/** The at-rules a skin may use. `@import` (and anything unknown) is refused. */
const AT_RULES = new Set([
  "media",
  "supports",
  "font-face",
  "keyframes",
  "-webkit-keyframes",
  "layer",
  "container",
  "property",
  "starting-style",
]);

/** Functions that take a URL as a bare string, or run code in old engines. */
const BANNED_FUNCTIONS = new Set([
  "image-set",
  "-webkit-image-set",
  "image",
  "src",
  "expression",
  "element",
  "-moz-element",
]);

/** Properties that load or run something in old engines. */
const BANNED_IDENTS = new Set(["behavior", "-moz-binding"]);

/**
 * Gives the `data:` URL of an asset in the skin folder (a relative path that passed
 * {@linkcode isSkinAssetPath}), or a string error.
 */
export type AssetResolver = (
  path: string,
) => { url: string } | { error: string };

/** The resolver of a stylesheet whose assets are already inlined: any relative path is refused. */
const NO_ASSETS: AssetResolver = (path) => ({
  error: `the asset "${path}" is not available`,
});

const isIdentChar = (c: string) =>
  /[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80;

/** Check a `data:` URL: a base64 or text payload of a media type a skin may embed. */
function checkDataUrl(url: string): string | null {
  const m = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9=._-]+)*),/i.exec(
    url,
  );
  if (!m) return "a data: URL must name its media type";
  if (!DATA_TYPES.has(m[1].toLowerCase())) {
    return `data: URLs of type ${m[1].toLowerCase()} are not allowed`;
  }
  // The payload cannot leave the quoted string it is written back into.
  if (/["\\\n\r\f]/.test(url)) {
    return "a data: URL must not contain quotes, backslashes or line breaks";
  }
  return null;
}

/**
 * Check a skin's stylesheet and inline its assets. A skin must not reach the network or run
 * anything, so the stylesheet is refused (not repaired) when it has:
 *
 * - `@import`, or any at-rule other than `@media`, `@supports`, `@font-face`, `@keyframes`,
 *   `@layer`, `@container`, `@property` and `@starting-style`;
 * - a `url()` that is not a relative path inside the skin folder, a `#fragment` or a `data:` URL
 *   of an image or font type (so no `http:`, `https:`, `//host`, `file:`, absolute path or `..`);
 * - `image-set()`, `image()`, `src()`, `element()`, `expression()`, `behavior`, `-moz-binding`;
 * - a backslash outside a quoted string, or one inside a `url()` (CSS escapes can spell `url` or
 *   `@import` in ways a reader would not see).
 *
 * Each relative `url()` is replaced by the `data:` URL `resolve` gives for it. Comments are
 * dropped. The result is what the page applies.
 */
export function sanitizeSkinCss(
  css: string,
  resolve: AssetResolver = NO_ASSETS,
): Result<string> {
  if (css.length > MAX_CSS_INLINED) return fail("skin.css is too large");
  if (css.includes("\0")) return fail("skin.css contains a NUL character");
  const out: string[] = [];
  let size = 0;
  const emit = (s: string) => {
    out.push(s);
    size += s.length;
  };
  const n = css.length;
  let i = 0;
  let line = 1;
  const at = (what: string) => fail(`skin.css line ${line}: ${what}`);

  /** Read a quoted string starting at `i` (its opening quote); returns its raw text with quotes. */
  const readString = (): string | null => {
    const quote = css[i];
    let j = i + 1;
    while (j < n) {
      const c = css[j];
      if (c === "\\") {
        if (css[j + 1] === "\n") line++;
        j += 2;
        continue;
      }
      if (c === "\n" || c === "\r" || c === "\f") return null;
      if (c === quote) {
        const s = css.slice(i, j + 1);
        i = j + 1;
        return s;
      }
      j++;
    }
    return null;
  };

  const skipSpace = () => {
    while (i < n && /\s/.test(css[i])) {
      if (css[i] === "\n") line++;
      i++;
    }
  };

  while (i < n) {
    const c = css[i];
    if (c === "\n") line++;
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) return at("a comment is not closed");
      for (let k = i; k < end; k++) if (css[k] === "\n") line++;
      i = end + 2;
      emit(" ");
      continue;
    }
    if (c === '"' || c === "'") {
      const s = readString();
      if (s === null) return at("a string is not closed");
      emit(s);
      continue;
    }
    if (c === "\\") {
      return at("a backslash escape outside a quoted string is not allowed");
    }
    if (c === "@") {
      let j = i + 1;
      while (j < n && isIdentChar(css[j])) j++;
      const name = css.slice(i + 1, j).toLowerCase();
      if (css[j] === "\\") {
        return at("a backslash escape outside a quoted string is not allowed");
      }
      if (!AT_RULES.has(name)) {
        return at(
          name === "import"
            ? "@import is not allowed (a skin is one stylesheet)"
            : `@${name || "…"} is not allowed`,
        );
      }
      emit(css.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentChar(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(css[j])) j++;
      const ident = css.slice(i, j);
      const lower = ident.toLowerCase();
      if (css[j] !== "(") {
        if (BANNED_IDENTS.has(lower)) return at(`${lower} is not allowed`);
        emit(ident);
        i = j;
        continue;
      }
      if (BANNED_FUNCTIONS.has(lower)) return at(`${lower}() is not allowed`);
      if (lower !== "url") {
        emit(ident);
        i = j;
        continue;
      }
      // url( … ): quoted or bare, no escapes.
      i = j + 1;
      skipSpace();
      let arg: string;
      if (css[i] === '"' || css[i] === "'") {
        const s = readString();
        if (s === null) return at("a url() is not closed");
        arg = s.slice(1, -1);
        skipSpace();
        if (css[i] !== ")") return at("a url() is not closed");
        i++;
      } else {
        const end = css.indexOf(")", i);
        if (end < 0) return at("a url() is not closed");
        arg = css.slice(i, end).trim();
        i = end + 1;
        if (/['(]/.test(arg)) return at("a url() is malformed");
      }
      if (arg.includes("\\")) return at("a url() must not contain a backslash");
      // It is written back inside double quotes.
      if (/[\n\r\f"]/.test(arg)) return at("a url() is malformed");
      if (/^#[A-Za-z0-9_-]+$/.test(arg)) {
        emit(`url("${arg}")`);
        continue;
      }
      if (/^data:/i.test(arg)) {
        const why = checkDataUrl(arg);
        if (why) return at(why);
        emit(`url("${arg}")`);
        continue;
      }
      if (!isSkinAssetPath(arg)) {
        return at(
          `url(${
            arg.slice(0, 60)
          }) is not allowed: only files inside the skin folder (a relative path, no "..")`,
        );
      }
      if (!assetMediaType(arg)) {
        return at(`url(${arg}): only image and font files can be used`);
      }
      const r = resolve(arg);
      if ("error" in r) return at(r.error);
      const why = checkDataUrl(r.url);
      if (why) return at(why);
      emit(`url("${r.url}")`);
      continue;
    }
    emit(c);
    i++;
    if (size > MAX_CSS_INLINED) return fail("skin.css is too large");
  }
  if (size > MAX_CSS_INLINED) return fail("skin.css is too large");
  return { ok: true, value: out.join("") };
}

/** The `@font-face` rules of a manifest's fonts (their files inlined), checked like the rest. */
function fontFaceCss(
  fonts: readonly SkinFont[],
  resolve: AssetResolver,
): Result<string> {
  const rules = fonts.map((f) =>
    `@font-face { font-family: "${f.family}"; src: url("${f.file}"); font-weight: ${
      f.weight ?? "normal"
    }; font-style: ${f.style ?? "normal"}; font-display: swap; }`
  );
  return sanitizeSkinCss(rules.join("\n"), resolve);
}

/**
 * Build a skin from its two files: the manifest checked, the stylesheet (after the manifest's
 * `@font-face` rules) sanitized with its assets inlined.
 */
export function buildSkin(
  files: { manifest: string; css: string },
  opts: {
    folder?: string;
    resolve?: AssetResolver;
    source: Skin["source"];
  },
): Result<Skin> {
  const m = parseManifest(files.manifest, opts.folder);
  if (!m.ok) return m;
  if (files.css.length > MAX_CSS_SOURCE) {
    return fail(`skin.css is larger than ${MAX_CSS_SOURCE / 1024} KB`);
  }
  const resolve = opts.resolve ?? NO_ASSETS;
  const faces = fontFaceCss(m.value.fonts ?? [], resolve);
  if (!faces.ok) return faces;
  const css = sanitizeSkinCss(files.css, resolve);
  if (!css.ok) return css;
  const all = faces.value ? `${faces.value}\n${css.value}` : css.value;
  if (all.length > MAX_CSS_INLINED) {
    return fail("the skin's assets are too large");
  }
  return {
    ok: true,
    value: { manifest: m.value, css: all, source: opts.source },
  };
}

/**
 * Check a skin that arrived over the bridge (or from the demo): the manifest again, and the
 * stylesheet again with no asset resolver, so only inlined `data:` URLs pass.
 */
export function checkSkin(raw: unknown): Result<Skin> {
  if (!isRecord(raw) || typeof raw.css !== "string") {
    return fail("not a skin");
  }
  const m = validateManifest(raw.manifest);
  if (!m.ok) return m;
  const css = sanitizeSkinCss(raw.css);
  if (!css.ok) return css;
  return {
    ok: true,
    value: { manifest: m.value, css: css.value, source: "user" },
  };
}

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

/** Whether a skin brings colours of its own (a theme, or terminal colours). */
export function skinHasColors(manifest: SkinManifest): boolean {
  return !!manifest.theme || !!manifest.terminal?.theme;
}

/**
 * The colour theme to show: the user's, or with `skinColors` the skin's (its base theme, or the
 * user's when it names none, under the skin's tokens and terminal colours).
 */
export function effectiveTheme(
  userTheme: ColorTheme,
  manifest: SkinManifest | null,
  skinColors: boolean,
): ColorTheme {
  if (!manifest || !skinColors || !skinHasColors(manifest)) return userTheme;
  const base = manifest.theme ? themeById(manifest.theme.base) : userTheme;
  return withSkinColors(base, manifest);
}

/** A terminal font stack with the skin's font (when it names one) ahead of it. */
export function withSkinFont(
  stack: string,
  skinFont: string | undefined,
): string {
  return skinFont ? `${skinFont}, ${stack}` : stack;
}

/** `theme` with a skin's tokens and terminal colours over it. */
function withSkinColors(
  theme: ColorTheme,
  manifest: SkinManifest,
): ColorTheme {
  const tokens = manifest.theme?.tokens ?? {};
  const chrome = { ...theme.chrome, ...tokens };
  const terminal = { ...theme.terminal };
  if (tokens["--tile"]) {
    terminal.background = chrome["--tile"];
    terminal.cursorAccent = chrome["--tile"];
  }
  if (tokens["--text"]) terminal.foreground = chrome["--text"];
  if (tokens["--accent"]) {
    const rgb = rgbTriplet(chrome["--accent"]);
    terminal.cursor = chrome["--accent"];
    terminal.selectionBackground = `rgba(${rgb}, 0.3)`;
    terminal.selectionInactiveBackground = `rgba(${rgb}, 0.16)`;
  }
  return {
    ...theme,
    scheme: manifest.theme?.scheme ?? theme.scheme,
    chrome,
    terminal: { ...terminal, ...(manifest.terminal?.theme ?? {}) },
  };
}
