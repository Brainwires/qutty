// `QUTTY_PTY_SELFTEST=detach`: a check of detach / reattach in the real app, with real windows
// (desktop.ts runs it once the app is up). The main window's page joins its workspace and starts
// its first shell as usual; then:
//
// 1. the shell is given a command that prints only after the window is gone;
// 2. the main window is closed: its workspace detaches, the shell keeps running, the app stays up;
// 3. the output arrives while no window shows the workspace;
// 4. the workspace's window is opened again (as the Dock, Reopen Closed Window or the Workspaces
//    menu do): its page joins, takes the shell back (the PTY's owner is the new window), restores
//    its tile on the same PTY (the snapshot it saves names it) and gets the missed output in the
//    replay; the shell still answers.
//
// It logs `detach self-test: OK` and the app exits (1 on failure). Run it under a temporary HOME,
// so the user's app folder, shell history and saved windows are untouched:
//
//   HOME=$(mktemp -d) QUTTY_PTY_SELFTEST=detach Qutty.app/Contents/MacOS/laufey_webview

import type { DesktopRuntime } from "denext/desktop";
import { workspaces } from "./workspace-host.ts";
import { terminalSessions } from "./pty.ts";
import { workspaceWindow } from "../lib/workspace/windows.ts";

const TIMEOUT_MS = 30_000;
const WORKSPACE = "main";

/** Poll `fn` until it returns something truthy. */
async function until<T>(
  what: string,
  fn: () => T | undefined | null | false,
  ms = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`no ${what} in ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The replay a window would get for `pty` now (attaching it to `window` again). */
function replayOf(pty: string, window: string): string {
  return terminalSessions().attachWorkspace(WORKSPACE, window)
    .find((r) => r.id === pty)?.data ?? "";
}

export async function detachSelfTest(app: DesktopRuntime): Promise<void> {
  const log = (m: string) => console.error(`detach self-test: ${m}`);
  const sessions = terminalSessions();
  const pty = await until(
    "first shell from the page",
    () => workspaces.ptysOf(WORKSPACE)[0],
  );
  await until("prompt", () => replayOf(pty, "main").length > 0);
  log(`the page started ${pty} in workspace "${WORKSPACE}"`);
  await sessions.host.write(pty, "sleep 2; echo QUTTY_DETACHED_$((6*7))\r");

  app.windows.get("main")?.close();
  await until(
    "detach",
    () =>
      workspaces.list().find((w) => w.id === WORKSPACE)?.state === "detached",
  );
  if (!sessions.host.isRunning(pty)) {
    throw new Error("the shell died with its window");
  }
  if (sessions.ownerOf(pty) !== undefined) {
    throw new Error("the shell still has an owner");
  }
  log("window closed: the workspace is detached, the shell runs on");
  // A marker in the saved snapshot: the reattached page replaces it with its own.
  const before = workspaces.snapshotOf(WORKSPACE) as
    | Record<string, unknown>
    | null;
  workspaces.save(WORKSPACE, { ...before, selftest: true });

  await new Promise((r) => setTimeout(r, 3500));
  const ref = app.windows.open(workspaceWindow(WORKSPACE));
  await until("reattach", () => sessions.ownerOf(pty) === ref.id);
  log(`reopened as ${ref.id}: the page took ${pty} back`);
  const saved = await until("the restored tile's snapshot", () => {
    const snap = workspaces.snapshotOf(WORKSPACE) as
      | Record<string, unknown>
      | null;
    return snap && snap.selftest !== true &&
      JSON.stringify(snap).includes(`"${pty}"`) && snap;
  });
  log(
    `the page restored ${
      JSON.stringify(saved).length
    } chars of snapshot on ${pty}`,
  );
  const replay = replayOf(pty, ref.id);
  if (!replay.includes("QUTTY_DETACHED_42")) {
    throw new Error(
      `the replay lacks the detached output: ${
        JSON.stringify(replay.slice(-200))
      }`,
    );
  }
  log("the replay has the output printed while detached");
  await sessions.host.write(pty, "echo QUTTY_BACK_$((7*6))\r");
  await until(
    "answer after reattach",
    () => replayOf(pty, ref.id).includes("QUTTY_BACK_42"),
  );
  log("the shell answers after the reattach");
  log("OK");
}
