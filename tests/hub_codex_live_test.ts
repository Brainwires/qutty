// A real Codex run against the hub, end to end: a hub with real sockets, a real PTY running
// `codex exec` with exactly the arguments the `+` picker adds (lib/hub/launch.ts), and a fake
// peer tile that left a message in Codex's mailbox before it started. Checks that Codex's MCP
// server reaches the hub (`whoami` answers for its tile, harness "codex"), that its hooks fire
// with Codex's own input (SessionStart hands it the pending message as context; busy on the
// prompt, idle at Stop), and that Codex answers the peer with `send_message`.
//
// It makes one small paid model request, so it only runs when asked:
//
//   QUTTY_LIVE_CODEX=1 deno test -A tests/hub_codex_live_test.ts
//
// It needs `codex` signed in (`codex login status`). It uses the user's own CODEX_HOME for the
// login (a copied auth file could rotate the refresh token away from the original) with
// `--ephemeral`, so no session is saved, and changes no config: the hub joins through `-c`
// overrides only. QUTTY_CODEX_MODEL picks the model (default: a small one). With
// QUTTY_CODEX_RECORD=<file>, the hook calls are written there (the fixtures in
// tests/fixtures/codex-hooks.json come from such a run).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { McpClient } from "@rullama/mcp-client";
import { installHubFiles } from "../desktop/hub.ts";
import { PtyHost, setPtyTaps } from "../desktop/pty.ts";
import type { HookOutput } from "../lib/hub/hooks.ts";
import type { HubIdentity } from "../lib/hub/protocol.ts";
import { Recorder } from "./pty_helpers.ts";
import { resultText } from "./hub_helpers.ts";
import { connect, fixture, HAS_NC } from "./socket_helpers.ts";

const LIVE = Deno.env.get("QUTTY_LIVE_CODEX") === "1";
const MODEL = Deno.env.get("QUTTY_CODEX_MODEL") ?? "gpt-6-luna";

/** One hook call as the hub saw it, and the tile's status after it. */
interface HookCall {
  event: string;
  harness?: string;
  input: Record<string, unknown>;
  output: HookOutput;
  status?: string;
}

const PROMPT =
  "Call the qutty MCP tool whoami and print its JSON result. Then call the qutty tool " +
  "read_messages. Then answer every qutty message you have received (in your context or " +
  "from read_messages) with the qutty tool send_message: to the sender's name, replyTo the " +
  "message id, text pong. Do nothing else.";

Deno.test({
  name:
    "live Codex: joins the hub through the picker's flags; hooks deliver a message; it replies",
  ignore: !LIVE || !HAS_NC,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await fixture();
    await installHubFiles(f.hub.paths);
    const work = await Deno.makeTempDir({ prefix: "qutty-codex-work" });
    const rec = new Recorder();
    const host = new PtyHost(rec.emit, { tapped: true });
    const core = f.hub.core;

    // Spy on the hub: every hook call, and which tile whoami answered for.
    const calls: HookCall[] = [];
    const hook = core.hook.bind(core);
    core.hook = (tileId, event, input, harness) => {
      const output = hook(tileId, event, input, harness);
      calls.push({
        event,
        ...(harness ? { harness } : {}),
        input,
        output,
        ...(core.registry.get(tileId)
          ? { status: core.registry.get(tileId)!.status }
          : {}),
      });
      return output;
    };
    // whoami (core.self) from the Codex tile also makes the peer send a second message, mid-turn:
    // the PostToolUse hook after that call should hand it over.
    let codexTile = "";
    const whoami: { tileId: string; harness?: string }[] = [];
    const self = core.self.bind(core);
    core.self = (who: HubIdentity) => {
      const t = self(who);
      if (t.id === codexTile && !whoami.some((w) => w.tileId === t.id)) {
        core.send(
          { role: "tile", tileId: "pty-90" },
          t.id,
          "second ping from peer: reply pong to this one too",
        );
      }
      whoami.push({
        tileId: t.id,
        ...(t.harness ? { harness: t.harness } : {}),
      });
      return t;
    };

    // The peer: a tile with no process, and an MCP client on its socket.
    const peerSock =
      f.hub.spawning("pty-90", { cwd: "/", cols: 80, rows: 24 }).env.QUTTY_SOCK;
    core.registry.rename("pty-90", "peer");
    const peer = new McpClient("peer", "1");
    await connect(peer, "hub", peerSock);

    // The message is left the moment Codex's tile exists, before Codex starts.
    setPtyTaps({
      spawning: (id, info) => {
        const r = f.hub.spawning(id, info);
        codexTile = id;
        core.send(
          { role: "tile", tileId: "pty-90" },
          id,
          "ping from peer: reply to me with the single word pong",
        );
        console.log(
          "--- codex argv after the program:",
          JSON.stringify(r.args),
        );
        return r;
      },
      data: (id, text) => f.hub.data(id, text),
      resized: (id, c, r) => f.hub.resized(id, c, r),
      ended: (id) => f.hub.ended(id),
    });
    try {
      const { id } = await host.spawn({
        cols: 200,
        rows: 50,
        cwd: work,
        program: "codex",
        agent: "codex",
        args: [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "-m",
          MODEL,
          "-c",
          'model_reasoning_effort="low"',
          PROMPT,
        ],
      });
      assertEquals(id, codexTile);
      const exit = await rec.waitExit(id, 240_000);
      console.log(`--- codex exited ${exit.exitCode}; terminal output (tail):`);
      console.log(rec.text(id).slice(-2500));
      console.log("--- hook calls:");
      for (const c of calls) console.log(JSON.stringify(c));
      console.log("--- whoami answered:", JSON.stringify(whoami));
      const record = Deno.env.get("QUTTY_CODEX_RECORD");
      if (record) {
        Deno.writeTextFileSync(record, JSON.stringify(calls, null, 2));
      }

      // MCP: Codex's server process reached the hub through the tile's socket.
      assert(
        whoami.some((w) => w.tileId === id),
        "whoami was not answered for the Codex tile",
      );
      assertEquals(whoami.find((w) => w.tileId === id), {
        tileId: id,
        harness: "codex",
      });

      // Hooks: SessionStart with the pending message; busy on the prompt; idle at the last Stop.
      const events = calls.map((c) => c.event);
      for (const e of ["SessionStart", "UserPromptSubmit", "Stop"]) {
        assert(events.includes(e), `no ${e} hook (got ${events.join(", ")})`);
      }
      assert(calls.every((c) => c.harness === "codex"));
      const start = calls.find((c) => c.event === "SessionStart")!;
      assertStringIncludes(JSON.stringify(start.output), "ping from peer");
      assertEquals(
        calls.find((c) => c.event === "UserPromptSubmit")!.status,
        "busy",
      );
      // The message sent mid-turn came back as PostToolUse context (or, at the latest, a Stop block).
      assert(
        calls.some((c) =>
          (c.event === "PostToolUse" || c.event === "Stop") &&
          JSON.stringify(c.output).includes("second ping")
        ),
        "the mid-turn message was not handed over by a hook",
      );
      assertEquals(calls.findLast((c) => c.event === "Stop")!.status, "idle");

      // The reply reached the peer.
      const inbox = resultText(
        await peer.callTool("hub", "read_messages", {}),
      );
      console.log("--- the peer's inbox:", inbox);
      assertStringIncludes(inbox.toLowerCase(), "pong");
      assertStringIncludes(inbox, id);
    } finally {
      await peer.disconnect("hub").catch(() => {});
      await host.dispose();
      setPtyTaps(undefined);
      await f.dispose();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
