// Loopy keeps the shape and the moves of Denext's examples/companion (its colours follow Qutty's
// theme). Checked against a snapshot taken from the example (tests/fixtures/companion/
// loopy-shape.json): the SVG's geometry as app/companion/loopy.tsx renders it, the speech
// bubble's markup, and every non-colour declaration and keyframe of Loopy's CSS in
// public/styles.css (scoped under .companion-overlay there). Where the example is checked out
// (DENEXT_DIR, default ../denext beside the repo), the snapshot is also compared with it, and
// `UPDATE_LOOPY_SNAPSHOT=1` rewrites the snapshot from it.

import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("../", import.meta.url);
const SNAPSHOT = new URL(
  "./fixtures/companion/loopy-shape.json",
  import.meta.url,
);

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
  /** The SVG's geometry: every d / cx / cy / r / rx / ry / viewBox / width / height. */
  svg: string[];
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
    for (const d of body.split(";")) {
      const at = d.indexOf(":");
      if (at < 0) continue;
      const prop = d.slice(0, at).trim();
      const value = norm(d.slice(at + 1)).replace(
        /(animation:\s*)?\bloopy-/g,
        "",
      );
      if (prop.startsWith("--") || COLOUR_PROPS.has(prop)) continue;
      decls[prop] = shapeValue(prop, value);
    }
    if (Object.keys(decls).length === 0) continue;
    rules[selector] = { ...(rules[selector] ?? {}), ...decls };
  }
  return { rules, keyframes };
}

/** Loopy's own selectors (the example's speech bubble, stage and Loopy sections). */
const LOOPY_SELECTOR =
  /^(@reduce )?\.(loopy|bubble|squash|poke|stage)\b|^\.loopy-|^\.bubble-(slot|text|close|actions)|^button$/;

/** The SVG's geometry in a Loopy component's source (its paths, circles, ellipse, viewBox). */
function svgShape(tsx: string): string[] {
  const body = tsx.slice(tsx.indexOf("/** The wire"));
  return [
    ...body.matchAll(/const (WIRE|ARM)\s*=\s*"([^"]+)"/g),
    ...body.matchAll(/\b(d|cx|cy|r|rx|ry|viewBox|width|height)="([^"]*)"/g),
  ].map((m) => `${m[1]}=${m[2]}`);
}

/** Qutty's shape: the CSS block scoped under .companion-overlay, and the rendered SVG. */
async function qutty(): Promise<Shape> {
  const css = await Deno.readTextFile(new URL("public/styles.css", ROOT));
  const start = css.indexOf("/* ---- The companion: Loopy");
  const end = css.indexOf(
    "/* ---------------------------------------------------------------- Qutty's additions */",
  );
  assert(start > 0 && end > start, "Loopy's block in public/styles.css");
  const keep = (s: string) =>
    s.split(", ").every((p) => LOOPY_SELECTOR.test(p));
  const tsx = await Deno.readTextFile(new URL("app/companion/loopy.tsx", ROOT));
  return {
    ...cssShape(css.slice(start, end), /\.companion-overlay /g, keep),
    svg: svgShape(tsx),
  };
}

/** The example's shape, when it is checked out. */
async function example(): Promise<Shape | null> {
  const dir = Deno.env.get("DENEXT_DIR") ??
    new URL("../denext/", ROOT).pathname;
  try {
    const css = await Deno.readTextFile(
      `${dir}/examples/companion/public/styles.css`,
    );
    const tsx = await Deno.readTextFile(
      `${dir}/examples/companion/components/Loopy.tsx`,
    );
    const bubble = css.slice(
      css.indexOf(
        "/* ---------------------------------------------------------------- speech bubble */",
      ),
    );
    const keep = (s: string) =>
      s.split(", ").filter((p) =>
        !/^\.(controls|demo|companion)\b|^button$/.test(p)
      )
        .every((p) => LOOPY_SELECTOR.test(p) || p === ".is-desktop .loopy");
    const shape = cssShape(bubble, "", keep);
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
    return { ...shape, svg: svgShape(tsx) };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

Deno.test("Loopy's look: the SVG's geometry, the CSS shapes and the moves match the example's snapshot", async () => {
  const snap = JSON.parse(await Deno.readTextFile(SNAPSHOT)) as Shape;
  const mine = await qutty();
  assertEquals(
    mine.svg,
    snap.svg,
    "the SVG geometry (paths, eyes, mouth, dots, sparkles)",
  );
  assertEquals(mine.keyframes, snap.keyframes, "the keyframes of every move");
  for (const [sel, decls] of Object.entries(snap.rules)) {
    assertEquals(mine.rules[sel], decls, `the shape of ${sel}`);
  }
});

Deno.test({
  name:
    "Loopy's look: the snapshot matches the example (where it is checked out)",
  async fn() {
    const ex = await example();
    if (!ex) return; // CI: no Denext checkout; the snapshot stands in for it.
    if (Deno.env.get("UPDATE_LOOPY_SNAPSHOT")) {
      await Deno.writeTextFile(SNAPSHOT, JSON.stringify(ex, null, 2) + "\n");
    }
    assertEquals(JSON.parse(await Deno.readTextFile(SNAPSHOT)), ex);
  },
});
