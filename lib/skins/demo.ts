/**
 * The demo backend's user skins (browser dev mode and the e2e suite): two packages kept in
 * memory, checked with the same functions the desktop side uses (lib/skins/skin.ts). "Blueprint"
 * is a small usable skin; "remote-import" is refused (its stylesheet has an `@import`), so
 * Settings has a problem to show. "Start from Classic" adds its copy to the same map; nothing is
 * written anywhere.
 *
 * @module
 */

import {
  buildSkin,
  type Skin,
  type SkinList,
  type SkinTemplateRequest,
} from "./skin.ts";
import { skinCopy } from "./builtin.ts";

const DEMO_DIR =
  "/Users/demo/Library/Application Support/org.qutty.Qutty/skins";

/** A 1×1 PNG, as a skin's inlined asset would arrive. */
const DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9nWQAAAABJRU5ErkJggg==";

const BLUEPRINT = {
  manifest: JSON.stringify({
    id: "blueprint",
    name: "Blueprint",
    author: "Qutty demo",
    version: "1.0.0",
    description: "Dashed frames and centred titles, on the Plum theme.",
    theme: "plum",
    frame: { buttons: "left", title: "center" },
  }),
  css: `/* A demo skin. */
:root[data-skin="blueprint"] [data-part="tile"] {
  border-style: dashed;
  border-radius: 0;
}
:root[data-skin="blueprint"] [data-part="tile-head"] {
  background-image: url("${DOT}");
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
`,
};

const REMOTE_IMPORT = {
  manifest: JSON.stringify({ id: "remote-import", name: "Remote import" }),
  css: `@import url("https://example.com/skin.css");
:root[data-skin="remote-import"] [data-part="tile"] { border-color: red; }
`,
};

export function createDemoSkins() {
  const packages = new Map<string, { manifest: string; css: string }>([
    ["blueprint", BLUEPRINT],
    ["remote-import", REMOTE_IMPORT],
  ]);
  const build = (id: string) =>
    buildSkin(packages.get(id)!, { folder: id, source: "user" });
  return {
    list(): Promise<SkinList> {
      const out: SkinList = { dir: DEMO_DIR, skins: [], problems: [] };
      for (const id of [...packages.keys()].sort()) {
        const r = build(id);
        if (r.ok) out.skins.push(r.value.manifest);
        else out.problems.push({ folder: id, error: r.error });
      }
      return Promise.resolve(out);
    },
    get(id: string): Promise<Skin> {
      if (!packages.has(id)) {
        return Promise.reject(new Error(`there is no skin "${id}"`));
      }
      const r = build(id);
      return r.ok
        ? Promise.resolve(r.value)
        : Promise.reject(new Error(r.error));
    },
    template(req: SkinTemplateRequest): Promise<{ id: string; dir: string }> {
      let copy: ReturnType<typeof skinCopy>;
      try {
        copy = skinCopy(req, (id) => packages.has(id));
      } catch (err) {
        return Promise.reject(err);
      }
      const { id, files } = copy;
      packages.set(id, files);
      return Promise.resolve({ id, dir: `${DEMO_DIR}/${id}` });
    },
    /** Nothing to open in a browser. */
    openFolder(): Promise<void> {
      return Promise.resolve();
    },
  };
}
