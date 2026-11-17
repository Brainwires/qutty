// `QUTTY_PTY_SELFTEST=move`: a tile moved from one window to another in the real app, with real
// windows and a real shell (desktop.ts runs it once the app is up). The main window's page joins
// its workspace and starts its first shell as usual; then:
//
// 1. the shell is given a command that leaves a mark in its state (`cd /tmp`) and in its output;
// 2. a second window opens on a new workspace; its page starts its own shell;
// 3. the main window's tile moves to it, as the tile header's "Move to Window" does
//    (desktop/tile-move.ts): it is the main window's only tile, so that window closes and its
//    workspace ends;
// 4. the shell kept running: its owner is the second window, which shows it (its page adopted it
//    from the replay and saved it in its snapshot, so the move is no longer pending), and it still
//    answers, in the folder it was left in.
//
// It logs `move self-test: OK` and the app exits (1 on failure). Run it under a temporary HOME, so
// the user's app folder, shell history and saved windows are untouched:
//
//   HOME=$(mktemp -d) QUTTY_PTY_SELFTEST=move Qutty.app/Contents/MacOS/laufey_webview

import type { DesktopRuntime } from "denext/desktop";
import { workspaces } from "./workspace-host.ts";
import { terminalSessions } from "./pty.ts";
import { moveTileFrom } from "./session.ts";
import { until } from "./selftest.ts";
import { newWorkspaceId, workspaceWindow } from "../lib/workspace/windows.ts";

type Snap = {
  terminals: { id: string }[];
  tiles: Record<string, { ptyId?: string | null }>;
};

/** The tile of snapshot `snap` on terminal `pty`, with its entry and tile snapshot. */
function tileOn(snap: unknown, pty: string) {
  const s = snap as Snap | null;
  const id = s &&
    Object.entries(s.tiles ?? {}).find(([, t]) => t.ptyId === pty)?.[0];
  const entry = id ? s!.terminals.find((t) => t.id === id) : undefined;
  return id && entry ? { id, entry, tile: s!.tiles[id] } : undefined;
}

export async function moveSelfTest(app: DesktopRuntime): Promise<void> {
  const log = (m: string) => console.error(`move self-test: ${m}`);
  const sessions = terminalSessions();
  const from = await until(
    "main window's workspace",
    () => workspaces.workspaceOfWindow("main"),
  );
  const pty = await until(
    "first shell from the page",
    () => workspaces.ptysOf(from)[0],
  );
  const replay = (window: string) => sessions.handOver(pty, window)?.data ?? "";
  await until("prompt", () => replay("main").length > 0);
  await sessions.host.write(pty, "cd /tmp && echo QUTTY_BEFORE_$((6*7))\r");
  await until(
    "output before",
    () => replay("main").includes("QUTTY_BEFORE_42"),
  );
  const tile = await until(
    "the page's snapshot of the tile",
    () => tileOn(workspaces.snapshotOf(from), pty),
  );
  log(`the page started ${pty} as tile ${tile.id} of "${from}"`);

  const ref = app.windows.open(workspaceWindow(newWorkspaceId(), true));
  const to = await until(
    "the second window's workspace",
    () => workspaces.workspaceOfWindow(ref.id),
  );
  const own = await until("its own shell", () => workspaces.ptysOf(to)[0]);
  log(`opened ${ref.id} on "${to}" with its own shell ${own}`);

  const result = moveTileFrom("main", {
    tileId: tile.id,
    tile: { entry: tile.entry, tile: tile.tile },
    to: { window: ref.id },
    last: true,
  });
  if (!result.moved) throw new Error(`the move failed: ${result.reason}`);
  log(`moved ${tile.id} to ${ref.id} (${result.move})`);

  await until("the main window closing", () => !app.windows.get("main"));
  await until("its workspace ending", () => !workspaces.has(from));
  log("the main window closed (its only tile left) and its workspace ended");
  if (!sessions.host.isRunning(pty)) throw new Error("the shell died");
  if (sessions.ownerOf(pty) !== ref.id) {
    throw new Error(`the owner is ${sessions.ownerOf(pty)}, not ${ref.id}`);
  }
  if (workspaces.workspaceOfPty(pty) !== to) {
    throw new Error("the shell is not in the second window's workspace");
  }
  log(`${pty} runs on, owned by ${ref.id}`);
  const saved = await until(
    "the second page's snapshot with the tile",
    () =>
      workspaces.arrivals(to).length === 0 &&
      tileOn(workspaces.snapshotOf(to), pty),
  );
  log(`the second page shows it as ${saved.id} and saved it`);
  if (!replay(ref.id).includes("QUTTY_BEFORE_42")) {
    throw new Error("the replay lost the output from before the move");
  }
  await sessions.host.write(pty, "echo QUTTY_MOVED_$((7*6)) $(pwd)\r");
  const after = await until("an answer after the move", () => {
    const text = replay(ref.id);
    return /QUTTY_MOVED_42 \S*\/tmp/.test(text) && text;
  });
  log(
    `the shell answers in its folder: ${
      JSON.stringify(
        after.slice(after.lastIndexOf("QUTTY_MOVED_42"), -1).split("\r")[0],
      )
    }`,
  );
  log("OK");
}
