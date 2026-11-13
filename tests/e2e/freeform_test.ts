// The free-form (MDI) view on the demo backend: switching views from the bar's View menu and
// Settings (no jump), moving a tile by its header and resizing it by its grips (real pointer
// drags), raising a tile on click, Maximize / Restore over the whole area, the arrange commands,
// minimize → chip → restore, the view and the rects across a remount, the Tiles list, and a
// terminal's PTY following a resize.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { press } from "./pointer_helpers.ts";
import type { Rect } from "../../lib/layout/mod.ts";
import { MDI_ITEM_IDS, tileItemId } from "../../lib/workspace/mdi-menu.ts";

/** Choose item `id` in the bar's layout menu (the View menu's model). */
async function menuItem(app: App, id: string): Promise<void> {
  await app.click("[data-testid=bar-pattern]");
  await app.click(`[data-testid=pattern-menu] [data-item="${id}"]`);
  await waitFor(
    async () => !(await app.exists("[data-testid=pattern-menu]")),
    2000,
    "the menu to close",
  );
}

const view = (app: App) => app.attr("[data-testid=app]", "data-view");

/** Switch to the free-form view and wait for it. */
async function freeform(app: App): Promise<void> {
  await menuItem(app, MDI_ITEM_IDS.viewFreeform);
  await waitFor(
    async () => (await view(app)) === "freeform",
    3000,
    "free-form",
  );
  await app.settle();
}

/** Tile `id`'s settled rect in the area. */
async function rectOf(app: App, id: string): Promise<Rect> {
  const rects = await app.tileRects();
  assert(rects[id], `${id} is shown`);
  return rects[id];
}

/** Each tile's stacking order (its z-index). */
const zOf = (app: App, id: string) =>
  app.eval(
    (s: string) => Number(document.querySelector<HTMLElement>(s)!.style.zIndex),
    tileSel(id),
  );

/** Drag from the centre of `selector` by (`dx`, `dy`) with the button held. */
async function dragBy(
  app: App,
  selector: string,
  dx: number,
  dy: number,
): Promise<void> {
  const r = await app.rectOf(selector);
  assert(r, selector);
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const hand = press(app, x, y);
  await hand.down();
  await hand.moveTo(x + dx, y + dy, 8);
  await hand.up();
  await app.settle();
}

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

function assertRect(got: Rect, want: Rect, msg = "") {
  for (const k of ["x", "y", "w", "h"] as const) {
    assert(near(got[k], want[k]), `${msg} ${k}: ${got[k]} vs ${want[k]}`);
  }
}

/** Wait for tile `id`'s rect to be `want` (±1px): a move, a maximize, a restore transition. */
async function becomes(app: App, id: string, want: Rect, msg: string) {
  let last: Rect | undefined;
  await waitFor(
    async () => {
      last = await rectOf(app, id);
      return (["x", "y", "w", "h"] as const).every((k) =>
        near(last![k], want[k])
      );
    },
    4000,
    msg,
  ).catch((e) => {
    throw new Error(
      `${e.message}: ${JSON.stringify(last)} vs ${JSON.stringify(want)}`,
    );
  });
}

/**
 * The window closed and opened again (`__e2eRemount`), once the snapshot is saved (debounced);
 * it comes back free-form.
 */
async function reopen(app: App): Promise<void> {
  await new Promise((r) => setTimeout(r, 600));
  await app.eval(() =>
    (globalThis as { __e2eRemount?: () => void }).__e2eRemount?.()
  );
  await waitFor(
    async () =>
      (await view(app)) === "freeform" &&
      (await app.count("[data-testid=tile][data-phase=shown]")) > 0,
    5000,
    "the workspace back, free-form",
  );
}

/** Wait for the shown tiles' rects to satisfy `ok` (an arrangement's transition), and return them. */
function arranged(
  app: App,
  what: string,
  ok: (r: Record<string, Rect>) => boolean,
): Promise<Record<string, Rect>> {
  return waitFor(
    async () => {
      const r = await app.tileRects();
      return ok(r) ? r : null;
    },
    4000,
    what,
  );
}

suite("free-form view", (test) => {
  test("switch views: no jump into free-form; Settings switches back to the layout", async (app) => {
    await app.ensureTerminals(3);
    const tiled = await app.tileRects();
    assertEquals(await view(app), "tiled");
    await freeform(app);
    const free = await app.tileRects();
    for (const [id, r] of Object.entries(tiled)) {
      assertRect(free[id], r, `tile ${id}`);
    }
    // The bar reads Free-form; Settings → Layout shows the workspace's view.
    assertEquals(
      await app.attr("[data-testid=bar-pattern]", "data-view"),
      "freeform",
    );
    await app.openSettings();
    assertEquals(
      await app.attr(
        '[data-testid=setting-view][data-value="freeform"]',
        "aria-checked",
      ),
      "true",
    );
    await app.click('[data-testid=setting-view][data-value="tiled"]');
    await app.closeSettings();
    await waitFor(async () => (await view(app)) === "tiled", 3000, "tiled");
    await app.assertLayoutMatches();
  });

  test("drag a header to move a tile; a click raises a tile behind; the buttons do not drag", async (app) => {
    const [a, , c] = await app.ensureTerminals(3);
    await freeform(app);
    await menuItem(app, MDI_ITEM_IDS.cascade);
    await app.settle();
    // Cascade: a at the back, c in front.
    assert((await zOf(app, a)) < (await zOf(app, c)));
    // A click on a's header (the part c does not cover) raises and focuses it.
    const ra = await rectOf(app, a);
    const base = await app.rectOf("[data-testid=tiles]");
    await app.clickAt(base!.x + ra.x + 40, base!.y + ra.y + 12);
    await waitFor(async () => (await app.focusedId()) === a, 3000, "a focused");
    await waitFor(
      async () => (await zOf(app, a)) > (await zOf(app, c)),
      3000,
      "a on top",
    );
    await waitFor(() => app.xtermHasFocus(a), 3000, "a has the keyboard");
    // Drag it by its title.
    await dragBy(app, `${tileSel(a)} [data-testid=tile-title]`, 90, 50);
    const moved = await rectOf(app, a);
    assertRect(moved, { ...ra, x: ra.x + 90, y: ra.y + 50 }, "moved");
    assert(await app.xtermHasFocus(a), "the drag kept the keyboard");
    // A drag that starts on a button does not move the tile.
    const r = await app.rectOf(`${tileSel(a)} [data-testid=tile-minimize]`);
    const hand = press(app, r!.x + r!.width / 2, r!.y + r!.height / 2);
    await hand.down();
    await hand.moveTo(r!.x + 200, r!.y + 120);
    // Released off the button: no click, no move.
    await hand.up();
    await app.settle();
    await becomes(app, a, moved, "not dragged from a button");
  });

  test("a header button on a tile behind acts on the first (held) click", async (app) => {
    const [a, b, c] = await app.ensureTerminals(3);
    await freeform(app);
    await menuItem(app, MDI_ITEM_IDS.cascade);
    await app.settle();
    assertEquals(await app.focusedId(), c);
    // a and b sit behind c; their headers show above it. A held press on a button must not
    // raise the tile first and lose the click.
    await app.slowClick(`${tileSel(b)} [data-testid=tile-maximize]`);
    await waitFor(
      () => app.exists(`${tileSel(b)}[data-maximized=true]`),
      3000,
      "b maximized on the first click",
    );
    await app.slowClick(`${tileSel(b)} [data-testid=tile-restore]`);
    await waitFor(
      async () => !(await app.exists(`${tileSel(b)}[data-maximized=true]`)),
      3000,
      "b restored",
    );
    await app.settle();
    await app.focusChip(c);
    await app.settle();
    await app.slowClick(`${tileSel(a)} [data-testid=tile-close]`);
    await waitFor(
      async () => !(await app.exists(tileSel(a))),
      3000,
      "a closed on the first click",
    );
    // The header's empty part still drags (and raises) the tile.
    const rb = await rectOf(app, b);
    await dragBy(app, `${tileSel(b)} [data-testid=tile-title]`, 20, 10);
    await becomes(app, b, { ...rb, x: rb.x + 20, y: rb.y + 10 }, "b dragged");
    assertEquals(await app.focusedId(), b);
  });

  test("resize from a corner and an edge; the minimum size holds; the PTY follows", async (app) => {
    const [a] = await app.ensureTerminals(1);
    await freeform(app);
    await app.waitForPrompt(a);
    const before = await rectOf(app, a);
    const grid = (await app.terminal(a))!;
    const resizes = (await app.resizes()).length;
    await dragBy(
      app,
      `${tileSel(a)} [data-testid=tile-grip][data-edge=se]`,
      -160,
      -90,
    );
    const smaller = await rectOf(app, a);
    assertRect(smaller, {
      ...before,
      w: before.w - 160,
      h: before.h - 90,
    }, "corner");
    // The PTY is resized to the smaller grid (once the fit lands).
    await waitFor(
      async () => {
        const t = (await app.terminal(a))!;
        const log = (await app.resizes()).slice(resizes);
        return t.cols < grid.cols && t.rows < grid.rows &&
          log.some((r) =>
            r.ptyId === t.ptyId && r.cols === t.cols && r.rows === t.rows
          );
      },
      5000,
      "the PTY to follow",
    );
    // From the west edge, far past the minimum: the minimum width, the right edge in place.
    const settings = await app.settings();
    await dragBy(
      app,
      `${tileSel(a)} [data-testid=tile-grip][data-edge=w]`,
      2000,
      0,
    );
    const min = await rectOf(app, a);
    assertEquals(min.w, settings.layout.minTileW);
    assert(near(min.x + min.w, smaller.x + smaller.w), "right edge fixed");
  });

  test("Maximize fills the area for one tile; Restore gives its rect back; the pattern stays", async (app) => {
    const [a, b] = await app.ensureTerminals(2);
    await freeform(app);
    const pattern = await app.pattern();
    const ra = await rectOf(app, a);
    await app.click(`${tileSel(a)} [data-testid=tile-maximize]`);
    await waitFor(
      () => app.exists(`${tileSel(a)} [data-testid=tile-restore]`),
      3000,
      "Restore offered",
    );
    const area = await app.clusterBounds();
    const gap = (await app.settings()).layout.gap;
    await becomes(app, a, {
      x: gap,
      y: gap,
      w: area.w - 2 * gap,
      h: area.h - 2 * gap,
    }, "maximized");
    assertEquals(await app.pattern(), pattern, "no monocle");
    assert((await app.tiles()).find((t) => t.id === b)!.phase === "shown");
    assert((await zOf(app, a)) > (await zOf(app, b)), "the others behind");
    // A maximized tile does not drag.
    await dragBy(app, `${tileSel(a)} [data-testid=tile-title]`, 80, 80);
    assertEquals((await rectOf(app, a)).x, gap);
    await app.click(`${tileSel(a)} [data-testid=tile-restore]`);
    await app.settle();
    await becomes(app, a, ra, "restored");
    // Mod+Enter maximizes / restores the focused tile here too.
    await app.shortcut("Enter");
    await waitFor(
      () => app.exists(`${tileSel(a)}[data-maximized=true]`),
      3000,
      "maximized by Mod+Enter",
    );
    assertEquals(await app.pattern(), pattern);
    await app.shortcut("Enter");
    await app.settle();
    await becomes(app, a, ra, "restored by Mod+Enter");
  });

  test("arrange: rows, columns and cascade; greyed in the tiled view", async (app) => {
    const [a, b, c] = await app.ensureTerminals(3);
    // Tiled: the arrange items are greyed.
    await app.click("[data-testid=bar-pattern]");
    assert(
      await app.eval(() =>
        document.querySelector<HTMLButtonElement>(
          '[data-item="qutty:arrange:cascade"]',
        )!.disabled
      ),
    );
    await app.click("[data-testid=bar-pattern]");
    await freeform(app);
    // Rows, the focused tile (c) on top, all full width.
    await menuItem(app, MDI_ITEM_IDS.tileHorizontally);
    await arranged(
      app,
      "rows top to bottom",
      (r) =>
        r[c].y < r[b].y && r[b].y < r[a].y && near(r[a].w, r[c].w) &&
        near(r[a].x, r[c].x),
    );
    await menuItem(app, MDI_ITEM_IDS.tileVertically);
    await arranged(
      app,
      "columns left to right",
      (r) =>
        r[c].x < r[b].x && r[b].x < r[a].x && near(r[a].h, r[c].h) &&
        near(r[a].y, r[c].y),
    );
    // Cascade in z-order: the front tile (c) lowest and rightmost, all one size.
    await menuItem(app, MDI_ITEM_IDS.cascade);
    const r = await arranged(
      app,
      "cascade",
      (r) =>
        r[a].x < r[b].x && r[b].x < r[c].x && r[a].y < r[b].y &&
        r[b].y < r[c].y && near(r[a].w, r[c].w) && near(r[a].h, r[c].h),
    );
    // The tiles stay free: a drag after an arrangement moves just that tile.
    await dragBy(app, `${tileSel(c)} [data-testid=tile-title]`, -40, 30);
    const after = await app.tileRects();
    assertRect(after[a], r[a], "a untouched");
  });

  test("minimize to a chip and restore in free-form: the tile comes back at its rect", async (app) => {
    const [a, b] = await app.ensureTerminals(2);
    await freeform(app);
    await menuItem(app, MDI_ITEM_IDS.cascade);
    await app.settle();
    await dragBy(app, `${tileSel(b)} [data-testid=tile-title]`, -20, -15);
    const rb = await rectOf(app, b);
    await app.click(`${tileSel(b)} [data-testid=tile-minimize]`);
    await waitFor(
      async () => (await app.attr(tileSel(b), "data-phase")) === "parked",
      3000,
      "parked",
    );
    assertEquals(await app.focusedId(), a);
    await app.focusChip(b);
    await app.settle();
    await becomes(app, b, rb, "back at its rect");
    assert((await zOf(app, b)) > (await zOf(app, a)), "on top");
  });

  test("the view and the rects come back when the window reopens; the Tiles list focuses", async (app) => {
    const [a, b] = await app.ensureTerminals(2);
    await freeform(app);
    await menuItem(app, MDI_ITEM_IDS.tileVertically);
    await app.settle();
    await dragBy(app, `${tileSel(a)} [data-testid=tile-title]`, -40, 0);
    const ra = await rectOf(app, a);
    await reopen(app);
    assertEquals((await app.chips()).length, 2);
    await app.settle();
    await becomes(app, a, ra, "a's rect");
    // The Tiles list: the focused tile checked; a click focuses another.
    await app.click("[data-testid=bar-pattern]");
    const focused = await app.focusedId();
    assertEquals(
      await app.attr(
        `[data-testid=tiles-item][data-item="${tileItemId(focused!)}"]`,
        "aria-checked",
      ),
      "true",
    );
    const other = focused === a ? b : a;
    await app.click(
      `[data-testid=tiles-item][data-item="${tileItemId(other)}"]`,
    );
    await waitFor(
      async () => (await app.focusedId()) === other,
      3000,
      "focused",
    );
  });

  test("Settings: the default view for new workspaces is saved; this workspace's stays", async (app) => {
    await app.ensureTerminals(1);
    await app.openSettings();
    await app.click(
      '[data-testid=setting-default-view][data-value="freeform"]',
    );
    await waitFor(
      async () => (await app.settings()).defaultView === "freeform",
      3000,
      "saved",
    );
    assertEquals(await view(app), "tiled");
  });
});
