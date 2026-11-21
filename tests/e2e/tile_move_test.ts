// Moving a tile to another window by its header's menu ("Move to Window"): two pages of the demo
// opened with `?peers=<name>` are each other's windows (lib/demo-windows.ts). The tile leaves its
// page without its terminal being killed and arrives in the other one, focused, with its output
// redrawn and its shell still answering. (The cross-window drag needs real windows: its geometry
// and the app process's side are unit-tested, tests/tile_move_test.ts.)

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { rightClick } from "./link_helpers.ts";

/** The middle of tile `id`'s header (its title). */
async function headerPoint(app: App, id: string) {
  return await app.eval((tid: string) => {
    const el = document.querySelector(
      `[data-testid=tile][data-id="${tid}"] [data-testid=tile-title]`,
    )!;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, id);
}

/** The tile ids of a page, in creation order. */
function tileIds(app: App): Promise<string[]> {
  return app.eval(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=tile]")].map((
      el,
    ) => el.dataset.id!)
  );
}

/** The actions of the open "Move to Window" menu. */
async function menuActions(app: App): Promise<string[]> {
  await waitFor(
    () => app.exists("[data-testid=tile-move-menu]"),
    3000,
    "the Move to Window menu",
  );
  return await app.eval(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[data-testid=tile-move-menu-item]",
      ),
    ].map((el) => el.dataset.action!)
  );
}

suite("tile move", (test) => {
  test(
    "tile move: Move to Window takes a tile and its running shell to the other window",
    async (app) => {
      const peer = await app.openPeer("peers=B");
      try {
        await app.page.bringToFront();
        const ids = await app.ensureTerminals(2);
        const moving = ids[1];
        await app.run(moving, "cd /tmp");
        await app.run(moving, "echo before-the-move");
        const peerBefore = await tileIds(peer);
        assertEquals(peerBefore.length, 1);

        // The header's menu lists the other window.
        await rightClick(app, await headerPoint(app, moving));
        assertEquals(await menuActions(app), ["source-control", "move:demo-B"]);
        await app.click(
          '[data-testid=tile-move-menu-item][data-action="move:demo-B"]',
        );

        // It leaves this window: its terminal was not killed, the other tile is focused.
        await waitFor(
          async () => !(await tileIds(app)).includes(moving),
          5000,
          "the tile gone from the first window",
        );
        assertEquals(await app.kills(), []);
        assertEquals(await app.focusedId(), ids[0]);

        // It arrives in the other one, focused, with its output and its shell's state.
        await peer.page.bringToFront();
        const arrived = await waitFor(
          async () => {
            const now = await tileIds(peer);
            return now.length === 2
              ? now.find((id) => !peerBefore.includes(id))
              : null;
          },
          5000,
          "the tile in the second window",
        );
        await waitFor(
          async () => (await peer.focusedId()) === arrived,
          3000,
          "the arrived tile focused",
        );
        assert(
          (await peer.readTerminalText(arrived)).includes("before-the-move"),
          "its output is redrawn",
        );
        const pwd = await peer.run(arrived, "pwd");
        assert(pwd.includes("/tmp"), `its shell kept its folder: ${pwd}`);
        const after = await peer.run(arrived, "echo after-the-move");
        assert(after.includes("after-the-move"), "its shell answers");
        assertEquals(await peer.kills(), []);
        peer.assertNoErrors();
      } finally {
        await peer.page.close();
      }
    },
    { query: "peers=A" },
  );

  test(
    "tile move: the menu lists no window when there is none, and moving back works",
    async (app) => {
      // Alone: a right click on a header lists no window (no other window, no tear-off in the
      // demo), only the terminal's own "Source Control for This Folder".
      const [only] = await app.ensureTerminals(1);
      await rightClick(app, await headerPoint(app, only));
      assertEquals(await menuActions(app), ["source-control"]);
      await app.press("Escape");
      await waitFor(
        async () => !(await app.exists("[data-testid=tile-move-menu]")),
        3000,
        "the menu closed",
      );

      const peer = await app.openPeer("peers=D");
      try {
        await app.page.bringToFront();
        await app.ensureTerminals(2);
        const moving = (await tileIds(app))[1];
        await rightClick(app, await headerPoint(app, moving));
        assertEquals(await menuActions(app), ["source-control", "move:demo-D"]);
        await app.click(
          '[data-testid=tile-move-menu-item][data-action="move:demo-D"]',
        );
        const arrived = await waitFor(
          async () => (await tileIds(peer))[1],
          5000,
          "the tile in the second window",
        );
        await peer.page.bringToFront();
        await peer.run(arrived, "echo went-over");
        // And back again, to the first window.
        await rightClick(peer, await headerPoint(peer, arrived));
        assertEquals(await menuActions(peer), [
          "source-control",
          "move:demo-C",
        ]);
        await peer.click(
          '[data-testid=tile-move-menu-item][data-action="move:demo-C"]',
        );
        await app.page.bringToFront();
        const back = await waitFor(
          async () => {
            const now = await tileIds(app);
            return now.length === 2 ? now[1] : null;
          },
          5000,
          "the tile back in the first window",
        );
        assert((await app.readTerminalText(back)).includes("went-over"));
        assertEquals((await tileIds(peer)).length, 1);
        peer.assertNoErrors();
      } finally {
        await peer.page.close();
      }
    },
    { query: "peers=C" },
  );
});
