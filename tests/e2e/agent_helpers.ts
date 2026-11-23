// Shared helpers for the agent hub and companion e2e suites (not a test module itself).

import { type App, waitFor } from "./harness.ts";

/** Start `agent:<name>` from the `+` picker; returns the new tile's id once it greeted. */
export async function launchAgent(app: App, name: string): Promise<string> {
  const before = new Set((await app.chips()).map((c) => c.id));
  await app.click("[data-testid=bar-new-menu]");
  const entry = `[data-testid=launch-item][data-id="agent:${name}"]`;
  await waitFor(() => app.exists(entry), 3000, "the picker");
  await app.click(entry);
  const id = await waitFor(
    async () => {
      const f = await app.focusedId();
      return f && !before.has(f) ? f : null;
    },
    5000,
    `the ${name} tile`,
  );
  await app.waitForText(id, "/help for commands");
  return id;
}

/** Right-click the middle of tile `id`'s header (again, while it takes) until `item` shows. */
export async function tileMenuWith(
  app: App,
  id: string,
  item: string,
): Promise<void> {
  await waitFor(
    async () => {
      if (await app.exists(item)) return true;
      const head = await app.eval((sel: string) => {
        const box = document.querySelector(sel)?.getBoundingClientRect();
        return box ? [box.x + box.width / 2, box.y + box.height / 2] : null;
      }, `[data-testid=tile][data-id="${id}"] .tile-head`);
      if (!head) return false;
      await app.page.mouse.move(head[0], head[1]);
      await app.page.mouse.down({ button: "right" });
      await app.page.mouse.up({ button: "right" });
      await new Promise((r) => setTimeout(r, 300));
      return await app.exists(item);
    },
    5000,
    `${item} in ${id}'s header menu`,
  );
}
