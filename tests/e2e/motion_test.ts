// Animation (transitions run; reduced motion turns them off), never-remount (xterm DOM nodes
// survive every re-layout) and a randomized focus stress run.

import { assert, assertEquals } from "@std/assert";
import { touch } from "../../lib/layout/mod.ts";
import { type App, suite, waitFor } from "./harness.ts";

interface Sampled {
  start: number;
  samples: number[];
  durations: string;
}

/**
 * Focus `toId` by a pointerdown on its header (the app's own tile-focus path) and sample the
 * width of tile `watchId` on every frame for ~600ms, all inside the page so no frame is missed.
 */
function sampleFocusChange(
  app: App,
  watchId: string,
  toId: string,
): Promise<Sampled> {
  return app.eval(
    (w: string, to: string) =>
      new Promise<Sampled>((resolve) => {
        const tile = document.querySelector<HTMLElement>(
          `[data-testid=tile][data-id="${w}"]`,
        )!;
        const start = tile.getBoundingClientRect().width;
        const durations = getComputedStyle(tile).transitionDuration;
        document.querySelector(
          `[data-testid=tile][data-id="${to}"] [data-testid=tile-title]`,
        )!
          .dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
            }),
          );
        const samples: number[] = [];
        const t0 = performance.now();
        const tick = () => {
          samples.push(tile.getBoundingClientRect().width);
          if (performance.now() - t0 < 600) requestAnimationFrame(tick);
          else resolve({ start, samples, durations });
        };
        requestAnimationFrame(tick);
      }),
    watchId,
    toId,
  );
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

suite("motion", (test) => {
  // ---- Animation ----------------------------------------------------------------------------

  test("animation: tiles transition (duration > 0, mid-transition rect in between)", async (app) => {
    const [a, b] = await app.ensureTerminals(2);
    await app.settle();
    // b (newest) is focused and wider; focusing a swaps the widths.
    const r = await sampleFocusChange(app, a, a);
    await app.settle();
    const end = (await app.rawTileRects())[a].w;
    const durs = r.durations.split(",").map((d) => parseFloat(d));
    assert(durs.some((d) => d > 0.1), `transition-duration ${r.durations}`);
    assert(
      Math.abs(end - r.start) > 40,
      `the width changes (${r.start} → ${end})`,
    );
    const lo = Math.min(r.start, end) + 2;
    const hi = Math.max(r.start, end) - 2;
    const between = r.samples.filter((w) => w > lo && w < hi);
    assert(
      between.length >= 2,
      `frames between ${r.start} and ${end}: ${
        r.samples.map((x) => x.toFixed(0))
      }`,
    );
    assertEquals(await app.focusedId(), a);
    void b;
  });

  test("animation: a new tile enters (parked → entering → shown)", async (app) => {
    const phases = await app.eval(() =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const mo = new MutationObserver(() => {
          const tiles = document.querySelectorAll<HTMLElement>(
            "[data-testid=tile]",
          );
          const t = tiles[tiles.length - 1];
          if (tiles.length === 2 && seen.at(-1) !== t.dataset.phase) {
            seen.push(t.dataset.phase!);
          }
          if (seen.at(-1) === "shown") {
            mo.disconnect();
            resolve(seen);
          }
        });
        mo.observe(document.querySelector("[data-testid=tiles]")!, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-phase"],
        });
        document.querySelector<HTMLElement>("[data-testid=bar-new]")!.click();
      })
    );
    assertEquals(phases.filter((p) => p !== "parked"), ["entering", "shown"]);
  });

  test(
    "animation: prefers-reduced-motion turns transitions off",
    async (app) => {
      const [a] = await app.ensureTerminals(2);
      await app.settle();
      assert(
        await app.exists("[data-testid=app].reduced-motion"),
        "the app sees reduced motion",
      );
      const r = await sampleFocusChange(app, a, a);
      const durs = r.durations.split(",").map((d) => parseFloat(d));
      // transform/width/height/opacity use --tile-ms (0); only the 180ms border/shadow colours stay.
      const props = await app.eval(() =>
        getComputedStyle(document.querySelector("[data-testid=tile]")!)
          .transitionProperty
      );
      const byProp = new Map(
        props.split(",").map((p, i) => [p.trim(), durs[i % durs.length]]),
      );
      for (const p of ["transform", "width", "height", "opacity"]) {
        assertEquals(byProp.get(p), 0, `${p} duration`);
      }
      const end = (await app.rawTileRects())[a].w;
      assert(Math.abs(end - r.start) > 40, "the width still changes");
      const lo = Math.min(r.start, end) + 2;
      const hi = Math.max(r.start, end) - 2;
      const between = r.samples.filter((w) => w > lo && w < hi);
      assertEquals(between, [], "no intermediate frames");
      // A new tile skips the entering phase.
      await app.newTerminal();
      assert((await app.tiles()).every((t) => t.phase === "shown"));
    },
    { reducedMotion: true },
  );

  // ---- Never-remount ------------------------------------------------------------------------

  test("never-remount: xterm nodes survive focus, patterns, monocle, overflow and bar moves", async (app) => {
    const ids = await app.ensureTerminals(5);
    for (const id of ids) {
      assert(await app.tagXterm(id, `tag-${id}`), `tagged ${id}`);
    }
    const tagTiles = () =>
      app.eval(() => {
        for (
          const el of document.querySelectorAll<HTMLElement>(
            "[data-testid=tile]",
          )
        ) {
          (el as HTMLElement & { __tileTag?: string }).__tileTag =
            el.dataset.id;
        }
      });
    await tagTiles();
    const check = async (when: string) => {
      for (const id of ids) {
        assertEquals(
          await app.xtermTag(id),
          `tag-${id}`,
          `${id} xterm after ${when}`,
        );
      }
      const tilesOk = await app.eval(() =>
        [...document.querySelectorAll<HTMLElement>("[data-testid=tile]")].every(
          (el) =>
            (el as HTMLElement & { __tileTag?: string }).__tileTag ===
              el.dataset.id &&
            el.querySelectorAll(".xterm").length === 1,
        )
      );
      assert(tilesOk, `tile nodes after ${when}`);
    };
    for (const id of [ids[0], ids[3], ids[1]]) await app.focusChip(id);
    await check("focus changes");
    for (const p of ["grid", "spiral", "rows", "master-stack"]) {
      await app.setPatternViaSettings(p);
    }
    await app.closeSettings();
    await check("pattern changes");
    await app.shortcut("Enter");
    await waitFor(
      async () => (await app.pattern()) === "monocle",
      2000,
      "monocle",
    );
    await app.settle();
    await app.shortcut("Enter");
    await check("monocle in/out");
    await app.setSlider("maxVisible", 1);
    await app.settle();
    await waitFor(
      async () =>
        (await app.tiles()).filter((t) => t.phase === "parked").length === 4,
      3000,
      "four parked",
    );
    await app.setSlider("maxVisible", 6);
    await app.closeSettings();
    await app.settle();
    await check("overflow out and back");
    await app.shortcut("KeyB", { shift: true });
    await app.shortcut("KeyB", { shift: true });
    await app.settle();
    await check("bar moves");
    // And every terminal still works.
    for (const id of ids) {
      const out = await app.run(id, `echo alive-${id}`);
      assert(out.includes(`\nalive-${id}`), `${id} still runs commands`);
    }
  });

  test("never-remount: a terminal's scrollback survives many re-layouts", async (app) => {
    const first = (await app.focusedId())!;
    await app.run(first, "stress 300");
    const before = await app.readTerminalText(first);
    await app.ensureTerminals(4);
    for (let i = 0; i < 7; i++) await app.shortcut("KeyL", { shift: true });
    await app.focusChip(first);
    await app.settle();
    const after = await app.readTerminalText(first);
    for (const n of [1, 150, 300]) {
      assert(
        after.includes(`line ${n} `) || after.includes(`line ${n}\n`),
        `line ${n}`,
      );
    }
    assert(after.length >= before.length - 200, "nothing lost");
  });

  // ---- Stress -------------------------------------------------------------------------------

  test("stress: 16 terminals, 50 random focus actions, layout consistent with MRU", async (app) => {
    for (let i = 1; i < 16; i++) await app.newTerminal("shortcut");
    assertEquals((await app.chips()).length, 16);
    let mru = await app.mru();
    const rand = mulberry32(0xC0FFEE);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const log: string[] = [];
    for (let step = 0; step < 50; step++) {
      const kind = pick([
        "chip",
        "chip",
        "tile",
        "prev",
        "next",
        "back",
        "digit",
      ]);
      switch (kind) {
        case "chip": {
          const id = pick(mru);
          log.push(`chip ${id}`);
          await app.focusChip(id);
          mru = touch(mru, id);
          break;
        }
        case "tile": {
          const shown = Object.keys(await app.tileRects());
          const id = pick(shown);
          log.push(`tile ${id}`);
          await app.click(
            `[data-testid=tile][data-id="${id}"] [data-testid=tile-title]`,
          );
          mru = touch(mru, id);
          break;
        }
        case "prev":
          log.push("Mod+`");
          await app.shortcut("Backquote");
          mru = touch(mru, mru[1]);
          break;
        case "next":
          log.push("Mod+]");
          await app.shortcut("BracketRight");
          mru = touch(mru, mru[1]);
          break;
        case "back":
          log.push("Mod+[");
          await app.shortcut("BracketLeft");
          mru = touch(mru, mru.at(-1)!);
          break;
        case "digit": {
          const k = 1 + Math.floor(rand() * 9);
          log.push(`Mod+${k}`);
          await app.shortcut(`Digit${k}`);
          mru = touch(mru, mru[k - 1]);
          break;
        }
      }
      await waitFor(
        async () => (await app.focusedId()) === mru[0],
        3000,
        `step ${step} (${log.at(-1)}) to focus ${mru[0]}`,
      );
    }
    assertEquals(await app.mru(), mru, `after ${log.join(", ")}`);
    await app.assertLayoutMatches();
    const tiles = (await app.tiles()).filter((t) => t.phase === "shown");
    for (const t of tiles) assertEquals(t.rank, mru.indexOf(t.id));
    const chips = await app.chips();
    assertEquals(chips.map((c) => c.id), mru, "bar order is MRU");
    assertEquals(chips.filter((c) => c.focused).map((c) => c.id), [mru[0]]);
    await waitFor(
      () => app.xtermHasFocus(mru[0]),
      3000,
      "keyboard focus on the final terminal",
    );
    const out = await app.run(mru[0], "echo survived");
    assert(/^survived$/m.test(out));
  });
});
