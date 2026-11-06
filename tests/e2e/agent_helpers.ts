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
