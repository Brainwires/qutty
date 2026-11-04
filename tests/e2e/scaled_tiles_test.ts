// Settings → Inactive tiles: `scale` keeps every terminal at the focused tile's size and shows the
// inactive ones scaled down, so focus changes never resize a PTY; `resize` (the default) is the
// old behaviour. PTY resizes are read from the backend spy (`window.__e2e.resizes`).

import { assert, assertEquals, assertGreater, assertLess } from "@std/assert";
import { tileBodySize } from "../../lib/layout/scale.ts";
import { type App, type PtyResize, suite, waitFor } from "./harness.ts";

interface BodyInfo {
  id: string;
  focused: boolean;
  /** The body's computed transform (`none` or a matrix). */
  transform: string;
  /** The x scale of that transform (1 for `none`). */
  scale: number;
  /** The body's layout size (untransformed). */
  w: number;
  h: number;
  /** The space the tile's chrome leaves for the body (inner box minus the header). */
  slotW: number;
  slotH: number;
  /** The body's inline style attribute (`""` when none). */
  inline: string;
  /** A click-catcher is displayed over the body. */
  catcher: boolean;
  scaledClass: boolean;
  transitionMs: number;
}

/** The terminal bodies of the shown tiles, once no body transform is animating. */
async function bodies(app: App): Promise<BodyInfo[]> {
  await app.settle();
  await waitFor(
    () =>
      app.eval(() =>
        !document.getAnimations().some((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target;
          return t instanceof Element && t.matches("[data-testid=tile-body]");
        })
      ),
    3000,
    "body transforms to settle",
  );
  return await app.eval(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[data-testid=tile][data-phase=shown]",
      ),
    ].map((tile) => {
      const body = tile.querySelector<HTMLElement>("[data-testid=tile-body]")!;
      const inner = tile.querySelector<HTMLElement>(".tile-inner")!;
      const head = tile.querySelector<HTMLElement>(".tile-head")!;
      const cs = getComputedStyle(body);
      const transform = cs.transform;
      return {
        id: tile.dataset.id!,
        focused: tile.dataset.focused === "true",
        transform,
        scale: transform === "none" ? 1 : new DOMMatrix(transform).a,
        w: body.offsetWidth,
        h: body.offsetHeight,
        slotW: inner.clientWidth,
        slotH: inner.clientHeight - head.offsetHeight,
        inline: body.getAttribute("style") ?? "",
        catcher: (() => {
          const c = tile.querySelector("[data-testid=tile-catcher]");
          return !!c && getComputedStyle(c).display !== "none";
        })(),
        scaledClass: tile.classList.contains("is-scaled"),
        transitionMs: parseFloat(cs.transitionDuration) * 1000,
      };
    })
  );
}

/** The resize log once it has been still for half a second (debounced fits, transitions). */
async function quietResizes(app: App): Promise<PtyResize[]> {
  let last = -1;
  let since = Date.now();
  return await waitFor(
    async () => {
      const r = await app.resizes();
      if (r.length !== last) {
        last = r.length;
        since = Date.now();
        return null;
      }
      return Date.now() - since >= 500 ? r : null;
    },
    8000,
    "PTY resizes to settle",
  );
}

/** Each terminal's PTY id and grid. */
async function grids(
  app: App,
  ids: string[],
): Promise<Map<string, { ptyId: string; cols: number; rows: number }>> {
  const out = new Map<string, { ptyId: string; cols: number; rows: number }>();
  for (const id of ids) {
    const s = (await app.terminal(id))!;
    out.set(id, { ptyId: s.ptyId!, cols: s.cols, rows: s.rows });
  }
  return out;
}

/** Resize mode: no catchers, no inline body styles or transforms, every body fills its slot. */
async function assertPlainBodies(app: App): Promise<void> {
  assertEquals(await app.count("[data-testid=tile-catcher]"), 0);
  for (const b of await bodies(app)) {
    assertEquals(b.transform, "none");
    assertEquals(b.inline, "");
    assert(!b.catcher && !b.scaledClass);
    assertEquals([b.w, b.h], [b.slotW, b.slotH]);
  }
}

/** Four terminals in scale mode, settled, with the settings panel closed. */
async function scaledFour(app: App): Promise<string[]> {
  await app.setInactiveTiles("scale");
  await app.closeSettings();
  const ids = await app.ensureTerminals(4);
  await quietResizes(app);
  return ids;
}

suite("scaled tiles", (test) => {
  test("scale: inactive bodies are scaled down at the focused size; the focused one is not", async (app) => {
    const ids = await scaledFour(app);
    const all = await bodies(app);
    assertEquals(all.length, 4);
    const focused = all.filter((b) => b.focused);
    assertEquals(focused.length, 1);
    const f = focused[0];
    assertEquals(f.transform, "none");
    assert(!f.catcher, "no click-catcher on the focused tile");
    // tileBodySize mirrors the CSS chrome: the focused body fills exactly the slot it would have.
    assertEquals([f.w, f.h], [f.slotW, f.slotH]);
    const rect = (await app.tileRects())[f.id];
    assertEquals(tileBodySize(rect), { w: f.w, h: f.h });
    for (const b of all.filter((b) => !b.focused)) {
      assert(b.scaledClass);
      assertLess(b.scale, 1, `${b.id} is scaled down`);
      assertGreater(b.scale, 0);
      assertEquals(
        [b.w, b.h],
        [f.w, f.h],
        `${b.id} laid out at the focused size`,
      );
      assert(b.catcher, `${b.id} has a click-catcher`);
      // The scaled terminal fits inside its own slot.
      assert(b.w * b.scale <= b.slotW + 0.5 && b.h * b.scale <= b.slotH + 0.5);
    }
    // Every terminal has the focused tile's grid.
    const g = [...(await grids(app, ids)).values()];
    for (const x of g) assertEquals([x.cols, x.rows], [g[0].cols, g[0].rows]);
  });

  test("scale: focus changes never resize a PTY", async (app) => {
    const ids = await scaledFour(app);
    const before = (await quietResizes(app)).length;
    const gridsBefore = await grids(app, ids);
    await app.focusChip(ids[0]);
    await app.focusChip(ids[2]);
    await app.shortcut("Backquote");
    await app.shortcut("BracketRight");
    await app.click(
      `[data-testid=tile][data-id="${ids[1]}"] [data-testid=tile-catcher]`,
    );
    await waitFor(
      async () => (await app.focusedId()) === ids[1],
      3000,
      "focus",
    );
    await bodies(app);
    const after = await quietResizes(app);
    assertEquals(after.slice(before), [], "no resizes from focus changes");
    assertEquals(await grids(app, ids), gridsBefore);
    // The PTY agrees with xterm.
    const out = await app.run(ids[1], "size");
    const g = gridsBefore.get(ids[1])!;
    assert(out.includes(`\n${g.rows} ${g.cols}`), `size: ${out.slice(-80)}`);
  });

  test("scale: clicking an inactive tile focuses it and the click never reaches xterm", async (app) => {
    const ids = await scaledFour(app);
    const target = ids[0];
    const sel =
      `[data-testid=tile][data-id="${target}"] [data-testid=tile-catcher]`;
    // The catcher is what sits under the pointer over the scaled terminal.
    const onTop = await app.eval((s: string) => {
      const c = document.querySelector(s)!.getBoundingClientRect();
      const top = document.elementFromPoint(
        c.x + c.width / 2,
        c.y + c.height / 2,
      );
      return top?.getAttribute("data-testid") ?? top?.className ?? null;
    }, sel);
    assertEquals(onTop, "tile-catcher");
    await app.click(sel);
    await waitFor(
      async () => (await app.focusedId()) === target,
      3000,
      "focus",
    );
    await waitFor(() => app.xtermHasFocus(target), 3000, "keyboard focus");
    const all = await bodies(app);
    const b = all.find((x) => x.id === target)!;
    assertEquals(b.transform, "none");
    assert(!b.catcher);
    // Keyboard input goes to it.
    const out = await app.run(target, "echo clicked");
    assert(/^clicked$/m.test(out));
  });

  test("scale: a layout change resizes each terminal once, to the new focused size", async (app) => {
    const ids = await scaledFour(app);
    const before = (await quietResizes(app)).length;
    const old = await grids(app, ids);
    // Grid makes the focused tile much smaller than cascade's.
    await app.setPatternViaSettings("grid");
    await app.closeSettings();
    await bodies(app);
    const log = (await quietResizes(app)).slice(before);
    const now = await grids(app, ids);
    const focused = (await app.focusedId())!;
    const want = now.get(focused)!;
    assert(
      want.cols !== old.get(focused)!.cols ||
        want.rows !== old.get(focused)!.rows,
      "the focused grid changed",
    );
    for (const id of ids) {
      const g = now.get(id)!;
      const mine = log.filter((r) => r.ptyId === g.ptyId);
      assertEquals(
        mine,
        [{ ptyId: g.ptyId, cols: want.cols, rows: want.rows }],
        `${id}: one resize to the focused size (${JSON.stringify(log)})`,
      );
    }
    assertEquals(log.length, ids.length);
    // And the focused body is the new focused tile's body.
    const f = (await bodies(app)).find((b) => b.focused)!;
    const rect = (await app.tileRects())[focused];
    assertEquals(tileBodySize(rect), { w: f.w, h: f.h });
  });

  test("scale: a new terminal starts at the focused size", async (app) => {
    const ids = await scaledFour(app);
    const id = await app.newTerminal();
    await quietResizes(app);
    const g = await grids(app, [...ids, id]);
    const want = g.get(id)!;
    for (const [tid, x] of g) {
      assertEquals([x.cols, x.rows], [want.cols, want.rows], tid);
    }
    const out = await app.run(id, "size");
    assert(
      out.includes(`\n${want.rows} ${want.cols}`),
      `size: ${out.slice(-80)}`,
    );
  });

  test("scale: the body transform animates with the tile", async (app) => {
    await scaledFour(app);
    const all = await bodies(app);
    assert(all.every((b) => b.transitionMs > 100), "transform transitions");
  });

  test("scale: reduced motion makes the scale change instant", async (app) => {
    await scaledFour(app);
    const all = await bodies(app);
    assert(all.every((b) => b.transitionMs === 0), "no transform transition");
  }, { reducedMotion: true });

  test("resize mode (default): unchanged — inactive tiles are refitted, no transforms or catchers", async (app) => {
    assertEquals((await app.settings()).inactiveTiles, "resize");
    const ids = await app.ensureTerminals(3);
    const before = (await quietResizes(app)).length;
    await assertPlainBodies(app);
    // A focus change resizes the terminals whose tiles changed size.
    await app.focusChip(ids[0]);
    await bodies(app);
    assertGreater((await quietResizes(app)).length, before);
  });

  test("switching scale → resize at run time restores per-tile sizes", async (app) => {
    const ids = await scaledFour(app);
    await app.setInactiveTiles("resize");
    await app.closeSettings();
    await quietResizes(app);
    await assertPlainBodies(app);
    const g = await grids(app, ids);
    const f = g.get((await app.focusedId())!)!;
    const smaller = [...g.values()].filter((x) =>
      x.cols < f.cols || x.rows < f.rows
    );
    assertGreater(
      smaller.length,
      0,
      "inactive terminals refitted to their tiles",
    );
  });

  test("the setting persists across a reload", async (app) => {
    await app.setInactiveTiles("scale");
    assertEquals(
      await app.attr(
        "[data-testid=setting-inactive-tiles][data-value=scale]",
        "aria-checked",
      ),
      "true",
    );
    await app.reload();
    assertEquals((await app.settings()).inactiveTiles, "scale");
    await app.ensureTerminals(2);
    await waitFor(
      () =>
        app.exists("[data-testid=tile].is-scaled [data-testid=tile-catcher]"),
      3000,
      "a scaled inactive tile after reload",
    );
    await app.openSettings();
    assertEquals(
      await app.attr(
        "[data-testid=setting-inactive-tiles][data-value=scale]",
        "aria-checked",
      ),
      "true",
    );
  });
});
