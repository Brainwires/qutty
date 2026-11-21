// The `ptyd` sidecar (`desktop.sidecars`): how the PTY daemon (desktop/ptyd.ts) is started.
//
// Denext ends its sidecars with the app (a module sidecar is a worker of the app's process), and
// has no process that outlives it. So the sidecar only starts the daemon: in its worker it checks
// whether a daemon of this protocol version answers, and if none does it starts one with
// `denextSidecar.spawnSelf` — the app's own executable again, headless (no window, no web
// engine), running this module as `denextSidecar.child` — detached into a session of its own
// (`setsid`, so the app's quit does not hang it up), its IPC channel and stdio dropped, so
// nothing ties it to the app. The child serves the socket until it is idle (desktop/ptyd.ts).
//
// Under `deno run` (`deno task desktop`) the child is `deno run` of the app's entry with the
// app's own flags, the same way.
//
// The sidecar child contract has an IPC channel (`spawnSelf`'s `detached` / `stdio` are Node's,
// passed through untyped), so the child drops the channel itself and the starter unrefs it.
//
// Why not Denext 4.22's detached sidecar (`detached: { exitAfterMs?, keepAcrossUpdates? }`): it
// outlives the app's quit, but not the way kept shells must.
// - Installing a full-app update stops every detached sidecar (`killSidecarsNow("update")`), with
//   or without `keepAcrossUpdates`: an update would end the shells the user kept. This daemon
//   is untouched by an update.
// - It is one instance per sidecar name. At launch an instance another app version started is
//   shut down and replaced unless `keepAcrossUpdates`, and with it the new version reattaches
//   to the old daemon whatever protocol it speaks, and starts none of its own. Here daemons of
//   two protocol versions run side by side (`ptyd-<v>.sock`), and the newer app asks the user
//   what to do with the older one's shells (desktop/kept-shells.ts). Naming the sidecar per
//   protocol version does not help: a record no declared sidecar names is cleaned up at launch.
// So the daemon keeps its own launch and lifetime (it ends itself once idle, desktop/ptyd.ts).

import { connectPtyd, ptydDir, ptydSocketPath } from "./ptyd-client.ts";
import { runPtyDaemon } from "./ptyd.ts";

/** The parts of Node's `ChildProcess` used here. */
interface ChildLike {
  pid?: number;
  unref(): void;
  disconnect?(): void;
  on(event: "error", fn: (err: Error) => void): void;
}

/** `globalThis.denextSidecar` (desktop/ptyd-sidecar.ts runs as a module sidecar). */
interface SidecarGlobal {
  name: string;
  child?: boolean;
  ready(): void;
  spawnSelf(
    args: string[],
    options?: { detached?: boolean; stdio?: unknown },
  ): ChildLike;
}

const sidecar = (globalThis as { denextSidecar?: SidecarGlobal }).denextSidecar;

/** Whether a daemon of this version answers in `dir`. */
async function answers(dir: string): Promise<boolean> {
  try {
    const c = await connectPtyd(ptydSocketPath(dir));
    await c.close();
    return true;
  } catch {
    return false;
  }
}

/** How long the starter waits for the daemon it started to answer. */
const START_WAIT_MS = 10_000;

if (sidecar?.child) {
  // The daemon. Once it listens it drops the IPC channel to the app that started it (it outlives
  // that app).
  const { default: process } = await import("node:process");
  await runPtyDaemon({
    dir: await ptydDir(),
    onListening: () => {
      try {
        (process as { disconnect?: () => void }).disconnect?.();
      } catch { /* no channel */ }
    },
  });
  Deno.exit(0);
} else if (sidecar) {
  try {
    const dir = await ptydDir();
    if (!(await answers(dir))) {
      const child = sidecar.spawnSelf(["ptyd"], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", (err) => console.error("ptyd: could not start", err));
      const deadline = Date.now() + START_WAIT_MS;
      let up = false;
      while (!up && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        up = await answers(dir);
      }
      try {
        child.disconnect?.();
      } catch { /* the child dropped it first */ }
      child.unref();
      console.error(
        up
          ? `ptyd: the PTY daemon runs (pid ${child.pid ?? "?"})`
          : "ptyd: the PTY daemon did not answer; shells run in the app",
      );
    }
  } catch (err) {
    console.error("ptyd: could not start the PTY daemon", err);
  }
  sidecar.ready();
}
