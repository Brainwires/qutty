// Real screenshots of Qutty for qutty.org, taken from the app's browser build with its demo
// backend (`?pty=demo`: demo shells, demo agents, the demo companion brain), driven in HEADLESS
// Chromium through Astral with the e2e suite's own helpers (tests/e2e/harness.ts). No window is
// ever shown.
//
//   cd site && deno task screenshots      # runs with the repo's deno.json (the app's imports)
//
// It exports the app (the repo root's `deno task export`, as the e2e suite does; set
// SHOTS_NO_BUILD=1 to reuse the current out/), serves it on a loopback port, takes each picture
// at 1440x900 CSS pixels and device scale 2, and writes WebP files (2000 px wide, via `cwebp`)
// to site/public/screenshots/. PNG originals stay in a temp folder.

import { launch, type Page } from "@astral/astral";
import { contentType } from "@std/media-types";
import { copy } from "@std/fs";
import { extname, fromFileUrl, join } from "@std/path";
import { App, ROOT, waitFor } from "../../tests/e2e/harness.ts";
import { launchAgent } from "../../tests/e2e/agent_helpers.ts";
import { modClick } from "../../tests/e2e/link_helpers.ts";
import { newWebTile, printUrl } from "../../tests/e2e/web_helpers.ts";
import { tileSel } from "../../tests/e2e/ssh_helpers.ts";

const OUT_DIR = fromFileUrl(new URL("../public/screenshots/", import.meta.url));
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;
/** The WebP files' width in pixels. */
const WEBP_WIDTH = 2000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the app, exported and served ------------------------------------------------------------

async function exportApp(): Promise<string> {
  if (Deno.env.get("SHOTS_NO_BUILD") !== "1") {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["task", "export"],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      throw new Error(`export failed:\n${new TextDecoder().decode(out.stderr)}`);
    }
  }
  const dir = await Deno.makeTempDir({ prefix: "qutty-shots-" });
  await copy(join(ROOT, "out"), join(dir, "site"));
  return join(dir, "site");
}

function serveDir(dir: string, hostname = "127.0.0.1") {
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname, port: 0, signal: ac.signal, onListen() {} },
    async (req) => {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path.endsWith("/")) path += "index.html";
      if (path.includes("..")) return new Response("bad path", { status: 400 });
      try {
        return new Response(await Deno.readFile(join(dir, path)), {
          headers: { "content-type": contentType(extname(path)) ?? "application/octet-stream" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  );
  return {
    port: server.addr.port,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** A small local "dev server" page for the web tile to show (web tiles embed localhost pages). */
const DEV_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Orbit — dashboard</title><style>
body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#f6f7fb;color:#1d2433}
header{display:flex;align-items:center;gap:12px;padding:14px 24px;background:#fff;border-bottom:1px solid #e3e6ee}
header b{font-size:17px} header span{color:#6b7385}
main{padding:24px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.c{background:#fff;border:1px solid #e3e6ee;border-radius:10px;padding:16px}
.c h2{margin:0 0 6px;font-size:13px;color:#6b7385;font-weight:600}
.c p{margin:0;font-size:28px;font-weight:700}
.w{grid-column:1/-1;height:220px;display:flex;align-items:flex-end;gap:10px;padding:16px}
.w i{flex:1;background:linear-gradient(#7c8cff,#4f5fe0);border-radius:6px 6px 0 0}
</style></head><body><header><b>Orbit</b><span>localhost:5173 · dev</span></header><main>
<div class="c"><h2>Builds today</h2><p>42</p></div><div class="c"><h2>Passing</h2><p>97.6%</p></div>
<div class="c"><h2>Median time</h2><p>3m 12s</p></div>
<div class="c w">${
  [40, 62, 55, 80, 71, 90, 66, 84, 95, 73, 88, 60].map((h) => `<i style="height:${h}%"></i>`)
    .join("")
}</div>
</main></body></html>`;

function serveDevPage() {
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen() {} },
    () => new Response(DEV_PAGE, { headers: { "content-type": "text/html" } }),
  );
  return {
    origin: `http://localhost:${server.addr.port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

// ---- helpers ---------------------------------------------------------------------------------

async function setTheme(app: App, theme: string): Promise<void> {
  await app.openSettings("appearance");
  await app.click(`[data-testid=setting-theme][data-value="${theme}"]`);
  await app.closeSettings();
}

/** Open terminals until there are `n`, each running a demo command. */
async function busyTerminals(app: App, commands: string[]): Promise<string[]> {
  const ids = await app.ensureTerminals(commands.length);
  for (const [i, id] of ids.entries()) {
    // `top` keeps running (the demo's live table): typed, not waited for.
    if (commands[i] === "top") await app.typeInTerminal(id, "top\n");
    else if (commands[i]) await app.run(id, commands[i]);
  }
  return ids;
}

const OVERLAY = "[data-testid=companion-overlay]";
const CHAT_INPUT = "[data-testid=companion-chat-input]";

/** Ask the companion (the demo brain) `question`; wait for a bubble starting with `answer`. */
async function companionAnswer(app: App, question: string, answer: string): Promise<void> {
  await waitFor(
    async () => ["idle", "blink"].includes(await app.attr(OVERLAY, "data-companion-state") ?? ""),
    5000,
    "the companion landed",
  );
  if (!(await app.exists(CHAT_INPUT))) await app.click("[data-testid=companion-poke]");
  await waitFor(
    () => app.eval((s: string) => document.activeElement?.matches(s) ?? false, CHAT_INPUT),
    3000,
    "the chat input",
  );
  await app.page.keyboard.type(question);
  await app.press("Enter");
  await waitFor(
    () =>
      app.eval(
        (s: string, want: string) =>
          document.querySelector(`${s} [data-testid=companion-bubble-text]`)?.textContent
            ?.startsWith(want) ?? false,
        "[data-testid=companion-bubble]",
        answer,
      ),
    8000,
    "the companion's answer",
  );
}

// ---- the shots -------------------------------------------------------------------------------

interface Shot {
  name: string;
  alt: string;
  take(app: App, extra: { devOrigin: string }): Promise<void>;
}

const SHOTS: Shot[] = [
  {
    name: "cascade",
    alt: "Five terminals in the cascade layout, the focused one largest",
    async take(app) {
      const ids = await busyTerminals(app, ["ls", "top", "date", "ls", "help"]);
      // Focus a few, so the recency order (and the sizes) step down.
      for (const i of [1, 3, 4]) await app.focusChip(ids[i]);
    },
  },
  {
    name: "harness",
    alt: "Claude Code in a terminal tile with Qutty's frame: header card, prompt box and side rail",
    async take(app) {
      const shell = (await app.focusedId())!;
      await app.run(shell, "ls");
      const claude = await launchAgent(app, "claude");
      await app.typeInTerminal(claude, "/help\n");
      await waitFor(
        () => app.exists(`${tileSel(claude)} [data-testid=harness-frame]`),
        5000,
        "the harness frame",
      );
      await app.click(`${tileSel(claude)} [data-testid=harness-input]`);
      await app.page.keyboard.type("add a test for the layout engine's spiral pattern");
      await app.page.mouse.move(WIDTH - 10, HEIGHT / 2);
    },
  },
  {
    name: "browser",
    alt: "A web tile showing a local development server next to the terminal that printed its URL",
    async take(app, { devOrigin }) {
      const url = `${devOrigin}/`;
      const term = await printUrl(app, url);
      await modClick(app, term, url);
      const web = await newWebTile(app, [term]);
      await waitFor(
        async () =>
          (await app.attr(`${tileSel(web)} [data-testid=web-body]`, "data-load")) ===
            "complete",
        8000,
        "the page loaded",
      );
      await app.page.mouse.move(WIDTH / 2, HEIGHT - 5);
    },
  },
  {
    name: "companion",
    alt: "The companion answering a question about the tiles in its speech bubble",
    async take(app) {
      const ids = await busyTerminals(app, ["help", "top", "ls"]);
      await app.focusChip(ids[0]);
      await companionAnswer(app, "what's in tile 2?", "Tile 2");
    },
  },
  {
    name: "theme-light",
    alt: "Qutty in the light Cloud theme",
    async take(app) {
      await setTheme(app, "cloud");
      const ids = await busyTerminals(app, ["ls", "help", "date", "colors"]);
      await app.focusChip(ids[3]);
    },
  },
  {
    name: "theme-dark",
    alt: "Qutty in the dark Plum theme",
    async take(app) {
      await setTheme(app, "plum");
      const ids = await busyTerminals(app, ["ls", "help", "date", "colors"]);
      await app.focusChip(ids[3]);
    },
  },
];

async function toWebp(png: string, webp: string): Promise<void> {
  const out = await new Deno.Command("cwebp", {
    args: ["-quiet", "-q", "80", "-m", "6", "-resize", String(WEBP_WIDTH), "0", png, "-o", webp],
  }).output();
  if (!out.success) throw new Error(`cwebp failed: ${new TextDecoder().decode(out.stderr)}`);
}

async function main(): Promise<void> {
  const only = Deno.env.get("SHOTS_ONLY")?.split(",");
  const site = await exportApp();
  const app = serveDir(site);
  const dev = serveDevPage();
  const origin = `http://127.0.0.1:${app.port}`;
  const pngDir = await Deno.makeTempDir({ prefix: "qutty-shots-png-" });
  await Deno.mkdir(OUT_DIR, { recursive: true });
  const profile = await Deno.makeTempDir({ prefix: "qutty-shots-chrome-" });
  const browser = await launch({
    headless: true, // never a visible window
    path: Deno.env.get("E2E_CHROME") || undefined,
    args: [
      "--force-prefers-no-reduced-motion",
      // Device scale 2 from the start: xterm measures its cells at boot.
      `--force-device-scale-factor=${SCALE}`,
      `--user-data-dir=${profile}`,
    ],
  });
  const skipped: string[] = [];
  try {
    for (const shot of SHOTS) {
      if (only && !only.includes(shot.name)) continue;
      const page: Page = await browser.newPage();
      try {
        const qa = new App(page, origin, { width: WIDTH, height: HEIGHT });
        await qa.boot();
        await shot.take(qa, { devOrigin: dev.origin });
        await qa.settle();
        await pause(700); // the layout's animated transitions and the blink settle
        const png = join(pngDir, `${shot.name}.png`);
        await Deno.writeFile(png, await page.screenshot({ format: "png" }));
        await toWebp(png, join(OUT_DIR, `${shot.name}.webp`));
        const errors = qa.errors.length ? ` (page errors: ${qa.errors.join("; ")})` : "";
        console.log(`shot: ${shot.name}.webp${errors}`);
      } catch (e) {
        skipped.push(`${shot.name}: ${e instanceof Error ? e.message : e}`);
        console.error(`shot: skipped ${shot.name}: ${e instanceof Error ? e.message : e}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await Deno.remove(profile, { recursive: true }).catch(() => {});
    await app.close();
    await dev.close();
  }
  console.log(`PNG originals: ${pngDir}`);
  if (skipped.length) {
    console.error(`skipped:\n  ${skipped.join("\n  ")}`);
    Deno.exitCode = 1;
  }
}

if (import.meta.main) await main();
