// The hub's poll loop (desktop/hub-socket.ts `FdReactor`) on plain pipes: an fd closed during a
// poll round and handed out again under the same number (the next `accept` or `pipe` gets the
// lowest free fd) must never get the old file's revents. It did, and on Linux that hung the
// sandbox_hub test: the old connection's POLLIN|POLLHUP went to a freshly accepted one, whose
// `read` then blocked the event loop with nothing to read.

import { assertEquals } from "@std/assert";
import { FdReactor } from "../desktop/hub-socket.ts";

const ignore = Deno.build.os === "windows";

const libc = ignore ? undefined : Deno.dlopen(
  Deno.build.os === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  {
    pipe: { parameters: ["buffer"], result: "i32" },
    write: { parameters: ["i32", "buffer", "usize"], result: "isize" },
    read: { parameters: ["i32", "buffer", "usize"], result: "isize" },
    close: { parameters: ["i32"], result: "i32" },
  },
).symbols;

/** A fresh pipe: [read end, write end]. */
function pipe(): [number, number] {
  const fds = new Int32Array(2);
  if (libc!.pipe(new Uint8Array(fds.buffer)) !== 0) throw new Error("pipe");
  return [fds[0], fds[1]];
}

const put = (fd: number) => libc!.write(fd, new Uint8Array([1]), 1n);
const drain = (fd: number) => libc!.read(fd, new Uint8Array(64), 64n);

/** Wait out the poll in flight (POLL_MS = 100) so no op outlives the test. */
const idle = () => new Promise((r) => setTimeout(r, 250));

Deno.test({
  name:
    "FdReactor: an fd closed and reused in the same round never gets the old fd's revents",
  ignore,
  async fn() {
    const reactor = new FdReactor();
    const quiet = pipe(); // keeps the loop polling, never readable
    const listener = pipe(); // stands in for a listening socket
    const old = pipe(); // stands in for a connection that is closing
    const calls: string[] = [];
    let fresh: [number, number] | undefined;
    let written = false; // drain only what was written (an empty pipe's read would block)
    reactor.watch(quiet[0], () => calls.push("quiet"));
    // Both readable before the round that polls them begins: one round reports both.
    put(listener[1]);
    put(old[1]);
    reactor.watch(listener[0], () => {
      drain(listener[0]);
      if (fresh) return;
      // The old connection goes, and a new one arrives (it may get the old one's number).
      reactor.close(old[0]);
      fresh = pipe();
      reactor.watch(fresh[0], () => {
        calls.push("fresh");
        if (written) drain(fresh![0]);
        else reactor.unwatch(fresh![0]);
      });
    });
    reactor.watch(old[0], () => calls.push("old"));
    await idle();
    // The fresh pipe was never written to: nothing may have been dispatched to it.
    assertEquals(calls, []);
    // It still works once it has something to read.
    written = true;
    put(fresh![1]);
    await idle();
    assertEquals(calls, ["fresh"]);
    for (const fd of [quiet[0], listener[0], fresh![0]]) reactor.close(fd);
    for (const fd of [quiet[1], listener[1], old[1], fresh![1]]) {
      libc!.close(fd);
    }
    await idle();
  },
});
