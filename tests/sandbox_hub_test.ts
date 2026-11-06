// The hub's TCP + token endpoint for sandboxed tiles (desktop/hub.ts `tcpEndpoint`,
// desktop/hub-socket.ts `FdTcpListener`), driven from the host: the shipped qutty-mcp and
// qutty-hook shims with `QUTTY_HUB=127.0.0.1:<port>` (bash's /dev/tcp, or nc), a scripted MCP
// client, raw sockets for the token check, and the registry's `sandbox` flag in list_peers.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { McpClient } from "@rullama/mcp-client";
import { HubService } from "../desktop/hub.ts";
import { resultText } from "./hub_helpers.ts";
import { fixture, HOOK_SHIM, MCP_SHIM } from "./socket_helpers.ts";

const ignore = Deno.build.os === "windows";

function spawnSandboxed(
  hub: HubService,
  id: string,
): { env: Record<string, string>; port: number } {
  const { env } = hub.spawning(id, {
    cwd: "/work",
    cols: 80,
    rows: 24,
    sandbox: { alsoOn: [] },
  });
  return { env, port: Number(env.QUTTY_HUB.split(":")[1]) };
}

/** The tile's environment with the hub at 127.0.0.1 (the host's view of host.docker.internal). */
const local = (env: Record<string, string>, port: number) => ({
  QUTTY_HUB: `127.0.0.1:${port}`,
  QUTTY_TILE_TOKEN: env.QUTTY_TILE_TOKEN,
  QUTTY_TILE_ID: env.QUTTY_TILE_ID,
});

/** One raw exchange: send `lines`, read until the server closes. */
async function raw(port: number, lines: string[]): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await conn.write(new TextEncoder().encode(lines.join("\n") + "\n"));
  let text = "";
  const buf = new Uint8Array(4096);
  const deadline = setTimeout(() => conn.close(), 8000);
  try {
    for (;;) {
      const n = await conn.read(buf);
      if (n === null) break;
      text += new TextDecoder().decode(buf.subarray(0, n));
    }
  } catch { /* closed by the deadline */ }
  clearTimeout(deadline);
  try {
    conn.close();
  } catch { /* already closed */ }
  return text;
}

Deno.test({
  name:
    "sandboxed tile: env carries QUTTY_HUB + token, no socket; the registry marks it sandboxed",
  ignore,
  async fn() {
    const f = await fixture();
    try {
      const { env, port } = spawnSandboxed(f.hub, "pty-7");
      assertEquals(env.QUTTY_HUB, `host.docker.internal:${port}`);
      assertEquals(env.QUTTY_TILE_ID, "pty-7");
      assertEquals(env.QUTTY_TILE_TOKEN.length, 64);
      assertEquals(env.QUTTY_SOCK, undefined);
      assertEquals(f.hub.tokenOf("pty-7"), env.QUTTY_TILE_TOKEN);
      const tile = f.hub.core.registry.get("pty-7");
      assertEquals(tile?.sandbox, true);
      assertEquals(tile?.cwd, "/work");
      // One endpoint for every sandboxed tile; each gets its own token.
      const second = spawnSandboxed(f.hub, "pty-8");
      assertEquals(second.port, port);
      assert(second.env.QUTTY_TILE_TOKEN !== env.QUTTY_TILE_TOKEN);
      // Its token dies with the tile.
      f.hub.ended("pty-7");
      assertEquals(f.hub.tokenOf("pty-7"), undefined);
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "TCP endpoint: a wrong or missing token gets one Unauthorized line and is closed",
  ignore,
  async fn() {
    const f = await fixture();
    try {
      const { port } = spawnSandboxed(f.hub, "pty-1");
      const bad = await raw(port, [
        "not-a-token",
        '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      ]);
      assertStringIncludes(bad, "Unauthorized");
      assertEquals(bad.includes('"tools"'), false);
      // A hook line without a token first is refused as well.
      const hookFirst = await raw(port, ['{"qutty":"hook","input":{}}']);
      assertStringIncludes(hookFirst, "Unauthorized");
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "qutty-mcp over TCP + token: whoami is the tile, list_peers shows sandbox and host tiles",
  ignore,
  async fn() {
    const f = await fixture();
    const client = new McpClient("claude-code", "1.0");
    try {
      // A host tile next to the sandboxed one.
      f.hub.spawning("pty-1", { cwd: "/", cols: 80, rows: 24 });
      const { env, port } = spawnSandboxed(f.hub, "pty-2");
      await client.connect({
        name: "hub",
        command: "bash",
        args: [MCP_SHIM],
        env: local(env, port),
      });
      const who = JSON.parse(
        resultText(await client.callTool("hub", "whoami", {})),
      );
      assertEquals(who.id, "pty-2");
      const peers = JSON.parse(
        resultText(await client.callTool("hub", "list_peers", {})),
      );
      const byId = Object.fromEntries(
        peers.tiles.map((t: { id: string }) => [t.id, t]),
      );
      assertEquals(byId["pty-2"].sandbox, true);
      assertEquals(byId["pty-1"].sandbox, undefined);
    } finally {
      await client.disconnect("hub").catch(() => {});
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "qutty-hook over TCP + token: a hook answers; a refused token prints nothing",
  ignore,
  async fn() {
    const f = await fixture();
    try {
      const { env, port } = spawnSandboxed(f.hub, "pty-3");
      const run = async (vars: Record<string, string>) => {
        const p = new Deno.Command("bash", {
          args: [HOOK_SHIM, "claude"],
          env: vars,
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        const w = p.stdin.getWriter();
        await w.write(
          new TextEncoder().encode(
            '{"hook_event_name":"SessionStart","session_id":"s1"}\n',
          ),
        );
        await w.close();
        const out = await p.output();
        return { code: out.code, text: new TextDecoder().decode(out.stdout) };
      };
      const ok = await run(local(env, port));
      assertEquals(ok.code, 0);
      assert(ok.text.startsWith("{"), ok.text);
      assertEquals(f.hub.core.registry.get("pty-3")?.harness, "claude");
      const refused = await run({ ...local(env, port), QUTTY_TILE_TOKEN: "x" });
      assertEquals(refused, { code: 0, text: "" });
    } finally {
      await f.dispose();
    }
  },
});
