// Shared helpers for the hub's real-socket tests (hub_socket_test.ts, companion_socket_test.ts;
// not a test module itself): the shipped shims, whether this system's `nc` speaks unix sockets,
// a hub in a private /tmp folder, and an MCP client through the qutty-mcp shim.

import type { McpClient } from "@rullama/mcp-client";
import { type HubEvent, HubService, prepareSocketDir } from "../desktop/hub.ts";
import { setPtyTaps } from "../desktop/pty.ts";

const ROOT = new URL("../", import.meta.url).pathname;
export const MCP_SHIM = `${ROOT}resources/bin/qutty-mcp`;
export const HOOK_SHIM = `${ROOT}resources/bin/qutty-hook`;

function ncHasUnix(): boolean {
  if (Deno.build.os === "windows") return false;
  try {
    const out = new Deno.Command("sh", {
      args: ["-c", "nc -h 2>&1"],
      stdout: "piped",
    })
      .outputSync();
    return new TextDecoder().decode(out.stdout).includes("-U");
  } catch {
    return false;
  }
}

/** Whether `nc -U` exists (busybox's nc has no `-U`; the shims fall back to socat there). */
export const HAS_NC = ncHasUnix();

export interface Fixture {
  hub: HubService;
  events: { event: HubEvent; data: unknown }[];
  base: string;
  home: string;
  socketDir: string;
  dispose(): Promise<void>;
}

/**
 * A hub in a private /tmp folder (no tiles yet). `write` types into a tile (default: nowhere).
 */
export async function fixture(
  opts: { write?: (id: string, text: string) => Promise<void> } = {},
): Promise<Fixture> {
  // /tmp, not $TMPDIR: macOS's is long, and sun_path holds 104 bytes.
  const base = await Deno.makeTempDir({ dir: "/tmp", prefix: "qh" });
  const home = await Deno.makeTempDir({ prefix: "qutty-home" });
  const socketDir = await prepareSocketDir(base);
  const events: { event: HubEvent; data: unknown }[] = [];
  const hub = new HubService({
    home,
    socketDir,
    emit: (event, data) => events.push({ event, data }),
    write: opts.write ?? (() => Promise.resolve()),
  });
  return {
    hub,
    events,
    base,
    home,
    socketDir,
    async dispose() {
      await hub.stop();
      // Let the reactor's last poll finish before the folders go.
      await new Promise((r) => setTimeout(r, 150));
      await Deno.remove(base, { recursive: true }).catch(() => {});
      await Deno.remove(home, { recursive: true }).catch(() => {});
    },
  };
}

/** An MCP client connected to `sock` through the qutty-mcp shim (`nc -U`). */
export async function connect(
  client: McpClient,
  name: string,
  sock: string,
): Promise<void> {
  await client.connect({
    name,
    command: "bash",
    args: [MCP_SHIM],
    env: { QUTTY_SOCK: sock },
  });
}

/** Tap the PTY extension's host into `hub` (undo with `setPtyTaps(undefined)`). */
export function tapHub(hub: HubService): void {
  setPtyTaps({
    spawning: (id, info) => hub.spawning(id, info),
    data: (id, text) => hub.data(id, text),
    resized: (id, c, r) => hub.resized(id, c, r),
    ended: (id) => hub.ended(id),
  });
}

/** Run the qutty-hook shim with `input` on stdin. */
export async function runHook(
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
  try {
    await w.write(new TextEncoder().encode(JSON.stringify(input, null, 2)));
    await w.close();
  } catch (err) {
    // Outside Qutty the shim exits without reading stdin (that's the behaviour under test), so
    // the write can race its exit and see a broken pipe; the exit code and output still count.
    if (!(err instanceof Deno.errors.BrokenPipe)) throw err;
  }
  const out = await child.output();
  return { code: out.code, out: new TextDecoder().decode(out.stdout) };
}
