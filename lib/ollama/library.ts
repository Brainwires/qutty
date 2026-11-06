/**
 * The ollama.com model library, read from its public pages (it has no search API: `/api/tags` on
 * ollama.com lists only its cloud models). Two pages are used:
 *
 * - `https://ollama.com/search?q=<query>&o=newest` (also `c=tools` to keep tool-calling models):
 *   one `<li>` per model with its name (`href="/library/<name>"`), "Updated <date>",
 *   capability chips (`vision`, `tools`, `thinking`, `cloud`), the description, the download
 *   count (`title="20,887 downloads"`), the tag count and the size chips (`9b`);
 * - `https://ollama.com/library/<name>`: the same facts plus the Applications list
 *   (`ollama launch <harness> --model <name>`), which says which harnesses the model is meant
 *   for, and the variants table (`<name>:<tag>`, size, context, input).
 *
 * The parsing is careful rather than complete: anything it cannot read is left out, never
 * guessed. Pure and client-safe; desktop/ollama.ts fetches with curl in a hidden PTY (no `net`
 * permission) and caches by URL ({@linkcode LIBRARY_TTL_MS}).
 *
 * @module
 */

/** One model as the library lists it. */
export interface LibraryModel {
  /** `mimo-v2.6` (pull it as is, or `<name>:<tag>`). */
  name: string;
  description: string;
  /** Capability chips: `tools`, `vision`, `thinking`, `embedding`, … (`cloud` is separate). */
  capabilities: string[];
  /** A cloud model (runs on ollama.com, nothing big to pull). */
  cloud: boolean;
  /** Size chips: `9b`, `30b`. */
  sizes: string[];
  /** Downloads, when the page said. */
  downloads?: number;
  /** The tag count (`8 tags`). */
  tags?: number;
  /** "Updated" as the page wrote it (`November 3, 2026`). */
  updated?: string;
  /** {@linkcode updated} as epoch ms, when it parsed. */
  updatedAt?: number;
}

/** One tag of a model (`mimo-v2.6:9b`). */
export interface LibraryVariant {
  tag: string;
  /** `6.6GB - 8.7GB` */
  size: string;
  /** `256K` */
  context?: string;
  /** `Text, Image` */
  input?: string;
}

/** A model's own page. */
export interface LibraryModelPage {
  name: string;
  description: string;
  capabilities: string[];
  /** The `ollama launch` integrations listed under Applications, in page order. */
  applications: string[];
  variants: LibraryVariant[];
}

/** A library search as the page gets it (desktop/ollama.ts `library`). */
export interface LibraryResult {
  models: LibraryModel[];
  /** Epoch ms of the copy served (0: none). */
  fetchedAt: number;
  /** Why a fresh copy could not be fetched (the cached one, if any, is still served). */
  error?: string;
}

/** A model page as the page gets it (desktop/ollama.ts `libraryModel`). */
export interface LibraryPageResult {
  page?: LibraryModelPage;
  fetchedAt: number;
  error?: string;
}

/** The base of every library URL. */
const LIBRARY_ORIGIN = "https://ollama.com";

/** How long a fetched library page is reused (the library changes a few times a day). */
export const LIBRARY_TTL_MS = 3 * 60 * 60 * 1000;

/** How the search is ordered: most popular, or newest first. */
export type LibraryOrder = "popular" | "newest";

/** The search URL for a query (empty: the whole library). */
export function searchUrl(
  query: string,
  opts: { order?: LibraryOrder; toolsOnly?: boolean } = {},
): string {
  const p = new URLSearchParams();
  const q = query.trim().slice(0, 100);
  if (q) p.set("q", q);
  if (opts.toolsOnly) p.set("c", "tools");
  if (opts.order === "newest") p.set("o", "newest");
  const s = p.toString();
  return `${LIBRARY_ORIGIN}/search${s ? `?${s}` : ""}`;
}

/** A library name a page URL may be built from (`mimo-v2.6`, `library/x`, `user/model`). */
export function isLibraryName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 120 &&
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i.test(v) &&
    !v.includes("..");
}

/** A model page's URL. */
export function modelUrl(name: string): string {
  return `${LIBRARY_ORIGIN}/library/${name}`;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Text from HTML: tags dropped, entities decoded, whitespace collapsed. */
export function htmlText(html: string): string {
  return html.replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000
          ? String.fromCodePoint(n)
          : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, " ").trim();
}

/** The text of every `<span>` whose class contains `marker`, in order. */
function chips(html: string, marker: string): string[] {
  const out: string[] = [];
  const re = /<span\s+class="([^"]*)"[^>]*>([^<]{1,40})<\/span>/g;
  for (const m of html.matchAll(re)) {
    if (m[1].includes(marker)) out.push(htmlText(m[2]).toLowerCase());
  }
  return out;
}

/** `20,887` → 20887. */
function count(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** The search page's models, in page order (a malformed entry is skipped). */
export function parseSearch(html: string): LibraryModel[] {
  const out: LibraryModel[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/<li\b/).slice(1)) {
    const name = /<a\s+href="\/library\/([^"?#]+)"/.exec(block)?.[1];
    if (!name || !isLibraryName(name) || seen.has(name)) continue;
    seen.add(name);
    const caps = chips(block, "bg-indigo-50");
    const updated = /title="Updated ([^"]+)"/.exec(block)?.[1];
    const updatedAt = updated ? Date.parse(updated) : NaN;
    const description = /<p\s+class="[^"]*line-clamp[^"]*">([\s\S]*?)<\/p>/
      .exec(block)?.[1];
    const downloads = count(/title="([\d,]+) downloads"/.exec(block)?.[1]);
    const tags = count(/<span\s*>(\d+) tags?<\/span>/.exec(block)?.[1]);
    out.push({
      name,
      description: description ? htmlText(description) : "",
      capabilities: caps,
      cloud: chips(block, "bg-cyan-50").includes("cloud"),
      sizes: chips(block, "bg-[#ddf4ff]"),
      ...(downloads !== undefined ? { downloads } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(updated ? { updated } : {}),
      ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
    });
  }
  return out;
}

/** A model page: its Applications, variants, capabilities and summary. */
export function parseModelPage(name: string, html: string): LibraryModelPage {
  const applications: string[] = [];
  const launch = /value="ollama launch ([a-z0-9][a-z0-9-]*)(?: [^"]*)?"/g;
  for (const m of html.matchAll(launch)) {
    if (!applications.includes(m[1])) applications.push(m[1]);
  }
  const variants: LibraryVariant[] = [];
  const row =
    /<a\s+href="\/library\/([^"]+:[^"]+)"\s+class="sm:hidden[^"]*">[\s\S]*?<p\s+class="flex text-neutral-500">([\s\S]*?)<\/p>/g;
  for (const m of html.matchAll(row)) {
    const tag = m[1];
    if (!tag.startsWith(`${name}:`) || variants.some((v) => v.tag === tag)) {
      continue;
    }
    const parts = htmlText(m[2]).split(" · ");
    const context = parts.find((p) => / context window$/.test(p))
      ?.replace(/ context window$/, "");
    const input = parts.find((p) => /^(Text|Image|Audio|Video)\b/.test(p));
    variants.push({
      tag,
      size: parts[0] ?? "",
      ...(context ? { context } : {}),
      ...(input ? { input } : {}),
    });
  }
  const summary = /<span id="summary-content">([\s\S]*?)<\/span>/.exec(html)
    ?.[1];
  return {
    name,
    description: summary ? htmlText(summary) : "",
    capabilities: [...new Set(chips(html, "bg-indigo-50"))],
    applications,
    variants,
  };
}

/** How many listed models changed since `since` (epoch ms; nothing before a first look). */
export function newSince(
  models: readonly LibraryModel[],
  since: number | null,
): LibraryModel[] {
  if (since === null) return [];
  return models.filter((m) => m.updatedAt !== undefined && m.updatedAt > since);
}
