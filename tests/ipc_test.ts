// Local channel paths and transports (desktop/ipc.ts) without a socket: Denext 4.22's
// `localIpcPath` shapes per OS (the unix socket path `QUTTY_SOCK` and the daemon's stay what the
// agent shims and older versions expect), the `sun_path` and name checks, the transport choice,
// and a local IPC connection as the byte endpoint the hub and the daemon client take (a fake
// connection of web streams).
//
// Run: deno task test

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { LocalIpcConnection } from "denext/desktop";
import {
  connectIpc,
  ipcChannelPath,
  ipcEndpoint,
  ipcOs,
  ipcTransport,
  isPipePath,
} from "../desktop/ipc.ts";
import { ptydSocketPath } from "../desktop/ptyd-client.ts";
import { ptydSocketName, ptydSocketVersion } from "../lib/ptyd/protocol.ts";

Deno.test("ipc path: a unix socket in the private folder on macOS and Linux", () => {
  for (const os of ["darwin", "linux"] as const) {
    assertEquals(
      ipcChannelPath("pty-3", { dir: "/tmp/qutty-501/4242", os }),
      "/tmp/qutty-501/4242/pty-3.sock",
    );
  }
});

Deno.test("ipc path: the daemon's socket keeps its versioned name", () => {
  const path = ptydSocketPath("/tmp/qutty-501", 2);
  assertEquals(path, `/tmp/qutty-501/${ptydSocketName(2)}`);
  assertEquals(ptydSocketVersion(path.slice(path.lastIndexOf("/") + 1)), 2);
});

Deno.test("ipc path: a named pipe per app and user on Windows (no folder)", () => {
  const path = ipcChannelPath("ptyd-2", { os: "windows", user: "abc123" });
  assertEquals(path, "\\\\.\\pipe\\org.qutty.Qutty.abc123.ptyd-2");
  assertEquals(isPipePath(path), true);
  assertEquals(isPipePath("/tmp/qutty-501/pty-1.sock"), false);
});

Deno.test("ipc path: refused without a folder, with a bad name, or past sun_path", () => {
  assertThrows(() => ipcChannelPath("pty-1", { os: "darwin" }), TypeError);
  assertThrows(
    () => ipcChannelPath("../x", { dir: "/tmp/q", os: "linux" }),
    TypeError,
  );
  assertThrows(
    () =>
      ipcChannelPath("pty-1", { dir: `/tmp/${"d".repeat(100)}`, os: "darwin" }),
    TypeError,
    "sun_path",
  );
});

Deno.test("ipc transport: libc unix sockets on macOS / Linux, Denext's local IPC on Windows", () => {
  assertEquals(ipcTransport("darwin"), "libc");
  assertEquals(ipcTransport("linux"), "libc");
  assertEquals(ipcTransport("freebsd"), "libc");
  assertEquals(ipcTransport("windows"), "local-ipc");
  assertEquals(ipcOs("freebsd"), "linux");
});

/** A fake `LocalIpcConnection`: what was written, and whether it was closed. */
function fakeConnection(incoming: string[]) {
  const written: string[] = [];
  let closed = 0;
  const utf8 = new TextEncoder();
  const conn: LocalIpcConnection = {
    readable: new ReadableStream({
      start(c) {
        for (const s of incoming) c.enqueue(utf8.encode(s));
        c.close();
      },
    }),
    writable: new WritableStream({
      write: (b) => void written.push(new TextDecoder().decode(b)),
    }),
    close: () => void closed++,
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  return { conn, written, closed: () => closed };
}

Deno.test("ipc endpoint: a local IPC connection as the hub's / daemon client's byte endpoint", async () => {
  const fake = fakeConnection(["hello\n"]);
  const ep = ipcEndpoint(fake.conn);
  assertEquals(await ep.write(new TextEncoder().encode("ping\n")), 5);
  assertEquals(fake.written, ["ping\n"]);
  const chunks: string[] = [];
  for await (const c of ep.readable) chunks.push(new TextDecoder().decode(c));
  assertEquals(chunks, ["hello\n"]);
  await ep.close();
  await ep.close();
  assertEquals(fake.closed(), 1);
});

Deno.test("ipc connect: through connectLocalIpc, with a timeout; a refusal rejects", async () => {
  const fake = fakeConnection([]);
  const asked: [string, unknown][] = [];
  const ep = await connectIpc(
    "\\\\.\\pipe\\org.qutty.Qutty.u.ptyd-2",
    (p, o) => {
      asked.push([p, o]);
      return Promise.resolve(fake.conn);
    },
  );
  assertEquals(asked, [["\\\\.\\pipe\\org.qutty.Qutty.u.ptyd-2", {
    timeoutMs: 2000,
  }]]);
  await ep.close();
  await assertRejects(() =>
    connectIpc("x", () => Promise.reject(new Error("ConnectionRefused")))
  );
});
