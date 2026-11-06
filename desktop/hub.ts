// The agent hub: a desktop extension (`hub`) beside `pty` and `ssh`. Every terminal gets its own
// unix socket and an MCP server behind it, so any agent in any tile can list its peers, read
// other tiles' screens, message other agents and ask the user — with no tokens: the socket a
// client connects through says which tile it is. See lib/hub/ for the logic and
// docs in TODO.md / the plan for the phases.
//
// - Sockets: `/tmp/qutty-<uid>/<pid>/<ptyId>.sock` (folders 0700, sockets 0600). Short on
//   purpose: `sun_path` holds 104 bytes on macOS, and `$TMPDIR` there is already ~50. One folder
//   per app process, so a dev build and the installed app never collide; folders of dead
//   processes are removed at start. Bound through libc (desktop/hub-socket.ts explains why).
// - Each terminal's environment (desktop/pty.ts `PtyTaps`): `QUTTY_SOCK`, `QUTTY_TILE_ID`, and
//   `~/.qutty/bin` first on `PATH`, where `qutty-mcp` and `qutty-hook` are installed (refreshed at
//   every start). An agent started from the `+` picker also gets the flags that load the hub's
//   MCP server and hooks (lib/hub/launch.ts).
// - Each connection's first line decides what it is: `{"qutty":"hook",…}` is one hook call
//   (answered with one line, then closed); anything else is MCP, served by @rullama/mcp-server
//   (`StreamServerTransport` over the libc socket, the line routed by `serveConnection`'s
//   `firstLine` hook).
// - Sandboxed tiles (the shared Docker sandbox, desktop/sandbox.ts) cannot reach a host unix
//   socket, so they get `QUTTY_HUB=host.docker.internal:<port>` and a per-tile
//   `QUTTY_TILE_TOKEN`: one TCP listener on 127.0.0.1 (plus the bridge gateway on native Linux),
//   a connection admitted only when its first line is a live token (`StreamServerListener`'s
//   pre-auth), which then names the tile; the next line is routed as above.
// - The screen mirror: a headless xterm per terminal, fed the PTY's output (lib/hub/mirror.ts).
// - The page: `snapshot` + the `tiles` event (badges), `ask` / `askClosed` (ask_user), `answer`,
//   `control` (companion commands, answered with `controlDone`), and the Agent integration
//   panel's methods.
// - The companion (desktop/companion.ts): its own socket and privileged identity, the brain
//   runtime (`companion` events, `companionSend` / `companionConfigure` / `companionStatus`), the
//   audit log, and `qutty-hook say …` lines (`say` events, answered with `companionSayDone`).
//
// The hub is optional: if it cannot start, it logs why and the terminals work as before. Nothing
// here may throw into the app's startup or a terminal's spawn.

import {
  defineDesktopExtension,
  type DesktopExtensionHost,
} from "denext/desktop";
import {
  type FirstLineDecision,
  McpServer,
  StreamServerListener,
  StreamServerTransport,
} from "@rullama/mcp-server";
import { emptyInput, objectSchema, str } from "./schema.ts";
import {
  ensureDir,
  setPtyTaps,
  writeFileAtomic,
  writeTerminal,
} from "./pty.ts";
import {
  ConnectionQueue,
  FdConnection,
  FdReactor,
  FdTcpListener,
  FdUnixListener,
  getuid,
  makeDir,
  processAlive,
  removeDir,
  unlinkPath,
} from "./hub-socket.ts";
import { HubCore } from "../lib/hub/core.ts";
import { CompanionHost, removeCompanionDir } from "./companion.ts";
import type { BrainAdapter } from "../lib/companion/brain.ts";
import type { AuditEntry, CompanionStatus } from "../lib/companion/protocol.ts";
import { ScreenMirror } from "../lib/hub/mirror.ts";
import { buildToolRegistry, createHubHandler } from "../lib/hub/tools.ts";
import {
  claudeHooksSettings,
  claudeMcpConfig,
  hubArgsFor,
  type HubPaths,
  hubPaths,
} from "../lib/hub/launch.ts";
import {
  type ConfigFs,
  installIntegration,
  type IntegrationFiles,
  integrationFiles,
  integrationStatus,
  uninstallIntegration,
} from "../lib/hub/integration.ts";
import { QUTTY_HOOK_SCRIPT, QUTTY_MCP_SCRIPT } from "../lib/hub/scripts.ts";
import type {
  AskRequest,
  HubIdentity,
  HubSnapshot,
  IntegrationStatus,
  IntegrationTarget,
} from "../lib/hub/protocol.ts";

export type { AskRequest, HubSnapshot, IntegrationStatus, IntegrationTarget };

const encoder = new TextEncoder();

/** How long a hook connection may take to send its line. */
const HOOK_LINE_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// Files: ~/.qutty and the socket folder
// ---------------------------------------------------------------------------------------------

async function readText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return undefined;
  }
}

/** Write `text` to `path` with `mode` unless it already holds exactly that. */
async function writeIfChanged(
  path: string,
  text: string,
  mode: number,
): Promise<void> {
  if (await readText(path) === text) {
    const st = await Deno.stat(path).catch(() => undefined);
    if (st && ((st.mode ?? 0) & 0o777) === mode) return;
  }
  writeFileAtomic(path, encoder.encode(text), mode);
}

/** Install the shims and the generated Claude Code files into `~/.qutty` (atomic, 0755). */
export async function installHubFiles(paths: HubPaths): Promise<void> {
  ensureDir(paths.dir, 0o755);
  ensureDir(paths.bin, 0o755);
  await writeIfChanged(paths.mcp, QUTTY_MCP_SCRIPT, 0o755);
  await writeIfChanged(paths.hook, QUTTY_HOOK_SCRIPT, 0o755);
  await writeIfChanged(paths.claudeMcpConfig, claudeMcpConfig(paths), 0o644);
  await writeIfChanged(paths.claudeHooks, claudeHooksSettings(paths), 0o644);
}

/**
 * Create (or check) the per-user socket folder `<base>/qutty-<uid>` (0700, owned by us, not a
 * link: `/tmp` is shared), remove the folders of dead processes, and create this process's own.
 * Returns the process folder.
 */
export async function prepareSocketDir(base = "/tmp"): Promise<string> {
  const uid = getuid();
  const userDir = `${base}/qutty-${uid}`;
  makeDir(userDir, 0o700);
  const st = await Deno.lstat(userDir);
  if (
    !st.isDirectory || st.isSymlink || st.uid !== uid ||
    ((st.mode ?? 0) & 0o077) !== 0
  ) {
    throw new Error(
      `${userDir} is not a private folder of this user; not using it`,
    );
  }
  for await (const entry of Deno.readDir(userDir)) {
    const pid = Number(entry.name);
    if (!entry.isDirectory || !/^\d+$/.test(entry.name) || pid === Deno.pid) {
      continue;
    }
    if (processAlive(pid)) continue;
    const dead = `${userDir}/${entry.name}`;
    for await (const f of Deno.readDir(dead)) {
      if (f.isDirectory) await removeCompanionDir(`${dead}/${f.name}`);
      else unlinkPath(`${dead}/${f.name}`);
    }
    removeDir(dead);
  }
  const own = `${userDir}/${Deno.pid}`;
  makeDir(own, 0o700);
  return own;
}

/** {@linkcode ConfigFs} over the libc writers (the app has no --allow-write). */
const desktopFs: ConfigFs = {
  read: readText,
  write(path, text, mode) {
    ensureDir(path.slice(0, path.lastIndexOf("/")), 0o700);
    writeFileAtomic(path, encoder.encode(text), mode);
    return Promise.resolve();
  },
  remove(path) {
    unlinkPath(path);
    return Promise.resolve();
  },
  async mode(path) {
    const st = await Deno.stat(path).catch(() => undefined);
    return st ? (st.mode ?? 0o600) & 0o777 : undefined;
  },
  async realPath(path) {
    return await Deno.realPath(path).catch(() => path);
  },
};

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

/** Where the hub's events go (the extension host's `emit`, or a test's recorder). */
export type HubEmit = (event: HubEvent, data: unknown) => void;
export type HubEvent =
  | "tiles"
  | "ask"
  | "askClosed"
  | "control"
  | "companion"
  | "say";

export interface HubServiceOptions {
  home: string;
  /** The per-process socket folder ({@linkcode prepareSocketDir}). */
  socketDir: string;
  emit: HubEmit;
  /** Type into a terminal (default: the PTY extension's host). */
  write?: (id: string, text: string) => Promise<void>;
  /** File access for the integration installer (default: libc writes). */
  fs?: ConfigFs;
  /** Where the companion's audit log goes (none: kept in memory only). */
  appSupportDir?: string;
  /** Another companion brain (tests). Default: Claude Code. */
  createBrain?: (cfg: { mcpConfig: string; model?: string }) => BrainAdapter;
}

/** The hub: sockets, MCP sessions, mirrors and the {@linkcode HubCore}. */
export class HubService {
  readonly core: HubCore;
  readonly paths: HubPaths;
  readonly files: IntegrationFiles;
  readonly socketDir: string;
  readonly companion: CompanionHost;
  #emit: HubEmit;
  #fs: ConfigFs;
  #reactor = new FdReactor();
  #server: McpServer;
  #listeners = new Map<string, FdUnixListener>();
  #conns = new Map<string, Set<FdConnection>>();
  #mirrors = new Map<string, ScreenMirror>();
  #installed: { claude?: boolean; codex?: boolean } = {};
  #companionListener: FdUnixListener | undefined;
  #tilesQueued = false;
  /** The TCP endpoint's listeners (127.0.0.1 first) and their accepted connections. */
  #tcp: FdTcpListener[] = [];
  #tcpQueue: ConnectionQueue | undefined;
  /** Sandboxed tiles' tokens → tile ids. */
  #tokens = new Map<string, string>();

  constructor(opts: HubServiceOptions) {
    this.paths = hubPaths(opts.home);
    this.files = integrationFiles(opts.home, this.paths);
    this.socketDir = opts.socketDir;
    this.#emit = opts.emit;
    this.#fs = opts.fs ?? desktopFs;
    const write = opts.write ?? writeTerminal;
    this.core = new HubCore({
      mirror: (id) => this.#mirrors.get(id),
      write,
      ask: (request) => this.#emit("ask", request),
      askClosed: (id) => this.#emit("askClosed", { id }),
      control: (command) => this.companion.control(command),
      changed: () => this.#queueTiles(),
      companionMail: () => this.companion.runtime.mailArrived(),
    });
    this.companion = new CompanionHost({
      core: this.core,
      socketDir: this.socketDir,
      mcpShim: this.paths.mcp,
      quttyDir: this.paths.dir,
      ...(opts.appSupportDir ? { appSupportDir: opts.appSupportDir } : {}),
      ...(opts.createBrain ? { createBrain: opts.createBrain } : {}),
      emit: (event, data) => this.#emit(event, data),
      listen: (path) => {
        this.#companionListener = FdUnixListener.listen(
          path,
          this.#reactor,
          (conn) => void this.#serve(conn, { role: "companion" }),
        );
      },
    });
    const tools = buildToolRegistry(this.core);
    this.#server = new McpServer(
      createHubHandler(this.core, tools, {
        audit: (call) => this.companion.record(call),
      }),
    );
    void this.refreshIntegration();
  }

  setEmit(emit: HubEmit): void {
    this.#emit = emit;
  }

  snapshot(): HubSnapshot & { asks: AskRequest[] } {
    return { ...this.core.snapshot(), asks: this.core.openAsks() };
  }

  /** The registry changed: one `tiles` event per tick. */
  #queueTiles(): void {
    if (this.#tilesQueued) return;
    this.#tilesQueued = true;
    queueMicrotask(() => {
      this.#tilesQueued = false;
      this.#emit("tiles", this.core.snapshot());
    });
  }

  /** The socket path of terminal `id`. */
  socketPath(id: string): string {
    return `${this.socketDir}/${id}.sock`;
  }

  // --- PTY taps ------------------------------------------------------------------------------

  /** A terminal is about to start: its socket, mirror, registry entry and environment. */
  spawning(
    id: string,
    info: {
      program?: string;
      agent?: string;
      cwd: string;
      cols: number;
      rows: number;
      /** Runs in the shared Docker sandbox: reached over TCP + token, not a unix socket. */
      sandbox?: { alsoOn: readonly string[] };
    },
  ): { env: Record<string, string>; pathPrepend?: string; args: string[] } {
    if (info.sandbox) return this.#spawningSandboxed(id, info, info.sandbox);
    const path = this.socketPath(id);
    const identity: HubIdentity = { role: "tile", tileId: id };
    const listener = FdUnixListener.listen(path, this.#reactor, (conn) => {
      void this.#serve(conn, identity);
    });
    this.#listeners.set(id, listener);
    this.#mirrors.set(id, new ScreenMirror(info.cols, info.rows));
    this.core.addTile({
      id,
      cwd: info.cwd,
      ...(info.agent ? { harness: info.agent } : {}),
    });
    return {
      env: { QUTTY_SOCK: path, QUTTY_TILE_ID: id },
      pathPrepend: this.paths.bin,
      args: info.program !== undefined
        ? hubArgsFor(info.agent, this.paths, this.#installed)
        : [],
    };
  }

  /**
   * A sandboxed terminal: a token instead of a socket. Its environment goes into the container
   * (`docker exec -e …`): `QUTTY_HUB` (`host.docker.internal:<port>`), `QUTTY_TILE_TOKEN`,
   * `QUTTY_TILE_ID`. An agent gets the hub's flags whether or not the user-scope integration is
   * installed on the host: the sandbox has its own home, without that registration.
   */
  #spawningSandboxed(
    id: string,
    info: { agent?: string; cwd: string; cols: number; rows: number },
    sandbox: { alsoOn: readonly string[] },
  ): { env: Record<string, string>; args: string[] } {
    const { port } = this.tcpEndpoint(sandbox.alsoOn);
    const token = newToken();
    this.#tokens.set(token, id);
    this.#mirrors.set(id, new ScreenMirror(info.cols, info.rows));
    this.core.addTile({
      id,
      cwd: info.cwd,
      sandbox: true,
      ...(info.agent ? { harness: info.agent } : {}),
    });
    return {
      env: {
        QUTTY_HUB: `host.docker.internal:${port}`,
        QUTTY_TILE_TOKEN: token,
        QUTTY_TILE_ID: id,
      },
      args: hubArgsFor(info.agent, this.paths),
    };
  }

  data(id: string, text: string): void {
    this.#mirrors.get(id)?.write(text);
  }

  resized(id: string, cols: number, rows: number): void {
    this.#mirrors.get(id)?.resize(cols, rows);
  }

  ended(id: string): void {
    for (const [token, tile] of this.#tokens) {
      if (tile === id) this.#tokens.delete(token);
    }
    this.#listeners.get(id)?.close();
    this.#listeners.delete(id);
    for (const c of this.#conns.get(id) ?? []) void c.close();
    this.#conns.delete(id);
    this.#mirrors.get(id)?.dispose();
    this.#mirrors.delete(id);
    this.core.removeTile(id);
  }

  /** Close every socket, stop the companion and remove this process's socket folder. */
  async stop(): Promise<void> {
    for (const id of [...this.#listeners.keys()]) this.ended(id);
    this.#companionListener?.close();
    for (const c of this.#conns.get("companion") ?? []) void c.close();
    await this.companion.stop();
    for (const l of this.#tcp) l.close();
    this.#tcp = [];
    this.#tcpQueue?.end();
    removeDir(this.socketDir);
  }

  // --- connections ---------------------------------------------------------------------------

  /** Serve one unix-socket connection as `identity`. */
  #serve(conn: FdConnection, identity: HubIdentity): Promise<void> {
    return this.#serveTransport(
      conn,
      StreamServerTransport.from(conn),
      identity,
      "unix",
    );
  }

  /** A hook or `say` line (one-shot, answered and closed), else an MCP session. */
  async #serveTransport(
    conn: FdConnection,
    transport: StreamServerTransport,
    identity: HubIdentity,
    kind: "unix" | "tcp",
  ): Promise<void> {
    const tileId = identity.role === "tile" ? identity.tileId : "companion";
    let set = this.#conns.get(tileId);
    if (!set) this.#conns.set(tileId, set = new Set());
    set.add(conn);
    try {
      const session = this.#server.serveConnection(transport, {
        connection: {
          id: `${tileId}-${kind}-${conn.fd}`,
          transport: kind,
          identity,
        },
        abortOnEof: true,
        firstLineTimeoutMs: HOOK_LINE_MS,
        firstLine: (line) => this.#firstLine(line, identity),
      });
      await session.done;
    } catch (e) {
      console.error("hub: connection failed", e);
    } finally {
      await transport.close().catch(() => {});
      set.delete(conn);
    }
  }

  /** A connection's first line: `{"qutty":"hook",…}` and `{"qutty":"say",…}` are answered here. */
  async #firstLine(
    line: string,
    identity: HubIdentity,
  ): Promise<FirstLineDecision> {
    if (identity.role !== "tile") return { action: "mcp" };
    const say = parseSayLine(line);
    if (say) {
      const from = this.core.registry.get(identity.tileId)?.name ??
        identity.tileId;
      const reply = await this.companion.say(say, from).catch((e) => ({
        error: e instanceof Error ? e.message : String(e),
      }));
      return { action: "close", reply: JSON.stringify(reply) };
    }
    const hook = parseHookLine(line);
    if (hook) {
      const reply = this.core.hook(
        identity.tileId,
        String(hook.input.hook_event_name ?? ""),
        hook.input,
        hook.harness,
      );
      return { action: "close", reply: JSON.stringify(reply) };
    }
    return { action: "mcp" };
  }

  // --- the TCP endpoint (sandboxed tiles) ----------------------------------------------------

  /**
   * The hub's TCP endpoint, started on first use: a free port on 127.0.0.1 (Docker Desktop
   * forwards `host.docker.internal` there) and, for native Linux Docker, the same port on each
   * of `alsoOn` (the bridge gateway `host.docker.internal:host-gateway` resolves to). A
   * connection is admitted only when its first line is a live tile's token.
   */
  tcpEndpoint(alsoOn: readonly string[] = []): { port: number } {
    if (!this.#tcpQueue) {
      const queue = new ConnectionQueue();
      this.#tcp.push(
        FdTcpListener.listen("127.0.0.1", 0, this.#reactor, queue.push),
      );
      this.#tcpQueue = queue;
      void this.#serveTcp(queue);
    }
    const port = this.#tcp[0].port;
    for (const host of alsoOn) {
      if (this.#tcp.some((l) => l.host === host)) continue;
      try {
        this.#tcp.push(
          FdTcpListener.listen(host, port, this.#reactor, this.#tcpQueue.push),
        );
      } catch (e) {
        console.error(`hub: cannot listen on ${host}:${port}`, e);
      }
    }
    return { port };
  }

  /** Admit TCP connections by token (`StreamServerListener`'s pre-auth), then serve them. */
  async #serveTcp(queue: ConnectionQueue): Promise<void> {
    const listener = new StreamServerListener(queue, {
      transport: "tcp",
      preAuthTimeoutMs: HOOK_LINE_MS,
      preAuth: (line) => {
        const tileId = line === null ? undefined : this.#tokens.get(line);
        return tileId
          ? { ok: true, identity: { role: "tile", tileId } }
          : { ok: false, reason: "unknown tile token" };
      },
    });
    for await (const { transport, info } of listener) {
      const conn = queue.take(info.id);
      if (!conn) {
        await transport.close();
        continue;
      }
      void this.#serveTransport(
        conn,
        transport,
        info.identity as HubIdentity,
        "tcp",
      );
    }
  }

  /** The token a sandboxed tile authenticates with (tests). */
  tokenOf(tileId: string): string | undefined {
    for (const [token, id] of this.#tokens) if (id === tileId) return token;
    return undefined;
  }

  // --- integration -----------------------------------------------------------------------------

  async integration(): Promise<IntegrationStatus[]> {
    const status = await integrationStatus(this.#fs, this.files, this.paths);
    this.#installed = {
      claude: status.find((s) => s.target === "claude")?.installed ?? false,
      codex: status.find((s) => s.target === "codex")?.installed ?? false,
    };
    return status;
  }

  async refreshIntegration(): Promise<void> {
    await this.integration().catch(() => {});
  }

  async install(target: IntegrationTarget): Promise<IntegrationStatus[]> {
    await installIntegration(this.#fs, this.files, this.paths, target);
    return await this.integration();
  }

  async uninstall(target: IntegrationTarget): Promise<IntegrationStatus[]> {
    await uninstallIntegration(this.#fs, this.files, this.paths, target);
    return await this.integration();
  }
}

/** A fresh tile token: 32 random bytes, hex. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A `qutty-hook say` line: `{"qutty":"say","args":["text",…]}` → its arguments, else `undefined`. */
export function parseSayLine(line: string): string[] | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const { qutty, args } = v as { qutty?: unknown; args?: unknown };
  if (qutty !== "say" || !Array.isArray(args) || args.length > 64) {
    return undefined;
  }
  return args.filter((a): a is string => typeof a === "string")
    .map((a) => a.slice(0, 2000));
}

/** A `qutty-hook` line: `{"qutty":"hook","harness":"claude","input":{…}}`, else `undefined`. */
export function parseHookLine(
  line: string,
): { harness?: string; input: Record<string, unknown> } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    typeof v !== "object" || v === null ||
    (v as { qutty?: unknown }).qutty !== "hook"
  ) {
    return undefined;
  }
  const { harness, input } = v as { harness?: unknown; input?: unknown };
  return {
    ...(typeof harness === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(harness)
      ? { harness }
      : {}),
    input: typeof input === "object" && input !== null && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {},
  };
}

// ---------------------------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------------------------

let service: HubService | undefined;
let startError: string | undefined;

async function start(host: DesktopExtensionHost): Promise<void> {
  const home = Deno.env.get("HOME");
  if (!home || !home.startsWith("/")) throw new Error("no home folder");
  if (Deno.build.os === "windows") throw new Error("not supported on Windows");
  const socketDir = await prepareSocketDir();
  const hub = new HubService({
    home,
    socketDir,
    appSupportDir: host.appSupportDir,
    emit: (event, data) => host.emit(event, data),
  });
  await installHubFiles(hub.paths);
  service = hub;
  // The companion is optional too: without its socket the hub still serves the tiles.
  await hub.companion.start().catch((e) =>
    console.error("hub: the companion did not start", e)
  );
  setPtyTaps({
    spawning: (id, info) => hub.spawning(id, info),
    data: (id, text) => hub.data(id, text),
    resized: (id, cols, rows) => hub.resized(id, cols, rows),
    ended: (id) => hub.ended(id),
  });
  globalThis.addEventListener("unload", () => {
    hub.stop().catch(() => {/* exiting */});
  });
}

function requireService(): HubService {
  if (!service) {
    throw new Error(
      `the agent hub is not running${startError ? `: ${startError}` : ""}`,
    );
  }
  return service;
}

const answerInput = objectSchema<{ id: string; action: string | null }>(
  (v, issues) => {
    const action = v.action;
    if (
      action !== null && (typeof action !== "string" || action.length > 200)
    ) {
      issues.push({
        message: "action must be a string or null",
        path: ["action"],
      });
    }
    return {
      id: str(v, "id", issues, 64),
      action: typeof action === "string" ? action : null,
    };
  },
);

const targetInput = objectSchema<{ target: IntegrationTarget }>((v, issues) => {
  if (v.target !== "claude" && v.target !== "codex") {
    issues.push({
      message: "target must be claude or codex",
      path: ["target"],
    });
  }
  return { target: v.target === "codex" ? "codex" : "claude" };
});

const labelInput = objectSchema<{ id: string; label: string }>((v, issues) => ({
  id: str(v, "id", issues, 64),
  label: str(v, "label", issues, 200),
}));

const sayDoneInput = objectSchema<{ id: string; action: string | null }>(
  (v, issues) => ({
    id: str(v, "id", issues, 64),
    action: typeof v.action === "string" ? v.action.slice(0, 64) : null,
  }),
);

const sendInput = objectSchema<{ text: string }>((v, issues) => ({
  text: str(v, "text", issues, 8000),
}));

const configureInput = objectSchema<{ enabled: boolean; model: string }>(
  (v, issues) => {
    if (typeof v.enabled !== "boolean") {
      issues.push({ message: "enabled must be a boolean", path: ["enabled"] });
    }
    const model = typeof v.model === "string" ? v.model : "";
    if (!/^[A-Za-z0-9._:-]{0,64}$/.test(model)) {
      issues.push({ message: "model must be a model name", path: ["model"] });
    }
    return { enabled: v.enabled === true, model };
  },
);

const controlDoneInput = objectSchema<
  { requestId: string; ok: boolean; tileId?: string; error?: string }
>((v, issues) => ({
  requestId: str(v, "requestId", issues, 64),
  ok: v.ok === true,
  ...(typeof v.tileId === "string" ? { tileId: v.tileId.slice(0, 64) } : {}),
  ...(typeof v.error === "string" ? { error: v.error.slice(0, 500) } : {}),
}));

export default defineDesktopExtension({
  name: "hub",
  events: ["tiles", "ask", "askClosed", "control", "companion", "say"],
  setup: (host) => {
    // Never throw into the app's startup: a hub that cannot start leaves the terminals as they were.
    start(host).catch((e) => {
      startError = e instanceof Error ? e.message : String(e);
      console.error(`hub: not started (${startError})`);
      setPtyTaps(undefined);
    });
  },
  methods: {
    /** The tiles and open questions (the page asks on load; then follows the events). */
    snapshot: {
      input: emptyInput,
      handler: (): HubSnapshot & { asks: AskRequest[] } =>
        service?.snapshot() ?? { running: false, tiles: [], asks: [] },
    },
    /** The user answered an `ask_user` question (or dismissed it: `action: null`). */
    answer: {
      input: answerInput,
      handler: (args: unknown): boolean => {
        const { id, action } = args as { id: string; action: string | null };
        return requireService().core.answer(id, action);
      },
    },
    /** The page's title for a terminal (shown to agents in list_peers). */
    setLabel: {
      input: labelInput,
      handler: (args: unknown): void => {
        const { id, label } = args as { id: string; label: string };
        service?.core.registry.setMeta(id, { label });
      },
    },
    /** The companion's status and recent privileged actions. */
    companionStatus: {
      input: emptyInput,
      handler: (): { status: CompanionStatus; activity: AuditEntry[] } =>
        requireService().companion.status(),
    },
    /** The user typed to the companion; the reply streams as `companion` events. */
    companionSend: {
      input: sendInput,
      handler: (args: unknown): { turn: number } => ({
        turn: requireService().companion.runtime.userSays(
          (args as { text: string }).text,
        ),
      }),
    },
    /** Settings → Companion: whether the brain may run, and its model. */
    companionConfigure: {
      input: configureInput,
      handler: (args: unknown): CompanionStatus => {
        const { enabled, model } = args as { enabled: boolean; model: string };
        return requireService().companion.configure(enabled, model);
      },
    },
    /** The button pressed under a waited-for `qutty-hook say` (`null`: closed). */
    companionSayDone: {
      input: sayDoneInput,
      handler: (args: unknown): boolean => {
        const { id, action } = args as { id: string; action: string | null };
        return requireService().companion.sayDone(id, action);
      },
    },
    /** The page carried out a `control` command (spawn / close / focus a tile). */
    controlDone: {
      input: controlDoneInput,
      handler: (args: unknown): boolean => {
        const a = args as {
          requestId: string;
          ok: boolean;
          tileId?: string;
          error?: string;
        };
        return requireService().companion.controlDone(
          a.requestId,
          a.ok
            ? { ok: true, ...(a.tileId ? { tileId: a.tileId } : {}) }
            : { ok: false, error: a.error ?? "failed" },
        );
      },
    },
    integrationStatus: {
      input: emptyInput,
      handler: (): Promise<IntegrationStatus[]> =>
        requireService().integration(),
    },
    integrationInstall: {
      input: targetInput,
      handler: (args: unknown): Promise<IntegrationStatus[]> =>
        requireService().install(
          (args as { target: IntegrationTarget }).target,
        ),
    },
    integrationUninstall: {
      input: targetInput,
      handler: (args: unknown): Promise<IntegrationStatus[]> =>
        requireService().uninstall(
          (args as { target: IntegrationTarget }).target,
        ),
    },
  },
});
