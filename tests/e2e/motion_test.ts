// Animation (transitions run; reduced motion turns them off), never-remount (xterm DOM nodes
// survive every re-layout) and a randomized focus stress run.

import { assert, assertEquals } from "@std/assert";
import { touch } from "../../lib/layout/mod.ts";
import { type App, suite, waitFor } from "./harness.ts";

interface Sampled {
  start: number;
  samples: number[];
  durations: string;
  /**
   * The width with the tile's running width/transform transitions paused at their halfway point
   * (null when none was running). Unlike `samples`, this doesn't depend on the machine being
   * fast enough to paint frames mid-transition: a slow CI runner may only paint the start and
   * the end.
   */
  mid: number | null;
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
        let mid: number | null = null;
        const t0 = performance.now();
        const measureMid = () => {
          const running = tile.getAnimations().filter((a) =>
            a instanceof CSSTransition &&
            ["width", "transform"].includes(a.transitionProperty)
          );
          if (running.length === 0) return;
          for (const a of running) {
            a.pause();
            a.currentTime = Number(a.effect?.getTiming().duration ?? 0) / 2;
          }
          mid = tile.getBoundingClientRect().width;
          for (const a of running) a.play();
        };
        const tick = () => {
          if (samples.length === 0) measureMid();
          samples.push(tile.getBoundingClientRect().width);
          if (performance.now() - t0 < 600) requestAnimationFrame(tick);
          else resolve({ start, samples, durations, mid });
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
    assert(
      r.mid !== null && r.mid > lo && r.mid < hi,
      `halfway width ${r.mid} between ${r.start} and ${end} (frames: ${
        r.samples.map((x) => x.toFixed(0))
      })`,
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

  test("chips: a press focuses its chip even if the strip moves before the release", async (app) => {
    // The strip scrolls back toward the focused chip after a keyboard focus change; a press held
    // through that scroll is released over something else, which fires no click. The chip acts
    // on the press, as a browser tab does, and the terminal keeps the keyboard.
    for (let i = 1; i < 16; i++) await app.newTerminal("shortcut");
    for (let k = 0; k < 4; k++) {
      await app.settle();
      await app.focusChip((await app.mru()).at(-1)!);
      const before = await app.mru();
      await app.shortcut("Backquote");
      await waitFor(
        async () => (await app.focusedId()) === before[1],
        3000,
        `Mod+\` to focus ${before[1]}`,
      );
      const id = before[Math.floor(before.length / 2)];
      await app.slowClick(
        `[data-testid=chip][data-id="${id}"] .chip-title`,
        400,
      );
      await waitFor(
        async () => (await app.focusedId()) === id,
        3000,
        `${id} to be focused by the press`,
      );
      await waitFor(
        () => app.xtermHasFocus(id),
        3000,
        `${id}'s terminal to have the keyboard`,
      );
      assertEquals((await app.chips()).length, 16, "no chip closed");
    }
  });

  test("a chip click right after a keyboard focus change lands on that chip", async (app) => {
    // The strip overflows; a click on the last chip scrolls it to the far end, the keyboard then
    // moves the focus, and the switcher bar smooth-scrolls back to the focused chip (first in MRU
    // order). That scroll stands still for a frame or more before it moves, so the chip aimed at
    // next looks still, then slides away before the press arrives; `pressDelayMs` stands in for a
    // loaded runner's round trip. Without `click`'s guard the press lands on the neighbouring chip
    // (often on its close button) and the chip aimed at is never focused.
    for (let i = 1; i < 16; i++) await app.newTerminal("shortcut");
    for (let k = 0; k < 12; k++) {
      app.pressDelayMs = 0;
      await app.settle();
      await app.focusChip((await app.mru()).at(-1)!);
      const before = await app.mru();
      await app.shortcut("Backquote");
      await waitFor(
        async () => (await app.focusedId()) === before[1],
        3000,
        `Mod+\` to focus ${before[1]}`,
      );
      // A chip in the middle of the strip, not one of the two the keyboard swapped.
      const id = await app.eval((skip: string[]) => {
        const box = document.querySelector("[data-testid=chips]")!
          .getBoundingClientRect();
        const mid = box.left + box.width * 0.6;
        let best = "";
        let dist = Infinity;
        for (
          const c of document.querySelectorAll<HTMLElement>(
            "[data-testid=chip]",
          )
        ) {
          const r = c.getBoundingClientRect();
          const d = Math.abs(r.left + r.width / 2 - mid);
          if (d < dist && !skip.includes(c.dataset.id!)) {
            dist = d;
            best = c.dataset.id!;
          }
        }
        return best;
      }, before.slice(0, 2));
      app.pressDelayMs = [40, 80, 120][k % 3];
      await app.focusChip(id);
      assertEquals((await app.chips()).length, 16, "no chip closed");
    }
  });

  test("chips: the focused chip comes into view after a focus change, even if its scroll is cut short", async (app) => {
    // The strip overflows and is scrolled to its far end; a keyboard focus change puts the
    // focused chip first (MRU order). Its smooth scroll is stopped where it is, over a few
    // frames (as a reorder or a resize under way could leave it): the bar aims again once the
    // strip settles, and the chip ends up in view.
    for (let i = 1; i < 16; i++) await app.newTerminal("shortcut");
    const inView = (id: string) =>
      app.eval((id: string) => {
        const list = document.querySelector("[data-testid=chips]")!;
        const chip = list.querySelector(`[data-testid=chip][data-id="${id}"]`)!;
        const a = list.getBoundingClientRect();
        const b = chip.getBoundingClientRect();
        return b.left >= a.left - 1 && b.right <= a.right + 1;
      }, id);
    for (let k = 0; k < 4; k++) {
      await app.settle();
      await app.focusChip((await app.mru()).at(-1)!);
      await app.settle();
      const before = await app.mru();
      await app.eval(() => {
        const list = document.querySelector<HTMLElement>(
          "[data-testid=chips]",
        )!;
        list.scrollTo({ left: list.scrollWidth, behavior: "instant" });
      });
      await app.shortcut("Backquote");
      // Stop the strip where it is, for a few frames.
      await app.eval(() =>
        new Promise<void>((done) => {
          const list = document.querySelector<HTMLElement>(
            "[data-testid=chips]",
          )!;
          let n = 0;
          const stop = () => {
            list.scrollTo({ left: list.scrollLeft, behavior: "instant" });
            if (++n < 4) requestAnimationFrame(stop);
            else done();
          };
          requestAnimationFrame(stop);
        })
      );
      await waitFor(
        async () => (await app.focusedId()) === before[1],
        3000,
        `Mod+\` to focus ${before[1]}`,
      );
      await waitFor(
        () => inView(before[1]),
        5000,
        `the focused chip ${before[1]} in view`,
      );
    }
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

  test("chips: a scroll of the strip between two reorders does not make every chip glide", async (app) => {
    // The FLIP compares each chip's position before and after a reorder. Measured in the
    // viewport, a scroll of the strip in between (revealChip's smooth scroll, or the user's)
    // read as every chip having moved, and positions kept from the last reorder went stale as
    // chip titles (and widths) changed, so every chip glided.
    for (let i = 1; i < 16; i++) await app.newTerminal("shortcut");
    await app.settle();
    const before = await app.mru();
    // Scroll the overflowing strip to its far end, instantly, with no reorder.
    const scrolled = await app.eval(() => {
      const list = document.querySelector<HTMLElement>("[data-testid=chips]")!;
      list.style.scrollBehavior = "auto";
      list.scrollLeft = list.scrollWidth;
      list.style.scrollBehavior = "";
      return list.scrollLeft;
    });
    assert(scrolled > 0, "the chip strip overflows and scrolled");
    // Mod+` swaps the top two of the MRU order: only those two chips change places.
    const glided = app.eval(() =>
      new Promise<string[]>((resolve) => {
        const seen = new Set<string>();
        const t0 = performance.now();
        const look = () => {
          for (const a of document.getAnimations()) {
            const el = (a.effect as KeyframeEffect | null)?.target as
              | HTMLElement
              | null;
            const id = el?.matches?.("[data-testid=chip]")
              ? el.dataset.id
              : undefined;
            if (
              id && (a as CSSTransition).transitionProperty === "transform"
            ) seen.add(id);
          }
          if (performance.now() - t0 < 400) requestAnimationFrame(look);
          else resolve([...seen]);
        };
        requestAnimationFrame(look);
      })
    );
    await app.shortcut("Backquote");
    const moved = await glided;
    // The FLIP still runs: the chip that left the front glides to its new place.
    assert(moved.includes(before[0]), `${before[0]} glides (glided: ${moved})`);
    for (const id of moved) {
      assert(
        before.slice(0, 2).includes(id),
        `only the two swapped chips glide, not ${id} (glided: ${
          moved.join(", ")
        })`,
      );
    }
  });
});
