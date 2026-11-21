/**
 * Companion looks: what the companion looks like (Settings → Companion → Look). The built-in look,
 * Loopy, is the hand-drawn face (app/companion/companion-face.tsx). A user look is a folder of
 * pictures in the app-support folder's `companions/` (desktop/companion-looks.ts reads it):
 *
 * - `look.json`: `{ "id", "name", "author", "version", "description", "size"?: { "w", "h" } }`;
 * - one picture per mood, named by the mood (`idle.png`, `happy.svg`, `thinking.gif`, …), SVG,
 *   PNG, WebP or GIF. Only `idle` is required: a missing mood falls back to a related one, then to
 *   `idle` ({@linkcode LOOK_IMAGES}, {@linkcode fallbackChain});
 * - optional mouth frames `speak-0`, `speak-1`, … for talking ({@linkcode speakFrame});
 * - optional `look.css`, scoped to the look ({@linkcode sanitizeLookCss}).
 *
 * The page gets each picture as a `data:` URL, never a `file:` or network URL, and a look has no
 * script: the pictures are drawn by `<img>`, where an SVG runs none either. docs/companion-looks.md
 * is the procedure for users.
 *
 * Pure and client-safe.
 *
 * @module
 */

import type { FaceMood, FaceState } from "./face-machine.ts";
import { LEVEL_STEPS } from "./lip-sync.ts";

/** The built-in look's id (the hand-drawn face). No user look may take it. */
export const BUILTIN_LOOK_ID = "loopy";
/** The built-in look's name, as Settings lists it. */
export const BUILTIN_LOOK_NAME = "Loopy";

/** A look's id (and its folder's name): lower-case letters, digits and dashes. */
const LOOK_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Whether `id` can name a look. */
export function isLookId(id: unknown): id is string {
  return typeof id === "string" && LOOK_ID.test(id);
}

/** The picture formats a look may use, by file extension, with their media types. */
export const LOOK_IMAGE_TYPES: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** The limits on a look (desktop/companion-looks.ts enforces them while reading). */
export const LOOK_LIMITS = {
  /** The biggest picture, bytes. */
  imageBytes: 1024 * 1024,
  /** All of a look's pictures together, bytes. */
  totalBytes: 8 * 1024 * 1024,
  /** The most pictures a look may have. */
  images: 48,
  /** The biggest `look.json`, bytes. */
  manifestBytes: 16 * 1024,
  /** The biggest `look.css`, bytes. */
  cssBytes: 32 * 1024,
  /** The most looks listed. */
  looks: 64,
  /** The most mouth frames (`speak-0` … `speak-15`). */
  speakFrames: 16,
  /** The drawn size's range, CSS px (`size` in look.json). */
  minSize: 48,
  maxSize: 240,
} as const;

/** The default drawn size: Loopy's own box (app/companion/companion-face.tsx). */
export const LOOK_DEFAULT_SIZE = { w: 93, h: 111 } as const;

/** One picture a look may have: its name (the file's, without the extension), use and fallback. */
export interface LookImageSpec {
  readonly id: string;
  /** What it is for, in a few words (the template's README and docs/companion-looks.md). */
  readonly use: string;
  /** The picture used when this one is missing (`null`: none, for `idle`, which is required). */
  readonly fallback: string | null;
}

/**
 * Every picture a look may have, in the order the README lists them: the base pictures first
 * (idle, then the five a look most wants), then each mood, then the extras. Each falls back to
 * its `fallback`, and the chain always ends at `idle`.
 */
export const LOOK_IMAGES: readonly LookImageSpec[] = [
  {
    id: "idle",
    use: "Resting, nothing going on. Required: everything falls back to it.",
    fallback: null,
  },
  {
    id: "happy",
    use: "Glad: a job went well, something nice was said.",
    fallback: "idle",
  },
  { id: "sad", use: "Something failed, or bad news.", fallback: "idle" },
  {
    id: "surprised",
    use: "Caught off guard: something new needs a look.",
    fallback: "idle",
  },
  {
    id: "thinking",
    use: "Working on an answer (also the voice turn while it thinks).",
    fallback: "idle",
  },
  { id: "sleepy", use: "Drowsy: late at night.", fallback: "idle" },
  // The moods a message can carry (lib/companion/face-machine.ts MOODS).
  { id: "neutral", use: "A plain message.", fallback: "idle" },
  {
    id: "attention",
    use: "Pointing at a question that wants an answer.",
    fallback: "surprised",
  },
  { id: "success", use: "Done, and it worked.", fallback: "happy" },
  { id: "confused", use: "Puzzled.", fallback: "thinking" },
  { id: "mad", use: "Annoyed.", fallback: "sad" },
  { id: "excited", use: "Thrilled.", fallback: "happy" },
  { id: "love", use: "Fond: hearts.", fallback: "happy" },
  {
    id: "shocked",
    use: "Startled: something went badly wrong.",
    fallback: "surprised",
  },
  { id: "wow", use: "Amazed.", fallback: "surprised" },
  { id: "blush", use: "Flattered and a little shy.", fallback: "happy" },
  // Qutty's own states.
  {
    id: "hot",
    use: "The computer has been busy for a while.",
    fallback: "idle",
  },
  { id: "sleeping", use: "Asleep at night.", fallback: "sleepy" },
  {
    id: "blink",
    use: "Eyes shut for a blink (only used on the idle picture).",
    fallback: "idle",
  },
  // The voice turn.
  { id: "listening", use: "Listening to you speak.", fallback: "idle" },
  {
    id: "speaking",
    use: "Talking, when there are no speak-N mouth frames.",
    fallback: "idle",
  },
];

const SPEC = new Map(LOOK_IMAGES.map((s) => [s.id, s]));

/** Whether `name` is a picture a look may have: one of {@linkcode LOOK_IMAGES} or `speak-<n>`. */
export function isLookImageName(name: string): boolean {
  const m = /^speak-(\d{1,2})$/.exec(name);
  if (m) return Number(m[1]) < LOOK_LIMITS.speakFrames;
  return SPEC.has(name);
}

/** `name`, then each fallback in turn, ending at `idle` (`[]` for a name that is no picture). */
export function fallbackChain(name: string): string[] {
  const out: string[] = [];
  let at: string | null = SPEC.has(name) ? name : null;
  while (at !== null && !out.includes(at)) {
    out.push(at);
    at = SPEC.get(at)?.fallback ?? null;
  }
  return out;
}

/** What `look.json` says. */
export interface LookManifest {
  readonly id: string;
  readonly name: string;
  readonly author: string;
  readonly version: string;
  readonly description: string;
  /** The drawn size, CSS px (default {@linkcode LOOK_DEFAULT_SIZE}). */
  readonly size?: { readonly w: number; readonly h: number };
}

/** A look as the page draws it: its manifest, its pictures as `data:` URLs, its scoped CSS. */
export interface Look extends LookManifest {
  /** Picture name (`idle`, `speak-0`, …) to its `data:` URL. */
  readonly images: Readonly<Record<string, string>>;
  /** `look.css`, sanitized and scoped ({@linkcode sanitizeLookCss}); "" for none. */
  readonly css: string;
}

/** A look as Settings lists it: its manifest and the `idle` picture for the thumbnail. */
export interface LookSummary extends LookManifest {
  readonly thumbnail: string;
}

/** A folder in `companions/` that is not a usable look, and why. */
export interface LookProblem {
  readonly folder: string;
  readonly error: string;
}

/** What Settings shows: the looks folder, the usable looks and the folders that are not. */
export interface LookListing {
  /** The looks folder (absolute; "" where there is none, the demo). */
  readonly dir: string;
  readonly looks: readonly LookSummary[];
  readonly problems: readonly LookProblem[];
}

/** A short single-line string from `raw`, at most `max` characters, or `fallback`. */
function text(raw: unknown, max: number, fallback = ""): string {
  if (typeof raw !== "string") return fallback;
  // deno-lint-ignore no-control-regex
  const clean = raw.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return Array.from(clean).slice(0, max).join("").trim() || fallback;
}

/**
 * `look.json`'s contents checked: the manifest, or why it is not one. The id must be a look id
 * other than the built-in one; the name is required; the rest are optional and trimmed.
 */
export function parseLookManifest(
  raw: unknown,
): { ok: true; manifest: LookManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "look.json is not a JSON object" };
  }
  const r = raw as Record<string, unknown>;
  if (!isLookId(r.id)) {
    return {
      ok: false,
      error:
        'look.json\'s "id" must be lower-case letters, digits and dashes (like "my-look")',
    };
  }
  if (r.id === BUILTIN_LOOK_ID) {
    return {
      ok: false,
      error: `"${BUILTIN_LOOK_ID}" is the built-in look's id`,
    };
  }
  const name = text(r.name, 40);
  if (!name) return { ok: false, error: 'look.json needs a "name"' };
  let size: LookManifest["size"];
  if (r.size !== undefined) {
    const s = r.size as Record<string, unknown> | null;
    const ok = (n: unknown) =>
      typeof n === "number" && Number.isFinite(n) &&
      n >= LOOK_LIMITS.minSize && n <= LOOK_LIMITS.maxSize;
    if (!s || typeof s !== "object" || !ok(s.w) || !ok(s.h)) {
      return {
        ok: false,
        error:
          `look.json's "size" must be { "w", "h" }, each ${LOOK_LIMITS.minSize} to ${LOOK_LIMITS.maxSize}`,
      };
    }
    size = { w: Math.round(s.w as number), h: Math.round(s.h as number) };
  }
  return {
    ok: true,
    manifest: {
      id: r.id,
      name,
      author: text(r.author, 60),
      version: text(r.version, 20),
      description: text(r.description, 200),
      ...(size ? { size } : {}),
    },
  };
}

/** How many mouth frames `images` has: `speak-0`, `speak-1`, … up to the first one missing. */
export function speakFrameCount(
  images: Readonly<Record<string, string>>,
): number {
  let n = 0;
  while (n < LOOK_LIMITS.speakFrames && images[`speak-${n}`]) n++;
  return n;
}

/**
 * The mouth frame for lip-sync step `step` (0 closed … `LEVEL_STEPS` wide open, lib/companion/
 * lip-sync.ts) when a look has `frames` of them: the steps spread evenly over the frames, so
 * `speak-0` is closed and the last frame the widest.
 */
export function speakFrame(step: number, frames: number): number {
  if (frames <= 1) return 0;
  const s = Math.max(0, Math.min(LEVEL_STEPS, step));
  return Math.round((s * (frames - 1)) / LEVEL_STEPS);
}

/** What the companion is doing, as {@linkcode pickLookImage} reads it. */
export interface LookFaceInputs {
  readonly state: FaceState;
  /** The mood on screen (none: neutral). */
  readonly mood?: FaceMood;
  readonly voice?: "listening" | "thinking" | "speaking";
  /** The lip-sync step while speaking. */
  readonly level?: number;
  /** The hot face (only over the neutral mood, as the drawn face). */
  readonly hot?: boolean;
  /** Asleep at night (with the sleepy mood). */
  readonly asleep?: boolean;
}

/** The picture to draw: its name, its `data:` URL, and whether it bobs (talking without frames). */
export interface LookPick {
  readonly name: string;
  readonly src: string;
  readonly bob: boolean;
}

/** The first picture of `name`'s fallback chain that `images` has (`idle` at the end). */
function resolve(
  images: Readonly<Record<string, string>>,
  name: string,
): { name: string; src: string } {
  for (const n of fallbackChain(name)) {
    if (images[n]) return { name: n, src: images[n] };
  }
  return { name: "idle", src: images.idle ?? "" };
}

/**
 * The picture a look shows for what the companion is doing:
 *
 * - speaking: the mouth frame for the lip-sync step when the look has two or more `speak-N`;
 *   else `speaking`, else the mood's picture, bobbing;
 * - listening or thinking in a voice turn: `listening` / `thinking`, else the mood's picture;
 * - asleep: `sleeping`; hot: `hot`; a blink on the idle picture: `blink`;
 * - else the mood's picture. Each through its fallback chain, ending at `idle`.
 */
export function pickLookImage(
  images: Readonly<Record<string, string>>,
  inputs: LookFaceInputs,
): LookPick {
  const mood = inputs.mood ?? "neutral";
  let name: string = mood;
  if (inputs.hot && mood === "neutral") name = "hot";
  if (inputs.asleep && mood === "sleepy") name = "sleeping";
  const base = resolve(images, name);
  if (inputs.voice === "speaking") {
    const frames = speakFrameCount(images);
    if (frames >= 2) {
      const n = `speak-${speakFrame(inputs.level ?? 0, frames)}`;
      return { name: n, src: images[n], bob: false };
    }
    if (images.speaking) {
      return { name: "speaking", src: images.speaking, bob: true };
    }
    return { ...base, bob: true };
  }
  if (inputs.voice === "listening" || inputs.voice === "thinking") {
    if (images[inputs.voice]) {
      return { name: inputs.voice, src: images[inputs.voice], bob: false };
    }
    return { ...base, bob: false };
  }
  if (inputs.state === "blink" && base.name === "idle" && images.blink) {
    return { name: "blink", src: images.blink, bob: false };
  }
  return { ...base, bob: false };
}

// ---------------------------------------------------------------------------------------------
// look.css
// ---------------------------------------------------------------------------------------------

/** The scope selector of look `id`'s CSS (on the companion overlay while the look is on). */
function lookScope(id: string): string {
  return `[data-look="${id}"]`;
}

/**
 * `look.css` made safe and scoped: comments dropped; `@import`, `@charset` and `@namespace`
 * removed; a `url()` kept only when it names one of the look's own pictures (by its file name,
 * relative: `url(idle.png)`), which becomes that picture's `data:` URL, and any other `url()`
 * (absolute, `file:`, `http:`, a path up, `data:`) replaced by `none`; legacy script hooks
 * (`expression(`, `behavior:`, `-moz-binding`, `javascript:`) refused. The rest is wrapped in the
 * look's scope with CSS nesting, so its rules match only inside the companion while the look is
 * on; braces must balance, so no rule can step out of the scope, and `\` escapes are allowed only
 * inside strings, so none can spell a `url(` or an `@import` past these checks.
 *
 * @param css The file's text.
 * @param id The look's id.
 * @param files The look's pictures by file name (`idle.png`) to their `data:` URLs.
 * @returns The scoped CSS ("" for an empty file) and what was changed, or why it was refused.
 */
export function sanitizeLookCss(
  css: string,
  id: string,
  files: Readonly<Record<string, string>> = {},
): { ok: true; css: string; notes: string[] } | { ok: false; error: string } {
  if (css.length > LOOK_LIMITS.cssBytes) {
    return { ok: false, error: "look.css is too big" };
  }
  const notes: string[] = [];
  let s = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
  if (/[<>]\s*\/?\s*style/i.test(s) || /<\/?script/i.test(s)) {
    return { ok: false, error: "look.css may not contain HTML" };
  }
  if (/expression\s*\(|behavior\s*:|-moz-binding|javascript\s*:/i.test(s)) {
    return { ok: false, error: "look.css may not run script" };
  }
  s = s.replace(/@(?:import|charset|namespace)\b[^;{}]*;?/gi, () => {
    notes.push("an @import, @charset or @namespace was removed");
    return "";
  });
  s = s.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi,
    (_all, dq, sq, bare) => {
      const ref = String(dq ?? sq ?? bare ?? "").trim();
      const src = /^[a-z0-9-]+\.[a-z]+$/i.test(ref) ? files[ref] : undefined;
      if (src) return `url("${src}")`;
      notes.push(`url(${ref}) is not one of the look's pictures`);
      return "none";
    },
  );
  // Anything still able to fetch: a bare `url(` left unmatched, or `image-set("…")` strings.
  if (/url\s*\(/i.test(s.replace(/url\("data:[^"]*"\)/g, ""))) {
    return { ok: false, error: "look.css has a url() it cannot use" };
  }
  if (/image-set\s*\(\s*["']/i.test(s) || /\bsrc\s*\(/i.test(s)) {
    return {
      ok: false,
      error: "look.css has an image reference it cannot use",
    };
  }
  // Braces must balance outside strings, never closing more than they opened.
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      else if (c === "\n") {
        return { ok: false, error: "look.css has an unclosed string" };
      }
      continue;
    }
    // An escape outside a string could spell `url(` or `@import` past the checks above.
    if (c === "\\") {
      return {
        ok: false,
        error: "look.css may not use \\ escapes outside strings",
      };
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth < 0) {
      return { ok: false, error: "look.css has an extra }" };
    }
  }
  if (quote || depth !== 0) {
    return { ok: false, error: "look.css has an unclosed { or string" };
  }
  const body = s.trim();
  return {
    ok: true,
    css: body ? `${lookScope(id)} {\n${body}\n}\n` : "",
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------------------------

/** What the page asks of the looks folder (desktop/companion-looks.ts; the demo's in memory). */
export interface LooksBackend {
  /** The looks folder, its looks with their thumbnails, and the folders that are not looks. */
  list(): Promise<LookListing>;
  /** One look whole, or why it cannot be had. */
  get(id: string): Promise<{ look: Look } | { error: string }>;
  /** Copy the starter look into the looks folder and open it; its folder. */
  create(): Promise<{ path: string }>;
  /** Open the looks folder in the file manager. */
  openFolder(): Promise<void>;
}
