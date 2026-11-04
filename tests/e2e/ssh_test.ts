// SSH in the UI, against the demo backend (lib/ssh-demo.ts: web-1 and db from ~/.ssh/config,
// prod-api saved in qutty.conf as a red-tinted favorite): the connection manager, SSH tiles
// (label, badge, tint, Disconnected + Reconnect), uploads by drop and the download picker.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { suite, waitFor } from "./harness.ts";
import {
  connectVia,
  DIALOG,
  dropFiles,
  FILTER,
  filter,
  openConnections,
  rowKeys,
  selectedKey,
  textOf,
  tileSel,
  waitForRemotePrompt,
} from "./ssh_helpers.ts";

suite("ssh", (test) => {
  // ---- The dialog ---------------------------------------------------------------------------

  test("dialog: opens from the bar button and the shortcut, Escape closes it", async (app) => {
    const first = (await app.focusedId())!;
    await openConnections(app, "button");
    assertEquals(
      await app.attr("[data-testid=bar-connections]", "aria-expanded"),
      "true",
    );
    // Workspace shortcuts do not reach the tiles while it is open.
    await app.shortcut("KeyT");
    assertEquals((await app.chips()).length, 1, "⌘T is held back");
    await app.press("Escape");
    await waitFor(async () => !(await app.exists(DIALOG)), 2000, "closed");
    await waitFor(
      () => app.xtermHasFocus(first),
      2000,
      "focus back in the terminal",
    );
    await openConnections(app, "shortcut");
    // The shortcut toggles it closed again.
    await app.shortcut("KeyO", { shift: true });
    await waitFor(
      async () => !(await app.exists(DIALOG)),
      2000,
      "toggled closed",
    );
    // A click on the backdrop closes it too.
    await openConnections(app);
    await app.clickAt(5, 300);
    await waitFor(
      async () => !(await app.exists(DIALOG)),
      2000,
      "backdrop click",
    );
  });

  test("dialog: the bar button is there with the bar on a vertical edge", async (app) => {
    await app.setBarPosition("left");
    await app.closeSettings();
    await openConnections(app, "button");
    await app.click("[data-testid=conn-close]");
    await waitFor(async () => !(await app.exists(DIALOG)), 2000, "closed");
  });

  test("dialog: groups, filter by alias / HostName / user / tag, ↑↓ selection", async (app) => {
    await openConnections(app);
    assertEquals(await rowKeys(app), [
      "favorites:prod-api",
      "config:web-1",
      "config:db",
    ]);
    assertEquals(await selectedKey(app), "favorites:prod-api");
    await app.press("ArrowDown");
    await app.press("ArrowDown");
    assertEquals(await selectedKey(app), "config:db");
    await app.press("ArrowDown");
    assertEquals(await selectedKey(app), "config:db", "clamped at the end");
    await app.press("ArrowUp");
    assertEquals(await selectedKey(app), "config:web-1");
    // The detail pane follows the selection: user, host, key, other directives, read-only.
    assertEquals(await textOf(app, "[data-testid=host-detail-label]"), "web-1");
    const detail = await textOf(app, "[data-testid=host-detail]");
    assert(detail.includes("deploy") && detail.includes("web-1.example.com"));
    assert(detail.includes("~/.ssh/id_ed25519"));
    assert(detail.includes("ForwardAgent"), detail);
    assert(await app.exists("[data-testid=host-readonly]"));
    for (
      const [q, keys] of [
        ["prod", ["favorites:prod-api"]], // tag and alias
        ["10.0.0", ["config:db"]], // HostName
        ["postgres", ["config:db"]], // user
        ["primary", ["config:db"]], // a second alias
      ] as const
    ) {
      await filter(app, q);
      await waitFor(
        async () => (await rowKeys(app)).join() === keys.join(),
        2000,
        `filter ${q}`,
      );
    }
    await filter(app, "zz!"); // not a host name either, so no quick connect
    await waitFor(
      () => app.exists("[data-testid=conn-empty]"),
      2000,
      "no match",
    );
  });

  test("connect: Enter opens an SSH tile with the host label, badge and tint", async (app) => {
    const id = await connectVia(app, "prod");
    const tile = tileSel(id);
    assertEquals(await app.attr(tile, "data-ssh"), "true");
    assertEquals(await app.attr(tile, "data-tint"), "red");
    assertEquals(
      await textOf(app, `${tile} [data-testid=tile-title]`),
      "prod-api",
    );
    assert(await app.exists(`${tile} [data-testid=tile-ssh-badge]`));
    assertEquals(
      await textOf(app, `[data-testid=chip][data-id="${id}"] .chip-title`),
      "prod-api",
    );
    assertEquals(
      await app.attr(`[data-testid=chip][data-id="${id}"]`, "data-tint"),
      "red",
    );
    // The tint is the theme's red, on the border.
    const colors = await app.eval((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)!;
      const probe = document.createElement("div");
      probe.style.color = getComputedStyle(document.documentElement)
        .getPropertyValue("--tint-red");
      document.body.append(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      return { border: getComputedStyle(el).borderTopColor, red };
    }, tile);
    assertEquals(colors.border, colors.red);
    // The remote session is in the terminal, and the title is not replaced by polling.
    await app.waitForText(id, "Welcome to api.example.com");
    await new Promise((r) => setTimeout(r, 2300));
    assertEquals(
      await textOf(app, `${tile} [data-testid=tile-title]`),
      "prod-api",
    );
    // It went to Recent.
    await openConnections(app);
    assert((await rowKeys(app)).includes("recent:prod-api"));
  });

  test("connect: double-click on a row and the Connect button", async (app) => {
    await openConnections(app);
    await app.eval(() =>
      document.querySelector<HTMLElement>('[data-key="config:db"]')!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    );
    const db = await waitFor(async () => {
      const f = await app.focusedId();
      return f && f !== "t1" ? f : null;
    });
    await app.waitForText(db, "Welcome to 10.0.0.5");
    await openConnections(app);
    await filter(app, "web");
    await app.click("[data-testid=host-connect]");
    await waitFor(
      async () => (await app.chips()).length === 3,
      3000,
      "third tile",
    );
  });

  test("quick connect: user@host:port that matches nothing, then the save offer", async (app) => {
    await openConnections(app);
    await filter(app, "root@1.2.3.4:2022");
    await waitFor(() => app.exists("[data-testid=conn-quick]"), 2000, "offer");
    assertMatch(
      await textOf(app, "[data-testid=conn-quick]"),
      /Connect to\s*root@1\.2\.3\.4:2022/,
    );
    const id = await connectVia(app, "root@1.2.3.4:2022");
    const tile = tileSel(id);
    assertEquals(
      await textOf(app, `${tile} [data-testid=tile-title]`),
      "root@1.2.3.4:2022",
    );
    assertEquals(await app.attr(tile, "data-tint"), null);
    await app.waitForText(id, "root@1.2.3.4:~$");
    // Save it: the form opens prefilled.
    await app.click(`${tile} [data-testid=save-offer-yes]`);
    await waitFor(
      () => app.exists("[data-testid=host-form]"),
      2000,
      "the form",
    );
    assertEquals(
      await app.eval(() =>
        ["alias", "hostName", "user", "port"].map((k) =>
          document.querySelector<HTMLInputElement>(`[data-testid=form-${k}]`)!
            .value
        )
      ),
      ["1.2.3.4", "1.2.3.4", "root", "2022"],
    );
    await app.click("[data-testid=form-save]");
    await waitFor(
      async () => (await selectedKey(app)) === "qutty:1.2.3.4",
      2000,
      "saved and selected",
    );
    assert(
      !(await app.exists(`${tile} [data-testid=save-offer]`)),
      "offer gone",
    );
  });

  test("hosts: create, edit (rename) and delete a Qutty host", async (app) => {
    await openConnections(app);
    await app.click("[data-testid=conn-new]");
    await waitFor(() => app.exists("[data-testid=host-form]"), 2000, "form");
    const type = async (key: string, text: string) => {
      await app.eval((k: string) => {
        const el = document.querySelector<HTMLInputElement>(
          `[data-testid=form-${k}]`,
        )!;
        el.focus();
        el.select();
      }, key);
      await app.page.keyboard.type(text);
    };
    // A mistake is shown next to its field, before anything is saved.
    await type("alias", "lab");
    await type("port", "99999");
    await app.click("[data-testid=form-save]");
    await waitFor(
      () => app.exists("[data-testid=form-error-port]"),
      2000,
      "port error",
    );
    await type("port", "2200");
    await type("hostName", "lab.local");
    await type("user", "me");
    await type("tags", "dev, lab");
    await app.click('[data-testid=form-tint][data-value="green"]');
    await app.eval(() =>
      document.querySelector<HTMLInputElement>("[data-testid=form-user]")!
        .focus()
    );
    await app.press("Enter"); // submits the form from a field
    await waitFor(
      async () => (await selectedKey(app)) === "qutty:lab",
      2000,
      "saved",
    );
    const detail = await textOf(app, "[data-testid=host-detail]");
    assert(detail.includes("lab.local") && detail.includes("2200"), detail);
    assertEquals(
      await app.attr('[data-key="qutty:lab"] .conn-tint', "data-tint"),
      "green",
    );
    // Rename.
    await app.click("[data-testid=host-edit]");
    await waitFor(
      () => app.exists("[data-testid=host-form]"),
      2000,
      "edit form",
    );
    await type("alias", "lab2");
    await app.click("[data-testid=form-save]");
    await waitFor(
      async () => (await selectedKey(app)) === "qutty:lab2",
      2000,
      "renamed",
    );
    assert(!(await rowKeys(app)).includes("qutty:lab"));
    // Delete, confirmed inside the pane; Cancel first keeps it.
    await app.click("[data-testid=host-delete]");
    await waitFor(
      () => app.exists("[data-testid=host-confirm-delete]"),
      2000,
      "confirm",
    );
    await app.click("[data-testid=host-confirm-delete-no]");
    assert((await rowKeys(app)).includes("qutty:lab2"));
    await app.click("[data-testid=host-delete]");
    await app.click("[data-testid=host-confirm-delete-yes]");
    await waitFor(
      async () => !(await rowKeys(app)).includes("qutty:lab2"),
      2000,
      "deleted",
    );
    assert(await app.exists(DIALOG), "still open");
  });

  test("hosts: config hosts are read-only and can be duplicated; backend errors show inline", async (app) => {
    await openConnections(app);
    await filter(app, "web-1");
    await waitFor(
      async () => (await selectedKey(app)) === "config:web-1",
      2000,
      "web-1",
    );
    assert(!(await app.exists("[data-testid=host-edit]")));
    assert(!(await app.exists("[data-testid=host-delete]")));
    await app.click("[data-testid=host-duplicate]");
    await waitFor(() => app.exists("[data-testid=host-form]"), 2000, "form");
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLInputElement>("[data-testid=form-alias]")!
          .value
      ),
      "web-1-copy",
    );
    // Escape in the form goes back to the detail view, not out of the dialog.
    await app.press("Escape");
    await waitFor(
      async () => !(await app.exists("[data-testid=host-form]")),
      2000,
      "back",
    );
    assert(await app.exists(DIALOG));
    await app.click("[data-testid=host-duplicate]");
    await waitFor(
      () => app.exists("[data-testid=host-form]"),
      2000,
      "form again",
    );
    await app.click("[data-testid=form-save]");
    await waitFor(
      async () => (await selectedKey(app)) === "qutty:web-1-copy",
      2000,
      "duplicated",
    );
    // Saving over a config host's alias: the backend refuses, the dialog says why.
    await app.click("[data-testid=conn-new]");
    await app.eval(() =>
      document.querySelector<HTMLInputElement>("[data-testid=form-alias]")!
        .focus()
    );
    await app.page.keyboard.type("db");
    await app.click("[data-testid=form-save]");
    await waitFor(() => app.exists("[data-testid=conn-error]"), 2000, "error");
    assertMatch(await textOf(app, "[data-testid=conn-error]"), /ssh\/config/);
  });

  // ---- SSH tiles ----------------------------------------------------------------------------

  test("disconnect: the overlay, no restart on Enter, Reconnect, Close", async (app) => {
    const id = await connectVia(app, "web-1");
    const tile = tileSel(id);
    await app.typeInTerminal(id, "exit 255\n");
    await waitFor(
      () => app.exists(`${tile} [data-testid=disconnected]`),
      3000,
      "overlay",
    );
    assertEquals(
      await textOf(app, `${tile} [data-testid=disconnected-code]`),
      "code 255",
    );
    assertMatch(
      await textOf(app, `${tile} [data-testid=disconnected-message]`),
      /could not connect, or the connection dropped/,
    );
    // The keyboard is on Reconnect; Enter in the dead terminal itself does nothing.
    await waitFor(
      () =>
        app.eval(() =>
          document.activeElement?.getAttribute("data-testid") === "reconnect"
        ),
      2000,
      "Reconnect focused",
    );
    await app.eval(
      (sel: string) =>
        document.querySelector<HTMLTextAreaElement>(
          `${sel} .xterm-helper-textarea`,
        )!
          .focus(),
      tile,
    );
    await app.press("Enter");
    await new Promise((r) => setTimeout(r, 300));
    assertEquals((await app.terminal(id))?.exited, true);
    await app.click(`${tile} [data-testid=reconnect]`);
    await waitFor(
      async () => !(await app.exists(`${tile} [data-testid=disconnected]`)),
      3000,
      "reconnected",
    );
    const text = await app.waitForText(id, "[reconnecting…]");
    // The old session's output stays above the new one.
    assert(
      text.indexOf("Connection to web-1.example.com closed.") <
        text.indexOf("[reconnecting…]"),
    );
    await waitFor(
      async () =>
        (await app.readTerminalText(id)).split("Welcome to").length === 3,
      3000,
      "a second session",
    );
    await app.typeInTerminal(id, "exit\n");
    await waitFor(
      () => app.exists(`${tile} [data-testid=disconnected]`),
      3000,
      "again",
    );
    assertEquals(
      await textOf(app, `${tile} [data-testid=disconnected-message]`),
      "The session ended.",
    );
    await app.click(`${tile} [data-testid=disconnected-close]`);
    await waitFor(async () => !(await app.exists(tile)), 3000, "closed");
  });

  test("shells still restart on Enter (unchanged)", async (app) => {
    const id = (await app.focusedId())!;
    await app.typeInTerminal(id, "exit\n");
    await app.waitForText(id, "press Enter to restart");
    assert(!(await app.exists(`${tileSel(id)} [data-testid=disconnected]`)));
    await app.press("Enter");
    await app.waitForPrompt(id);
  });

  test("upload: drop on an SSH tile, confirm into the OSC 7 folder, progress, cancel", async (app) => {
    const id = await connectVia(app, "web-1");
    const tile = tileSel(id);
    // No OSC 7 yet would mean `~`; the demo's remote shell reports its folder on each prompt.
    await app.typeInTerminal(id, "cd /srv/app\n");
    await app.waitForText(id, /:\/srv\/app\$/);
    await dropFiles(app, id, ["a.txt", "b.txt", "c.txt"]);
    assertMatch(
      await textOf(app, `${tile} [data-testid=upload-confirm]`),
      /Upload 3 items to/,
    );
    assertEquals(
      await app.eval(
        (sel: string) =>
          document.querySelector<HTMLInputElement>(
            `${sel} [data-testid=upload-dir]`,
          )!.value,
        tile,
      ),
      "/srv/app",
    );
    // Cancel drops the question.
    await app.click(`${tile} [data-testid=upload-no]`);
    await waitFor(
      async () => !(await app.exists(`${tile} [data-testid=upload-confirm]`)),
      2000,
      "cancelled question",
    );
    // Again, and upload: a progress row, then Cancel → Cancelled, dismissible.
    await dropFiles(app, id, ["a.txt", "b.txt", "c.txt"]);
    await app.click(`${tile} [data-testid=upload-yes]`);
    await waitFor(
      async () =>
        (await app.attr(`${tile} [data-testid=transfer]`, "data-state")) ===
          "running" &&
        Number(
            (await textOf(app, `${tile} [data-testid=transfer-percent]`))
              .replace("%", ""),
          ) > 0,
      3000,
      "progress",
    );
    assertMatch(
      await textOf(app, `${tile} [data-testid=transfer-text]`),
      /Uploading [abc]\.txt/,
    );
    assertMatch(await textOf(app, `${tile} [data-testid=transfer]`), /\d\/3/);
    await app.click(`${tile} [data-testid=transfer-cancel]`);
    await waitFor(
      async () =>
        (await app.attr(`${tile} [data-testid=transfer]`, "data-state")) ===
          "cancelled",
      2000,
      "cancelled",
    );
    assertEquals(
      await textOf(app, `${tile} [data-testid=transfer-text]`),
      "Upload cancelled",
    );
    await app.click(`${tile} [data-testid=transfer-dismiss]`);
    await waitFor(
      async () => !(await app.exists(`${tile} [data-testid=transfer]`)),
      2000,
      "dismissed",
    );
    // One file to the folder typed into the strip, to completion.
    await dropFiles(app, id, ["notes.md"]);
    await app.eval((sel: string) => {
      const el = document.querySelector<HTMLInputElement>(
        `${sel} [data-testid=upload-dir]`,
      )!;
      el.focus();
      el.select();
    }, tile);
    await app.page.keyboard.type("/tmp");
    await app.press("Enter");
    await waitFor(
      async () =>
        (await app.attr(`${tile} [data-testid=transfer]`, "data-state")) ===
          "done",
      5000,
      "done",
    );
    assertEquals(
      await textOf(app, `${tile} [data-testid=transfer-text]`),
      "Uploaded 1 item to /tmp",
    );
  });

  test("upload: a shell tile does not take drops; Reconnect re-reads the folder", async (app) => {
    const shell = (await app.focusedId())!;
    await app.eval((sel: string) => {
      const el = document.querySelector(`${sel} [data-testid=tile-body]`)!;
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "a.txt"));
      el.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
        }),
      );
    }, tileSel(shell));
    assert(!(await app.exists("[data-testid=upload-confirm]")));
    // Reconnecting forgets the old session's folder; the new session's prompt reports it again.
    const id = await connectVia(app, "db");
    await app.typeInTerminal(id, "cd /var/log\n");
    await app.waitForText(id, /:\/var\/log\$/);
    await app.typeInTerminal(id, "exit 1\n");
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=disconnected]`),
      3000,
      "down",
    );
    await app.click(`${tileSel(id)} [data-testid=reconnect]`);
    await waitForRemotePrompt(app, id);
    await dropFiles(app, id, ["x.bin"]);
    const dir = await app.eval(
      (sel: string) =>
        document.querySelector<HTMLInputElement>(
          `${sel} [data-testid=upload-dir]`,
        )!.value,
      tileSel(id),
    );
    assertEquals(dir, "/home/demo");
    await app.press("Escape");
    await waitFor(
      async () => !(await app.exists("[data-testid=upload-confirm]")),
      2000,
      "Escape cancels",
    );
  });

  test("download: browse folders, pick a file, saved path shown", async (app) => {
    const id = await connectVia(app, "web-1");
    const tile = tileSel(id);
    await app.click(`${tile} [data-testid=tile-download]`);
    await waitFor(
      () => app.exists("[data-testid=remote-browser]"),
      2000,
      "browser",
    );
    await waitFor(
      async () =>
        (await textOf(app, "[data-testid=remote-path]")) === "/home/demo",
      3000,
      "the home listing",
    );
    const names = () =>
      app.eval(() =>
        [...document.querySelectorAll<HTMLElement>("[data-testid=remote-row]")]
          .map((el) => el.dataset.name)
      );
    assertEquals((await names())[0], "src", "folders first");
    // Enter opens the selected folder; Backspace goes back up.
    await app.press("Enter");
    await waitFor(
      async () =>
        (await textOf(app, "[data-testid=remote-path]")) === "/home/demo/src",
      3000,
      "src",
    );
    assertEquals(await names(), ["lib.rs", "main.rs"]);
    await app.press("Backspace");
    await waitFor(
      async () =>
        (await textOf(app, "[data-testid=remote-path]")) === "/home/demo",
      3000,
      "back home",
    );
    await app.click('[data-testid=remote-row][data-name="notes.md"]');
    assertEquals(
      await textOf(app, "[data-testid=remote-download]"),
      "Download",
    );
    await app.click("[data-testid=remote-download]");
    await waitFor(
      async () => !(await app.exists("[data-testid=remote-browser]")),
      2000,
      "closed",
    );
    await waitFor(
      async () =>
        (await app.attr(`${tile} [data-testid=transfer]`, "data-state")) ===
          "done",
      5000,
      "downloaded",
    );
    assertEquals(
      await textOf(app, `${tile} [data-testid=transfer-text]`),
      "Saved to /Users/demo/Downloads/notes.md",
    );
    // A folder, with Escape closing the picker without downloading first.
    await app.click(`${tile} [data-testid=tile-download]`);
    await waitFor(
      () => app.exists("[data-testid=remote-browser]"),
      2000,
      "browser",
    );
    await app.press("Escape");
    await waitFor(
      async () => !(await app.exists("[data-testid=remote-browser]")),
      2000,
      "esc",
    );
    await app.click(`${tile} [data-testid=tile-download]`);
    await waitFor(
      () => app.exists('[data-testid=remote-row][data-name="src"].is-selected'),
      3000,
      "src selected",
    );
    assertEquals(
      await textOf(app, "[data-testid=remote-download]"),
      "Download folder",
    );
    await app.click("[data-testid=remote-download]");
    await waitFor(
      async () => (await app.count(`${tile} [data-testid=transfer]`)) === 2,
      3000,
      "second transfer",
    );
  });

  test("filter field keeps focus while rows are clicked", async (app) => {
    await openConnections(app);
    await app.click('[data-testid=conn-row][data-key="config:db"]');
    assertEquals(await selectedKey(app), "config:db");
    assert(
      await app.eval(
        (s: string) => document.activeElement?.matches(s) ?? false,
        FILTER,
      ),
    );
  });
});
