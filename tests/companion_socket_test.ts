// The companion's identity over real sockets: its own socket (in a folder a tile cannot list)
// whose connections may call the companion-only tools. A scripted MCP client on it, through the
// shipped qutty-mcp shim, types into a real PTY tile with write_tile and reads the result back
// with read_screen; the same call from the tile's own socket is refused, and both are in the
// audit log. `qutty-hook say` through the shipped shim reaches the page, and a `--wait` prints
// the button pressed.
//
// Skipped where `nc` has no `-U` (busybox) — the shims fall back to socat there.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { McpClient } from "@rullama/mcp-client";
import { PtyHost, setPtyTaps } from "../desktop/pty.ts";
import { companionSocketDir } from "../desktop/companion.ts";
import { Recorder } from "./pty_helpers.ts";
import { resultText, waitUntil } from "./hub_helpers.ts";
import {
  connect,
  fixture,
  HAS_NC,
  HOOK_SHIM,
  tapHub,
} from "./socket_helpers.ts";

const ignore = !HAS_NC;

const json = (r: { content: { type: string; text?: string }[] }) =>
  JSON.parse(resultText(r));

/** Run `qutty-hook say …` from tile socket `sock`; its stdout, stderr and exit code. */
async function hookSay(sock: string, args: string[]) {
  const out = await new Deno.Command("bash", {
    args: [HOOK_SHIM, "say", ...args],
    env: { QUTTY_SOCK: sock },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(out.stdout).trim(),
    stderr: dec.decode(out.stderr).trim(),
    code: out.code,
  };
}

Deno.test({
  name:
    "companion identity: write_tile into a real PTY tile and read_screen it back; a tile is refused; both audited",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const rec = new Recorder();
    const host = new PtyHost(rec.emit, { tapped: true });
    const f = await fixture({ write: (id, text) => host.write(id, text) });
    const { hub, events, socketDir } = f;
    tapHub(hub);
    const companion = new McpClient("companion", "1");
    const tileClient = new McpClient("tile", "1");
    try {
      await hub.companion.start();
      // The socket's folder can be passed through, not listed.
      const dir = companionSocketDir(socketDir);
      assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o300);
      let listed = true;
      try {
        for await (const _ of Deno.readDir(dir)) break;
      } catch {
        listed = false;
      }
      assertEquals(listed, false, "a tile cannot list the companion's folder");
      assertEquals(
        JSON.parse(await Deno.readTextFile(hub.companion.mcpConfig))
          .mcpServers.qutty.env.QUTTY_SOCK,
        hub.companion.socket,
      );

      const { id } = await host.spawn({ cols: 60, rows: 10, shell: "/bin/sh" });
      await rec.waitFor(id, "$", 10_000).catch(() => {});
      await connect(companion, "hub", hub.companion.socket);
      assertEquals(
        json(await companion.callTool("hub", "whoami", {})),
        { role: "companion" },
      );

      const wrote = await companion.callTool("hub", "write_tile", {
        tile: id,
        text: "echo companion-wrote-$((6*7))\r",
      });
      assertEquals(wrote.isError, undefined);
      const screen = await waitUntil(
        async () => {
          const s = json(
            await companion.callTool("hub", "read_screen", { tile: id }),
          )
            .screen as string;
          return s.split("\n").includes("companion-wrote-42") ? s : null;
        },
        10_000,
        "the written command's output on the screen",
      );
      // The typed command is echoed, but a long prompt (a CI VM's "host:~ user$") can wrap it
      // onto the next screen row, so compare with the row breaks removed.
      assertStringIncludes(
        (screen ?? "").replaceAll("\n", ""),
        "echo companion-wrote-$((6*7))",
      );

      // The tile's own socket: the same tool is refused.
      await connect(tileClient, "hub", hub.socketPath(id));
      const denied = await tileClient.callTool("hub", "write_tile", {
        tile: id,
        text: "echo nope\r",
      });
      assert(denied.isError);
      assertStringIncludes(resultText(denied), "companion only");

      const audit = hub.companion.audit.recent();
      assertEquals(audit.map((e) => [e.tool, e.by, e.ok]), [
        ["write_tile", id, false],
        ["write_tile", "companion", true],
      ]);
      assert(
        events.some((e) =>
          e.event === "companion" &&
          (e.data as { kind: string }).kind === "activity"
        ),
        "the page hears about each entry",
      );
    } finally {
      await companion.disconnect("hub").catch(() => {});
      await tileClient.disconnect("hub").catch(() => {});
      await host.dispose();
      setPtyTaps(undefined);
      await f.dispose();
      const gone = await Deno.stat(companionSocketDir(socketDir)).then(
        () => false,
        () => true,
      );
      assert(gone, "stop() removes the companion's folder");
    }
  },
});

Deno.test({
  name:
    "qutty-hook say: through the shim to the page; --wait prints the button pressed; refusals exit 1",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const f = await fixture();
    const { hub, events } = f;
    try {
      const sock = hub.spawning("pty-1", { cwd: "/", cols: 80, rows: 24 }).env
        .QUTTY_SOCK;
      const quick = await hookSay(sock, [
        "Tests",
        'passed "fine"',
        "--mood",
        "success",
      ]);
      assertEquals([quick.code, quick.stdout, quick.stderr], [0, "", ""]);
      const say = events.find((e) => e.event === "say")!.data as {
        message: { text: string; mood: string; from: string };
        wait: boolean;
      };
      assertEquals(say.message.text, 'Tests passed "fine"');
      assertEquals(say.message.mood, "success");
      assertEquals(say.message.from, "shell-1");
      assertEquals(say.wait, false);

      const waiting = hookSay(sock, [
        "Deploy?",
        "--action",
        "yes:Deploy now",
        "--action",
        "no:Later",
        "--wait",
      ]);
      const asked = await waitUntil(
        () =>
          events.filter((e) => e.event === "say")[1]?.data as
            | { message: { id: string } }
            | undefined,
        5000,
        "the waited say",
      );
      hub.companion.sayDone(asked!.message.id, "yes");
      const answered = await waiting;
      assertEquals([answered.code, answered.stdout], [0, "yes"]);

      const refused = await hookSay(sock, ["hi", "--mood", "angry"]);
      assertEquals(refused.code, 1);
      assertStringIncludes(refused.stderr, "mood must be one of");
    } finally {
      await f.dispose();
    }
  },
});
