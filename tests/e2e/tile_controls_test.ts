// The tiles' window controls on the demo backend: Minimize, Maximize and Restore in each header,
// the minimized chip that restores its tile, the "All tiles minimized" state, and a double click
// on a header (in the browser there is no OS preference to read: maximize / restore). A web tile
// keeping its page across minimize / restore is in web_tile_test.ts.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";

/** Wait for the pattern to be `pattern`. */
const patternIs = (app: App, pattern: string) =>
  waitFor(async () => (await app.pattern()) === pattern, 3000, pattern);

/** Chip `id`'s info. */
const chip = async (app: App, id: string) =>
  (await app.chips()).find((c) => c.id === id)!;

/** Wait for tile `id` to be parked (minimized: out of the layout, still mounted). */
const parked = (app: App, id: string) =>
  waitFor(
    async () => (await app.attr(tileSel(id), "data-phase")) === "parked",
    3000,
    `${id} parked`,
  );

/** A real double click at the centre of `selector`. */
async function doubleClick(app: App, selector: string): Promise<void> {
  const r = await app.rectOf(selector);
  assert(r, selector);
  await app.page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, {
    count: 2,
  });
}

suite("tile window controls", (test) => {
  test("Minimize: the tile goes to the bar, its shell runs on, the focus stays", async (app) => {
    const [a, b, c] = await app.ensureTerminals(3);
    await app.settle();
    assertEquals(await app.focusedId(), c);
    // Minimize a tile that is not focused: the focus does not move to it first.
    await app.click(`${tileSel(a)} [data-testid=tile-minimize]`);
    await parked(app, a);
    assertEquals(await app.focusedId(), c);
    const ca = await chip(app, a);
    assertEquals([ca.minimized, ca.tiled], [true, false]);
    assertEquals(
      await app.attr(`[data-testid=chip][data-id="${a}"]`, "class"),
      "chip is-minimized",
    );
    assertEquals(await app.kills(), [], "its shell still runs");
    await app.settle();
    await app.assertLayoutMatches();
    // Minimize the focused tile: the next one in MRU order takes the focus (and the keyboard).
    await app.click(`${tileSel(c)} [data-testid=tile-minimize]`);
    await parked(app, c);
    assertEquals(await app.focusedId(), b);
    await waitFor(() => app.xtermHasFocus(b), 3000, "b has the keyboard");
    // ⌘] has nothing to cycle to: the minimized tiles are out of the cycle.
    await app.shortcut("BracketRight");
    assertEquals(await app.focusedId(), b);
  });

  test("a minimized chip restores its tile, focused (and leaves monocle)", async (app) => {
    const [a, , c] = await app.ensureTerminals(3);
    await app.click(`${tileSel(c)} [data-testid=tile-minimize]`);
    await parked(app, c);
    await app.focusChip(c);
    await waitFor(
      async () => !(await chip(app, c)).minimized,
      3000,
      "restored",
    );
    assert((await chip(app, c)).tiled);
    await waitFor(() => app.xtermHasFocus(c), 3000, "c has the keyboard");
    await app.settle();
    await app.assertLayoutMatches();
    // In monocle, restoring a minimized tile ends in the tiled layout.
    await app.click(`${tileSel(a)} [data-testid=tile-minimize]`);
    await parked(app, a);
    await app.shortcut("Enter");
    await patternIs(app, "monocle");
    await app.focusChip(a);
    await patternIs(app, "cascade");
    assertEquals(await app.focusedId(), a);
  });

  test("Maximize shows the tile alone; Restore brings the layout back", async (app) => {
    const [a, b] = await app.ensureTerminals(3);
    await app.setPatternViaSettings("grid");
    await app.closeSettings();
    await app.click(`${tileSel(a)} [data-testid=tile-maximize]`);
    await patternIs(app, "monocle");
    assertEquals(await app.focusedId(), a);
    assert(await app.exists(`${tileSel(a)} [data-testid=tile-restore]`));
    assert(!(await app.exists(`${tileSel(a)} [data-testid=tile-maximize]`)));
    assertEquals(
      await app.attr(`${tileSel(a)} [data-testid=tile-restore]`, "aria-label"),
      "Restore terminal",
    );
    await app.settle();
    await app.assertLayoutMatches();
    // Another tile picked from the bar while maximized is just focused (still alone).
    await app.focusChip(b);
    assertEquals(await app.pattern(), "monocle");
    await app.click(`${tileSel(b)} [data-testid=tile-restore]`);
    await patternIs(app, "grid");
    assertEquals(await app.focusedId(), b);
    assert(await app.exists(`${tileSel(b)} [data-testid=tile-maximize]`));
    await app.settle();
    await app.assertLayoutMatches();
  });

  test("minimizing every tile leaves a quiet empty state, the chips in the bar", async (app) => {
    const ids = await app.ensureTerminals(2);
    for (const id of ids) {
      await app.click(`${tileSel(id)} [data-testid=tile-minimize]`);
      await parked(app, id);
    }
    await waitFor(
      () => app.exists("[data-testid=all-minimized]"),
      3000,
      "the empty state",
    );
    assertEquals(
      await app.eval(() =>
        document.querySelector("[data-testid=all-minimized]")!.textContent
      ),
      "All tiles minimized",
    );
    assert(!(await app.exists("[data-testid=empty]")), "not 'No terminals'");
    assertEquals(await app.focusedId(), null);
    assertEquals((await app.chips()).map((c) => c.minimized), [true, true]);
    await app.focusChip(ids[0]);
    await waitFor(
      async () => !(await app.exists("[data-testid=all-minimized]")),
      3000,
      "the empty state gone",
    );
    await app.settle();
    await app.assertLayoutMatches();
  });

  test("double click on a header: maximize / restore; not on its buttons", async (app) => {
    const [a] = await app.ensureTerminals(2);
    await app.settle();
    await doubleClick(app, `${tileSel(a)} [data-testid=tile-title]`);
    await patternIs(app, "monocle");
    assertEquals(await app.focusedId(), a);
    await app.settle();
    await doubleClick(app, `${tileSel(a)} [data-testid=tile-title]`);
    await patternIs(app, "cascade");
    await app.settle();
    // A double click on Maximize is two clicks on its buttons (Maximize, then Restore in its
    // place), never a header double click on top.
    await doubleClick(app, `${tileSel(a)} [data-testid=tile-maximize]`);
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(await app.pattern(), "cascade");
  });

  test("minimized tiles come back minimized when the window reopens", async (app) => {
    const [a, b] = await app.ensureTerminals(2);
    await app.click(`${tileSel(a)} [data-testid=tile-minimize]`);
    await parked(app, a);
    // Let the snapshot save (debounced), then remount the workspace.
    await new Promise((r) => setTimeout(r, 600));
    await app.eval(() =>
      (globalThis as { __e2eRemount?: () => void }).__e2eRemount?.()
    );
    await waitFor(
      async () => (await app.chips()).length === 2,
      5000,
      "both chips back",
    );
    await waitFor(
      async () => (await chip(app, a))?.minimized === true,
      5000,
      "a still minimized",
    );
    assertEquals(await app.focusedId(), b);
    await parked(app, a);
  });
});
