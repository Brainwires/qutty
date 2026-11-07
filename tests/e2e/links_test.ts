// Clickable links against the demo backend: the demo shell's `links` command prints a URL, an
// OSC 8 hyperlink, paths that exist in the demo's fake file system (lib/links-demo.ts), one that
// does not, and things that are not links. Underline only with the modifier held, ⌘-click opens
// through the right backend method (the spy in lib/test-hooks.ts), a plain click does not, the
// right-click menu, Download in an SSH tile, and the editor setting.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { connectVia, tileSel } from "./ssh_helpers.ts";

interface LinkState {
  hovered: string | null;
  underline: boolean;
  pointer: boolean;
}

const linkState = (app: App, id: string) =>
  app.eval(
    (i: string) =>
      (globalThis as unknown as {
        __e2e: { linkState(id: string): LinkState | null };
      }).__e2e.linkState(i),
    id,
  );

// deno-lint-ignore no-explicit-any
const linkCalls = (app: App): Promise<any[]> =>
  app.eval(() => // deno-lint-ignore no-explicit-any
  [...(globalThis as any).__e2e.links]);

/**
 * The viewport point of the middle of `needle`'s second cell on screen in terminal `id`, and
 * the cell height.
 */
async function pointOf(
  app: App,
  id: string,
  needle: string,
): Promise<{ x: number; y: number; cellH: number }> {
  const state = await app.terminal(id);
  assert(state, "terminal state");
  const lines = state.text.split("\n");
  const row = lines.findIndex((l) => l.includes(needle));
  assert(row >= 0, `"${needle}" on screen`);
  assert(row < state.rows, `"${needle}" in the first screen (no scrollback)`);
  const col = lines[row].indexOf(needle) + 1;
  const box = await app.eval((sel: string) => {
    const r = document.querySelector(`${sel} .xterm-screen`)!
      .getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, tileSel(id));
  return {
    x: box.x + (col + 0.5) * (box.w / state.cols),
    y: box.y + (row + 0.5) * (box.h / state.rows),
    cellH: box.h / state.rows,
  };
}

/** Run `links` in the focused terminal and return its id. */
async function printLinks(app: App): Promise<string> {
  const id = (await app.focusedId())!;
  await app.run(id, "links");
  await app.waitForText(id, /not links: 1\.2\.3/);
  return id;
}

/** Hover `needle` until the link under the pointer is `text` (`null`: no link there). */
async function hover(
  app: App,
  id: string,
  needle: string,
  text: string | null,
): Promise<void> {
  const pt = await pointOf(app, id, needle);
  // From the row above: xterm asks for a row's links once per row it enters, and drops the
  // answer for a move that entered the terminal.
  await app.page.mouse.move(pt.x, pt.y - pt.cellH);
  await app.page.mouse.move(pt.x, pt.y);
  await waitFor(
    async () => (await linkState(app, id))?.hovered === text,
    3000,
    `hovering ${needle} → ${text}`,
  );
}

/** Wait for `n` link calls (the failure says which arrived). */
async function callCount(app: App, n: number): Promise<void> {
  try {
    await waitFor(
      async () => (await linkCalls(app)).length === n,
      3000,
      `${n}`,
    );
  } catch {
    throw new Error(
      `expected ${n} link calls: ${JSON.stringify(await linkCalls(app))}`,
    );
  }
}

/** Wait for the link menu and return its items' actions. */
async function menuActions(app: App): Promise<(string | undefined)[]> {
  await waitFor(() => app.exists("[data-testid=link-menu]"), 2000, "menu");
  return await app.eval(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=link-menu-item]")]
      .map((el) => el.dataset.action)
  );
}

async function rightClick(app: App, pt: { x: number; y: number }) {
  await app.page.mouse.move(pt.x, pt.y);
  await app.page.mouse.down({ button: "right" });
  await app.page.mouse.up({ button: "right" });
}

async function modClick(app: App, id: string, needle: string): Promise<void> {
  const pt = await pointOf(app, id, needle);
  await app.page.keyboard.down(app.mod);
  await app.page.mouse.click(pt.x, pt.y);
  await app.page.keyboard.up(app.mod);
}

suite("links", (test) => {
  test("hover underlines only while the modifier is held", async (app) => {
    const id = await printLinks(app);
    await hover(app, id, "https://deno.com/", "https://deno.com/");
    assertEquals(await linkState(app, id), {
      hovered: "https://deno.com/",
      underline: false,
      pointer: false,
    });
    await app.page.keyboard.down(app.mod);
    await waitFor(
      async () => (await linkState(app, id))?.underline === true,
      2000,
      "underlined with the modifier",
    );
    assertEquals((await linkState(app, id))?.pointer, true);
    await app.page.keyboard.up(app.mod);
    await waitFor(
      async () => (await linkState(app, id))?.underline === false,
      2000,
      "plain again",
    );
    // The trailing ")." is not part of the second URL; OSC 8 links follow the modifier too.
    await hover(
      app,
      id,
      "https://docs.deno.com/runtime/",
      "https://docs.deno.com/runtime/",
    );
    await hover(
      app,
      id,
      "Qutty on GitHub",
      "https://github.com/Brainwires/qutty",
    );
    assertEquals((await linkState(app, id))?.underline, false);
    await app.page.keyboard.down(app.mod);
    await waitFor(
      async () => (await linkState(app, id))?.underline === true,
      2000,
      "OSC 8 underlined with the modifier",
    );
    await app.page.keyboard.up(app.mod);
    // Paths: only those that exist; never version numbers or times.
    await hover(app, id, "~/notes.md", "~/notes.md");
    await hover(
      app,
      id,
      "Source/qutty/src/main.ts:42:7",
      "Source/qutty/src/main.ts:42:7",
    );
    await hover(app, id, "./missing.ts", null);
    await hover(app, id, "1.2.3", null);
    await hover(app, id, "12:30", null);
  });

  test("⌘-click opens through the backend; a plain click does not", async (app) => {
    const id = await printLinks(app);
    await hover(app, id, "https://deno.com/", "https://deno.com/");
    const url = await pointOf(app, id, "https://deno.com/");
    await app.page.mouse.click(url.x, url.y);
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(await linkCalls(app), [], "a plain click opens nothing");

    // The plain click's mousedown drops xterm's current link; hover again to find it.
    await hover(app, id, "https://deno.com/", "https://deno.com/");
    await modClick(app, id, "https://deno.com/");
    await hover(
      app,
      id,
      "Qutty on GitHub",
      "https://github.com/Brainwires/qutty",
    );
    await modClick(app, id, "Qutty on GitHub");
    await hover(app, id, "~/notes.md", "~/notes.md");
    await modClick(app, id, "~/notes.md");
    await hover(app, id, "~/Downloads", "~/Downloads");
    await modClick(app, id, "~/Downloads");
    await hover(app, id, "my notes", "file:///Users/demo/notes.md");
    await modClick(app, id, "my notes");
    await callCount(app, 5);
    assertEquals(await linkCalls(app), [
      { kind: "url", url: "https://deno.com/" },
      { kind: "url", url: "https://github.com/Brainwires/qutty" },
      { kind: "open", path: "/Users/demo/notes.md" },
      { kind: "reveal", path: "/Users/demo/Downloads" },
      { kind: "open", path: "/Users/demo/notes.md" },
    ]);
  });

  test("a file with a line opens in the editor; the setting persists", async (app) => {
    const id = await printLinks(app);
    const err = "Source/qutty/src/main.ts:42:7";
    await hover(app, id, err, err);
    await modClick(app, id, err);
    // Auto: the first installed preset (the demo has code and zed).
    await waitFor(
      async () => (await linkCalls(app)).length === 1,
      3000,
      "the editor",
    );
    assertEquals((await linkCalls(app))[0], {
      kind: "edit",
      command: "code -g {file}:{line}:{col}",
      file: "/Users/demo/Source/qutty/src/main.ts",
      line: 42,
      col: 7,
    });

    await app.openSettings();
    await app.eval(() => {
      const el = document.querySelector<HTMLSelectElement>(
        "[data-testid=setting-links-editor]",
      )!;
      el.value = "zed";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(
      async () => (await app.settings()).links?.editor === "zed",
      2000,
      "the editor setting saved",
    );
    await app.reload();
    await app.openSettings();
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLSelectElement>(
          "[data-testid=setting-links-editor]",
        )!.value
      ),
      "zed",
    );
    await app.closeSettings();
    const id2 = await printLinks(app);
    await hover(app, id2, err, err);
    await modClick(app, id2, err);
    await waitFor(
      async () => (await linkCalls(app)).length === 1,
      3000,
      "the editor after the reload",
    );
    assertEquals(
      (await linkCalls(app))[0].command,
      "zed {file}:{line}:{col}",
    );
  });

  test("right-click on a link: its menu; Reveal and Copy", async (app) => {
    const id = await printLinks(app);
    await hover(app, id, "~/notes.md", "~/notes.md");
    const pt = await pointOf(app, id, "~/notes.md");
    await rightClick(app, pt);
    const actions = await menuActions(app);
    assertEquals(actions, ["open", "reveal", "copy"]);
    await app.click('[data-testid=link-menu-item][data-action="reveal"]');
    await waitFor(
      async () => !(await app.exists("[data-testid=link-menu]")),
      2000,
      "closed",
    );
    assertEquals(await linkCalls(app), [
      { kind: "reveal", path: "/Users/demo/notes.md" },
    ]);
    // Escape closes it without doing anything.
    await hover(app, id, "~/notes.md", "~/notes.md");
    await rightClick(app, pt);
    await waitFor(() => app.exists("[data-testid=link-menu]"), 2000, "again");
    await app.press("Escape");
    await waitFor(
      async () => !(await app.exists("[data-testid=link-menu]")),
      2000,
      "Escape",
    );
    assertEquals((await linkCalls(app)).length, 1);
  });

  test("SSH tile: a remote path offers Download; URLs open as usual", async (app) => {
    const id = await connectVia(app, "web-1");
    await app.typeInTerminal(id, "links\n");
    await app.waitForText(id, /not links: 1\.2\.3/);
    // The new tile glides into place: measure cells once it is still.
    await app.settle();
    const remote = "/home/demo/logs/app.log";
    await hover(app, id, remote, remote);
    await modClick(app, id, remote);
    const actions = await menuActions(app);
    assertEquals(actions, ["download", "copy"]);
    await app.click('[data-testid=link-menu-item][data-action="download"]');
    await waitFor(
      async () =>
        (await app.attr(
          `${tileSel(id)} [data-testid=transfer]`,
          "data-state",
        )) ===
          "done",
      5000,
      "downloaded",
    );
    assertEquals(await linkCalls(app), [], "nothing opened locally");
    await hover(app, id, "https://deno.com/", "https://deno.com/");
    await modClick(app, id, "https://deno.com/");
    await waitFor(
      async () => (await linkCalls(app)).length === 1,
      3000,
      "the URL",
    );
    assertEquals((await linkCalls(app))[0], {
      kind: "url",
      url: "https://deno.com/",
    });
  });
});
