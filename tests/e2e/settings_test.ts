// The settings popover (open/close, live sliders) and persistence across reloads.

import { assert, assertEquals } from "@std/assert";
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

  test("panel: the settings button toggles it", async (app) => {
    await app.click("[data-testid=bar-settings]");
    await waitFor(() => panelOpen(app), 2000, "open");
    await app.click("[data-testid=bar-settings]");
    await waitFor(async () => !(await panelOpen(app)), 2000, "closed again");
  });

  test("panel: Escape closes it", async (app) => {
    await app.openSettings();
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

  test("panel: an outside click closes it; inside clicks do not", async (app) => {
    await app.openSettings();
    await app.click("[data-testid=setting-pattern][data-pattern=rows]");
    await app.click("[data-testid=setting-bar-order][data-value=created]");
    assert(await panelOpen(app), "still open after inside clicks");
    const r = (await app.rectOf("[data-testid=cluster]"))!;
    const panel = (await app.rectOf("[data-testid=settings-panel]"))!;
    // A cluster point away from the panel.
    const x = panel.x > r.x + 200 ? r.x + 100 : r.right - 100;
    await app.clickAt(x, r.bottom - 100);
    await waitFor(
      async () => !(await panelOpen(app)),
      2000,
      "closed by outside click",
    );
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
    await app.openSettings();
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
    await app.openSettings();
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
});
