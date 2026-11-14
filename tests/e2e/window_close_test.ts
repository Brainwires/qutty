// The window's close button (app/use-window-close.ts, app/close-window-dialog.tsx): the demo has
// no window to close, so `__e2e.requestClose` asks the page's close guard as Denext would, and
// `__e2e.windowCalls` records what the page then did (`close`: Keep Running, the window detaches;
// `end:confirm`: its shells end, a busy agent asked about first). Settings → Windows changes the
// remembered choice.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

type Reason = "close" | "quit";

const requestClose = (app: App, reason: Reason = "close") =>
  app.eval(
    (r: Reason) =>
      (globalThis as unknown as {
        __e2e: { requestClose(r: Reason): Promise<boolean> };
      }).__e2e.requestClose(r),
    reason,
  );

const windowCalls = (app: App) =>
  app.eval(() => [
    ...(globalThis as unknown as { __e2e: { windowCalls: string[] } }).__e2e
      .windowCalls,
  ]);

const dialogOpen = (app: App) => app.exists("[data-testid=close-window]");

const activeTestId = (app: App) =>
  app.eval(() => document.activeElement?.getAttribute("data-testid") ?? null);

/** Click the close button with the setting at "ask": the question comes up. */
async function ask(app: App): Promise<void> {
  assertEquals(await requestClose(app), false, "the window is kept open");
  await waitFor(() => dialogOpen(app), 2000, "the close question");
}

/** Pick `value` in Settings → Windows. */
async function setWindowClose(app: App, value: string): Promise<void> {
  await app.openSettings();
  await app.eval((v: string) => {
    const el = document.querySelector<HTMLSelectElement>(
      "[data-testid=setting-window-close]",
    )!;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await waitFor(
    async () => (await app.settings()).windowClose === value,
    2000,
    `windowClose ${value}`,
  );
  await app.closeSettings();
}

suite("window close", (test) => {
  test("ask: the question lists the terminals; Return keeps them running and closes the window", async (app) => {
    await app.ensureTerminals(3);
    await ask(app);
    assertEquals(
      await app.attr("[data-testid=close-window]", "aria-label"),
      "Close this window?",
    );
    assert(
      (await app.eval(() =>
        document.querySelector("[data-testid=close-window-count]")!.textContent
      ))!.includes("3 terminals"),
    );
    // Keep Running is the default and has the focus.
    await waitFor(
      async () => (await activeTestId(app)) === "close-window-keep",
      2000,
      "Keep Running focused",
    );
    // A workspace shortcut does nothing while it is up.
    const tiles = await app.count("[data-testid=chip]");
    await app.shortcut("KeyT");
    assertEquals(await app.count("[data-testid=chip]"), tiles);
    await app.press("Enter");
    await waitFor(
      async () => (await windowCalls(app)).join() === "close",
      2000,
      "the window closed (detached)",
    );
    assert(!(await dialogOpen(app)));
    assertEquals(await app.kills(), [], "no shell was ended");
    assertEquals((await app.settings()).windowClose, "ask", "not remembered");
  });

  test("ask: Return on the checkbox is Keep Running too; Tab stays in the question", async (app) => {
    await ask(app);
    await app.eval(() =>
      document.querySelector<HTMLElement>(
        "[data-testid=close-window-remember]",
      )!.focus()
    );
    // Tab walks the question's controls and wraps; it never reaches a terminal.
    const seen = new Set<string | null>();
    for (let i = 0; i < 6; i++) {
      await app.press("Tab");
      seen.add(await activeTestId(app));
    }
    assertEquals(
      [...seen].sort(),
      [
        "close-window-cancel",
        "close-window-end",
        "close-window-keep",
        "close-window-remember",
      ],
    );
    await app.eval(() =>
      document.querySelector<HTMLElement>(
        "[data-testid=close-window-remember]",
      )!.focus()
    );
    await app.press("Enter");
    await waitFor(
      async () => (await windowCalls(app)).join() === "close",
      2000,
      "Keep Running",
    );
  });

  test("ask: Escape cancels and never remembers; the keyboard goes back to the terminal", async (app) => {
    const id = (await app.focusedId())!;
    await ask(app);
    await app.click("[data-testid=close-window-remember]");
    await app.press("Escape");
    await waitFor(async () => !(await dialogOpen(app)), 2000, "cancelled");
    assertEquals(await windowCalls(app), []);
    assertEquals((await app.settings()).windowClose, "ask");
    await waitFor(() => app.xtermHasFocus(id), 3000, "the terminal's focus");
    // Cancel asks again next time; so does a click on the button.
    await ask(app);
    await app.click("[data-testid=close-window-cancel]");
    await waitFor(async () => !(await dialogOpen(app)), 2000, "cancelled");
    assertEquals(await windowCalls(app), []);
    await ask(app);
  });

  test("ask: a second click while asking closes the window as before; a quit is never held", async (app) => {
    assertEquals(await requestClose(app, "quit"), true);
    assert(!(await dialogOpen(app)), "a quit asks nothing here");
    await ask(app);
    assertEquals(
      await requestClose(app),
      true,
      "the second click goes through",
    );
    assertEquals(await requestClose(app, "quit"), true);
    assertEquals(await windowCalls(app), [], "Denext closes it, not the page");
  });

  test("end, remembered: the shells end, and the next close ends them without asking", async (app) => {
    await ask(app);
    await app.click("[data-testid=close-window-remember]");
    await app.click("[data-testid=close-window-end]");
    await waitFor(
      async () => (await windowCalls(app)).join() === "end:confirm",
      2000,
      "End Shells",
    );
    assert(!(await dialogOpen(app)));
    await waitFor(
      async () => (await app.settings()).windowClose === "end",
      2000,
      "remembered",
    );
    // Settings → Windows shows the remembered choice.
    await app.openSettings();
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLSelectElement>(
          "[data-testid=setting-window-close]",
        )!.value
      ),
      "end",
    );
    await app.closeSettings();
    assertEquals(await requestClose(app), false);
    await waitFor(
      async () => (await windowCalls(app)).join() === "end:confirm,end:confirm",
      2000,
      "ended without asking",
    );
    assert(!(await dialogOpen(app)));
    // A quit still goes through untouched.
    assertEquals(await requestClose(app, "quit"), true);
  });

  test("settings: Keep shells running closes without asking; Ask each time asks again", async (app) => {
    await setWindowClose(app, "keep");
    assertEquals(await requestClose(app), true);
    assert(!(await dialogOpen(app)));
    assertEquals(await windowCalls(app), []);
    // Remembered across a reload.
    await app.reload();
    assertEquals(await requestClose(app), true);
    await setWindowClose(app, "ask");
    await ask(app);
    // Remember + Keep Running saves "keep".
    await app.click("[data-testid=close-window-remember]");
    await app.click("[data-testid=close-window-keep]");
    await waitFor(
      async () => (await app.settings()).windowClose === "keep",
      2000,
      "remembered keep",
    );
  });
});
