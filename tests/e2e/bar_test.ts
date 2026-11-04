// The switcher bar: its own "+N" overflow, its four edges, and its two orders.

import { assert, assertEquals } from "@std/assert";
import { BAR_POSITIONS } from "../../lib/workspace/store.ts";
import { type App, type BoxRect, suite, waitFor } from "./harness.ts";

/** The chips the bar's strip clips, measured independently of the app. */
function clippedChipIds(app: App): Promise<string[]> {
  return app.eval(() => {
    const list = document.querySelector("[data-testid=chips]")!;
    const box = list.getBoundingClientRect();
    const vertical = list.closest("[data-testid=bar]")!.classList.contains(
      "is-vertical",
    );
    return [...document.querySelectorAll<HTMLElement>("[data-testid=chip]")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return vertical
          ? r.top < box.top - 1 || r.bottom > box.bottom + 1
          : r.left < box.left - 1 || r.right > box.right + 1;
      })
      .map((el) => el.dataset.id!);
  });
}

async function waitChipsStill(app: App): Promise<void> {
  // FLIP glides and the chip-in animation move chips for a few hundred ms: wait until no chip
  // animation is running and the rects hold still across two frames.
  await waitFor(
    () =>
      app.eval(() =>
        new Promise<boolean>((resolve) => {
          const chips = [
            ...document.querySelectorAll<HTMLElement>("[data-testid=chip]"),
          ];
          const running = document.getAnimations().some((a) =>
            a.playState === "running" &&
            chips.includes(
              (a.effect as KeyframeEffect | null)?.target as HTMLElement,
            )
          );
          // A FLIP inversion is pending until its frame clears the inline transform.
          if (running || chips.some((el) => el.style.transform !== "")) {
            return resolve(false);
          }
          const snap = () =>
            chips.map((el) => {
              const r = el.getBoundingClientRect();
              return `${r.x.toFixed(1)},${r.y.toFixed(1)}`;
            }).join("|");
          const a = snap();
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(
                a === snap() &&
                  !document.getAnimations().some((x) =>
                    chips.includes(
                      (x.effect as KeyframeEffect | null)
                        ?.target as HTMLElement,
                    )
                  ),
              )
            )
          );
        })
      ),
    4000,
    "chips to stop moving",
  );
}

function overlaps(a: BoxRect, b: BoxRect): boolean {
  return a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 &&
    b.y < a.bottom - 0.5;
}

async function assertBarOnEdge(app: App, position: string): Promise<void> {
  await waitFor(
    async () =>
      (await app.attr("[data-testid=bar]", "data-position")) === position,
    2000,
    `bar ${position}`,
  );
  const vp = await app.eval(() => ({ w: innerWidth, h: innerHeight }));
  const bar = (await app.rectOf("[data-testid=bar]"))!;
  const cluster = (await app.rectOf("[data-testid=cluster]"))!;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  switch (position) {
    case "top":
      assert(
        near(bar.y, 0) && near(bar.width, vp.w),
        `top bar ${JSON.stringify(bar)}`,
      );
      assert(cluster.y >= bar.bottom - 0.5, "cluster below the bar");
      break;
    case "bottom":
      assert(
        near(bar.bottom, vp.h) && near(bar.width, vp.w),
        `bottom bar ${JSON.stringify(bar)}`,
      );
      assert(cluster.bottom <= bar.y + 0.5, "cluster above the bar");
      break;
    case "left":
      assert(
        near(bar.x, 0) && near(bar.height, vp.h),
        `left bar ${JSON.stringify(bar)}`,
      );
      assert(cluster.x >= bar.right - 0.5, "cluster right of the bar");
      break;
    case "right":
      assert(
        near(bar.right, vp.w) && near(bar.height, vp.h),
        `right bar ${JSON.stringify(bar)}`,
      );
      assert(cluster.right <= bar.x + 0.5, "cluster left of the bar");
      break;
  }
  assert(!overlaps(bar, cluster), "bar and cluster do not overlap");
  // Every shown tile stays inside the cluster.
  const rects = await app.tileRects();
  const bounds = await app.clusterBounds();
  for (const [id, r] of Object.entries(rects)) {
    assert(
      r.x >= -0.5 && r.y >= -0.5 && r.x + r.w <= bounds.w + 0.5 &&
        r.y + r.h <= bounds.h + 0.5,
      `tile ${id} inside the cluster`,
    );
  }
}

async function assertChipStacking(app: App, vertical: boolean): Promise<void> {
  await waitChipsStill(app);
  const rects = await app.eval(() =>
    [...document.querySelectorAll("[data-testid=chip]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y };
    })
  );
  const dump = JSON.stringify(rects);
  for (let i = 1; i < rects.length; i++) {
    if (vertical) {
      assert(
        Math.abs(rects[i].x - rects[0].x) <= 1,
        `chips share a column: ${dump}`,
      );
      assert(rects[i].y > rects[i - 1].y, `chips stack downwards: ${dump}`);
    } else {
      assert(
        Math.abs(rects[i].y - rects[0].y) <= 1,
        `chips share a row: ${dump}`,
      );
      assert(rects[i].x > rects[i - 1].x, `chips run left to right: ${dump}`);
    }
  }
}

suite("bar", (test) => {
  // ---- The bar's own overflow ---------------------------------------------------------------

  test(
    "bar overflow: +N appears with the clipped count and its menu focuses",
    async (app) => {
      for (let i = 1; i < 16; i++) await app.newTerminal("shortcut");
      assertEquals((await app.chips()).length, 16);
      await waitChipsStill(app);
      await waitFor(
        () => app.exists("[data-testid=bar-more]"),
        3000,
        "the +N button",
      );
      let clipped: string[] = [];
      await waitFor(
        async () => {
          clipped = await clippedChipIds(app);
          const label = await app.eval(() =>
            document.querySelector("[data-testid=bar-more]")?.textContent ?? ""
          );
          return clipped.length > 0 && label === `+${clipped.length}`;
        },
        3000,
        "+N to equal the clipped chip count",
      );
      await app.click("[data-testid=bar-more]");
      await waitFor(
        () => app.exists("[data-testid=overflow-menu]"),
        2000,
        "the menu",
      );
      const listed = await app.eval(() =>
        [...document.querySelectorAll<HTMLElement>(
          "[data-testid=overflow-item]",
        )].map((el) => el.dataset.id!)
      );
      assertEquals(listed, clipped);
      const pick = listed.at(-1)!;
      await app.click(`[data-testid=overflow-item][data-id="${pick}"]`);
      await waitFor(
        async () => (await app.focusedId()) === pick,
        3000,
        `${pick} focused`,
      );
      assert(!(await app.exists("[data-testid=overflow-menu]")), "menu closes");
      await waitFor(() => app.xtermHasFocus(pick), 3000, "keyboard focus");
      await app.assertLayoutMatches();
      // The focused chip is in view (MRU order puts it first).
      await waitChipsStill(app);
      assert(!(await clippedChipIds(app)).includes(pick));
    },
    { width: 900, height: 700 },
  );

  test("bar overflow: no +N when every chip fits", async (app) => {
    await app.ensureTerminals(3);
    await waitChipsStill(app);
    assertEquals(await clippedChipIds(app), []);
    assert(!(await app.exists("[data-testid=bar-more]")));
  });

  test("bar overflow: the overflow menu closes on Escape", async (app) => {
    for (let i = 1; i < 12; i++) await app.newTerminal("shortcut");
    await waitFor(
      () => app.exists("[data-testid=bar-more]"),
      3000,
      "the +N button",
    );
    await app.click("[data-testid=bar-more]");
    await waitFor(
      () => app.exists("[data-testid=overflow-menu]"),
      2000,
      "the menu",
    );
    await app.press("Escape");
    await waitFor(
      async () => !(await app.exists("[data-testid=overflow-menu]")),
      2000,
      "closed",
    );
  }, { width: 700, height: 600 });

  // ---- Position -----------------------------------------------------------------------------

  test("position: every edge via settings", async (app) => {
    await app.ensureTerminals(3);
    for (const p of ["bottom", "left", "right", "top"]) {
      await app.setBarPosition(p);
      await assertBarOnEdge(app, p);
      await app.assertLayoutMatches();
    }
  });

  test("position: Mod+Shift+B cycles the edges", async (app) => {
    await app.ensureTerminals(2);
    let i = BAR_POSITIONS.indexOf("top");
    for (let n = 0; n < BAR_POSITIONS.length; n++) {
      await app.shortcut("KeyB", { shift: true });
      i = (i + 1) % BAR_POSITIONS.length;
      await assertBarOnEdge(app, BAR_POSITIONS[i]);
      await app.assertLayoutMatches();
    }
  });

  test("position: vertical bars stack chips vertically, horizontal ones in a row", async (app) => {
    await app.ensureTerminals(4);
    await assertChipStacking(app, false);
    await app.setBarPosition("left");
    await assertChipStacking(app, true);
    await app.setBarPosition("right");
    await assertChipStacking(app, true);
    await app.setBarPosition("bottom");
    await assertChipStacking(app, false);
  });

  // ---- Order --------------------------------------------------------------------------------

  test("order: recently used follows MRU after focus changes", async (app) => {
    const ids = await app.ensureTerminals(4);
    for (const id of [ids[1], ids[3], ids[0]]) {
      await app.focusChip(id);
      const domOrder = (await app.chips()).map((c) => c.id);
      assertEquals(domOrder, await app.mru());
      assertEquals(domOrder[0], id);
    }
    const ordinals = (await app.chips()).map((c) => c.ordinal);
    assertEquals(ordinals, [1, 2, 3, 4]);
  });

  test("order: opened keeps creation order whatever is focused", async (app) => {
    const ids = await app.ensureTerminals(4);
    await app.setBarOrder("created");
    await app.closeSettings();
    for (const id of [ids[2], ids[0], ids[3]]) {
      await app.focusChip(id);
      assertEquals((await app.chips()).map((c) => c.id), ids);
    }
    await app.setBarOrder("mru");
    assertEquals((await app.chips()).map((c) => c.id), await app.mru());
  });
});
