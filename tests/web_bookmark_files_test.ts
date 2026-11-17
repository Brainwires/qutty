// Bookmark files (lib/web/bookmark-files.ts): the Netscape bookmarks HTML every browser imports
// and exports (round trip, nested folders, escaping, the loose markup browsers write) and
// Chrome's `Bookmarks` JSON.

import { assert, assertEquals } from "@std/assert";
import {
  addBookmark,
  addFolder,
  BAR_ID,
  type Bookmarks,
  childrenOf,
  emptyBookmarks,
  type ImportedItem,
  mergeImported,
  OTHER_ID,
} from "../lib/web/bookmarks.ts";
import {
  decodeEntities,
  escapeHtml,
  exportNetscapeBookmarks,
  parseChromeBookmarks,
  parseNetscapeBookmarks,
} from "../lib/web/bookmark-files.ts";

/** The tree below `parentId` as imported items (what a parse of its export should give). */
function asItems(b: Bookmarks, parentId: string): ImportedItem[] {
  return childrenOf(b, parentId).map((n) =>
    n.kind === "folder"
      ? { title: n.title, children: asItems(b, n.id), addedAt: n.createdAt }
      : { title: n.title, url: n.url!, addedAt: n.createdAt }
  );
}

Deno.test("netscape: export then import gives the same tree, nested and escaped", () => {
  let b = emptyBookmarks(1_600_000_000_000);
  const t = 1_700_000_000_000;
  b = addBookmark(b, {
    id: "q",
    title: `Quotes "and" <tags> & ampersands`,
    url: "https://example.com/search?q=a&b=%22c%22",
    now: t,
  }).bookmarks;
  b = addFolder(b, { id: "f", title: "Dev & <Tools>", now: t }).bookmarks;
  b = addBookmark(b, {
    title: "Deno",
    url: "https://deno.land/",
    parentId: "f",
    now: t,
  }).bookmarks;
  b =
    addFolder(b, { id: "g", title: "Deeper", parentId: "f", now: t }).bookmarks;
  b = addBookmark(b, {
    title: "日本語 ✓",
    url: "http://localhost:3000/x",
    parentId: "g",
    now: t,
  }).bookmarks;
  b = addBookmark(b, {
    title: "Other one",
    url: "https://other.example/",
    parentId: OTHER_ID,
    now: t,
  }).bookmarks;

  const html = exportNetscapeBookmarks(b);
  assert(html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>"));
  assert(html.includes('PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>'));
  assert(html.includes("Quotes &quot;and&quot; &lt;tags&gt; &amp; ampersands"));
  assert(html.includes('HREF="https://example.com/search?q=a&amp;b=%22c%22"'));
  assert(html.includes(`ADD_DATE="${t / 1000}"`));

  const parsed = parseNetscapeBookmarks(html);
  assertEquals(parsed, [
    {
      title: "Bookmarks bar",
      addedAt: 1_600_000_000_000,
      children: asItems(b, BAR_ID),
    },
    {
      title: "Other bookmarks",
      addedAt: 1_600_000_000_000,
      children: asItems(b, OTHER_ID),
    },
  ]);
  // And into another tree: under Imported, the same shape.
  const merged = mergeImported(emptyBookmarks(), parsed, { now: 5 });
  const imported = childrenOf(merged.bookmarks, merged.folderId!);
  assertEquals(imported.map((n) => n.title), [
    "Bookmarks bar",
    "Other bookmarks",
  ]);
  assertEquals(asItems(merged.bookmarks, imported[0].id), asItems(b, BAR_ID));
  assertEquals(merged.count, 4);
});

Deno.test("netscape: the loose markup browsers write", () => {
  // Firefox-style: lowercase tags, a place: link, stray <p>, a separator, attributes in any
  // order, single quotes, entities in titles, a description (<DD>).
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks Menu</H1>
<DL><p>
  <DT><A HREF="place:sort=8&amp;maxResults=10">Recent Tags</A>
  <HR>
  <dt><h3 add_date='1700000000' last_modified="1">Mozilla &#38; Friends</h3>
  <dl><p>
    <dt><a icon="data:image/png;base64,AAAA" href='https://www.mozilla.org/' add_date="1700000001">Mozilla &#x2014; Home</a>
    <DD>A description that is not a bookmark
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    <DT><A HREF="file:///Users/me/notes.txt">A file</A>
  </dl><p>
  <DT><A HREF="https://top.example/">Top &lt;level&gt;</A>
</DL><p>`;
  assertEquals(parseNetscapeBookmarks(html), [
    {
      title: "Mozilla & Friends",
      addedAt: 1_700_000_000_000,
      children: [{
        title: "Mozilla — Home",
        url: "https://www.mozilla.org/",
        addedAt: 1_700_000_001_000,
      }],
    },
    { title: "Top <level>", url: "https://top.example/" },
  ]);
  assertEquals(parseNetscapeBookmarks(""), []);
  assertEquals(
    parseNetscapeBookmarks("<html><body>no bookmarks</body></html>"),
    [],
  );
  // Unclosed lists still give what was read.
  assertEquals(
    parseNetscapeBookmarks(
      '<DL><DT><H3>F</H3><DL><DT><A HREF="https://a/">A</A>',
    ),
    [{ title: "F", children: [{ title: "A", url: "https://a/" }] }],
  );
});

Deno.test("netscape: entities and escaping", () => {
  assertEquals(
    decodeEntities("&amp;&lt;&gt;&quot;&#39;&#x41;&nbsp;&bogus;&#0;"),
    "&<>\"'A &bogus;&#0;",
  );
  assertEquals(
    escapeHtml(`<a href="x">&</a>`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
  );
});

Deno.test("chrome: the Bookmarks JSON's bar, other and synced folders", () => {
  const json = JSON.stringify({
    checksum: "x",
    roots: {
      bookmark_bar: {
        type: "folder",
        name: "Bookmarks bar",
        date_added: "13350000000000000",
        children: [
          {
            type: "url",
            name: "Deno",
            url: "https://deno.land/",
            date_added: "13350000000000000",
          },
          { type: "url", name: "JS", url: "javascript:alert(1)" },
          {
            type: "folder",
            name: "Work",
            children: [{
              type: "url",
              name: "Docs",
              url: "https://docs.example/",
            }],
          },
        ],
      },
      other: { type: "folder", name: "Other bookmarks", children: [] },
      synced: {
        type: "folder",
        name: "Mobile bookmarks",
        children: [{ type: "url", name: "Phone", url: "https://m.example/" }],
      },
    },
    version: 1,
  });
  const items = parseChromeBookmarks(json);
  // 13350000000000000 µs since 1601 is 2024-01-15.
  const added = Math.floor(13350000000000000 / 1000 - 11_644_473_600_000);
  assertEquals(items, [
    {
      title: "Bookmarks bar",
      addedAt: added,
      children: [
        { title: "Deno", url: "https://deno.land/", addedAt: added },
        {
          title: "Work",
          children: [{ title: "Docs", url: "https://docs.example/" }],
        },
      ],
    },
    {
      title: "Mobile bookmarks",
      children: [{ title: "Phone", url: "https://m.example/" }],
    },
  ]);
  assertEquals(parseChromeBookmarks("not json"), []);
  assertEquals(parseChromeBookmarks("{}"), []);
  assertEquals(parseChromeBookmarks('{"roots": 3}'), []);
});
