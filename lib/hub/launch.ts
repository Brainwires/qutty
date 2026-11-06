/**
 * Where the hub's files live under the home folder, the files Qutty generates there, and the
 * extra arguments an agent started from the `+` picker gets so it joins the hub with no setup:
 *
 * - Claude Code: `--mcp-config ~/.qutty/claude-mcp.json --settings ~/.qutty/claude-hooks.json`
 *   (both flags load *additional* config: the user's own servers and settings still apply);
 * - Codex: `-c mcp_servers.qutty.command="…/qutty-mcp"` (a `-c key=value` override, the value
 *   parsed as TOML).
 *
 * Pure: desktop/hub.ts writes the files and asks for the arguments.
 *
 * @module
 */

import { HOOK_EVENTS } from "./hooks.ts";

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
      return skip.codex
        ? []
        : ["-c", `mcp_servers.qutty.command=${tomlString(paths.mcp)}`];
    default:
      return [];
  }
}
