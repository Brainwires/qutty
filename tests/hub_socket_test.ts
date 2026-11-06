// The agent hub over real sockets (desktop/hub.ts + desktop/hub-socket.ts): per-tile unix
// sockets bound through libc, the system `nc -U` (through the shipped qutty-mcp shim) as the MCP
// client's stdio server, a scripted @rullama/mcp-client session (initialize → tools/list →
// send_message → read_messages between two fake tiles; wait_for_message concurrent with
// list_peers on one connection), qutty-hook round trips, and a real PTY whose environment and
// screen mirror the hub provides.
//
// Skipped where `nc` has no `-U` (busybox) — the shim falls back to socat there.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { McpClient } from "@rullama/mcp-client";
import { HubService, parseHookLine, prepareSocketDir } from "../desktop/hub.ts";
import { PtyHost, setPtyTaps } from "../desktop/pty.ts";
import { Recorder } from "./pty_helpers.ts";
import { resultText, waitUntil } from "./hub_helpers.ts";
import {
  connect,
  type Fixture,
  fixture,
  HAS_NC,
  HOOK_SHIM,
  MCP_SHIM,
  tapHub,
} from "./socket_helpers.ts";

const ignore = !HAS_NC;

function spawnFake(hub: HubService, id: string, agent?: string): string {
  const { env } = hub.spawning(id, {
    cwd: "/",
    cols: 80,
    rows: 24,
    ...(agent ? { agent } : {}),
  });
  return env.QUTTY_SOCK;
}

/**
 * Run `fn` with one fake tile per client name (`pty-1`, `pty-2`, …), each with an MCP client
 * connected through its socket; everything is torn down afterwards.
 */
async function withClients(
  names: string[],
  fn: (f: Fixture, clients: McpClient[], socks: string[]) => Promise<void>,
): Promise<void> {
  const f = await fixture();
  const clients = names.map((n) => new McpClient(n, "1.0"));
  try {
    const socks = names.map((_, i) => spawnFake(f.hub, `pty-${i + 1}`));
    for (const [i, c] of clients.entries()) await connect(c, "hub", socks[i]);
    await fn(f, clients, socks);
  } finally {
    for (const c of clients) await c.disconnect("hub").catch(() => {});
    await f.dispose();
  }
}

const json = (r: { content: { type: string; text?: string }[] }) =>
  JSON.parse(resultText(r));

Deno.test({
  name:
    "socket folder: private, per process, short paths; dead processes' folders removed",
  ignore: Deno.build.os === "windows",
  async fn() {
    const base = await Deno.makeTempDir({ dir: "/tmp", prefix: "qh" });
    try {
      const own = await prepareSocketDir(base);
      const userDir = own.slice(0, own.lastIndexOf("/"));
      assertEquals(own.slice(own.lastIndexOf("/") + 1), String(Deno.pid));
      assertEquals((Deno.statSync(userDir).mode ?? 0) & 0o777, 0o700);
      assertEquals((Deno.statSync(own).mode ?? 0) & 0o777, 0o700);
      // A folder of a process that does not exist (pid 2^22 - 3) is cleaned up.
      const dead = `${userDir}/4194301`;
      Deno.mkdirSync(dead);
      Deno.writeTextFileSync(`${dead}/pty-1.sock`, "");
      await prepareSocketDir(base);
      assertEquals(await Deno.stat(dead).then(() => true, () => false), false);
      assert(`${own}/pty-123.sock`.length < 104);
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "socket folder: a folder owned by someone else / with loose permissions is refused",
  ignore: Deno.build.os === "windows",
  async fn() {
    const base = await Deno.makeTempDir({ dir: "/tmp", prefix: "qh" });
    try {
      const uid = Deno.uid()!;
      Deno.mkdirSync(`${base}/qutty-${uid}`, { mode: 0o777 });
      Deno.chmodSync(`${base}/qutty-${uid}`, 0o777);
      let refused = false;
      await prepareSocketDir(base).catch(() => (refused = true));
      assert(refused);
    } finally {
      await Deno.remove(base, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "MCP over a tile socket (nc -U): initialize → tools/list → send_message → read_messages",
  ignore,
  async fn() {
    await withClients(["test-a", "claude-code"], async (f, [a, b], [sockA]) => {
      assertEquals(Deno.lstatSync(sockA).isSocket, true);
      assertEquals((Deno.lstatSync(sockA).mode ?? 0) & 0o777, 0o600);
      assertEquals(a.getProtocolVersion("hub"), "2025-06-18");
      assertEquals(a.getServerInfo("hub").name, "qutty");
      const tools = (await a.listTools("hub")).map((t) => t.name);
      assert(tools.includes("send_message") && tools.includes("write_tile"));
      // b's client name made pty-2 a claude tile, named "claude".
      await waitUntil(
        () => f.hub.core.registry.get("pty-2")?.name === "claude",
        2000,
        "rename",
      );

      const me = json(await a.callTool("hub", "whoami"));
      assertEquals(me.id, "pty-1");
      const sent = json(
        await a.callTool("hub", "send_message", {
          to: "claude",
          text: "hello b",
        }),
      );
      assertEquals(sent.sent[0].to, "pty-2");
      const got = json(await b.callTool("hub", "read_messages"));
      assertEquals(
        got.messages.map((
          m: { text: string; from: string },
        ) => [m.from, m.text]),
        [[
          "pty-1",
          "hello b",
        ]],
      );
      const denied = await a.callTool("hub", "write_tile", {
        tile: "pty-2",
        text: "x",
      });
      assert(denied.isError);
      // Tiles events reached the page.
      assert(f.events.some((e) => e.event === "tiles"));
    });
  },
});

Deno.test({
  name:
    "MCP: wait_for_message does not stall list_peers on the same connection",
  ignore,
  async fn() {
    await withClients(["a", "b"], async (_f, [a, b]) => {
      const waiting = a.callTool("hub", "wait_for_message", {
        timeoutMs: 20_000,
      });
      const t0 = Date.now();
      const peers = json(await a.callTool("hub", "list_peers"));
      assert(
        Date.now() - t0 < 2000,
        "list_peers answered while wait_for_message was pending",
      );
      assertEquals(peers.tiles.length, 2);
      await b.callTool("hub", "send_message", { to: "pty-1", text: "wake up" });
      const woke = json(await waiting);
      assertEquals(woke.messages[0].text, "wake up");
    });
  },
});

Deno.test({
  name:
    "ask_user over the socket: the page's answer reaches the waiting caller",
  ignore,
  async fn() {
    const f = await fixture();
    const a = new McpClient("a", "1");
    try {
      await connect(a, "hub", spawnFake(f.hub, "pty-1"));
      const pending = a.callTool("hub", "ask_user", {
        text: "Proceed?",
        actions: ["Go", "Stop"],
      });
      const ask = await waitUntil(
        () =>
          f.events.find((e) => e.event === "ask")?.data as
            | { id: string }
            | undefined,
        3000,
        "the ask event",
      );
      assertEquals(f.hub.snapshot().asks.length, 1);
      f.hub.core.answer(ask!.id, "Go");
      assertEquals(json(await pending).action, "Go");
      assert(f.events.some((e) => e.event === "askClosed"));
    } finally {
      await a.disconnect("hub").catch(() => {});
      await f.dispose();
    }
  },
});

/** Run the qutty-hook shim with `input` on stdin. */
async function runHook(
  input: unknown,
  env: Record<string, string>,
  harness = "claude",
): Promise<{ code: number; out: string }> {
  const child = new Deno.Command("bash", {
    args: [HOOK_SHIM, harness],
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(input, null, 2)));
  await w.close();
  const out = await child.output();
  return { code: out.code, out: new TextDecoder().decode(out.stdout) };
}

Deno.test({
  name: "qutty-hook: SessionStart / Stop round trips through the tile's socket",
  ignore,
  async fn() {
    const f = await fixture();
    try {
      const sock = spawnFake(f.hub, "pty-1");
      spawnFake(f.hub, "pty-2", "codex");
      const start = await runHook(
        {
          hook_event_name: "SessionStart",
          source: "startup",
          cwd: "/repo",
          session_id: "s",
        },
        { QUTTY_SOCK: sock },
      );
      assertEquals(start.code, 0);
      const ctx = JSON.parse(start.out).hookSpecificOutput;
      assertEquals(ctx.hookEventName, "SessionStart");
      assertStringIncludes(ctx.additionalContext, "pty-1");
      assertEquals(f.hub.core.registry.get("pty-1")?.harness, "claude");

      const idle = await runHook({
        hook_event_name: "Stop",
        stop_hook_active: false,
      }, {
        QUTTY_SOCK: sock,
      });
      assertEquals(JSON.parse(idle.out), {});
      f.hub.core.send(
        { role: "tile", tileId: "pty-2" },
        "pty-1",
        "tests are red",
      );
      const blocked = await runHook({
        hook_event_name: "Stop",
        stop_hook_active: false,
      }, {
        QUTTY_SOCK: sock,
      });
      const out = JSON.parse(blocked.out);
      assertEquals(out.decision, "block");
      assertStringIncludes(out.reason, "tests are red");
    } finally {
      await f.dispose();
    }
  },
});

Deno.test({
  name: "the shims exit quietly outside Qutty (no QUTTY_SOCK, or a dead one)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const hook = await runHook({ hook_event_name: "Stop" }, {});
    assertEquals(hook, { code: 0, out: "" });
    const dead = await runHook({ hook_event_name: "Stop" }, {
      QUTTY_SOCK: "/tmp/nope.sock",
    });
    assertEquals(dead, { code: 0, out: "" });
    const mcp = await new Deno.Command("bash", {
      args: [MCP_SHIM],
      env: { QUTTY_SOCK: "" },
      stdin: "null",
      stdout: "piped",
    }).output();
    assertEquals(mcp.code, 0);
    assertEquals(mcp.stdout.length, 0);
  },
});

Deno.test("parseHookLine: only qutty hook lines; harness checked", () => {
  assertEquals(
    parseHookLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}'),
    undefined,
  );
  assertEquals(parseHookLine("not json"), undefined);
  assertEquals(
    parseHookLine('{"qutty":"hook","harness":"claude","input":{"a":1}}'),
    {
      harness: "claude",
      input: { a: 1 },
    },
  );
  assertEquals(parseHookLine('{"qutty":"hook","harness":"x y","input":[1]}'), {
    input: {},
  });
});

Deno.test({
  name: "a closed tile's socket goes away; its connections are closed",
  ignore,
  async fn() {
    const f = await fixture();
    const a = new McpClient("a", "1");
    try {
      const sock = spawnFake(f.hub, "pty-1");
      await connect(a, "hub", sock);
      f.hub.ended("pty-1");
      assertEquals(await Deno.lstat(sock).then(() => true, () => false), false);
      assertEquals(f.hub.core.registry.get("pty-1"), undefined);
    } finally {
      await a.disconnect("hub").catch(() => {});
      await f.dispose();
    }
  },
});

Deno.test({
  name:
    "a real PTY: QUTTY_SOCK / QUTTY_TILE_ID / PATH in its environment; read_screen mirrors ANSI output",
  ignore: ignore || !Deno.statSync("/bin/sh").isFile,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await fixture();
    const rec = new Recorder();
    const host = new PtyHost(rec.emit, { tapped: true });
    tapHub(f.hub);
    const client = new McpClient("probe", "1");
    try {
      const { id } = await host.spawn({ cols: 40, rows: 8, shell: "/bin/sh" });
      await rec.waitFor(id, "$", 10_000).catch(() => {});
      await host.write(
        id,
        'printf "S=%s T=%s P=%s\\n" "$QUTTY_SOCK" "$QUTTY_TILE_ID" ":$PATH:"\r',
      );
      await rec.until(
        "env line",
        () => /S=\S+ T=pty-\d+ P=\S+/.test(rec.text(id)),
      );
      const m = rec.text(id).match(/S=(\S+) T=(pty-\d+) P=(\S+)/)!;
      assertEquals(m[1], f.hub.socketPath(id));
      assertEquals(m[2], id);
      // First on PATH as spawned; a login shell's path_helper (macOS) may move it behind the system folders.
      assertStringIncludes(m[3], `:${f.home}/.qutty/bin:`);

      await host.write(
        id,
        "clear; printf '\\033[1;31mRED\\033[0m plain\\n\\033[3;5Hxy\\n'\r",
      );
      await rec.until("printf output", () => rec.text(id).includes("plain"));
      await new Promise((r) => setTimeout(r, 200));
      await connect(client, "hub", m[1]);
      const screen = json(
        await client.callTool("hub", "read_screen", { tile: id }),
      ).screen
        .split("\n");
      assertEquals(screen[0], "RED plain");
      assertEquals(screen[2], "    xy");
      host.resize(id, 30, 6);
      const sb = json(
        await client.callTool("hub", "read_scrollback", {
          tile: id,
          grep: "RED",
        }),
      );
      assertStringIncludes(sb.text, "RED plain");
    } finally {
      await client.disconnect("hub").catch(() => {});
      await host.dispose();
      setPtyTaps(undefined);
      await f.dispose();
    }
  },
});
