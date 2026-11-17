// The companion in every mood: each mood said with `qutty-hook say --mood`, its face checked (the
// mood, its rim, the brows on the head as drawn) and photographed, and the neutral face under the pointer (delighted) and in its
// highest idle brow pose. The close-ups are companion-mood-<theme>-<mood>.png in
// tests/e2e/__screenshots__ (and `COMPANION_SHOT_DIR` when set), with a contact sheet of each
// theme (companion-moods-<theme>.png): the pictures the PRs show.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { MOODS } from "../../lib/companion/face-machine.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const SVG = `${OVERLAY} svg.companion-avatar`;
const SHOT_DIR = join(ROOT, "tests/e2e/__screenshots__");

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The face as drawn: its mood, move, expression, and the bead's centre on screen. */
function avatar(app: App) {
  return app.eval((s: string) => {
    const svg = document.querySelector<SVGSVGElement>(s);
    if (!svg) return null;
    const r = svg.querySelector(".companion-bead")!.getBoundingClientRect();
    return {
      mood: svg.getAttribute("data-mood"),
      state: svg.getAttribute("data-state"),
      expr: svg.getAttribute("data-expr"),
      rim: getComputedStyle(svg.querySelector(".companion-bead")!).filter,
      cx: r.x + r.width / 2,
      cy: r.y + r.height / 2,
    };
  }, SVG);
}

/**
 * The brows as drawn, in the bead's own units (every move and pose applied): the highest point
 * of their stroke, and the farthest from the head's centre (80, 76).
 */
function browsOnHead(app: App) {
  return app.eval((s: string) => {
    const svg = document.querySelector<SVGSVGElement>(s)!;
    const bead = svg.querySelector<SVGGraphicsElement>(".companion-bead")!;
    const toBead = bead.getScreenCTM()!.inverse();
    let top = Infinity;
    let reach = 0;
    for (
      const path of svg.querySelectorAll<SVGPathElement>(
        ".companion-brows path",
      )
    ) {
      const half = parseFloat(getComputedStyle(path).strokeWidth) / 2;
      const ctm = path.getScreenCTM()!;
      const len = path.getTotalLength();
      for (let i = 0; i <= 40; i++) {
        const p = path.getPointAtLength((len * i) / 40)
          .matrixTransform(ctm).matrixTransform(toBead);
        top = Math.min(top, p.y - half);
        reach = Math.max(reach, Math.hypot(p.x - 80, p.y - 76) + half);
      }
    }
    return { top, reach };
  }, SVG);
}

/** Save `png` as `name` in SHOT_DIR (and COMPANION_SHOT_DIR when set). */
async function save(name: string, png: Uint8Array): Promise<void> {
  await Deno.mkdir(SHOT_DIR, { recursive: true });
  await Deno.writeFile(join(SHOT_DIR, name), png);
  const dir = Deno.env.get("COMPANION_SHOT_DIR");
  if (dir) {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeFile(join(dir, name), png);
  }
}

/** A close-up of the companion (the bubble hidden), as a PNG. */
async function closeUp(app: App): Promise<Uint8Array> {
  const a = (await avatar(app))!;
  return await app.page.screenshot({
    format: "png",
    clip: { x: a.cx - 75, y: a.cy - 70, width: 150, height: 118, scale: 3 },
  });
}

/** Hide (or show again) the speech bubble, so the close-ups show the face alone. */
function hideBubble(app: App, hide: boolean) {
  return app.eval((on: boolean) => {
    let el = document.getElementById("e2e-hide-bubble");
    if (on && !el) {
      el = document.createElement("style");
      el.id = "e2e-hide-bubble";
      el.textContent =
        ".companion-overlay .bubble-slot, .companion-overlay .companion-reaction { visibility: hidden !important; }";
      document.head.append(el);
    } else if (!on) el?.remove();
  }, hide);
}

/** Close the bubble on screen (it is hidden, so not through a pointer click). */
function closeBubble(app: App) {
  return app.eval(() => {
    document.querySelector<HTMLElement>(
      "[data-testid=companion-bubble-close]",
    )?.click();
  });
}

/** `bytes` in base64. */
function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** A labelled grid of the close-ups, photographed. */
async function contactSheet(
  app: App,
  shots: [string, Uint8Array][],
): Promise<Uint8Array> {
  const items = shots.map(([label, png]) => [
    label,
    `data:image/png;base64,${base64(png)}`,
  ]);
  const size = await app.eval((list: string[][]) => {
    const sheet = document.createElement("div");
    sheet.id = "e2e-contact-sheet";
    sheet.style.cssText =
      "position:fixed;left:0;top:0;z-index:99999;display:grid;grid-template-columns:repeat(4,170px);gap:6px;padding:10px;background:#15191e;color:#e8ecef;font:600 13px system-ui";
    for (const [label, src] of list) {
      const fig = document.createElement("figure");
      fig.style.cssText = "margin:0;text-align:center";
      const img = document.createElement("img");
      img.src = src;
      img.style.cssText = "width:170px;height:134px;display:block";
      const cap = document.createElement("figcaption");
      cap.textContent = label;
      fig.append(img, cap);
      sheet.append(fig);
    }
    document.body.append(sheet);
    const r = sheet.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, items);
  await pause(300);
  const png = await app.page.screenshot({
    format: "png",
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 2 },
  });
  await app.eval(() => document.getElementById("e2e-contact-sheet")?.remove());
  return png;
}

/** The theme `id` (Settings → Appearance). */
async function setTheme(app: App, id: string): Promise<void> {
  await app.openSettings("appearance");
  await app.click(`[data-testid=setting-theme][data-value="${id}"]`);
  await waitFor(
    () =>
      app.eval(
        (t: string) =>
          document.documentElement.getAttribute("data-theme") === t,
        id,
      ),
    2000,
    `theme ${id}`,
  );
  await app.closeSettings();
}

/** The brows as drawn stay on the head (tests/companion_brows_test.ts checks the geometry). */
async function assertBrowsOnHead(app: App, what: string): Promise<void> {
  const b = await browsOnHead(app);
  // The bead's top is at y 47 and its radius 29; a little slack for a pose still easing in.
  assert(b.top >= 53.5, `${what}: the brows' top ${b.top.toFixed(2)}`);
  assert(b.reach <= 27.5, `${what}: the brows reach ${b.reach.toFixed(2)}`);
}

/** How long a mood's own entrance (the wow's word, the blush's cheeks) takes to finish, ms. */
const SETTLE_MS: Record<string, number> = { wow: 3_400 };

/** Every mood photographed in `theme`, the neutral face's poses, and the sheet. */
async function photograph(app: App, theme: string): Promise<void> {
  const shell = (await app.focusedId())!;
  await waitFor(
    async () => ["idle", "blink"].includes((await avatar(app))?.state ?? ""),
    3000,
    "the companion landed",
  );
  await hideBubble(app, true);
  const shots: [string, Uint8Array][] = [];
  for (const mood of MOODS) {
    await app.run(
      shell,
      `qutty-hook say Mood ${mood} --mood ${mood} --timeout 0`,
    );
    await waitFor(
      async () => {
        const a = await avatar(app);
        return a?.mood === mood && ["idle", "blink", "think", "point"].includes(
          a.state ?? "",
        );
      },
      4000,
      `the ${mood} face`,
    );
    await pause(SETTLE_MS[mood] ?? 1_400);
    const a = (await avatar(app))!;
    assert(
      mood === "neutral" ? a.rim === "none" : a.rim.includes("drop-shadow"),
      `${mood}: its rim (${a.rim})`,
    );
    await assertBrowsOnHead(app, mood);
    const png = await closeUp(app);
    await save(`companion-mood-${theme}-${mood}.png`, png);
    shots.push([mood, png]);
    await closeBubble(app);
  }
  // The neutral face under the pointer (delighted), and its highest idle brow pose.
  await waitFor(
    async () => (await avatar(app))?.mood === "neutral",
    3000,
    "neutral again",
  );
  const a = (await avatar(app))!;
  await app.page.mouse.move(a.cx + 2, a.cy + 4, { steps: 4 });
  await waitFor(
    async () => (await avatar(app))?.expr === "delighted",
    3000,
    "delighted under the pointer",
  );
  await pause(700);
  await assertBrowsOnHead(app, "delighted");
  const delighted = await closeUp(app);
  await save(`companion-mood-${theme}-neutral-delighted.png`, delighted);
  shots.push(["neutral (pointer over)", delighted]);
  await app.page.mouse.move(5, 5, { steps: 4 });
  await waitFor(
    async () => (await avatar(app))?.expr !== "delighted",
    3000,
    "not delighted once the pointer left",
  );
  await app.eval((s: string) => {
    document.querySelector(s)!.setAttribute("data-expr", "brow-raise");
  }, SVG);
  await pause(900);
  await assertBrowsOnHead(app, "brow-raise");
  const raised = await closeUp(app);
  await save(`companion-mood-${theme}-neutral-brow-raise.png`, raised);
  shots.push(["neutral (brow raise)", raised]);
  await hideBubble(app, false);
  await save(`companion-moods-${theme}.png`, await contactSheet(app, shots));
  assertEquals(shots.length, MOODS.length + 2);
}

suite("companion moods", (test) => {
  test(
    "every mood's face, photographed (dark theme), with the neutral face's poses",
    (app) => photograph(app, "sea-glass"),
    { width: 1100, height: 760 },
  );
  test(
    "every mood's face, photographed (light theme)",
    async (app) => {
      await setTheme(app, "paper");
      await photograph(app, "paper");
    },
    { width: 1100, height: 760 },
  );
});
