// User skins, the desktop side: a desktop extension (`skins`) beside `links` and the others. A
// skin is a folder in `<app support>/skins/` (on macOS
// `~/Library/Application Support/org.qutty.Qutty/skins/`; `~/.qutty/skins/` where the runtime
// gives no app-support folder) holding a `skin.json` and a `skin.css` (lib/skins/skin.ts,
// docs/skins.md).
//
// - `list`: every skin folder, checked in full (the manifest, the stylesheet, its assets), as
//   the manifests of the usable ones and the reason for each one that is not.
// - `get`: one skin, its stylesheet sanitized and its assets (images, fonts) inlined as `data:`
//   URLs, so the page loads nothing from the folder and nothing from the network.
// - `template`: write a copy of a skin package (the page sends the built-in Classic's two files)
//   into the folder under a free id, to start a skin from.
// - `openFolder`: the folder in Finder (Linux: the file manager), made first when missing.
//
// Reading goes through Deno's fs (the baseline has read). Writing goes through libc
// (desktop/libc.ts), as every extension's writes do: the app has no `write` permission. A skin
// never runs code: there is no script in a package, and the stylesheet is refused when it has
// `@import`, a remote `url()` or anything else lib/skins/skin.ts lists.

import { defineDesktopExtension } from "denext/desktop";
import { encodeBase64 } from "@std/encoding";
import { emptyInput, objectSchema, str } from "./schema.ts";
import { ensureDir, writeFileAtomic } from "./libc.ts";
import { resolveProgram } from "./pty.ts";
import { type CommandRunner, PtyRunner } from "./ollama.ts";
import { openCommand } from "./links.ts";
import {
  assetMediaType,
  type AssetResolver,
  buildSkin,
  isSkinId,
  MAX_ASSET_BYTES,
  MAX_CSS_SOURCE,
  MAX_MANIFEST_BYTES,
  type Skin,
  type SkinList,
  type SkinTemplateRequest,
} from "../lib/skins/skin.ts";
import { BUILTIN_SKIN_IDS, skinCopy } from "../lib/skins/builtin.ts";

/** How many skin folders are looked at. */
const MAX_SKINS = 64;
/** The most a skin's assets may add up to (bytes, before base64). */
const MAX_ASSETS_TOTAL = 2 * 1024 * 1024;

type Built = { ok: true; value: Skin } | { ok: false; error: string };

function readText(path: string, max: number, what: string): string {
  const size = Deno.statSync(path).size;
  if (size > max) throw new Error(`${what} is larger than ${max / 1024} KB`);
  return Deno.readTextFileSync(path);
}

/** The user's skins folder (exported for tests, which point it at a temp folder). */
export class SkinStore {
  readonly dir: string;
  #runner: CommandRunner | undefined;
  #os: "darwin" | "linux";

  constructor(opts: { dir: string; runner?: CommandRunner; os?: string }) {
    this.dir = opts.dir;
    this.#runner = opts.runner;
    this.#os = (opts.os ?? Deno.build.os) === "darwin" ? "darwin" : "linux";
  }

  /** The skin folders' names, sorted (dot folders and files left out). */
  #folders(): string[] {
    let names: string[];
    try {
      names = [...Deno.readDirSync(this.dir)]
        .filter((e) =>
          !e.name.startsWith(".") && (e.isDirectory || e.isSymlink)
        )
        .map((e) => e.name);
    } catch {
      return [];
    }
    return names.sort().slice(0, MAX_SKINS);
  }

  /** Gives a skin folder's assets as `data:` URLs; nothing outside the folder is ever read. */
  #assets(root: string): AssetResolver {
    let total = 0;
    const seen = new Map<string, string>();
    return (path) => {
      const cached = seen.get(path);
      if (cached) return { url: cached };
      const type = assetMediaType(path);
      if (!type) return { error: `"${path}" is not an image or font file` };
      try {
        // A symlink must not lead out of the skin's folder.
        const real = Deno.realPathSync(`${root}/${path}`);
        if (!real.startsWith(`${root}/`)) {
          return { error: `"${path}" is outside the skin folder` };
        }
        const stat = Deno.statSync(real);
        if (!stat.isFile) return { error: `"${path}" is not a file` };
        if (stat.size > MAX_ASSET_BYTES) {
          return {
            error: `"${path}" is larger than ${MAX_ASSET_BYTES / 1024} KB`,
          };
        }
        total += stat.size;
        if (total > MAX_ASSETS_TOTAL) {
          return {
            error: `the skin's files add up to more than ${
              MAX_ASSETS_TOTAL / 1024 / 1024
            } MB`,
          };
        }
        const url = `data:${type};base64,${
          encodeBase64(Deno.readFileSync(real))
        }`;
        seen.set(path, url);
        return { url };
      } catch {
        return { error: `"${path}" was not found in the skin folder` };
      }
    };
  }

  /** Read and check the skin in `folder`. */
  #build(folder: string): Built {
    if (!isSkinId(folder)) {
      return {
        ok: false,
        error:
          "the folder's name must be 1 to 40 lower-case letters, digits or dashes",
      };
    }
    if (BUILTIN_SKIN_IDS.includes(folder)) {
      return { ok: false, error: `"${folder}" is a built-in skin's id` };
    }
    try {
      const root = Deno.realPathSync(`${this.dir}/${folder}`);
      let manifest: string;
      try {
        manifest = readText(
          `${root}/skin.json`,
          MAX_MANIFEST_BYTES,
          "skin.json",
        );
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          return { ok: false, error: "there is no skin.json" };
        }
        throw err;
      }
      let css = "";
      try {
        css = readText(`${root}/skin.css`, MAX_CSS_SOURCE, "skin.css");
      } catch (err) {
        // A skin of only colours and frame options has no stylesheet.
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
      return buildSkin({ manifest, css }, {
        folder,
        resolve: this.#assets(root),
        source: "user",
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Every skin folder: the usable skins' manifests, and why each other one is not. */
  list(): SkinList {
    const out: SkinList = { dir: this.dir, skins: [], problems: [] };
    for (const folder of this.#folders()) {
      const r = this.#build(folder);
      if (r.ok) out.skins.push(r.value.manifest);
      else out.problems.push({ folder, error: r.error });
    }
    return out;
  }

  /** One skin, ready to apply. Throws with the reason when it is not usable. */
  get(id: string): Skin {
    if (!isSkinId(id) || !this.#folders().includes(id)) {
      throw new Error(`there is no skin "${String(id).slice(0, 40)}"`);
    }
    const r = this.#build(id);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }

  /** Make the skins folder (and the app-support folder above it) when missing. */
  ensure(): void {
    ensureDir(this.dir.slice(0, this.dir.lastIndexOf("/")), 0o755);
    ensureDir(this.dir, 0o755);
  }

  /**
   * Write a copy of a skin package under a free id (`my-classic`, `my-classic-2`, …). The copy is
   * checked like any skin before anything is written.
   */
  template(req: SkinTemplateRequest): { id: string; dir: string } {
    const folders = this.#folders();
    const { id, files } = skinCopy(req, (id) => folders.includes(id));
    this.ensure();
    const dir = `${this.dir}/${id}`;
    ensureDir(dir, 0o755);
    const enc = new TextEncoder();
    writeFileAtomic(`${dir}/skin.json`, enc.encode(files.manifest), 0o644);
    writeFileAtomic(`${dir}/skin.css`, enc.encode(files.css), 0o644);
    return { id, dir };
  }

  /** Show the skins folder in the file manager. */
  async openFolder(): Promise<void> {
    this.ensure();
    if (!this.#runner) throw new Error("cannot open folders here");
    const [program, ...args] = openCommand(this.#os, "open", this.dir);
    const path = program.startsWith("/")
      ? program
      : await resolveProgram(program);
    if (!path) throw new Error(`${program} is not installed`);
    const r = await this.#runner.run(path, args, { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`${program} exited with ${r.code}`);
  }
}

/** Where user skins live: in the app-support folder, else in `~/.qutty`. */
export function skinsDir(
  appSupportDir: string | undefined,
  home: string | undefined,
): string | undefined {
  if (appSupportDir) return `${appSupportDir}/skins`;
  return home && home.startsWith("/") ? `${home}/.qutty/skins` : undefined;
}

let store: SkinStore | undefined;

function requireStore(): SkinStore {
  if (!store) throw new Error("skins are not available");
  return store;
}

const getInput = objectSchema<{ id: string }>((v, issues) => ({
  id: str(v, "id", issues, 40),
}));

const templateInput = objectSchema<SkinTemplateRequest>((v, issues) => ({
  id: str(v, "id", issues, 40),
  name: str(v, "name", issues, 60),
  from: str(v, "from", issues, 40),
  manifest: str(v, "manifest", issues, MAX_MANIFEST_BYTES),
  css: str(v, "css", issues, MAX_CSS_SOURCE),
}));

export default defineDesktopExtension({
  name: "skins",
  setup: (host) => {
    if (Deno.build.os === "windows") return;
    const dir = skinsDir(host.appSupportDir, Deno.env.get("HOME"));
    if (dir) store = new SkinStore({ dir, runner: new PtyRunner() });
  },
  methods: {
    /** The user's skins (manifests) and the folders that are not usable skins. */
    list: {
      input: emptyInput,
      handler: (): Promise<SkinList> => Promise.resolve(requireStore().list()),
    },
    /** One skin: its manifest and its sanitized stylesheet, assets inlined. */
    get: {
      input: getInput,
      handler: (args: unknown): Promise<Skin> =>
        Promise.resolve(requireStore().get((args as { id: string }).id)),
    },
    /** Copy a skin package into the folder under a free id. */
    template: {
      input: templateInput,
      handler: (args: unknown): Promise<{ id: string; dir: string }> =>
        Promise.resolve(requireStore().template(args as SkinTemplateRequest)),
    },
    /** Show the skins folder in the file manager. */
    openFolder: {
      input: emptyInput,
      handler: (): Promise<void> => requireStore().openFolder(),
    },
  },
});
