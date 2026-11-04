// Workspace shortcuts with the platform modifier (⌘ on mac, Ctrl elsewhere; the app's
// data-platform says which), pressed while xterm has keyboard focus.

import { assert, assertEquals } from "@std/assert";
import { suite, waitFor } from "./harness.ts";

suite("keyboard", (test) => {
  test("Mod+1..9 focuses by bar ordinal (opened order)", async (app) => {
    const ids = await app.ensureTerminals(9);
    await app.setBarOrder("created");
    await app.closeSettings();
    await app.focusTerminalInput((await app.focusedId())!);
    for (const k of [3, 1, 9, 5, 2, 8]) {
      await app.shortcut(`Digit${k}`);
      await waitFor(
        async () => (await app.focusedId()) === ids[k - 1],
        2000,
        `Mod+${k}`,
      );
      await waitFor(
        () => app.xtermHasFocus(ids[k - 1]),
        2000,
        "keyboard focus follows",
      );
    }
  });

  test("Mod+1..9 focuses by bar ordinal (recently used order)", async (app) => {
    await app.ensureTerminals(5);
    for (const k of [2, 4, 3, 5]) {
      const want = (await app.chips()).find((c) => c.ordinal === k)!.id;
      await app.shortcut(`Digit${k}`);
      await waitFor(
        async () => (await app.focusedId()) === want,
        2000,
        `Mod+${k}`,
      );
    }
  });

  test("Mod+digit beyond the terminal count does nothing", async (app) => {
    await app.ensureTerminals(2);
    const before = await app.focusedId();
    await app.shortcut("Digit7");
    await app.settle();
    assertEquals(await app.focusedId(), before);
  });

  test("Mod+] / Mod+[ held: alt-tab walks the MRU, release commits", async (app) => {
    await app.ensureTerminals(4);
    const start = await app.mru(); // [a, b, c, d]
    const kb = app.page.keyboard;
    await kb.down(app.mod);
    await kb.press("BracketRight");
    await waitFor(
      async () => (await app.focusedId()) === start[1],
      2000,
      "→ b",
    );
    await kb.press("BracketRight");
    await waitFor(
      async () => (await app.focusedId()) === start[2],
      2000,
      "→ c (walks, no bounce)",
    );
    await kb.press("BracketRight");
    await waitFor(
      async () => (await app.focusedId()) === start[3],
      2000,
      "→ d",
    );
    await kb.press("BracketLeft");
    await waitFor(
      async () => (await app.focusedId()) === start[2],
      2000,
      "← c",
    );
    await kb.up(app.mod);
    // Released on c: c is first; a fresh cycle now starts from the committed order.
    const committed = await app.mru();
    assertEquals(committed[0], start[2]);
    await app.shortcut("BracketRight");
    await waitFor(
      async () => (await app.focusedId()) === committed[1],
      2000,
      "new cycle → mru[1]",
    );
    await app.assertLayoutMatches();
  });

  test("Mod+] released between presses bounces between the two most recent", async (app) => {
    await app.ensureTerminals(3);
    const [a, b, c] = await app.mru();
    await app.shortcut("BracketRight");
    await waitFor(async () => (await app.focusedId()) === b, 2000, "→ b");
    await app.shortcut("BracketRight");
    await waitFor(async () => (await app.focusedId()) === a, 2000, "→ a");
    // A fresh backwards cycle starts at the oldest terminal.
    await app.shortcut("BracketLeft");
    await waitFor(
      async () => (await app.focusedId()) === c,
      2000,
      "← c (oldest)",
    );
    assertEquals(await app.mru(), [c, a, b]);
  });

  test("Mod+` jumps to the previous terminal", async (app) => {
    const ids = await app.ensureTerminals(4);
    await app.focusChip(ids[0]);
    await app.focusChip(ids[2]);
    await app.shortcut("Backquote");
    await waitFor(
      async () => (await app.focusedId()) === ids[0],
      2000,
      "previous",
    );
    await app.shortcut("Backquote");
    await waitFor(
      async () => (await app.focusedId()) === ids[2],
      2000,
      "and back",
    );
    await waitFor(
      () => app.xtermHasFocus(ids[2]),
      2000,
      "keyboard focus follows",
    );
  });

  test("Mod+W closes the focused terminal; focus moves to mru[0]", async (app) => {
    const ids = await app.ensureTerminals(4);
    await app.focusChip(ids[1]);
    await app.focusChip(ids[3]);
    const mru = await app.mru();
    const ptyId = (await app.terminal(mru[0]))!.ptyId!;
    await app.shortcut("KeyW");
    await waitFor(
      async () => (await app.chips()).length === 3,
      2000,
      "3 chips",
    );
    assertEquals(await app.focusedId(), mru[1]);
    assertEquals(await app.mru(), mru.slice(1));
    await waitFor(
      () => app.xtermHasFocus(mru[1]),
      2000,
      "keyboard focus follows",
    );
    await waitFor(
      async () => (await app.kills()).includes(ptyId),
      2000,
      "PTY killed",
    );
    await app.assertLayoutMatches();
  });

  test("shortcuts are not echoed into the terminal", async (app) => {
    const a = (await app.focusedId())!;
    await app.newTerminal();
    await app.typeInTerminal(a, "echo abc");
    await app.waitForText(a, "echo abc");
    // Every non-destructive shortcut, pressed with xterm focused, then back to `a`.
    await app.shortcut("KeyL", { shift: true });
    await app.shortcut("KeyB", { shift: true });
    await app.shortcut("Enter");
    await app.shortcut("Enter");
    await app.shortcut("Digit1");
    await app.shortcut("Backquote");
    await waitFor(
      async () => (await app.focusedId()) !== a,
      2000,
      "focus moved",
    );
    await app.shortcut("Backquote");
    await waitFor(
      async () => (await app.focusedId()) === a,
      2000,
      "focus back",
    );
    await app.shortcut("BracketRight");
    await app.shortcut("BracketLeft");
    await waitFor(
      async () => (await app.focusedId()) === a,
      2000,
      "cycled back",
    );
    await app.settle();
    assert(
      /^demo:~\$ echo abc\s*$/.test(await app.lastLine(a)),
      `line: ${await app.lastLine(a)}`,
    );
    const out = await app.run(a, "");
    assert(/^abc$/m.test(out), "the line still runs as typed");
  });

  test("plain keys without the modifier reach the shell", async (app) => {
    const a = (await app.focusedId())!;
    // T, W, digits, brackets, backquote typed plainly are just text.
    const out = await app.run(a, "echo tw19[]`");
    assert(/^tw19\[\]`$/m.test(out), out);
  });
});
