// The terminal font: the settings panel's typeface / size / line-height controls, the
// Mod+= / Mod+- / Mod+0 shortcuts, applying the font to every terminal (a parked one included)
// with the PTY resized to match, persistence and sanitising.

import { assert, assertEquals, assertGreater, assertLess } from "@std/assert";
import {
  DEFAULT_FONT_SETTINGS,
  FONT_IDS,
  fontStack,
} from "../../lib/workspace/fonts.ts";
import { SETTINGS_STORAGE_KEY } from "../../lib/workspace/store.ts";
import { type App, suite, type TerminalState, waitFor } from "./harness.ts";

const DEFAULT_STACK = fontStack(DEFAULT_FONT_SETTINGS);

/** Set a font range input (`fontSize` / `lineHeight`) and fire `input`. */
async function setFontSlider(
  app: App,
  key: "fontSize" | "lineHeight",
  value: number,
): Promise<void> {
  await app.openSettings();
  await app.eval(
    (k: string, v: number) => {
      const el = document.querySelector<HTMLInputElement>(
        `[data-testid=setting-${k}]`,
      )!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    key,
    value,
  );
  await waitFor(
    async () => (await app.settings())[key] === value,
    2000,
    `${key} = ${value}`,
  );
}

/** Wait until xterm in `id` uses `size` and its grid has been refitted away from `from`. */
async function waitForFont(
  app: App,
  id: string,
  size: number,
  from?: TerminalState,
): Promise<TerminalState> {
  return await waitFor(
    async () => {
      const s = await app.terminal(id);
      if (!s || s.fontSize !== size) return null;
      if (from && s.cols === from.cols && s.rows === from.rows) return null;
      return s;
    },
    5000,
    `${id} at ${size}px${
      from ? ` refitted from ${from.cols}x${from.rows}` : ""
    }`,
  );
}

/** Run the demo `size` command until the PTY agrees with xterm; returns xterm's state. */
async function ptyAgrees(app: App, id: string): Promise<TerminalState> {
  let s = (await app.terminal(id))!;
  await waitFor(
    async () => {
      const out = await app.run(id, "size");
      s = (await app.terminal(id))!;
      const line = out.split("\n").filter((l) => /^\d+ \d+\s*$/.test(l)).at(
        -1,
      ) ?? "";
      const m = /^(\d+) (\d+)/.exec(line);
      return !!m && Number(m[1]) === s.rows && Number(m[2]) === s.cols;
    },
    5000,
    `PTY size = xterm size in ${id}`,
  );
  return s;
}

/** Settle the tiles and let the debounced fit land (the grid stops changing). */
async function settledGrid(app: App, id: string): Promise<TerminalState> {
  await app.settle();
  let prev = "";
  return await waitFor(
    async () => {
      const s = (await app.terminal(id))!;
      const key = `${s.cols}x${s.rows}`;
      const same = key === prev;
      prev = key;
      if (!same) await new Promise((r) => setTimeout(r, 150));
      return same ? s : null;
    },
    5000,
    `${id} grid to settle`,
  );
}

suite("font", (test) => {
  test("defaults: a fresh terminal uses the default font", async (app) => {
    const s = (await app.terminal((await app.focusedId())!))!;
    assertEquals(s.fontSize, DEFAULT_FONT_SETTINGS.fontSize);
    assertEquals(s.fontFamily, DEFAULT_STACK);
    assertEquals(s.lineHeight, DEFAULT_FONT_SETTINGS.lineHeight);
    assertEquals(s.fontWeight, "normal");
  });

  test("slider: a bigger font gives fewer cols/rows, a smaller one more; the PTY agrees", async (app) => {
    const id = (await app.focusedId())!;
    await settledGrid(app, id);
    const base = await ptyAgrees(app, id);
    await setFontSlider(app, "fontSize", 20);
    const big = await waitForFont(app, id, 20, base);
    assertLess(big.cols, base.cols);
    assertLess(big.rows, base.rows);
    const bigPty = await ptyAgrees(app, id);
    assertEquals([bigPty.cols, bigPty.rows], [big.cols, big.rows]);
    assertEquals(
      await app.eval(() =>
        document.querySelector("[data-testid=font-size-value]")!.textContent
      ),
      "20px",
    );
    await setFontSlider(app, "fontSize", 10);
    const small = await waitForFont(app, id, 10, big);
    assertGreater(small.cols, base.cols);
    assertGreater(small.rows, base.rows);
    await ptyAgrees(app, id);
  });

  test("steppers: − and + change the size by one and stop at the range ends", async (app) => {
    const id = (await app.focusedId())!;
    await app.openSettings();
    await app.click("[data-testid=setting-fontSize-inc]");
    await waitForFont(app, id, 14);
    await app.click("[data-testid=setting-fontSize-dec]");
    await app.click("[data-testid=setting-fontSize-dec]");
    await waitForFont(app, id, 12);
    assertEquals(await app.attr("[data-testid=setting-fontSize]", "min"), "9");
    assertEquals(await app.attr("[data-testid=setting-fontSize]", "max"), "32");
    await setFontSlider(app, "fontSize", 32);
    assert(
      await app.eval(() =>
        document.querySelector<HTMLButtonElement>(
          "[data-testid=setting-fontSize-inc]",
        )!.disabled
      ),
      "+ disabled at the max",
    );
  });

  test("shortcuts: Mod+= / Mod++ / Mod+- / Mod+0 from inside xterm, none typed into the shell", async (app) => {
    const id = (await app.focusedId())!;
    await settledGrid(app, id);
    const base = await ptyAgrees(app, id);
    await app.focusTerminalInput(id);
    const lineBefore = await app.lastLine(id);
    await app.shortcut("Equal");
    await waitForFont(app, id, 14);
    await app.shortcut("Equal", { shift: true });
    await waitForFont(app, id, 15);
    await app.shortcut("Equal");
    await app.shortcut("Equal");
    await app.shortcut("Equal");
    const big = await waitForFont(app, id, 18, base);
    assertLess(big.cols, base.cols);
    assertEquals((await app.settings()).fontSize, 18);
    await app.shortcut("Minus");
    await waitForFont(app, id, 17);
    await app.shortcut("Digit0");
    const reset = await waitForFont(app, id, DEFAULT_FONT_SETTINGS.fontSize);
    await waitFor(
      async () => {
        const s = (await app.terminal(id))!;
        return s.cols === base.cols && s.rows === base.rows;
      },
      5000,
      "the grid back at its default-size dimensions",
    );
    assertEquals(reset.fontSize, 13);
    assertEquals(
      await app.lastLine(id),
      lineBefore,
      "no = - + 0 reached the shell",
    );
    assert(await app.xtermHasFocus(id), "xterm keeps focus");
    await ptyAgrees(app, id);
  });

  test("shortcuts: Mod+- stops at 9 and Mod+= at 32", async (app) => {
    const id = (await app.focusedId())!;
    await app.focusTerminalInput(id);
    for (let i = 0; i < 6; i++) await app.shortcut("Minus");
    await waitForFont(app, id, 9);
    await app.shortcut("Minus");
    assertEquals((await app.settings()).fontSize, 9);
    await setFontSlider(app, "fontSize", 31);
    await app.closeSettings();
    await app.focusTerminalInput(id);
    await app.shortcut("Equal");
    await app.shortcut("Equal");
    await waitForFont(app, id, 32);
    assertEquals((await app.settings()).fontSize, 32);
  });

  test("Mod+0 resets a slider-set size", async (app) => {
    const id = (await app.focusedId())!;
    await setFontSlider(app, "fontSize", 25);
    await waitForFont(app, id, 25);
    await app.closeSettings();
    await app.focusTerminalInput(id);
    await app.shortcut("Digit0");
    await waitForFont(app, id, 13);
    assertEquals((await app.settings()).fontSize, 13);
  });

  test("all terminals: visible, parked (monocle) and new ones get the font; the parked one refits on return", async (app) => {
    const [first, second] = await app.ensureTerminals(2);
    await app.setPatternViaSettings("monocle");
    await app.closeSettings();
    await app.settle();
    assertEquals(
      (await app.tiles()).find((t) => t.id === first)!.phase,
      "parked",
    );
    const before = await settledGrid(app, second);
    await app.focusTerminalInput(second);
    for (let i = 0; i < 5; i++) await app.shortcut("Equal");
    const visibleAt18 = await waitForFont(app, second, 18, before);
    await ptyAgrees(app, second);
    // The parked terminal already has the new options.
    const parked = (await app.terminal(first))!;
    assertEquals(parked.fontSize, 18);
    assertEquals(parked.fontFamily, DEFAULT_STACK);
    // Back on screen in the same monocle rect, it refits to the same grid.
    await app.focusChip(first);
    await waitFor(
      async () => {
        const s = (await app.terminal(first))!;
        return s.cols === visibleAt18.cols && s.rows === visibleAt18.rows;
      },
      5000,
      `${first} refitted to ${visibleAt18.cols}x${visibleAt18.rows}`,
    );
    await ptyAgrees(app, first);
    // A new terminal starts with the current font.
    const third = await app.newTerminal();
    const t3 = (await app.terminal(third))!;
    assertEquals(t3.fontSize, 18);
    const t3Grid = await settledGrid(app, third);
    assertEquals([t3Grid.cols, t3Grid.rows], [
      visibleAt18.cols,
      visibleAt18.rows,
    ]);
  });

  test("all terminals: an overflowed (maxVisible) terminal gets the font and refits when it comes back", async (app) => {
    const ids = await app.ensureTerminals(3);
    const first = ids[0];
    await app.setSlider("maxVisible", 2);
    await waitFor(
      async () =>
        (await app.tiles()).find((t) => t.id === first)!.phase === "parked",
      3000,
      "the first terminal parked",
    );
    await setFontSlider(app, "fontSize", 22);
    for (const id of ids) {
      assertEquals((await app.terminal(id))!.fontSize, 22, id);
    }
    await app.closeSettings();
    await app.focusChip(first);
    await settledGrid(app, first);
    const s = await ptyAgrees(app, first);
    assertEquals(s.fontSize, 22);
    // Its grid is what a fresh fit at 22px gives: shrinking the font back must grow it.
    await app.focusTerminalInput(first);
    await app.shortcut("Digit0");
    const back = await waitForFont(app, first, 13, s);
    assertGreater(back.cols, s.cols);
  });

  test("line height: taller lines give fewer rows, the same cols", async (app) => {
    const id = (await app.focusedId())!;
    const base = await settledGrid(app, id);
    await setFontSlider(app, "lineHeight", 1.6);
    const tall = await waitFor(
      async () => {
        const s = (await app.terminal(id))!;
        return s.lineHeight === 1.6 && s.rows !== base.rows ? s : null;
      },
      5000,
      "rows to change with the line height",
    );
    assertLess(tall.rows, base.rows);
    assertEquals(tall.cols, base.cols);
    await ptyAgrees(app, id);
  });

  test("picker: every family listed, installed first, missing ones marked, previewed in their face", async (app) => {
    await app.openSettings();
    const opts = await app.eval(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          "[data-testid=setting-font-family]",
        ),
      ].map((el) => ({
        id: el.dataset.value!,
        installed: el.dataset.installed === "true",
        tag: el.querySelector(".font-option-tag")?.textContent ?? null,
        face: el.querySelector<HTMLElement>(".font-option-name")!.style
          .fontFamily,
      }))
    );
    assertEquals(opts.map((o) => o.id).sort(), [...FONT_IDS].sort());
    assertEquals(opts.at(-1)!.id, "custom");
    const curated = opts.slice(0, -1);
    const firstMissing = curated.findIndex((o) => !o.installed);
    if (firstMissing >= 0) {
      assert(
        curated.slice(firstMissing).every((o) => !o.installed),
        `installed first: ${JSON.stringify(curated.map((o) => o.installed))}`,
      );
    }
    for (const o of curated) {
      assertEquals(o.tag, o.installed ? null : "not installed", o.id);
      assert(/monospace$/.test(o.face), `${o.id} previewed: ${o.face}`);
    }
    // Courier New ships with macOS and Windows; at least one family must be detected.
    assert(curated.some((o) => o.installed), "some family detected");
    // Picking one applies it to xterm and the live sample.
    await app.click("[data-testid=setting-font-family][data-value=menlo]");
    const id = (await app.focusedId())!;
    await waitFor(
      async () => (await app.terminal(id))!.fontFamily === "Menlo, monospace",
      2000,
      "Menlo applied",
    );
    assertEquals(
      await app.attr(
        "[data-testid=setting-font-family][aria-selected=true]",
        "data-value",
      ),
      "menlo",
    );
    const sample = await app.eval(() => {
      const el = document.querySelector<HTMLElement>(
        "[data-testid=font-sample]",
      )!;
      return { text: el.textContent, face: el.style.fontFamily };
    });
    assert(sample.text!.includes("0O1lI"), sample.text!);
    assertEquals(sample.face, "Menlo, monospace");
  });

  test("custom family: typed (with a space), applied, and round-trips through a reload", async (app) => {
    const id = (await app.focusedId())!;
    await app.openSettings();
    await app.click("[data-testid=setting-font-family][data-value=custom]");
    await waitFor(
      () => app.exists("[data-testid=setting-font-custom]"),
      2000,
      "the custom input",
    );
    // An empty custom name keeps the default face.
    assertEquals((await app.terminal(id))!.fontFamily, DEFAULT_STACK);
    await app.click("[data-testid=setting-font-custom]");
    await app.page.keyboard.type("Courier New");
    await waitFor(
      async () =>
        (await app.terminal(id))!.fontFamily === '"Courier New", monospace',
      2000,
      "the custom family applied",
    );
    const saved = await app.settings();
    assertEquals(saved.fontFamily, "custom");
    assertEquals(saved.fontFamilyCustom, "Courier New");
    await app.closeSettings();
    await app.reload();
    assertEquals(
      (await app.terminal((await app.focusedId())!))!.fontFamily,
      '"Courier New", monospace',
    );
    await app.openSettings();
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLInputElement>(
          "[data-testid=setting-font-custom]",
        )!.value
      ),
      "Courier New",
    );
  });

  test("persistence: family, size, line height and weight survive a reload", async (app) => {
    await app.openSettings();
    await app.click(
      "[data-testid=setting-font-family][data-value=courier-new]",
    );
    await setFontSlider(app, "fontSize", 17);
    await setFontSlider(app, "lineHeight", 1.3);
    await app.click("[data-testid=setting-fontWeight][data-value='500']");
    await waitFor(
      async () => (await app.settings()).fontWeight === "500",
      2000,
      "weight 500",
    );
    await app.closeSettings();
    await app.reload();
    const s = (await app.terminal((await app.focusedId())!))!;
    assertEquals(s.fontFamily, '"Courier New", monospace');
    assertEquals(s.fontSize, 17);
    assertEquals(s.lineHeight, 1.3);
    assertEquals(s.fontWeight, "500");
    await app.openSettings();
    assertEquals(
      await app.attr(
        "[data-testid=setting-font-family][aria-selected=true]",
        "data-value",
      ),
      "courier-new",
    );
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLInputElement>(
          "[data-testid=setting-fontSize]",
        )!
          .value
      ),
      "17",
    );
  });

  test("persistence: corrupt font settings fall back to defaults / clamp, without errors", async (app) => {
    await app.eval(
      (k: string) =>
        localStorage.setItem(
          k,
          JSON.stringify({
            layout: { pattern: "rows" },
            fontFamily: "<script>",
            fontFamilyCustom: { x: 1 },
            fontSize: 999,
            lineHeight: "tall",
            fontWeight: 900,
          }),
        ),
      SETTINGS_STORAGE_KEY,
    );
    await app.reload();
    const s = (await app.terminal((await app.focusedId())!))!;
    assertEquals(s.fontFamily, DEFAULT_STACK);
    assertEquals(s.fontSize, 32);
    assertEquals(s.lineHeight, DEFAULT_FONT_SETTINGS.lineHeight);
    assertEquals(s.fontWeight, "normal");
    assertEquals(await app.pattern(), "rows", "the valid parts are kept");
    await waitFor(
      async () => {
        const saved = await app.settings();
        return saved.fontFamily === "sf-mono" && saved.fontSize === 32;
      },
      2000,
      "a sanitised value written back",
    );
    // Old settings with no font fields at all load the defaults.
    await app.eval(
      (k: string) =>
        localStorage.setItem(k, JSON.stringify({ barPosition: "left" })),
      SETTINGS_STORAGE_KEY,
    );
    await app.reload();
    const d = (await app.terminal((await app.focusedId())!))!;
    assertEquals(d.fontSize, 13);
    assertEquals(d.fontFamily, DEFAULT_STACK);
  });

  test("shortcut list: the font shortcuts are listed", async (app) => {
    await app.openSettings();
    const items = await app.eval(() =>
      [...document.querySelectorAll(".shortcuts div")].map((d) => d.textContent)
    );
    const mod = app.platform === "mac" ? "⌘" : "Ctrl+";
    for (const k of ["=", "-", "0"]) {
      assert(
        items.some((t) => t!.startsWith(`${mod}${k}`)),
        `${mod}${k} in ${JSON.stringify(items)}`,
      );
    }
  });
});
