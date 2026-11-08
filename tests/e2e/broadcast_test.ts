// Broadcast input (cluster ssh) in the UI, against the demo backend: the mode's toggles (bar
// button, ⌘⇧I, Stop), the banner and the header checkboxes, typing that reaches the checked
// tiles and no others, terminal replies that stay in their own tile, and the confirmation for a
// big paste.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { connectVia, textOf, tileSel } from "./ssh_helpers.ts";

const BANNER = "[data-testid=broadcast-banner]";
const check = (id: string) => `${tileSel(id)} [data-testid=tile-broadcast]`;

/** Two SSH tiles (web-1 and db) next to the first, local, tile. */
async function threeTiles(
  app: App,
): Promise<{ local: string; a: string; b: string }> {
  const local = (await app.focusedId())!;
  const a = await connectVia(app, "web-1");
  const b = await connectVia(app, "db");
  return { local, a, b };
}

async function setOn(app: App, on: boolean): Promise<void> {
  if ((await app.exists(BANNER)) !== on) {
    await app.shortcut("KeyI", { shift: true });
  }
  await waitFor(
    async () => (await app.exists(BANNER)) === on,
    2000,
    `broadcast ${on ? "on" : "off"}`,
  );
}

async function checkTile(app: App, id: string, on: boolean): Promise<void> {
  const checked = () =>
    app.eval(
      (s: string) => document.querySelector<HTMLInputElement>(s)?.checked,
      check(id),
    );
  if ((await checked()) !== on) await app.click(check(id));
  await waitFor(async () => (await checked()) === on, 2000, `${id} checked`);
}

/** Wait until terminal `id` shows `text` on a line of its own (a command's output). */
function waitForLine(app: App, id: string, text: string): Promise<string> {
  return app.waitForText(id, new RegExp(`(^|\\n)${text}(\\n|$)`));
}

/** Paste `text` into terminal `id` the way the browser does (a paste event on xterm's textarea). */
async function paste(app: App, id: string, text: string): Promise<void> {
  await app.focusTerminalInput(id);
  await app.eval(
    (sel: string, t: string) => {
      const ta = document.querySelector(`${sel} .xterm-helper-textarea`)!;
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      ta.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    tileSel(id),
    text,
  );
}

suite("broadcast", (test) => {
  test("mode: bar button, ⌘⇧I and Stop toggle it; Escape still reaches the terminal", async (app) => {
    const { local } = await threeTiles(app);
    assertEquals(await app.count("[data-testid=tile-broadcast]"), 0);
    await app.click("[data-testid=bar-broadcast]");
    await waitFor(() => app.exists(BANNER), 2000, "the banner");
    assertEquals(
      await app.attr("[data-testid=bar-broadcast]", "aria-pressed"),
      "true",
    );
    assertEquals(await app.count("[data-testid=tile-broadcast]"), 3);
    assertEquals(
      await textOf(app, "[data-testid=broadcast-label]"),
      "Broadcast: check the tiles to type into",
    );
    // Escape is the terminal's: it does not end the mode.
    const focused = (await app.focusedId())!;
    await app.focusTerminalInput(focused);
    await app.press("Escape");
    await new Promise((r) => setTimeout(r, 200));
    assert(await app.exists(BANNER), "still on after Escape");
    await app.shortcut("KeyI", { shift: true });
    await waitFor(async () => !(await app.exists(BANNER)), 2000, "off");
    assertEquals(await app.count("[data-testid=tile-broadcast]"), 0);
    await setOn(app, true);
    await app.click("[data-testid=broadcast-stop]");
    await waitFor(async () => !(await app.exists(BANNER)), 2000, "stopped");
    // The keyboard is back in a terminal.
    await waitFor(() => app.xtermHasFocus(focused), 2000, "focus back");
    assert(local);
  });

  test("typing: reaches every checked tile and no other; replies stay in their tile", async (app) => {
    const { local, a, b } = await threeTiles(app);
    await setOn(app, true);
    await checkTile(app, a, true);
    await checkTile(app, b, true);
    assertEquals(
      await textOf(app, "[data-testid=broadcast-label]"),
      "Broadcasting to 2 tiles",
    );
    assertEquals(await app.attr(BANNER, "data-live"), "true");
    assertEquals(await app.attr(tileSel(a), "data-broadcast"), "true");
    assertEquals(await app.attr(tileSel(b), "data-broadcast"), "true");
    assertEquals(await app.attr(tileSel(local), "data-broadcast"), null);
    assertEquals(await app.exists("[data-testid=broadcast-warn]"), false);

    await app.typeInTerminal(a, "echo hello-all\n");
    await waitForLine(app, a, "hello-all");
    await waitForLine(app, b, "hello-all");
    // Typing in b goes to a too.
    await app.typeInTerminal(b, "echo from-b\n");
    await waitForLine(app, a, "from-b");
    // The unchecked local tile got none of it, and its own typing stays in it.
    await app.typeInTerminal(local, "echo only-local\n");
    await waitForLine(app, local, "only-local");
    for (const id of [a, b]) {
      const text = await app.readTerminalText(id);
      assert(!text.includes("only-local"), `${id} got the local tile's keys`);
    }
    assert(!(await app.readTerminalText(local)).includes("hello-all"));

    // `query` makes each tile's terminal answer two queries; each shell must see exactly its
    // own two answers (a broadcast answer would make it four).
    await app.typeInTerminal(a, "query\n");
    await new Promise((r) => setTimeout(r, 300));
    await app.typeInTerminal(a, "replies\n");
    await waitForLine(app, a, "replies: 2");
    await waitForLine(app, b, "replies: 2");

    // A checked local shell is allowed, with a warning.
    await checkTile(app, local, true);
    await waitFor(
      () => app.exists("[data-testid=broadcast-warn]"),
      2000,
      "the warning",
    );
    assertEquals(
      await textOf(app, "[data-testid=broadcast-warn]"),
      "1 is not an SSH tile",
    );
    assertEquals(
      await textOf(app, "[data-testid=broadcast-label]"),
      "Broadcasting to 3 tiles",
    );
    assertEquals(await textOf(app, "[data-testid=bar-broadcast-count]"), "3");

    // Unchecked: b no longer hears a; turned off: nobody hears anybody.
    await checkTile(app, local, false);
    await checkTile(app, b, false);
    await app.typeInTerminal(a, "echo after-uncheck\n");
    await waitForLine(app, a, "after-uncheck");
    await checkTile(app, b, true);
    await setOn(app, false);
    await app.typeInTerminal(a, "echo after-off\n");
    await waitForLine(app, a, "after-off");
    await new Promise((r) => setTimeout(r, 200));
    const bText = await app.readTerminalText(b);
    assert(!bText.includes("after-uncheck"), "unchecked tile got keys");
    assert(!bText.includes("after-off"), "keys broadcast after off");
    // Turning it on again starts with nothing checked.
    await setOn(app, true);
    assertEquals(await app.attr(BANNER, "data-count"), "0");
  });

  test("paste: a short one goes to all, a big one waits for Paste to all / This tile only", async (app) => {
    const { a, b } = await threeTiles(app);
    await setOn(app, true);
    await checkTile(app, a, true);
    await checkTile(app, b, true);

    await paste(app, a, "echo pasted-small");
    await app.waitForText(b, "echo pasted-small");
    await app.typeInTerminal(a, "\n");
    await waitForLine(app, b, "pasted-small");

    await paste(app, a, "echo big-1\necho big-2\n");
    await waitFor(
      () => app.exists("[data-testid=broadcast-paste]"),
      2000,
      "the paste question",
    );
    assert(
      (await textOf(app, "[data-testid=broadcast-paste]")).includes(
        "Paste 2 lines, 22 characters into 2 tiles?",
      ),
      await textOf(app, "[data-testid=broadcast-paste]"),
    );
    await new Promise((r) => setTimeout(r, 200));
    assert(!(await app.readTerminalText(a)).includes("big-1"), "held in a");
    assert(!(await app.readTerminalText(b)).includes("big-1"), "held in b");
    await app.click("[data-testid=broadcast-paste-all]");
    await waitForLine(app, a, "big-2");
    await waitForLine(app, b, "big-2");

    await paste(app, a, "echo one-1\necho one-2\n");
    await app.click("[data-testid=broadcast-paste-one]");
    await waitForLine(app, a, "one-2");
    await paste(app, a, "echo none-1\necho none-2\n");
    await app.click("[data-testid=broadcast-paste-cancel]");
    await waitFor(
      async () => !(await app.exists("[data-testid=broadcast-paste]")),
      2000,
      "the question gone",
    );
    await new Promise((r) => setTimeout(r, 200));
    assert(!(await app.readTerminalText(b)).includes("one-1"), "one tile only");
    assert(!(await app.readTerminalText(a)).includes("none-1"), "cancelled");
    assert(await app.xtermHasFocus(a), "the keyboard is back in the terminal");
  });
});
