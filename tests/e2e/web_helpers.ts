// What the web tile suites share (tests/e2e/web_tile_test.ts, tests/e2e/web_browser_test.ts):
// the test site, a web tile opened from a ⌘-clicked URL, the address field, and waiting for a
// page to load. The frame is cross-origin: what the tile asked for is its frame's `src`; what
// loaded is the site's request log.

import { type App, serveWebPages, waitFor, type WebPages } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { hover, modClick } from "./link_helpers.ts";

/** Run `fn` with the test site up. */
export async function withPages(fn: (pages: WebPages) => Promise<void>) {
  const pages = await serveWebPages();
  try {
    await fn(pages);
  } finally {
    await pages.close();
  }
}

/** Print `url` in the focused terminal; returns the terminal's id once it is on screen. */
export async function printUrl(app: App, url: string): Promise<string> {
  const id = (await app.focusedId())!;
  await app.run(id, `echo ${url}`);
  await app.settle();
  await hover(app, id, url, url);
  return id;
}

/** The web tile (`data-web`) that is not in `before`, once it is the focused tile. */
export async function newWebTile(app: App, before: string[]): Promise<string> {
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
export const frameSrc = (app: App, id: string) =>
  app.attr(`${tileSel(id)} [data-testid=web-frame]`, "src");

/** Wait for web tile `id`'s frame to ask for `url`, and the site to have served `path`. */
export async function shows(
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
export async function goTo(app: App, id: string, text: string): Promise<void> {
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
export async function openPageA(
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
