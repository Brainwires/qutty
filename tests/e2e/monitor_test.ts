// The lite system monitor against the demo backend (lib/sysstats-demo.ts: the demo shell's
// `load <cpu> [gpu]` pins the fake figures), sampled every 250 ms here (`statsMs`): the bar meter
// (off by default, on and off in Settings), Loopy's hot face after a sustained load and its cool
// down with hysteresis, never over an `ask_user` question's attention face, and off with Lively.
// Also takes the hot face's screenshot (and the meter's), copied where `LOOPY_HOT_SHOT` says.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { launchAgent } from "./agent_helpers.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const METER = "[data-testid=sys-meter]";
const QUERY = "statsMs=250";
const SHOT_DIR = join(ROOT, "tests/e2e/__screenshots__");

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Loopy's face mood (`hot` while hot). */
function mood(app: App): Promise<string | null> {
  return app.attr(`${OVERLAY} svg.loopy`, "data-mood");
}

/** Set a System monitor slider (the panel must be open) and fire `input`. */
async function setMonitorSlider(app: App, key: string, value: number) {
  await app.eval(
    (k: string, v: number) => {
      const el = document.querySelector<HTMLInputElement>(
        `[data-testid=setting-monitor-${k}]`,
      )!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    key,
    value,
  );
  await waitFor(
    async () =>
      ((await app.settings()) as unknown as {
        monitor: Record<string, number>;
      }).monitor[key] === value,
    2000,
    `${key} = ${value}`,
  );
}

/** Hot after 2 s (the shortest) so the suite is quick. */
async function quickHot(app: App) {
  await app.openSettings();
  await setMonitorSlider(app, "sustainS", 2);
  await app.closeSettings();
}

/** Pin the demo machine's figures from the focused tile. */
async function load(app: App, args: string) {
  const id = (await app.focusedId())!;
  await app.run(id, `load ${args}`);
}

/** The meter's figures, by key. */
function meter(app: App) {
  return app.eval((s: string) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return Object.fromEntries(
      [...el.querySelectorAll<HTMLElement>(".sys-meter-row")].map((r) => [
        r.dataset.testid!.replace("sys-meter-", ""),
        { value: Number(r.dataset.value), level: r.dataset.level },
      ]),
    );
  }, METER);
}

suite("system monitor", (test) => {
  test(
    "the bar meter: off by default, on in Settings, follows the load, off again",
    async (app) => {
      await pause(800);
      assert(!(await app.exists(METER)), "no meter by default");
      await app.openSettings();
      await app.click("[data-testid=setting-monitor-meter]");
      await app.closeSettings();
      await waitFor(() => app.exists(METER), 3000, "the meter");
      await waitFor(
        async () => {
          const m = await meter(app);
          return m?.cpu && m.gpu && m.cpu.value < 40 ? m : null;
        },
        3000,
        "a calm machine's figures",
      );
      await load(app, "95 40");
      const busy = await waitFor(
        async () => {
          const m = await meter(app);
          return m?.cpu && m.cpu.value >= 94 && m.gpu.value <= 41 ? m : null;
        },
        5000,
        "CPU 95%, GPU 40%",
      );
      assertEquals(busy.cpu.level, "hot");
      assertEquals(busy.gpu.level, "calm");
      const title = await app.attr(METER, "title");
      assert(
        /^CPU \d+% · GPU \d+% · memory 41%$/.test(title ?? ""),
        title ?? "",
      );
      await app.openSettings();
      await app.click("[data-testid=setting-monitor-meter]");
      await app.closeSettings();
      await waitFor(async () => !(await app.exists(METER)), 2000, "no meter");
    },
    { query: QUERY },
  );

  test(
    "hot Loopy: after a sustained load, stays hot above the cool line, cools below it",
    async (app) => {
      await quickHot(app);
      await waitFor(async () => (await mood(app)) === "neutral", 3000, "idle");
      await load(app, "20 96");
      const t0 = Date.now();
      await waitFor(async () => (await mood(app)) === "hot", 8000, "hot");
      assert(Date.now() - t0 >= 2000, "not before the 2 s are up");
      // Between the lines (70–85%): still hot.
      await load(app, "75 75");
      await pause(3500);
      assertEquals(await mood(app), "hot", "75% stays hot");
      await load(app, "10 10");
      await waitFor(async () => (await mood(app)) === "neutral", 8000, "cool");
      // A short spike does not make it hot.
      await load(app, "99");
      await pause(900);
      await load(app, "10");
      await pause(2600);
      assertEquals(await mood(app), "neutral", "a spike is not hot");
    },
    { query: QUERY },
  );

  test(
    "hot Loopy: never over an ask_user question; hot again once it is answered",
    async (app) => {
      await quickHot(app);
      await load(app, "97");
      await waitFor(async () => (await mood(app)) === "hot", 8000, "hot");
      const claude = await launchAgent(app, "claude");
      await app.typeInTerminal(claude, "/ask Ship it?\n");
      await waitFor(
        async () => (await mood(app)) === "attention",
        4000,
        "the question's attention face",
      );
      await pause(1500);
      assertEquals(await mood(app), "attention", "hot never replaces it");
      await app.click("[data-testid=loopy-action]");
      await waitFor(async () => (await mood(app)) === "hot", 5000, "hot again");
    },
    { query: QUERY },
  );

  test("hot Loopy: off in Settings, and off with Lively", async (app) => {
    await quickHot(app);
    await load(app, "97");
    await waitFor(async () => (await mood(app)) === "hot", 8000, "hot");
    await app.openSettings();
    await app.click("[data-testid=setting-companion-lively]");
    await waitFor(
      async () => (await mood(app)) === "neutral",
      3000,
      "no Lively",
    );
    await app.click("[data-testid=setting-companion-lively]");
    await waitFor(async () => (await mood(app)) === "hot", 8000, "hot again");
    await app.click("[data-testid=setting-monitor-hot]");
    await waitFor(async () => (await mood(app)) === "neutral", 3000, "off");
    await app.closeSettings();
  }, { query: QUERY });

  test("screenshot: the hot face and the bar meter", async (app) => {
    await app.openSettings();
    await app.click("[data-testid=setting-monitor-meter]");
    await setMonitorSlider(app, "sustainS", 2);
    await app.closeSettings();
    await load(app, "93 88");
    await waitFor(async () => (await mood(app)) === "hot", 8000, "hot");
    await app.page.mouse.move(5, 500);
    await pause(1200);
    const box = await app.eval(
      (o: string, m: string) => {
        const b = document.querySelector(`${o} .loopy-bead`)!
          .getBoundingClientRect();
        const r = document.querySelector(m)!.getBoundingClientRect();
        return {
          face: { x: b.x + b.width / 2, y: b.y + b.height / 2 },
          meter: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      },
      OVERLAY,
      METER,
    );
    const face = await app.page.screenshot({
      format: "png",
      clip: {
        x: box.face.x - 80,
        y: box.face.y - 85,
        width: 160,
        height: 150,
        scale: 3,
      },
    });
    const bar = await app.page.screenshot({
      format: "png",
      clip: {
        x: box.meter.x - 8,
        y: box.meter.y - 6,
        width: box.meter.width + 16,
        height: box.meter.height + 12,
        scale: 3,
      },
    });
    await Deno.mkdir(SHOT_DIR, { recursive: true });
    await Deno.writeFile(join(SHOT_DIR, "loopy-hot.png"), face);
    await Deno.writeFile(join(SHOT_DIR, "sys-meter.png"), bar);
    const copy = Deno.env.get("LOOPY_HOT_SHOT");
    if (copy) {
      await Deno.writeFile(copy, face);
      await Deno.writeFile(copy.replace(/\.png$/, "-meter.png"), bar);
    }
  }, { query: QUERY });
});
