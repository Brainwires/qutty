// The macOS Dock menu's commands, the page's half (app/use-dock-commands.ts): the demo has no Dock,
// so `__e2e.dockCommand` queues a command as the app process does for the frontmost window
// (desktop/dock-menu.ts) and tells the page, which takes it. New Terminal opens a terminal as ⌘T
// does; "Claude Code (chat)" and "Codex (chat)" ask for the agent tile's folder. The menu itself, its windows and
// the routing are unit-tested (tests/dock_menu_test.ts).

import { assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

type Command = "newTerminal" | "agentChat" | "codexChat";

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

  test("Claude Code (chat) asks for the agent tile's folder", async (app) => {
    await app.ensureTerminals(1);
    await dockCommand(app, "agentChat");
    await waitFor(
      () => app.exists("[data-testid=agent-launch-cwd]"),
      3000,
      "the folder question",
    );
  });

  test("Codex (chat) asks for the folder of a Codex agent tile", async (app) => {
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
