/**
 * A look folder's files made into a {@linkcode Look}: `look.json` checked, each picture checked
 * (its name one a look may have, its bytes the format its extension says, within the size limits)
 * and turned into a `data:` URL, and `look.css` sanitized. desktop/companion-looks.ts reads the
 * folder (the folder's own files only: no sub-folders, no links) and hands the bytes here; the
 * demo builds its looks the same way.
 *
 * Pure and client-safe.
 *
 * @module
 */

import {
  isLookImageName,
  type Look,
  LOOK_IMAGE_TYPES,
  LOOK_LIMITS,
  type LookManifest,
  parseLookManifest,
  sanitizeLookCss,
} from "./looks.ts";

const decoder = new TextDecoder("utf-8", { fatal: false });

/** `bytes` in base64 (`btoa` over chunks: no dependency, the page and Deno both have it). */
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** A file in a look folder that may be read: `look.json`, `look.css`, or a picture's name. */
export function isLookFileName(name: string): boolean {
  if (name === "look.json" || name === "look.css") return true;
  const m = /^([a-z0-9-]+)\.([a-z]+)$/.exec(name);
  return m !== null && m[2] in LOOK_IMAGE_TYPES && isLookImageName(m[1]);
}

/** Whether `bytes` are what a file of extension `ext` must start with (SVG: text with `<svg`). */
function formatMatches(ext: string, bytes: Uint8Array): boolean {
  const at = (sig: number[], from = 0) =>
    sig.every((b, i) => bytes[from + i] === b);
  switch (ext) {
    case "png":
      return at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "gif":
      return at([0x47, 0x49, 0x46, 0x38]);
    case "webp":
      return at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8);
    case "svg": {
      const text = decoder.decode(bytes);
      return /<svg[\s>]/i.test(text) && !/<script/i.test(text);
    }
    default:
      return false;
  }
}

/** `look.json` parsed and checked. */
function readManifest(
  bytes: Uint8Array | undefined,
): { ok: true; manifest: LookManifest } | { ok: false; error: string } {
  if (!bytes) return { ok: false, error: "no look.json" };
  if (bytes.length > LOOK_LIMITS.manifestBytes) {
    return { ok: false, error: "look.json is too big" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return { ok: false, error: "look.json is not valid JSON" };
  }
  return parseLookManifest(raw);
}

/**
 * The look in `files` (file name to bytes; names {@linkcode isLookFileName} rejects are ignored),
 * or why it is not one. `only` limits the pictures read (the thumbnail: `["idle"]`).
 */
export function buildLook(
  files: ReadonlyMap<string, Uint8Array>,
  only?: readonly string[],
): { ok: true; look: Look } | { ok: false; error: string } {
  const parsed = readManifest(files.get("look.json"));
  if (!parsed.ok) return parsed;
  const { manifest } = parsed;
  const images: Record<string, string> = {};
  const byFile: Record<string, string> = {};
  let total = 0;
  let count = 0;
  for (const name of [...files.keys()].sort()) {
    if (!isLookFileName(name) || name.startsWith("look.")) continue;
    const dot = name.lastIndexOf(".");
    const stem = name.slice(0, dot);
    const ext = name.slice(dot + 1);
    if (only && !only.includes(stem)) continue;
    // Two files for one picture (idle.png and idle.svg): the first by name wins.
    if (images[stem]) continue;
    const bytes = files.get(name)!;
    if (bytes.length > LOOK_LIMITS.imageBytes) {
      return {
        ok: false,
        error: `${name} is bigger than ${LOOK_LIMITS.imageBytes / 1024} KB`,
      };
    }
    total += bytes.length;
    if (total > LOOK_LIMITS.totalBytes) {
      return {
        ok: false,
        error: `the pictures are bigger than ${
          LOOK_LIMITS.totalBytes / 1024 / 1024
        } MB together`,
      };
    }
    if (++count > LOOK_LIMITS.images) {
      return {
        ok: false,
        error: `more than ${LOOK_LIMITS.images} pictures`,
      };
    }
    if (!formatMatches(ext, bytes)) {
      return {
        ok: false,
        error: ext === "svg"
          ? `${name} is not an SVG picture (or has a script)`
          : `${name} is not a ${ext.toUpperCase()} picture`,
      };
    }
    const url = `data:${LOOK_IMAGE_TYPES[ext]};base64,${base64(bytes)}`;
    images[stem] = url;
    byFile[name] = url;
  }
  if (!images.idle) {
    return {
      ok: false,
      error: "no idle picture (idle.svg, idle.png, idle.webp or idle.gif)",
    };
  }
  let css = "";
  const cssBytes = files.get("look.css");
  if (cssBytes && !only) {
    if (cssBytes.length > LOOK_LIMITS.cssBytes) {
      return { ok: false, error: "look.css is too big" };
    }
    const scoped = sanitizeLookCss(
      decoder.decode(cssBytes),
      manifest.id,
      byFile,
    );
    if (!scoped.ok) return scoped;
    css = scoped.css;
  }
  return { ok: true, look: { ...manifest, images, css } };
}
