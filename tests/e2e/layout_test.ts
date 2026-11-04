// MRU sizing, every pattern (settings, pattern menu, Mod+Shift+L), monocle, the cluster's
// overflow (maxVisible) and window resizes — all checked against `computeLayout` itself.

import { assert, assertEquals, assertGreater } from "@std/assert";
import { PATTERNS } from "../../lib/workspace/store.ts";
import { type App, suite, waitFor } from "./harness.ts";

const area = (r: { w: number; h: number }) => r.w * r.h;

/** Ranks from the DOM must equal the MRU index; the focused tile is the biggest. */
async function assertMruSizing(app: App): Promise<void> {
  const mru = await app.mru();
  const rects = await app.tileRects();
  const tiles = (await app.tiles()).filter((t) => t.id in rects);
  for (const t of tiles) {
    assertEquals(t.rank, mru.indexOf(t.id), `rank of ${t.id}`);
  }
  const byRank = tiles.slice().sort((a, b) => a.rank! - b.rank!);
  const focused = byRank[0];
  assertEquals(focused.id, await app.focusedId());
  for (const t of byRank.slice(1)) {
    assert(
      area(rects[focused.id]) >= area(rects[t.id]),
      `focused ${focused.id} (${area(rects[focused.id])}) >= ${t.id} (${
        area(rects[t.id])
      })`,
    );
  }
  // Area never grows with rank (integer px rounding: allow a 1px strip of the larger side).
  for (let i = 1; i < byRank.length; i++) {
    const a = rects[byRank[i - 1].id];
    const b = rects[byRank[i].id];
    const tol = Math.max(a.w, a.h, b.w, b.h) + 1;
    assert(
      area(b) <= area(a) + tol,
      `rank ${i} (${byRank[i].id}, ${area(b)}) <= rank ${i - 1} (${
        byRank[i - 1].id
      }, ${area(a)})`,
    );
  }
}

suite("layout", (test) => {
  // ---- MRU sizing ---------------------------------------------------------------------------

  test("mru: ranks follow focus order and the focused tile is largest", async (app) => {
    const ids = await app.ensureTerminals(5);
    await assertMruSizing(app);
    for (const id of [ids[1], ids[3], ids[0], ids[4], ids[2]]) {
      await app.focusChip(id);
      assertEquals((await app.mru())[0], id);
      await assertMruSizing(app);
    }
    assertEquals(await app.mru(), [ids[2], ids[4], ids[0], ids[3], ids[1]]);
  });

  test("mru: rects match computeLayout after every focus change", async (app) => {
    const ids = await app.ensureTerminals(5);
    await app.assertLayoutMatches();
    for (const id of [ids[0], ids[2], ids[1], ids[0]]) {
      await app.focusChip(id);
      await app.assertLayoutMatches();
    }
  });

  test("mru: clicking a tile focuses it and re-tiles", async (app) => {
    const ids = await app.ensureTerminals(3);
    const target = ids[0];
    // Click the tile's header (title), which is not the close button.
    await app.click(
      `[data-testid=tile][data-id="${target}"] [data-testid=tile-title]`,
    );
    await waitFor(
      async () => (await app.focusedId()) === target,
      3000,
      "tile focus",
    );
    await waitFor(() => app.xtermHasFocus(target), 3000, "keyboard focus");
    await app.assertLayoutMatches();
  });

  test("mru: decay = 1 gives equal-ish sizes in columns", async (app) => {
    await app.ensureTerminals(4);
    await app.setPatternViaSettings("columns");
    await app.setSlider("decay", 1);
    await app.closeSettings();
    await app.assertLayoutMatches();
    const widths = Object.values(await app.tileRects()).map((r) => r.w);
    assert(Math.max(...widths) - Math.min(...widths) <= 1, `widths ${widths}`);
  });

  // ---- Patterns -----------------------------------------------------------------------------

  test("patterns: every pattern via the settings panel matches computeLayout", async (app) => {
    await app.ensureTerminals(5);
    for (const p of PATTERNS) {
      await app.setPatternViaSettings(p);
      assertEquals(
        await app.attr("[data-testid=bar-pattern]", "data-pattern"),
        p,
      );
      assertEquals(
        await app.attr(
          "[data-testid=setting-pattern][aria-checked=true]",
          "data-pattern",
        ),
        p,
      );
      await app.assertLayoutMatches();
      await assertMruSizing(app);
    }
  });

  test("patterns: every pattern via the bar's pattern menu", async (app) => {
    await app.ensureTerminals(4);
    for (const p of [...PATTERNS].reverse()) {
      await app.click("[data-testid=bar-pattern]");
      await waitFor(
        () => app.exists("[data-testid=pattern-menu]"),
        2000,
        "menu",
      );
      assertEquals(
        await app.count("[data-testid=pattern-item]"),
        PATTERNS.length,
      );
      await app.click(`[data-testid=pattern-item][data-pattern="${p}"]`);
      await waitFor(async () => (await app.pattern()) === p, 2000, p);
      assert(!(await app.exists("[data-testid=pattern-menu]")), "menu closes");
      await app.assertLayoutMatches();
    }
  });

  test("patterns: Mod+Shift+L cycles through every pattern", async (app) => {
    await app.ensureTerminals(4);
    const start = (await app.pattern())!;
    let i = PATTERNS.indexOf(start as typeof PATTERNS[number]);
    for (let n = 0; n < PATTERNS.length; n++) {
      await app.shortcut("KeyL", { shift: true });
      i = (i + 1) % PATTERNS.length;
      const want = PATTERNS[i];
      await waitFor(async () => (await app.pattern()) === want, 2000, want);
      await app.assertLayoutMatches();
    }
    assertEquals(await app.pattern(), start);
  });

  test("patterns: the pattern menu closes on Escape and outside click", async (app) => {
    await app.click("[data-testid=bar-pattern]");
    await waitFor(() => app.exists("[data-testid=pattern-menu]"), 2000, "menu");
    await app.press("Escape");
    await waitFor(
      async () => !(await app.exists("[data-testid=pattern-menu]")),
      2000,
      "closed",
    );
    await app.click("[data-testid=bar-pattern]");
    await waitFor(() => app.exists("[data-testid=pattern-menu]"), 2000, "menu");
    const r = (await app.rectOf("[data-testid=cluster]"))!;
    await app.clickAt(r.x + r.width / 2, r.y + r.height / 2);
    await waitFor(
      async () => !(await app.exists("[data-testid=pattern-menu]")),
      2000,
      "closed",
    );
  });

  // ---- Monocle ------------------------------------------------------------------------------

  test("monocle: Mod+Enter shows one tile, toggling restores the pattern", async (app) => {
    const ids = await app.ensureTerminals(4);
    await app.setPatternViaSettings("grid");
    await app.closeSettings();
    await app.shortcut("Enter");
    await waitFor(
      async () => (await app.pattern()) === "monocle",
      2000,
      "monocle",
    );
    await app.assertLayoutMatches();
    const rects = await app.tileRects();
    assertEquals(Object.keys(rects), [await app.focusedId()]);
    const chips = await app.chips();
    assertEquals(chips.filter((c) => c.tiled).length, 1);
    assertEquals(chips.filter((c) => !c.tiled).length, ids.length - 1);
    // Overflow tiles are parked, not removed.
    await waitFor(
      async () =>
        (await app.tiles()).filter((t) => t.phase === "parked").length ===
          ids.length - 1,
      2000,
      "parked tiles",
    );
    assertEquals((await app.tiles()).length, ids.length);
    await app.shortcut("Enter");
    await waitFor(
      async () => (await app.pattern()) === "grid",
      2000,
      "back to grid",
    );
    await app.assertLayoutMatches();
    assertEquals((await app.chips()).filter((c) => c.tiled).length, ids.length);
  });

  test("monocle: focusing another terminal swaps the single tile", async (app) => {
    const ids = await app.ensureTerminals(3);
    await app.shortcut("Enter");
    await waitFor(
      async () => (await app.pattern()) === "monocle",
      2000,
      "monocle",
    );
    await app.focusChip(ids[0]);
    await app.assertLayoutMatches();
    assertEquals(Object.keys(await app.tileRects()), [ids[0]]);
    await waitFor(
      () => app.xtermHasFocus(ids[0]),
      3000,
      "keyboard focus in the monocle tile",
    );
  });

  // ---- Overflow (maxVisible) ----------------------------------------------------------------

  test("overflow: maxVisible = 3 tiles three, the rest chips are untiled", async (app) => {
    const ids = await app.ensureTerminals(5);
    await app.setSlider("maxVisible", 3);
    await app.closeSettings();
    await app.assertLayoutMatches();
    const mru = await app.mru();
    const chips = await app.chips();
    for (const c of chips) {
      assertEquals(c.tiled, mru.indexOf(c.id) < 3, `chip ${c.id} tiled`);
    }
    assertEquals(Object.keys(await app.tileRects()).length, 3);
    assertEquals((await app.tiles()).length, ids.length);
  });

  test("overflow: focusing an overflow chip brings it in and pushes the oldest out", async (app) => {
    await app.ensureTerminals(5);
    await app.setSlider("maxVisible", 3);
    await app.closeSettings();
    const mru = await app.mru();
    const visible = mru.slice(0, 3);
    const overflowId = mru[4];
    await app.focusChip(overflowId);
    await app.assertLayoutMatches();
    const shown = Object.keys(await app.tileRects()).sort();
    assertEquals(shown, [overflowId, visible[0], visible[1]].sort());
    const chips = await app.chips();
    assertEquals(
      chips.find((c) => c.id === visible[2])!.tiled,
      false,
      "oldest visible pushed out",
    );
    assertEquals(chips.find((c) => c.id === overflowId)!.tiled, true);
    await waitFor(
      () => app.xtermHasFocus(overflowId),
      3000,
      "keyboard focus in the returning terminal",
    );
  });

  test("overflow: a terminal's xterm state survives overflow and return", async (app) => {
    const first = (await app.focusedId())!;
    await app.run(first, "echo kept-across-overflow");
    await app.typeInTerminal(first, "echo pending-line");
    await app.ensureTerminals(4);
    await app.setSlider("maxVisible", 2);
    await app.closeSettings();
    await waitFor(
      async () =>
        (await app.tiles()).find((t) => t.id === first)!.phase === "parked",
      3000,
      "the first terminal parked",
    );
    const sizeHidden = await app.terminal(first);
    await app.focusChip(first);
    await app.settle();
    const text = await app.readTerminalText(first);
    assert(text.includes("kept-across-overflow"), text);
    assert(
      /echo pending-line\s*$/.test(await app.lastLine(first)),
      "unsent line kept",
    );
    // The shell still has the half-typed line: finishing it runs it.
    const out = await app.run(first, "!");
    assert(/^pending-line!$/m.test(out), out);
    assert(
      sizeHidden!.cols >= 2 && sizeHidden!.rows >= 1,
      "never fitted to 0x0 while hidden",
    );
  });

  test("overflow: maxVisible = 1 behaves like monocle", async (app) => {
    await app.ensureTerminals(3);
    await app.setSlider("maxVisible", 1);
    await app.closeSettings();
    await app.assertLayoutMatches();
    assertEquals(Object.keys(await app.tileRects()), [await app.focusedId()]);
  });

  // ---- Resize -------------------------------------------------------------------------------

  test(
    "resize: the viewport re-layouts and the grid shrinks and grows",
    async (app) => {
      const ids = await app.ensureTerminals(3);
      const id = ids.at(-1)!;
      const sizeAt = async () => {
        await app.settle();
        // Wait for the debounced fit to settle and the PTY to agree with xterm.
        let s = await app.terminal(id);
        await waitFor(
          async () => {
            const out = await app.run(id, "size");
            s = await app.terminal(id);
            const m = /^(\d+) (\d+)\s*$/m.exec(
              out.split("\n").filter((l) => /^\d+ \d+\s*$/.test(l)).at(-1) ??
                "",
            );
            return !!m && Number(m[1]) === s!.rows && Number(m[2]) === s!.cols;
          },
          5000,
          "PTY size = xterm size",
        );
        return s!;
      };
      await app.assertLayoutMatches();
      const big = await sizeAt();
      await app.setViewport(900, 600);
      await app.assertLayoutMatches();
      const small = await sizeAt();
      assertGreater(big.cols, small.cols);
      assertGreater(big.rows, small.rows);
      await app.setViewport(1700, 1050);
      await app.assertLayoutMatches();
      const bigger = await sizeAt();
      assertGreater(bigger.cols, big.cols);
      assertGreater(bigger.rows, big.rows);
    },
    { width: 1400, height: 900 },
  );

  test("resize: rects match computeLayout at several sizes and patterns", async (app) => {
    await app.ensureTerminals(4);
    for (const [w, h] of [[1200, 800], [800, 1000], [1600, 700]]) {
      await app.setViewport(w, h);
      for (const p of ["cascade", "master-stack", "grid"]) {
        await app.setPatternViaSettings(p);
        await app.assertLayoutMatches();
      }
    }
  });
});
