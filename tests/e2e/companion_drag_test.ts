// Dragging Loopy to another corner against the demo backend (app/companion/use-loopy-drag.ts): a
// drag past the threshold moves the overlay with the pointer and snaps it to the nearest corner on
// release, saved as Settings → Companion → Corner, without the click that would open the chat; a
// press that barely moves is still a click; a drag that ends where it began snaps back.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const POKE = "[data-testid=loopy-poke]";
const INPUT = "[data-testid=loopy-chat-input]";

/** Wait until Loopy has sprung up and stands idle. */
function landed(app: App) {
  return waitFor(
    async () =>
      ["idle", "blink"].includes(
        await app.attr(OVERLAY, "data-loopy-state") ?? "",
      ),
    3000,
    "Loopy landed",
  );
}

/** The centre of Loopy's face, and the overlay's insets from the tile area's edges. */
function where(app: App) {
  return app.eval(
    (o: string, p: string) => {
      const overlay = document.querySelector<HTMLElement>(o)!;
      const r = overlay.getBoundingClientRect();
      const c = overlay.offsetParent!.getBoundingClientRect();
      const face = overlay.querySelector(p)!.getBoundingClientRect();
      return {
        x: face.left + face.width / 2,
        y: face.top + face.height / 2,
        left: Math.round(r.left - c.left),
        top: Math.round(r.top - c.top),
        right: Math.round(c.right - r.right),
        bottom: Math.round(c.bottom - r.bottom),
        translate: overlay.style.translate,
      };
    },
    OVERLAY,
    POKE,
  );
}

/**
 * A press with the left button held through the moves. Astral's `mouse.move` sends its moves
 * with no button down, which Chromium takes as the press being over, so this drives the CDP
 * directly.
 */
function press(app: App, x: number, y: number) {
  const input = app.cdp.Input;
  let at = { x, y };
  const send = (type: "mousePressed" | "mouseMoved" | "mouseReleased") =>
    input.dispatchMouseEvent({
      type,
      x: at.x,
      y: at.y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
    });
  return {
    down: async () => {
      await send("mouseMoved");
      await send("mousePressed");
    },
    async moveTo(tx: number, ty: number, steps = 6) {
      const from = at;
      for (let i = 1; i <= steps; i++) {
        at = {
          x: from.x + (tx - from.x) * i / steps,
          y: from.y + (ty - from.y) * i / steps,
        };
        await send("mouseMoved");
      }
    },
    up: () => send("mouseReleased"),
  };
}

suite("companion drag", (test) => {
  test("drag Loopy from the bottom right to the top left: it snaps there and the corner is saved; no chat", async (app) => {
    await landed(app);
    assertEquals(await app.attr(OVERLAY, "data-corner"), "bottom-right");
    const start = await where(app);
    const hand = press(app, start.x, start.y);
    await hand.down();
    await hand.moveTo(start.x - 300, start.y - 200, 8);
    // Mid-drag: the overlay follows the pointer.
    assertEquals(await app.attr(OVERLAY, "data-dragging"), "true");
    const mid = await where(app);
    assert(
      Math.abs(mid.x - (start.x - 300)) < 2 &&
        Math.abs(mid.y - (start.y - 200)) < 2,
      `followed the pointer: ${JSON.stringify(mid)}`,
    );
    await hand.moveTo(60, 60, 8);
    await hand.up();
    await waitFor(
      async () => (await app.attr(OVERLAY, "data-corner")) === "top-left",
      2000,
      "Loopy in the top left",
    );
    const end = await where(app);
    assertEquals(end.translate, "", "no offset once it snapped");
    assert(end.left >= 0 && end.left < 30, `left inset ${end.left}`);
    assert(end.top >= 0 && end.top < 30, `top inset ${end.top}`);
    assertEquals(await app.attr(OVERLAY, "data-dragging"), null);
    assertEquals((await app.settings()).companion.corner, "top-left");
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(await app.exists(INPUT), false, "the drag is not a click");

    // A plain click still opens the chat, from the new corner.
    await app.click(POKE);
    await waitFor(() => app.exists(INPUT), 2000, "the chat box");
  });

  test("a press that moves a few pixels is a click; a drag back to the same corner snaps back", async (app) => {
    await landed(app);
    const start = await where(app);
    const nudge = press(app, start.x, start.y);
    await nudge.down();
    await nudge.moveTo(start.x + 3, start.y - 2, 2);
    await nudge.up();
    await waitFor(() => app.exists(INPUT), 2000, "the chat box");
    assertEquals(await app.attr(OVERLAY, "data-corner"), "bottom-right");

    // Out and back: still the bottom right, the overlay where it was, the chat still open.
    const hand = press(app, start.x, start.y);
    await hand.down();
    await hand.moveTo(start.x - 120, start.y - 40, 5);
    assertEquals(await app.attr(OVERLAY, "data-dragging"), "true");
    await hand.moveTo(start.x - 10, start.y, 5);
    await hand.up();
    await waitFor(
      async () => (await app.attr(OVERLAY, "data-dragging")) === null,
      2000,
      "the drag over",
    );
    const after = await where(app);
    assertEquals(await app.attr(OVERLAY, "data-corner"), "bottom-right");
    assertEquals(after.translate, "");
    assertEquals([after.right, after.bottom], [start.right, start.bottom]);
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(await app.exists(INPUT), true, "the drag did not poke");
    assertEquals((await app.settings()).companion.corner, "bottom-right");
  });
});
