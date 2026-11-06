/**
 * How each agent harness joins the hub for one session, without touching the user's own config:
 * the arguments and environment a tile's harness gets, whether it was started from the `+`
 * picker directly or through `ollama launch <harness> --model … -- <args>` (desktop/pty.ts puts
 * the arguments after the `--`, which ollama hands to the harness verbatim).
 *
 * | harness  | MCP server (`qutty`)                                             | hooks                  |
 * | -------- | ---------------------------------------------------------------- | ---------------------- |
 * | claude   | `--mcp-config ~/.qutty/claude-mcp.json` (lib/hub/launch.ts)      | `--settings` hooks     |
 * | codex    | `-c mcp_servers.qutty…` (lib/hub/launch.ts)                      | `-c hooks…` + trust    |
 * | opencode | `OPENCODE_CONFIG=~/.qutty/opencode.json` + `--standalone`        | none (JS plugins only) |
 * | qwen     | `--mcp-config <json>`                                            | none per session       |
 * | copilot  | `--additional-mcp-config <json>` (env listed: only PATH passes)  | none per session       |
 * | kimi     | `--mcp-config <json>` (env listed)                               | none per session       |
 * | dsh      | `--patch ~/.qutty/dsh-qutty.yml` (dsh-mcp-client, env listed)    | none                   |
 * | openclaw | `OPENCLAW_CONFIG_PATH=~/.qutty/openclaw.json` + `chat`           | none (JS hooks only)   |
 * | hermes   | none per session: Settings → Agent integration adds it to        | none (other input)     |
 * |          | `~/.hermes/config.yaml` (lib/hub/integration-hermes.ts)          |                        |
 * | others   | none: pi has no MCP; droid, cline, omp, muse, pool only read     |                        |
 * |          | their own config files                                           |                        |
 *
 * - OpenCode loads `OPENCODE_CONFIG` as one more layer, on top of `OPENCODE_CONFIG_CONTENT` (what
 *   `ollama launch opencode` sets) and the user's files. `--standalone` gives the session a
 *   private server: by default the TUI attaches to a shared background service that was started
 *   with another environment (no `QUTTY_SOCK`, or another tile's).
 * - Copilot and Kimi start MCP servers with a minimal environment, so the tile's hub variables are
 *   written into the server entry itself; those arguments are therefore per tile.
 *
 * Everything that can be checked without the harness installed is unit-tested; what was verified
 * against a real binary is in tests/hub_harness_live_test.ts.
 *
 * Pure: desktop/hub.ts writes the files and asks for the wiring.
 *
 * @module
 */

import { hubArgsFor, type HubPaths } from "./launch.ts";

/** The hub variables a tile has (`QUTTY_SOCK` + `QUTTY_TILE_ID`, or the sandbox's TCP pair). */
export const HUB_ENV_NAMES = [
  "QUTTY_SOCK",
  "QUTTY_TILE_ID",
  "QUTTY_HUB",
  "QUTTY_TILE_TOKEN",
] as const;

/** What a harness gets: arguments (before its own, or after ollama's `--`) and environment. */
export interface HubWiring {
  args: string[];
  env: Record<string, string>;
}

/** The files the per-session wiring points at (generated into `~/.qutty` with the others). */
export interface WiringPaths {
  /** `~/.qutty/opencode.json` (`OPENCODE_CONFIG`) */
  opencodeConfig: string;
  /** `~/.qutty/dsh-qutty.yml` (`dsh --patch`) */
  dshPatch: string;
  /** `~/.qutty/openclaw.json` (`OPENCLAW_CONFIG_PATH`) */
  openclawConfig: string;
}

export function wiringPaths(paths: HubPaths): WiringPaths {
  return {
    opencodeConfig: `${paths.dir}/opencode.json`,
    dshPatch: `${paths.dir}/dsh-qutty.yml`,
    openclawConfig: `${paths.dir}/openclaw.json`,
  };
}

/**
 * The user's OpenClaw config: `OPENCLAW_CONFIG_PATH` when the app has one (not Qutty's own),
 * else `~/.openclaw/openclaw.json`.
 */
export function openclawUserConfig(
  home: string,
  paths: HubPaths,
  env: Record<string, string | undefined> = {},
): string {
  const own = wiringPaths(paths).openclawConfig;
  const set = env.OPENCLAW_CONFIG_PATH;
  return set && set.startsWith("/") && set !== own
    ? set
    : `${home.replace(/\/+$/, "")}/.openclaw/openclaw.json`;
}

/**
 * `~/.qutty/openclaw.json`: the user's config (`$include`, so everything in it still applies)
 * plus the hub as an MCP server. OpenClaw starts a stdio server with only the variables listed in
 * its `env`, and expands `${VAR}` from its own environment (an unset one stays as written).
 */
export function openclawConfig(paths: HubPaths, userConfig: string): string {
  return JSON.stringify(
    {
      $include: userConfig,
      mcp: {
        servers: {
          qutty: {
            command: paths.mcp,
            env: Object.fromEntries(HUB_ENV_NAMES.map((n) => [n, `\${${n}}`])),
          },
        },
      },
    },
    null,
    2,
  ) + "\n";
}

/** `~/.qutty/opencode.json`: the hub as a local MCP server (it inherits the tile's environment). */
export function opencodeConfig(paths: HubPaths): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: { qutty: { type: "local", command: [paths.mcp], enabled: true } },
    },
    null,
    2,
  ) + "\n";
}

/**
 * `~/.qutty/dsh-qutty.yml`: a dsh launcher patch adding its MCP client for the hub. dsh scrubs
 * variables that look like secrets (`QUTTY_TILE_TOKEN`), so all four are passed by name.
 */
export function dshPatch(paths: HubPaths): string {
  const env = HUB_ENV_NAMES.map((n) =>
    `        ${n}: !!js process.env.${n} ?? ""`
  ).join("\n");
  return [
    "# Qutty agent hub: the qutty MCP server for this dsh session (written by Qutty).",
    "- id: mcp-qutty",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: qutty",
    "    transport: stdio",
    `    command: ${JSON.stringify(paths.mcp)}`,
    "    env:",
    env,
    "",
  ].join("\n");
}

/** The tile's hub variables that are set. */
function hubEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    HUB_ENV_NAMES.filter((n) => env[n]).map((n) => [n, env[n]]),
  );
}

/** A Claude-style `mcpServers` JSON with one `qutty` server (and extra fields for it). */
function mcpServersJson(
  paths: HubPaths,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    mcpServers: { qutty: { command: paths.mcp, args: [], ...extra } },
  });
}

/** The harnesses with a per-session wiring. */
export const WIRED_HARNESSES = [
  "claude",
  "codex",
  "opencode",
  "qwen",
  "copilot",
  "kimi",
  "dsh",
  "openclaw",
] as const;

/**
 * The wiring for `agent` in a tile whose hub variables are `tileEnv`: none for a harness without
 * a per-session mechanism. `skip` (Claude Code / Codex): the user-scope integration is installed
 * already, which would register the server and hooks twice. `userEnv` is the app's own
 * environment: a user who set `OPENCODE_CONFIG` keeps theirs (and opencode is not wired).
 * `facts.openclawUserConfig`: the user's OpenClaw config, when it exists (OpenClaw is wired only
 * then).
 */
export function hubWiring(
  agent: string | undefined,
  paths: HubPaths,
  tileEnv: Record<string, string> = {},
  skip: { claude?: boolean; codex?: boolean } = {},
  userEnv: Record<string, string | undefined> = {},
  facts: { openclawUserConfig?: string } = {},
): HubWiring {
  const w = wiringPaths(paths);
  switch (agent) {
    case "openclaw": {
      // Its default TUI talks to the gateway daemon, whose MCP servers never see a tile's
      // environment: `chat` (`tui --local`) runs the agent, and its MCP servers, in the tile.
      // Our config includes the user's, which must exist (OpenClaw refuses a missing include)
      // and be under an allowed include root (by default only our config's own folder).
      const user = facts.openclawUserConfig;
      if (!user) return { args: [], env: {} };
      const roots = [
        ...(userEnv.OPENCLAW_INCLUDE_ROOTS ?? "").split(":").filter(Boolean),
        user.slice(0, user.lastIndexOf("/")) || "/",
      ];
      return {
        args: ["chat"],
        env: {
          OPENCLAW_CONFIG_PATH: w.openclawConfig,
          OPENCLAW_INCLUDE_ROOTS: [...new Set(roots)].join(":"),
        },
      };
    }
    case "claude":
    case "codex":
      return { args: hubArgsFor(agent, paths, skip), env: {} };
    case "opencode":
      return userEnv.OPENCODE_CONFIG ? { args: [], env: {} } : {
        args: ["--standalone"],
        env: { OPENCODE_CONFIG: w.opencodeConfig },
      };
    case "qwen":
      return { args: ["--mcp-config", mcpServersJson(paths)], env: {} };
    case "copilot":
      return {
        args: [
          "--additional-mcp-config",
          mcpServersJson(paths, {
            type: "local",
            env: hubEnv(tileEnv),
            tools: ["*"],
          }),
        ],
        env: {},
      };
    case "kimi":
      return {
        args: ["--mcp-config", mcpServersJson(paths, { env: hubEnv(tileEnv) })],
        env: {},
      };
    case "dsh":
      return { args: ["--patch", w.dshPatch], env: {} };
    default:
      return { args: [], env: {} };
  }
}
