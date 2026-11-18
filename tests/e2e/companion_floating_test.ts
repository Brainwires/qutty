// The floating companion (Settings → Companion → Floating) against the demo backend. A browser
// page cannot open a window of its own, so here: Floating chosen (as the desktop app saves it)
// falls back to the companion in the window, says why in Settings and grays nothing the user
// already picked; and the floating window's own page (`/companion`) draws the companion on a
// transparent page, filling the window, and chats with the (demo) brain. The window itself
// (transparent, click-through, on top, dragged, its routing) is the desktop's:
// tests/companion_floating_test.ts covers its logic.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { suite, waitFor } from "./harness.ts";
import { SETTINGS_STORAGE_KEY } from "../../lib/workspace/store.ts";

const OVERLAY = "[data-testid=companion-overlay]";

suite("companion floating", (test) => {
  test("Floating in a browser: the companion stays in the window, and Settings says why", async (app) => {
    await waitFor(() => app.exists(OVERLAY), 3000, "the overlay");
    await app.eval((key: string) => {
      const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
      raw.companion = { ...(raw.companion ?? {}), mode: "floating" };
      localStorage.setItem(key, JSON.stringify(raw));
    }, SETTINGS_STORAGE_KEY);
    await app.reload();
    await waitFor(() => app.exists(OVERLAY), 3000, "the overlay again");
    assertEquals(await app.attr(OVERLAY, "data-floating"), null);
    assertEquals((await app.settings()).companion.mode, "floating");

    await app.openSettings("companion");
    const floating =
      '[data-testid=setting-companion-mode][data-value="floating"]';
    await waitFor(() => app.exists(floating), 2000, "the mode buttons");
    // Chosen, so not grayed out (the user can see what is picked), with the reason.
    assertEquals(await app.attr(floating, "aria-checked"), "true");
    assertEquals(await app.attr(floating, "disabled"), null);
    assertEquals(
      await app.attr(floating, "title"),
      "Floating needs the desktop app.",
    );
    const hint = await app.eval(() =>
      document.querySelector("[data-testid=companion-mode-hint]")
        ?.textContent ?? ""
    );
    assertStringIncludes(hint, "Floating needs the desktop app.");
    assertStringIncludes(hint, "sits in a corner of the window");
    // On every Space is the floating window's: off while it does not float.
    assertEquals(
      await app.attr("[data-testid=setting-companion-all-spaces]", "disabled"),
      "",
    );
    // Back to In window: Floating is grayed out now.
    await app.click(
      '[data-testid=setting-companion-mode][data-value="window"]',
    );
    await waitFor(
      async () => (await app.attr(floating, "disabled")) === "",
      2000,
      "Floating grayed out",
    );
    await app.closeSettings();
    assertEquals((await app.settings()).companion.mode, "window");
  });

  test("The floating window's page: the companion on a transparent page, and its chat", async (app) => {
    const page = await app.page.browser().newPage();
    try {
      await page.goto(`${app.origin}/companion/?pty=demo&test=1`, {
        waitUntil: "load",
      });
      const sel = `[data-testid=floating-companion] ${OVERLAY}`;
      await waitFor(
        () =>
          page.evaluate(
            (s: string) =>
              document.querySelector(s)?.getAttribute("data-floating") ===
                "true",
            { args: [sel] },
          ),
        5000,
        "the floating companion",
      );
      const look = await page.evaluate(() => ({
        floating: document.documentElement.dataset.floating ?? null,
        body: getComputedStyle(document.body).backgroundColor,
        html: getComputedStyle(document.documentElement).backgroundColor,
      }));
      assertEquals(look, {
        floating: "true",
        body: "rgba(0, 0, 0, 0)",
        html: "rgba(0, 0, 0, 0)",
      });
      // It sits at the page's bottom left, as wide as the window lets it.
      const box = await page.evaluate((s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return { left: r.left, bottom: innerHeight - r.bottom };
      }, { args: [sel] });
      assert(box.left < 12 && box.bottom < 12, JSON.stringify(box));

      // Click the companion, type, send: the demo brain answers in the bubble.
      await page.evaluate(() =>
        document.querySelector<HTMLElement>("[data-testid=companion-poke]")!
          .click()
      );
      await waitFor(
        () =>
          page.evaluate(() =>
            !!document.querySelector("[data-testid=companion-chat-input]")
          ),
        2000,
        "the chat box",
      );
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(
          "[data-testid=companion-chat-input]",
        )!;
        input.value = "hello there";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // Sent once the line has its text (a render later).
      await waitFor(
        () =>
          page.evaluate(() =>
            !document.querySelector<HTMLButtonElement>(
              "[data-testid=companion-chat-send]",
            )?.disabled
          ),
        2000,
        "the send button",
      );
      await page.evaluate(() =>
        document.querySelector<HTMLElement>(
          "[data-testid=companion-chat-send]",
        )!.click()
      );
      await waitFor(
        () =>
          page.evaluate(() =>
            document.querySelector("[data-testid=companion-bubble]")
              ?.getAttribute("data-kind") === "reply"
          ),
        8000,
        "the reply in the bubble",
      );
    } finally {
      await page.close();
    }
  });
});
