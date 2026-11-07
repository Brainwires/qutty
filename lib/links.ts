/**
 * Clickable links in terminal output, the pure half: what counts as a link in a line of text
 * (URLs, then local paths with an optional `:line[:col]`), where a path points (against the
 * tile's directory and the home folder), and how the configured editor command becomes an argv.
 * lib/terminal-links.ts wires this to xterm.js; desktop/links.ts checks and opens what it finds.
 *
 * Detection rules:
 *
 * - **URLs**: `http://`, `https://`, `file://` and `mailto:` up to whitespace, quotes or `<>`.
 *   Trailing punctuation (`.,;:!?'"*`) is trimmed, and so is a closing bracket that has no
 *   opening one inside the link (`(see https://x.y/a)` → `https://x.y/a`; a Wikipedia
 *   `…/Foo_(bar)` keeps its own pair). An `http(s)` link needs a host, a `mailto:` an address.
 * - **Paths**: absolute (`/…`), home (`~/…`), explicitly relative (`./…`, `../…`) or a bare
 *   relative one that either has a `/` (`src/x.ts`) or a file extension with a letter in it
 *   (`main.rs`, not `1.2.3`). A path needs a letter somewhere, so `12:30`, `3/4` and `1.2.3` are
 *   never candidates. A path inside a URL is not one. Trailing dots are trimmed (end of a
 *   sentence). These are only candidates: a local path is linked when it exists.
 * - **Line and column** after a path: `file:42`, `file:42:7` (compilers, test runners, stack
 *   traces like `at fn (file:42:7)`), `file(42,7)` / `file(42)` (tsc, MSBuild), and Python's
 *   `File "path", line 42`.
 *
 * Client-safe and pure.
 *
 * @module
 */

import { join, normalize } from "@std/path/posix";

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

/** A URL found in a line: `[start, end)` are string offsets into it. */
export interface UrlMatch {
  kind: "url";
  start: number;
  end: number;
  /** The text as printed (trimmed), which is also what is opened. */
  text: string;
}

/** A path found in a line, with the line and column it names (if any). */
export interface PathMatch {
  kind: "path";
  start: number;
  end: number;
  /** The whole linked text, the `:line:col` suffix included. */
  text: string;
  /** The path as printed (`~/x`, `./src/a.ts`, `/etc/hosts`). */
  path: string;
  line?: number;
  col?: number;
}

export type LinkMatch = UrlMatch | PathMatch;

// deno-lint-ignore no-control-regex
const URL_RE = /\b(?:https?:\/\/|file:\/\/|mailto:)[^\s<>"'`\x00-\x1f\x7f]+/gi;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * `text` without trailing punctuation and without closing brackets that have no opening one in
 * it, repeatedly (`https://x.y/a).` → `https://x.y/a`).
 */
export function trimLinkEnd(text: string): string {
  let out = text;
  for (;;) {
    const last = out.at(-1);
    if (last === undefined) return out;
    const open = CLOSERS[last];
    if (TRAILING.has(last) || (open && count(out, last) > count(out, open))) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/** Whether `text` is a URL Qutty opens: http(s) with a host, file with a path, mailto with an address. */
export function isOpenableUrl(text: string): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  switch (url.protocol) {
    case "http:":
    case "https:":
      return url.hostname !== "";
    case "file:":
      return url.pathname.startsWith("/") && url.pathname.length > 1;
    case "mailto:":
      return /^[^@\s/]+@[^@\s/]+$/.test(decodeURIComponent(url.pathname));
    default:
      return false;
  }
}

/** The URLs in `line`, left to right. */
export function findUrls(line: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  for (const m of line.matchAll(URL_RE)) {
    const text = trimLinkEnd(m[0]);
    if (!isOpenableUrl(text)) continue;
    out.push({ kind: "url", start: m.index, end: m.index + text.length, text });
  }
  return out;
}

/** One path segment's characters (letters and digits of any script, `_ . @ + -`). */
const NAME = String.raw`[\p{L}\p{N}_.@+\-]`;
/**
 * A path candidate: a prefixed one (`/`, `~/`, `./`, `../`) or a bare one, then an optional
 * `:line[:col]` or `(line[,col])`. Not preceded by a name character or a slash, so a match never
 * starts in the middle of a word.
 */
const PATH_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@+\-~/])` +
    String
      .raw`((?:~|\.{1,2})?\/(?:${NAME}+(?:\/${NAME}+)*\/?)?|${NAME}+(?:\/${NAME}+)*\/?)` +
    String.raw`(?::(\d{1,7})(?::(\d{1,7}))?|\((\d{1,7})(?:,\s?(\d{1,7}))?\))?`,
  "gu",
);
/** Python's traceback form: `File "/x/y.py", line 42`. */
const PY_RE = /File "([^"\n]+)", line (\d{1,7})/g;

/** Whether a (trimmed) path-like token is worth checking. */
function isPathCandidate(path: string): boolean {
  if (!/\p{L}/u.test(path)) return false;
  if (/^(?:~|\.{1,2})?\//.test(path)) {
    // A prefix alone (`/`, `~/`, `./`) or a run of slashes is not a path to open.
    return /[^/.~]/.test(path) && !path.startsWith("//");
  }
  if (path.includes("/")) return !path.startsWith("-");
  // A bare name: only with an extension that has a letter (`main.rs`, `README.md`).
  return /^[^.].*\.[\p{L}\p{N}]*\p{L}[\p{L}\p{N}]*$/u.test(path);
}

/** Trailing dots off a path (end of a sentence), except a path that is all dots (`..`). */
function trimPathEnd(path: string): string {
  if (/(?:^|\/)\.{1,2}$/.test(path)) return path;
  return path.replace(/\.+$/, "");
}

function overlaps(
  a: { start: number; end: number },
  list: readonly { start: number; end: number }[],
): boolean {
  return list.some((b) => a.start < b.end && b.start < a.end);
}

/** The path candidates in `line` outside the given ranges (the URLs), left to right. */
export function findPaths(
  line: string,
  skip: readonly { start: number; end: number }[] = [],
): PathMatch[] {
  const out: PathMatch[] = [];
  for (const m of line.matchAll(PY_RE)) {
    const start = m.index + 'File "'.length;
    const hit: PathMatch = {
      kind: "path",
      start,
      end: start + m[1].length,
      text: m[1],
      path: m[1],
      line: Number(m[2]),
    };
    if (!overlaps(hit, skip)) out.push(hit);
  }
  const taken = [...skip, ...out];
  for (const m of line.matchAll(PATH_RE)) {
    const raw = m[1];
    const hasSuffix = m[2] !== undefined || m[4] !== undefined;
    // With a suffix the path ends where the suffix starts; without one, trim sentence dots.
    const path = hasSuffix ? raw : trimPathEnd(raw);
    if (!isPathCandidate(path)) continue;
    const lineNo = m[2] ?? m[4];
    const colNo = m[3] ?? m[5];
    const text = hasSuffix ? m[0] : path;
    const hit: PathMatch = {
      kind: "path",
      start: m.index,
      end: m.index + text.length,
      text,
      path,
      ...(lineNo !== undefined ? { line: Number(lineNo) } : {}),
      ...(colNo !== undefined ? { col: Number(colNo) } : {}),
    };
    if (!overlaps(hit, taken)) out.push(hit);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Every link candidate in `line`: the URLs, then the paths outside them. */
export function findLinks(line: string): LinkMatch[] {
  const urls = findUrls(line);
  return [...urls, ...findPaths(line, urls)].sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * The absolute path `path` names, from `cwd` (the tile's directory) and `home`: `~` and `~/…`
 * from home, absolute as is, relative from `cwd`. Normalized (`..`, `.`, repeated and trailing
 * slashes). `undefined` when it cannot be known: `~user/…`, a relative path without a `cwd`, a
 * NUL or a newline.
 */
export function resolvePath(
  path: string,
  cwd: string | undefined,
  home: string | undefined,
): string | undefined {
  if (path === "" || /[\0\n\r]/.test(path)) return undefined;
  let abs: string;
  if (path === "~" || path.startsWith("~/")) {
    if (!home?.startsWith("/")) return undefined;
    abs = join(home, path.slice(1));
  } else if (path.startsWith("~")) {
    return undefined;
  } else if (path.startsWith("/")) {
    abs = path;
  } else {
    if (!cwd?.startsWith("/")) return undefined;
    abs = join(cwd, path);
  }
  const out = normalize(abs);
  return out.length > 1 ? out.replace(/\/+$/, "") : out;
}

/** A `file://` URL's local path (`file:///Users/x/a%20b` → `/Users/x/a b`), or `undefined`. */
export function fileUrlPath(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "file:") return undefined;
    const p = decodeURIComponent(u.pathname);
    return p.startsWith("/") && !p.includes("\0") ? p : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------------------------

/** What a resolved local path is (desktop/links.ts `resolve`). */
export interface LinkTarget {
  /** The absolute, normalized path. */
  path: string;
  kind: "file" | "dir";
}

/** What `linkOpen` does: a URL in the browser, a file in its default app, a path in the file manager. */
export type LinkOpenRequest =
  | { kind: "url"; url: string }
  | { kind: "open"; path: string }
  | { kind: "reveal"; path: string };

/** `linkEdit`: run an editor command template on a file. */
export interface LinkEditRequest {
  /** The template (`code -g {file}:{line}:{col}`). */
  command: string;
  /** An absolute path. */
  file: string;
  line?: number;
  col?: number;
}

/** An editor Settings offers when its command is installed. */
export interface EditorPreset {
  id: string;
  label: string;
  /** The command looked up on `PATH` to tell whether it is installed. */
  program: string;
  template: string;
}

export const EDITOR_PRESETS: readonly EditorPreset[] = [
  {
    id: "code",
    label: "VS Code",
    program: "code",
    template: "code -g {file}:{line}:{col}",
  },
  {
    id: "cursor",
    label: "Cursor",
    program: "cursor",
    template: "cursor -g {file}:{line}:{col}",
  },
  {
    id: "zed",
    label: "Zed",
    program: "zed",
    template: "zed {file}:{line}:{col}",
  },
  {
    id: "subl",
    label: "Sublime Text",
    program: "subl",
    template: "subl {file}:{line}:{col}",
  },
  {
    id: "idea",
    label: "IntelliJ IDEA",
    program: "idea",
    template: "idea --line {line} --column {col} {file}",
  },
  {
    // Xcode's command-line opener (macOS; last, so "auto" prefers a code editor).
    id: "xed",
    label: "Xcode",
    program: "xed",
    template: "xed --line {line} {file}",
  },
];

export function editorPreset(id: string): EditorPreset | undefined {
  return EDITOR_PRESETS.find((p) => p.id === id);
}

/** Longest editor command template accepted. */
export const MAX_EDITOR_COMMAND = 300;

/**
 * Split a command template into words: whitespace separates, `"…"` and `'…'` group (no escapes,
 * no expansion of any kind). `undefined` for an unbalanced quote or an empty template.
 */
export function splitCommand(template: string): string[] | undefined {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (quote) return undefined;
  if (inWord) words.push(cur);
  return words.length > 0 ? words : undefined;
}

/**
 * The argv an editor command template runs for a file: `{file}`, `{line}` and `{col}` are
 * replaced inside words, never re-split, so a path with spaces, quotes or `;` stays one argument
 * and nothing reaches a shell. Without a line, `:{line}` / `:{col}` / `,{col}` disappear and a
 * bare `{line}` / `{col}` becomes `1`; a template without `{file}` gets the file as its last
 * argument. `undefined` when the template is unusable (empty, unbalanced quotes, a placeholder in
 * the program word, too long) or the file is not an absolute path (so it can never look like an
 * option).
 */
export function editorArgv(
  template: string,
  target: { file: string; line?: number; col?: number },
): string[] | undefined {
  if (template.length > MAX_EDITOR_COMMAND || /[\0\n\r]/.test(template)) {
    return undefined;
  }
  const { file } = target;
  if (!file.startsWith("/") || /[\0\n\r]/.test(file)) return undefined;
  const words = splitCommand(template.trim());
  if (!words || words[0] === "" || /[{}]/.test(words[0])) return undefined;
  const line = validNumber(target.line);
  const col = line === undefined ? undefined : validNumber(target.col);
  const fill = (word: string) => {
    let w = word;
    if (line === undefined) w = w.replaceAll(":{line}", "");
    if (col === undefined) {
      w = w.replaceAll(":{col}", "").replaceAll(",{col}", "");
    }
    // One pass, so a `{line}` inside the file name is left alone.
    return w.replace(
      /\{(file|line|col)\}/g,
      (_, key: string) =>
        key === "file" ? file : String((key === "line" ? line : col) ?? 1),
    );
  };
  const argv = [words[0], ...words.slice(1).map(fill)];
  if (!words.slice(1).some((w) => w.includes("{file}"))) argv.push(file);
  return argv;
}

function validNumber(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n > 0 && n < 1e8
    ? n
    : undefined;
}

/**
 * The argv of "$EDITOR in a new tile": `/bin/sh` with a fixed script that runs `$VISUAL` /
 * `$EDITOR` (asked of the login shell when the app's own environment has neither, as a
 * Finder-started app's does not), else `vi`, with `+line` and the file as its own arguments.
 * The file is never part of the script.
 */
export function editorTileArgs(file: string, line?: number): string[] {
  const script = [
    'ed="${VISUAL:-$EDITOR}"',
    'if [ -z "$ed" ]; then ed=$("${SHELL:-/bin/sh}" -l -i -c ' +
    "'printenv VISUAL || printenv EDITOR' 2>/dev/null </dev/null | tail -n 1); fi",
    // Unquoted on purpose: `EDITOR="code -w"` is a command with an argument.
    'exec ${ed:-vi} "$@"',
  ].join("\n");
  const n = validNumber(line);
  return ["-c", script, "qutty-edit", ...(n ? [`+${n}`] : []), file];
}

// ---------------------------------------------------------------------------------------------
// Settings → Links
// ---------------------------------------------------------------------------------------------

/** Settings → Links, persisted with the workspace settings (lib/workspace/store.ts). */
export interface LinkSettings {
  /**
   * What opens a file printed with a line (`src/x.ts:42`): `auto` (the first installed editor
   * preset, else the file's default app), `default` (the default app, line ignored), `tile`
   * (`$EDITOR` in a new tile), `custom` (`command`), or an {@linkcode EDITOR_PRESETS} id.
   */
  editor: string;
  /** The custom command template (`custom`). */
  command: string;
}

export const DEFAULT_LINKS: LinkSettings = { editor: "auto", command: "" };

const EDITOR_CHOICES = new Set(["auto", "default", "tile", "custom"]);

/** `raw` (from storage or a patch) onto `base`, each field checked. */
export function sanitizeLinks(
  raw: unknown,
  base: LinkSettings = DEFAULT_LINKS,
): LinkSettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof LinkSettings, unknown>>;
  if (
    typeof r.editor === "string" &&
    (EDITOR_CHOICES.has(r.editor) || editorPreset(r.editor))
  ) out.editor = r.editor;
  if (typeof r.command === "string") {
    out.command = r.command.replace(/[\0\r\n]/g, "").slice(
      0,
      MAX_EDITOR_COMMAND,
    );
  }
  return out;
}

/** How a file with a line opens, given the settings and the installed editor presets. */
export type EditorChoice =
  | { kind: "command"; command: string }
  | { kind: "tile" }
  | { kind: "default" };

export function editorChoice(
  settings: LinkSettings,
  installed: readonly string[],
): EditorChoice {
  switch (settings.editor) {
    case "default":
      return { kind: "default" };
    case "tile":
      return { kind: "tile" };
    case "custom":
      return settings.command.trim()
        ? { kind: "command", command: settings.command.trim() }
        : { kind: "default" };
    case "auto": {
      const first = EDITOR_PRESETS.find((p) => installed.includes(p.id));
      return first
        ? { kind: "command", command: first.template }
        : { kind: "default" };
    }
    default: {
      const preset = editorPreset(settings.editor);
      return preset
        ? { kind: "command", command: preset.template }
        : { kind: "default" };
    }
  }
}
