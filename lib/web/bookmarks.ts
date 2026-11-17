/**
 * Web tile bookmarks: a tree of bookmarks and folders under two fixed roots, the "Bookmarks bar"
 * (what the bar under a web tile's toolbar shows, app/bookmarks-bar.tsx) and "Other bookmarks".
 *
 * The tree is one flat, ordered list of nodes: a node's children are the nodes whose `parentId`
 * is its id, in list order. Every operation is pure and returns a new tree (or the same one when
 * nothing changes), so the manager's undo and the cross-window sync (lib/web/synced.ts) can
 * compare by identity.
 *
 * Stored on its own localStorage key ({@linkcode BOOKMARKS_STORAGE_KEY}), not in the settings blob:
 * an imported library can run to thousands of entries, and the settings are rewritten on every
 * settings change. Everything read back is checked ({@linkcode sanitizeBookmarks}): http(s) URLs
 * only, capped lengths, counts and depth.
 *
 * Client-safe, no DOM.
 *
 * @module
 */

import { parseWebUrl } from "./url.ts";

/** A bookmark or a folder. */
export interface BookmarkNode {
  id: string;
  kind: "bookmark" | "folder";
  title: string;
  /** A bookmark's http(s) URL (folders have none). */
  url?: string;
  /** The folder it is in; `null` for the two roots. */
  parentId: string | null;
  /** When it was made (ms since the epoch). */
  createdAt: number;
}

/** The whole tree, in order. */
export interface Bookmarks {
  readonly nodes: readonly BookmarkNode[];
}

/** The root the bar shows. */
export const BAR_ID = "bar";
/** The other root. */
export const OTHER_ID = "other";
const ROOT_TITLES: Record<string, string> = {
  [BAR_ID]: "Bookmarks bar",
  [OTHER_ID]: "Other bookmarks",
};

/** The localStorage key; bump the suffix when the shape changes incompatibly. */
export const BOOKMARKS_STORAGE_KEY = "qutty.bookmarks.v1";

/** The most nodes kept (an imported library past this is cut). */
export const MAX_NODES = 5000;
/** The deepest a folder may nest below a root. */
export const MAX_DEPTH = 12;
/** The longest title kept. */
const MAX_TITLE = 300;
/** The longest URL kept. */
const MAX_URL = 2048;
const MAX_ID = 64;

/** The empty tree: the two roots. */
export function emptyBookmarks(now = 0): Bookmarks {
  return {
    nodes: [BAR_ID, OTHER_ID].map((id) => ({
      id,
      kind: "folder" as const,
      title: ROOT_TITLES[id],
      parentId: null,
      createdAt: now,
    })),
  };
}

/** Whether `id` is one of the two roots (never renamed, moved or deleted). */
export function isRoot(id: string): boolean {
  return id === BAR_ID || id === OTHER_ID;
}

/** A title cleaned up: no control characters, trimmed, capped. */
export function cleanTitle(raw: string): string {
  // deno-lint-ignore no-control-regex -- control characters are what it strips
  return raw.replace(/[\0-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim()
    .slice(0, MAX_TITLE);
}

/** `raw` as a URL a bookmark may keep (http(s), not too long), or `null`. */
export function bookmarkUrl(raw: string): string | null {
  if (raw.length > MAX_URL) return null;
  const url = parseWebUrl(raw.trim());
  return url && url.href.length <= MAX_URL ? url.href : null;
}

let seq = 0;
/** A fresh node id. */
function newBookmarkId(): string {
  seq = (seq + 1) % 1_000_000;
  return `b${Date.now().toString(36)}${seq.toString(36)}${
    Math.floor(Math.random() * 1e6).toString(36)
  }`;
}

/** Node `id` (`undefined`: none). */
export function nodeById(
  b: Bookmarks,
  id: string,
): BookmarkNode | undefined {
  return b.nodes.find((n) => n.id === id);
}

/** The children of folder `parentId`, in order. */
export function childrenOf(b: Bookmarks, parentId: string): BookmarkNode[] {
  return b.nodes.filter((n) => n.parentId === parentId);
}

/** Every node below `id` (not `id` itself). */
export function descendantsOf(b: Bookmarks, id: string): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  const queue = [id];
  while (queue.length) {
    const at = queue.shift()!;
    for (const n of b.nodes) {
      if (n.parentId === at) {
        out.push(n);
        if (n.kind === "folder") queue.push(n.id);
      }
    }
  }
  return out;
}

/** How deep `id` is below its root (a root is 0; `-1`: no such node). */
export function depthOf(b: Bookmarks, id: string): number {
  let depth = 0;
  let node = nodeById(b, id);
  if (!node) return -1;
  while (node.parentId !== null) {
    depth++;
    node = nodeById(b, node.parentId);
    if (!node || depth > MAX_DEPTH + 1) return -1;
  }
  return depth;
}

/** The folders from the root down to `id` (inclusive). */
export function pathOf(b: Bookmarks, id: string): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  let node = nodeById(b, id);
  while (node && out.length <= MAX_DEPTH + 1) {
    out.unshift(node);
    node = node.parentId === null ? undefined : nodeById(b, node.parentId);
  }
  return out;
}

/** Every folder, depth first in order, with its depth (what a folder picker lists). */
export function folderList(
  b: Bookmarks,
): { node: BookmarkNode; depth: number }[] {
  const out: { node: BookmarkNode; depth: number }[] = [];
  const walk = (parentId: string, depth: number) => {
    for (const n of childrenOf(b, parentId)) {
      if (n.kind !== "folder") continue;
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  for (const id of [BAR_ID, OTHER_ID]) {
    const root = nodeById(b, id);
    if (root) out.push({ node: root, depth: 0 });
    walk(id, 1);
  }
  return out;
}

/** The bookmarks for `url` (the same page: compared as parsed URLs). */
export function bookmarksFor(b: Bookmarks, url: string): BookmarkNode[] {
  const href = bookmarkUrl(url);
  if (!href) return [];
  return b.nodes.filter((n) => n.kind === "bookmark" && n.url === href);
}

/** The bookmarks whose title or URL holds every word of `query` (case-insensitive). */
export function searchBookmarks(b: Bookmarks, query: string): BookmarkNode[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return b.nodes.filter((n) => {
    if (n.kind !== "bookmark") return false;
    const hay = `${n.title} ${n.url ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The letter a bookmark's icon shows: its title's first letter or digit, else its host's. */
export function monogram(title: string, url?: string): string {
  const pick = (s: string) => s.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase();
  let host = "";
  if (url) {
    host = (parseWebUrl(url)?.hostname ?? "").replace(/^www\./, "");
  }
  return pick(title) ?? pick(host) ?? "•";
}

/** The list with `node` inserted as child `index` of its parent (`undefined`: last). */
function insertAt(
  nodes: readonly BookmarkNode[],
  node: BookmarkNode,
  index?: number,
): BookmarkNode[] {
  const out = [...nodes];
  const siblings = out.filter((n) => n.parentId === node.parentId);
  if (index !== undefined && index >= 0 && index < siblings.length) {
    out.splice(out.indexOf(siblings[index]), 0, node);
  } else if (siblings.length > 0) {
    out.splice(out.indexOf(siblings[siblings.length - 1]) + 1, 0, node);
  } else {
    // A folder's first child goes at the end (the roots stay first, as a stored tree has them).
    out.push(node);
  }
  return out;
}

/** Whether a node can be put in `parentId`: an existing folder, not too deep, room left. */
function canHold(b: Bookmarks, parentId: string): boolean {
  const parent = nodeById(b, parentId);
  return !!parent && parent.kind === "folder" &&
    depthOf(b, parentId) < MAX_DEPTH && b.nodes.length < MAX_NODES;
}

export interface NewBookmark {
  title: string;
  url: string;
  /** The folder (default: the bar). */
  parentId?: string;
  /** Its place among the folder's children (default: last). */
  index?: number;
  id?: string;
  now?: number;
}

/** Add a bookmark; `id` is `null` (and the tree unchanged) for a URL it cannot keep. */
export function addBookmark(
  b: Bookmarks,
  item: NewBookmark,
): { bookmarks: Bookmarks; id: string | null } {
  const url = bookmarkUrl(item.url);
  const parentId = item.parentId ?? BAR_ID;
  if (!url || !canHold(b, parentId)) return { bookmarks: b, id: null };
  const id = item.id ?? newBookmarkId();
  const node: BookmarkNode = {
    id,
    kind: "bookmark",
    title: cleanTitle(item.title) || (parseWebUrl(url)?.host ?? url),
    url,
    parentId,
    createdAt: item.now ?? Date.now(),
  };
  return { bookmarks: { nodes: insertAt(b.nodes, node, item.index) }, id };
}

/** Add a folder (default title "New folder"); `id` is `null` when it cannot go there. */
export function addFolder(
  b: Bookmarks,
  item: {
    title: string;
    parentId?: string;
    index?: number;
    id?: string;
    now?: number;
  },
): { bookmarks: Bookmarks; id: string | null } {
  const parentId = item.parentId ?? BAR_ID;
  if (!canHold(b, parentId)) return { bookmarks: b, id: null };
  const id = item.id ?? newBookmarkId();
  const node: BookmarkNode = {
    id,
    kind: "folder",
    title: cleanTitle(item.title) || "New folder",
    parentId,
    createdAt: item.now ?? Date.now(),
  };
  return { bookmarks: { nodes: insertAt(b.nodes, node, item.index) }, id };
}

/** Rename a node or change a bookmark's URL (a URL it cannot keep, or a root: unchanged). */
export function updateNode(
  b: Bookmarks,
  id: string,
  patch: { title?: string; url?: string },
): Bookmarks {
  const node = nodeById(b, id);
  if (!node || isRoot(id)) return b;
  const next = { ...node };
  if (patch.title !== undefined) {
    const title = cleanTitle(patch.title);
    if (title) next.title = title;
  }
  if (patch.url !== undefined && node.kind === "bookmark") {
    const url = bookmarkUrl(patch.url);
    if (!url) return b;
    next.url = url;
  }
  if (next.title === node.title && next.url === node.url) return b;
  return { nodes: b.nodes.map((n) => (n === node ? next : n)) };
}

/**
 * Move node `id` to child `index` of folder `parentId` (`undefined`: last). The index counts the
 * folder's children without the moved node, so moving within one folder is a reorder. Refused
 * (unchanged) for a root, a target that is not a folder, or the node itself or one of its
 * descendants.
 */
export function moveNode(
  b: Bookmarks,
  id: string,
  parentId: string,
  index?: number,
): Bookmarks {
  const node = nodeById(b, id);
  const parent = nodeById(b, parentId);
  if (!node || !parent || isRoot(id) || parent.kind !== "folder") return b;
  if (parentId === id || descendantsOf(b, id).some((n) => n.id === parentId)) {
    return b;
  }
  const height = node.kind === "folder"
    ? Math.max(0, ...descendantsOf(b, id).map((n) => depthOf(b, n.id))) -
      depthOf(b, id)
    : 0;
  if (depthOf(b, parentId) + 1 + height > MAX_DEPTH) return b;
  const without = b.nodes.filter((n) => n !== node);
  const moved = node.parentId === parentId ? node : { ...node, parentId };
  const nodes = insertAt(without, moved, index);
  const same = nodes.length === b.nodes.length &&
    nodes.every((n, i) => n === b.nodes[i]);
  return same ? b : { nodes };
}

/** What {@linkcode removeNodes} took out: enough to put it back ({@linkcode restoreNodes}). */
export interface Removed {
  /** The nodes taken out, with where each was in the list, in list order. */
  readonly entries: readonly { node: BookmarkNode; at: number }[];
}

/** Delete `ids` and everything in them (the roots stay). */
export function removeNodes(
  b: Bookmarks,
  ids: readonly string[],
): { bookmarks: Bookmarks; removed: Removed } {
  const gone = new Set<string>();
  for (const id of ids) {
    if (isRoot(id) || !nodeById(b, id)) continue;
    gone.add(id);
    for (const d of descendantsOf(b, id)) gone.add(d.id);
  }
  if (gone.size === 0) return { bookmarks: b, removed: { entries: [] } };
  const entries: { node: BookmarkNode; at: number }[] = [];
  b.nodes.forEach((node, at) => {
    if (gone.has(node.id)) entries.push({ node, at });
  });
  return {
    bookmarks: { nodes: b.nodes.filter((n) => !gone.has(n.id)) },
    removed: { entries },
  };
}

/**
 * Put back what {@linkcode removeNodes} took out, each node where it was. Nodes whose folder is
 * gone by now, or whose id came back meanwhile, stay out.
 */
export function restoreNodes(b: Bookmarks, removed: Removed): Bookmarks {
  if (removed.entries.length === 0) return b;
  const nodes = [...b.nodes];
  const ids = new Set(nodes.map((n) => n.id));
  for (const { node, at } of removed.entries) {
    if (ids.has(node.id) || node.parentId === null) continue;
    if (!ids.has(node.parentId)) continue;
    nodes.splice(Math.min(at, nodes.length), 0, node);
    ids.add(node.id);
  }
  return nodes.length === b.nodes.length ? b : { nodes };
}

/**
 * A stored or synced tree, checked: the two roots (always, first), then every node that is
 * well formed and hangs off a root through existing folders, at most {@linkcode MAX_DEPTH} deep,
 * in order, at most {@linkcode MAX_NODES}. Bookmarks keep http(s) URLs only.
 */
export function sanitizeBookmarks(raw: unknown): Bookmarks {
  const base = emptyBookmarks();
  const list = raw && typeof raw === "object" &&
      Array.isArray((raw as { nodes?: unknown }).nodes)
    ? (raw as { nodes: unknown[] }).nodes
    : [];
  const candidates: BookmarkNode[] = [];
  const seen = new Set<string>([BAR_ID, OTHER_ID]);
  const roots = new Map(base.nodes.map((n) => [n.id, { ...n }]));
  for (const v of list.slice(0, MAX_NODES * 2)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || r.id.length > MAX_ID) continue;
    const createdAt = typeof r.createdAt === "number" &&
        Number.isFinite(r.createdAt) && r.createdAt >= 0
      ? Math.floor(r.createdAt)
      : 0;
    if (isRoot(r.id)) {
      roots.get(r.id)!.createdAt = createdAt;
      continue;
    }
    if (seen.has(r.id)) continue;
    if (typeof r.parentId !== "string") continue;
    const title = typeof r.title === "string" ? cleanTitle(r.title) : "";
    if (r.kind === "folder") {
      seen.add(r.id);
      candidates.push({
        id: r.id,
        kind: "folder",
        title: title || "Folder",
        parentId: r.parentId,
        createdAt,
      });
    } else if (r.kind === "bookmark" && typeof r.url === "string") {
      const url = bookmarkUrl(r.url);
      if (!url) continue;
      seen.add(r.id);
      candidates.push({
        id: r.id,
        kind: "bookmark",
        title: title || (parseWebUrl(url)?.host ?? url),
        url,
        parentId: r.parentId,
        createdAt,
      });
    }
  }
  // Keep what hangs off a root through kept folders (a cycle or an orphan hangs off none).
  const kids = new Map<string, BookmarkNode[]>();
  for (const n of candidates) {
    const list = kids.get(n.parentId!) ?? [];
    list.push(n);
    kids.set(n.parentId!, list);
  }
  const reached = new Set<string>();
  const queue: [string, number][] = [[BAR_ID, 0], [OTHER_ID, 0]];
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (d >= MAX_DEPTH) continue;
    for (const n of kids.get(id) ?? []) {
      if (reached.size >= MAX_NODES - 2) break;
      reached.add(n.id);
      if (n.kind === "folder") queue.push([n.id, d + 1]);
    }
  }
  const kept = candidates.filter((n) => reached.has(n.id));
  return { nodes: [roots.get(BAR_ID)!, roots.get(OTHER_ID)!, ...kept] };
}

/** One imported entry: a bookmark, or a folder of entries (lib/web/bookmark-files.ts). */
export type ImportedItem =
  | { title: string; url: string; addedAt?: number }
  | { title: string; children: ImportedItem[]; addedAt?: number };

/**
 * Add `items` in a new folder `title` (default "Imported") at the end of "Other bookmarks", as
 * far as the limits allow. Returns the folder's id (`null`: nothing could be added) and how many
 * bookmarks went in.
 */
export function mergeImported(
  b: Bookmarks,
  items: readonly ImportedItem[],
  options: { title?: string; now?: number } = {},
): { bookmarks: Bookmarks; folderId: string | null; count: number } {
  const now = options.now ?? Date.now();
  const made = addFolder(b, {
    title: options.title ?? "Imported",
    parentId: OTHER_ID,
    now,
  });
  if (!made.id) return { bookmarks: b, folderId: null, count: 0 };
  // Built as one list and appended (adding one by one would be quadratic on a big library).
  const added: BookmarkNode[] = [];
  let room = MAX_NODES - made.bookmarks.nodes.length;
  let count = 0;
  const walk = (list: readonly ImportedItem[], parentId: string, d: number) => {
    for (const item of list) {
      if (room <= 0) return;
      const createdAt = item.addedAt ?? now;
      if ("children" in item) {
        if (d > MAX_DEPTH) continue;
        const id = newBookmarkId();
        added.push({
          id,
          kind: "folder",
          title: cleanTitle(item.title) || "Folder",
          parentId,
          createdAt,
        });
        room--;
        walk(item.children, id, d + 1);
      } else {
        const url = bookmarkUrl(item.url);
        if (!url) continue;
        added.push({
          id: newBookmarkId(),
          kind: "bookmark",
          title: cleanTitle(item.title) || (parseWebUrl(url)?.host ?? url),
          url,
          parentId,
          createdAt,
        });
        room--;
        count++;
      }
    }
  };
  walk(items, made.id, depthOf(made.bookmarks, made.id) + 1);
  return {
    bookmarks: { nodes: [...made.bookmarks.nodes, ...added] },
    folderId: made.id,
    count,
  };
}
