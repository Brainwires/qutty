// Loopy keeps the shape, the moods and the moves of Denext's examples/companion as it is on the
// branch feat/loopy-voice-tools (the crossed-triangle wire with a steel bead head and 13 moods).
// Checked against a snapshot taken from the example (tests/fixtures/companion/loopy-shape.json):
// the SVG app/companion/loopy.tsx renders in each of the 13 moods, each mood's wire tint, and
// every non-colour declaration and keyframe of Loopy's CSS in public/styles.css (scoped under
// .companion-overlay there). Where the example can be read (DENEXT_DIR, default ../denext beside
// the repo, at the git ref DENEXT_LOOPY_REF, default origin/feat/loopy-voice-tools; an empty ref
// reads the checkout's files), the snapshot is also compared with it, and
// `UPDATE_LOOPY_SNAPSHOT=1` rewrites the snapshot from it. The voice turn is included: Loopy
// listening, thinking and speaking at each lip-sync step, and the example's voice rules (the
// listening pulse, the speaking mouth); its size setting is not Qutty's and is left out.

import { assert, assertEquals } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { renderToString } from "denext";
import { jsx } from "denext/jsx-runtime";
import { Loopy } from "../app/companion/loopy.tsx";
import { MOODS } from "../lib/companion/loopy-machine.ts";

const ROOT = new URL("../", import.meta.url);
const SNAPSHOT = new URL(
  "./fixtures/companion/loopy-shape.json",
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

interface Shape {
  /** selector → declarations, without the colour ones. */
  rules: Record<string, Record<string, string>>;
  /** keyframe name → its body, whitespace-normalised. */
  keyframes: Record<string, string>;
  /** mood → the wire's tint: [colour, edge, shine]. */
  tints: Record<string, string[]>;
  /** mood → the SVG Loopy renders in it (idle), without the voice turn's attributes. */
  svg: Record<string, string>;
  /** voice turn (`speaking-<step>`, `listening-<step>`, `thinking`) → the SVG (neutral, idle). */
  voice: Record<string, string>;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The colour part of `border: 1.5px solid <colour>` dropped. */
function shapeValue(prop: string, value: string): string {
  if (prop.startsWith("border") && /solid/.test(value)) {
    return value.replace(/(solid)\s+.*/, "$1");
  }
  return value.replace(/var\(--loopy-/g, "var(--");
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

/** Loopy's shape from a stylesheet: rules matching `keep`, with `scope` taken off selectors. */
function cssShape(
  css: string,
  scope: string | RegExp,
  keep: (selector: string) => boolean,
): Pick<Shape, "rules" | "keyframes"> {
  const rules: Shape["rules"] = {};
  const keyframes: Shape["keyframes"] = {};
  for (const [prelude, body] of blocks(css)) {
    if (prelude.startsWith("@keyframes")) {
      const name = prelude.split(" ")[1].replace(/^loopy-/, "");
      keyframes[name] = norm(body);
      continue;
    }
    const selector = prelude.split(",").map((s) =>
      norm(s).replace(scope, "").replace(
        /^@media \(prefers-reduced-motion: reduce\) /,
        "@reduce ",
      )
    ).join(", ");
    if (!keep(selector)) continue;
    const decls: Record<string, string> = {};
    for (const [prop, raw] of declarations(body)) {
      const value = raw.replace(/(animation:\s*)?\bloopy-/g, "");
      if (prop.startsWith("--") || COLOUR_PROPS.has(prop)) continue;
      decls[prop] = shapeValue(prop, value);
    }
    if (Object.keys(decls).length === 0) continue;
    rules[selector] = { ...(rules[selector] ?? {}), ...decls };
  }
  return { rules, keyframes };
}

/**
 * Each mood's wire tint: the bare steel on `root` (neutral), and every `.loopy[data-mood]` rule
 * (with `scope` taken off), as [--clip, --clip-edge, --clip-shine] (`--loopy-` prefixed in Qutty).
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
      : /^\.loopy\[data-mood="(\w+)"\]$/.exec(selector)?.[1];
    if (!mood) continue;
    const vars = Object.fromEntries(
      declarations(body).map(([p, v]) => [p.replace(/^--loopy-/, "--"), v]),
    );
    if (vars["--clip"]) {
      out[mood] = [vars["--clip"], vars["--clip-edge"], vars["--clip-shine"]];
    }
  }
  return out;
}

/** Loopy's own selectors (the example's speech bubble, stage and Loopy sections). */
const LOOPY_SELECTOR =
  /^(@reduce )?\.(loopy|bubble|squash|poke|stage)\b|^\.loopy-|^\.bubble-(slot|text|close|actions)|^button$/;

// deno-lint-ignore no-explicit-any
type LoopyComponent = (props: any) => unknown;

/** The SVG a Loopy component renders in each mood, without the voice turn's attributes. */
async function renderMoods(
  component: LoopyComponent,
): Promise<Shape["svg"]> {
  const out: Shape["svg"] = {};
  for (const mood of MOODS) {
    const html = await renderToString(
      jsx(component as never, { state: "idle", mood }) as never,
    );
    out[mood] = html.replace(/ (style|data-voice)="[^"]*"/g, "");
  }
  return out;
}

/** The SVG a Loopy component renders in each voice turn: every lip-sync step, listening, thinking. */
async function renderVoice(
  component: LoopyComponent,
): Promise<Shape["voice"]> {
  const turns: [string, Record<string, unknown>][] = [
    ["thinking", { voice: "thinking" }],
  ];
  for (let step = 0; step <= 4; step++) {
    turns.push([`speaking-${step}`, { voice: "speaking", level: step }]);
    turns.push([`listening-${step}`, { voice: "listening", level: step }]);
  }
  const out: Shape["voice"] = {};
  for (const [name, props] of turns) {
    out[name] = await renderToString(
      jsx(component as never, { state: "idle", ...props }) as never,
    );
  }
  return out;
}

/** Qutty's shape: the CSS block scoped under .companion-overlay, and the rendered SVG. */
async function qutty(): Promise<Shape> {
  const css = await Deno.readTextFile(new URL("public/styles.css", ROOT));
  const start = css.indexOf("/* ---- The companion: Loopy");
  const end = css.indexOf(
    "/* ---------------------------------------------------------------- Qutty's additions */",
  );
  assert(start > 0 && end > start, "Loopy's block in public/styles.css");
  const block = css.slice(start, end);
  const keep = (s: string) =>
    s.split(", ").every((p) => LOOPY_SELECTOR.test(p));
  return {
    ...cssShape(block, /\.companion-overlay /g, keep),
    tints: tints(block, ".companion-overlay", /^\.companion-overlay /),
    svg: await renderMoods(Loopy),
    voice: await renderVoice(Loopy),
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

/** The example's Loopy component: its source and the modules it imports, copied out and loaded. */
async function exampleLoopy(
  read: (path: string) => Promise<string | null>,
): Promise<LoopyComponent | null> {
  const tsx = await read("components/Loopy.tsx");
  if (tsx === null) return null;
  const tmp = await Deno.makeTempDir({ prefix: "loopy-example-" });
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
    return mod.Loopy as LoopyComponent;
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** The example's shape, when it can be read. */
async function example(): Promise<Shape | null> {
  const dir = Deno.env.get("DENEXT_DIR") ??
    new URL("../denext/", ROOT).pathname;
  const ref = Deno.env.get("DENEXT_LOOPY_REF") ??
    "origin/feat/loopy-voice-tools";
  const read = (path: string) => exampleFile(dir, ref, path);
  const css = await read("public/styles.css");
  if (css === null) return null;
  const component = await exampleLoopy(read);
  if (!component) return null;
  // The speech bubble, stage, Loopy and voice sections; not the size setting between them.
  const section = (name: string) =>
    css.indexOf(
      `/* ---------------------------------------------------------------- ${name} */`,
    );
  const sizeAt = section("size");
  const voiceAt = section("voice");
  const settingsAt = section("settings");
  const loopyCss = css.slice(
    section("speech bubble"),
    sizeAt < 0 ? undefined : sizeAt,
  ) + (voiceAt < 0
    ? ""
    : css.slice(voiceAt, settingsAt < 0 ? undefined : settingsAt));
  const keep = (s: string) =>
    s.split(", ").filter((p) =>
      !/^\.(controls|demo|companion)\b|^button$/.test(p)
    )
      .every((p) => LOOPY_SELECTOR.test(p) || p === ".is-desktop .loopy");
  const shape = cssShape(loopyCss, "", keep);
  // Its desktop-window size is the overlay's.
  const small = shape.rules[".is-desktop .loopy"];
  delete shape.rules[".is-desktop .loopy"];
  shape.rules[".loopy"] = { ...shape.rules[".loopy"], ...small };
  for (const sel of Object.keys(shape.rules)) {
    // `.bubble-actions button, .controls button, .demo button` keeps its bubble part.
    if (sel.includes(".controls") || sel.includes(".demo")) {
      const kept = sel.split(", ").filter((p) => !/\.(controls|demo)/.test(p))
        .join(", ");
      shape.rules[kept] = shape.rules[sel];
      delete shape.rules[sel];
    }
  }
  delete shape.rules[""]; // the controls and demo rows, which Qutty has not
  return {
    ...shape,
    tints: tints(css, ":root", ""),
    svg: await renderMoods(component),
    voice: await renderVoice(component),
  };
}

Deno.test("Loopy's look: the SVG in every mood, the tints, the CSS shapes and the moves match the example's snapshot", async () => {
  const snap = JSON.parse(await Deno.readTextFile(SNAPSHOT)) as Shape;
  const mine = await qutty();
  assertEquals(Object.keys(snap.svg), [...MOODS], "the 13 moods");
  for (const mood of MOODS) {
    assertEquals(mine.svg[mood], snap.svg[mood], `Loopy drawn ${mood}`);
  }
  assertEquals(mine.voice, snap.voice, "Loopy listening, thinking, speaking");
  assertEquals(mine.tints, snap.tints, "each mood's wire tint");
  assertEquals(mine.keyframes, snap.keyframes, "the keyframes of every move");
  for (const [sel, decls] of Object.entries(snap.rules)) {
    assertEquals(mine.rules[sel], decls, `the shape of ${sel}`);
  }
});

Deno.test({
  name: "Loopy's look: the snapshot matches the example (where it can be read)",
  async fn() {
    const ex = await example();
    if (!ex) return; // CI: no Denext checkout; the snapshot stands in for it.
    if (Deno.env.get("UPDATE_LOOPY_SNAPSHOT")) {
      await Deno.writeTextFile(SNAPSHOT, JSON.stringify(ex, null, 2) + "\n");
    }
    assertEquals(JSON.parse(await Deno.readTextFile(SNAPSHOT)), ex);
  },
});
