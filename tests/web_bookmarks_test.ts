// The bookmarks model (lib/web/bookmarks.ts) and its storage (lib/web/synced.ts): add, move,
// reorder, delete and undo, the limits, what is kept from a stored tree, and the round trip
// through storage and across windows.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  addBookmark,
  addFolder,
  BAR_ID,
  type Bookmarks,
  BOOKMARKS_STORAGE_KEY,
  bookmarksFor,
  childrenOf,
  depthOf,
  emptyBookmarks,
  folderList,
  MAX_DEPTH,
  MAX_NODES,
  mergeImported,
  monogram,
  moveNode,
  OTHER_ID,
  pathOf,
  removeNodes,
  restoreNodes,
  sanitizeBookmarks,
  searchBookmarks,
  updateNode,
} from "../lib/web/bookmarks.ts";
import { syncedStore } from "../lib/web/synced.ts";

const ids = (b: Bookmarks, parent: string) =>
  childrenOf(b, parent).map((n) => n.id);

/** A bar with a, b, c and a folder f holding x. */
function sample(): Bookmarks {
  let b = emptyBookmarks();
  for (const id of ["a", "b", "c"]) {
    b = addBookmark(b, {
      id,
      title: id.toUpperCase(),
      url: `https://${id}.example/`,
      now: 1,
    }).bookmarks;
  }
  b = addFolder(b, { id: "f", title: "F", now: 1 }).bookmarks;
  b = addBookmark(b, {
    id: "x",
    title: "X",
    url: "https://x.example/",
    parentId: "f",
    now: 1,
  }).bookmarks;
  return b;
}

Deno.test("bookmarks: the empty tree is the bar and other bookmarks", () => {
  const b = emptyBookmarks();
  assertEquals(b.nodes.map((n) => [n.id, n.title, n.parentId]), [
    [BAR_ID, "Bookmarks bar", null],
    [OTHER_ID, "Other bookmarks", null],
  ]);
  assertEquals(folderList(b).map((f) => [f.node.id, f.depth]), [
    [BAR_ID, 0],
    [OTHER_ID, 0],
  ]);
});

Deno.test("bookmarks: add goes last (or at an index), http(s) only, titles cleaned", () => {
  let b = sample();
  assertEquals(ids(b, BAR_ID), ["a", "b", "c", "f"]);
  b =
    addBookmark(b, { id: "z", title: "Z", url: "https://z.example", index: 1 })
      .bookmarks;
  assertEquals(ids(b, BAR_ID), ["a", "z", "b", "c", "f"]);
  for (
    const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"]
  ) {
    const r = addBookmark(b, { title: "bad", url });
    assertEquals(r.id, null, url);
    assertStrictEquals(r.bookmarks, b);
  }
  const r = addBookmark(b, {
    title: "  Tab\tand\nnew line \u0000 ",
    url: "https://t.example",
  });
  const n = r.bookmarks.nodes.find((x) => x.id === r.id)!;
  assertEquals(n.title, "Tab and new line");
  assertEquals(n.url, "https://t.example/");
  // No title: the host.
  const h = addBookmark(b, { title: "", url: "https://host.example:8080/p" });
  assertEquals(
    h.bookmarks.nodes.find((x) => x.id === h.id)!.title,
    "host.example:8080",
  );
  // Not into a bookmark.
  assertEquals(
    addBookmark(b, { title: "x", url: "https://q/", parentId: "a" }).id,
    null,
  );
});

Deno.test("bookmarks: rename and change a URL; roots and bad URLs stay", () => {
  const b = sample();
  const renamed = updateNode(b, "a", { title: "Alpha" });
  assertEquals(renamed.nodes.find((n) => n.id === "a")!.title, "Alpha");
  assertStrictEquals(updateNode(b, "a", { title: "A" }), b, "unchanged");
  assertStrictEquals(updateNode(b, BAR_ID, { title: "Mine" }), b, "a root");
  assertStrictEquals(updateNode(b, "a", { url: "ftp://x/" }), b, "bad URL");
  assertStrictEquals(updateNode(b, "a", { title: "   " }), b, "empty title");
  const moved = updateNode(b, "a", { url: "https://alpha.example/x" });
  assertEquals(
    moved.nodes.find((n) => n.id === "a")!.url,
    "https://alpha.example/x",
  );
  assertEquals(
    bookmarksFor(moved, "https://alpha.example/x").map((n) => n.id),
    ["a"],
  );
});

Deno.test("bookmarks: move reorders within a folder and moves into folders", () => {
  const b = sample();
  // Reorder: the index counts the folder without the moved node.
  assertEquals(ids(moveNode(b, "a", BAR_ID, 2), BAR_ID), ["b", "c", "a", "f"]);
  assertEquals(ids(moveNode(b, "c", BAR_ID, 0), BAR_ID), ["c", "a", "b", "f"]);
  assertEquals(ids(moveNode(b, "a", BAR_ID), BAR_ID), ["b", "c", "f", "a"]);
  assertStrictEquals(moveNode(b, "a", BAR_ID, 0), b, "already there");
  // Into a folder (last), and out to other bookmarks.
  const into = moveNode(b, "b", "f");
  assertEquals(ids(into, "f"), ["x", "b"]);
  assertEquals(ids(into, BAR_ID), ["a", "c", "f"]);
  assertEquals(ids(moveNode(into, "f", OTHER_ID), OTHER_ID), ["f"]);
  assertEquals(pathOf(moveNode(into, "f", OTHER_ID), "b").map((n) => n.id), [
    OTHER_ID,
    "f",
    "b",
  ]);
  // Refused: a root, into a bookmark, into itself or below itself.
  const g = addFolder(b, { id: "g", title: "G", parentId: "f" }).bookmarks;
  assertStrictEquals(moveNode(g, BAR_ID, OTHER_ID), g);
  assertStrictEquals(moveNode(g, "c", "a"), g);
  assertStrictEquals(moveNode(g, "f", "f"), g);
  assertStrictEquals(moveNode(g, "f", "g"), g);
});

Deno.test("bookmarks: folders nest at most MAX_DEPTH deep", () => {
  let b = emptyBookmarks();
  let parent = BAR_ID;
  for (let i = 0; i < MAX_DEPTH + 3; i++) {
    const r = addFolder(b, { id: `d${i}`, title: `D${i}`, parentId: parent });
    if (!r.id) break;
    b = r.bookmarks;
    parent = r.id;
  }
  assertEquals(depthOf(b, parent), MAX_DEPTH);
  // A tree that would go too deep does not move under another folder.
  const other =
    addFolder(b, { id: "o", title: "O", parentId: OTHER_ID }).bookmarks;
  assertStrictEquals(moveNode(other, "d0", "o"), other);
});

Deno.test("bookmarks: delete takes a folder's contents; undo puts all back in place", () => {
  const b = sample();
  const { bookmarks: after, removed } = removeNodes(b, ["b", "f", BAR_ID]);
  assertEquals(ids(after, BAR_ID), ["a", "c"]);
  assertEquals(
    after.nodes.some((n) => n.id === "x"),
    false,
    "the folder's bookmark",
  );
  assertEquals(removed.entries.map((e) => e.node.id), ["b", "f", "x"]);
  const back = restoreNodes(after, removed);
  assertEquals(back.nodes, b.nodes);
  // Nothing to delete: unchanged.
  const none = removeNodes(b, ["nope", OTHER_ID]);
  assertStrictEquals(none.bookmarks, b);
  assertStrictEquals(restoreNodes(b, none.removed), b);
  // A restore after the folder went elsewhere keeps what still has a folder.
  const { bookmarks: noF, removed: justX } = removeNodes(b, ["x"]);
  const gone = removeNodes(noF, ["f"]).bookmarks;
  assertStrictEquals(restoreNodes(gone, justX), gone);
});

Deno.test("bookmarks: search, monograms", () => {
  const b = sample();
  assertEquals(searchBookmarks(b, "x.example").map((n) => n.id), ["x"]);
  assertEquals(searchBookmarks(b, "EXAMPLE b").map((n) => n.id), ["b"]);
  assertEquals(searchBookmarks(b, "  "), []);
  assertEquals(monogram("github", "https://github.com/"), "G");
  assertEquals(monogram("  — 2fa", undefined), "2");
  assertEquals(monogram("", "https://www.deno.land/"), "D");
  assertEquals(monogram("ünïcode"), "Ü");
  assertEquals(monogram("", ""), "•");
});

Deno.test("bookmarks: sanitize keeps well-formed nodes that hang off a root", () => {
  const raw = {
    nodes: [
      {
        id: "bar",
        kind: "folder",
        title: "Hacked",
        parentId: null,
        createdAt: 5,
      },
      {
        id: "a",
        kind: "bookmark",
        title: "A",
        url: "https://a/",
        parentId: "bar",
        createdAt: 2,
      },
      {
        id: "js",
        kind: "bookmark",
        title: "JS",
        url: "javascript:alert(1)",
        parentId: "bar",
      },
      {
        id: "a",
        kind: "bookmark",
        title: "dup",
        url: "https://dup/",
        parentId: "bar",
      },
      {
        id: "orphan",
        kind: "bookmark",
        title: "O",
        url: "https://o/",
        parentId: "nowhere",
      },
      { id: "c1", kind: "folder", title: "C1", parentId: "c2" },
      { id: "c2", kind: "folder", title: "C2", parentId: "c1" },
      { id: "f", kind: "folder", title: "F", parentId: "other" },
      {
        id: "in-f",
        kind: "bookmark",
        title: "\u0007ok",
        url: "http://in.f/",
        parentId: "f",
      },
      {
        id: "under-bm",
        kind: "bookmark",
        title: "U",
        url: "https://u/",
        parentId: "a",
      },
      {
        id: "x".repeat(65),
        kind: "bookmark",
        title: "long id",
        url: "https://l/",
        parentId: "bar",
      },
      {
        id: "long",
        kind: "bookmark",
        title: "t".repeat(400),
        url: "https://t/",
        parentId: "bar",
      },
      {
        id: "big",
        kind: "bookmark",
        title: "B",
        url: `https://b/${"p".repeat(3000)}`,
        parentId: "bar",
      },
      "junk",
      null,
    ],
  };
  const b = sanitizeBookmarks(raw);
  assertEquals(b.nodes.map((n) => n.id), [
    "bar",
    "other",
    "a",
    "f",
    "in-f",
    "long",
  ]);
  assertEquals(b.nodes[0].title, "Bookmarks bar", "a root's title is fixed");
  assertEquals(b.nodes[0].createdAt, 5);
  assertEquals(b.nodes.find((n) => n.id === "in-f")!.title, "ok");
  assertEquals(b.nodes.find((n) => n.id === "long")!.title.length, 300);
  assertEquals(sanitizeBookmarks(null), emptyBookmarks());
  assertEquals(sanitizeBookmarks({ nodes: "x" }), emptyBookmarks());
});

Deno.test("bookmarks: at most MAX_NODES are kept or added", () => {
  const nodes = Array.from({ length: MAX_NODES + 50 }, (_, i) => ({
    id: `n${i}`,
    kind: "bookmark",
    title: `N${i}`,
    url: `https://n${i}.example/`,
    parentId: "bar",
  }));
  const b = sanitizeBookmarks({ nodes });
  assertEquals(b.nodes.length, MAX_NODES);
  assertEquals(
    addBookmark(b, { title: "one more", url: "https://m/" }).id,
    null,
  );
  const merged = mergeImported(b, [{ title: "I", url: "https://i/" }]);
  assertEquals(merged.folderId, null);
});

Deno.test("bookmarks: imported entries go in a new folder in other bookmarks", () => {
  const b = sample();
  const { bookmarks, folderId, count } = mergeImported(b, [
    { title: "One", url: "https://one/" },
    { title: "Dir", children: [{ title: "Two", url: "https://two/" }] },
    { title: "Bad", url: "javascript:void 0" },
  ], { now: 9 });
  assert(folderId);
  assertEquals(count, 2);
  assertEquals(ids(bookmarks, OTHER_ID), [folderId]);
  const inside = childrenOf(bookmarks, folderId);
  assertEquals(inside.map((n) => n.title), ["One", "Dir"]);
  assertEquals(childrenOf(bookmarks, inside[1].id).map((n) => n.url), [
    "https://two/",
  ]);
  assertEquals(
    bookmarks.nodes.find((n) => n.id === folderId)!.title,
    "Imported",
  );
  // What came in survives a save and a load.
  assertEquals(
    sanitizeBookmarks(JSON.parse(JSON.stringify(bookmarks))),
    bookmarks,
  );
});

/** A localStorage and window stand-in shared by two "windows". */
function fakeWindows() {
  const data = new Map<string, string>();
  const listeners = new Set<(e: { key: string | null }) => void>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
  const events = {
    addEventListener: (_: "storage", fn: (e: { key: string | null }) => void) =>
      void listeners.add(fn),
    removeEventListener: (
      _: "storage",
      fn: (e: { key: string | null }) => void,
    ) => void listeners.delete(fn),
  };
  return {
    data,
    storage,
    events,
    listeners,
    /** Another window wrote `key` (the browser fires `storage` in the others). */
    fire: (key: string | null) => {
      for (const fn of [...listeners]) fn({ key });
    },
  };
}

Deno.test("bookmarks: persist round trip and the other windows follow", () => {
  const w = fakeWindows();
  const one = syncedStore(BOOKMARKS_STORAGE_KEY, sanitizeBookmarks, w);
  const two = syncedStore(BOOKMARKS_STORAGE_KEY, sanitizeBookmarks, w);
  assertEquals(one.get(), emptyBookmarks(), "nothing stored yet");
  const seen: Bookmarks[] = [];
  const off = two.subscribe((b) => seen.push(b));
  assertEquals(w.listeners.size, 1);
  const b = sample();
  one.set(b);
  assertEquals(JSON.parse(w.data.get(BOOKMARKS_STORAGE_KEY)!), b);
  // The other window hears the storage event and reads it back, checked.
  w.fire("qutty.settings.v1");
  assertEquals(seen.length, 0, "another key");
  w.fire(BOOKMARKS_STORAGE_KEY);
  assertEquals(seen.length, 1);
  assertEquals(seen[0], b);
  assertEquals(two.get(), b);
  off();
  assertEquals(w.listeners.size, 0);
  // Unfollowed, a read still sees the latest.
  one.set(moveNode(b, "a", BAR_ID));
  assertEquals(ids(two.get(), BAR_ID), ["b", "c", "f", "a"]);
  // Junk on the key: the empty tree. A storage that throws: kept in memory.
  w.data.set(BOOKMARKS_STORAGE_KEY, "{not json");
  assertEquals(
    syncedStore(BOOKMARKS_STORAGE_KEY, sanitizeBookmarks, w).get(),
    emptyBookmarks(),
  );
  const broken = syncedStore(BOOKMARKS_STORAGE_KEY, sanitizeBookmarks, {
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    },
    events: null,
  });
  broken.set(b);
  assertStrictEquals(broken.get(), b, "kept in memory");
});
