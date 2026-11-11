// Web tiles against the demo backend and a tiny local site (`serveWebPages`, on its own port so
// it is a dev host the iframe engine shows, never the app's own origin): ⌘-click (Ctrl-click off
// macOS) on a localhost URL opens a web tile beside its terminal, the right-click menu's choices,
// the toolbar (address, back, forward, reload, open in the default browser), a page the engine
// cannot show, the workspace coming back with the tile at its last page, the setting, and closing.
//
// The frame is cross-origin: neither the app nor the test can look inside it. What the tile
// asked for is its frame's `src`; what loaded is the site's request log.

import { assert, assertEquals } from "@std/assert";
import {
  type App,
  serveWebPages,
  suite,
  waitFor,
  type WebPages,
} from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import {
  hover,
  linkCalls,
  menuActions,
  modClick,
  pointOf,
  rightClick,
} from "./link_helpers.ts";

/** Run `fn` with the test site up. */
async function withPages(fn: (pages: WebPages) => Promise<void>) {
  const pages = await serveWebPages();
  try {
    await fn(pages);
  } finally {
    await pages.close();
  }
}

/** Print `url` in the focused terminal; returns the terminal's id once it is on screen. */
async function printUrl(app: App, url: string): Promise<string> {
  const id = (await app.focusedId())!;
  await app.run(id, `echo ${url}`);
  await app.settle();
  await hover(app, id, url, url);
  return id;
}

/** The web tile (`data-web`) that is not in `before`, once it is the focused tile. */
async function newWebTile(app: App, before: string[]): Promise<string> {
  return await waitFor(
    () =>
      app.eval((known: string[]) => {
        const el = document.querySelector<HTMLElement>(
          "[data-testid=tile][data-web=true][data-focused=true]",
        );
        const id = el?.dataset.id;
        return id && !known.includes(id) ? id : null;
      }, before),
    5000,
    "a new focused web tile",
  );
}

/** The `src` of web tile `id`'s frame (`null`: no frame). */
const frameSrc = (app: App, id: string) =>
  app.attr(`${tileSel(id)} [data-testid=web-frame]`, "src");

/** Wait for web tile `id`'s frame to ask for `url`, and the site to have served `path`. */
async function shows(
  app: App,
  pages: WebPages,
  id: string,
  url: string,
): Promise<void> {
  await waitFor(async () => (await frameSrc(app, id)) === url, 5000, `${url}`);
  const path = new URL(url).pathname;
  await waitFor(() => pages.hits.includes(path), 5000, `${path} served`);
  await waitFor(
    async () =>
      (await app.attr(`${tileSel(id)} [data-testid=web-body]`, "data-load")) ===
        "complete",
    5000,
    `${url} loaded`,
  );
}

/** Type `text` into web tile `id`'s address field and press Enter. */
async function goTo(app: App, id: string, text: string): Promise<void> {
  await app.click(`${tileSel(id)} [data-testid=web-address]`);
  await waitFor(
    () =>
      app.eval(
        (sel: string) => document.activeElement === document.querySelector(sel),
        `${tileSel(id)} [data-testid=web-address]`,
      ),
    2000,
    "the address field focused",
  );
  // Its text is selected on focus: typing replaces it.
  await app.page.keyboard.type(text);
  await app.press("Enter");
}

/** ⌘-click a printed `<site>/a`: the terminal, the web tile it opened (showing it), the URL. */
async function openPageA(
  app: App,
  pages: WebPages,
): Promise<{ term: string; web: string; url: string }> {
  const url = `${pages.origin}/a`;
  const term = await printUrl(app, url);
  await modClick(app, term, url);
  const web = await newWebTile(app, [term]);
  await shows(app, pages, web, url);
  return { term, web, url };
}

/** Wait until the default browser was asked for exactly `urls`. */
async function browserOpened(app: App, urls: string[]): Promise<void> {
  await waitFor(
    async () => (await linkCalls(app)).length === urls.length,
    3000,
    "the browser",
  );
  assertEquals(await linkCalls(app), urls.map((url) => ({ kind: "url", url })));
}

const disabled = (app: App, id: string, testid: string) =>
  app.eval(
    (sel: string) => document.querySelector<HTMLButtonElement>(sel)!.disabled,
    `${tileSel(id)} [data-testid=${testid}]`,
  );

suite("web tiles", (test) => {
  test("⌘-click on a localhost URL opens a web tile beside its terminal", async (app) => {
    await withPages(async (pages) => {
      const { term, web } = await openPageA(app, pages);
      // Beside the terminal it came from: the new tile first, the terminal next.
      assertEquals(await app.mru(), [web, term]);
      assertEquals((await app.chips()).length, 2);
      // A cross-origin page's title cannot be read: the header shows the host.
      assertEquals(
        await app.eval(
          (sel: string) => document.querySelector(sel)!.textContent,
          `${tileSel(web)} [data-testid=tile-title]`,
        ),
        new URL(pages.origin).host,
      );
      assertEquals(
        await app.attr(`${tileSel(web)} [data-testid=web-frame]`, "sandbox"),
        "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads",
      );
      assertEquals(
        await app.attr(
          `${tileSel(web)} [data-testid=web-frame]`,
          "referrerpolicy",
        ),
        "no-referrer",
      );
      assertEquals(await linkCalls(app), [], "nothing went to the browser");
      await app.settle();
      await app.assertLayoutMatches();
    });
  });

  test("right-click: Open in Qutty tile, Open in default browser, Copy", async (app) => {
    await withPages(async (pages) => {
      const url = `${pages.origin}/a`;
      const term = await printUrl(app, url);
      await rightClick(app, await pointOf(app, term, url));
      assertEquals(await menuActions(app), ["tile", "browser", "copy"]);
      await app.click('[data-testid=link-menu-item][data-action="browser"]');
      await browserOpened(app, [url]);

      // Open in Qutty tile.
      await hover(app, term, url, url);
      await rightClick(app, await pointOf(app, term, url));
      await app.click('[data-testid=link-menu-item][data-action="tile"]');
      const web = await newWebTile(app, [term]);
      await shows(app, pages, web, url);
      assertEquals((await linkCalls(app)).length, 1, "only the first one");
    });
  });

  test("the toolbar: address, back, forward, reload, open in the browser", async (app) => {
    await withPages(async (pages) => {
      const { term, web, url: a } = await openPageA(app, pages);
      const b = `${pages.origin}/b`;
      assert(await disabled(app, web, "web-back"));
      assert(await disabled(app, web, "web-forward"));

      // A bare host and port gets http://.
      await goTo(app, web, `${new URL(pages.origin).host}/b`);
      await shows(app, pages, web, b);
      assertEquals(
        await app.eval(
          (sel: string) => document.querySelector<HTMLInputElement>(sel)!.value,
          `${tileSel(web)} [data-testid=web-address]`,
        ),
        b,
      );
      assert(!(await disabled(app, web, "web-back")));

      await app.click(`${tileSel(web)} [data-testid=web-back]`);
      await waitFor(async () => (await frameSrc(app, web)) === a, 3000, "back");
      assert(!(await disabled(app, web, "web-forward")));
      await app.click(`${tileSel(web)} [data-testid=web-forward]`);
      await waitFor(
        async () => (await frameSrc(app, web)) === b,
        3000,
        "forward",
      );
      await shows(app, pages, web, b);

      const served = pages.hits.filter((p) => p === "/b").length;
      await app.click(`${tileSel(web)} [data-testid=web-reload]`);
      await waitFor(
        () => pages.hits.filter((p) => p === "/b").length === served + 1,
        3000,
        "reloaded",
      );

      // A slow page shows Stop while it loads; Stop ends the load.
      await goTo(app, web, `${pages.origin}/slow?ms=4000`);
      await waitFor(
        () => app.exists(`${tileSel(web)} [data-testid=web-stop]`),
        3000,
        "Stop while loading",
      );
      await app.click(`${tileSel(web)} [data-testid=web-stop]`);
      await waitFor(
        () => app.exists(`${tileSel(web)} [data-testid=web-reload]`),
        3000,
        "Reload again",
      );

      await app.click(`${tileSel(web)} [data-testid=web-external]`);
      await browserOpened(app, [`${pages.origin}/slow?ms=4000`]);
    });
  });

  test("a page the engine cannot show offers the default browser", async (app) => {
    await withPages(async (pages) => {
      const { web, url: a } = await openPageA(app, pages);
      await goTo(app, web, "deno.com");
      await waitFor(
        () => app.exists(`${tileSel(web)} [data-testid=web-notice]`),
        3000,
        "the notice",
      );
      assertEquals(await frameSrc(app, web), null, "no frame for it");
      await app.click(`${tileSel(web)} [data-testid=web-notice-open]`);
      await browserOpened(app, ["https://deno.com/"]);
      // Back to a page it can show: a frame again.
      await goTo(app, web, a);
      await shows(app, pages, web, a);
    });
  });

  test("restore: the web tile comes back at its last page when the window reopens", async (app) => {
    await withPages(async (pages) => {
      const { term, web, url: a } = await openPageA(app, pages);
      const b = `${pages.origin}/b`;
      await goTo(app, web, b);
      await shows(app, pages, web, b);
      const mru = await app.mru();
      // Let the snapshot save (it is debounced).
      await new Promise((r) => setTimeout(r, 600));
      const before = pages.hits.filter((p) => p === "/b").length;

      // The demo's stand-in for closing the window and opening it again (the demo session lives
      // in the page, so a real reload starts a new workspace; the desktop app keeps it).
      await app.eval(() =>
        (globalThis as unknown as { __e2eRemount(): void }).__e2eRemount()
      );
      await waitFor(
        async () => (await app.count("[data-testid=chip]")) === 2,
        5000,
        "2 tiles after the remount",
      );
      await waitFor(
        () => app.exists(`${tileSel(web)}[data-web=true]`),
        3000,
        "the web tile back",
      );
      await waitFor(
        () => pages.hits.filter((p) => p === "/b").length === before + 1,
        5000,
        "its page loaded again",
      );
      await shows(app, pages, web, b);
      assertEquals(await app.mru(), mru);
      assertEquals(await app.focusedId(), web);
      // The terminal is back on its shell too, and no shell was killed.
      assertEquals(await app.kills(), []);
      assert((await app.terminal(term))?.ptyId);
    });
  });

  test("Settings → Links → Default browser: ⌘-click opens the browser", async (app) => {
    await withPages(async (pages) => {
      await app.openSettings();
      await app.eval(() => {
        const el = document.querySelector<HTMLSelectElement>(
          "[data-testid=setting-links-web]",
        )!;
        el.value = "browser";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await waitFor(
        async () => (await app.settings()).links?.web === "browser",
        2000,
        "the setting saved",
      );
      await app.closeSettings();
      const url = `${pages.origin}/a`;
      const term = await printUrl(app, url);
      await modClick(app, term, url);
      await browserOpened(app, [url]);
      assertEquals((await app.chips()).length, 1, "no web tile");
    });
  });

  test("a click inside the page focuses its tile and leaves the page the keyboard", async (app) => {
    await withPages(async (pages) => {
      const { term, web } = await openPageA(app, pages);
      await app.focusChip(term);
      await waitFor(() => app.xtermHasFocus(term), 3000, "the terminal");
      await app.settle();
      const box =
        (await app.rectOf(`${tileSel(web)} [data-testid=web-frame]`))!;
      // The click never reaches Qutty's page (the frame is cross-origin): the window losing
      // focus to the frame is what focuses the tile.
      await app.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await waitFor(
        async () => (await app.focusedId()) === web,
        3000,
        "the web tile focused",
      );
      // And the focus stays in the page (the tile does not pull it back to its body).
      await new Promise((r) => setTimeout(r, 300));
      assertEquals(
        await app.eval(() => document.activeElement?.tagName),
        "IFRAME",
      );
    });
  });

  test("closing a web tile gives the keyboard back to the terminal", async (app) => {
    await withPages(async (pages) => {
      const { term, web } = await openPageA(app, pages);
      // The web tile has the keyboard (its body, so the shortcuts still work).
      await waitFor(
        () =>
          app.eval(
            (sel: string) =>
              document.querySelector(sel)!.contains(document.activeElement),
            tileSel(web),
          ),
        2000,
        "the web tile focused",
      );
      await app.click(`${tileSel(web)} [data-testid=tile-close]`);
      await waitFor(
        async () => !(await app.exists(tileSel(web))),
        3000,
        "the tile gone",
      );
      assertEquals(await app.focusedId(), term);
      await waitFor(
        () => app.xtermHasFocus(term),
        3000,
        "the terminal focused",
      );
      assertEquals(await app.kills(), [], "no PTY was killed for it");
      assertEquals((await app.chips()).length, 1);
    });
  });
});
