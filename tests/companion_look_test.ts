// The companion's face keeps the shape and the moods of Denext's examples/companion as it is on the
// branch feat/loopy-voice-tools (the crossed-triangle wire with a steel bead head and 13 moods).
// Qutty draws the bead head alone, larger, without the wire body, so only the face is compared,
// against a snapshot taken from the example (tests/fixtures/companion/face-shape.json): the head
// group app/companion/companion-face.tsx renders in each of the 13 moods and in the voice turn
// (listening, thinking, speaking at each lip-sync step), the bead's shading, each mood's tint, and
// every non-colour declaration and keyframe of the face's CSS in public/styles.css (scoped under
// .companion-overlay there). The wire, the body's moves and the layout are Qutty's and left out.
// The snapshot also holds the avatar's own size (Qutty's: the crop and the scale), checked against
// the render. Where the example can be read (DENEXT_DIR, default ../denext beside the repo, at the
// git ref DENEXT_COMPANION_REF, default origin/feat/loopy-voice-tools; an empty ref reads the
// checkout's files), the face in the snapshot is also compared with it, and
// `UPDATE_COMPANION_SNAPSHOT=1` rewrites the snapshot from it (and the avatar from the render).

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { renderToString } from "denext";
import { jsx } from "denext/jsx-runtime";
import {
  COMPANION_SCALE,
  COMPANION_VIEWBOX,
  CompanionFace,
} from "../app/companion/companion-face.tsx";
import { MOODS } from "../lib/companion/face-machine.ts";

const ROOT = new URL("../", import.meta.url);
const SNAPSHOT = new URL(
  "./fixtures/companion/face-shape.json",
  import.meta.url,
);
const EXAMPLE = "examples/companion";

/** Properties that only colour things (the theme's business). */
const COLOUR_PROPS = new Set([
  "color",
  "fill",
  "stroke",
  "background",
  "background-color",
  "border-color",
  "box-shadow",
]);

/** The face, as the example and Qutty both draw it. */
interface Shape {
  /** The face's selectors → declarations, without the colour ones. */
  rules: Record<string, Record<string, string>>;
  /** The keyframes the face's rules use: name → its body, whitespace-normalised. */
  keyframes: Record<string, string>;
  /** mood → its tint: [colour, edge, shine] (the example's wire; Qutty's extras and rim). */
  tints: Record<string, string[]>;
  /** The bead's shading: the SVG's `<defs>`. */
  defs: string;
  /** mood → the head group (`.companion-head`) the companion renders in it (idle). */
  head: Record<string, string>;
  /** voice turn (`speaking-<step>`, `listening-<step>`, `thinking`) → the head group (neutral). */
  voice: Record<string, string>;
}

/** Qutty's avatar: the crop of the drawing and its size in CSS px. */
interface Avatar {
  viewBox: string;
  width: number;
  height: number;
}

/** The snapshot: the example's face, and Qutty's avatar size. */
type Snapshot = Shape & { avatar: Avatar };

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The colour part of `border: 1.5px solid <colour>` dropped. */
function shapeValue(prop: string, value: string): string {
  if (prop.startsWith("border") && /solid/.test(value)) {
    return value.replace(/(solid)\s+.*/, "$1");
  }
  return value.replace(/var\(--companion-/g, "var(--");
}

/** Top-level blocks of a CSS text: [prelude, body], comments dropped, @media flattened. */
function blocks(css: string): [string, string][] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: [string, string][] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const prelude = norm(text.slice(i, open));
    let depth = 1;
    let k = open + 1;
    while (depth > 0 && k < text.length) {
      if (text[k] === "{") depth++;
      else if (text[k] === "}") depth--;
      k++;
    }
    const body = text.slice(open + 1, k - 1);
    if (prelude.startsWith("@media")) {
      for (const [p, b] of blocks(body)) out.push([`${prelude} ${p}`, b]);
    } else out.push([prelude, body]);
    i = k;
  }
  return out;
}

/** The `prop: value` declarations of a block body. */
function declarations(body: string): [string, string][] {
  return body.split(";").flatMap((d): [string, string][] => {
    const at = d.indexOf(":");
    return at < 0 ? [] : [[d.slice(0, at).trim(), norm(d.slice(at + 1))]];
  });
}

/**
 * The face's parts of a selector list (scope already off), joined; "" when it has none. A face
 * part names the head or a part of it (the bead, eyes, brows, mouth, an extra), or is one of the
 * example's catch-alls for the drawing (`.companion-avatar path`, the reduced-motion
 * `.companion-avatar *`).
 */
function faceSelector(selector: string): string {
  return selector.split(", ").filter((p) =>
    /\.companion-(head|bead|eyes|eye-white|brows|mouth|tongue|star-eyes|heart-eyes|wow-sparks|exclaim|zaps|question|zs|steam|tear|blush|floating-hearts|extra)\b/
      .test(p) || /^(@reduce )?\.companion-avatar (path|\*)$/.test(p)
  ).join(", ");
}

/**
 * The face's shape from a stylesheet: its rules (with `scope` taken off selectors and the parts
 * that are not the face's dropped), and the keyframes those rules use.
 */
function cssShape(
  css: string,
  scope: string | RegExp,
): Pick<Shape, "rules" | "keyframes"> {
  const rules: Shape["rules"] = {};
  const keyframes: Shape["keyframes"] = {};
  for (const [prelude, body] of blocks(css)) {
    if (prelude.startsWith("@keyframes")) {
      const name = prelude.split(" ")[1].replace(/^companion-/, "");
      keyframes[name] = norm(body);
      continue;
    }
    const selector = faceSelector(
      prelude.split(",").map((s) =>
        norm(s).replace(scope, "").replace(
          /^@media \(prefers-reduced-motion: reduce\) /,
          "@reduce ",
        )
      ).join(", "),
    );
    if (!selector) continue;
    const decls: Record<string, string> = {};
    for (const [prop, raw] of declarations(body)) {
      const value = raw.replace(/(animation:\s*)?\bcompanion-/g, "");
      if (prop.startsWith("--") || COLOUR_PROPS.has(prop)) continue;
      decls[prop] = shapeValue(prop, value);
    }
    if (Object.keys(decls).length === 0) continue;
    rules[selector] = { ...(rules[selector] ?? {}), ...decls };
  }
  const used = new Set(
    Object.values(rules).flatMap((d) =>
      `${d.animation ?? ""} ${d["animation-name"] ?? ""}`.split(/[\s,]+/)
    ),
  );
  return {
    rules,
    keyframes: Object.fromEntries(
      Object.entries(keyframes).filter(([name]) => used.has(name)),
    ),
  };
}

/**
 * Each mood's wire tint: the bare steel on `root` (neutral), and every
 * `.companion-avatar[data-mood]` rule (with `scope` taken off), as [--clip, --clip-edge,
 * --clip-shine] (`--companion-` prefixed in Qutty).
 */
function tints(
  css: string,
  root: string,
  scope: string | RegExp,
): Shape["tints"] {
  const out: Shape["tints"] = {};
  for (const [prelude, body] of blocks(css)) {
    const selector = prelude.replace(scope, "");
    const mood = selector === root
      ? "neutral"
      : /^\.companion-avatar\[data-mood="(\w+)"\]$/.exec(selector)?.[1];
    if (!mood) continue;
    const vars = Object.fromEntries(
      declarations(body).map(([p, v]) => [p.replace(/^--companion-/, "--"), v]),
    );
    if (vars["--clip"]) {
      out[mood] = [vars["--clip"], vars["--clip-edge"], vars["--clip-shine"]];
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
type FaceComponent = (props: any) => unknown;

/** The element of `html` that starts at `open` (`<g class="companion-head">`, `<defs>`), whole. */
function element(html: string, open: string): string {
  const start = html.indexOf(open);
  assert(start >= 0, `${open} in the render`);
  const tag = /^<(\w+)/.exec(open)![1];
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[0].endsWith("/>")) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`${open} is not closed`);
}

const head = (html: string) => element(html, '<g class="companion-head">');

/** A face component's render with `props` (idle). */
function render(
  component: FaceComponent,
  props: Record<string, unknown>,
): Promise<string> {
  return renderToString(
    jsx(component as never, { state: "idle", ...props }) as never,
  );
}

/**
 * What a face component draws of the face: the shading, the head in each mood and voice turn
 * (each render passed through `names` first).
 */
async function drawnFace(
  component: FaceComponent,
  names: (html: string) => string = (html) => html,
): Promise<Pick<Shape, "defs" | "head" | "voice">> {
  const draw = async (props: Record<string, unknown>) =>
    names(await render(component, props));
  const out: Pick<Shape, "defs" | "head" | "voice"> = {
    defs: element(await draw({}), "<defs>"),
    head: {},
    voice: {},
  };
  for (const mood of MOODS) {
    out.head[mood] = head(await draw({ mood }));
  }
  const turns: [string, Record<string, unknown>][] = [
    ["thinking", { voice: "thinking" }],
  ];
  for (let step = 0; step <= 4; step++) {
    turns.push([`speaking-${step}`, { voice: "speaking", level: step }]);
    turns.push([`listening-${step}`, { voice: "listening", level: step }]);
  }
  for (const [name, props] of turns) {
    out.voice[name] = head(await draw(props));
  }
  return out;
}

/** Qutty's face: the CSS block scoped under .companion-overlay, and the rendered head. */
async function qutty(): Promise<Shape> {
  const css = await Deno.readTextFile(new URL("public/styles.css", ROOT));
  const start = css.indexOf("/* ---- The companion's face");
  const end = css.indexOf(
    "/* ---------------------------------------------------------------- Qutty's additions */",
  );
  assert(
    start > 0 && end > start,
    "the companion's block in public/styles.css",
  );
  const block = css.slice(start, end);
  return {
    ...cssShape(block, /\.companion-overlay /g),
    tints: tints(block, ".companion-overlay", /^\.companion-overlay /),
    ...await drawnFace(CompanionFace),
  };
}

/** Qutty's avatar as rendered: the SVG's viewBox, width and height. */
async function avatar(): Promise<Avatar> {
  const html = await render(CompanionFace, {});
  const attr = (name: string) =>
    new RegExp(`<svg[^>]* ${name}="([^"]*)"`).exec(html)?.[1] ?? "";
  return {
    viewBox: attr("viewBox"),
    width: Number(attr("width")),
    height: Number(attr("height")),
  };
}

/** A file of the example at `ref` (git show), or in the checkout when `ref` is empty; or null. */
async function exampleFile(
  dir: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    if (!ref) return await Deno.readTextFile(join(dir, EXAMPLE, path));
    const out = await new Deno.Command("git", {
      args: ["-C", dir, "show", `${ref}:${EXAMPLE}/${path}`],
      stdout: "piped",
      stderr: "null",
    }).output();
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/**
 * The example's face component (its `Loopy`): its source and the modules it imports, copied out and
 * loaded.
 */
async function exampleFace(
  read: (path: string) => Promise<string | null>,
): Promise<FaceComponent | null> {
  const tsx = await read("components/Loopy.tsx");
  if (tsx === null) return null;
  const tmp = await Deno.makeTempDir({ prefix: "denext-example-" });
  try {
    await Deno.mkdir(join(tmp, "components"));
    await Deno.mkdir(join(tmp, "lib"));
    await Deno.writeTextFile(join(tmp, "components/Loopy.tsx"), tsx);
    for (const [, lib] of tsx.matchAll(/from "\.\.\/lib\/([\w-]+\.ts)"/g)) {
      const src = await read(`lib/${lib}`);
      if (src === null) return null;
      await Deno.writeTextFile(join(tmp, "lib", lib), src);
    }
    const mod = await import(
      toFileUrl(join(tmp, "components/Loopy.tsx")).href
    );
    return mod.Loopy as FaceComponent;
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/**
 * The example's names as Qutty's: the example calls its companion Loopy (`.loopy`, `.loopy-head`,
 * `--loopy-clip`, `@keyframes loopy-pop`), Qutty's face is `.companion-avatar` with `companion-*`
 * parts, variables and keyframes.
 */
function quttyNames(text: string): string {
  return text.replace(/\bloopy(?=-)/g, "companion").replace(
    /\bloopy\b/g,
    "companion-avatar",
  );
}

/** The example's shape (in Qutty's names), when it can be read. */
async function example(): Promise<Shape | null> {
  const dir = Deno.env.get("DENEXT_DIR") ??
    new URL("../denext/", ROOT).pathname;
  const ref = Deno.env.get("DENEXT_COMPANION_REF") ??
    "origin/feat/loopy-voice-tools";
  const read = (path: string) => exampleFile(dir, ref, path);
  const source = await read("public/styles.css");
  if (source === null) return null;
  const css = quttyNames(source);
  const component = await exampleFace(read);
  if (!component) return null;
  // The speech bubble, stage, Loopy and voice sections; not the size setting between them.
  const section = (name: string) =>
    css.indexOf(
      `/* ---------------------------------------------------------------- ${name} */`,
    );
  const sizeAt = section("size");
  const voiceAt = section("voice");
  const settingsAt = section("settings");
  const faceCss = css.slice(
    section("speech bubble"),
    sizeAt < 0 ? undefined : sizeAt,
  ) + (voiceAt < 0
    ? ""
    : css.slice(voiceAt, settingsAt < 0 ? undefined : settingsAt));
  return {
    ...cssShape(faceCss, ""),
    tints: tints(css, ":root", ""),
    ...await drawnFace(component, quttyNames),
  };
}

Deno.test("The companion's look: the face in every mood and voice turn, the tints, the face's CSS and the avatar's size match the snapshot", async () => {
  const snap = JSON.parse(await Deno.readTextFile(SNAPSHOT)) as Snapshot;
  const mine = await qutty();
  assertEquals(Object.keys(snap.head), [...MOODS], "the 13 moods");
  for (const mood of MOODS) {
    assertEquals(
      mine.head[mood],
      snap.head[mood],
      `the companion's face ${mood}`,
    );
  }
  assertEquals(mine.defs, snap.defs, "the bead's shading");
  assertEquals(
    mine.voice,
    snap.voice,
    "the companion listening, thinking, speaking",
  );
  assertEquals(mine.tints, snap.tints, "each mood's tint");
  assertEquals(mine.keyframes, snap.keyframes, "the face's keyframes");
  assertEquals(mine.rules, snap.rules, "the face's CSS");
  assertEquals(await avatar(), snap.avatar, "the avatar's crop and size");
});

Deno.test("The companion's look: the avatar is the head alone, 2 times the clip's, smaller than the clip was", async () => {
  const [, , w, h] = COMPANION_VIEWBOX;
  // The bead (r 29) at the clip's 0.75 px a unit was 43.5 px across; now 2 times that.
  assertEquals(58 * COMPANION_SCALE, 43.5 * 2);
  // Smaller than the whole clip was in its window (120 x 150).
  assert(w * COMPANION_SCALE < 120 && h * COMPANION_SCALE < 150);
  const html = await render(CompanionFace, { mood: "love" });
  for (const gone of ["companion-wire", "companion-body", "companion-shadow"]) {
    assert(!html.includes(gone), `no ${gone}`);
  }
});

Deno.test({
  name:
    "The companion's look: the snapshot's face matches the example (where it can be read)",
  async fn() {
    const ex = await example();
    if (!ex) return; // CI: no Denext checkout; the snapshot stands in for it.
    if (Deno.env.get("UPDATE_COMPANION_SNAPSHOT")) {
      const next: Snapshot = { ...ex, avatar: await avatar() };
      await Deno.writeTextFile(SNAPSHOT, JSON.stringify(next, null, 2) + "\n");
    }
    const snap = JSON.parse(await Deno.readTextFile(SNAPSHOT)) as Snapshot;
    const { avatar: _qutty, ...face } = snap;
    assertEquals(face, ex);
  },
});
