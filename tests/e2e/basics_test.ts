// Boot, typing, creating, closing, exit/restart and activity — through the real UI.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { suite, waitFor } from "./harness.ts";

suite("basics", (test) => {
  // ---- Boot ---------------------------------------------------------------------------------

  test("boot: one terminal, focused, prompt visible, no errors", async (app) => {
    const chips = await app.chips();
    const tiles = await app.tiles();
    assertEquals(chips.length, 1);
    assertEquals(tiles.length, 1);
    const id = chips[0].id;
    assertEquals(await app.focusedId(), id);
    assert(chips[0].focused && chips[0].tiled);
    assertEquals(tiles[0].focused, true);
    assertEquals(tiles[0].rank, 0);
    await waitFor(
      async () => (await app.tiles())[0].phase === "shown",
      3000,
      "the first tile to be shown",
    );
    const text = await app.readTerminalText(id);
    assertMatch(text, /Qutty/);
    assertMatch(await app.lastLine(id), /^demo:~\$\s*$/);
    assert(!(await app.exists("[data-testid=empty]")));
    // Keyboard focus lands in the first terminal.
    await waitFor(() => app.xtermHasFocus(id), 3000, "xterm focus at boot");
  });

  // ---- Typing -------------------------------------------------------------------------------

  test("typing: echo hello prints hello", async (app) => {
    const id = (await app.focusedId())!;
    const text = await app.run(id, "echo hello");
    const lines = text.split("\n");
    const i = lines.findIndex((l) => /demo:~\$ echo hello/.test(l));
    assert(i >= 0, "the command line is echoed");
    assertEquals(lines[i + 1], "hello");
  });

  test("typing: help lists the demo commands", async (app) => {
    const id = (await app.focusedId())!;
    const text = await app.run(id, "help");
    assertMatch(text, /Qutty demo shell/);
    for (
      const cmd of ["ls", "date", "echo", "clear", "stress", "size", "top"]
    ) {
      assertMatch(text, new RegExp(`^\\s+${cmd}\\b`, "m"));
    }
  });

  test("typing: clear wipes the screen and scrollback", async (app) => {
    const id = (await app.focusedId())!;
    await app.run(id, "echo before-clear");
    // `run` counts prompts, which `clear` resets; wait for the cleared screen instead.
    await app.typeInTerminal(id, "clear\n");
    await waitFor(
      async () => {
        const t = await app.readTerminalText(id);
        return !t.includes("before-clear") && /^demo:~\$\s*$/.test(t.trim());
      },
      3000,
      "a cleared screen",
    );
    const text = (await app.readTerminalText(id)).trim();
    assert(!text.includes("before-clear"), `still there: ${text}`);
    assert(!text.includes("Qutty"));
    assertEquals(await app.promptCount(id), 1);
  });

  test("typing: backspace edits the line", async (app) => {
    const id = (await app.focusedId())!;
    await app.typeInTerminal(id, "echo helpx");
    await app.waitForText(id, "echo helpx");
    await app.press("Backspace");
    await app.press("Backspace");
    await waitFor(
      async () => /demo:~\$ echo hel\s*$/.test(await app.lastLine(id)),
      3000,
      "two characters erased",
    );
    const text = await app.run(id, "lo");
    const lines = text.split("\n");
    const i = lines.findIndex((l) => /demo:~\$ echo hello\s*$/.test(l));
    assert(i >= 0, `edited line: ${text}`);
    assertEquals(lines[i + 1], "hello");
  });

  test("typing: Ctrl+C abandons the line", async (app) => {
    const id = (await app.focusedId())!;
    await app.typeInTerminal(id, "echo never");
    await app.waitForText(id, "echo never");
    const before = await app.promptCount(id);
    await app.ctrl("KeyC");
    await waitFor(
      async () => (await app.promptCount(id)) > before,
      3000,
      "a fresh prompt after ^C",
    );
    assertMatch(await app.readTerminalText(id), /echo never\^C/);
    const text = await app.run(id, "echo after");
    assert(!/^never$/m.test(text), "the abandoned line never ran");
    assertMatch(text, /^after$/m);
  });

  // ---- Create -------------------------------------------------------------------------------

  test("create: via the + button", async (app) => {
    const first = (await app.focusedId())!;
    const id = await app.newTerminal("button");
    assert(id !== first);
    assertEquals((await app.chips()).length, 2);
    assertEquals(await app.focusedId(), id);
    await waitFor(() => app.xtermHasFocus(id), 3000, "keyboard focus in new");
  });

  test("create: via the shortcut (Mod+T)", async (app) => {
    const first = (await app.focusedId())!;
    const id = await app.newTerminal("shortcut");
    assert(id !== first);
    assertEquals((await app.chips()).length, 2);
    assertEquals(await app.focusedId(), id);
    // The shortcut never reaches the shell.
    assert(!(await app.readTerminalText(first)).includes("demo:~$ t"));
  });

  test("create: n = 2..8, the newest is focused and counts match", async (app) => {
    for (let n = 2; n <= 8; n++) {
      const id = await app.newTerminal(n % 2 ? "shortcut" : "button");
      const chips = await app.chips();
      const tiles = await app.tiles();
      assertEquals(chips.length, n);
      assertEquals(tiles.length, n);
      assertEquals(await app.focusedId(), id);
      assertEquals(chips.filter((c) => c.focused).map((c) => c.id), [id]);
      assertEquals(tiles.filter((t) => t.focused).map((t) => t.id), [id]);
      assertEquals(chips.find((c) => c.id === id)!.rank, 0);
      await waitFor(() => app.xtermHasFocus(id), 3000, `keyboard focus ${id}`);
    }
    await app.assertLayoutMatches();
  });

  // ---- Close --------------------------------------------------------------------------------

  test("close: via the tile close button kills the PTY and re-tiles", async (app) => {
    await app.ensureTerminals(3);
    const target = (await app.focusedId())!;
    const ptyId = (await app.terminal(target))!.ptyId!;
    const mruBefore = await app.mru();
    await app.click(
      `[data-testid=tile][data-id="${target}"] [data-testid=tile-close]`,
    );
    await waitFor(
      async () => (await app.chips()).length === 2,
      3000,
      "two chips",
    );
    assertEquals((await app.tiles()).length, 2);
    assert(!(await app.tiles()).some((t) => t.id === target));
    assertEquals(await app.focusedId(), mruBefore[1]);
    assertEquals(await app.terminal(target), null);
    await waitFor(
      async () => (await app.kills()).includes(ptyId),
      2000,
      "the PTY kill",
    );
    await app.assertLayoutMatches();
  });

  test("close: via the chip close button (unfocused terminal)", async (app) => {
    const ids = await app.ensureTerminals(3);
    const focused = (await app.focusedId())!;
    const target = ids.find((id) => id !== focused)!;
    const ptyId = (await app.terminal(target))!.ptyId!;
    await app.closeChip(target);
    await waitFor(
      async () => (await app.chips()).length === 2,
      3000,
      "two chips",
    );
    assert(!(await app.chips()).some((c) => c.id === target));
    // Closing another terminal from the bar leaves focus where it was.
    assertEquals(await app.focusedId(), focused);
    await waitFor(
      async () => (await app.kills()).includes(ptyId),
      2000,
      "the PTY kill",
    );
    await app.assertLayoutMatches();
  });

  test("close: the last terminal shows the empty state; empty-new creates one", async (app) => {
    await app.ensureTerminals(2);
    await app.shortcut("KeyW");
    await waitFor(async () => (await app.chips()).length === 1, 3000, "1 chip");
    await app.shortcut("KeyW");
    await waitFor(() => app.exists("[data-testid=empty]"), 3000, "empty state");
    assertEquals((await app.chips()).length, 0);
    assertEquals((await app.tiles()).length, 0);
    assertEquals(await app.focusedId(), null);
    assertEquals((await app.kills()).length, 2);
    await app.click("[data-testid=empty-new]");
    const id = await waitFor(() => app.focusedId(), 3000, "a new terminal");
    await app.waitForPrompt(id);
    assert(!(await app.exists("[data-testid=empty]")));
    assertEquals((await app.chips()).length, 1);
    await app.assertLayoutMatches();
  });

  // ---- Exit / restart -----------------------------------------------------------------------

  test("exit: banner, data-exited, Enter restarts with a prompt", async (app) => {
    const id = (await app.focusedId())!;
    const ptyBefore = (await app.terminal(id))!.ptyId;
    await app.typeInTerminal(id, "exit\n");
    await app.waitForText(id, /process exited \(code 0\)/);
    await waitFor(
      async () =>
        (await app.attr(
          `[data-testid=tile][data-id="${id}"]`,
          "data-exited",
        )) ===
          "true",
      3000,
      "tile exited",
    );
    assertEquals((await app.chips())[0].exited, true);
    assertEquals((await app.terminal(id))!.exited, true);
    // Typing into an exited terminal does nothing but Enter.
    await app.typeInTerminal(id, "\n");
    await waitFor(
      async () => {
        const s = await app.terminal(id);
        return !!s && !s.exited && !!s.ptyId && s.ptyId !== ptyBefore;
      },
      3000,
      "a new PTY",
    );
    await app.waitForPrompt(id);
    assert(!(await app.readTerminalText(id)).includes("process exited"));
    await waitFor(
      async () => (await app.chips())[0].exited === false,
      3000,
      "chip restarted",
    );
    assertEquals(
      await app.attr(`[data-testid=tile][data-id="${id}"]`, "data-exited"),
      "false",
    );
    const text = await app.run(id, "echo back");
    assertMatch(text, /^back$/m);
  });

  test("exit: an exit code is reported", async (app) => {
    const id = (await app.focusedId())!;
    await app.typeInTerminal(id, "exit 3\n");
    await app.waitForText(id, /process exited \(code 3\)/);
    await waitFor(
      () => app.exists(`[data-testid=tile][data-id="${id}"] .tile-exited`),
      3000,
      "the exited badge",
    );
    assertMatch(
      (await app.eval(() =>
        document.querySelector(".tile-exited")!.textContent
      ))!,
      /exited 3/,
    );
  });

  // ---- Activity -----------------------------------------------------------------------------

  test("activity: output in an unfocused terminal marks its chip; focus clears it", async (app) => {
    const a = (await app.focusedId())!;
    const b = await app.newTerminal();
    // `top` redraws every second: delayed output that arrives after focus moves away.
    await app.typeInTerminal(b, "top\n");
    await app.waitForText(b, "demo top");
    await app.focusChip(a);
    const chipB = `[data-testid=chip][data-id="${b}"]`;
    await waitFor(
      async () => (await app.attr(chipB, "data-activity")) === "true",
      4000,
      "activity on the background chip",
    );
    assertEquals(
      await app.attr(`[data-testid=chip][data-id="${a}"]`, "data-activity"),
      "false",
    );
    assert(await app.exists(`[data-testid=tile][data-id="${b}"].has-activity`));
    await app.focusChip(b);
    assertEquals(await app.attr(chipB, "data-activity"), "false");
    // Quit top; the prompt comes back.
    await app.typeInTerminal(b, "q");
    await waitFor(
      async () => /demo:~\$\s*$/.test(await app.lastLine(b)),
      3000,
      "prompt after top",
    );
  });

  test("activity: a burst (stress) in the focused terminal sets no activity", async (app) => {
    const a = (await app.focusedId())!;
    const b = await app.newTerminal();
    await app.run(b, "stress 3000", 10_000);
    await app.waitForText(b, "line 3000");
    assertEquals(
      await app.attr(`[data-testid=chip][data-id="${b}"]`, "data-activity"),
      "false",
    );
    assertEquals(
      await app.attr(`[data-testid=chip][data-id="${a}"]`, "data-activity"),
      "false",
    );
  });
});
