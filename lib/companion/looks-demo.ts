/**
 * The demo's looks folder, in memory: empty at first; "Create a look…" adds the starter look
 * (lib/companion/look-template.ts, built the way the desktop builds a folder); the e2e suite adds
 * looks it read from disk through desktop/companion-looks.ts (`window.__e2e.addLook`).
 *
 * Client-safe.
 *
 * @module
 */

import { buildLook } from "./look-build.ts";
import { starterFiles, starterFolderName } from "./look-template.ts";
import type { Look, LooksBackend, LookSummary } from "./looks.ts";

/** The demo's looks, and `add` for the e2e suite. */
export interface DemoLooks extends LooksBackend {
  /** Put `look` in the folder (replacing one with its id). */
  add(look: Look): void;
}

/** A demo looks folder. */
export function createDemoLooks(): DemoLooks {
  const looks = new Map<string, Look>();
  const encoder = new TextEncoder();
  return {
    add: (look) => void looks.set(look.id, look),
    list: () =>
      Promise.resolve({
        dir: "",
        looks: [...looks.values()].map(({ images, css: _css, ...m }) => ({
          ...m,
          thumbnail: images.idle,
        } as LookSummary)),
        problems: [],
      }),
    get: (id) => {
      const look = looks.get(id);
      return Promise.resolve(
        look ? { look } : { error: `no look "${id}" in the demo` },
      );
    },
    create: () => {
      const id = starterFolderName(new Set(looks.keys()));
      const files = new Map(
        Object.entries(starterFiles(id)).map((
          [n, t],
        ) => [n, encoder.encode(t)]),
      );
      const built = buildLook(files);
      if (!built.ok) return Promise.reject(new Error(built.error));
      looks.set(id, built.look);
      return Promise.resolve({ path: `(demo) ${id}` });
    },
    openFolder: () => Promise.resolve(),
  };
}
