// The `+` split button's picker, against the demo backend (DEMO_LAUNCHABLES in lib/pty-client.ts:
// zsh (default), bash, fish; Claude Code and Codex; the demo SSH hosts; Ollama): its submenus
// (Web Browser, Shell, SSH, Terminal, Coding) and what each lists, the keyboard (↑/↓, → / Enter
// into a submenu, ← / Escape out of it), the pointer (a submenu opens after a short rest, and a
// diagonal move into it keeps it open), launching a shell, an agent tool (its tile closes when it
// exits) and an SSH host, Escape, the bar on a vertical edge, and what plain `+` opens.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { DIALOG, waitForRemotePrompt } from "./ssh_helpers.ts";
import {
  ARROW,
  type LaunchSub,
  MENU,
  openSub,
  pickEntry,
  pickInSub,
  submenu,
  subRow,
} from "./launch_helpers.ts";

const item = (id: string) => `[data-testid=launch-item][data-id="${id}"]`;

/** Open the picker with the mouse and wait for its submenus' rows. */
async function openMenu(app: App): Promise<void> {
  await app.click(ARROW);
  await waitFor(() => app.exists(subRow("shell")), 3000, "the picker");
}

/** What has the keyboard: an entry's id, `sub:<id>` for a submenu's row, else its test id. */
function focusedItem(app: App): Promise<string | null> {
  return app.eval(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el?.dataset.testid === "launch-sub") return `sub:${el.dataset.sub}`;
    return el?.dataset.id ?? el?.dataset.testid ?? null;
  });
}

/** The open submenu (`null`: none). */
function openSubId(app: App): Promise<string | null> {
  return app.eval(() =>
    document.querySelector<HTMLElement>("[data-testid=launch-submenu]")
      ?.dataset.sub ?? null
  );
}

/** The rows of submenu `sub` (open): an entry's id, a command's test id, separators "-". */
function subRows(app: App, sub: LaunchSub): Promise<string[]> {
  return app.eval(
    (s: string) =>
      [...document.querySelectorAll<HTMLElement>(`${s} > *`)].map((el) =>
        el.getAttribute("role") === "separator"
          ? "-"
          : el.dataset.id ?? el.dataset.testid ?? "?"
      ),
    submenu(sub),
  );
}

/** The labels of submenu `sub` (open). */
function subLabels(app: App, sub: LaunchSub): Promise<string[]> {
  return app.eval(
    (s: string) =>
      [...document.querySelectorAll<HTMLElement>(`${s} .menu-label`)].map((
        el,
      ) => el.textContent ?? ""),
    submenu(sub),
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

/** Pick `entryId` with the mouse, from its submenu; returns the new tile's id. */
async function launch(app: App, entryId: string): Promise<string> {
  const before = await chipIds(app);
  await pickEntry(app, entryId);
  const id = await newFocused(app, before);
  await waitFor(async () => !(await app.exists(MENU)), 2000, "menu closed");
  return id;
}

/** The centre of `selector`'s box. */
async function centre(
  app: App,
  selector: string,
): Promise<{ x: number; y: number }> {
  const r = (await app.rectOf(selector))!;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Choose what plain `+` opens in Settings. */
async function setPlusOpens(app: App, value: string): Promise<void> {
  await app.openSettings("general");
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
  test("open: the arrow opens the submenus; each lists what it should", async (app) => {
    assertEquals(await app.attr(ARROW, "aria-expanded"), "false");
    await openMenu(app);
    assertEquals(await app.attr(ARROW, "aria-expanded"), "true");
    const subs = await app.eval(() =>
      [...document.querySelectorAll<HTMLElement>("[data-testid=launch-sub]")]
        .map((el) => el.dataset.sub)
    );
    assertEquals(subs, ["web", "shell", "ssh", "terminal", "coding"]);
    // The keyboard is on the first row; no submenu is open yet.
    assertEquals(await focusedItem(app), "sub:web");
    assertEquals(await openSubId(app), null);
    // Web Browser: the web tiles' History and Bookmark Manager (Open needs the native engine).
    await openSub(app, "web");
    assert(
      (await subRows(app, "web")).includes("launch-history"),
      "Web Browser → History",
    );
    assert((await subRows(app, "web")).includes("launch-bookmarks"));
    // Shell: the default first, tagged.
    await openSub(app, "shell");
    assertEquals(await openSubId(app), "shell");
    assertEquals(await subRows(app, "shell"), [
      "shell:/bin/zsh",
      "shell:/bin/bash",
      "shell:/opt/homebrew/bin/fish",
    ]);
    assert(
      (await app.eval(() =>
        document.querySelector(
          '[data-testid=launch-item][data-id="shell:/bin/zsh"]',
        )?.textContent ?? ""
      )).includes("default"),
    );
    // SSH: Connections Manager, a separator, the hosts.
    await openSub(app, "ssh");
    const ssh = await subRows(app, "ssh");
    assertEquals(ssh.slice(0, 2), ["launch-connections", "-"]);
    assert(ssh.includes("ssh:web-1"), ssh.join());
    assert(ssh.includes("ssh:prod-api"), ssh.join());
    assertEquals((await subLabels(app, "ssh"))[0], "Connections Manager");
    // Terminal: the agent tools in a terminal.
    await openSub(app, "terminal");
    assertEquals((await subRows(app, "terminal")).slice(0, 2), [
      "agent:claude",
      "agent:codex",
    ]);
    assertEquals(
      await app.attr(`${submenu("terminal")} ${item("agent:claude")}`, "title"),
      "Claude Code in a terminal, with Qutty's overlay",
    );
    // Coding: the chat tiles, no "(chat)" suffixes, then Ollama's dialog.
    await openSub(app, "coding");
    const coding = ["Claude Code", "Codex", "Ollama", "Ollama models…"];
    await waitFor(
      async () => (await subLabels(app, "coding")).join() === coding.join(),
      3000,
      `Coding's rows: ${coding.join(", ")}`,
    );
    assertEquals((await subRows(app, "coding")).slice(-2), [
      "-",
      "launch-ollama",
    ]);
    assertEquals(
      await app.attr(
        `${submenu("coding")} [data-testid=launch-agent-chat]`,
        "title",
      ),
      "Qutty's chat view; Claude Code runs headless",
    );
    // Only one submenu at a time.
    assertEquals(await app.count("[data-testid=launch-submenu]"), 1);
    // The submenu stays inside the window.
    const sub = (await app.rectOf(submenu("coding")))!;
    const vw = await app.eval(() => innerWidth);
    const vh = await app.eval(() => innerHeight);
    assert(sub.x >= 0 && sub.right <= vw && sub.y >= 0 && sub.bottom <= vh);
    // An outside click closes it all and opens nothing.
    const before = (await app.chips()).length;
    await app.clickAt(700, 500);
    await waitFor(async () => !(await app.exists(MENU)), 2000, "closed");
    assertEquals(await app.exists(submenu("coding")), false);
    assertEquals((await app.chips()).length, before);
    assertEquals(await app.attr(ARROW, "aria-expanded"), "false");
  });

  test("keyboard: ↑/↓ wrap, → and Enter open a submenu, ← and Escape close it, Enter launches", async (app) => {
    const before = await chipIds(app);
    await app.eval(() =>
      document.querySelector<HTMLElement>("[data-testid=bar-new-menu]")!
        .focus()
    );
    await app.press("ArrowDown");
    await waitFor(() => app.exists(MENU), 2000, "opened by ↓");
    await waitFor(
      async () => (await focusedItem(app)) === "sub:web",
      2000,
      "first row focused",
    );
    await app.press("ArrowUp");
    assertEquals(await focusedItem(app), "launch-worktrees", "↑ wraps");
    await app.press("ArrowDown");
    assertEquals(await focusedItem(app), "sub:web", "↓ wraps back");
    await app.press("End");
    assertEquals(await focusedItem(app), "launch-worktrees");
    await app.press("Home");
    await app.press("ArrowDown");
    assertEquals(await focusedItem(app), "sub:shell");
    // → opens Shell with its first row focused; ↓ moves in it; ← closes it, back on its row.
    await app.press("ArrowRight");
    await waitFor(
      async () => (await focusedItem(app)) === "shell:/bin/zsh",
      2000,
      "the Shell submenu's first row",
    );
    assertEquals(
      await app.attr(subRow("shell"), "aria-expanded"),
      "true",
    );
    await app.press("ArrowDown");
    assertEquals(await focusedItem(app), "shell:/bin/bash");
    await app.press("ArrowLeft");
    assertEquals(await openSubId(app), null);
    assertEquals(await focusedItem(app), "sub:shell");
    // Enter opens it too; Escape closes just the submenu, the menu stays.
    await app.press("Enter");
    await waitFor(
      async () => (await focusedItem(app)) === "shell:/bin/zsh",
      2000,
      "opened by Enter",
    );
    await app.press("Escape");
    assertEquals(await openSubId(app), null);
    assert(await app.exists(MENU), "Escape in a submenu keeps the menu");
    assertEquals(await focusedItem(app), "sub:shell");
    // ↓ off a submenu's row closes its submenu.
    await app.press("ArrowRight");
    await waitFor(async () => (await openSubId(app)) === "shell", 2000, "open");
    await app.press("ArrowLeft");
    await app.press("ArrowDown");
    assertEquals(await focusedItem(app), "sub:ssh");
    assertEquals(await openSubId(app), null);
    await app.press("ArrowUp");
    await app.press("ArrowRight");
    await waitFor(
      async () => (await focusedItem(app)) === "shell:/bin/zsh",
      2000,
      "Shell again",
    );
    await app.press("ArrowDown");
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

  test("pointer: a rest opens a submenu; a diagonal move into it keeps it open", async (app) => {
    await openMenu(app);
    const mouse = app.page.mouse;
    // Resting on Terminal's row opens its submenu, after a moment.
    const terminal = await centre(app, subRow("terminal"));
    await mouse.move(terminal.x, terminal.y);
    await waitFor(
      async () => (await openSubId(app)) === "terminal",
      2000,
      "Terminal opened by a rest",
    );
    // Toward the submenu across Coding's row (below it): Terminal stays open.
    const coding = await centre(app, subRow("coding"));
    const target = await centre(
      app,
      `${submenu("terminal")} ${item("agent:claude")}`,
    );
    await mouse.move(coding.x + 40, coding.y);
    await mouse.move(target.x, target.y);
    await new Promise((r) => setTimeout(r, 500));
    assertEquals(await openSubId(app), "terminal", "kept open on the way");
    // Resting on Coding's row: Coding takes over.
    await mouse.move(coding.x, coding.y);
    await waitFor(
      async () => (await openSubId(app)) === "coding",
      2000,
      "Coding after a rest",
    );
    await app.press("Escape");
    await app.press("Escape");
    await waitFor(async () => !(await app.exists(MENU)), 2000, "closed");
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

  test("agent entry: Terminal runs the tool, titled by it; the tile closes when it exits", async (app) => {
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

  test("ssh entry: connects like the Connections dialog; Connections Manager opens it", async (app) => {
    const id = await launch(app, "ssh:web-1");
    await waitForRemotePrompt(app, id);
    assertEquals(await chipTitle(app, id), "web-1");
    await pickInSub(app, "ssh", "[data-testid=launch-connections]");
    await waitFor(() => app.exists(DIALOG), 2000, "the Connections dialog");
    assert(!(await app.exists(MENU)));
  });

  test("vertical bar: the picker and its submenus open beside the bar, inside the window", async (app) => {
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
      // The submenu flies out away from the bar, and stays inside too.
      await openSub(app, "shell");
      const sub = (await app.rectOf(submenu("shell")))!;
      if (edge === "left") assert(sub.x >= menu.right - 1, `${edge}: beside`);
      else assert(sub.right <= menu.x + 1, `${edge}: flipped to the left`);
      assert(sub.x >= 0 && sub.right <= vw, `${edge}: submenu inside`);
      assert(sub.y >= 0 && sub.bottom <= vh, `${edge}: submenu inside`);
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
      app.platform === "mac" ? "New: bash ⌘T" : "New: bash Ctrl+T",
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
