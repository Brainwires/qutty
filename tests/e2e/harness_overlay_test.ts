// The harness overlay (app/harness-overlay.tsx) against the demo backend: a demo Claude Code from
// the `+` picker (a demo agent turns bracketed paste on and says when a line came in a paste,
// lib/pty-client.ts) gets the header card, the prompt box and the side rail around its terminal;
// a plain shell does not. Sending types into the terminal; Interrupt (shown only while the
// harness is busy) sends Esc; the terminal refits as the prompt box grows; the tile's menus and
// Settings → Tiles turn it off and on, and the xterm is never remounted by it; the companion keeps
// off the prompt box and the rail. Screenshots (each theme, focused with text, busy, an agent
// tile's prompt box, the companion beside the prompt box) go to tests/e2e/__screenshots__ (and
// `HARNESS_SHOT_DIR` when set).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { launchAgent } from "./agent_helpers.ts";
import { rightClick } from "./link_helpers.ts";
import { press } from "./pointer_helpers.ts";

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

type Box = { left: number; top: number; right: number; bottom: number };

/** The client box of the first element matching `selector` (null: none, or not drawn). */
function boxOf(app: App, selector: string): Promise<Box | null> {
  return app.eval((s: string) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, selector);
}

const intersects = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const COMPANION = "[data-testid=companion-overlay]";
/** The companion itself: its face and the buttons beside it. */
const COMPANION_STAGE = `${COMPANION} .stage`;

/** Wait until the companion's box (eased into place) is clear of every box in `others`. */
function companionClear(app: App, others: string[], what: string) {
  return waitFor(
    async () => {
      const c = await boxOf(app, COMPANION_STAGE);
      if (!c) return false;
      for (const o of others) {
        const b = await boxOf(app, o);
        if (!b || intersects(c, b)) return false;
      }
      // Settled: the same box a moment later (the move eases).
      await new Promise((r) => setTimeout(r, 300));
      const again = await boxOf(app, COMPANION_STAGE);
      return again !== null && Math.abs(again.top - c.top) < 0.5 &&
        Math.abs(again.left - c.left) < 0.5;
    },
    5000,
    what,
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
    // The prompt box: a short placeholder by the harness's name; no Interrupt while idle.
    assertEquals(
      await app.attr(inTile(claude, "harness-input"), "placeholder"),
      "Ask Claude…",
    );
    assertEquals(
      await app.attr(inTile(claude, "harness-prompt"), "data-part"),
      "composer",
    );
    assert(!(await app.exists(inTile(claude, "harness-interrupt"))));
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
    // The pointer off the card (no hover outlines in the picture).
    await app.page.mouse.move(1000, 400);
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
    // Busy now: Interrupt shows, and sends Esc to the harness.
    await waitFor(
      () => app.exists(inTile(claude, "harness-interrupt")),
      3000,
      "Interrupt while busy",
    );
    await app.click(inTile(claude, "harness-interrupt"));
    await app.waitForText(claude, "(demo) interrupted");
    // Idle again: no Interrupt.
    await waitFor(
      async () => !(await app.exists(inTile(claude, "harness-interrupt"))),
      3000,
      "Interrupt gone once idle",
    );
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
    assertEquals(
      await app.attr(inTile(claude, "harness-input"), "placeholder"),
      "Message Codex…",
    );
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

  test("screenshots: focused with text, and busy with Interrupt", async (app) => {
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    await clickPrompt(app, claude);
    await app.page.keyboard.type("Refactor the parser so tokens carry spans,");
    await app.page.keyboard.down("Shift");
    await app.press("Enter");
    await app.page.keyboard.up("Shift");
    await app.page.keyboard.type("then update the tests that compare them.");
    await app.page.mouse.move(1000, 400);
    await shot(app, "harness-overlay-focused.png");
    await app.press("Enter");
    await waitFor(
      () => app.exists(inTile(claude, "harness-interrupt")),
      3000,
      "Interrupt while busy",
    );
    await app.page.mouse.move(1000, 400);
    await shot(app, "harness-overlay-busy.png");
  });

  test("the companion keeps off the prompt box and the rail, at rest and when dropped on them", async (app) => {
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    await waitFor(() => app.exists(COMPANION_STAGE), 3000, "the companion");
    const composer = inTile(claude, "harness-prompt");
    const rail = inTile(claude, "harness-rail");
    // Maximized, the tile fills the area: the companion's bottom-right corner is over the prompt
    // box and the rail, so it rests above the one and beside the other.
    await app.click(inTile(claude, "harness-maximize"));
    await waitFor(
      async () =>
        (await app.attr(tileSel(claude), "data-maximized")) === "true",
      3000,
      "maximized",
    );
    await companionClear(
      app,
      [composer, rail],
      "the companion off the prompt box and the rail",
    );
    // It still sits in the bottom-right, just above the prompt box.
    const c = (await boxOf(app, COMPANION_STAGE))!;
    const p = (await boxOf(app, composer))!;
    assert(c.bottom <= p.top, `above the prompt box: ${c.bottom} ${p.top}`);
    assert(p.top - c.bottom < 40, `right above it: ${p.top - c.bottom}`);
    // The prompt box grows: the companion moves up with it.
    await clickPrompt(app, claude);
    for (let i = 0; i < 5; i++) {
      await app.page.keyboard.type(`line ${i + 1}`);
      await app.page.keyboard.down("Shift");
      await app.press("Enter");
      await app.page.keyboard.up("Shift");
    }
    await companionClear(app, [composer, rail], "clear of the taller box");
    await app.page.mouse.move(400, 300);
    await shot(app, "harness-overlay-companion.png");
    // Dragged and dropped onto the prompt box on the left: it snaps to the bottom-left corner and
    // settles above the box.
    const face =
      (await boxOf(app, `${COMPANION} [data-testid=companion-poke]`))!;
    const from = {
      x: (face.left + face.right) / 2,
      y: (face.top + face.bottom) / 2,
    };
    const hand = press(app, from.x, from.y);
    await hand.down();
    await hand.moveTo(p.left + 60, (p.top + p.bottom) / 2, 10);
    await hand.up();
    await waitFor(
      async () => (await app.attr(COMPANION, "data-corner")) === "bottom-left",
      3000,
      "dropped in the bottom-left corner",
    );
    await companionClear(
      app,
      [composer, rail],
      "settled beside the prompt box",
    );
  });

  test("an agent tile's prompt box: the same composer", async (app) => {
    await app.click("[data-testid=bar-new-menu]");
    await app.click("[data-testid=launch-agent-chat]");
    await waitFor(
      () => app.exists("[data-testid=agent-launch-cwd]"),
      3000,
      "the folder question",
    );
    await app.click("[data-testid=agent-launch-open]");
    const input =
      "[data-testid=tile][data-agent-tile=true] [data-testid=agent-input]";
    await waitFor(
      () =>
        app.eval((s: string) => {
          const el = document.querySelector<HTMLTextAreaElement>(s);
          return !!el && !el.disabled;
        }, input),
      5000,
      "the agent's prompt box",
    );
    assertEquals(await app.attr(input, "placeholder"), "Ask Claude…");
    assertEquals(
      await app.attr(
        "[data-testid=tile][data-agent-tile=true] [data-testid=agent-prompt]",
        "data-part",
      ),
      "composer",
    );
    await app.click(input);
    await app.page.keyboard.type("Summarize what changed in notes.md");
    await app.page.mouse.move(1000, 400);
    await shot(app, "agent-composer.png");
  });

  test("the prompt box is in the UI font, scales with the tile's zoom, and squares up under Classic", async (app) => {
    const claude = await launchAgent(app, "claude");
    await waitOverlay(app, claude, true);
    const input = inTile(claude, "harness-input");
    const look = () =>
      app.eval((s: string) => {
        const el = document.querySelector<HTMLElement>(s)!;
        const box = el.closest<HTMLElement>("[data-part=composer]")!;
        return {
          family: getComputedStyle(el).fontFamily,
          mono: getComputedStyle(document.documentElement).getPropertyValue(
            "--mono",
          ),
          // The card's drawn height (a Chromium before 128, without `currentCSSZoom`, measures a
          // zoomed element in its own zoomed px).
          height: box.getBoundingClientRect().height *
            ("currentCSSZoom" in box
              ? 1
              : parseFloat(getComputedStyle(box).zoom) || 1),
          radius: getComputedStyle(box).borderTopLeftRadius,
        };
      }, input);
    const base = await look();
    assert(!base.family.includes("Mono"), base.family);
    assertEquals(base.radius, "16px");
    // Mod+= twice: 125%, and the prompt box grows with the tile.
    await app.focusTerminalInput(claude);
    await app.shortcut("Equal");
    await app.shortcut("Equal", { shift: true });
    await waitFor(
      async () => (await look()).height > base.height * 1.15,
      3000,
      "the prompt box zoomed with the tile",
    );
    await app.shortcut("Digit0");
    // Classic: a square, raised prompt box.
    await app.openSettings("appearance");
    await app.click('[data-testid=setting-skin][data-value="classic"]');
    await app.closeSettings();
    await waitFor(
      async () => (await look()).radius === "0px",
      3000,
      "squared under Classic",
    );
    await app.page.mouse.move(1000, 400);
    await shot(app, "harness-overlay-classic.png");
  });
});
