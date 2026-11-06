// The Ollama helper's backend: a desktop extension (`ollama`) beside `pty`, `ssh`, `hub`,
// `sandbox` and `voice`. It reports what Ollama has (installed, version, server, the pulled and
// loaded models with what `ollama show` says about each, which `ollama launch` harnesses are
// installed) and reads the ollama.com library. The parsing lives in lib/ollama/.
//
// - Every `ollama` command and every library fetch (`curl`) runs in a hidden PTY of this module
//   (the pattern desktop/ssh.ts uses for scp, through desktop/sandbox.ts's `PtyDockerCli`), so
//   the app needs no `run` and no `net` permission. The tiles themselves (`ollama launch …`,
//   `ollama pull …`) are ordinary program spawns through the PTY extension.
// - Cheap to poll: `ollama --version`, `ollama list` and `ollama ps` per call; `ollama show` only
//   for a model not seen before (cached by name and digest, so a re-pulled model is read again).
// - Library pages are cached for LIBRARY_TTL_MS (a few hours) per URL; a failed fetch keeps the
//   last good copy and says why.
//
// Nothing here may throw into the app's startup: without Ollama the status says so.

import { defineDesktopExtension } from "denext/desktop";
import { emptyInput, objectSchema, optBool, optStr, str } from "./schema.ts";
import { resolveProgram } from "./pty.ts";
import { PtyDockerCli } from "./sandbox.ts";
import {
  emptyStatus,
  isModelName,
  lastLine,
  type OllamaModelDetails,
  type OllamaStatus,
  parseList,
  parsePs,
  parseShow,
  parseVersion,
} from "../lib/ollama/cli.ts";
import { OLLAMA_HARNESSES } from "../lib/ollama/harnesses.ts";
import {
  isLibraryName,
  LIBRARY_TTL_MS,
  type LibraryOrder,
  type LibraryPageResult,
  type LibraryResult,
  modelUrl,
  parseModelPage,
  parseSearch,
  searchUrl,
} from "../lib/ollama/library.ts";

export type { LibraryPageResult, LibraryResult, OllamaStatus };

/** Where the macOS app lives when installed (Settings offers to open it). */
const OLLAMA_APP = "/Applications/Ollama.app";

/** What runs a program and returns its exit code and output (a hidden PTY; tests fake it). */
export interface CommandRunner {
  run(
    program: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ code: number; out: string }>;
}

// deno-lint-ignore no-control-regex
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\r/g;

/**
 * Programs through hidden PTYs, each started as `env TERM=dumb <program> …`: on a terminal that
 * claims to be an xterm, `ollama` asks for the background colour (OSC 11) and waits 5 s for an
 * answer a hidden PTY never gives; `TERM=dumb` skips the question.
 */
export class PtyRunner implements CommandRunner {
  #cli: PtyDockerCli;
  constructor(appSupportDir: string | undefined) {
    this.#cli = new PtyDockerCli({
      ...(appSupportDir ? { appSupportDir } : {}),
      find: () => Promise.resolve("/usr/bin/env"),
    });
  }
  async run(
    program: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ code: number; out: string }> {
    const r = await this.#cli.run(["TERM=dumb", program, ...args], opts);
    return { code: r.code, out: r.out.replace(ESCAPES, "") };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The Ollama helper: status readings and library fetches, cached. */
export class OllamaService {
  #runner: CommandRunner;
  #find: (name: string) => Promise<string | undefined>;
  #appPath: string;
  /** `ollama show` facts by `name@digest`. */
  #details = new Map<string, OllamaModelDetails>();
  /** Library pages by URL. */
  #pages = new Map<string, { at: number; text: string }>();
  /** The status reading in flight (concurrent callers share it). */
  #reading: Promise<OllamaStatus> | undefined;

  constructor(opts: {
    runner: CommandRunner;
    find?: (name: string) => Promise<string | undefined>;
    appPath?: string;
  }) {
    this.#runner = opts.runner;
    this.#find = opts.find ?? resolveProgram;
    this.#appPath = opts.appPath ?? OLLAMA_APP;
  }

  /** A fresh reading (one at a time). */
  status(): Promise<OllamaStatus> {
    this.#reading ??= this.#read().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  async #read(): Promise<OllamaStatus> {
    const now = Date.now();
    const status = emptyStatus(now);
    status.app = Deno.build.os === "darwin" && await exists(this.#appPath);
    status.harnesses = await Promise.all(
      OLLAMA_HARNESSES.map(async (h) => ({
        name: h.name,
        label: h.label,
        installed: (await this.#find(h.name)) !== undefined,
      })),
    );
    const path = await this.#find("ollama");
    if (!path) return status;
    status.installed = true;
    status.path = path;
    const ollama = (args: string[]) =>
      this.#runner.run(path, args, { timeoutMs: 10_000 });
    try {
      const v = await ollama(["--version"]);
      const version = parseVersion(v.out);
      if (version) status.version = version;
      // Asked first because `ollama list` with no server tries to start one (it opens the macOS
      // app), which a poll must not do: the user may have quit Ollama on purpose.
      if (!(await this.#serverUp())) {
        status.error = "the Ollama server is not running";
        return status;
      }
      const list = await ollama(["list"]);
      if (list.code !== 0) {
        status.error = lastLine(list.out) || `ollama list exited ${list.code}`;
        return status;
      }
      status.serverUp = true;
      status.models = parseList(list.out);
      const ps = await ollama(["ps"]);
      if (ps.code === 0) status.running = parsePs(ps.out);
      for (const m of status.models) {
        const key = `${m.name}@${m.id}`;
        let details = this.#details.get(key);
        if (!details && isModelName(m.name)) {
          const show = await ollama(["show", m.name]);
          if (show.code === 0) {
            details = parseShow(show.out);
            this.#details.set(key, details);
          }
        }
        if (details) m.details = details;
      }
    } catch (e) {
      status.error = e instanceof Error ? e.message : String(e);
    }
    return status;
  }

  /** `curl` with `args`, or why it cannot run. */
  async #curl(
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; out: string }> {
    const curl = await this.#find("curl");
    if (!curl) return { code: 127, out: "curl was not found" };
    return await this.#runner.run(curl, ["-fsSL", ...args], { timeoutMs });
  }

  /** Whether the server answers on its address (`OLLAMA_HOST`, else 127.0.0.1:11434). */
  async #serverUp(): Promise<boolean> {
    const r = await this.#curl([
      "--max-time",
      "3",
      `${serverOrigin(Deno.env.get("OLLAMA_HOST"))}/api/version`,
    ], 6_000);
    return r.code === 0 && r.out.includes('"version"');
  }

  /** A library page's text, from the cache while fresh. */
  async #fetch(
    url: string,
  ): Promise<{ text?: string; at: number; error?: string }> {
    const cached = this.#pages.get(url);
    const now = Date.now();
    if (cached && now - cached.at < LIBRARY_TTL_MS) {
      return { text: cached.text, at: cached.at };
    }
    let error: string;
    try {
      const r = await this.#curl(
        ["--max-time", "20", "-A", "Qutty (Ollama helper)", url],
        25_000,
      );
      if (r.code === 0 && r.out.includes("<")) {
        this.#pages.set(url, { at: now, text: r.out });
        return { text: r.out, at: now };
      }
      error = `the library could not be reached (curl exit ${r.code}${
        lastLine(r.out) ? `: ${lastLine(r.out).slice(0, 200)}` : ""
      })`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    return cached
      ? { text: cached.text, at: cached.at, error }
      : { at: 0, error };
  }

  /** Search the library (empty query: the whole library). */
  async library(
    query: string,
    order: LibraryOrder,
    toolsOnly: boolean,
  ): Promise<LibraryResult> {
    const got = await this.#fetch(searchUrl(query, { order, toolsOnly }));
    return {
      models: got.text ? parseSearch(got.text) : [],
      fetchedAt: got.at,
      ...(got.error ? { error: got.error } : {}),
    };
  }

  /** One model's page (its Applications and variants). */
  async libraryModel(name: string): Promise<LibraryPageResult> {
    const base = name.replace(/:.*$/, "");
    if (!isLibraryName(base)) {
      return { fetchedAt: 0, error: "not a model name" };
    }
    const got = await this.#fetch(modelUrl(base));
    return {
      ...(got.text ? { page: parseModelPage(base, got.text) } : {}),
      fetchedAt: got.at,
      ...(got.error ? { error: got.error } : {}),
    };
  }

  /** Open the Ollama app (macOS), which starts its server. */
  async openApp(): Promise<boolean> {
    if (Deno.build.os !== "darwin" || !(await exists(this.#appPath))) {
      return false;
    }
    const r = await this.#runner.run("/usr/bin/open", ["-a", this.#appPath], {
      timeoutMs: 10_000,
    });
    return r.code === 0;
  }
}

/**
 * The server's HTTP origin for an `OLLAMA_HOST` value (`host`, `host:port`, `scheme://host:port`);
 * the default `http://127.0.0.1:11434`. `0.0.0.0` (listen on all) is asked on loopback.
 */
export function serverOrigin(host: string | undefined): string {
  const h = (host ?? "").trim();
  if (!h) return "http://127.0.0.1:11434";
  const m = /^(?:(https?):\/\/)?([^/:]+|\[[^\]]+\])?(?::(\d+))?\/?$/.exec(h);
  if (!m) return "http://127.0.0.1:11434";
  const scheme = m[1] ?? "http";
  const name = !m[2] || m[2] === "0.0.0.0" ? "127.0.0.1" : m[2];
  return `${scheme}://${name}:${
    m[3] ?? (scheme === "https" ? "443" : "11434")
  }`;
}

let service: OllamaService | undefined;

function requireService(): OllamaService {
  if (!service) throw new Error("the Ollama helper is not available");
  return service;
}

const libraryInput = objectSchema<
  { query?: string; order: LibraryOrder; toolsOnly: boolean }
>((v, issues) => {
  const query = optStr(v, "query", issues, 100);
  const order = v.order === "newest" ? "newest" : "popular";
  return {
    ...(query === undefined ? {} : { query }),
    order,
    toolsOnly: optBool(v, "toolsOnly", issues) ?? false,
  };
});

const nameInput = objectSchema<{ name: string }>((v, issues) => ({
  name: str(v, "name", issues, 200),
}));

export default defineDesktopExtension({
  name: "ollama",
  setup: (host) => {
    if (Deno.build.os === "windows") return;
    const dir = host.appSupportDir || undefined;
    service = new OllamaService({ runner: new PtyRunner(dir) });
  },
  methods: {
    /** Installed? version, server, models (with `show` facts), loaded models, harnesses. */
    status: {
      input: emptyInput,
      handler: (): Promise<OllamaStatus> => requireService().status(),
    },
    /** Search ollama.com (cached for a few hours). */
    library: {
      input: libraryInput,
      handler: (args: unknown): Promise<LibraryResult> => {
        const a = args as {
          query?: string;
          order: LibraryOrder;
          toolsOnly: boolean;
        };
        return requireService().library(a.query ?? "", a.order, a.toolsOnly);
      },
    },
    /** A model's library page: which harnesses it is listed for, its variants. */
    libraryModel: {
      input: nameInput,
      handler: (args: unknown): Promise<LibraryPageResult> =>
        requireService().libraryModel((args as { name: string }).name),
    },
    /** Open Ollama.app (macOS), the way to start its server. */
    openApp: {
      input: emptyInput,
      handler: (): Promise<boolean> => requireService().openApp(),
    },
  },
});
