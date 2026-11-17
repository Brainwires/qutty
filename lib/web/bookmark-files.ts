/**
 * Bookmark files: the Netscape bookmarks HTML that Chrome, Safari, Firefox and Edge all import
 * and export, and Chrome's own `Bookmarks` JSON. Parsing gives {@linkcode ImportedItem}s, which
 * lib/web/bookmarks.ts `mergeImported` adds in an "Imported" folder; exporting writes the whole
 * tree, the bar as the toolbar folder (`PERSONAL_TOOLBAR_FOLDER`).
 *
 * The parser is a small tag scanner, not a DOM: the format is a flat run of `<DT><H3>` (a folder,
 * whose entries follow in the next `<DL>`), `<DT><A HREF>` (a bookmark) and `</DL>` (the folder
 * ends), and browsers write it loosely (no closing `</DT>`, stray `<p>`). Entities are decoded,
 * non-http(s) links (`place:`, `javascript:`, `file:`) are dropped, and the counts are capped.
 *
 * Pure and client-safe.
 *
 * @module
 */

import {
  BAR_ID,
  type BookmarkNode,
  type Bookmarks,
  bookmarkUrl,
  childrenOf,
  type ImportedItem,
  MAX_DEPTH,
  MAX_NODES,
  OTHER_ID,
} from "./bookmarks.ts";

/** The biggest file read (characters). */
const MAX_FILE = 20 * 1024 * 1024;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** `text` with its HTML entities decoded. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, name) => {
    const n = String(name);
    if (n[0] === "#") {
      const code = n[1] === "x" || n[1] === "X"
        ? parseInt(n.slice(2), 16)
        : parseInt(n.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : all;
    }
    return NAMED[n.toLowerCase()] ?? all;
  });
}

/** `text` escaped for HTML text and double-quoted attributes. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(
    />/g,
    "&gt;",
  ).replace(/"/g, "&quot;");
}

/** The attributes of a tag's inside (`HREF="…" ADD_DATE="…"`), names lower-cased. */
function attributes(inside: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const m of inside.matchAll(re)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** An `ADD_DATE` (seconds since the epoch) in ms, when it is one. */
function addDate(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 && n < 1e11
    ? Math.floor(n * 1000)
    : undefined;
}

/** Text between tags: tags removed, entities decoded, white space folded. */
function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ")
    .trim();
}

type Folder = { title: string; children: ImportedItem[]; addedAt?: number };

/**
 * The entries of a Netscape bookmarks file, as folders and bookmarks. The file's own top level
 * (what follows its `<H1>`) is the list returned.
 */
export function parseNetscapeBookmarks(html: string): ImportedItem[] {
  const src = html.slice(0, MAX_FILE);
  const top: ImportedItem[] = [];
  const stack: ImportedItem[][] = [];
  let into = top;
  /** A folder heading seen whose `<DL>` has not opened yet. */
  let pending: Folder | null = null;
  let count = 0;
  const re = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null && count < MAX_NODES) {
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "dl") {
      // A list opens inside the folder whose heading came just before it (the file's outer list
      // and a list with no heading stay where they are) and closes back to where it opened.
      if (closing) {
        into = stack.pop() ?? top;
      } else {
        stack.push(into);
        if (pending) into = pending.children;
      }
      pending = null;
      continue;
    }
    if (closing) continue;
    const end = src.indexOf(`</${m[2]}`, re.lastIndex);
    const endAt = end < 0 ? src.length : end;
    const inner = src.slice(re.lastIndex, endAt);
    re.lastIndex = end < 0 ? src.length : end;
    const attrs = attributes(m[3]);
    const addedAt = addDate(attrs.add_date);
    if (tag === "h3") {
      if (stack.length > MAX_DEPTH) {
        pending = null;
        continue;
      }
      const folder: Folder = {
        title: textOf(inner),
        children: [],
        ...(addedAt ? { addedAt } : {}),
      };
      into.push(folder);
      pending = folder;
      count++;
    } else {
      const url = bookmarkUrl(attrs.href ?? "");
      pending = null;
      if (!url) continue;
      into.push({
        title: textOf(inner),
        url,
        ...(addedAt ? { addedAt } : {}),
      });
      count++;
    }
  }
  return top;
}

/** A Netscape bookmarks file of the whole tree (`now`: the root folders' dates). */
export function exportNetscapeBookmarks(b: Bookmarks): string {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file.",
    "     It will be read and overwritten.",
    "     DO NOT EDIT! -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const date = (n: BookmarkNode) =>
    n.createdAt > 0 ? ` ADD_DATE="${Math.floor(n.createdAt / 1000)}"` : "";
  const walk = (parentId: string, indent: string) => {
    for (const n of childrenOf(b, parentId)) {
      if (n.kind === "folder") {
        lines.push(
          `${indent}<DT><H3${date(n)}>${escapeHtml(n.title)}</H3>`,
          `${indent}<DL><p>`,
        );
        walk(n.id, `${indent}    `);
        lines.push(`${indent}</DL><p>`);
      } else {
        lines.push(
          `${indent}<DT><A HREF="${escapeHtml(n.url ?? "")}"${date(n)}>${
            escapeHtml(n.title)
          }</A>`,
        );
      }
    }
  };
  for (const id of [BAR_ID, OTHER_ID]) {
    const root = b.nodes.find((n) => n.id === id);
    if (!root) continue;
    const toolbar = id === BAR_ID ? ' PERSONAL_TOOLBAR_FOLDER="true"' : "";
    lines.push(
      `    <DT><H3${date(root)}${toolbar}>${escapeHtml(root.title)}</H3>`,
      "    <DL><p>",
    );
    walk(id, "        ");
    lines.push("    </DL><p>");
  }
  lines.push("</DL><p>", "");
  return lines.join("\n");
}

/**
 * The entries of Chrome's `Bookmarks` file (JSON: `roots.bookmark_bar`, `roots.other`,
 * `roots.synced`, each a folder of `{type: "url" | "folder", name, url, children}`). Chrome's
 * `date_added` is µs since 1601. Malformed input gives `[]`.
 */
export function parseChromeBookmarks(json: string): ImportedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(json.slice(0, MAX_FILE));
  } catch {
    return [];
  }
  const roots = (data as { roots?: Record<string, unknown> } | null)?.roots;
  if (!roots || typeof roots !== "object") return [];
  let count = 0;
  const when = (raw: unknown): number | undefined => {
    const us = Number(raw);
    if (!Number.isFinite(us) || us <= 0) return undefined;
    const ms = Math.floor(us / 1000 - 11_644_473_600_000);
    return ms > 0 ? ms : undefined;
  };
  const item = (v: unknown, depth: number): ImportedItem | null => {
    if (!v || typeof v !== "object" || count >= MAX_NODES) return null;
    const r = v as Record<string, unknown>;
    const title = typeof r.name === "string" ? r.name : "";
    const addedAt = when(r.date_added);
    const at = addedAt ? { addedAt } : {};
    if (r.type === "url" && typeof r.url === "string") {
      const url = bookmarkUrl(r.url);
      if (!url) return null;
      count++;
      return { title, url, ...at };
    }
    if (r.type === "folder" && Array.isArray(r.children) && depth < MAX_DEPTH) {
      count++;
      const children = r.children.map((c) => item(c, depth + 1)).filter((
        c,
      ): c is ImportedItem => c !== null);
      return { title, children, ...at };
    }
    return null;
  };
  return ["bookmark_bar", "other", "synced"].map((k) => item(roots[k], 0))
    .filter((c): c is ImportedItem =>
      c !== null && (!("children" in c) || c.children.length > 0)
    );
}
