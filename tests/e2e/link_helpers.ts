// Clicking links in a terminal from the e2e suite: where a piece of text is on screen, hovering
// it, ⌘-clicking it (Ctrl-click off macOS), right-clicking it, and what the backend was asked to
// open (the spy in lib/test-hooks.ts). Used by links_test.ts and web_tile_test.ts.

import { assert } from "@std/assert";
import { type App, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";

interface LinkState {
  hovered: string | null;
  underline: boolean;
  pointer: boolean;
}

export const linkState = (app: App, id: string) =>
  app.eval(
    (i: string) =>
      (globalThis as unknown as {
        __e2e: { linkState(id: string): LinkState | null };
      }).__e2e.linkState(i),
    id,
  );

// deno-lint-ignore no-explicit-any
export const linkCalls = (app: App): Promise<any[]> =>
  app.eval(() => // deno-lint-ignore no-explicit-any
  [...(globalThis as any).__e2e.links]);

/**
 * The viewport point of the middle of `needle`'s second cell on screen in terminal `id`, and
 * the cell height.
 */
export async function pointOf(
  app: App,
  id: string,
  needle: string,
): Promise<{ x: number; y: number; cellH: number }> {
  const state = await app.terminal(id);
  assert(state, "terminal state");
  const lines = state.text.split("\n");
  const row = lines.findIndex((l) => l.includes(needle));
  assert(row >= 0, `"${needle}" on screen`);
  assert(row < state.rows, `"${needle}" in the first screen (no scrollback)`);
  const col = lines[row].indexOf(needle) + 1;
  const box = await app.eval((sel: string) => {
    const r = document.querySelector(`${sel} .xterm-screen`)!
      .getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, tileSel(id));
  return {
    x: box.x + (col + 0.5) * (box.w / state.cols),
    y: box.y + (row + 0.5) * (box.h / state.rows),
    cellH: box.h / state.rows,
  };
}

/** Run `links` in the focused terminal and return its id. */
export async function printLinks(app: App): Promise<string> {
  const id = (await app.focusedId())!;
  await app.run(id, "links");
  await app.waitForText(id, /not links: 1\.2\.3/);
  // The first tile grows into place after boot: measure cells once it is still (a resize also
  // makes xterm drop the link under the pointer).
  await app.settle();
  return id;
}

/** Hover `needle` until the link under the pointer is `text` (`null`: no link there). */
export async function hover(
  app: App,
  id: string,
  needle: string,
  text: string | null,
): Promise<void> {
  const pt = await pointOf(app, id, needle);
  // From the row above: xterm asks for a row's links once per row it enters, and drops the
  // answer for a move that entered the terminal.
  await app.page.mouse.move(pt.x, pt.y - pt.cellH);
  await app.page.mouse.move(pt.x, pt.y);
  await waitFor(
    async () => (await linkState(app, id))?.hovered === text,
    3000,
    `hovering ${needle} → ${text}`,
  );
}

/** Wait for `n` link calls (the failure says which arrived). */
export async function callCount(app: App, n: number): Promise<void> {
  try {
    await waitFor(
      async () => (await linkCalls(app)).length === n,
      3000,
      `${n}`,
    );
  } catch {
    throw new Error(
      `expected ${n} link calls: ${JSON.stringify(await linkCalls(app))}`,
    );
  }
}

/** Wait for the link menu and return its items' actions. */
export async function menuActions(app: App): Promise<(string | undefined)[]> {
  await waitFor(() => app.exists("[data-testid=link-menu]"), 2000, "menu");
  return await app.eval(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=link-menu-item]")]
      .map((el) => el.dataset.action)
  );
}

export async function rightClick(app: App, pt: { x: number; y: number }) {
  await app.page.mouse.move(pt.x, pt.y);
  await app.page.mouse.down({ button: "right" });
  await app.page.mouse.up({ button: "right" });
}

export async function modClick(
  app: App,
  id: string,
  needle: string,
): Promise<void> {
  const pt = await pointOf(app, id, needle);
  await app.page.keyboard.down(app.mod);
  // Click only once the app has seen the modifier (the link is underlined): a click that beats
  // the keydown is a plain click.
  await waitFor(
    async () => (await linkState(app, id))?.underline === true,
    2000,
    `${needle} underlined with the modifier held`,
  );
  await app.page.mouse.click(pt.x, pt.y);
  await app.page.keyboard.up(app.mod);
}
