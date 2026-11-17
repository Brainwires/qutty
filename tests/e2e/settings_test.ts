// The Settings dialog (open/close, tabs, search, deep links, live sliders) and persistence across
// reloads; Settings → Agents → Agent integration's Codex trust warning and Re-trust (the demo's
// `?codexTrust=untrusted`).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DEFAULT_LAYOUT_OPTIONS } from "../../lib/layout/mod.ts";
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
} from "../../lib/workspace/store.ts";
import { type App, suite, waitFor } from "./harness.ts";

const sliderValue = (app: App, key: string) =>
  app.eval(
    (k: string) =>
      Number(
        document.querySelector<HTMLInputElement>(`[data-testid=setting-${k}]`)!
          .value,
      ),
    key,
  );

const panelOpen = (app: App) => app.exists("[data-testid=settings-panel]");

const textOf = (app: App, selector: string) =>
  app.eval(
    (s: string) => document.querySelector(s)?.textContent?.trim() ?? "",
    selector,
  );

suite("settings", (test) => {
  // ---- Panel --------------------------------------------------------------------------------

  test("panel: opens from the bar and closes with its × button", async (app) => {
    await app.openSettings();
    assertEquals(
      await app.attr("[data-testid=bar-settings]", "aria-expanded"),
      "true",
    );
    await app.click("[data-testid=settings-close]");
    await waitFor(async () => !(await panelOpen(app)), 2000, "closed");
    assertEquals(
      await app.attr("[data-testid=bar-settings]", "aria-expanded"),
      "false",
    );
  });

  test("panel: the settings button opens it; a backdrop click closes it", async (app) => {
    await app.click("[data-testid=bar-settings]");
    await waitFor(() => panelOpen(app), 2000, "open");
    // A modal: the backdrop covers the window, a click on it (not on the dialog) closes.
    const panel = (await app.rectOf("[data-testid=settings-panel]"))!;
    assert(panel.x >= 8, `room beside the dialog: ${panel.x}`);
    await app.clickAt(panel.x / 2, panel.y + panel.height / 2);
    await waitFor(async () => !(await panelOpen(app)), 2000, "closed again");
  });

  test("panel: Escape closes it", async (app) => {
    await app.openSettings("layout");
    // Focus inside the panel, then Escape.
    await app.eval(() =>
      document.querySelector<HTMLElement>("[data-testid=setting-gap]")!.focus()
    );
    await app.press("Escape");
    await waitFor(
      async () => !(await panelOpen(app)),
      2000,
      "closed by Escape",
    );
    // And with keyboard focus in the terminal.
    await app.openSettings();
    await app.focusTerminalInput((await app.focusedId())!);
    await app.press("Escape");
    await waitFor(
      async () => !(await panelOpen(app)),
      2000,
      "closed by Escape from xterm",
    );
  });

  test("panel: inside clicks do not close it", async (app) => {
    await app.openSettings("layout");
    await app.click("[data-testid=setting-pattern][data-pattern=rows]");
    await app.settingsTab("general");
    await app.click("[data-testid=setting-bar-order][data-value=created]");
    assert(await panelOpen(app), "still open after inside clicks");
  });

  test("dialog: fits the window, wide on big ones and nearly all of it on small ones", async (app) => {
    for (const [w, h] of [[1400, 900], [640, 480]]) {
      await app.setViewport(w, h);
      await app.openSettings();
      const r = (await app.rectOf("[data-testid=settings-panel]"))!;
      assert(
        r.x >= 0 && r.y >= 0 && r.right <= w && r.bottom <= h,
        `${w}×${h}`,
      );
      assert(r.width >= Math.min(900, w * 0.85), `wide at ${w}: ${r.width}`);
      await app.closeSettings();
    }
  });

  test("dialog: tabs switch the content, ↑/↓ walk them, and the last one is remembered", async (app) => {
    await app.openSettings();
    const selected = () =>
      app.attr("[data-testid=settings-tab][aria-selected=true]", "data-tab");
    const shownPanels = () =>
      app.eval(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            "[data-testid=settings-category]",
          ),
        ].filter((el) => !el.hidden).map((el) => el.dataset.tab)
      );
    assertEquals(await selected(), "general", "General by default");
    assertEquals(await shownPanels(), ["general"]);
    assertEquals(
      await app.attr("[data-testid=settings-tablist]", "aria-orientation"),
      "vertical",
    );
    await app.click('[data-testid=settings-tab][data-tab="layout"]');
    await waitFor(async () => (await selected()) === "layout", 2000, "layout");
    assertEquals(await shownPanels(), ["layout"]);
    assertEquals(await textOf(app, "[data-testid=settings-title]"), "Layout");
    assert(await app.exists("[data-testid=setting-gap]"));
    // A control on a hidden tab cannot take focus.
    assertEquals(
      await app.eval(() => {
        const el = document.querySelector<HTMLElement>(
          "[data-testid=setting-plus-opens]",
        )!;
        el.focus();
        return document.activeElement === el;
      }),
      false,
      "a hidden tab's control is not focusable",
    );
    // The keyboard: the selected tab has focus; ↓ and ↑ move (and wrap), Tab goes into the content.
    await app.eval(() =>
      document.querySelector<HTMLElement>(
        '[data-testid=settings-tab][aria-selected="true"]',
      )!.focus()
    );
    await app.press("ArrowDown");
    await waitFor(async () => (await selected()) === "tiles", 2000, "tiles");
    assertEquals(
      await app.eval(() =>
        (document.activeElement as HTMLElement | null)?.dataset.tab
      ),
      "tiles",
      "the new tab has focus",
    );
    await app.press("ArrowUp");
    await app.press("ArrowUp");
    await waitFor(
      async () => (await selected()) === "appearance",
      2000,
      "appearance",
    );
    await app.press("Tab");
    assert(
      await app.eval(() =>
        !!document.activeElement?.closest(
          '[data-testid=settings-category][data-tab="appearance"]',
        )
      ),
      "Tab moves into the content",
    );
    // Remembered across closing and reloading.
    await app.closeSettings();
    await app.openSettings();
    assertEquals(await selected(), "appearance");
    await waitFor(
      async () => (await app.settings()).settingsTab === "appearance",
      2000,
      "persisted",
    );
    await app.reload();
    await app.openSettings();
    assertEquals(await selected(), "appearance");
    assertEquals(await shownPanels(), ["appearance"]);
  });

  test("dialog: search finds a setting in another tab; clearing returns to the tab", async (app) => {
    await app.openSettings("general");
    // The search field has the keyboard on open.
    await waitFor(
      () =>
        app.eval(() =>
          document.activeElement?.getAttribute("data-testid") ===
            "settings-search"
        ),
      2000,
      "the search field focused",
    );
    const visible = (s: string) =>
      app.eval((sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        return !!el && el.getClientRects().length > 0;
      }, s);
    /** Replace the search field's text with `text` (typed). */
    const search = async (text: string) => {
      await app.eval(() => {
        const el = document.querySelector<HTMLInputElement>(
          "[data-testid=settings-search]",
        )!;
        el.focus();
        el.select();
      });
      if (text) await app.page.keyboard.type(text);
      else await app.press("Backspace");
    };
    await app.page.keyboard.type("gap");
    await waitFor(
      () => visible("[data-testid=setting-gap]"),
      2000,
      "Layout's gap slider shown",
    );
    assertEquals(await visible("[data-testid=setting-bar-order]"), false);
    assertEquals(await visible("[data-testid=setting-decay]"), false);
    assertEquals(await textOf(app, "[data-testid=settings-title]"), "Search");
    // Grouped under its category's name.
    assertStringIncludes(
      await textOf(
        app,
        '[data-testid=settings-category][data-tab="layout"] .settings-category-title',
      ),
      "Layout",
    );
    // Its controls work from the results.
    await search("pattern");
    await app.click("[data-testid=setting-pattern][data-pattern=rows]");
    await waitFor(async () => (await app.pattern()) === "rows", 2000, "rows");
    // Hints count too: "recently they were used" is only in the focus-to-main hint.
    await search("recently they were used");
    await waitFor(
      () => visible("[data-testid=setting-focus-to-main]"),
      2000,
      "found by its hint",
    );
    assertEquals(await visible("[data-testid=setting-gap]"), false);
    // Nothing matches.
    await search("zzzqqq");
    await waitFor(
      () => app.exists("[data-testid=settings-no-results]"),
      2000,
      "no results",
    );
    // Cleared: back on the selected tab, everything in it shown.
    await search("");
    await waitFor(
      () => visible("[data-testid=setting-bar-order]"),
      2000,
      "General again",
    );
    assertEquals(await visible("[data-testid=setting-gap]"), false);
    assertEquals(await textOf(app, "[data-testid=settings-title]"), "General");
    assertEquals(await app.exists("[data-search-hidden]"), false);
  });

  test("dialog: Escape closes it and gives the keyboard back to the focused tile", async (app) => {
    const id = (await app.focusedId())!;
    await app.openSettings("voice");
    await app.press("Escape");
    await waitFor(async () => !(await panelOpen(app)), 2000, "closed");
    await waitFor(
      () => app.xtermHasFocus(id),
      2000,
      "the tile has the keyboard",
    );
    // The × button too.
    await app.openSettings();
    await app.click("[data-testid=settings-close]");
    await waitFor(async () => !(await panelOpen(app)), 2000, "closed by ×");
    await waitFor(() => app.xtermHasFocus(id), 2000, "the tile again");
  });

  test("dialog: a link to another tab opens it at the setting", async (app) => {
    await app.openSettings("companion");
    // Lively off: System monitor's hot companion links back to it.
    await app.click("[data-testid=setting-companion-lively]");
    await waitFor(
      async () => !(await app.settings()).companion.lively,
      2000,
      "lively off",
    );
    await app.settingsTab("monitor");
    await app.click(
      '[data-testid=settings-link][data-tab="companion"]',
    );
    await waitFor(
      async () =>
        (await app.attr(
          "[data-testid=settings-tab][aria-selected=true]",
          "data-tab",
        )) === "companion",
      2000,
      "the Companion tab",
    );
    await waitFor(
      () =>
        app.eval(() =>
          document.activeElement?.getAttribute("data-testid") ===
            "setting-companion-lively"
        ),
      2000,
      "Lively focused",
    );
    // In view inside the scrolling content.
    const row = (await app.rectOf("[data-testid=setting-companion-lively]"))!;
    const box = (await app.rectOf("[data-testid=settings-content]"))!;
    assert(row.y >= box.y && row.bottom <= box.bottom, "scrolled into view");
  });

  test("panel: slider changes re-layout live while open", async (app) => {
    await app.ensureTerminals(5);
    await app.openSettings();
    await app.setSlider("maxVisible", 2);
    assert(await panelOpen(app));
    await app.assertLayoutMatches();
    assertEquals(Object.keys(await app.tileRects()).length, 2);
    await app.setSlider("gap", 20);
    await app.assertLayoutMatches();
    const rects = Object.values(await app.tileRects());
    assert(
      rects.every((r) => r.x >= 20 && r.y >= 20),
      "the gap pads the edges",
    );
    await app.setSlider("maxVisible", 5);
    await app.setSlider("decay", 0.4);
    await app.assertLayoutMatches();
    await app.setPatternViaSettings("master-stack");
    await app.setSlider("masterRatio", 0.8);
    await app.assertLayoutMatches();
    const bounds = await app.clusterBounds();
    const focused = (await app.tileRects())[(await app.focusedId())!];
    assert(focused.w > bounds.w * 0.7, `master share ${focused.w}/${bounds.w}`);
    // The output labels follow.
    assertEquals(await sliderValue(app, "masterRatio"), 0.8);
  });

  test("panel: sliders are clamped to their ranges", async (app) => {
    await app.openSettings("layout");
    for (
      const [k, min, max] of [["decay", 0.3, 1], ["gap", 0, 32], [
        "maxVisible",
        1,
        16,
      ]] as const
    ) {
      assertEquals(
        await app.attr(`[data-testid=setting-${k}]`, "min"),
        String(min),
      );
      assertEquals(
        await app.attr(`[data-testid=setting-${k}]`, "max"),
        String(max),
      );
    }
  });

  // ---- Persistence --------------------------------------------------------------------------

  test("persistence: pattern, sliders, bar edge and order survive a reload", async (app) => {
    await app.setPatternViaSettings("rows");
    await app.setSlider("decay", 0.5);
    await app.setSlider("masterRatio", 0.7);
    await app.setSlider("maxVisible", 4);
    await app.setSlider("gap", 10);
    await app.setBarPosition("left");
    await app.setBarOrder("created");
    await app.closeSettings();
    await app.reload();
    assertEquals(await app.pattern(), "rows");
    assertEquals(await app.attr("[data-testid=bar]", "data-position"), "left");
    await app.openSettings("general");
    assertEquals(await sliderValue(app, "decay"), 0.5);
    assertEquals(await sliderValue(app, "masterRatio"), 0.7);
    assertEquals(await sliderValue(app, "maxVisible"), 4);
    assertEquals(await sliderValue(app, "gap"), 10);
    assertEquals(
      await app.attr(
        "[data-testid=setting-bar-order][aria-checked=true]",
        "data-value",
      ),
      "created",
    );
    assertEquals(
      await app.attr(
        "[data-testid=setting-bar-position][aria-checked=true]",
        "data-value",
      ),
      "left",
    );
    await app.closeSettings();
    await app.ensureTerminals(3);
    await app.assertLayoutMatches();
  });

  test("persistence: corrupt JSON falls back to the defaults without errors", async (app) => {
    await app.setPatternViaSettings("grid");
    await app.eval(
      (k: string) => localStorage.setItem(k, "{not json"),
      SETTINGS_STORAGE_KEY,
    );
    await app.reload();
    assertEquals(await app.pattern(), DEFAULT_SETTINGS.layout.pattern);
    assertEquals(
      await app.attr("[data-testid=bar]", "data-position"),
      DEFAULT_SETTINGS.barPosition,
    );
    // The app rewrites a valid value.
    await waitFor(
      async () => {
        const raw = await app.eval(
          (k: string) => localStorage.getItem(k),
          SETTINGS_STORAGE_KEY,
        );
        try {
          return JSON.parse(raw!).layout.pattern ===
            DEFAULT_SETTINGS.layout.pattern;
        } catch {
          return false;
        }
      },
      2000,
      "a valid stored value",
    );
    await app.assertLayoutMatches();
  });

  test("persistence: out-of-range and unknown values are sanitized", async (app) => {
    await app.eval(
      (k: string) =>
        localStorage.setItem(
          k,
          JSON.stringify({
            layout: {
              pattern: "bogus",
              gap: 9999,
              decay: -3,
              maxVisible: "7",
              masterRatio: null,
            },
            barPosition: "middle",
            barOrder: 42,
          }),
        ),
      SETTINGS_STORAGE_KEY,
    );
    await app.reload();
    const s = await app.settings();
    assertEquals(s.layout.pattern, DEFAULT_LAYOUT_OPTIONS.pattern);
    assertEquals(s.layout.gap, 32);
    assertEquals(s.layout.decay, 0.3);
    assertEquals(s.layout.maxVisible, DEFAULT_LAYOUT_OPTIONS.maxVisible);
    assertEquals(s.barPosition, "top");
    assertEquals(s.barOrder, "mru");
    await app.assertLayoutMatches();
  });

  test("persistence: a non-object value (a JSON number) is ignored", async (app) => {
    await app.eval(
      (k: string) => localStorage.setItem(k, "12"),
      SETTINGS_STORAGE_KEY,
    );
    await app.reload();
    assertEquals(await app.pattern(), DEFAULT_SETTINGS.layout.pattern);
  });

  // ---- Agent integration: Codex's hook trust ------------------------------------------------

  test(
    "integration: an untrusted Codex install shows a warning; Re-trust clears it",
    async (app) => {
      const row = '[data-testid=integration-row][data-target="codex"]';
      await app.openSettings("agents");
      await waitFor(() => app.exists(row), 3000, "the rows");
      assertEquals(
        await app.exists(`${row} [data-testid=integration-warning]`),
        false,
        "not installed: no warning",
      );
      await app.click(`${row} [data-testid=integration-install]`);
      await waitFor(
        () => app.exists(`${row} [data-testid=integration-warning]`),
        3000,
        "the trust warning",
      );
      assertEquals(await app.attr(row, "data-trust"), "untrusted");
      const text = await app.eval(
        (s: string) => document.querySelector(s)?.textContent ?? "",
        `${row} [data-testid=integration-warning]`,
      );
      assert(text.includes("trusts none of"), text);
      await app.click(`${row} [data-testid=integration-retrust]`);
      await waitFor(
        async () =>
          !(await app.exists(`${row} [data-testid=integration-warning]`)),
        3000,
        "the warning gone",
      );
      assertEquals(await app.attr(row, "data-installed"), "true");
      assertEquals(await app.exists("[data-testid=integration-error]"), false);
    },
    { query: "codexTrust=untrusted" },
  );
});
