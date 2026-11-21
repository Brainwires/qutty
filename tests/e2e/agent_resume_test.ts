// Resuming agents after a restart, the page's side against the demo backend (lib/hub-demo.ts):
// a tile whose agent was resumed says so until the agent gets busy (the demo agent's `/resumed`
// marks it, as the restart's resume does in the app), the header menu's "Don't resume this
// agent", and Settings → Tiles → "Resume agents after restart", on by default.

import { assert, assertEquals } from "@std/assert";
import { suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { launchAgent, tileMenuWith } from "./agent_helpers.ts";

const NO_RESUME = '[data-testid=tile-move-menu-item][data-action="no-resume"]';

suite("agent resume", (test) => {
  test("a resumed agent's tile says so until it gets busy; Don't resume this agent", async (app) => {
    const claude = await launchAgent(app, "claude");
    const chip = `${tileSel(claude)} [data-testid=tile-resumed]`;
    assert(!(await app.exists(chip)));
    await app.typeInTerminal(claude, "/resumed\n");
    await waitFor(() => app.exists(chip), 5000, "the resumed note");
    // The agent's first turn.
    await app.typeInTerminal(claude, "hello\n");
    await waitFor(async () => !(await app.exists(chip)), 5000, "note gone");

    await tileMenuWith(app, claude, NO_RESUME);
    assertEquals(await app.attr(NO_RESUME, "aria-checked"), "false");
    await app.click(NO_RESUME);
    await waitFor(
      async () => !(await app.exists(NO_RESUME)),
      2000,
      "the menu closed",
    );
    await tileMenuWith(app, claude, NO_RESUME);
    assertEquals(await app.attr(NO_RESUME, "aria-checked"), "true");
  });

  test("settings: Tiles → Resume agents after restart, on by default", async (app) => {
    await app.openSettings("tiles");
    const toggle = "[data-testid=setting-resume-agents]";
    await waitFor(() => app.exists(toggle), 3000, "the setting");
    const checked = () =>
      app.eval(
        (s: string) => document.querySelector<HTMLInputElement>(s)?.checked,
        toggle,
      );
    assertEquals(await checked(), true);
    await app.click(toggle);
    await waitFor(async () => (await checked()) === false, 2000, "off");
  });
});
