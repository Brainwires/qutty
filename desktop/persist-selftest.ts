// `QUTTY_PTY_SELFTEST=persist`: a check, in the packaged app, that a shell survives quitting the
// app (desktop/kept-shells.ts, desktop/ptyd.ts). Run the app twice under the same temporary HOME
// (and `QUTTY_PTYD_DIR`, a private folder for the daemon's socket):
//
// 1. first launch: a shell is started in a workspace of its own, in the PTY daemon; it is given
//    `export QUTTY_PERSIST=<token>`; the quit that keeps the shells runs (`keepForNextLaunch`),
//    and the app exits. A marker in HOME names the token and the terminal.
// 2. second launch: the workspace comes back with the terminal adopted from the daemon; the shell
//    is asked for `$QUTTY_PERSIST` and must answer the token; the workspace is ended (the shell
//    with it) and the app exits.
//
// Each launch logs `persist self-test: ...` and exits 0 (1 on failure):
//
//   HOME=$H QUTTY_PTYD_DIR=$H/ptyd QUTTY_PTY_SELFTEST=persist Qutty.app/Contents/MacOS/laufey_webview

import type { TerminalSessions } from "./terminal-sessions.ts";
import type { ShellKeeper } from "./kept-shells.ts";
import { workspaces } from "./workspace-host.ts";
import { writeFileAtomic } from "./libc.ts";
import { unlinkPath } from "./hub-socket.ts";

const TIMEOUT_MS = 30_000;
const WORKSPACE = "persist-selftest";
const WINDOW = "persist-selftest-window";

const log = (m: string) => console.error(`persist self-test: ${m}`);

/** Run a self-test once the app is up, then exit (1 on failure). */
export function runSelfTest(name: string, fn: () => Promise<void>): void {
  setTimeout(() =>
    fn().then(() => Deno.exit(0), (e) => {
      console.error(`${name} self-test: FAILED: ${e?.message ?? e}`);
      Deno.exit(1);
    }), 3000);
}

async function until<T>(
  what: string,
  fn: () => T | undefined | null | false | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`no ${what} in time`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function replayOf(sessions: TerminalSessions, pty: string): string {
  return sessions.attachWorkspace(WORKSPACE, WINDOW)
    .find((r) => r.id === pty)?.data ?? "";
}

export async function persistSelfTest(
  sessions: TerminalSessions,
  keeper: ShellKeeper,
): Promise<void> {
  const home = Deno.env.get("HOME") ?? "";
  const markerPath = `${home}/.qutty-persist-selftest.json`;
  await keeper.ready;
  const marker = await Deno.readTextFile(markerPath).then(
    (t) => JSON.parse(t) as { token: string; pty: string },
    () => undefined,
  );
  if (!marker) {
    log("first launch: starting a shell in the PTY daemon");
    workspaces.restore({ id: WORKSPACE, name: "Persist test", snapshot: null });
    const token = crypto.randomUUID().slice(0, 8);
    const started = await sessions.restoreShell(
      WORKSPACE,
      { cols: 80, rows: 24, cwd: home },
      "",
    );
    if (!sessions.host.isRemote(started.id)) {
      throw new Error("the shell runs in the app, not in the PTY daemon");
    }
    log(`${started.id} (pid ${started.pid}) runs in the daemon`);
    await until("prompt", () => replayOf(sessions, started.id).length > 0);
    await sessions.host.write(
      started.id,
      `export QUTTY_PERSIST=${token}; echo QP_SET\r`,
    );
    await until(
      "the export",
      () => replayOf(sessions, started.id).includes("QP_SET\r\n"),
    );
    const kept = await keeper.keepForNextLaunch();
    log(`quit keeping ${kept} shell(s)`);
    if (kept < 1) throw new Error("nothing was kept");
    // Through libc: the packaged app has no --allow-write.
    writeFileAtomic(
      markerPath,
      new TextEncoder().encode(JSON.stringify({ token, pty: started.id })),
      0o600,
    );
    log("first launch: OK");
    return;
  }
  log(`second launch: looking for ${marker.pty}`);
  await until(
    "the kept workspace",
    () => workspaces.ptysOf(WORKSPACE).includes(marker.pty),
  );
  if (!sessions.host.isRemote(marker.pty)) {
    throw new Error("the kept shell was not adopted from the daemon");
  }
  const before = replayOf(sessions, marker.pty);
  log(`adopted ${marker.pty} with ${before.length} chars of replay`);
  await sessions.host.write(
    marker.pty,
    `printf 'QP<%s>\\n' "$QUTTY_PERSIST"\r`,
  );
  await until(
    "the variable",
    () => replayOf(sessions, marker.pty).includes(`QP<${marker.token}>`),
  );
  log(`the shell still has QUTTY_PERSIST=${marker.token}`);
  workspaces.end(WORKSPACE);
  await until("the shell's end", () => !sessions.host.isRunning(marker.pty));
  unlinkPath(markerPath);
  log("OK");
}
