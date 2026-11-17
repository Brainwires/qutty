/**
 * The pages web tiles visited (the History dialog, app/history-dialog.tsx) and what the address
 * field suggests as it is typed in: bookmarks first, then visited pages, best first.
 *
 * One list for the whole app (every web tile shares one storage partition, so one profile),
 * newest first, at most {@linkcode MAX_VISITS} pages, each once with its visit count. Stored on its
 * own localStorage key ({@linkcode VISITS_STORAGE_KEY}) and synced across windows
 * (lib/web/synced.ts).
 *
 * Pure and client-safe.
 *
 * @module
 */

import {
  type Bookmarks,
  bookmarkUrl,
  cleanTitle,
  searchBookmarks,
} from "./bookmarks.ts";

/** One visited page. */
export interface Visit {
  url: string;
  title: string;
  /** The last visit (ms since the epoch). */
  at: number;
  /** How many times it was visited. */
  count: number;
}

/** The visited pages, newest first. */
export interface Visits {
  readonly visits: readonly Visit[];
}

/** The localStorage key; bump the suffix when the shape changes incompatibly. */
export const VISITS_STORAGE_KEY = "qutty.history.v1";

/** The most pages kept (the oldest go first). */
export const MAX_VISITS = 1000;

/** No visits. */
export const NO_VISITS: Visits = { visits: [] };

/** A visit to `url` at `now` (moved to the front; its title kept unless a new one is given). */
export function recordVisit(
  h: Visits,
  page: { url: string; title?: string },
  now: number,
): Visits {
  const url = bookmarkUrl(page.url);
  if (!url) return h;
  const was = h.visits.find((v) => v.url === url);
  const title = page.title !== undefined ? cleanTitle(page.title) : "";
  const visit: Visit = {
    url,
    title: title || was?.title || "",
    at: now,
    count: (was?.count ?? 0) + 1,
  };
  const rest = h.visits.filter((v) => v !== was);
  return { visits: [visit, ...rest].slice(0, MAX_VISITS) };
}

/** The title of the page at `url` became `title` (no new visit). */
export function titleVisit(h: Visits, url: string, title: string): Visits {
  const href = bookmarkUrl(url);
  const clean = cleanTitle(title);
  const was = h.visits.find((v) => v.url === href);
  if (!was || !clean || was.title === clean) return h;
  return {
    visits: h.visits.map((v) => (v === was ? { ...v, title: clean } : v)),
  };
}

/** Forget the visits to `urls`. */
export function removeVisits(h: Visits, urls: readonly string[]): Visits {
  const gone = new Set(urls);
  const visits = h.visits.filter((v) => !gone.has(v.url));
  return visits.length === h.visits.length ? h : { visits };
}

/** The visits whose title or URL holds every word of `query` (all of them for none). */
export function searchVisits(h: Visits, query: string): Visit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...h.visits];
  return h.visits.filter((v) => {
    const hay = `${v.title} ${v.url}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** A stored or synced list, checked: http(s) URLs once each, short titles, newest first. */
export function sanitizeVisits(raw: unknown): Visits {
  const list = raw && typeof raw === "object" &&
      Array.isArray((raw as { visits?: unknown }).visits)
    ? (raw as { visits: unknown[] }).visits
    : [];
  const seen = new Set<string>();
  const visits: Visit[] = [];
  for (const v of list.slice(0, MAX_VISITS * 2)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const url = typeof r.url === "string" ? bookmarkUrl(r.url) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const at = typeof r.at === "number" && Number.isFinite(r.at) && r.at > 0
      ? Math.floor(r.at)
      : 0;
    const count = typeof r.count === "number" && Number.isFinite(r.count)
      ? Math.max(1, Math.min(1e6, Math.floor(r.count)))
      : 1;
    visits.push({
      url,
      title: typeof r.title === "string" ? cleanTitle(r.title) : "",
      at,
      count,
    });
    if (visits.length >= MAX_VISITS) break;
  }
  visits.sort((a, b) => b.at - a.at);
  return { visits };
}

/** One suggestion under the address field. */
export interface Suggestion {
  url: string;
  title: string;
  kind: "bookmark" | "history";
}

/** `url` without its scheme and a leading `www.`: what a typed prefix is matched against. */
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
}

/**
 * What the address field suggests for `input`: the bookmarks and visited pages whose bare URL
 * starts with it, or whose title or URL holds all its words; a URL once, its bookmark first;
 * prefix matches before word matches, bookmarks before visits, then the most visited and most
 * recent. At most `limit`.
 */
export function suggest(
  input: string,
  bookmarks: Bookmarks,
  visits: Visits,
  limit = 8,
): Suggestion[] {
  const text = input.trim().toLowerCase();
  if (!text) return [];
  const prefix = bareUrl(text);
  type Scored = Suggestion & { score: number };
  const out = new Map<string, Scored>();
  const add = (s: Suggestion, score: number) => {
    const was = out.get(s.url);
    if (!was || was.score < score) {
      out.set(s.url, { ...s, title: s.title || was?.title || "", score });
    }
  };
  const isPrefix = (url: string) =>
    bareUrl(url.toLowerCase()).startsWith(prefix);
  for (const n of searchBookmarks(bookmarks, text)) {
    add(
      { url: n.url!, title: n.title, kind: "bookmark" },
      (isPrefix(n.url!) ? 4e15 : 2e15) + 1e14,
    );
  }
  for (const n of bookmarks.nodes) {
    if (n.kind === "bookmark" && isPrefix(n.url!)) {
      add({ url: n.url!, title: n.title, kind: "bookmark" }, 4e15 + 1e14);
    }
  }
  for (const v of searchVisits(visits, text)) {
    add(
      { url: v.url, title: v.title, kind: "history" },
      (isPrefix(v.url) ? 4e15 : 2e15) + Math.min(v.count, 99) * 1e12 +
        v.at / 1e3,
    );
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ url, title, kind }) => ({ url, title, kind }));
}
