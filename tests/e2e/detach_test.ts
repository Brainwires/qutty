// Detachable sessions in the page: the workspace island is unmounted and mounted again
// (`__e2eRemount`, the stand-in for closing the window and reopening it; the demo backend's shells
// and their replay stay up, as the desktop app's PTYs do). Every tile must come back on its own
// shell, with its output, the layout, the MRU order and the focus, and nothing may be killed.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

/** Close and reopen the window, as far as the page is concerned. */
async function remount(app: App, tiles: number): Promise<void> {
  await app.eval(() =>
    (globalThis as unknown as { __e2eRemount(): void }).__e2eRemount()
  );
  await waitFor(
    async () => (await app.count("[data-testid=chip]")) === tiles,
    5000,
    `${tiles} tiles after the remount`,
  );
}

suite("detach", (test) => {
  test("detach: every tile comes back on its shell, with its output, layout and focus", async (app) => {
    const ids = await app.ensureTerminals(3);
    await app.run(ids[1], "echo before-the-detach");
    await app.setPatternViaSettings("columns");
    await app.closeSettings();
    await app.focusChip(ids[2]);
    await app.focusChip(ids[0]);
    const ptys = await Promise.all(
      ids.map(async (id) => (await app.terminal(id))!.ptyId),
    );
    const mru = await app.mru();
    // Let the snapshot save (it is debounced).
    await new Promise((r) => setTimeout(r, 600));

    await remount(app, 3);
    for (const [i, id] of ids.entries()) {
      await waitFor(
        async () => (await app.terminal(id))?.ptyId === ptys[i],
        3000,
        `${id} back on ${ptys[i]}`,
      );
    }
    assert(
      (await app.readTerminalText(ids[1])).includes("before-the-detach"),
      "the output is redrawn",
    );
    assertEquals(await app.pattern(), "columns");
    assertEquals(await app.mru(), mru);
    assertEquals(await app.focusedId(), ids[0]);
    await waitFor(() => app.xtermHasFocus(ids[0]), 3000, "the keyboard back");
    // Nothing was killed, and the shells still answer.
    assertEquals(await app.kills(), []);
    const after = await app.run(ids[1], "echo after-the-reattach");
    assert(after.includes("after-the-reattach"));
    await app.assertLayoutMatches();
  });

  test("detach: a shell that ended while detached comes back ended; Enter restarts it", async (app) => {
    const id = (await app.focusedId())!;
    await app.typeInTerminal(id, "exit\n");
    await app.waitForText(id, /process exited \(code 0\)/);
    await new Promise((r) => setTimeout(r, 600));
    await remount(app, 1);
    await waitFor(
      async () => (await app.terminal(id))?.exited === true,
      3000,
      "the tile still ended",
    );
    assertEquals((await app.chips())[0].exited, true);
    await app.waitForText(id, /process exited \(code 0\)/);
    await app.typeInTerminal(id, "\n");
    await waitFor(
      async () => (await app.terminal(id))?.exited === false,
      3000,
      "a new shell",
    );
    await app.waitForPrompt(id);
  });

  test("detach: closing a tile releases its terminal; a remount does not bring it back", async (app) => {
    const ids = await app.ensureTerminals(2);
    await app.closeChip(ids[1]);
    await waitFor(
      async () => (await app.chips()).length === 1,
      3000,
      "one tile left",
    );
    await new Promise((r) => setTimeout(r, 600));
    await remount(app, 1);
    assertEquals((await app.chips()).map((c) => c.id), [ids[0]]);
  });
});
