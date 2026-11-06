// The shared Docker sandbox's UI against the demo backend (lib/sandbox/demo.ts: the real
// lifecycle over a pretend docker): Settings → Sandbox and its status line, the picker's
// "Run in sandbox" / "Run on host" toggle, plain `+` following "new tiles open in the sandbox",
// and the badge and tint on sandboxed tiles.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

const ARROW = "[data-testid=bar-new-menu]";
const MENU = "[data-testid=launch-menu]";
const TOGGLE = "[data-testid=launch-sandbox]";
const item = (id: string) => `[data-testid=launch-item][data-id="${id}"]`;
const tile = (id: string) => `[data-testid=tile][data-id="${id}"]`;

/** Settings → Sandbox → Shared container (the section opened if folded). */
async function shareSandbox(app: App): Promise<void> {
  await app.openSettings();
  await waitFor(
    () => app.exists("[data-testid=sandbox-settings]"),
    2000,
    "the sandbox section",
  );
  await app.click('[data-testid=setting-sandbox-mode][data-value="shared"]');
  await waitFor(
    async () => (await app.settings()).sandbox?.mode === "shared",
    2000,
    "sandbox mode shared",
  );
}

async function chipIds(app: App): Promise<Set<string>> {
  return new Set((await app.chips()).map((c) => c.id));
}

/** Wait for a new focused tile (not in `before`). */
function newFocused(app: App, before: Set<string>): Promise<string> {
  return waitFor(
    async () => {
      const f = await app.focusedId();
      return f && !before.has(f) ? f : null;
    },
    5000,
    "a new focused terminal",
  );
}

/** Launch the bash entry from the picker; returns the new tile's id. */
async function launchBash(app: App): Promise<string> {
  const before = await chipIds(app);
  if (!(await app.exists(MENU))) await app.click(ARROW);
  await waitFor(() => app.exists(item("shell:/bin/bash")), 3000, "picker");
  await app.click(item("shell:/bin/bash"));
  return await newFocused(app, before);
}

const isSandboxed = (app: App, id: string) =>
  app.eval(
    (s: string) =>
      document.querySelector<HTMLElement>(s)?.dataset.sandbox === "true",
    tile(id),
  );

suite("sandbox", (test) => {
  test("settings: off by default; Shared container shows the status line and persists fields", async (app) => {
    await app.openSettings();
    assertEquals((await app.settings()).sandbox?.mode ?? "off", "off");
    assertEquals(await app.exists("[data-testid=sandbox-status]"), false);
    assertEquals(
      await app.attr("[data-testid=setting-sandbox-image]", "disabled"),
      "",
    );
    await shareSandbox(app);
    await waitFor(
      () => app.exists("[data-testid=sandbox-status]"),
      3000,
      "the status line",
    );
    await waitFor(
      async () =>
        (await app.attr("[data-testid=sandbox-status]", "data-phase")) ===
          "stopped",
      3000,
      "phase stopped",
    );
    const detail = await app.eval(() =>
      document.querySelector("[data-testid=sandbox-detail]")?.textContent ?? ""
    );
    assert(detail.includes("qutty-sandbox-main"), detail);
    // A checkbox and the image field persist.
    await app.click("[data-testid=setting-sandbox-network]");
    await waitFor(
      async () => (await app.settings()).sandbox.network === false,
      2000,
      "network off",
    );
    await app.eval(() => {
      const input = document.querySelector<HTMLInputElement>(
        "[data-testid=setting-sandbox-image]",
      )!;
      input.value = "ubuntu:24.04";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(
      async () => (await app.settings()).sandbox.image === "ubuntu:24.04",
      2000,
      "the image",
    );
    // Start from the status line; Stop stops it.
    await app.click("[data-testid=sandbox-restart]");
    await waitFor(
      async () =>
        (await app.attr("[data-testid=sandbox-status]", "data-phase")) ===
          "running",
      4000,
      "running",
    );
    await app.click("[data-testid=sandbox-stop]");
    await waitFor(
      async () =>
        (await app.attr("[data-testid=sandbox-status]", "data-phase")) ===
          "stopped",
      4000,
      "stopped",
    );
  });

  test("picker: no toggle while off; Run in sandbox / Run on host decide where a pick runs", async (app) => {
    await app.click(ARROW);
    await waitFor(() => app.exists(item("shell:/bin/bash")), 3000, "picker");
    assertEquals(await app.exists(TOGGLE), false);
    await app.click(ARROW);
    await shareSandbox(app);
    await app.closeSettings();

    await app.click(ARROW);
    await waitFor(() => app.exists(TOGGLE), 3000, "the toggle");
    assertEquals(await app.attr(TOGGLE, "aria-checked"), "true");
    const inside = await launchBash(app);
    await app.waitForText(inside, "root@qutty-sandbox", 5000);
    assert(await isSandboxed(app, inside));
    assert(
      await app.exists(`${tile(inside)} [data-testid=tile-sandbox-badge]`),
    );
    assertEquals(await app.attr(tile(inside), "data-tint"), "green");

    // The toggle flips without closing the menu; the next pick runs on the host.
    await app.click(ARROW);
    await waitFor(() => app.exists(TOGGLE), 3000, "the toggle");
    await app.click(TOGGLE);
    assertEquals(await app.attr(TOGGLE, "aria-checked"), "false");
    assert(await app.exists(MENU), "the menu stays open");
    const host = await launchBash(app);
    await app.waitForPrompt(host);
    assertEquals(await isSandboxed(app, host), false);
    assertEquals(
      await app.exists(`${tile(host)} [data-testid=tile-sandbox-badge]`),
      false,
    );
    // Reopening starts from the default again.
    await app.click(ARROW);
    await waitFor(() => app.exists(TOGGLE), 3000, "the toggle");
    assertEquals(await app.attr(TOGGLE, "aria-checked"), "true");
  });

  test("plain +: follows “new tiles open in the sandbox”; the first tile stays on the host", async (app) => {
    const [first] = (await app.tiles()).map((t) => t.id);
    await shareSandbox(app);
    await app.closeSettings();
    assertEquals(await isSandboxed(app, first), false);
    const before = await chipIds(app);
    await app.click("[data-testid=bar-new]");
    const inside = await newFocused(app, before);
    await app.waitForText(inside, "root@qutty-sandbox", 5000);
    assert(await isSandboxed(app, inside));
    // Turned off: plain + opens on the host.
    await app.openSettings();
    await app.click("[data-testid=setting-sandbox-newTilesInSandbox]");
    await waitFor(
      async () => (await app.settings()).sandbox.newTilesInSandbox === false,
      2000,
      "default off",
    );
    await app.closeSettings();
    const host = await app.newTerminal();
    assertEquals(await isSandboxed(app, host), false);
  });
});
