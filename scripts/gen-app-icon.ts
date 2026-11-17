// Generates the app icon: the companion's face (app/companion/companion-face.tsx) on a dark teal
// squircle, on the macOS 824/1024 grid (a 1024 canvas, a 100 px margin, a continuous-corner
// squircle and the standard soft drop shadow).
//
// The face is the component's default mood, "neutral" (the face it wears at rest), drawn here as a
// standalone SVG: the bead, brows, eyes and mouth are the component's shapes (its FACES.neutral)
// with the styles of public/styles.css (.companion-avatar …) resolved into it: the ink, the eye
// whites, the colour accents (the teal irises with their catch-lights) and the small closed smile.
// The neutral face has no cheeks and no tinted rim (the rim is for the other moods), so neither
// does the icon. Change the face there, then mirror it in `face()` below and run this again.
// Every size is rasterized by headless Chromium (Astral, as the e2e harness launches it) at its own
// size, so each one is sharp; 32 px and under draw a simpler face (bolder ink, dark pupils looking
// straight out) that still reads.
//
// Writes icons/source.png (the 1024 master), icons/app-1024.png, icons/app.png (512, Linux),
// icons/app.icns (iconutil, 16–1024 @1x/@2x), icons/app.ico (16–256) and public/favicon.png (64).
// public/tray.png is made from icons/app-1024.png by scripts/gen-tray-icons.ts.
//
//   deno run -A scripts/gen-app-icon.ts [--preview <dir>]

import { launch } from "@astral/astral";
import { fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

// ---- The squircle -----------------------------------------------------------------------------

/** The squircle on the 824/1024 grid: a superellipse (n = 5), Apple's continuous corners. */
function squirclePath(): string {
  const c = 512, r = 412, n = 5, steps = 360;
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const cos = Math.cos(t), sin = Math.sin(t);
    const x = c + r * Math.sign(cos) * Math.abs(cos) ** (2 / n);
    const y = c + r * Math.sign(sin) * Math.abs(sin) ** (2 / n);
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
}

// ---- The face ---------------------------------------------------------------------------------

// The component's colours (public/styles.css): --companion-face-ink, the bead's edge, and the
// iris gradient (companion-face.tsx AccentDefs).
const INK = "#1d2b33";
const BEAD_EDGE = "#4b545b";

/** The iris gradient, as `AccentDefs` draws it. */
const ACCENT_DEFS = `
      <radialGradient id="iris" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#0c1a22"/>
        <stop offset="0.42" stop-color="#0f2530"/>
        <stop offset="0.5" stop-color="#1b7f8e"/>
        <stop offset="0.86" stop-color="#14606f"/>
        <stop offset="1" stop-color="#0c3a44"/>
      </radialGradient>`;

/** A dot pupil's catch-light, as the component's `glint` draws it. */
function glint(x: number, y: number, r: number): string {
  const g = r * 0.3;
  return `<circle cx="${(x - r * 0.32).toFixed(2)}" cy="${
    (y - r * 0.36).toFixed(2)
  }" r="${g.toFixed(2)}" fill="#ffffff" fill-opacity="0.92"/>`;
}

/**
 * The companion's neutral face, in the drawing's own units (the bead: centre (80, 76), radius 29),
 * as the component draws it, for an icon `px` wide. From 32 px down it thickens the ink, widens
 * the smile and centres the dark pupils (a glance to the side is lost at that size); at 16 px the
 * eyes are plain
 * dark ovals (white eyes on the light steel are a grey smudge at that size).
 */
function face(px: number): string {
  const small = px <= 32, tiny = px <= 16;
  const brow = small ? 5 : 3.4;
  const mouthStroke = small ? 4 : 2.8;
  // FACES.neutral's small closed smile (SMILE); from 32 px down a little wider and deeper, or it
  // reads as a flat dash.
  const mouth = small ? "M72 88 Q80 95 88 88" : "M74 89 Q80 93 86 89";
  const eyeStroke = small ? 2.4 : 1;
  const pupil = small ? 4.4 : 3.6;
  // FACES.neutral's pupils look in and down a little (dx ±1.8, dy 1.8).
  const [lx, rx, py] = small ? [70, 90, 72] : [71.8, 88.2, 73.8];
  const eyes = tiny
    ? `<g fill="${INK}">
      <ellipse cx="70" cy="71" rx="5.6" ry="7.4"/>
      <ellipse cx="90" cy="71" rx="5.6" ry="7.4"/>
    </g>`
    : `<g stroke="${INK}" stroke-width="${eyeStroke}">
      <ellipse cx="70" cy="72" rx="7.2" ry="8.8" fill="#ffffff"/>
      <ellipse cx="90" cy="72" rx="7.2" ry="8.8" fill="#ffffff"/>
    </g>
    <circle cx="${lx}" cy="${py}" r="${pupil}" fill="${
      small ? INK : "url(#iris)"
    }"/>
    <circle cx="${rx}" cy="${py}" r="${pupil}" fill="${
      small ? INK : "url(#iris)"
    }"/>
    ${small ? "" : glint(lx, py, pupil) + glint(rx, py, pupil)}`;
  return `
    <defs>
      <radialGradient id="bead" cx="0.36" cy="0.32" r="0.75">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="0.35" stop-color="#d9dee3"/>
        <stop offset="0.8" stop-color="#8b959e"/>
        <stop offset="1" stop-color="#5d666e"/>
      </radialGradient>${ACCENT_DEFS}
      <filter id="lift" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="1.6" stdDeviation="1.8" flood-color="#000" flood-opacity="0.45"/>
      </filter>
    </defs>
    <g filter="url(#lift)">
      <circle cx="80" cy="76" r="29" fill="url(#bead)" stroke="${BEAD_EDGE}" stroke-width="1"/>
    </g>
    <g fill="none" stroke="${INK}" stroke-width="${brow}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M61 61 Q68 55 76 59.5"/>
      <path d="M84 59.5 Q92 55 99 61"/>
    </g>
    ${eyes}
    <path d="${mouth}" fill="none" stroke="${INK}"
      stroke-width="${mouthStroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// ---- The icon ---------------------------------------------------------------------------------

/** The whole icon as an SVG `px` wide, on the 1024 grid. */
function iconSvg(px: number): string {
  const small = px <= 32;
  // The bead's diameter on the grid: large, so the face reads in the Dock and at 16 px.
  const bead = small ? 660 : 540;
  const scale = bead / 58;
  // Centre the bead (80, 76) on the squircle's centre, a little low, so the brows above it sit in the middle too.
  const tx = 512 - 80 * scale, ty = 530 - 76 * scale;
  const sq = squirclePath();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#123642"/>
      <stop offset="0.55" stop-color="#0a1f28"/>
      <stop offset="1" stop-color="#06131a"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#2fd3b3" stop-opacity="0.55"/>
      <stop offset="0.55" stop-color="#17a08a" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#17a08a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.10"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.32"/>
    </filter>
    <clipPath id="sq"><path d="${sq}"/></clipPath>
  </defs>
  <path d="${sq}" fill="url(#bg)" filter="url(#drop)"/>
  <g clip-path="url(#sq)">
    <circle cx="512" cy="530" r="${small ? 470 : 440}" fill="url(#glow)"/>
    <path d="${sq}" fill="url(#sheen)"/>
  </g>
  <path d="${sq}" fill="none" stroke="#3fe0c0" stroke-opacity="${
    small ? 0.5 : 0.35
  }"
    stroke-width="${small ? 16 : 5}"/>
  <g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${
    scale.toFixed(4)
  })">
    ${face(px)}
  </g>
</svg>`;
}

// ---- Rasterize --------------------------------------------------------------------------------

/** Every size to rasterize, in px. */
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;

async function rasterize(): Promise<Map<number, Uint8Array>> {
  const profile = await Deno.makeTempDir({ prefix: "qutty-icon-chrome-" });
  const browser = await launch({
    headless: true,
    path: Deno.env.get("E2E_CHROME") || undefined,
    args: [`--user-data-dir=${profile}`],
  });
  const out = new Map<number, Uint8Array>();
  try {
    const page = await browser.newPage();
    const cdp = page.unsafelyGetCelestialBindings();
    await cdp.Emulation.setDefaultBackgroundColorOverride({
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    for (const px of SIZES) {
      await page.setViewportSize({ width: px, height: px });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent">${
          iconSvg(px)
        }</body></html>`,
      );
      out.set(px, await page.screenshot({ format: "png" }));
    }
  } finally {
    await browser.close();
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
  return out;
}

/** A Windows .ico of PNG entries (Vista and later read PNG-compressed entries). */
function ico(entries: readonly [number, Uint8Array][]): Uint8Array {
  const head = 6 + 16 * entries.length;
  const total = head + entries.reduce((n, [, png]) => n + png.length, 0);
  const buf = new Uint8Array(total);
  const v = new DataView(buf.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, entries.length, true);
  let off = head;
  entries.forEach(([px, png], i) => {
    const e = 6 + 16 * i;
    buf[e] = px >= 256 ? 0 : px;
    buf[e + 1] = px >= 256 ? 0 : px;
    v.setUint16(e + 4, 1, true);
    v.setUint16(e + 6, 32, true);
    v.setUint32(e + 8, png.length, true);
    v.setUint32(e + 12, off, true);
    buf.set(png, off);
    off += png.length;
  });
  return buf;
}

async function run(cmd: string, args: string[]): Promise<void> {
  const res = await new Deno.Command(cmd, { args, stderr: "piped" }).output();
  if (!res.success) {
    throw new Error(
      `${cmd} failed: ${new TextDecoder().decode(res.stderr)}`,
    );
  }
}

if (import.meta.main) {
  const pngs = await rasterize();
  const png = (px: number) => pngs.get(px)!;
  const icons = join(ROOT, "icons");
  await Deno.writeFile(join(icons, "source.png"), png(1024));
  await Deno.writeFile(join(icons, "app-1024.png"), png(1024));
  await Deno.writeFile(join(icons, "app.png"), png(512));
  await Deno.writeFile(join(ROOT, "public", "favicon.png"), png(64));
  await Deno.writeFile(
    join(icons, "app.ico"),
    ico([16, 24, 32, 48, 64, 128, 256].map((px) => [px, png(px)])),
  );

  // macOS: an .iconset with every size, @1x and @2x, then iconutil.
  const tmp = await Deno.makeTempDir({ prefix: "qutty-icon-" });
  const set = join(tmp, "app.iconset");
  await Deno.mkdir(set);
  for (const pt of [16, 32, 128, 256, 512]) {
    await Deno.writeFile(join(set, `icon_${pt}x${pt}.png`), png(pt));
    await Deno.writeFile(join(set, `icon_${pt}x${pt}@2x.png`), png(pt * 2));
  }
  await run("iconutil", ["-c", "icns", set, "-o", join(icons, "app.icns")]);
  await Deno.remove(tmp, { recursive: true });

  const i = Deno.args.indexOf("--preview");
  if (i >= 0 && Deno.args[i + 1]) {
    const dir = Deno.args[i + 1];
    await Deno.mkdir(dir, { recursive: true });
    for (const px of [1024, 128, 32, 16]) {
      await Deno.writeFile(join(dir, `icon-${px}.png`), png(px));
    }
  }
  console.log(
    "Wrote icons/ (source, app-1024, app.png, .icns, .ico) and public/favicon.png",
  );
}
