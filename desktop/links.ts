// Clickable links, the desktop side: a desktop extension (`links`) beside `pty`, `ssh`, `hub`,
// `sandbox`, `voice` and `ollama`. The page finds link candidates in terminal output
// (lib/links.ts, lib/terminal-links.ts); this checks which paths exist and opens things:
//
// - `resolve`: which candidate paths exist (against the tile's directory and `$HOME`), and
//   whether each is a file or a folder. The page asks on hover and caches the answer briefly.
// - `open`: a URL in the default browser, a file in its default app, a path revealed in Finder
//   (Linux: the file manager). A file the OS would run instead of display (a script, an app, an
//   executable) is revealed instead of opened.
// - `editors` / `edit`: which of the editor presets are installed, and running the configured
//   editor command template on a file at a line.
//
// Why not Denext's `shell` capability (`openExternal` / `openPath` / `reveal`, Denext 4.13.1): it
// confines `openPath` and `reveal` to the app's own data, cache and documents folders (or a path
// the user picked in a dialog this session), so it cannot open `~/Source/x/src/a.ts`, and turning
// it on bakes `--allow-run` of `open` and `osascript` into the app, which otherwise has no `run`
// permission at all. So, like desktop/ollama.ts, every command runs in a hidden PTY
// (`PtyRunner`), always as an argv (no shell): `/usr/bin/open` (macOS), `xdg-open` / `dbus-send`
// (Linux), or the editor's own program.

import { defineDesktopExtension } from "denext/desktop";
import {
  emptyInput,
  objectSchema,
  optInt,
  optStr,
  str,
  strList,
} from "./schema.ts";
import { resolveProgram } from "./pty.ts";
import { type CommandRunner, PtyRunner } from "./ollama.ts";
import {
  EDITOR_PRESETS,
  editorArgv,
  isOpenableUrl,
  type LinkEditRequest,
  type LinkOpenRequest,
  type LinkTarget,
  MAX_EDITOR_COMMAND,
  resolvePath,
} from "../lib/links.ts";

/** How many paths one `resolve` call may ask about (one terminal line's worth, generously). */
const MAX_RESOLVE = 64;
const MAX_PATH = 4096;
const RUN_TIMEOUT_MS = 15_000;

/**
 * File extensions a default-app open would run (or install) rather than show: programs, scripts,
 * launchers and installers. Such a file is revealed instead. Best effort, like Denext's own
 * `openPath` denylist; an executable bit counts as well.
 */
// deno-fmt-ignore
const RUNS_ON_OPEN = new Set([
  "app", "command", "tool", "terminal", "scpt", "scptd", "applescript", "workflow", "action",
  "pkg", "mpkg", "dmg", "fileloc", "webloc", "inetloc", "prefpane", "saver", "kext", "osax",
  "desktop", "sh", "bash", "zsh", "csh", "ksh", "fish", "run", "appimage", "bin", "jar", "py",
  "pyw", "pyc", "pl", "rb", "php", "deb", "rpm", "flatpakref", "snap", "exe", "bat", "cmd",
  "com", "msi", "ps1", "vbs", "lnk",
]);

/** Whether a default-app open of `path` (a file with `mode`) would run it. */
export function runsOnOpen(path: string, mode: number | null): boolean {
  if (mode !== null && (mode & 0o111) !== 0) return true;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && RUNS_ON_OPEN.has(name.slice(dot + 1));
}

type Os = "darwin" | "linux";

/** What a path is, or `null` when it does not exist (`Deno.stat`, injectable for tests). */
type StatFn = (
  path: string,
) => Promise<
  { isFile: boolean; isDirectory: boolean; mode: number | null } | null
>;

async function realStat(path: string) {
  try {
    const s = await Deno.stat(path);
    return { isFile: s.isFile, isDirectory: s.isDirectory, mode: s.mode };
  } catch {
    return null;
  }
}

/** The argv that opens a URL or a path, or reveals a path, on `os`. Pure; the path is one argument. */
export function openCommand(
  os: Os,
  action: "url" | "open" | "reveal",
  target: string,
): string[] {
  if (os === "darwin") {
    return action === "reveal"
      ? ["/usr/bin/open", "-R", target]
      : ["/usr/bin/open", target];
  }
  if (action !== "reveal") return ["xdg-open", target];
  return [
    "dbus-send",
    "--session",
    "--dest=org.freedesktop.FileManager1",
    "--type=method_call",
    "/org/freedesktop/FileManager1",
    "org.freedesktop.FileManager1.ShowItems",
    // dbus-send splits `array:string:` values on commas.
    `array:string:file://${encodeURI(target).replace(/,/g, "%2C")}`,
    "string:",
  ];
}

/** The links service (exported for tests, which fake the runner, `stat` and the program lookup). */
export class LinkService {
  #runner: CommandRunner;
  #stat: StatFn;
  #find: (name: string) => Promise<string | undefined>;
  #os: Os;
  #home: string | undefined;

  constructor(opts: {
    runner: CommandRunner;
    stat?: StatFn;
    find?: (name: string) => Promise<string | undefined>;
    os?: Os;
    home?: string;
  }) {
    this.#runner = opts.runner;
    this.#stat = opts.stat ?? realStat;
    this.#find = opts.find ?? resolveProgram;
    this.#os = opts.os ?? (Deno.build.os === "darwin" ? "darwin" : "linux");
    this.#home = opts.home ?? Deno.env.get("HOME");
  }

  /** Each path resolved against `cwd` and the home folder, if it exists. */
  async resolve(
    cwd: string | undefined,
    paths: string[],
  ): Promise<(LinkTarget | null)[]> {
    return await Promise.all(paths.map(async (p) => {
      const path = resolvePath(p, cwd, this.#home);
      if (!path) return null;
      const s = await this.#stat(path);
      if (!s || (!s.isFile && !s.isDirectory)) return null;
      return { path, kind: s.isDirectory ? "dir" : "file" } as LinkTarget;
    }));
  }

  /** Open a URL, open a file (a folder or a runnable file is revealed), or reveal a path. */
  async open(req: LinkOpenRequest): Promise<void> {
    if (req.kind === "url") {
      if (!isOpenableUrl(req.url)) throw new Error("not a URL Qutty opens");
      // The normalized href: what was checked is what is opened.
      return await this.#run(
        openCommand(this.#os, "url", new URL(req.url).href),
      );
    }
    const path = resolvePath(req.path, undefined, this.#home);
    if (!path || !req.path.startsWith("/")) {
      throw new Error("the path must be absolute");
    }
    const s = await this.#stat(path);
    if (!s) throw new Error(`${path} does not exist`);
    const reveal = req.kind === "reveal" || s.isDirectory ||
      runsOnOpen(path, s.mode);
    if (!reveal) return await this.#run(openCommand(this.#os, "open", path));
    try {
      await this.#run(openCommand(this.#os, "reveal", path));
    } catch (err) {
      // Linux without a FileManager1 service (no file manager running): open the folder instead.
      if (this.#os === "darwin") throw err;
      const dir = s.isDirectory
        ? path
        : path.slice(0, path.lastIndexOf("/")) || "/";
      await this.#run(openCommand(this.#os, "open", dir));
    }
  }

  /** The ids of the editor presets whose program is installed. */
  async editors(): Promise<string[]> {
    const found = await Promise.all(
      EDITOR_PRESETS.map(async (p) =>
        (await this.#find(p.program)) ? p.id : null
      ),
    );
    return found.filter((id): id is string => id !== null);
  }

  /** The argv `edit` would run (its program looked up), or why not. Exported for the real check. */
  async editArgv(req: LinkEditRequest): Promise<string[]> {
    const argv = editorArgv(req.command, req);
    if (!argv) throw new Error("the editor command is not usable");
    const s = await this.#stat(req.file);
    if (!s?.isFile) throw new Error(`${req.file} is not a file`);
    const program = await this.#find(argv[0]);
    if (!program) throw new Error(`${argv[0]} is not installed`);
    return [program, ...argv.slice(1)];
  }

  /** Run the editor command on a file. */
  async edit(req: LinkEditRequest): Promise<void> {
    await this.#run(await this.editArgv(req));
  }

  async #run(argv: string[]): Promise<void> {
    const [program, ...args] = argv;
    const path = program.startsWith("/") ? program : await this.#find(program);
    if (!path) throw new Error(`${program} is not installed`);
    const r = await this.#runner.run(path, args, { timeoutMs: RUN_TIMEOUT_MS });
    if (r.code !== 0) {
      const why = r.out.trim().split("\n").at(-1) ?? "";
      throw new Error(
        `${program} exited with ${r.code}${why ? `: ${why}` : ""}`,
      );
    }
  }
}

let service: LinkService | undefined;

function requireService(): LinkService {
  if (!service) throw new Error("links are not available");
  return service;
}

const resolveInput = objectSchema<{ cwd?: string; paths: string[] }>(
  (v, issues) => {
    const cwd = optStr(v, "cwd", issues, MAX_PATH);
    return {
      ...(cwd === undefined ? {} : { cwd }),
      paths: strList(v, "paths", issues, MAX_RESOLVE, MAX_PATH),
    };
  },
);

const openInput = objectSchema<LinkOpenRequest>((v, issues) => {
  if (v.kind === "url") {
    return { kind: "url", url: str(v, "url", issues, 8192) };
  }
  if (v.kind !== "open" && v.kind !== "reveal") {
    issues.push({
      message: "kind must be url, open or reveal",
      path: ["kind"],
    });
  }
  return {
    kind: v.kind === "reveal" ? "reveal" : "open",
    path: str(v, "path", issues, MAX_PATH),
  };
});

const editInput = objectSchema<LinkEditRequest>((v, issues) => {
  const line = optInt(v, "line", issues, 1, 1e8);
  const col = optInt(v, "col", issues, 1, 1e8);
  return {
    command: str(v, "command", issues, MAX_EDITOR_COMMAND),
    file: str(v, "file", issues, MAX_PATH),
    ...(line === undefined ? {} : { line }),
    ...(col === undefined ? {} : { col }),
  };
});

export default defineDesktopExtension({
  name: "links",
  setup: (host) => {
    if (Deno.build.os === "windows") return;
    service = new LinkService({
      runner: new PtyRunner(host.appSupportDir || undefined),
    });
  },
  methods: {
    /** Which candidate paths exist (resolved against `cwd` and `$HOME`), file or folder. */
    resolve: {
      input: resolveInput,
      handler: (args: unknown): Promise<(LinkTarget | null)[]> => {
        const a = args as { cwd?: string; paths: string[] };
        return requireService().resolve(a.cwd, a.paths);
      },
    },
    /** Open a URL or a file, or reveal a path. */
    open: {
      input: openInput,
      handler: (args: unknown): Promise<void> =>
        requireService().open(args as LinkOpenRequest),
    },
    /** The installed editor presets (lib/links.ts EDITOR_PRESETS ids). */
    editors: {
      input: emptyInput,
      handler: (): Promise<string[]> => requireService().editors(),
    },
    /** Run the editor command template on a file at a line. */
    edit: {
      input: editInput,
      handler: (args: unknown): Promise<void> =>
        requireService().edit(args as LinkEditRequest),
    },
  },
});
