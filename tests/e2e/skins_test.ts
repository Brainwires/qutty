// Skins (Settings → Appearance → Skin): the built-in Classic skin restyles the chrome through
// `data-skin`, a user skin (the demo backend's) through an adopted stylesheet, a skin that fails
// its checks says why and Qutty's own look shows, and the tile frame options (window buttons
// left or right, the title's alignment) hold under every skin.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { SETTINGS_STORAGE_KEY } from "../../lib/workspace/store.ts";
import { type App, ROOT, suite, waitFor } from "./harness.ts";

/** The skin state on the document element, and the tokens that show whose colours are on. */
const docSkin = (app: App) =>
  app.eval(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    return {
      skin: root.getAttribute("data-skin"),
      buttons: root.getAttribute("data-frame-buttons"),
      title: root.getAttribute("data-frame-title"),
      theme: root.getAttribute("data-theme"),
      panel: css.getPropertyValue("--panel").trim(),
    };
  });

/** The focused tile's frame as drawn. */
const focusedFrame = (app: App) =>
  app.eval(() => {
    const tile = document.querySelector<HTMLElement>(
      "[data-testid=tile][data-focused=true]",
    )!;
    const head = tile.querySelector<HTMLElement>("[data-part=tile-head]")!;
    const title = tile.querySelector<HTMLElement>("[data-part=tile-title]")!;
    const x = (name: string) =>
      tile.querySelector<HTMLElement>(
        `[data-part=tile-button][data-button=${name}]`,
      )!.getBoundingClientRect().left;
    const headCss = getComputedStyle(head);
    const tileCss = getComputedStyle(tile);
    return {
      headImage: headCss.backgroundImage,
      headWeight: headCss.fontWeight,
      headHeight: headCss.height,
      radius: tileCss.borderTopLeftRadius,
      borderStyle: tileCss.borderTopStyle,
      borderWidth: tileCss.borderTopWidth,
      titleAlign: getComputedStyle(title).textAlign,
      titleX: title.getBoundingClientRect().left,
      minimize: x("minimize"),
      maximize: x("maximize"),
      close: x("close"),
      background: (globalThis as unknown as {
        __e2e: { terminal(id: string): { background: string } | null };
      }).__e2e.terminal(tile.dataset.id!)?.background,
    };
  });

async function pickSkin(app: App, id: string): Promise<void> {
  await app.openSettings("appearance");
  await waitFor(
    () => app.exists(`[data-testid=setting-skin][data-value="${id}"]`),
    3000,
    `the ${id} skin in the picker`,
  );
  await app.click(`[data-testid=setting-skin][data-value="${id}"]`);
  await waitFor(
    async () => (await docSkin(app)).skin === id,
    3000,
    `skin ${id}`,
  );
}

/** Store skin settings as an earlier session would have, then reload. */
async function storeSkin(
  app: App,
  skin: Record<string, unknown>,
): Promise<void> {
  await app.eval(
    (k: string, skin: Record<string, unknown>) => {
      const s = JSON.parse(localStorage.getItem(k) ?? "{}");
      localStorage.setItem(k, JSON.stringify({ ...s, skin }));
    },
    SETTINGS_STORAGE_KEY,
    skin,
  );
  await app.reload();
}

suite("skins", (test) => {
  test("skins: Qutty by default; the picker lists the built-ins and the user's skins", async (app) => {
    assertEquals(await docSkin(app), {
      skin: "qutty",
      buttons: "right",
      title: "left",
      theme: "sea-glass",
      panel: "#151b23",
    });
    await app.openSettings("appearance");
    await waitFor(
      () => app.exists('[data-testid=setting-skin][data-source="user"]'),
      3000,
      "the user's skins",
    );
    const choices = await app.eval(() =>
      [...document.querySelectorAll<HTMLElement>("[data-testid=setting-skin]")]
        .map((b) => [
          b.dataset.value,
          b.dataset.source,
          b.getAttribute("aria-checked"),
        ])
    );
    assertEquals(choices, [
      ["qutty", "builtin", "true"],
      ["classic", "builtin", "false"],
      ["blueprint", "user", "false"],
    ]);
    // The folder that is not a usable skin, with the reason.
    const problem = await app.eval(() =>
      document.querySelector(
        '[data-testid=skin-problems] [data-folder="remote-import"]',
      )?.textContent ?? ""
    );
    assertStringIncludes(problem, "@import is not allowed");
    assert(!(await app.exists("[data-testid=skin-error]")));
    // The window buttons are where they always were: minimize, maximize, close, after the title.
    const f = await focusedFrame(app);
    assert(f.titleX < f.minimize && f.minimize < f.maximize);
    assert(f.maximize < f.close);
    assertEquals(f.titleAlign, "start");
  });

  test("skins: Classic sets data-skin and redraws a tile's header, with its own colours", async (app) => {
    await app.ensureTerminals(2);
    const before = await focusedFrame(app);
    assertEquals(before.headImage, "none");
    assertEquals(before.radius, "8px");
    await pickSkin(app, "classic");
    const doc = await docSkin(app);
    assertEquals(doc.skin, "classic");
    assertEquals(doc.panel, "#c0c0c0");
    assertEquals(doc.theme, "paper");
    const f = await focusedFrame(app);
    // A gradient title bar, bold, on a square frame.
    assertStringIncludes(f.headImage, "linear-gradient");
    assertStringIncludes(f.headImage, "rgb(0, 0, 128)");
    assertEquals(f.headWeight, "700");
    assertEquals(f.radius, "0px");
    // The geometry the layout counts on is untouched.
    assertEquals([before.headHeight, f.headHeight], ["26px", "26px"]);
    assertEquals(f.borderWidth, "1px");
    assertEquals(f.background, "#ffffff");
    // Its window buttons still work.
    await app.closeSettings();
    await app.settle();
    await app.screenshot(
      join(ROOT, "tests/e2e/__screenshots__/skin-classic.png"),
    );
    const id = (await app.focusedId())!;
    await app.click(
      `[data-testid=tile][data-id="${id}"] [data-button=maximize]`,
    );
    await waitFor(
      () => app.exists(`[data-testid=tile][data-id="${id}"][data-maximized]`),
      2000,
      "maximized",
    );
    await app.click(
      `[data-testid=tile][data-id="${id}"] [data-button=restore]`,
    );
    await app.click(`[data-testid=tile][data-id="${id}"] [data-button=close]`);
    await waitFor(
      async () => (await app.tiles()).every((t) => t.id !== id),
      2000,
      "closed",
    );
    // It survives a reload, at the first paint of the restored page.
    await waitFor(
      async () => (await app.settings()).skin.id === "classic",
      2000,
      "persisted",
    );
    await app.reload();
    assertEquals((await docSkin(app)).skin, "classic");
    assertStringIncludes(
      (await focusedFrame(app)).headImage,
      "linear-gradient",
    );
    // Without the skin's colours the shapes stay and the chosen theme is back.
    await app.openSettings("appearance");
    await app.screenshot(
      join(ROOT, "tests/e2e/__screenshots__/skin-classic-settings.png"),
    );
    await app.click("[data-testid=setting-skin-colors]");
    await waitFor(
      async () => (await docSkin(app)).panel === "#151b23",
      2000,
      "the theme's colours",
    );
    const plain = await docSkin(app);
    assertEquals([plain.skin, plain.theme], ["classic", "sea-glass"]);
    assertEquals((await focusedFrame(app)).radius, "0px");
    // And Qutty's own look comes back whole.
    await pickSkin(app, "qutty");
    const after = await focusedFrame(app);
    assertEquals(after.headImage, "none");
    assertEquals(after.radius, "8px");
  });

  test("skins: a user skin applies its stylesheet, colours and frame defaults", async (app) => {
    await pickSkin(app, "blueprint");
    await waitFor(
      async () => (await focusedFrame(app)).borderStyle === "dashed",
      3000,
      "the skin's stylesheet",
    );
    const doc = await docSkin(app);
    // Its skin.json pairs it with Plum and puts the buttons left, the title centred.
    assertEquals(doc.theme, "plum");
    assertEquals([doc.buttons, doc.title], ["left", "center"]);
    const f = await focusedFrame(app);
    assertStringIncludes(f.headImage, "data:image/png");
    assertEquals(f.titleAlign, "center");
    assert(f.close < f.minimize && f.minimize < f.maximize);
    assert(f.maximize < f.titleX);
    assertEquals(
      await app.eval(() =>
        document.querySelector("[data-testid=skin-desc]")?.textContent
      ),
      "Dashed frames and centred titles, on the Plum theme. By Qutty demo.",
    );
    // It comes back after a reload (fetched again from the backend).
    await waitFor(
      async () => (await app.settings()).skin.id === "blueprint",
      2000,
      "persisted",
    );
    await app.reload();
    await waitFor(
      async () => (await focusedFrame(app)).borderStyle === "dashed",
      3000,
      "the skin after a reload",
    );
    // Back to Qutty: the stylesheet goes with it.
    await pickSkin(app, "qutty");
    assertEquals((await focusedFrame(app)).borderStyle, "solid");
  });

  test("skins: a skin that fails its checks shows why and falls back to Qutty", async (app) => {
    await storeSkin(app, { id: "remote-import" });
    await app.openSettings("appearance");
    await waitFor(
      () => app.exists("[data-testid=skin-error]"),
      3000,
      "the error",
    );
    const error = await app.eval(() =>
      document.querySelector("[data-testid=skin-error]")!.textContent ?? ""
    );
    assertStringIncludes(error, "remote-import");
    assertStringIncludes(error, "@import is not allowed");
    assertEquals((await docSkin(app)).skin, "qutty");
    assertEquals((await focusedFrame(app)).headImage, "none");
    // A skin that is not there at all, and junk in storage.
    await storeSkin(app, { id: "gone" });
    await app.openSettings("appearance");
    await waitFor(
      () => app.exists("[data-testid=skin-error]"),
      3000,
      "the error",
    );
    assertStringIncludes(
      await app.eval(() =>
        document.querySelector("[data-testid=skin-error]")!.textContent ?? ""
      ),
      "was not found",
    );
    assertEquals((await docSkin(app)).skin, "qutty");
    await storeSkin(app, { id: "../../etc", frameButtons: "top" });
    const s = (await app.settings()).skin;
    assertEquals([s.id, s.frameButtons], ["qutty", "skin"]);
    // Picking a good skin clears the error.
    await pickSkin(app, "classic");
    assert(!(await app.exists("[data-testid=skin-error]")));
  });

  test("frame: the window buttons go left or right, under Qutty and under Classic", async (app) => {
    await app.ensureTerminals(2);
    await app.openSettings("appearance");
    for (const skin of ["qutty", "classic"]) {
      await pickSkin(app, skin);
      await app.choose("[data-testid=setting-frame-buttons]", "left");
      await waitFor(
        async () => (await docSkin(app)).buttons === "left",
        2000,
        "buttons left",
      );
      let f = await focusedFrame(app);
      // On the left Close is outermost, and the whole group is ahead of the title.
      assert(f.close < f.minimize && f.minimize < f.maximize, skin);
      assert(f.maximize < f.titleX, skin);
      await app.choose("[data-testid=setting-frame-buttons]", "right");
      await waitFor(
        async () => (await docSkin(app)).buttons === "right",
        2000,
        "buttons right",
      );
      f = await focusedFrame(app);
      assert(f.titleX < f.minimize && f.minimize < f.maximize, skin);
      assert(f.maximize < f.close, skin);
      await app.choose("[data-testid=setting-frame-buttons]", "skin");
      await waitFor(
        async () => (await app.settings()).skin.frameButtons === "skin",
        2000,
        "the skin's default",
      );
    }
    // The buttons act from the left as well, on an unfocused tile too.
    await app.choose("[data-testid=setting-frame-buttons]", "left");
    await app.closeSettings();
    await app.settle();
    const other = (await app.tiles()).find((t) => !t.focused)!;
    await app.click(
      `[data-testid=tile][data-id="${other.id}"] [data-button=close]`,
    );
    await waitFor(
      async () => (await app.tiles()).every((t) => t.id !== other.id),
      2000,
      "closed from the left",
    );
    // The choice is kept.
    await app.reload();
    assertEquals((await docSkin(app)).buttons, "left");
  });

  test("frame: the title aligns left, center or right, over the skin's default", async (app) => {
    await app.openSettings("appearance");
    for (const align of ["center", "right", "left"]) {
      await app.choose("[data-testid=setting-frame-title]", align);
      await waitFor(
        async () => (await docSkin(app)).title === align,
        2000,
        `title ${align}`,
      );
      assertEquals(
        (await focusedFrame(app)).titleAlign,
        align === "left" ? "start" : align,
      );
    }
    // "Skin default" names what the skin does; the user's choice wins over it.
    await pickSkin(app, "blueprint");
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLSelectElement>(
          "[data-testid=setting-frame-title]",
        )!.selectedOptions[0].textContent
      ),
      "Left",
    );
    assertEquals((await docSkin(app)).title, "left");
    await app.choose("[data-testid=setting-frame-title]", "skin");
    await waitFor(
      async () => (await docSkin(app)).title === "center",
      2000,
      "the skin's centred title",
    );
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLSelectElement>(
          "[data-testid=setting-frame-title]",
        )!.selectedOptions[0].textContent
      ),
      "Skin default (center)",
    );
  });

  test("skins: Start from Classic copies it as a user skin that looks the same", async (app) => {
    await app.openSettings("appearance");
    await waitFor(
      () => app.exists('[data-testid=setting-skin][data-source="user"]'),
      3000,
      "the user's skins",
    );
    await app.click("[data-testid=skins-start-classic]");
    await waitFor(
      () => app.exists('[data-testid=setting-skin][data-value="my-classic"]'),
      3000,
      "the copy in the picker",
    );
    assertStringIncludes(
      await app.eval(() =>
        document.querySelector("[data-testid=skins-note]")!.textContent ?? ""
      ),
      "my-classic",
    );
    await pickSkin(app, "my-classic");
    await waitFor(
      async () =>
        (await focusedFrame(app)).headImage.includes("linear-gradient"),
      3000,
      "the copy's stylesheet",
    );
    const f = await focusedFrame(app);
    assertEquals(f.radius, "0px");
    assertEquals((await docSkin(app)).panel, "#c0c0c0");
    // A second copy gets its own name; the folder buttons answer.
    await app.click("[data-testid=skins-start-classic]");
    await waitFor(
      () => app.exists('[data-testid=setting-skin][data-value="my-classic-2"]'),
      3000,
      "the second copy",
    );
    await app.click("[data-testid=skins-reload]");
    await app.click("[data-testid=skins-open-folder]");
    assert(
      await app.exists('[data-testid=setting-skin][data-value="my-classic"]'),
    );
  });
});
