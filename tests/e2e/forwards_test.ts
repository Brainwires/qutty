// The port-forward panel in the UI, against the demo backend (lib/ssh-demo.ts: prod-api is a
// Qutty host with the favourite `L 8080:localhost:80`; db's config has a LocalForward): from an
// SSH tile's header (start a favourite, add, refuse a bad spec, show ssh's error, stop) and from
// the connection manager's detail pane (a host with no connection, config forwards).

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import {
  connectVia,
  DIALOG,
  filter,
  openConnections,
  textOf,
  tileSel,
} from "./ssh_helpers.ts";

const PANEL = "[data-testid=forwards-panel]";
const FORWARDS = "[data-testid=forwards-dialog]";

function rowKeys(app: App, testid: string): Promise<string[]> {
  return app.eval(
    (t: string) =>
      [...document.querySelectorAll<HTMLElement>(`[data-testid=${t}]`)].map(
        (el) => el.dataset.key!,
      ),
    testid,
  );
}

async function waitRows(app: App, testid: string, want: string[]) {
  await waitFor(
    async () =>
      JSON.stringify(await rowKeys(app, testid)) === JSON.stringify(want),
    3000,
    `${testid} rows ${JSON.stringify(want)}`,
  );
}

async function typeSpec(app: App, text: string): Promise<void> {
  await app.eval(() => {
    const el = document.querySelector<HTMLInputElement>(
      "[data-testid=forward-spec]",
    )!;
    el.focus();
    el.select();
  });
  await app.page.keyboard.type(text);
}

suite("forwards", (test) => {
  test("tile: start a favourite, add one, refuse bad input, show ssh's error, stop", async (app) => {
    const id = await connectVia(app, "prod");
    await app.click(`${tileSel(id)} [data-testid=tile-forwards]`);
    await waitFor(() => app.exists(FORWARDS), 2000, "the forwards dialog");
    await waitFor(
      async () => (await app.attr(PANEL, "data-master")) === "true",
      3000,
      "the connection checked",
    );
    assertEquals(await app.exists("[data-testid=forwards-none]"), true);
    await waitRows(app, "forward-favorite", ["L 8080:localhost:80"]);

    // A favourite starts on the live connection.
    await app.click("[data-testid=forward-start]");
    await waitRows(app, "forward-row", ["L 8080:localhost:80"]);
    assert(
      (await textOf(app, "[data-testid=forward-row]")).includes(
        "local 8080 → localhost:80",
      ),
    );

    // Option injection never leaves the form.
    await typeSpec(app, "8080:-oProxyCommand=x:80");
    await app.press("Enter");
    await waitFor(
      () => app.exists("[data-testid=forward-spec-error]"),
      2000,
      "the spec error",
    );
    assertEquals(
      await textOf(app, "[data-testid=forward-spec-error]"),
      "-oProxyCommand=x is not a host.",
    );
    await waitRows(app, "forward-row", ["L 8080:localhost:80"]);

    // ssh's own refusal is shown.
    await typeSpec(app, "80:localhost:80");
    await app.click("[data-testid=forward-add]");
    await waitFor(
      () => app.exists("[data-testid=forwards-error]"),
      2000,
      "ssh's error",
    );
    assert(
      (await textOf(app, "[data-testid=forwards-error]")).includes(
        "Permission denied",
      ),
    );

    // A dynamic forward, kept as a favourite.
    await app.click("[data-testid=forward-kind][data-kind=dynamic]");
    await typeSpec(app, "1080");
    await app.click("[data-testid=forward-save]");
    await app.click("[data-testid=forward-add]");
    await waitRows(app, "forward-row", ["L 8080:localhost:80", "D 1080"]);
    await waitRows(app, "forward-favorite", ["L 8080:localhost:80", "D 1080"]);
    assertEquals(await app.exists("[data-testid=forwards-error]"), false);

    // Stop one; forget a favourite.
    await app.click(
      '[data-testid=forward-row][data-key="L 8080:localhost:80"] [data-testid=forward-cancel]',
    );
    await waitRows(app, "forward-row", ["D 1080"]);
    await app.click(
      '[data-testid=forward-favorite][data-key="D 1080"] [data-testid=forward-forget]',
    );
    await waitRows(app, "forward-favorite", ["L 8080:localhost:80"]);

    // Escape closes it and the keyboard goes back to the tile.
    await app.press("Escape");
    await waitFor(async () => !(await app.exists(FORWARDS)), 2000, "closed");
    await waitFor(() => app.xtermHasFocus(id), 2000, "focus back in the tile");
    // Reopened: the forward is still running on the connection.
    await app.click(`${tileSel(id)} [data-testid=tile-forwards]`);
    await waitRows(app, "forward-row", ["D 1080"]);
  });

  test("connections dialog: forwards of a host without a connection, and config ones", async (app) => {
    await openConnections(app);
    await filter(app, "db");
    await waitFor(
      async () => (await app.count("[data-testid=conn-row]")) === 1,
      2000,
      "db alone",
    );
    await app.click("[data-testid=host-forwards]");
    await waitFor(() => app.exists(PANEL), 2000, "the panel in the pane");
    await waitFor(
      async () => (await app.attr(PANEL, "data-master")) === "false",
      3000,
      "not connected",
    );
    assert(
      (await textOf(app, "[data-testid=forwards-status]")).startsWith(
        "Not connected",
      ),
    );
    assertEquals(
      await app.attr("[data-testid=forward-add]", "disabled"),
      "",
      "nothing to add to",
    );
    assert(
      (await textOf(app, "[data-testid=forwards-configured]")).includes(
        "local 5432 → localhost:5432",
      ),
    );
    // Not a Qutty host: no favourites, a hint instead.
    assertEquals(await app.exists("[data-testid=forward-save]"), false);
    // Escape goes back to the detail view, a second one closes the dialog.
    await app.press("Escape");
    await waitFor(
      () => app.exists("[data-testid=host-detail]"),
      2000,
      "back to the detail",
    );
    assert(await app.exists(DIALOG));
    await app.click("[data-testid=host-forwards]");
    await app.click("[data-testid=conn-forwards-back]");
    await waitFor(
      () => app.exists("[data-testid=host-detail]"),
      2000,
      "back again",
    );
  });
});
