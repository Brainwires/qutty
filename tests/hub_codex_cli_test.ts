// The installed Codex CLI reads Qutty's configuration the way Qutty means it, with no model
// request and no login: `codex mcp get qutty` shows the server with its env_vars, and the app
// server's `hooks/list` reports each of Qutty's hooks as trusted, both for the `+` picker's `-c`
// overrides and for the block Settings → Agent integration installs. Everything runs in a
// temporary CODEX_HOME / HOME. Skipped where `codex` is not installed (CI).

import { assertEquals } from "@std/assert";
import {
  installIntegration,
  integrationFiles,
  uninstallIntegration,
} from "../lib/hub/integration.ts";
import {
  CODEX_MCP_ENV_VARS,
  codexHubArgs,
  hubPaths,
} from "../lib/hub/launch.ts";
import { CODEX_HOOK_EVENTS } from "../lib/hub/hooks.ts";
import { denoConfigFs } from "./hub_helpers.ts";

function hasCodex(): boolean {
  try {
    return new Deno.Command("codex", { args: ["--version"], stdout: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
}

const ignore = !hasCodex();

interface ListedHook {
  eventName: string;
  command: string;
  trustStatus: string;
}

/** `hooks/list` from `codex app-server` (stdio JSON-RPC), run with `args` and `env`. */
async function listHooks(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<ListedHook[]> {
  const child = new Deno.Command("codex", {
    args: ["app-server", ...args],
    env,
    cwd,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "qutty-test", version: "0" } },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [cwd] } },
    ].map((m) => JSON.stringify(m) + "\n").join(""),
  ));
  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    while (!/"id":2[,}]/.test(buf)) {
      const { value, done } = await lines.read();
      if (done) break;
      buf += value;
    }
  } finally {
    await w.close().catch(() => {});
    child.kill();
    await lines.cancel().catch(() => {});
    await child.status;
  }
  const line = buf.split("\n").find((l) => /"id":2[,}]/.test(l));
  return JSON.parse(line!).result.data[0].hooks;
}

/** Qutty's hooks among `hooks`, as `event → trust status`. */
function quttyTrust(hooks: ListedHook[]): Record<string, string> {
  return Object.fromEntries(
    hooks.filter((h) => /qutty-hook'? codex$/.test(h.command))
      .map((h) => [h.eventName, h.trustStatus]),
  );
}

const allTrusted = Object.fromEntries(
  CODEX_HOOK_EVENTS.map((e) => [
    e[0].toLowerCase() + e.slice(1),
    "trusted",
  ]),
);

Deno.test({
  name:
    "codex CLI: the picker's -c overrides give a server with env_vars and trusted hooks",
  ignore,
  sanitizeResources: false,
  async fn() {
    const codexHome = await Deno.makeTempDir({ prefix: "qutty-codex-home" });
    try {
      const args = codexHubArgs(hubPaths("/Users/my 'odd' name"));
      const env = { CODEX_HOME: codexHome };
      const mcp = await new Deno.Command("codex", {
        args: ["mcp", ...args, "get", "qutty", "--json"],
        env,
        stdout: "piped",
        stderr: "null",
      }).output();
      const server = JSON.parse(new TextDecoder().decode(mcp.stdout));
      assertEquals(
        server.transport.command,
        "/Users/my 'odd' name/.qutty/bin/qutty-mcp",
      );
      assertEquals(server.transport.env_vars, [...CODEX_MCP_ENV_VARS]);
      assertEquals(
        quttyTrust(await listHooks(args, env, codexHome)),
        allTrusted,
      );
    } finally {
      await Deno.remove(codexHome, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "codex CLI: the installed config.toml block gives trusted hooks after the user's own",
  ignore,
  sanitizeResources: false,
  async fn() {
    const home = await Deno.makeTempDir({ prefix: "qutty-codex-int" });
    try {
      const paths = hubPaths(home);
      const files = integrationFiles(home, paths);
      const mine =
        `[[hooks.Stop]]\nhooks = [{ type = "command", command = "true" }]\n`;
      await Deno.mkdir(`${home}/.codex`);
      await Deno.writeTextFile(files.codexConfig, mine);
      await installIntegration(denoConfigFs, files, paths, "codex");
      const hooks = await listHooks(
        [],
        { CODEX_HOME: `${home}/.codex`, HOME: home },
        home,
      );
      assertEquals(quttyTrust(hooks), allTrusted);
      // The user's own hook keeps its own (absent) trust.
      assertEquals(
        hooks.filter((h) => h.command === "true").map((h) => h.trustStatus),
        ["untrusted"],
      );
      await uninstallIntegration(denoConfigFs, files, paths, "codex");
      assertEquals(await Deno.readTextFile(files.codexConfig), mine);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
});
