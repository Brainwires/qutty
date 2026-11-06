/**
 * The `docker` command lines of the shared sandbox, kept pure so they are unit-testable: the
 * long-lived container (`docker run -d`), a tile's shell or agent in it (`docker exec -it`), the
 * keepalive that stops it with the app, and the small queries the lifecycle makes.
 *
 * Decision: a plain long-lived container, not Docker Desktop's sandboxes. `docker sandbox` is
 * removed from current Docker Desktop (4.98: "deprecated and has been removed", pointing at the
 * separate Docker Sandboxes product, which runs one agent per microVM rather than several shells
 * in one sandbox). A container gives every tile one filesystem, process space and set of tools,
 * works with any image, and works the same on native Linux Docker.
 *
 * The container:
 * - runs as root, `HOME=/root` on a named volume (`qutty-sandbox-home`), so tools installed in
 *   `$HOME` and agent logins survive restarts and image changes; `IS_SANDBOX=1` (Claude Code
 *   then allows `--dangerously-skip-permissions` as root);
 * - sees `~/.qutty` read-only at its host path (the shims, and the generated MCP / hook configs
 *   the hub's launch flags point at), the shims linked into `/usr/local/bin`;
 * - sees the project folder at its host path, read/write or read-only;
 * - optionally sees the host's `~/.claude` and `~/.codex` read-only under `/mnt/host`;
 * - has the default bridge network, or none (which also cuts it off from the hub);
 * - on native Linux, gets `host.docker.internal` mapped to the bridge gateway (`host-gateway`),
 *   which Docker Desktop provides by itself.
 *
 * @module
 */

import type { SandboxSettings } from "./settings.ts";

/** The volume every window's sandbox keeps `$HOME` (`/root`) on. */
const HOME_VOLUME = "qutty-sandbox-home";
/** The home folder inside the sandbox. */
const SANDBOX_HOME = "/root";
/** Where the opt-in host agent configs appear. */
export const HOST_CONFIG_DIR = "/mnt/host";
/** The label every sandbox container carries. */
const SANDBOX_LABEL = "org.qutty.sandbox";
/** The label holding the hash of the settings the container was created with. */
const CONFIG_LABEL = "org.qutty.config";
/**
 * `docker exec -it`'s detach sequence. The default (Ctrl-P Ctrl-Q) would delay every Ctrl-P
 * (the shell's history key); Docker cannot turn it off, so it is moved to a sequence nobody types.
 */
export const DETACH_KEYS = "ctrl-^,ctrl-^,ctrl-^";

/** The container name for a window: `qutty-sandbox-main`. */
export function containerName(windowId: string): string {
  const safe = windowId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48) ||
    "main";
  return `qutty-sandbox-${safe}`;
}

/** What the container is made from: the settings plus the facts of this machine. */
export interface SandboxSpec {
  name: string;
  image: string;
  volume: string;
  /** `~/.qutty` on the host (mounted read-only at the same path). */
  quttyDir: string;
  /** Project folder ("" for none). */
  project: string;
  projectWritable: boolean;
  network: boolean;
  /** Host agent config folders to mount read-only (`~/.claude`, `~/.codex`, the ones that exist). */
  hostConfigs: string[];
  /** Native Linux Docker (no Docker Desktop VM): map `host.docker.internal` itself. */
  linux: boolean;
}

/** The spec for a window's settings. */
export function sandboxSpec(
  settings: SandboxSettings,
  facts: {
    name: string;
    quttyDir: string;
    hostConfigs: string[];
    linux: boolean;
    volume?: string;
  },
): SandboxSpec {
  return {
    name: facts.name,
    image: settings.image,
    volume: facts.volume ?? HOME_VOLUME,
    quttyDir: facts.quttyDir,
    project: settings.project,
    projectWritable: settings.projectWritable,
    network: settings.network,
    hostConfigs: settings.hostAgentConfigs ? [...facts.hostConfigs] : [],
    linux: facts.linux,
  };
}

/** A short stable hash of what the container is created with (FNV-1a, hex). */
export function specHash(spec: SandboxSpec): string {
  const { name: _name, ...rest } = spec;
  const text = JSON.stringify(rest, Object.keys(rest).sort());
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The container's main process: link the shims onto `PATH`, then wait until stopped (`--init`
 * runs it under tini, so a TERM — `docker stop`, or the keepalive's `kill 1` — ends it at once).
 */
const ENTRY_SCRIPT =
  'mkdir -p /usr/local/bin; for f in "$1"/*; do ln -sf "$f" /usr/local/bin/ 2>/dev/null; done; ' +
  "trap 'exit 0' TERM; while :; do sleep 3600 & wait $!; done";

/** `docker run -d …`: create and start the window's container. */
export function runArgs(spec: SandboxSpec): string[] {
  const mount = (source: string, target: string, readonly: boolean) => [
    "--mount",
    `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
  ];
  return [
    "run",
    "-d",
    "--init",
    "--name",
    spec.name,
    "--hostname",
    "qutty-sandbox",
    "--label",
    `${SANDBOX_LABEL}=1`,
    "--label",
    `${CONFIG_LABEL}=${specHash(spec)}`,
    "--user",
    "0:0",
    "-e",
    `HOME=${SANDBOX_HOME}`,
    "-e",
    "IS_SANDBOX=1",
    "--mount",
    `type=volume,source=${spec.volume},target=${SANDBOX_HOME}`,
    ...mount(spec.quttyDir, spec.quttyDir, true),
    ...(spec.project
      ? mount(spec.project, spec.project, !spec.projectWritable)
      : []),
    ...spec.hostConfigs.flatMap((dir) =>
      mount(dir, `${HOST_CONFIG_DIR}/${baseName(dir)}`, true)
    ),
    ...(spec.network ? [] : ["--network", "none"]),
    ...(spec.linux && spec.network
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    "-w",
    spec.project || SANDBOX_HOME,
    spec.image,
    "sh",
    "-c",
    ENTRY_SCRIPT,
    "qutty-sandbox",
    `${spec.quttyDir}/bin`,
  ];
}

/** What a sandboxed tile runs. */
export interface SandboxExec {
  /** The picked shell's path on the host (its name is run in the container), if not the default. */
  shell?: string;
  /** An agent tool (its command name is run in the container) and its arguments. */
  agent?: { name: string; args: string[] };
}

/** The default shell inside: bash when the image has it, else sh; a login shell either way. */
const AUTO_SHELL = [
  "sh",
  "-c",
  "if command -v bash >/dev/null 2>&1; then exec bash -l; fi; exec sh -l",
];

/** The container-side command of a sandboxed tile. */
export function sandboxCommand(run: SandboxExec): string[] {
  if (run.agent) return [run.agent.name, ...run.agent.args];
  if (run.shell) return [baseName(run.shell), "-l"];
  return [...AUTO_SHELL];
}

/**
 * Where a sandboxed tile starts: the requested folder when it is inside the mounted project,
 * else the project folder, else the sandbox home.
 */
export function sandboxWorkdir(
  project: string,
  cwd: string | undefined,
): string {
  if (!project) return SANDBOX_HOME;
  if (cwd && (cwd === project || cwd.startsWith(`${project}/`))) return cwd;
  return project;
}

/**
 * `docker exec -it …` for a tile. `envNames` are passed by name (`-e NAME`): docker copies their
 * values from its own environment, so the hub token never appears on a command line.
 */
export function execArgs(
  name: string,
  opts: { workdir: string; envNames: readonly string[]; command: string[] },
): string[] {
  const names = ["TERM", "COLORTERM", "TERM_PROGRAM", ...opts.envNames];
  return [
    "exec",
    "-it",
    "--detach-keys",
    DETACH_KEYS,
    "-w",
    opts.workdir,
    ...[...new Set(names)].flatMap((n) => ["-e", n]),
    "-e",
    "LANG=C.UTF-8",
    "-e",
    "QUTTY_SANDBOX=1",
    name,
    ...opts.command,
  ];
}

/**
 * The keepalive, run as `docker exec -i <ctr> sh -c …` in a hidden PTY of the app: when the app
 * exits (or crashes) the PTY closes, docker's stdin ends and the container is stopped. Works
 * with the network off, too. A `keep` line (Settings → keep running) ends it without stopping.
 */
const KEEPALIVE_SCRIPT =
  'while read -r l; do [ "$l" = keep ] && exit 0; done; kill -TERM 1';

export function keepaliveArgs(name: string): string[] {
  return ["exec", "-i", name, "sh", "-c", KEEPALIVE_SCRIPT];
}

/** `docker inspect` of the container: `running|config-hash|startedAt|image`. */
export function inspectArgs(name: string): string[] {
  return [
    "inspect",
    "--type",
    "container",
    "--format",
    `{{.State.Running}}|{{index .Config.Labels "${CONFIG_LABEL}"}}|{{.State.StartedAt}}|{{.Config.Image}}`,
    name,
  ];
}

/** What {@linkcode inspectArgs} printed. */
export interface ContainerState {
  running: boolean;
  config: string;
  startedAt: string;
  image: string;
}

export function parseInspect(out: string): ContainerState | undefined {
  const line = out.split("\n").map((l) => l.trim()).find((l) =>
    /^(true|false)\|/.test(l)
  );
  if (!line) return undefined;
  const [running, config = "", startedAt = "", image = ""] = line.split("|");
  return { running: running === "true", config, startedAt, image };
}

/** `docker version`: the server's version (fails when the daemon is not running). */
export const VERSION_ARGS = [
  "version",
  "--format",
  "{{.Server.Version}}",
];

/** The default bridge's gateway addresses (native Linux: where `host-gateway` points). */
export const BRIDGE_ARGS = [
  "network",
  "inspect",
  "bridge",
  "--format",
  "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
];

/** The IPv4 gateways {@linkcode BRIDGE_ARGS} printed. */
export function parseGateways(out: string): string[] {
  return out.split(/\s+/).filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}
