// Tiles in place (Settings → Layout → "Focused tile moves to the main spot" off): focusing a tile
// does not move it, a header drag onto another tile swaps the two (Escape puts it back), a short
// header click still focuses, and the setting and the order survive a reload and a remount.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { Rect } from "../../lib/layout/mod.ts";
import { type App, suite, waitFor } from "./harness.ts";
import { press } from "./pointer_helpers.ts";

const tileSel = (id: string) => `[data-testid=tile][data-id="${id}"]`;

/** Turn the setting off (or on) through Settings → Layout. */
async function setFocusToMain(app: App, on: boolean): Promise<void> {
  await app.openSettings();
  const checked = await app.eval(
    () =>
      document.querySelector<HTMLInputElement>(
        "[data-testid=setting-focus-to-main]",
      )!.checked,
  );
  if (checked !== on) await app.click("[data-testid=setting-focus-to-main]");
  await waitFor(
    async () => (await app.settings()).focusToMain === on,
    2000,
    `focusToMain = ${on}`,
  );
  await app.closeSettings();
}

/** Four tiles with the setting off; their settled rects. */
async function fourInPlace(
  app: App,
): Promise<{ ids: string[]; rects: Record<string, Rect> }> {
  const ids = await app.ensureTerminals(4);
  await setFocusToMain(app, false);
  return { ids, rects: await app.tileRects() };
}

function assertSameRects(
  got: Record<string, Rect>,
  want: Record<string, Rect>,
  msg: string,
) {
  assertEquals(Object.keys(got).sort(), Object.keys(want).sort(), msg);
  for (const [id, r] of Object.entries(want)) {
    for (const k of ["x", "y", "w", "h"] as const) {
      assert(
        Math.abs(got[id][k] - r[k]) <= 1,
        `${msg}: ${id}.${k} ${got[id][k]} vs ${r[k]}`,
      );
    }
  }
}

/** A point on tile `id`'s header clear of its controls (just right of the title's start). */
async function headPoint(app: App, id: string) {
  const r = await app.rectOf(`${tileSel(id)} [data-testid=tile-title]`);
  assert(r, `${id} title`);
  return { x: r.x + Math.min(12, r.width / 2), y: r.y + r.height / 2 };
}

/**
 * The tiles' settled rects once no tile transition runs: right after a drop the tile's transition
 * back (or to its new slot) may not have moved yet, which `settle` alone can take for still.
 */
async function restingRects(app: App): Promise<Record<string, Rect>> {
  await waitFor(
    () =>
      app.eval(() =>
        !document.getAnimations().some((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target;
          return t instanceof Element &&
            t.matches("[data-testid=tile], [data-testid=tile-body]");
        })
      ),
    3000,
    "tile and body transitions to end",
  );
  return await app.tileRects();
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Viewport coordinates of a point in the tiles' container. */
async function toViewport(app: App, p: { x: number; y: number }) {
  const base = await app.rectOf("[data-testid=tiles]");
  return { x: base!.x + p.x, y: base!.y + p.y };
}

suite("tile order", (test) => {
  test("tile order: with the setting off, focusing tiles does not move them", async (app) => {
    const { ids, rects } = await fourInPlace(app);
    // The chips, a short header click and the keyboard: only the focus changes.
    await app.focusChip(ids[0]);
    // No relayout: no tile moves or resizes on the way either.
    assertEquals(
      await app.eval(() =>
        document.getAnimations().filter((a) =>
          a instanceof CSSTransition &&
          ["transform", "width", "height"].includes(a.transitionProperty) &&
          (a.effect as KeyframeEffect | null)?.target instanceof Element &&
          ((a.effect as KeyframeEffect).target as Element).matches(
            "[data-testid=tile]",
          )
        ).length
      ),
      0,
      "no tile transition on a focus change",
    );
    assertSameRects(await app.tileRects(), rects, "chip focus");
    await app.focusChip(ids[2]);
    assertSameRects(await app.tileRects(), rects, "chip focus");
    await app.shortcut("Backquote");
    await waitFor(
      async () => (await app.focusedId()) !== ids[2],
      2000,
      "the cycle to move the focus",
    );
    assertSameRects(await app.tileRects(), rects, "cycle");
    // Back on: the focused tile takes the main spot again.
    await app.focusChip(ids[1]);
    await setFocusToMain(app, true);
    await app.assertLayoutMatches();
    assertEquals((await app.mru())[0], ids[1]);
    app.assertNoErrors();
  });

  test("tile order: a short header click focuses the tile and moves nothing", async (app) => {
    const { ids, rects } = await fourInPlace(app);
    const other = (await app.focusedId()) === ids[0] ? ids[1] : ids[0];
    const p = await headPoint(app, other);
    const hand = press(app, p.x, p.y);
    await hand.down();
    await hand.moveTo(p.x + 2, p.y + 1, 2);
    await hand.up();
    await waitFor(
      async () => (await app.focusedId()) === other,
      2000,
      `${other} to be focused`,
    );
    await waitFor(() => app.xtermHasFocus(other), 2000, "keyboard focus");
    assertSameRects(await restingRects(app), rects, "after the click");
    app.assertNoErrors();
  });

  test("tile order: a header drag onto another tile swaps the two", async (app) => {
    const { ids, rects } = await fourInPlace(app);
    const [a, b] = [ids[0], ids[2]];
    const from = await headPoint(app, a);
    const to = await toViewport(app, center(rects[b]));
    const hand = press(app, from.x, from.y);
    await hand.down();
    await hand.moveTo(to.x, to.y, 10);
    // While it lasts: the dragged tile is lifted and the target marked.
    assert(
      await app.exists(`${tileSel(a)}.is-swap-dragging`),
      "the dragged tile",
    );
    assert(await app.exists(`${tileSel(b)}.is-swap-target`), "the target");
    await hand.up();
    await waitFor(
      () => app.exists(".is-swap-dragging, .is-swap-target").then((x) => !x),
      2000,
      "the drag to end",
    );
    const after = await restingRects(app);
    assertSameRects(
      { [a]: after[a], [b]: after[b] },
      { [a]: rects[b], [b]: rects[a] },
      "swapped",
    );
    for (const id of ids.filter((x) => x !== a && x !== b)) {
      assertSameRects({ [id]: after[id] }, { [id]: rects[id] }, "unmoved");
    }
    app.assertNoErrors();
  });

  test("tile order: Escape or a drop outside the tiles puts the tile back", async (app) => {
    const { ids, rects } = await fourInPlace(app);
    const [a, b] = [ids[1], ids[3]];
    const from = await headPoint(app, a);
    const to = await toViewport(app, center(rects[b]));
    let hand = press(app, from.x, from.y);
    await hand.down();
    await hand.moveTo(to.x, to.y, 8);
    assert(await app.exists(`${tileSel(b)}.is-swap-target`), "the target");
    await app.press("Escape");
    await waitFor(
      () => app.exists(".is-swap-dragging").then((x) => !x),
      2000,
      "Escape to end the drag",
    );
    await hand.up();
    assertSameRects(await restingRects(app), rects, "after Escape");
    // Released over the bar, not a tile.
    const bar = await app.rectOf("[data-testid=bar]");
    hand = press(app, from.x, from.y);
    await hand.down();
    await hand.moveTo(bar!.x + 4, bar!.y + bar!.height / 2, 8);
    await hand.up();
    assertSameRects(await restingRects(app), rects, "after a drop outside");
    app.assertNoErrors();
  });

  test("tile order: the setting survives a reload; the order survives a remount", async (app) => {
    const { ids, rects } = await fourInPlace(app);
    const [a, b] = [ids[0], ids[3]];
    const from = await headPoint(app, a);
    const to = await toViewport(app, center(rects[b]));
    const hand = press(app, from.x, from.y);
    await hand.down();
    await hand.moveTo(to.x, to.y, 8);
    await hand.up();
    const swapped = await restingRects(app);
    assertNotEquals(swapped[a], rects[a]);
    // Let the snapshot save (it is debounced), then close and reopen the window.
    await new Promise((r) => setTimeout(r, 600));
    await app.eval(() =>
      (globalThis as unknown as { __e2eRemount(): void }).__e2eRemount()
    );
    await waitFor(
      async () => (await app.count("[data-testid=chip]")) === 4,
      5000,
      "4 tiles after the remount",
    );
    assertSameRects(await app.tileRects(), swapped, "after the remount");
    await app.reload();
    assertEquals((await app.settings()).focusToMain, false);
    await app.openSettings();
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLInputElement>(
          "[data-testid=setting-focus-to-main]",
        )!.checked
      ),
      false,
    );
    app.assertNoErrors();
  });

  test("tile order: scaled inactive tiles keep the main tile's size; the focused one fits its own", async (app) => {
    await app.setInactiveTiles("scale");
    await app.closeSettings();
    const { ids, rects } = await fourInPlace(app);
    // The main slot is the biggest; focus a smaller one.
    const main = ids.reduce((m, id) =>
      rects[id].w * rects[id].h > rects[m].w * rects[m].h ? id : m
    );
    const small = ids.find((id) => id !== main)!;
    await app.focusChip(small);
    await restingRects(app);
    const bodies = await app.eval(() =>
      Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>(
          "[data-testid=tile][data-phase=shown]",
        )].map((tile) => {
          const body = tile.querySelector<HTMLElement>(
            "[data-testid=tile-body]",
          )!;
          const inner = tile.querySelector<HTMLElement>(".tile-inner")!;
          const head = tile.querySelector<HTMLElement>(".tile-head")!;
          return [tile.dataset.id!, {
            w: body.offsetWidth,
            h: body.offsetHeight,
            slotW: inner.clientWidth,
            slotH: inner.clientHeight - head.offsetHeight,
            transform: getComputedStyle(body).transform,
          }];
        }),
      )
    );
    const f = bodies[small];
    assertEquals(f.transform, "none");
    assertEquals(
      [f.w, f.h],
      [f.slotW, f.slotH],
      "the focused body fits its tile",
    );
    for (const id of ids.filter((x) => x !== small)) {
      assertEquals(
        [bodies[id].w, bodies[id].h],
        [bodies[main].slotW, bodies[main].slotH],
        `${id} at the main tile's size`,
      );
    }
    assertSameRects(await app.tileRects(), rects, "nothing moved");
    app.assertNoErrors();
  });
});
