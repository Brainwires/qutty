// The web tiles' browser parts against the demo backend and the local test site (the iframe
// engine, which headless Chromium uses): the star and the bookmarks bar, the bookmark manager
// (rename, delete and Undo), Settings → Links → "Show bookmarks bar", the browser keys over a
// focused web tile (⌘L, ⌘[, ⌘= zooming the page and not the terminals' font), and the address
// field's suggestions from the visited pages.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor, type WebPages } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { frameSrc, goTo, openPageA, shows, withPages } from "./web_helpers.ts";

/** The titles on web tile `id`'s bookmarks bar. */
const barTitles = (app: App, id: string) =>
  app.eval(
    (sel: string) =>
      [...document.querySelectorAll(sel)].map((el) =>
        el.querySelector(".bm-title")!.textContent
      ),
    `${tileSel(id)} [data-testid=bm-item]`,
  );

/** Star the page web tile `id` shows, name the bookmark `name`, and press Enter. */
async function star(app: App, id: string, name: string): Promise<void> {
  await app.click(`${tileSel(id)} [data-testid=web-star]`);
  await waitFor(
    () => app.exists("[data-testid=bm-popover][data-mode=star]"),
    3000,
    "the star's popover",
  );
  // The name is focused and selected: typing replaces it.
  await waitFor(
    () =>
      app.eval(() =>
        document.activeElement?.getAttribute("data-testid") ===
          "bm-popover-name"
      ),
    2000,
    "the name focused",
  );
  await app.page.keyboard.type(name);
  await app.press("Enter");
  await waitFor(
    async () => !(await app.exists("[data-testid=bm-popover]")),
    2000,
    "the popover closed",
  );
}

/** Give web tile `id`'s body the keyboard (not the cross-origin frame, which keeps keys). */
async function focusBody(app: App, id: string): Promise<void> {
  await app.eval(
    (sel: string) => document.querySelector<HTMLElement>(sel)!.focus(),
    `${tileSel(id)} [data-testid=web-body]`,
  );
}

/** A web tile on page A, then gone on to page B (so Back has somewhere to go). */
async function openAThenB(
  app: App,
  pages: WebPages,
): Promise<{ web: string; a: string; b: string }> {
  const { web, url: a } = await openPageA(app, pages);
  const b = `${pages.origin}/b`;
  await goTo(app, web, b);
  await shows(app, pages, web, b);
  return { web, a, b };
}

const activeTestid = (app: App) =>
  app.eval(() => document.activeElement?.getAttribute("data-testid") ?? null);

suite("web browser", (test) => {
  test("star a page: it is on the bar, and a click on it goes back there", async (app) => {
    await withPages(async (pages) => {
      const { web, url: a } = await openPageA(app, pages);
      assertEquals(await barTitles(app, web), [], "an empty bar");
      assert(await app.exists(`${tileSel(web)} [data-testid=bm-empty]`));
      assertEquals(
        await app.attr(
          `${tileSel(web)} [data-testid=web-star]`,
          "aria-pressed",
        ),
        "false",
      );
      await star(app, web, "Page A");
      assertEquals(await barTitles(app, web), ["Page A"]);
      assertEquals(
        await app.attr(
          `${tileSel(web)} [data-testid=web-star]`,
          "aria-pressed",
        ),
        "true",
      );
      // Saved on its own key, not in the settings.
      const stored = await app.eval(() =>
        JSON.parse(localStorage.getItem("qutty.bookmarks.v1") ?? "null")
      );
      assertEquals(
        stored.nodes.filter((n: { kind: string }) => n.kind === "bookmark")
          .map((n: { url: string }) => n.url),
        [a],
      );

      // Elsewhere, the star is empty; the bar's entry goes back.
      const b = `${pages.origin}/b`;
      await goTo(app, web, b);
      await shows(app, pages, web, b);
      assertEquals(
        await app.attr(
          `${tileSel(web)} [data-testid=web-star]`,
          "aria-pressed",
        ),
        "false",
      );
      await app.click(`${tileSel(web)} [data-testid=bm-item]`);
      await waitFor(
        async () => (await frameSrc(app, web)) === a,
        5000,
        "page A",
      );
      // Http: the address field says it is not secure.
      assertEquals(
        await app.attr(
          `${tileSel(web)} [data-testid=web-security]`,
          "data-secure",
        ),
        "false",
      );
    });
  });

  test("the manager: rename a bookmark, delete it, undo", async (app) => {
    await withPages(async (pages) => {
      const { web } = await openPageA(app, pages);
      await star(app, web, "Page A");
      // Bookmarks… in the + menu.
      await app.click("[data-testid=bar-new-menu]");
      await app.click("[data-testid=launch-bookmarks]");
      await waitFor(
        () => app.exists("[data-testid=bm-manager]"),
        3000,
        "the manager",
      );
      const rows = () =>
        app.eval(() =>
          [...document.querySelectorAll(
            "[data-testid=bmm-row] [data-testid=bmm-title]",
          )]
            .map((el) => el.textContent)
        );
      assertEquals(await rows(), ["Page A"]);

      // Rename inline: double click the name, type, Enter.
      await app.eval(() =>
        document.querySelector("[data-testid=bmm-title]")!.dispatchEvent(
          new MouseEvent("dblclick", { bubbles: true }),
        )
      );
      await waitFor(
        () => app.exists("[data-testid=bmm-edit-title]"),
        2000,
        "the name field",
      );
      await app.page.keyboard.type("Renamed");
      await app.press("Enter");
      await waitFor(
        async () => (await rows())[0] === "Renamed",
        2000,
        "renamed",
      );
      assertEquals(await barTitles(app, web), ["Renamed"], "the bar follows");

      // Delete it (the row picked, Delete), then Undo in the toast.
      await app.click("[data-testid=bmm-row]");
      await app.click("[data-testid=bmm-delete]");
      await waitFor(async () => (await rows()).length === 0, 2000, "deleted");
      assertEquals(await barTitles(app, web), []);
      assert(await app.exists("[data-testid=bmm-toast]"));
      await app.click("[data-testid=bmm-undo]");
      await waitFor(async () => (await rows())[0] === "Renamed", 2000, "back");
      assertEquals(await barTitles(app, web), ["Renamed"]);
      assertEquals(await app.exists("[data-testid=bmm-toast]"), false);

      // Search finds it; Escape clears the search, then closes the manager.
      await app.click("[data-testid=bmm-search]");
      await app.page.keyboard.type("nothing-like-it");
      await waitFor(
        () => app.exists("[data-testid=bmm-empty]"),
        2000,
        "no match",
      );
      await app.press("Escape");
      await waitFor(
        async () => (await rows()).length === 1,
        2000,
        "the search cleared",
      );
      await app.press("Escape");
      await waitFor(
        async () => !(await app.exists("[data-testid=bm-manager]")),
        2000,
        "the manager closed",
      );
    });
  });

  test("Settings → Links → Show bookmarks bar hides the bar", async (app) => {
    await withPages(async (pages) => {
      const { web } = await openPageA(app, pages);
      assert(await app.exists(`${tileSel(web)} [data-testid=bm-bar]`));
      await app.openSettings("links");
      await app.eval(() =>
        document.querySelector<HTMLInputElement>(
          "[data-testid=setting-links-bookmarks-bar]",
        )!.click()
      );
      await waitFor(
        async () => (await app.settings()).links?.bookmarksBar === false,
        2000,
        "the setting saved",
      );
      await app.closeSettings();
      assertEquals(
        await app.exists(`${tileSel(web)} [data-testid=bm-bar]`),
        false,
      );
    });
  });

  test("browser keys over a web tile: ⌘L, ⌘[ back, ⌘= zooms the page, not the font", async (app) => {
    await withPages(async (pages) => {
      const { web, a } = await openAThenB(app, pages);

      // ⌘L: the address field, its text selected.
      await focusBody(app, web);
      await app.shortcut("KeyL");
      await waitFor(
        async () => (await activeTestid(app)) === "web-address",
        2000,
        "⌘L",
      );
      assert(
        await app.eval(() => {
          const el = document.activeElement as HTMLInputElement;
          return el.selectionStart === 0 && el.selectionEnd === el.value.length;
        }),
        "selected",
      );

      // ⌘[: back (not the tile cycle).
      const mru = await app.mru();
      await focusBody(app, web);
      await app.shortcut("BracketLeft");
      await waitFor(
        async () => (await frameSrc(app, web)) === a,
        5000,
        "back to A",
      );
      assertEquals(await app.mru(), mru, "no cycle");
      assertEquals(await app.focusedId(), web);

      // ⌘=: the page zooms (the pill), the terminals' font stays.
      const font = (await app.settings()).fontSize;
      assertEquals(
        await app.exists(`${tileSel(web)} [data-testid=web-zoom]`),
        false,
      );
      await focusBody(app, web);
      await app.shortcut("Equal");
      await waitFor(
        async () =>
          (await app.eval(
            (sel: string) => document.querySelector(sel)?.textContent ?? null,
            `${tileSel(web)} [data-testid=web-zoom]`,
          )) === "110%",
        2000,
        "the zoom pill",
      );
      assertEquals(
        (await app.settings()).fontSize,
        font,
        "the font is unchanged",
      );
      // Remembered for the site.
      const zoom = await app.eval(() =>
        JSON.parse(localStorage.getItem("qutty.web-zoom.v1") ?? "null")
      );
      assertEquals(zoom.sites, { [new URL(pages.origin).host]: 1.1 });
      // ⌘0: back to 100%, the pill goes.
      await focusBody(app, web);
      await app.shortcut("Digit0");
      await waitFor(
        async () =>
          !(await app.exists(`${tileSel(web)} [data-testid=web-zoom]`)),
        2000,
        "100%",
      );
      // From a terminal, ⌘= zooms that tile (its indicator), not the page nor Settings' font.
      const term = (await app.tiles()).find((t) => t.id !== web)!.id;
      await app.focusChip(term);
      await app.shortcut("Equal");
      await waitFor(
        async () =>
          (await app.eval(
            (sel: string) => document.querySelector(sel)?.textContent ?? null,
            `${tileSel(term)} [data-testid=tile-zoom]`,
          )) === "110%",
        2000,
        "the terminal tile zoomed",
      );
      assertEquals((await app.settings()).fontSize, font);
      assertEquals(
        await app.exists(`${tileSel(web)} [data-testid=web-zoom]`),
        false,
        "the page stays at 100%",
      );
    });
  });

  test("the address field suggests visited pages", async (app) => {
    await withPages(async (pages) => {
      const { web, a, b } = await openAThenB(app, pages);

      await app.click(`${tileSel(web)} [data-testid=web-address]`);
      await waitFor(
        async () => (await activeTestid(app)) === "web-address",
        2000,
        "focused",
      );
      await app.page.keyboard.type("localhost");
      await waitFor(
        () => app.exists("[data-testid=web-suggest]"),
        2000,
        "suggestions",
      );
      const urls = await app.eval(() =>
        [...document.querySelectorAll<HTMLElement>(
          "[data-testid=web-suggest-row]",
        )]
          .map((el) => el.dataset.url)
      );
      assertEquals(new Set(urls), new Set([a, b]));
      // ↓ picks the first; Enter goes there.
      const first = urls[0]!;
      await app.press("ArrowDown");
      await app.press("Enter");
      await waitFor(
        async () => (await frameSrc(app, web)) === first,
        5000,
        first,
      );
      assertEquals(await app.exists("[data-testid=web-suggest]"), false);

      // Escape closes the list and keeps the text; a second Escape leaves the field.
      await app.click(`${tileSel(web)} [data-testid=web-address]`);
      await app.page.keyboard.type("local");
      await waitFor(
        () => app.exists("[data-testid=web-suggest]"),
        2000,
        "suggestions",
      );
      await app.press("Escape");
      await waitFor(
        async () => !(await app.exists("[data-testid=web-suggest]")),
        2000,
        "closed",
      );
      assertEquals(await activeTestid(app), "web-address");
      await app.press("Escape");
      await waitFor(
        async () => (await activeTestid(app)) === "web-body",
        2000,
        "left",
      );
    });
  });
});
