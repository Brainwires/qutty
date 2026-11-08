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
 * - on native Linux (when the app is not run as root), runs its tiles as the host user instead
 *   (`docker exec -u <uid>:<gid>`), so files they create in a read/write project mount are the
 *   user's on the host, not root's. Its main process stays root: {@linkcode userSetupArgs} adds
 *   the user to `/etc/passwd` (tools that look the user up need an entry) and hands it the home
 *   volume, mounted at `/home/qutty`. Docker Desktop maps a bind mount's ownership to the user
 *   by itself, so macOS keeps root;
 * - sees `~/.qutty` read-only at its host path (the shims, and the generated MCP / hook configs
 *   the hub's launch flags point at), the shims linked into `/usr/local/bin`;
 * - sees the project folder at its host path, read/write or read-only;
 * - optionally sees the host's `~/.claude` and `~/.codex` read-only under `/mnt/host`;
 * - has the default bridge network, or none. With the network off, Docker Desktop's container
 *   can no longer reach the hub (`host.docker.internal` is not served without a network, nor on
 *   an `--internal` one). Native Linux keeps it: the container joins an `--internal` network of
 *   its own ({@linkcode HUB_NETWORK}: no route out, but its gateway is the host), and the hub
 *   also listens on that gateway;
 * - on native Linux, gets `host.docker.internal` mapped to the bridge gateway (`host-gateway`),
 *   or to the internal network's gateway with the network off; Docker Desktop provides the name
 *   by itself.
 *
 * @module
 */

import type { SandboxSettings } from "./settings.ts";

/** The volume every window's sandbox keeps `$HOME` (`/root`) on. */
const HOME_VOLUME = "qutty-sandbox-home";
/** The home folder inside the sandbox (root's). */
const SANDBOX_HOME = "/root";
/** The home folder when the tiles run as the host user (native Linux). */
const USER_HOME = "/home/qutty";
/**
 * The `--internal` network a native Linux sandbox with the network off joins: nothing leaves it,
 * but its gateway is an address of the host, where the hub listens.
 */
export const HUB_NETWORK = "qutty-sandbox-hub";
/** Where the opt-in host agent configs appear. */
export const HOST_CONFIG_DIR = "/mnt/host";
/** The label every sandbox container carries. */
const SANDBOX_LABEL = "org.qutty.sandbox";
/** The label holding the hash of the settings the container was created with. */
const CONFIG_LABEL = "org.qutty.config";
/** The label holding the `uid:gid` the tiles of the container run as (absent: root). */
const USER_LABEL = "org.qutty.user";
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
  /** The host user the tiles run as (native Linux, not root); root when absent. */
  user?: HostUser;
}

/** A host user's ids. */
export interface HostUser {
  uid: number;
  gid: number;
}

/** The home folder inside a container whose tiles run as `user` (`uid:gid`; root when absent). */
export function sandboxHome(user: string | undefined): string {
  return user ? USER_HOME : SANDBOX_HOME;
}

/** `uid:gid` for `docker exec -u`, or `undefined` for root. */
export function execUser(spec: SandboxSpec): string | undefined {
  return spec.user ? `${spec.user.uid}:${spec.user.gid}` : undefined;
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
    /** The app's user (`getuid`/`getgid`); used on native Linux only, and not for root. */
    user?: HostUser;
  },
): SandboxSpec {
  const user = facts.linux && facts.user && facts.user.uid !== 0
    ? { uid: facts.user.uid, gid: facts.user.gid }
    : undefined;
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
    ...(user ? { user } : {}),
  };
}

/** A short stable hash of what the container is created with (FNV-1a, hex). */
export function specHash(spec: SandboxSpec): string {
  const { name: _name, ...rest } = spec;
  // Top-level keys sorted; nested values (the user's ids) kept whole. Without a user this is the
  // text earlier versions hashed, so their containers are not recreated.
  const text = JSON.stringify(
    Object.fromEntries(
      Object.entries(rest).sort(([a], [b]) => a < b ? -1 : 1),
    ),
  );
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

/**
 * How the container is networked: the default bridge, or none; on native Linux, the bridge with
 * `host.docker.internal` mapped to its gateway, or (network off) {@linkcode HUB_NETWORK} with the
 * name mapped to that network's gateway (`hubGateway`), so the hub stays reachable. Without a
 * known gateway, network off is `none`.
 */
function networkArgs(spec: SandboxSpec, hubGateway?: string): string[] {
  if (spec.network) {
    return spec.linux
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : [];
  }
  if (spec.linux && hubGateway) {
    return [
      "--network",
      HUB_NETWORK,
      "--add-host",
      `host.docker.internal:${hubGateway}`,
    ];
  }
  return ["--network", "none"];
}

/**
 * `docker run -d …`: create and start the window's container. `hubGateway`: the gateway of
 * {@linkcode HUB_NETWORK} (native Linux, network off).
 */
export function runArgs(
  spec: SandboxSpec,
  opts: { hubGateway?: string } = {},
): string[] {
  const user = execUser(spec);
  const home = sandboxHome(user);
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
    ...(user ? ["--label", `${USER_LABEL}=${user}`] : []),
    "--user",
    "0:0",
    "-e",
    `HOME=${home}`,
    "-e",
    "IS_SANDBOX=1",
    "--mount",
    `type=volume,source=${spec.volume},target=${home}`,
    ...mount(spec.quttyDir, spec.quttyDir, true),
    ...(spec.project
      ? mount(spec.project, spec.project, !spec.projectWritable)
      : []),
    ...spec.hostConfigs.flatMap((dir) =>
      mount(dir, `${HOST_CONFIG_DIR}/${baseName(dir)}`, true)
    ),
    ...networkArgs(spec, opts.hubGateway),
    "-w",
    spec.project || home,
    spec.image,
    "sh",
    "-c",
    ENTRY_SCRIPT,
    "qutty-sandbox",
    `${spec.quttyDir}/bin`,
  ];
}

/**
 * Make the host user known inside (native Linux), run as root after every start: a group and a
 * `passwd` entry for the ids unless the image has them (its own user keeps its name; `HOME` is
 * set for the container either way), and the home volume handed to the user (all of it, once:
 * after a switch from root, or a new volume). Idempotent.
 */
const USER_SETUP_SCRIPT = 'u="$1"; g="$2"; h="$3"; ' +
  'grep -q "^[^:]*:[^:]*:$g:" /etc/group || echo "qutty:x:$g:" >> /etc/group; ' +
  'grep -q "^[^:]*:[^:]*:$u:" /etc/passwd || ' +
  'echo "qutty:x:$u:$g:Qutty:$h:/bin/sh" >> /etc/passwd; ' +
  'mkdir -p "$h"; [ "$(stat -c %u:%g "$h")" = "$u:$g" ] || chown -R "$u:$g" "$h"';

/** `docker exec` (as root) of the user setup in container `name` for `user` (`uid:gid`). */
export function userSetupArgs(name: string, user: string): string[] {
  const [uid, gid = uid] = user.split(":");
  return [
    "exec",
    "-u",
    "0:0",
    name,
    "sh",
    "-c",
    USER_SETUP_SCRIPT,
    "qutty-setup",
    uid,
    gid,
    USER_HOME,
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
 * else the project folder, else the sandbox home (`home`, default root's).
 */
export function sandboxWorkdir(
  project: string,
  cwd: string | undefined,
  home = SANDBOX_HOME,
): string {
  if (!project) return home;
  if (cwd && (cwd === project || cwd.startsWith(`${project}/`))) return cwd;
  return project;
}

/**
 * `docker exec -it …` for a tile. `envNames` are passed by name (`-e NAME`): docker copies their
 * values from its own environment, so the hub token never appears on a command line. `user`:
 * `uid:gid` to run as (native Linux), else the container's root.
 */
export function execArgs(
  name: string,
  opts: {
    workdir: string;
    envNames: readonly string[];
    command: string[];
    user?: string;
  },
): string[] {
  const names = ["TERM", "COLORTERM", "TERM_PROGRAM", ...opts.envNames];
  return [
    "exec",
    "-it",
    "--detach-keys",
    DETACH_KEYS,
    ...(opts.user ? ["-u", opts.user] : []),
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

/** `docker inspect` of the container: `running|config-hash|startedAt|image|user`. */
export function inspectArgs(name: string): string[] {
  return [
    "inspect",
    "--type",
    "container",
    "--format",
    `{{.State.Running}}|{{index .Config.Labels "${CONFIG_LABEL}"}}|{{.State.StartedAt}}|{{.Config.Image}}|{{index .Config.Labels "${USER_LABEL}"}}`,
    name,
  ];
}

/** What {@linkcode inspectArgs} printed. */
export interface ContainerState {
  running: boolean;
  config: string;
  startedAt: string;
  image: string;
  /** The `uid:gid` its tiles run as, as it was created ("" for root). */
  user: string;
}

export function parseInspect(out: string): ContainerState | undefined {
  const line = out.split("\n").map((l) => l.trim()).find((l) =>
    /^(true|false)\|/.test(l)
  );
  if (!line) return undefined;
  const [running, config = "", startedAt = "", image = "", label = ""] = line
    .split("|");
  // A container made before the label existed prints Go's `<no value>`.
  const user = /^\d+:\d+$/.test(label) ? label : "";
  return { running: running === "true", config, startedAt, image, user };
}

/** `docker version`: the server's version (fails when the daemon is not running). */
export const VERSION_ARGS = [
  "version",
  "--format",
  "{{.Server.Version}}",
];

/** A network's gateway addresses. */
export function gatewayArgs(network: string): string[] {
  return [
    "network",
    "inspect",
    network,
    "--format",
    "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
  ];
}

/** The default bridge's gateway addresses (native Linux: where `host-gateway` points). */
export const BRIDGE_ARGS = gatewayArgs("bridge");

/** `docker network create` of {@linkcode HUB_NETWORK}: internal (no route out), labelled. */
export const HUB_NETWORK_CREATE_ARGS = [
  "network",
  "create",
  "--internal",
  "--label",
  `${SANDBOX_LABEL}=1`,
  HUB_NETWORK,
];

/** The IPv4 gateways {@linkcode BRIDGE_ARGS} printed. */
export function parseGateways(out: string): string[] {
  return out.split(/\s+/).filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}
