// Companion looks, the desktop side: a desktop extension (`looks`) beside `hub`. The user's looks
// are folders in `companions/` under the app-support folder (Denext's per-app data folder:
// `~/Library/Application Support/org.qutty.Qutty/companions` on macOS,
// `$XDG_DATA_HOME/org.qutty.Qutty/companions`, by default `~/.local/share/…`, on Linux). Each folder
// holds a `look.json`, pictures named by mood and maybe a `look.css` (lib/companion/looks.ts;
// docs/companion-looks.md).
//
// - `list`: the looks (their manifests and `idle` pictures, for Settings' thumbnails) and the
//   folders that are not usable looks, with why.
// - `get`: one look with all its pictures, as `data:` URLs, and its scoped CSS.
// - `create`: copy the starter look (lib/companion/look-template.ts) into a new folder and open it.
// - `openFolder`: open the looks folder in Finder (Linux: the file manager).
//
// Only a folder's own regular files are read: sub-folders, symbolic links and names a look cannot
// have are skipped, so a look cannot reach outside its folder; each file's size is checked before
// it is read (lib/companion/look-build.ts checks the rest). The page never gets a path to load:
// the pictures arrive as `data:` URLs. Opening a folder runs `/usr/bin/open` (`xdg-open`) in a
// hidden PTY, as desktop/links.ts does.

import { defineDesktopExtension } from "denext/desktop";
import { join } from "@std/path";
import { emptyInput, objectSchema, str } from "./schema.ts";
import { resolveProgram } from "./pty.ts";
import { type CommandRunner, PtyRunner } from "./ollama.ts";
import { openCommand } from "./links.ts";
import { buildLook, isLookFileName } from "../lib/companion/look-build.ts";
import {
  isLookId,
  type Look,
  LOOK_LIMITS,
  type LookListing,
  type LookProblem,
  type LookSummary,
} from "../lib/companion/looks.ts";
import {
  starterFiles,
  starterFolderName,
} from "../lib/companion/look-template.ts";

/** The looks folder's name in the app-support folder. */
export const LOOKS_FOLDER = "companions";

/** The biggest file read from a look folder (the largest picture). */
const MAX_FILE = Math.max(
  LOOK_LIMITS.imageBytes,
  LOOK_LIMITS.cssBytes,
  LOOK_LIMITS.manifestBytes,
);

/** A look folder's files (only `wanted` names, when given), each checked before it is read. */
async function readFolderFiles(
  dir: string,
  wanted?: (name: string) => boolean,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for await (const entry of Deno.readDir(dir)) {
    // `isFile` is false for a symbolic link: links are never followed.
    if (!entry.isFile || !isLookFileName(entry.name)) continue;
    if (wanted && !wanted(entry.name)) continue;
    const path = join(dir, entry.name);
    const info = await Deno.lstat(path);
    if (!info.isFile) continue;
    if (info.size > MAX_FILE) {
      // Too big to read: a stand-in just past the limit, which buildLook reports by name.
      files.set(entry.name, new Uint8Array(MAX_FILE + 1));
      continue;
    }
    files.set(entry.name, await Deno.readFile(path));
  }
  return files;
}

/** The looks in a looks folder (exported for tests, which point it at a temp folder). */
export class LookStore {
  readonly dir: string;
  #runner: CommandRunner | undefined;
  #os: "darwin" | "linux";

  constructor(
    dir: string,
    opts: { runner?: CommandRunner; os?: "darwin" | "linux" } = {},
  ) {
    this.dir = dir;
    this.#runner = opts.runner;
    this.#os = opts.os ?? (Deno.build.os === "darwin" ? "darwin" : "linux");
  }

  /** The look folders' names (real folders, not links), sorted; none when there is no folder. */
  async #folders(): Promise<string[]> {
    const names: string[] = [];
    try {
      for await (const entry of Deno.readDir(this.dir)) {
        if (entry.isDirectory && !entry.name.startsWith(".")) {
          names.push(entry.name);
        }
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }
    return names.sort().slice(0, LOOK_LIMITS.looks);
  }

  /**
   * Every look folder read with `only` pictures: the usable looks (the first folder of an id
   * wins) and the folders that are not, with why.
   */
  async #scan(
    only?: readonly string[],
  ): Promise<
    { looks: { folder: string; look: Look }[]; problems: LookProblem[] }
  > {
    const looks: { folder: string; look: Look }[] = [];
    const problems: LookProblem[] = [];
    const wanted = only
      ? (name: string) =>
        name === "look.json" ||
        only.includes(name.slice(0, name.lastIndexOf(".")))
      : undefined;
    for (const folder of await this.#folders()) {
      let files: Map<string, Uint8Array>;
      try {
        files = await readFolderFiles(join(this.dir, folder), wanted);
      } catch (e) {
        problems.push({
          folder,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const built = buildLook(files, only);
      if (!built.ok) {
        problems.push({ folder, error: built.error });
        continue;
      }
      const twin = looks.find((l) => l.look.id === built.look.id);
      if (twin) {
        problems.push({
          folder,
          error: `its id "${built.look.id}" is the folder ${twin.folder}'s too`,
        });
        continue;
      }
      looks.push({ folder, look: built.look });
    }
    return { looks, problems };
  }

  /** The looks, with their `idle` pictures for the thumbnails, and the folders that are not. */
  async list(): Promise<LookListing> {
    const { looks, problems } = await this.#scan(["idle"]);
    return {
      dir: this.dir,
      looks: looks.map(({ look }): LookSummary => {
        const { images, css: _css, ...manifest } = look;
        return { ...manifest, thumbnail: images.idle };
      }),
      problems,
    };
  }

  /** Look `id` with all its pictures, or why it cannot be had. */
  async get(id: string): Promise<{ look: Look } | { error: string }> {
    if (!isLookId(id)) return { error: "not a look id" };
    // Find its folder by the manifests alone, then read that folder whole.
    const { looks, problems } = await this.#scan(["idle"]);
    const found = looks.find((l) => l.look.id === id);
    if (!found) {
      const bad = problems.find((p) => p.folder === id);
      return { error: bad ? bad.error : `no look "${id}" in ${this.dir}` };
    }
    const built = buildLook(
      await readFolderFiles(join(this.dir, found.folder)),
    );
    return built.ok ? { look: built.look } : { error: built.error };
  }

  /** Copy the starter look into a new folder (`my-look`, `my-look-2`, …); its path. */
  async create(): Promise<string> {
    await Deno.mkdir(this.dir, { recursive: true });
    const taken = new Set<string>();
    for await (const entry of Deno.readDir(this.dir)) taken.add(entry.name);
    const id = starterFolderName(taken);
    const folder = join(this.dir, id);
    await Deno.mkdir(folder);
    for (const [name, text] of Object.entries(starterFiles(id))) {
      await Deno.writeTextFile(join(folder, name), text, { createNew: true });
    }
    return folder;
  }

  /** Open `path` (the looks folder by default, made first) in the file manager. */
  async open(path: string = this.dir): Promise<void> {
    if (!this.#runner) throw new Error("opening folders is not available");
    await Deno.mkdir(this.dir, { recursive: true });
    const [program, ...args] = openCommand(this.#os, "open", path);
    const exe = program.startsWith("/")
      ? program
      : await resolveProgram(program);
    if (!exe) throw new Error(`${program} is not installed`);
    const r = await this.#runner.run(exe, args, { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`${program} exited with ${r.code}`);
  }
}

let store: LookStore | undefined;

function requireStore(): LookStore {
  if (!store) throw new Error("companion looks are not available");
  return store;
}

const idInput = objectSchema<{ id: string }>((v, issues) => ({
  id: str(v, "id", issues, 64),
}));

export default defineDesktopExtension({
  name: "looks",
  setup: (host) => {
    if (host.os === "windows" || !host.appSupportDir) return;
    store = new LookStore(join(host.appSupportDir, LOOKS_FOLDER), {
      runner: new PtyRunner(),
    });
  },
  methods: {
    /** The looks folder, its looks (with thumbnails) and the folders that are not looks. */
    list: {
      input: emptyInput,
      handler: (): Promise<LookListing> => requireStore().list(),
    },
    /** One look whole (`error`: missing or not usable). */
    get: {
      input: idInput,
      handler: (args: unknown): Promise<{ look: Look } | { error: string }> =>
        requireStore().get((args as { id: string }).id),
    },
    /** Copy the starter look into the looks folder and open it; its folder. */
    create: {
      input: emptyInput,
      handler: async (): Promise<{ path: string }> => {
        const s = requireStore();
        const path = await s.create();
        await s.open(path).catch((e) =>
          console.error("looks: could not open the new look", e)
        );
        return { path };
      },
    },
    /** Open the looks folder (made if missing). */
    openFolder: {
      input: emptyInput,
      handler: (): Promise<void> => requireStore().open(),
    },
  },
});
