// A real pointer drag for the e2e suite: the left button held through the moves (Loopy's drag,
// free-form tiles' moves and resizes).

import type { App } from "./harness.ts";

/**
 * A press with the left button held through the moves. Astral's `mouse.move` sends its moves
 * with no button down, which Chromium takes as the press being over, so this drives the CDP
 * directly.
 */
export function press(app: App, x: number, y: number) {
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
