// Generates the tray icons in public/ (desktop/tray.ts picks one per OS):
//
// - public/tray-template.png: the macOS menu-bar icon, 36×36 (18 pt at 2×), black on transparent.
//   The runtime draws every tray image as a template image on macOS, so only its alpha counts and
//   macOS tints it for the light or dark menu bar itself.
// - public/tray-dark.png: the same glyph in the app icon's teal, 64×64, for a dark panel (Linux,
//   Windows, where the OS tells light from dark).
// - public/tray.png: the app icon (icons/app-1024.png) at 64×64, for every other panel. Its dark
//   squircle keeps the teal cat readable on a light panel too. Made with macOS `sips`.
//
// The glyph is the app icon's cat-eared terminal: a head with two ears and a `>_` prompt cut out.
//
//   deno run -A scripts/gen-tray-icons.ts

type Point = readonly [number, number];

/** Whether `p` is inside the triangle `a b c`. */
function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const side = (u: Point, v: Point) =>
    (p[0] - v[0]) * (u[1] - v[1]) - (u[0] - v[0]) * (p[1] - v[1]);
  const d1 = side(a, b), d2 = side(b, c), d3 = side(c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Whether `p` is inside the rounded rectangle `x0..x1 × y0..y1` with corner radius `r`. */
function inRoundRect(
  p: Point,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
): boolean {
  const [x, y] = p;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** The distance from `p` to the segment `a b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Whether the unit-square point `p` is ink: the head and ears, minus the `>_` prompt. */
function ink(p: Point): boolean {
  const head = inRoundRect(p, 0.06, 0.3, 0.94, 0.9, 0.16) ||
    inTriangle(p, [0.1, 0.4], [0.2, 0.06], [0.44, 0.31]) ||
    inTriangle(p, [0.9, 0.4], [0.8, 0.06], [0.56, 0.31]);
  if (!head) return false;
  const stroke = 0.045;
  const chevron = segmentDistance(p, [0.24, 0.46], [0.42, 0.6]) <= stroke ||
    segmentDistance(p, [0.42, 0.6], [0.24, 0.74]) <= stroke;
  const underscore = p[0] >= 0.5 && p[0] <= 0.76 && p[1] >= 0.69 &&
    p[1] <= 0.78;
  return !chevron && !underscore;
}

/** The glyph at `size`×`size` in colour `rgb`, as RGBA rows (4×4 supersampled). */
function glyph(
  size: number,
  rgb: readonly [number, number, number],
): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          if (ink([(x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size])) {
            hits++;
          }
        }
      }
      const i = (y * size + x) * 4;
      out.set([...rgb, Math.round((255 * hits) / (n * n))], i);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A zlib stream of `bytes` (PNG's IDAT format). */
async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An RGBA PNG of `size`×`size` pixels. */
async function png(size: number, rgba: Uint8Array): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw.set(
      rgba.subarray(y * size * 4, (y + 1) * size * 4),
      y * (size * 4 + 1) + 1,
    );
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const root = new URL("../", import.meta.url);
const pub = (name: string) => new URL(`public/${name}`, root);

await Deno.writeFile(
  pub("tray-template.png"),
  await png(36, glyph(36, [0, 0, 0])),
);
await Deno.writeFile(
  pub("tray-dark.png"),
  await png(64, glyph(64, [0x4f, 0xe3, 0xb8])),
);
const sips = await new Deno.Command("sips", {
  args: [
    "-z",
    "64",
    "64",
    new URL("icons/app-1024.png", root).pathname,
    "--out",
    pub("tray.png").pathname,
  ],
  stdout: "null",
}).output();
if (!sips.success) throw new Error("sips could not scale icons/app-1024.png");
console.log("public/tray-template.png, public/tray-dark.png, public/tray.png");
