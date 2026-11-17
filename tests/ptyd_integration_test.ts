// The PTY daemon for real, in this process: `runPtyDaemon` on a unix socket in a private temp
// folder (libc FFI, the peer uid check), real shells through `Deno.openPty` (denext's toolchain,
// `deno task test`). A client starts a shell and sets a variable, lets it go and disconnects; a
// second client finds it, attaches with its replay and the shell still has the variable; it is
// detached and reattached once more, then ended, and the daemon exits on its own.

import { assert, assertEquals } from "@std/assert";
import { runPtyDaemon } from "../desktop/ptyd.ts";
import {
  connectPtyd,
  otherDaemons,
  type PtydClient,
  ptydSocketPath,
  type RemotePty,
} from "../desktop/ptyd-client.ts";
import { runtimeOpenPty } from "../desktop/pty.ts";
import { privateDir } from "../desktop/hub-socket.ts";
import { until } from "./session_helpers.ts";

const ignore = Deno.build.os === "windows" || runtimeOpenPty() === undefined ||
  !(() => {
    try {
      return Deno.statSync("/bin/sh").isFile;
    } catch {
      return false;
    }
  })();

/** Collect a terminal's output as text. */
function collect(pty: RemotePty): { text: () => string; done: Promise<void> } {
  let text = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    for await (const chunk of pty.readable) {
      text += decoder.decode(chunk, { stream: true });
    }
  })();
  return { text: () => text, done };
}

async function write(pty: RemotePty, s: string): Promise<void> {
  const w = pty.writable.getWriter();
  try {
    await w.write(new TextEncoder().encode(s));
  } finally {
    w.releaseLock();
  }
}

Deno.test({
  name:
    "ptyd integration: a shell outlives its client and is reattached with its replay",
  ignore,
  // The FFI library and the socket poll loop live for the process.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Short: a socket path must fit `sun_path` (104 bytes on macOS).
    const dir = await privateDir(
      await Deno.makeTempDir({ dir: "/tmp", prefix: "qp-" }),
    );
    const logs: string[] = [];
    const served = runPtyDaemon({ dir, log: (m) => logs.push(m) });
    const path = ptydSocketPath(dir);
    let first: PtydClient | undefined;
    await until("the socket", () => {
      try {
        return Deno.statSync(path).isSocket === true;
      } catch {
        return false;
      }
    });
    first = await connectPtyd(path);
    assertEquals((await first.hello()).v, 1);
    const pty = await first.open("pty-1", {
      cmd: "/bin/sh",
      args: [],
      cwd: "/tmp",
      env: { PATH: "/usr/bin:/bin", PS1: "$ ", HOME: "/tmp" },
      cols: 80,
      rows: 24,
    });
    const out = collect(pty);
    await until("a prompt", () => out.text().includes("$ "));
    await write(pty, "QP=kept42; export QP; echo SET_$((1+1))\r");
    await until("the export", () => out.text().includes("SET_2"));
    pty.detach();
    await first.request("setState", { state: { note: "kept" } });
    await first.close();
    first = undefined;

    // Another version's daemon is not this one.
    assertEquals(await otherDaemons(dir), []);

    const second = await connectPtyd(path);
    assertEquals((await second.request("getState", {})).state, {
      note: "kept",
    });
    const [s] = await second.list();
    assertEquals([s.sid, s.attached, s.exit], ["pty-1", false, undefined]);
    const adopted = await second.adopt(s.sid, s.pid);
    assert(adopted.replay.includes("SET_2"), "the replay has the old output");
    const again = collect(adopted.pty);
    await write(adopted.pty, "echo VAL_$QP\r");
    await until("the variable", () => again.text().includes("VAL_kept42"));

    // Detach and reattach once more, on the same connection.
    adopted.pty.detach();
    await second.request("list", {});
    const third = await second.adopt("pty-1", s.pid);
    assert(third.replay.includes("VAL_kept42"));
    const last = collect(third.pty);
    await write(third.pty, "exit 7\r");
    assertEquals((await third.pty.status).code, 7);
    await last.done;
    await second.request("release", { sid: "pty-1" });
    await second.close();
    // Nothing runs and nobody is connected: the daemon ends by itself.
    await served;
    assert(logs.some((l) => l.startsWith("serving ")), logs.join("\n"));
    assert(logs.includes("idle: exiting"), logs.join("\n"));
    await Deno.remove(dir, { recursive: true });
  },
});
