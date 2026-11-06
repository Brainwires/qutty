// The shared Docker sandbox: a desktop extension (`sandbox`) beside `pty`, `ssh` and `hub`. One
// long-lived container per window that every sandboxed tile `docker exec`s into, so agents share
// one filesystem, process space and set of tools without touching the Mac. The rules (command
// lines, lifecycle) live in lib/sandbox/; this file runs docker and wires the PTY host:
//
// - Every `docker` command runs through node-pty in a hidden PTY of this module (the pattern
//   desktop/ssh.ts uses for scp): the packaged app has no `--allow-run`. A sandboxed tile is a
//   program spawn of `docker exec -it …` through the PTY extension (desktop/pty.ts asks this
//   module's `SandboxProvider` for the argv), so no permission is added.
// - The container starts on the first sandboxed tile (or `ensure`, which the page calls first so
//   a long image pull is not cut short by the 30 s method timeout), and stops with the app: a
//   keepalive `docker exec -i` in a hidden PTY ends when the app exits or crashes, and its
//   container side then stops the container. "Keep running" releases it.
// - Agents inside reach the hub over TCP + token (desktop/hub.ts `tcpEndpoint`).
// - Denext 4.12 has no window-closed hook: a second window's container stops when the app quits.
//
// Nothing here may throw into the app's startup: without Docker the sandbox is `unavailable`
// and Settings says why.

import { defineDesktopExtension } from "denext/desktop";
import { emptyInput, objectSchema } from "./schema.ts";
import {
  PtyHost,
  resolveProgram,
  type SandboxCommand,
  type SandboxRequest,
  setSandboxProvider,
} from "./pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "./pty.ts";
import {
  containerName,
  execArgs,
  sandboxCommand,
  sandboxWorkdir,
} from "../lib/sandbox/docker.ts";
import {
  type DockerCli,
  type KeepaliveHandle,
  SandboxController,
  type SandboxFacts,
  type SandboxStatus,
} from "../lib/sandbox/lifecycle.ts";
import {
  type SandboxSettings,
  sanitizeSandbox,
} from "../lib/sandbox/settings.ts";
import { hubPaths } from "../lib/hub/launch.ts";

export type { SandboxStatus };

// ---------------------------------------------------------------------------------------------
// docker, through hidden PTYs
// ---------------------------------------------------------------------------------------------

/** Where docker lives when a Finder-launched app's `PATH` does not have it. */
function dockerCandidates(home: string | undefined): string[] {
  return [
    "docker",
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    ...(home ? [`${home}/.docker/bin/docker`] : []),
    "/usr/bin/docker",
  ];
}

/** The docker executable, or `undefined` when it is not installed. */
export async function findDocker(
  home = Deno.env.get("HOME"),
): Promise<string | undefined> {
  for (const c of dockerCandidates(home)) {
    const path = await resolveProgram(c);
    if (path) return path;
  }
  return undefined;
}

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

interface Run {
  out: string;
  exit?: PtyExitEvent;
  done: (exit: PtyExitEvent) => void;
}

/** {@linkcode DockerCli} over node-pty: one hidden PTY per command. */
export class PtyDockerCli implements DockerCli {
  #host: PtyHost;
  #runs = new Map<string, Run>();
  #early = new Map<string, { out: string; exit?: PtyExitEvent }>();
  #docker: Promise<string | undefined> | undefined;
  #appSupportDir: string | undefined;
  #find: () => Promise<string | undefined>;

  constructor(
    opts: {
      appSupportDir?: string;
      find?: () => Promise<string | undefined>;
    } = {},
  ) {
    this.#appSupportDir = opts.appSupportDir;
    this.#find = opts.find ?? (() => findDocker());
    this.#host = new PtyHost((event, data) => {
      const id = (data as { id: string }).id;
      const run = this.#runs.get(id);
      const early = run ?? this.#early.get(id) ??
        (this.#early.set(id, { out: "" }).get(id)!);
      if (event === "data") early.out += (data as PtyDataEvent).data;
      else {
        early.exit = data as PtyExitEvent;
        run?.done(early.exit);
      }
    });
  }

  /** The docker path (looked up once; again after a miss, in case it was installed since). */
  async #path(): Promise<string> {
    const found = await (this.#docker ??= this.#find());
    if (!found) {
      this.#docker = undefined;
      throw new Error("no docker on PATH or in the usual places");
    }
    return found;
  }

  async #spawn(args: string[]): Promise<string> {
    const program = await this.#path();
    const { id } = await this.#host.spawn(
      { cols: 400, rows: 50, program, args, cwd: "/" },
      { owner: "sandbox", appSupportDir: this.#appSupportDir },
    );
    return id;
  }

  async run(
    args: string[],
    opts: { timeoutMs?: number } = {},
  ): Promise<{ code: number; out: string }> {
    const id = await this.#spawn(args);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await new Promise<PtyExitEvent>((resolve) => {
      const early = this.#early.get(id);
      this.#early.delete(id);
      const run: Run = { out: early?.out ?? "", done: resolve };
      this.#runs.set(id, run);
      if (early?.exit) resolve(early.exit);
      timer = setTimeout(() => {
        this.#host.kill(id);
        resolve({ id, exitCode: 124, signal: null });
      }, opts.timeoutMs ?? 60_000);
    });
    clearTimeout(timer);
    const out = (this.#runs.get(id)?.out ?? "").replace(ANSI, "");
    this.#runs.delete(id);
    return { code: exit.signal ? 128 + exit.signal : exit.exitCode, out };
  }

  keepalive(args: string[]): KeepaliveHandle {
    let release = () => {};
    const done = (async () => {
      const id = await this.#spawn(args);
      release = () => void this.#host.write(id, "keep\n").catch(() => {});
      await new Promise<void>((resolve) => {
        const early = this.#early.get(id);
        this.#early.delete(id);
        this.#runs.set(id, { out: "", done: () => resolve() });
        if (early?.exit) resolve();
      });
      this.#runs.delete(id);
    })().catch((e) => console.error("sandbox: keepalive failed", e));
    return { release: () => release(), done };
  }
}

// ---------------------------------------------------------------------------------------------
// The windows' sandboxes
// ---------------------------------------------------------------------------------------------

/** One controller per window, and the {@linkcode SandboxProvider} the PTY host asks. */
export class SandboxService {
  #docker: DockerCli;
  #facts: SandboxFacts;
  #byWindow = new Map<string, SandboxController>();
  #dockerPath: () => Promise<string | undefined>;
  #names: (windowId: string) => string;

  constructor(opts: {
    docker: DockerCli;
    facts: SandboxFacts;
    dockerPath?: () => Promise<string | undefined>;
    /** The container name for a window (tests use their own). */
    names?: (windowId: string) => string;
  }) {
    this.#docker = opts.docker;
    this.#facts = opts.facts;
    this.#dockerPath = opts.dockerPath ?? (() => findDocker());
    this.#names = opts.names ?? containerName;
  }

  controller(windowId: string): SandboxController {
    let c = this.#byWindow.get(windowId);
    if (!c) {
      c = new SandboxController({
        docker: this.#docker,
        name: this.#names(windowId),
        facts: this.#facts,
      });
      this.#byWindow.set(windowId, c);
    }
    return c;
  }

  /** A sandboxed terminal's command: the window's container is started first if needed. */
  async prepare(req: SandboxRequest): Promise<SandboxCommand> {
    const ctl = this.controller(req.owner);
    const ready = await ctl.ensure();
    const file = await this.#dockerPath();
    if (!file) throw new Error("docker is not installed");
    const workdir = sandboxWorkdir(ready.project, req.cwd);
    return {
      file,
      cwd: workdir,
      alsoOn: ready.bridge,
      argv: (envNames, hubArgs) =>
        execArgs(ready.container, {
          workdir,
          envNames,
          command: sandboxCommand({
            ...(req.shell ? { shell: req.shell } : {}),
            ...(req.agent
              ? {
                agent: {
                  name: req.agent.name,
                  args: [...hubArgs, ...req.agent.args],
                },
              }
              : {}),
          }),
        }),
    };
  }
}

/** The host agent config folders that exist (for the opt-in read-only mount). */
async function hostConfigDirs(home: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of [`${home}/.claude`, `${home}/.codex`]) {
    if ((await Deno.stat(d).catch(() => undefined))?.isDirectory) out.push(d);
  }
  return out;
}

let service: SandboxService | undefined;

function requireService(): SandboxService {
  if (!service) throw new Error("the sandbox is not available");
  return service;
}

const configureInput = objectSchema<{ settings: SandboxSettings }>((v) => ({
  settings: sanitizeSandbox(v.settings),
}));

const windowOf = (ctx: { windowId?: string }) => ctx.windowId ?? "main";

export default defineDesktopExtension({
  name: "sandbox",
  setup: (host) => {
    const home = Deno.env.get("HOME");
    if (!home || Deno.build.os === "windows") return;
    void hostConfigDirs(home).then((hostConfigs) => {
      service = new SandboxService({
        docker: new PtyDockerCli({ appSupportDir: host.appSupportDir }),
        facts: {
          quttyDir: hubPaths(home).dir,
          hostConfigs,
          linux: Deno.build.os === "linux",
        },
      });
      setSandboxProvider(service);
    }).catch((e) => console.error("sandbox: not started", e));
  },
  methods: {
    /** The window's sandbox status (Settings → Sandbox polls it while shown). */
    status: {
      input: emptyInput,
      handler: (_args: unknown, ctx): SandboxStatus =>
        requireService().controller(windowOf(ctx)).status(),
    },
    /** The page's settings for its window (sent on load and on every change). */
    configure: {
      input: configureInput,
      handler: (args: unknown, ctx): SandboxStatus =>
        requireService().controller(windowOf(ctx)).configure(
          (args as { settings: SandboxSettings }).settings,
        ),
    },
    /** Docker installed and running? (Settings asks when shown.) */
    check: {
      input: emptyInput,
      handler: async (_args: unknown, ctx): Promise<SandboxStatus> => {
        const c = requireService().controller(windowOf(ctx));
        await c.check();
        return c.status();
      },
    },
    /** Start the window's container (a first pull can take minutes: no timeout). */
    ensure: {
      input: emptyInput,
      timeoutMs: false,
      handler: async (_args: unknown, ctx): Promise<SandboxStatus> => {
        const c = requireService().controller(windowOf(ctx));
        await c.ensure();
        return c.status();
      },
    },
    restart: {
      input: emptyInput,
      timeoutMs: false,
      handler: (_args: unknown, ctx): Promise<SandboxStatus> =>
        requireService().controller(windowOf(ctx)).restart(),
    },
    stop: {
      input: emptyInput,
      timeoutMs: 120_000,
      handler: (_args: unknown, ctx): Promise<SandboxStatus> =>
        requireService().controller(windowOf(ctx)).stop(),
    },
    resetVolume: {
      input: emptyInput,
      timeoutMs: 120_000,
      handler: (_args: unknown, ctx): Promise<SandboxStatus> =>
        requireService().controller(windowOf(ctx)).resetVolume(),
    },
  },
});
