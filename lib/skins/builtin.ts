/**
 * The built-in skins: "Qutty" (the app's own look, no stylesheet) and "Classic" (a late-90s
 * desktop: grey bevelled frames, each tile a child window with a gradient title bar).
 *
 * A built-in's stylesheet is a static file the page always links (app/layout.tsx), scoped under
 * `:root[data-skin="<id>"]`, so it costs nothing while another skin is on and is there at the
 * first paint. Classic's package is public/skins/classic/ (skin.json, skin.css): the same two
 * files a user skin has, so Settings → "Start from Classic" can copy them out as a template. Its
 * manifest is repeated here because the page needs it before any fetch; a unit test keeps the two
 * equal.
 *
 * @module
 */

import {
  buildSkin,
  DEFAULT_SKIN_ID,
  isSkinId,
  type Skin,
  type SkinManifest,
  type SkinTemplateRequest,
} from "./skin.ts";

const QUTTY: SkinManifest = {
  id: DEFAULT_SKIN_ID,
  name: "Qutty",
  author: "Qutty",
  version: "1",
  description: "Qutty's own look.",
};

/** Classic's manifest: public/skins/classic/skin.json, checked. */
export const CLASSIC_MANIFEST: SkinManifest = {
  id: "classic",
  name: "Classic",
  author: "Qutty",
  version: "1",
  description:
    "A late-90s desktop: grey bevelled frames, and every tile a child window with a title bar.",
  theme: {
    base: "paper",
    scheme: "light",
    tokens: {
      "--ink": "#808080",
      "--ink-2": "#c0c0c0",
      "--tile": "#ffffff",
      "--head": "#c0c0c0",
      "--line": "#808080",
      "--line-2": "#808080",
      "--panel": "#c0c0c0",
      "--text": "#000000",
      "--text-2": "#202020",
      "--text-3": "#505050",
      "--accent": "#000080",
      "--accent-ink": "#ffffff",
      "--accent-glow": "rgba(0, 0, 128, 0.2)",
      "--amber": "#806000",
      "--red": "#a00000",
      "--hi": "#000000",
      "--shadow": "#000000",
      "--shadow-a": "0.5",
    },
  },
  frame: {
    buttons: "right",
    title: "left",
    buttonOrder: ["minimize", "maximize", "close"],
  },
};

/** Where the page fetches Classic's package from (for "Start from Classic"). */
export const CLASSIC_PACKAGE = "/skins/classic";

/** The built-in skins, in the picker's order. Their stylesheets are linked, not applied here. */
export const BUILTIN_SKINS: readonly Skin[] = [
  { manifest: QUTTY, css: "", source: "builtin" },
  { manifest: CLASSIC_MANIFEST, css: "", source: "builtin" },
];

/** The ids a user skin cannot take. */
export const BUILTIN_SKIN_IDS: readonly string[] = BUILTIN_SKINS.map((s) =>
  s.manifest.id
);

/**
 * A copy of a skin package under a new id: the manifest's id and name changed, and every
 * `data-skin="<from>"` in the stylesheet pointed at the new id.
 */
function retargetSkin(
  files: { manifest: string; css: string },
  from: string,
  to: { id: string; name: string },
): { manifest: string; css: string } {
  const manifest = { ...JSON.parse(files.manifest), id: to.id, name: to.name };
  return {
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    css: files.css.replaceAll(
      new RegExp(`data-skin=(["']?)${from}\\1`, "g"),
      `data-skin="${to.id}"`,
    ),
  };
}

/**
 * The copy of a skin package to write for a template request: under the id asked for, or with a
 * number added when `taken` says it is in use (`my-classic`, `my-classic-2`, …), and checked like
 * any user skin. Throws with the reason when there is nothing usable to write.
 */
export function skinCopy(
  req: SkinTemplateRequest,
  taken: (id: string) => boolean,
): { id: string; files: { manifest: string; css: string } } {
  if (!isSkinId(req.id) || !isSkinId(req.from)) {
    throw new Error("not a skin id");
  }
  let id = req.id;
  let name = req.name;
  for (let n = 2; taken(id) || BUILTIN_SKIN_IDS.includes(id); n++) {
    id = `${req.id}-${n}`;
    name = `${req.name} ${n}`;
    if (!isSkinId(id) || n > 99) throw new Error("no free name for the copy");
  }
  let files: { manifest: string; css: string };
  try {
    files = retargetSkin(req, req.from, { id, name });
  } catch {
    throw new Error("skin.json is not valid JSON");
  }
  const built = buildSkin(files, { folder: id, source: "user" });
  if (!built.ok) throw new Error(built.error);
  return { id, files };
}
