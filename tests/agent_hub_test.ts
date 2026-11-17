// An agent tile in the real hub (desktop/hub.ts over real sockets, with a scripted adapter for
// Claude Code): its session is a hub tile with a socket of its own, whose MCP connection alone
// lists `approve_tool`; the permission round trip over that socket (Claude Code's
// --permission-prompt-tool → the `agent` event the page shows → the page's answer → the JSON
// Claude Code expects); another tile's `read_screen` reads its transcript; the companion's
// `write_tile` sends it a prompt; its tile goes when its session ends.
//
// Skipped where `nc` has no `-U` (the qutty-mcp shim needs it, or socat).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { McpClient } from "@rullama/mcp-client";
import type {
  AgentAdapter,
  AgentMessage,
  AgentSessionSpec,
  AgentSink,
} from "../lib/agent/adapter.ts";
import type { AgentUpdate } from "../lib/agent/sessions.ts";
import { resultText, waitUntil } from "./hub_helpers.ts";
import { connect, fixture, HAS_NC } from "./socket_helpers.ts";

/** Answers every message with one line of text. */
class EchoAdapter implements AgentAdapter {
  readonly label = "echo";
  readonly images = false;
  static last: EchoAdapter | undefined;
  env: Record<string, string> = {};
  sink: AgentSink | undefined;
  sent: string[] = [];
  constructor(env: Record<string, string>) {
    this.env = env;
    EchoAdapter.last = this;
  }
  start(_spec: AgentSessionSpec, sink: AgentSink) {
    this.sink = sink;
    return Promise.resolve();
  }
  send(m: AgentMessage) {
    this.sent.push(m.text);
    this.sink?.event({
      kind: "text",
      id: `m${this.sent.length}`,
      delta: `echo: ${m.text}`,
      at: 0,
    });
    this.sink?.event({
      kind: "turnEnd",
      isError: false,
      subtype: "success",
      at: 0,
    });
    return Promise.resolve();
  }
  interrupt() {
    return Promise.resolve();
  }
  stop() {}
}

Deno.test({
  name:
    "agent tile in the hub: its socket, approve_tool over MCP, read_screen, write_tile",
  ignore: !HAS_NC,
  async fn() {
    const f = await fixture({
      createAgent: (_spec, tile) => new EchoAdapter(tile.env),
    });
    const agent = new McpClient("claude-code", "1.0");
    const peer = new McpClient("test-peer", "1.0");
    try {
      const snap = f.hub.agents.start({ cwd: "/tmp" });
      assertEquals(snap.id, "agent-1");
      const sock = `${f.socketDir}/agent-1.sock`;
      assertEquals(Deno.lstatSync(sock).isSocket, true);
      assertEquals(f.hub.core.registry.get("agent-1")?.harness, "claude");

      // A plain terminal tile beside it.
      const { env } = f.hub.spawning("pty-1", { cwd: "/", cols: 80, rows: 24 });
      await connect(peer, "hub", env.QUTTY_SOCK);
      await connect(agent, "hub", sock);
      const listed = (await agent.listTools("hub")).map((t) => t.name);
      assert(listed.includes("approve_tool"));
      assert(
        !(await peer.listTools("hub")).some((t) => t.name === "approve_tool"),
      );

      // A message starts the adapter with the tile's socket in its environment.
      assert(f.hub.agents.send("agent-1", { text: "hello" }));
      await waitUntil(() => EchoAdapter.last?.sent.length === 1, 2000, "sent");
      assertEquals(EchoAdapter.last!.env.QUTTY_SOCK, sock);
      assertEquals(EchoAdapter.last!.env.QUTTY_TILE_ID, "agent-1");

      // Claude Code's permission question, over the socket.
      const asking = agent.callTool("hub", "approve_tool", {
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "toolu_1",
      });
      const question = await waitUntil(
        () =>
          f.events.map((e) => e.data as AgentUpdate).find((u) =>
            u && "event" in u && u.event.kind === "permission"
          ),
        3000,
        "the question event",
      );
      assert(
        question && "event" in question && question.event.kind === "permission",
      );
      assertEquals(f.events.find((e) => e.data === question)?.event, "agent");
      assertEquals(f.hub.core.registry.get("agent-1")?.status, "waiting");
      f.hub.agents.answer("agent-1", question.event.requestId, "allow");
      assertEquals(JSON.parse(resultText(await asking)), {
        behavior: "allow",
        updatedInput: { command: "ls" },
      });

      // Another tile reads its screen: the transcript.
      const screen = JSON.parse(resultText(
        await peer.callTool("hub", "read_screen", { tile: "agent-1" }),
      ));
      assertStringIncludes(screen.screen, "> hello");
      assertStringIncludes(screen.screen, "● echo: hello");
      const grep = JSON.parse(resultText(
        await peer.callTool("hub", "read_scrollback", {
          tile: "agent-1",
          grep: "echo",
        }),
      ));
      assertStringIncludes(grep.text, "echo: hello");

      // The companion types a prompt into it (Enter sends it).
      await f.hub.core.writeTile("agent-1", "run the tests\r");
      await waitUntil(() => EchoAdapter.last!.sent.length === 2, 2000, "typed");
      assertEquals(EchoAdapter.last!.sent[1], "run the tests");

      // The tile closes: its hub tile and socket go.
      f.hub.agents.stop("agent-1");
      assertEquals(f.hub.core.registry.get("agent-1"), undefined);
      assertEquals(await Deno.lstat(sock).then(() => true, () => false), false);
    } finally {
      await agent.disconnect("hub").catch(() => {});
      await peer.disconnect("hub").catch(() => {});
      await f.dispose();
    }
  },
});
