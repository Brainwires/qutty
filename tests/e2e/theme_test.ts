// Colour themes (live switching of the chrome and every xterm, persistence) and where Settings
// keeps them (Appearance, with the font; the shortcut list under General).

import { assert, assertEquals } from "@std/assert";
import { SETTINGS_STORAGE_KEY } from "../../lib/workspace/store.ts";
import { THEME_IDS, themeById } from "../../lib/workspace/themes.ts";
import { type App, suite, waitFor } from "./harness.ts";

/** The document's theme as the page sees it. */
const docTheme = (app: App) =>
  app.eval(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    return {
      id: root.getAttribute("data-theme"),
      ink: css.getPropertyValue("--ink").trim(),
      accent: css.getPropertyValue("--accent").trim(),
      scheme: css.colorScheme,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });

/** Every terminal's xterm theme background, by id. */
const terminalBackgrounds = (app: App) =>
  app.eval(() => {
    const hooks = (globalThis as unknown as {
      __e2e: { terminal(id: string): { background: string } | null };
    }).__e2e;
    const out: Record<string, string> = {};
    for (
      const el of document.querySelectorAll<HTMLElement>("[data-testid=tile]")
    ) {
      out[el.dataset.id!] = hooks.terminal(el.dataset.id!)?.background ?? "";
    }
    return out;
  });

/** `#rrggbb` → the `rgb(r, g, b)` getComputedStyle reports. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function setTheme(app: App, id: string): Promise<void> {
  await app.openSettings("appearance");
  await app.click(`[data-testid=setting-theme][data-value="${id}"]`);
  await waitFor(
    async () => (await docTheme(app)).id === id,
    2000,
    `theme ${id}`,
  );
}

async function assertTheme(app: App, id: string): Promise<void> {
  const want = themeById(id);
  const doc = await docTheme(app);
  assertEquals(doc.id, id);
  assertEquals(doc.ink, want.chrome["--ink"]);
  assertEquals(doc.accent, want.chrome["--accent"]);
  assertEquals(doc.scheme, want.scheme);
  assertEquals(doc.body, rgb(want.chrome["--ink"]));
  const bgs = await terminalBackgrounds(app);
  assert(Object.keys(bgs).length > 0, "some terminals");
  for (const [tid, bg] of Object.entries(bgs)) {
    assertEquals(bg, want.terminal.background, `terminal ${tid}`);
  }
  assertEquals(
    await app.attr(
      "[data-testid=setting-theme][aria-checked=true]",
      "data-value",
    ) ?? id,
    id,
  );
}

suite("theme", (test) => {
  // ---- Themes ---------------------------------------------------------------------------------

  test("theme: Sea Glass by default, with six tiles in a dark and a light group", async (app) => {
    await assertTheme(app, "sea-glass");
    await app.openSettings("appearance");
    const groups = await app.eval(() =>
      [...document.querySelectorAll<HTMLElement>(".theme-group")].map((g) => ({
        scheme: g.dataset.scheme,
        label: g.querySelector(".theme-group-label")?.textContent,
        ids: [...g.querySelectorAll<HTMLElement>("[data-testid=setting-theme]")]
          .map((b) => b.dataset.value),
      }))
    );
    assertEquals(groups, [
      {
        scheme: "dark",
        label: "Dark",
        ids: ["sea-glass", "plum", "ember"],
      },
      {
        scheme: "light",
        label: "Light",
        ids: ["paper", "cloud", "sakura"],
      },
    ]);
    assertEquals(
      await app.attr(
        "[data-testid=setting-theme][aria-checked=true]",
        "data-value",
      ),
      "sea-glass",
    );
  });

  test("theme: switching recolours the chrome and every terminal, parked ones too", async (app) => {
    await app.ensureTerminals(3);
    await app.setSlider("maxVisible", 2);
    for (const id of ["paper", "plum", "sakura", "sea-glass"]) {
      await setTheme(app, id);
      await assertTheme(app, id);
    }
    // A terminal created afterwards starts in the current theme.
    await setTheme(app, "ember");
    await app.closeSettings();
    await app.newTerminal();
    await assertTheme(app, "ember");
    // The focused tile's border is the theme's accent.
    const border = await app.eval(() =>
      getComputedStyle(
        document.querySelector("[data-testid=tile][data-focused=true]")!,
      ).borderTopColor
    );
    assertEquals(border, rgb(themeById("ember").chrome["--accent"]));
  });

  test("theme: tiles are keyboard operable", async (app) => {
    await app.openSettings("appearance");
    await app.eval(() =>
      document.querySelector<HTMLElement>(
        '[data-testid=setting-theme][data-value="cloud"]',
      )!.focus()
    );
    await app.press("Enter");
    await waitFor(
      async () => (await docTheme(app)).id === "cloud",
      2000,
      "cloud via Enter",
    );
    await app.eval(() =>
      document.querySelector<HTMLElement>(
        '[data-testid=setting-theme][data-value="plum"]',
      )!.focus()
    );
    await app.press("Space");
    await waitFor(
      async () => (await docTheme(app)).id === "plum",
      2000,
      "plum via Space",
    );
    await assertTheme(app, "plum");
  });

  test("theme: survives a reload; an unknown stored theme falls back to Sea Glass", async (app) => {
    await app.ensureTerminals(2);
    await setTheme(app, "cloud");
    await waitFor(
      async () => (await app.settings()).theme === "cloud",
      2000,
      "persisted",
    );
    await app.reload();
    await assertTheme(app, "cloud");
    await app.eval(
      (k: string) => {
        const s = JSON.parse(localStorage.getItem(k)!);
        localStorage.setItem(k, JSON.stringify({ ...s, theme: "solarized" }));
      },
      SETTINGS_STORAGE_KEY,
    );
    await app.reload();
    await assertTheme(app, "sea-glass");
    assertEquals(THEME_IDS.includes((await app.settings()).theme), true);
  });

  // ---- Where they are in Settings --------------------------------------------------------

  test("settings: the theme and the font are in Appearance, the shortcut list in General", async (app) => {
    await app.openSettings("appearance");
    const groups = await app.eval(() =>
      [
        ...document.querySelectorAll(
          '[data-testid=settings-category][data-tab="appearance"] .settings-group-title',
        ),
      ].map((h) => h.textContent)
    );
    assertEquals(groups, ["Theme", "Skin", "Font", "Zoom", "Inactive tiles"]);
    assert(
      await app.exists(
        "[data-testid=theme-section] [data-testid=setting-theme]",
      ),
    );
    assert(
      await app.exists("[data-testid=font-section] [data-testid=font-list]"),
    );
    await app.settingsTab("general");
    assert(
      await app.eval(() =>
        !!document.querySelector(
          '[data-testid=settings-category][data-tab="general"] [data-testid=shortcuts-section] .shortcuts',
        )
      ),
    );
  });
});
