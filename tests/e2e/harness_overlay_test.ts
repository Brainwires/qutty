// The harness overlay (app/harness-overlay.tsx) against the demo backend: a demo Claude Code from
// the `+` picker (a demo agent turns bracketed paste on and says when a line came in a paste,
// lib/pty-client.ts) gets the header card, the prompt box and the side rail around its terminal;
// a plain shell does not. Sending types into the terminal; Interrupt sends Esc; the terminal
// refits as the prompt box grows; the tile's menus and Settings → Tiles turn it off and on, and
// the xterm is never remounted by it. A screenshot of each theme goes to tests/e2e/__screenshots__
// (and `HARNESS_SHOT_DIR` when set).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { launchAgent } from "./agent_helpers.ts";
import { rightClick } from "./link_helpers.ts";

const SHOT_DIRS = [
  join(ROOT, "tests/e2e/__screenshots__"),
  ...(Deno.env.get("HARNESS_SHOT_DIR")
    ? [Deno.env.get("HARNESS_SHOT_DIR")!]
    : []),
];

const inTile = (id: string, testid: string) =>
  `${tileSel(id)} [data-testid=${testid}]`;

/** Whether tile `id` wears the overlay. */
function hasOverlay(app: App, id: string): Promise<boolean> {
  return app.exists(inTile(id, "harness-frame"));
}

function waitOverlay(app: App, id: string, on: boolean) {
  return waitFor(
    async () => (await hasOverlay(app, id)) === on,
    5000,
    `${id}'s overlay ${on ? "shown" : "gone"}`,
  );
}

/** Give the prompt box of tile `id` the keyboard by clicking it. */
async function clickPrompt(app: App, id: string): Promise<void> {
  await app.click(inTile(id, "harness-input"));
  await waitFor(
    () =>
      app.eval(
        (s: string) => document.activeElement === document.querySelector(s),
        inTile(id, "harness-input"),
      ),
    2000,
    "the prompt box focused",
  );
}

/** The middle of tile `id`'s header (its title, or the overlay's card). */
function headerPoint(app: App, id: string) {
  return app.eval((s: string) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, `${tileSel(id)} .tile-head`);
}

/** Tile `id`'s terminal rows once its fit has settled (the same twice, a moment apart). */
async function settledRows(app: App, id: string): Promise<number> {
  let last = -1;
  return await waitFor(
    async () => {
      await app.settle();
      await new Promise((r) => setTimeout(r, 300));
      const rows = (await app.terminal(id))!.rows;
      const same = rows === last;
      last = rows;
      return same ? rows : null;
    },
    5000,
    "the terminal's size settled",
  );
}

/** Right-click tile `id`'s header until its menu shows `item`. */
async function headMenu(app: App, id: string, item: string): Promise<void> {
  await waitFor(
    async () => {
      if (await app.exists(item)) return true;
      await rightClick(app, await headerPoint(app, id));
      return await waitFor(() => app.exists(item), 700, "menu").catch(() =>
        false
      );
    },
    4000,
    "the header menu",
  );
}

async function shot(app: App, name: string): Promise<void> {
  for (const dir of SHOT_DIRS) {
    await Deno.mkdir(dir, { recursive: true });
    await app.screenshot(join(dir, name));
  }
}

suite("harness overlay", (test) => {
  test("a harness tile gets the overlay, a shell does not; the terminal keeps the keyboard", async (app) => {
    const shell = (await app.focusedId())!;
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    assertEquals(await app.attr(tileSel(claude), "data-harness"), "claude");
    assertEquals(await hasOverlay(app, shell), false);
    assertEquals(await app.attr(tileSel(shell), "data-harness"), null);
    // The header card: the harness, its hub name, its status.
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector(s)?.textContent,
        inTile(claude, "harness-label"),
      ),
      "Claude Code",
    );
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector<HTMLInputElement>(s)?.value,
        inTile(claude, "harness-name"),
      ),
      "claude",
    );
    await waitFor(
      async () =>
        (await app.attr(inTile(claude, "harness-status"), "data-status")) ===
          "idle",
      3000,
      "idle",
    );
    // The terminal is the harness's own and still has the keyboard.
    assert(await app.xtermHasFocus(claude), "the terminal keeps focus");
    await app.typeInTerminal(claude, "typed in the terminal\n");
    await app.waitForText(claude, "claude heard: typed in the terminal");

    // Rename it from the card (its hub name, as the agent badge shows).
    await app.click(inTile(claude, "harness-name"));
    await app.eval((s: string) => {
      const el = document.querySelector<HTMLInputElement>(s)!;
      el.value = "builder";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, inTile(claude, "harness-name"));
    await app.press("Enter");
    await waitFor(
      () =>
        app.eval(
          (s: string) =>
            document.querySelector(s)?.querySelector(".tile-agent-name")
              ?.textContent === "builder",
          inTile(claude, "tile-agent-badge"),
        ),
      3000,
      "renamed in the hub",
    );
    await shot(app, "harness-overlay-dark.png");
  });

  test("send types the prompt into the terminal as a paste, then Enter; Interrupt sends Esc", async (app) => {
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    const rows = await settledRows(app, claude);
    await clickPrompt(app, claude);
    await app.page.keyboard.type("fix the build");
    // Shift+Enter is a new line in the box (not a send), and the terminal refits as it grows.
    for (let i = 0; i < 4; i++) {
      await app.page.keyboard.down("Shift");
      await app.press("Enter");
      await app.page.keyboard.up("Shift");
    }
    await app.page.keyboard.type("and the tests");
    await waitFor(
      async () => (await app.terminal(claude))!.rows < rows,
      3000,
      "the terminal refitted above the taller prompt box",
    );
    assert(!(await app.readTerminalText(claude)).includes("fix the build"));
    await app.press("Enter");
    // Bracketed paste (the demo agent turned it on): the line breaks are text, one Enter sends.
    await app.waitForText(
      claude,
      /claude heard \(pasted\): fix the build +and the tests/,
    );
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector<HTMLTextAreaElement>(s)?.value,
        inTile(claude, "harness-input"),
      ),
      "",
    );
    // The box shrank back, and the terminal grew back.
    await waitFor(
      async () => (await app.terminal(claude))!.rows === rows,
      3000,
      "the terminal refitted back",
    );
    // The Send button does the same.
    await app.page.keyboard.type("again");
    await app.click(inTile(claude, "harness-send"));
    await app.waitForText(claude, "claude heard (pasted): again");
    // ↑ brings the last prompt back.
    await clickPrompt(app, claude);
    await app.press("ArrowUp");
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector<HTMLTextAreaElement>(s)?.value,
        inTile(claude, "harness-input"),
      ),
      "again",
    );
    // Interrupt: Esc to the harness.
    await app.click(inTile(claude, "harness-interrupt"));
    await app.waitForText(claude, "(demo) interrupted");
    // A click in the terminal gives it the keyboard back.
    await app.click(inTile(claude, "tile-body"));
    await waitFor(() => app.xtermHasFocus(claude), 2000, "terminal focus");
    // The rail's maximize.
    await app.click(inTile(claude, "harness-maximize"));
    await waitFor(
      async () =>
        (await app.attr(tileSel(claude), "data-maximized")) === "true",
      3000,
      "maximized",
    );
  });

  test("toggle: the overlay's menu hides it, the header menu brings it back; the xterm stays", async (app) => {
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    assert(await app.tagXterm(claude, "same-xterm"));
    await app.click(inTile(claude, "harness-menu"));
    await app.click(inTile(claude, "harness-hide"));
    await waitOverlay(app, claude, false);
    assertEquals(await app.attr(tileSel(claude), "data-harness"), null);
    assertEquals(await app.xtermTag(claude), "same-xterm");
    // The header's right-click menu: "GUI overlay", unchecked now.
    const item = '[data-testid=tile-move-menu-item][data-action="gui-overlay"]';
    await headMenu(app, claude, item);
    assertEquals(await app.attr(item, "aria-checked"), "false");
    await app.click(item);
    await waitOverlay(app, claude, true);
    assertEquals(await app.xtermTag(claude), "same-xterm");
    // And off again from the same item, checked now.
    await headMenu(app, claude, item);
    assertEquals(await app.attr(item, "aria-checked"), "true");
    await app.click(item);
    await waitOverlay(app, claude, false);
    // The terminal still works.
    await app.typeInTerminal(claude, "still here\n");
    await app.waitForText(claude, "claude heard: still here");
    // A plain shell's header menu has no such item (and, alone in the demo, no menu at all).
    const shell = (await app.chips()).find((c) => c.id !== claude)!.id;
    await rightClick(app, await headerPoint(app, shell));
    await new Promise((r) => setTimeout(r, 300));
    assert(!(await app.exists(item)));
  });

  test("settings: Tiles → Show a GUI around agent harnesses, on by default", async (app) => {
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    await app.openSettings("tiles");
    const toggle = "[data-testid=setting-harness-overlay]";
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector<HTMLInputElement>(s)?.checked,
        toggle,
      ),
      true,
    );
    await app.click(toggle);
    await waitFor(
      async () => (await app.settings()).harnessOverlay === false,
      2000,
      "saved off",
    );
    await app.closeSettings();
    await waitOverlay(app, claude, false);
    // The overlay's own menu links back to the setting.
    await app.openSettings("tiles");
    await app.click(toggle);
    await app.closeSettings();
    await waitOverlay(app, claude, true);
    await app.click(inTile(claude, "harness-menu"));
    await app.click(inTile(claude, "harness-settings"));
    await waitFor(
      () =>
        app.exists(
          "[data-testid=settings-panel] [data-testid=harness-section]",
        ),
      2000,
      "Settings at the overlay's switch",
    );
  });

  test("a harness that exits takes its overlay (and, quitting cleanly, its tile) with it", async (app) => {
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    await clickPrompt(app, claude);
    await app.page.keyboard.type("/exit");
    await app.press("Enter");
    await waitFor(
      async () => !(await app.exists(tileSel(claude))),
      5000,
      "the tile gone",
    );
    assertEquals(await app.count("[data-testid=harness-frame]"), 0);
  });

  test("light theme: the overlay's cards follow the theme", async (app) => {
    const claude = await launchAgent(app, "codex");
    await waitOverlay(app, claude, true);
    await app.openSettings("appearance");
    await app.click('[data-testid=setting-theme][data-value="cloud"]');
    await app.closeSettings();
    await clickPrompt(app, claude);
    await app.page.keyboard.type("explain the failing test");
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector(s)?.textContent,
        inTile(claude, "harness-label"),
      ),
      "Codex",
    );
    await shot(app, "harness-overlay-light.png");
  });
});
