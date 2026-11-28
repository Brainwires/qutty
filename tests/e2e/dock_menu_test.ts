// The macOS Dock menu's commands, the page's half (app/use-dock-commands.ts): the demo has no Dock,
// so `__e2e.dockCommand` queues a command as the app process does for the frontmost window
// (desktop/dock-menu.ts) and tells the page, which takes it. New Terminal opens a terminal as ⌘T
// does; Coding → Claude Code and Codex ask for the agent tile's folder; Terminal → Claude Code
// starts the tool in a terminal, as the `+` menu's Terminal submenu does. The menu itself, its
// windows and the routing are unit-tested (tests/dock_menu_test.ts).

import { assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

type Command =
  | "newTerminal"
  | "agentChat"
  | "codexChat"
  | "claudeTerminal"
  | "codexTerminal";

const dockCommand = (app: App, command: Command) =>
  app.eval(
    (c: Command) =>
      (globalThis as unknown as {
        __e2e: { dockCommand(c: string): void };
      }).__e2e.dockCommand(c),
    command,
  );

suite("dock menu", (test) => {
  test("New Terminal opens a terminal, once", async (app) => {
    await app.ensureTerminals(1);
    const before = await app.count("[data-testid=chip]");
    await dockCommand(app, "newTerminal");
    await waitFor(
      async () => (await app.count("[data-testid=chip]")) === before + 1,
      3000,
      "the new terminal",
    );
    // Taken once: it never runs again.
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(await app.count("[data-testid=chip]"), before + 1);
  });

  test("Terminal → Claude Code starts the tool in a new terminal, once", async (app) => {
    await app.ensureTerminals(1);
    const before = new Set((await app.chips()).map((c) => c.id));
    await dockCommand(app, "claudeTerminal");
    const id = await waitFor(
      async () => {
        const f = await app.focusedId();
        return f && !before.has(f) ? f : null;
      },
      5000,
      "the Claude Code terminal",
    );
    await app.waitForText(id, "Claude Code");
    assertEquals((await app.settings()).lastLaunch, "agent:claude");
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(await app.count("[data-testid=chip]"), before.size + 1);
  });

  test("Coding → Claude Code asks for the agent tile's folder", async (app) => {
    await app.ensureTerminals(1);
    await dockCommand(app, "agentChat");
    await waitFor(
      () => app.exists("[data-testid=agent-launch-cwd]"),
      3000,
      "the folder question",
    );
  });

  test("Coding → Codex asks for the folder of a Codex agent tile", async (app) => {
    await app.ensureTerminals(1);
    await dockCommand(app, "codexChat");
    await waitFor(
      () => app.exists("[data-testid=agent-launch-cwd]"),
      3000,
      "the folder question",
    );
    assertEquals(
      await app.eval(() =>
        document.querySelector("[data-testid=agent-launch] .agent-launch-title")
          ?.textContent
      ),
      "✻ Codex (chat)",
    );
    await app.press("Escape");
  });
});
