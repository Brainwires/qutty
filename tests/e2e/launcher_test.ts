// The `+` split button's picker, against the demo backend (DEMO_LAUNCHABLES in lib/pty-client.ts:
// zsh (default), bash, fish; Claude Code and Codex; the demo SSH hosts): opening it, the keyboard,
// launching a shell, an agent tool (its tile closes when it exits) and an SSH host, Escape, the
// bar on a vertical edge, and what plain `+` opens.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { DIALOG, waitForRemotePrompt } from "./ssh_helpers.ts";

const ARROW = "[data-testid=bar-new-menu]";
const MENU = "[data-testid=launch-menu]";
const item = (id: string) => `[data-testid=launch-item][data-id="${id}"]`;

/** Open the picker with the mouse and wait for its entries. */
async function openMenu(app: App): Promise<void> {
  await app.click(ARROW);
  await waitFor(() => app.exists(item("shell:/bin/zsh")), 3000, "the picker");
}

/** The data-id (or test id) of the focused element. */
function focusedItem(app: App): Promise<string | null> {
  return app.eval(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.dataset.id ?? el?.dataset.testid ?? null;
  });
}

/** Every entry id in the picker, top to bottom. */
function itemIds(app: App): Promise<string[]> {
  return app.eval(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=launch-item]")]
      .map((el) => el.dataset.id!)
  );
}

/** The chip title of terminal `id`. */
function chipTitle(app: App, id: string): Promise<string> {
  return app.eval(
    (i: string) =>
      document.querySelector(`[data-testid=chip][data-id="${i}"] .chip-title`)
        ?.textContent ?? "",
    id,
  );
}

/** Wait for a new focused terminal (not in `before`) and return its id. */
function newFocused(app: App, before: Set<string>): Promise<string> {
  return waitFor(
    async () => {
      const f = await app.focusedId();
      return f && !before.has(f) ? f : null;
    },
    5000,
    "a new focused terminal",
  );
}

async function chipIds(app: App): Promise<Set<string>> {
  return new Set((await app.chips()).map((c) => c.id));
}

/** Pick `entryId` with the mouse; returns the new tile's id. */
async function launch(app: App, entryId: string): Promise<string> {
  const before = await chipIds(app);
  if (!(await app.exists(MENU))) await openMenu(app);
  await app.click(item(entryId));
  const id = await newFocused(app, before);
  await waitFor(async () => !(await app.exists(MENU)), 2000, "menu closed");
  return id;
}

/** Choose what plain `+` opens in Settings. */
async function setPlusOpens(app: App, value: string): Promise<void> {
  await app.openSettings();
  await waitFor(
    () =>
      app.eval(
        (v: string) =>
          [...document.querySelectorAll<HTMLOptionElement>(
            "[data-testid=setting-plus-opens] option",
          )].some((o) => o.value === v),
        value,
      ),
    3000,
    `option ${value}`,
  );
  await app.eval((v: string) => {
    const sel = document.querySelector<HTMLSelectElement>(
      "[data-testid=setting-plus-opens]",
    )!;
    sel.value = v;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await waitFor(
    async () => (await app.settings()).plusOpens === value,
    2000,
    `plusOpens ${value}`,
  );
  await app.closeSettings();
}

suite("launcher", (test) => {
  test("open: the arrow opens the picker with shells, agents and hosts", async (app) => {
    assertEquals(await app.attr(ARROW, "aria-expanded"), "false");
    await openMenu(app);
    assertEquals(await app.attr(ARROW, "aria-expanded"), "true");
    const sections = await app.eval(() =>
      [...document.querySelectorAll<HTMLElement>(
        "[data-testid=launch-section]",
      )].map((el) => el.dataset.section)
    );
    assertEquals(sections, ["shells", "agents", "ssh"]);
    const ids = await itemIds(app);
    assertEquals(ids.slice(0, 5), [
      "shell:/bin/zsh",
      "shell:/bin/bash",
      "shell:/opt/homebrew/bin/fish",
      "agent:claude",
      "agent:codex",
    ]);
    assert(ids.includes("ssh:web-1"), ids.join());
    assert(ids.includes("ssh:prod-api"), ids.join());
    // The default shell is marked; Connections… closes the list.
    assert(
      (await app.eval(() =>
        document.querySelector(
          '[data-testid=launch-item][data-id="shell:/bin/zsh"]',
        )?.textContent ?? ""
      )).includes("default"),
    );
    assert(await app.exists("[data-testid=launch-connections]"));
    // The keyboard is on the first entry.
    assertEquals(await focusedItem(app), "shell:/bin/zsh");
    // An outside click closes it and opens nothing.
    const before = (await app.chips()).length;
    await app.clickAt(700, 500);
    await waitFor(async () => !(await app.exists(MENU)), 2000, "closed");
    assertEquals((await app.chips()).length, before);
    assertEquals(await app.attr(ARROW, "aria-expanded"), "false");
  });

  test("keyboard: ↓ opens, ↑/↓ wrap, Home/End jump, Enter launches", async (app) => {
    const before = await chipIds(app);
    await app.eval(() =>
      document.querySelector<HTMLElement>("[data-testid=bar-new-menu]")!
        .focus()
    );
    await app.press("ArrowDown");
    await waitFor(() => app.exists(MENU), 2000, "opened by ↓");
    await waitFor(
      async () => (await focusedItem(app)) === "shell:/bin/zsh",
      2000,
      "first entry focused",
    );
    await app.press("ArrowUp");
    assertEquals(await focusedItem(app), "launch-connections", "↑ wraps");
    await app.press("ArrowDown");
    assertEquals(await focusedItem(app), "shell:/bin/zsh", "↓ wraps back");
    await app.press("End");
    assertEquals(await focusedItem(app), "launch-connections");
    await app.press("Home");
    await app.press("ArrowDown");
    assertEquals(await focusedItem(app), "shell:/bin/bash");
    await app.press("Enter");
    const id = await newFocused(app, before);
    await waitFor(async () => !(await app.exists(MENU)), 2000, "closed");
    await app.waitForPrompt(id);
    await waitFor(
      () => app.xtermHasFocus(id),
      3000,
      "the keyboard is in the new terminal",
    );
    // The demo reports the picked shell's name, so the title says bash.
    await waitFor(
      async () => (await chipTitle(app, id)).startsWith("bash"),
      4000,
      "titled bash",
    );
    assertEquals((await app.settings()).lastLaunch, "shell:/bin/bash");
  });

  test("Escape closes the picker and gives the keyboard back to the terminal", async (app) => {
    const first = (await app.focusedId())!;
    await app.waitForPrompt(first);
    await openMenu(app);
    await app.press("Escape");
    await waitFor(async () => !(await app.exists(MENU)), 2000, "closed");
    await waitFor(() => app.xtermHasFocus(first), 2000, "terminal focused");
    assertEquals((await app.chips()).length, 1, "nothing launched");
    // Typing goes to the shell as usual.
    const out = await app.run(first, "echo after-escape");
    assert(out.includes("after-escape"));
  });

  test("shell entry: a picked shell opens as a new tile titled by it", async (app) => {
    const id = await launch(app, "shell:/opt/homebrew/bin/fish");
    await app.waitForPrompt(id);
    await waitFor(
      async () => (await chipTitle(app, id)).startsWith("fish"),
      4000,
      "titled fish",
    );
    assertEquals((await app.chips()).length, 2);
    // A shell still restarts on Enter after it exits.
    await app.typeInTerminal(id, "exit\n");
    await app.waitForText(id, "process exited");
    assertEquals((await app.chips()).length, 2, "the shell's tile stays");
  });

  test("agent entry: runs the tool, titled by it; the tile closes when it exits", async (app) => {
    const first = (await app.focusedId())!;
    const id = await launch(app, "agent:claude");
    await app.waitForText(id, "Claude Code");
    await waitFor(
      async () => (await chipTitle(app, id)).startsWith("claude"),
      4000,
      "titled claude (not node)",
    );
    const out = await app.readTerminalText(id);
    assert(!out.includes("demo:~$"), "no shell around the tool");
    await app.typeInTerminal(id, "hello\n");
    await app.waitForText(id, "claude heard: hello");
    await app.typeInTerminal(id, "/exit\n");
    await waitFor(
      async () => !(await chipIds(app)).has(id),
      4000,
      "the agent's tile closed",
    );
    assertEquals(await app.focusedId(), first);
    assertEquals(
      await app.exists(`[data-testid=tile][data-id="${id}"]`),
      false,
    );
    assertEquals((await app.settings()).lastLaunch, "agent:claude");
  });

  test("ssh entry: connects like the Connections dialog; Connections… opens it", async (app) => {
    const id = await launch(app, "ssh:web-1");
    await waitForRemotePrompt(app, id);
    assertEquals(await chipTitle(app, id), "web-1");
    await openMenu(app);
    await app.click("[data-testid=launch-connections]");
    await waitFor(() => app.exists(DIALOG), 2000, "the Connections dialog");
    assert(!(await app.exists(MENU)));
  });

  test("vertical bar: the picker opens beside the bar on the left and right", async (app) => {
    for (const edge of ["left", "right"]) {
      await app.setBarPosition(edge);
      await app.closeSettings();
      await openMenu(app);
      const bar = (await app.rectOf("[data-testid=bar]"))!;
      const menu = (await app.rectOf(MENU))!;
      const vw = await app.eval(() => innerWidth);
      const vh = await app.eval(() => innerHeight);
      if (edge === "left") assert(menu.x >= bar.right, `${edge}: right of bar`);
      else assert(menu.right <= bar.x, `${edge}: left of bar`);
      assert(menu.x >= 0 && menu.right <= vw, `${edge}: inside the window`);
      assert(menu.y >= 0 && menu.bottom <= vh, `${edge}: inside the window`);
      await app.press("Escape");
      await waitFor(async () => !(await app.exists(MENU)), 2000, "closed");
    }
    // Launching works from there too.
    const id = await launch(app, "agent:codex");
    await app.waitForText(id, "Codex");
  });

  test("plus opens: last used and a specific entry, for + and the shortcut; persisted", async (app) => {
    assertEquals((await app.settings()).plusOpens, "default");
    await launch(app, "shell:/bin/bash");
    await setPlusOpens(app, "last");
    assertEquals(
      await app.attr("[data-testid=bar-new]", "aria-label"),
      "New: bash ⌘T",
    );
    let before = await chipIds(app);
    await app.click("[data-testid=bar-new]");
    let id = await newFocused(app, before);
    await waitFor(
      async () => (await chipTitle(app, id)).startsWith("bash"),
      4000,
      "+ opened the last pick",
    );
    await setPlusOpens(app, "agent:claude");
    before = await chipIds(app);
    await app.shortcut("KeyT");
    id = await newFocused(app, before);
    await app.waitForText(id, "Claude Code");
    // Plain + does not change the last pick.
    assertEquals((await app.settings()).lastLaunch, "shell:/bin/bash");
    await app.reload();
    assertEquals((await app.settings()).plusOpens, "agent:claude");
    // The first terminal after a start is always the default shell.
    const first = (await app.focusedId())!;
    await app.waitForPrompt(first);
    await setPlusOpens(app, "default");
    before = await chipIds(app);
    await app.click("[data-testid=bar-new]");
    id = await newFocused(app, before);
    await app.waitForPrompt(id);
    await waitFor(
      async () => (await chipTitle(app, id)).startsWith("demo-sh"),
      4000,
      "the default shell",
    );
  });
});
