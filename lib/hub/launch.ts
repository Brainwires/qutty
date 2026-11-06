/**
 * Where the hub's files live under the home folder, the files Qutty generates there, and the
 * extra arguments an agent started from the `+` picker gets so it joins the hub with no setup:
 *
 * - Claude Code: `--mcp-config ~/.qutty/claude-mcp.json --settings ~/.qutty/claude-hooks.json`
 *   (both flags load *additional* config: the user's own servers and settings still apply);
 * - Codex: `-c key=value` overrides (the value parsed as TOML; together they are Codex's
 *   "session flags" config layer, on top of the user's own): `mcp_servers.qutty` with
 *   `env_vars` (Codex starts an MCP server with only a few variables such as `HOME` and `PATH`,
 *   so `QUTTY_SOCK` has to be named), a `hooks.<Event>` group per event in
 *   {@linkcode CODEX_HOOK_EVENTS}, and `hooks.state` marking exactly those hooks trusted. Codex
 *   runs a hook that is not a managed one only once its hash is trusted (what its `/hooks`
 *   review stores; it reads trust from the user's config and the session flags). The hash is
 *   the one Codex computes ({@linkcode codexHookHash}), so a changed command is not trusted.
 *
 * Pure: desktop/hub.ts writes the files and asks for the arguments.
 *
 * @module
 */

import { CODEX_HOOK_EVENTS, HOOK_EVENTS } from "./hooks.ts";
import { sha256Hex } from "./sha256.ts";

/** The hub's paths for a home folder. */
export interface HubPaths {
  /** `~/.qutty` */
  dir: string;
  /** `~/.qutty/bin`, prepended to every tile's `PATH`. */
  bin: string;
  /** `~/.qutty/bin/qutty-mcp` */
  mcp: string;
  /** `~/.qutty/bin/qutty-hook` */
  hook: string;
  /** `~/.qutty/claude-mcp.json` (`--mcp-config`) */
  claudeMcpConfig: string;
  /** `~/.qutty/claude-hooks.json` (`--settings`) */
  claudeHooks: string;
}

export function hubPaths(home: string): HubPaths {
  const dir = `${home.replace(/\/+$/, "")}/.qutty`;
  const bin = `${dir}/bin`;
  return {
    dir,
    bin,
    mcp: `${bin}/qutty-mcp`,
    hook: `${bin}/qutty-hook`,
    claudeMcpConfig: `${dir}/claude-mcp.json`,
    claudeHooks: `${dir}/claude-hooks.json`,
  };
}

/** A word for `sh -c` (Claude Code runs a hook's `command` through the shell). */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The MCP server entry (Claude Code's `mcpServers.qutty`). */
export function claudeMcpEntry(mcpPath: string): Record<string, unknown> {
  return { type: "stdio", command: mcpPath, args: [], env: {} };
}

/** `~/.qutty/claude-mcp.json`: the hub as an MCP server, for `--mcp-config`. */
export function claudeMcpConfig(paths: HubPaths): string {
  return JSON.stringify(
    { mcpServers: { qutty: claudeMcpEntry(paths.mcp) } },
    null,
    2,
  ) +
    "\n";
}

/** The hook command (`qutty-hook claude`): how Qutty's hook entries are recognised too. */
export function hookCommand(paths: HubPaths, harness = "claude"): string {
  return `${shellQuote(paths.hook)} ${harness}`;
}

/** One matcher group running `qutty-hook` (no matcher: every tool / every source). */
function hookGroup(paths: HubPaths): Record<string, unknown> {
  return {
    hooks: [{ type: "command", command: hookCommand(paths), timeout: 15 }],
  };
}

/** The `hooks` table Qutty adds: each event in {@linkcode HOOK_EVENTS} runs `qutty-hook`. */
export function claudeHooks(paths: HubPaths): Record<string, unknown[]> {
  return Object.fromEntries(HOOK_EVENTS.map((e) => [e, [hookGroup(paths)]]));
}

/** `~/.qutty/claude-hooks.json`: the hooks, for `--settings`. */
export function claudeHooksSettings(paths: HubPaths): string {
  return JSON.stringify({ hooks: claudeHooks(paths) }, null, 2) + "\n";
}

/** A TOML basic string (JSON's escapes are a subset TOML accepts). */
export function tomlString(s: string): string {
  return JSON.stringify(s);
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

/**
 * The variables Codex passes on to the qutty MCP server (`env_vars`): the tile's socket and id,
 * and the shared sandbox's TCP endpoint and token.
 */
export const CODEX_MCP_ENV_VARS = [
  "QUTTY_SOCK",
  "QUTTY_TILE_ID",
  "QUTTY_HUB",
  "QUTTY_TILE_TOKEN",
] as const;

/** The `mcp_servers.qutty` table for Codex. */
export function codexMcpEntry(
  mcpPath: string,
): { command: string; args: string[]; env_vars: string[] } {
  return { command: mcpPath, args: [], env_vars: [...CODEX_MCP_ENV_VARS] };
}

export type CodexHookEvent = typeof CODEX_HOOK_EVENTS[number];

/** The one handler Qutty adds to an event: `qutty-hook codex` (Codex caps `Interrupt` at 3 s). */
export function codexHookHandler(
  paths: HubPaths,
  event: CodexHookEvent,
): { type: "command"; command: string; timeout: number } {
  return {
    type: "command",
    command: hookCommand(paths, "codex"),
    timeout: event === "Interrupt" ? 3 : 15,
  };
}

/** Codex's snake_case name for an event (`PostToolUse` → `post_tool_use`). */
function codexEventLabel(event: CodexHookEvent): string {
  return event.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase());
}

/** The source of hooks given with `-c` (Codex's session-flags layer). */
export const CODEX_SESSION_FLAGS_SOURCE = "/<session-flags>/config.toml";

/**
 * The key Codex keeps a hook's trust under: `<config file>:<event>:<group>:<handler>`, the file
 * being {@linkcode CODEX_SESSION_FLAGS_SOURCE} or the user's config.toml path.
 */
export function codexHookKey(
  source: string,
  event: CodexHookEvent,
  groupIndex: number,
): string {
  return `${source}:${codexEventLabel(event)}:${groupIndex}:0`;
}

/** A JSON value with its object keys sorted, recursively (serde_json's `sort_all_objects`). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v !== "object" || v === null) return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]),
  );
}

/**
 * The hash Codex trusts Qutty's hook for `event` by (`hook_hash` in openai/codex
 * `codex-rs/hooks/src/engine/discovery.rs`): `sha256:` and the SHA-256 of the compact, key-sorted
 * JSON of `{ event_name, hooks: [the normalized handler] }`, with no matcher and the handler's
 * unset options left out.
 */
export function codexHookHash(paths: HubPaths, event: CodexHookEvent): string {
  const identity = {
    event_name: codexEventLabel(event),
    hooks: [{ ...codexHookHandler(paths, event), async: false }],
  };
  return `sha256:${sha256Hex(JSON.stringify(sortKeys(identity)))}`;
}

/** A TOML inline value: strings, numbers, booleans, arrays and tables (odd keys quoted). */
export function tomlInline(v: unknown): string {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlInline).join(", ")}]`;
  const entries = Object.entries(v as Record<string, unknown>).map(([k, x]) =>
    `${/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k)} = ${tomlInline(x)}`
  );
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** The `-c` overrides that join a Codex session to the hub: the server, the hooks, their trust. */
export function codexHubArgs(paths: HubPaths): string[] {
  const entry = codexMcpEntry(paths.mcp);
  const args = [
    "-c",
    `mcp_servers.qutty.command=${tomlString(entry.command)}`,
    "-c",
    `mcp_servers.qutty.env_vars=${tomlInline(entry.env_vars)}`,
  ];
  const state: Record<string, { trusted_hash: string }> = {};
  for (const event of CODEX_HOOK_EVENTS) {
    args.push(
      "-c",
      `hooks.${event}=${
        tomlInline([{ hooks: [codexHookHandler(paths, event)] }])
      }`,
    );
    state[codexHookKey(CODEX_SESSION_FLAGS_SOURCE, event, 0)] = {
      trusted_hash: codexHookHash(paths, event),
    };
  }
  // One inline table: a dotted `-c hooks.state."<key>"…` is split at the key's own dots.
  args.push("-c", `hooks.state=${tomlInline(state)}`);
  return args;
}

/**
 * The arguments that join `agent` (an `AGENT_TOOLS` name) to the hub, put before the user's own:
 * none for a tool the hub has no wiring for, or when `skip` (the user-scope integration is
 * installed already, which would register the server and hooks twice).
 */
export function hubArgsFor(
  agent: string | undefined,
  paths: HubPaths,
  skip: { claude?: boolean; codex?: boolean } = {},
): string[] {
  switch (agent) {
    case "claude":
      return skip.claude ? [] : [
        "--mcp-config",
        paths.claudeMcpConfig,
        "--settings",
        paths.claudeHooks,
      ];
    case "codex":
      return skip.codex ? [] : codexHubArgs(paths);
    default:
      return [];
  }
}
