// Per-tile zoom (lib/workspace/tile-zoom.ts): Mod+= / Mod+- / Mod+0 zoom only the focused
// terminal tile (its font over Settings' size, its grid and PTY refitted), the indicator on a
// tile not at 100% resets it, Settings' font size is left alone, and "Zoom all tiles together"
// zooms every tile at once and gives each its own zoom back when turned off.

import { assert, assertEquals, assertLess } from "@std/assert";
import { DEFAULT_FONT_SETTINGS } from "../../lib/workspace/fonts.ts";
import { type App, suite, type TerminalState, waitFor } from "./harness.ts";
import { ptyAgrees, settledGrid } from "./grid_helpers.ts";

const BASE = DEFAULT_FONT_SETTINGS.fontSize;
const tileSel = (id: string) => `[data-testid=tile][data-id="${id}"]`;

/** Wait until xterm in `id` is at `size` px. */
function fontOf(app: App, id: string, size: number): Promise<TerminalState> {
  return waitFor(
    async () => {
      const s = await app.terminal(id);
      return s && s.fontSize === size ? s : null;
    },
    5000,
    `${id} at ${size}px`,
  );
}

/** Tile `id`'s zoom indicator text (`null`: none shown). */
function indicator(app: App, id: string): Promise<string | null> {
  return app.eval(
    (sel: string) => document.querySelector(sel)?.textContent ?? null,
    `${tileSel(id)} [data-testid=tile-zoom]`,
  );
}

suite("tile zoom", (test) => {
  test("Mod+= / Mod+- / Mod+0 zoom only the focused terminal; the indicator resets it", async (app) => {
    const [first, second] = await app.ensureTerminals(2);
    await app.focusChip(second);
    const base = await settledGrid(app, second);
    const firstBase = await settledGrid(app, first);
    await app.focusTerminalInput(second);
    const lineBefore = await app.lastLine(second);

    await app.shortcut("Equal");
    await app.shortcut("Equal", { shift: true });
    // 125% of 13px.
    await fontOf(app, second, 16);
    await waitFor(
      async () => (await indicator(app, second)) === "125%",
      3000,
      "the 125% indicator",
    );
    const big = await settledGrid(app, second);
    assertLess(big.cols, base.cols, "fewer columns at the bigger font");
    await ptyAgrees(app, second);
    // The other tile and Settings' font are untouched.
    assertEquals((await app.terminal(first))!.fontSize, BASE);
    assertEquals(await indicator(app, first), null);
    assertEquals((await app.settings()).fontSize, BASE);
    assertEquals(
      [(await app.terminal(first))!.cols, (await app.terminal(first))!.rows],
      [firstBase.cols, firstBase.rows],
    );

    await app.shortcut("Minus");
    await fontOf(app, second, 14);
    assertEquals(await indicator(app, second), "110%");

    // The indicator: back to 100%, and it goes.
    await app.click(`${tileSel(second)} [data-testid=tile-zoom]`);
    await fontOf(app, second, BASE);
    await waitFor(
      async () => (await indicator(app, second)) === null,
      2000,
      "no indicator at 100%",
    );

    // Mod+0 from a zoomed-out tile.
    await app.focusTerminalInput(second);
    await app.shortcut("Minus");
    await app.shortcut("Minus");
    await waitFor(
      async () => (await indicator(app, second)) === "80%",
      2000,
      "80%",
    );
    await app.shortcut("Digit0");
    await fontOf(app, second, BASE);
    await settledGrid(app, second);
    await ptyAgrees(app, second);
    assertEquals(
      await app.lastLine(second),
      lineBefore,
      "no = - + 0 reached the shell",
    );
    assert(await app.xtermHasFocus(second), "xterm keeps the keyboard");
  });

  test("each tile keeps its own zoom when the focus moves", async (app) => {
    const [first, second] = await app.ensureTerminals(2);
    await app.focusChip(first);
    await app.focusTerminalInput(first);
    await app.shortcut("Equal");
    await fontOf(app, first, 14);
    await app.focusChip(second);
    await app.focusTerminalInput(second);
    await app.shortcut("Minus");
    await fontOf(app, second, 12);
    assertEquals((await app.terminal(first))!.fontSize, 14);
    assertEquals(await indicator(app, first), "110%");
    assertEquals(await indicator(app, second), "90%");
    // Settings' size applies under each tile's zoom.
    await app.openSettings("appearance");
    await app.eval(() => {
      const el = document.querySelector<HTMLInputElement>(
        "[data-testid=setting-fontSize]",
      )!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(el, "20");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await fontOf(app, first, 22);
    await fontOf(app, second, 18);
  });

  test("Zoom all tiles together: one level for every tile; off gives each its own back", async (app) => {
    const [first, second] = await app.ensureTerminals(2);
    await app.focusChip(first);
    await app.focusTerminalInput(first);
    await app.shortcut("Equal");
    await fontOf(app, first, 14);

    await app.openSettings("appearance");
    await app.click("[data-testid=setting-zoom-together]");
    await waitFor(
      async () => (await app.settings()).zoomTogether === true,
      2000,
      "the setting on",
    );
    // The shared level is 100%: the first tile's own zoom steps aside.
    await fontOf(app, first, BASE);
    await app.closeSettings();

    await app.focusChip(second);
    await app.focusTerminalInput(second);
    await app.shortcut("Equal");
    await app.shortcut("Equal");
    await fontOf(app, second, 16);
    await fontOf(app, first, 16);
    assertEquals(await indicator(app, first), "125%");
    assertEquals(await indicator(app, second), "125%");
    assertEquals((await app.settings()).sharedZoom, 1.25);
    // A new tile starts at the shared level.
    const third = await app.newTerminal();
    await fontOf(app, third, 16);

    // The indicator resets the shared level.
    await app.click(`${tileSel(first)} [data-testid=tile-zoom]`);
    await fontOf(app, second, BASE);
    await fontOf(app, third, BASE);

    // Off: the first tile's own 110% is back.
    await app.openSettings("appearance");
    await app.click("[data-testid=setting-zoom-together]");
    await fontOf(app, first, 14);
    assertEquals(await indicator(app, first), "110%");
    assertEquals(await indicator(app, second), null);
  });
});
