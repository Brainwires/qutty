// Screenshots of the key states into tests/e2e/__screenshots__/ (gitignored). No pixel diffing:
// each shot must be a real, non-blank PNG of the viewport's size. Useful for eyeballing a change.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { PATTERNS } from "../../lib/workspace/store.ts";
import { THEME_IDS } from "../../lib/workspace/themes.ts";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import {
  connectVia,
  dropFiles,
  filter,
  openConnections,
  tileSel,
} from "./ssh_helpers.ts";

const DIR = join(ROOT, "tests/e2e/__screenshots__");
const W = 1280;
const H = 800;

/** Take a screenshot and check it is a PNG of the viewport size with some real content. */
async function shot(app: App, name: string): Promise<void> {
  await app.settle();
  await Deno.mkdir(DIR, { recursive: true });
  const path = join(DIR, `${name}.png`);
  const png = await app.screenshot(path);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assertEquals([...png.slice(0, 8)], sig, `${name}: PNG signature`);
  const view = new DataView(png.buffer, png.byteOffset);
  // IHDR width/height (device pixels: the viewport times its scale factor).
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  const vp = await app.eval(() => ({ w: innerWidth, h: innerHeight }));
  assert(w >= vp.w && h >= vp.h && w % vp.w === 0, `${name}: ${w}x${h}`);
  assert(png.length > 8_000, `${name}: ${png.length} bytes looks blank`);
  const stat = await Deno.stat(path);
  assertEquals(stat.size, png.length);
}

suite("visual", (test) => {
  test("screenshot: boot", async (app) => {
    await shot(app, "01-boot");
  }, { width: W, height: H });

  test("screenshot: every pattern with five terminals", async (app) => {
    const ids = await app.ensureTerminals(5);
    await app.run(ids[4], "ls");
    await app.run(ids[3], "colors");
    for (const [i, p] of PATTERNS.entries()) {
      await app.setPatternViaSettings(p);
      await app.closeSettings();
      await shot(app, `02-pattern-${i}-${p}`);
    }
  }, { width: W, height: H });

  test("screenshot: inactive tiles scaled", async (app) => {
    await app.setInactiveTiles("scale");
    await app.closeSettings();
    const ids = await app.ensureTerminals(5);
    await app.run(ids[0], "ls");
    await app.run(ids[1], "colors");
    await app.run(ids[2], "stress 40");
    await app.typeInTerminal(ids[3], "top\n");
    await app.waitForText(ids[3], "demo top");
    await app.focusChip(ids[4]);
    await app.run(ids[4], "size");
    await shot(app, "09-inactive-tiles-scaled");
  }, { width: W, height: H });

  test("screenshot: settings panel open", async (app) => {
    await app.ensureTerminals(3);
    await app.openSettings();
    await shot(app, "03-settings");
  }, { width: W, height: H });

  test("screenshot: settings panel in every theme", async (app) => {
    const ids = await app.ensureTerminals(3);
    await app.run(ids[1], "colors");
    await app.run(ids[2], "ls");
    for (const id of THEME_IDS) {
      await app.openSettings();
      await app.click(`[data-testid=setting-theme][data-value="${id}"]`);
      await waitFor(
        () =>
          app.eval(
            (t: string) => document.documentElement.dataset.theme === t,
            id,
          ),
        2000,
        `theme ${id}`,
      );
      await shot(app, `08-theme-${id}`);
    }
  }, { width: W, height: H });

  test("screenshot: bar on each edge", async (app) => {
    await app.ensureTerminals(4);
    for (const p of ["bottom", "left", "right"]) {
      await app.setBarPosition(p);
      await app.closeSettings();
      await shot(app, `04-bar-${p}`);
    }
  }, { width: W, height: H });

  test("screenshot: bar overflow menu", async (app) => {
    for (let i = 1; i < 14; i++) await app.newTerminal("shortcut");
    await waitFor(() => app.exists("[data-testid=bar-more]"), 3000, "+N");
    await app.click("[data-testid=bar-more]");
    await waitFor(
      () => app.exists("[data-testid=overflow-menu]"),
      2000,
      "menu",
    );
    await shot(app, "05-bar-overflow-menu");
  }, { width: 900, height: H });

  test("screenshot: exited terminal and activity", async (app) => {
    const a = (await app.focusedId())!;
    const b = await app.newTerminal();
    await app.typeInTerminal(b, "top\n");
    await app.waitForText(b, "demo top");
    await app.focusChip(a);
    await waitFor(
      async () =>
        (await app.attr(
          `[data-testid=chip][data-id="${b}"]`,
          "data-activity",
        )) === "true",
      4000,
      "activity",
    );
    await app.typeInTerminal(a, "exit\n");
    await app.waitForText(a, "process exited");
    await shot(app, "06-exited-and-activity");
  }, { width: W, height: H });

  test("screenshot: SSH connection manager", async (app) => {
    await app.ensureTerminals(2);
    await connectVia(app, "web-1");
    await openConnections(app);
    await filter(app, "");
    await shot(app, "09-ssh-dialog");
    await app.click("[data-testid=host-edit]");
    await waitFor(() => app.exists("[data-testid=host-form]"), 2000, "form");
    await shot(app, "09-ssh-dialog-form");
  }, { width: W, height: H });

  test(
    "screenshot: SSH tiles, a transfer in progress and a disconnect",
    async (app) => {
      await app.ensureTerminals(2);
      const down = await connectVia(app, "db");
      await app.typeInTerminal(down, "exit 255\n");
      await waitFor(
        () => app.exists(`${tileSel(down)} [data-testid=disconnected]`),
        3000,
        "disconnected",
      );
      const id = await connectVia(app, "prod");
      await app.typeInTerminal(id, "cd /srv/app\n");
      await app.waitForText(id, /:\/srv\/app\$/);
      const files = Array.from(
        { length: 12 },
        (_, i) => `build-${i + 1}.tar.gz`,
      );
      await dropFiles(app, id, files);
      await app.click(`${tileSel(id)} [data-testid=upload-yes]`);
      await waitFor(
        async () =>
          (await app.attr(
              `${tileSel(id)} [data-testid=transfer]`,
              "data-state",
            )) === "running" &&
          Number(
              await app.attr(
                `${tileSel(id)} [role=progressbar]`,
                "aria-valuenow",
              ),
            ) >= 40,
        3000,
        "a running upload, partway",
      );
      await shot(app, "10-ssh-tile");
    },
    { width: W, height: H },
  );

  test("screenshot: empty state", async (app) => {
    await app.shortcut("KeyW");
    await waitFor(() => app.exists("[data-testid=empty]"), 3000, "empty");
    await shot(app, "07-empty");
  }, { width: W, height: H });
});
