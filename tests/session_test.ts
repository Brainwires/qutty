// Detachable sessions end to end in the app's process: the real `pty` and `session` extensions
// (desktop/pty.ts, desktop/session.ts) with real shells, driven through their handlers with a fake
// extension host whose windows open, close and quit (tests/session_helpers.ts).
//
// - a window's terminals' events reach that window only, and another window cannot touch them;
// - closing the window detaches its workspace: the shells keep running, output printed while no
//   window shows them is kept, and the window that shows the workspace next gets it in the replay
//   and the live output after it;
// - an exit while detached comes back with the replay; closing the tile releases the terminal;
// - ending a workspace kills its terminals; the app's quit kills the rest;
// - the quit guard asks with the OS's message box (`host.confirm`), with no window open;
// - the Window menu's "Close Window and End Its Shells": the window used last closes, its
//   workspace is ended after the close and its key forgotten; a busy agent is asked about first.
//
// Run: deno test -A tests/

import { assert, assertEquals, assertRejects } from "@std/assert";
import { DesktopCapError } from "denext/desktop";
import ptyExt, { terminalSessions } from "../desktop/pty.ts";
import sessionExt, {
  closeQuestion,
  createEndWindow,
  guardQuit,
  quitQuestion,
  type SessionEndWindow,
  type SessionJoin,
} from "../desktop/session.ts";
import { workspaces } from "../desktop/workspace-host.ts";
import { forgetEndedWorkspaces } from "../desktop/windows.ts";
import { HAS_SH, marker, POSIX, warmUp } from "./pty_helpers.ts";
import {
  ctxOf,
  fakeExtensionHost,
  fakeRuntimeWindows,
  until,
} from "./session_helpers.ts";

await warmUp();

const ignore = !POSIX || !HAS_SH;
const SH = { cols: 80, rows: 24, shell: "/bin/sh", cwd: "/tmp" };
const pty = ptyExt.methods;
const session = sessionExt.methods;

/** A fresh app: both extensions set up on one fake host, the registry empty. */
function app(windows: Parameters<typeof fakeExtensionHost>[0]) {
  workspaces.clear();
  const fake = fakeExtensionHost(windows);
  ptyExt.setup(fake.host);
  sessionExt.setup(fake.host);
  return fake;
}

const join = (window: string) =>
  session.join.handler({}, ctxOf(window)) as SessionJoin;

Deno.test({
  name:
    "session: a closed window's shells keep running and come back with what they printed",
  ignore,
  // The fake host's windows never really go away; the shells are reaped at the quit below.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = app([
      { id: "main", kind: "main", key: "ws-a" },
      { id: "w2", kind: "window", key: "ws-b" },
    ]);
    assertEquals(join("main").workspace.id, "ws-a");
    assertEquals(join("w2").workspace.id, "ws-b");
    const a1 = await pty.spawn.handler(SH, ctxOf("main"));
    const a2 = await pty.spawn.handler(SH, ctxOf("main"));
    const b = await pty.spawn.handler(SH, ctxOf("w2"));
    try {
      // Events go to the owner window only.
      const mk = marker("routed");
      await pty.write.handler(
        { id: a1.id, data: `${mk.cmd}\r` },
        ctxOf("main"),
      );
      await until(
        "a1's output",
        () => fake.text(a1.id, "main").includes(mk.text),
      );
      assertEquals(fake.text(a1.id, "w2"), "");
      assert(
        !fake.events.some((e) => e.event === "data" && e.window === undefined),
      );
      // Another window's calls cannot reach it.
      await assertRejects(
        () => pty.write.handler({ id: a1.id, data: "x" }, ctxOf("w2")),
        DesktopCapError,
        "no such terminal",
      );

      // a1 prints after its window is gone; a2 exits while detached.
      await pty.write.handler({
        id: a1.id,
        data: "sleep 1; echo DETACHED_$((6*7))\r",
      }, ctxOf("main"));
      await pty.write.handler(
        { id: a2.id, data: "sleep 1; exit 3\r" },
        ctxOf("main"),
      );
      await fake.close("main");
      assertEquals(
        workspaces.list().find((w) => w.id === "ws-a")?.state,
        "detached",
      );
      assertEquals(terminalSessions().ownerOf(a1.id), undefined);
      const sent = fake.events.length;
      await new Promise((r) => setTimeout(r, 2000));
      assert(
        terminalSessions().host.isRunning(a1.id),
        "a1 died with its window",
      );
      // Nothing was sent anywhere for the detached terminals.
      assert(
        !fake.events.slice(sent).some((e) =>
          [a1.id, a2.id].includes((e.data as { id: string }).id)
        ),
      );

      // The workspace's window opens again (its key): the page joins and gets both back.
      fake.open({ id: "w3", kind: "window", key: "ws-a" });
      const back = join("w3");
      assertEquals(back.workspace.id, "ws-a");
      const r1 = back.ptys.find((p) => p.id === a1.id)!;
      const r2 = back.ptys.find((p) => p.id === a2.id)!;
      assert(
        r1.data.includes("DETACHED_42"),
        "the detached output is replayed",
      );
      assert(r1.data.includes(mk.text), "so is what came before");
      assertEquals(r1.exit, undefined);
      assertEquals([r1.cols, r1.rows], [80, 24]);
      assert(r1.seq > 0 && !r1.truncated);
      assertEquals(r2.exit?.exitCode, 3, "the exit while detached comes back");
      // Live output continues to the new window.
      const mk2 = marker("back");
      await pty.write.handler({ id: a1.id, data: `${mk2.cmd}\r` }, ctxOf("w3"));
      await until(
        "output after the reattach",
        () => fake.text(a1.id, "w3").includes(mk2.text),
      );

      // Closing the ended tile releases its terminal; the workspace keeps a1.
      pty.kill.handler({ id: a2.id }, ctxOf("w3"));
      await until(
        "a2 released",
        () => !workspaces.ptysOf("ws-a").includes(a2.id),
      );
      // Closing a running tile kills it; its exit still reaches the window, then it is released.
      pty.kill.handler({ id: a1.id }, ctxOf("w3"));
      await until("a1's exit", () => fake.exited(a1.id, "w3"));
      await until("a1 released", () => workspaces.ptysOf("ws-a").length === 0);

      // Ending ws-b kills its shell.
      const ended = session.end.handler({ id: "ws-b" }) as {
        ended: number;
      };
      assertEquals(ended.ended, 1);
      await until("b killed", () => !terminalSessions().host.isRunning(b.id));
    } finally {
      await fake.quit();
    }
    assertEquals(terminalSessions().size, 0);
  },
});

Deno.test({
  name:
    "session: the quit kills detached terminals too; a reload gets its terminals back",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = app([{ id: "main", kind: "main", key: "ws-q" }]);
    join("main");
    const t = await pty.spawn.handler(SH, ctxOf("main"));
    // A reload is no close: the same window joins again and takes the terminal back.
    const again = join("main");
    assertEquals(again.ptys.map((p) => p.id), [t.id]);
    await fake.close("main");
    assert(terminalSessions().host.isRunning(t.id));
    await fake.quit();
    await until(
      "killed by the quit",
      () => !terminalSessions().host.isRunning(t.id),
    );
    assertEquals(workspaces.list(), []);
  },
});

Deno.test("session: save needs a joined window and an object of bounded size", async () => {
  workspaces.clear();
  const bad = await session.save.input["~standard"].validate({ snapshot: "x" });
  assert("issues" in bad && bad.issues?.length === 1);
  const big = await session.save.input["~standard"].validate({
    snapshot: { s: "x".repeat(300 * 1024) },
  });
  assert("issues" in big && big.issues?.length === 1);
  try {
    session.save.handler({ snapshot: {} }, ctxOf("nobody"));
    throw new Error("saved for a window that joined nothing");
  } catch (e) {
    assert(e instanceof DesktopCapError && e.code === "not_found");
  }
});

/** A detached workspace `ws-1` whose terminal `p1` runs a busy agent, and no window open. */
function busyDetached(): void {
  workspaces.clear();
  workspaces.join("w1", "ws-1");
  workspaces.addPty("ws-1", "p1");
  workspaces.windowClosed("w1");
  workspaces.setBusyProvider(() => [{ ptyId: "p1", name: "claude" }]);
}

Deno.test("session: Cmd+Q with a busy agent asks with the OS's message box, with no window open", async () => {
  busyDetached();
  const fake = fakeExtensionHost([]);
  const quits: number[] = [];
  const off = guardQuit(fake.host, () => quits.push(1));
  try {
    // Cancel: the quit stays cancelled and nothing quits.
    fake.reply = () => Promise.resolve(1);
    assertEquals(await fake.beforeQuit(), false);
    assertEquals(fake.confirms, [
      quitQuestion([{ ptyId: "p1", name: "claude" }]),
    ]);
    assertEquals(fake.confirms[0].message, "An agent is still working");
    assertEquals(fake.confirms[0].buttons, ["Quit Anyway", "Cancel"]);
    assertEquals([fake.confirms[0].defaultId, fake.confirms[0].cancelId], [
      1,
      1,
    ]);
    assert(fake.confirms[0].detail?.includes("claude"));
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(quits, []);

    // A second quit while the box is still up is cancelled without a second box.
    let press: (n: number) => void = () => {};
    fake.reply = () => new Promise((r) => press = r);
    assertEquals(await fake.beforeQuit(), false);
    assertEquals(await fake.beforeQuit(), false);
    assertEquals(fake.confirms.length, 2);
    // Quit Anyway: the quit is issued again, and the guard lets it through.
    press(0);
    await until("the quit issued again", () => quits.length === 1);
    assertEquals(await fake.beforeQuit(), true);

    // A runtime without message boxes: this quit is cancelled, the next one goes through.
    fake.reply = () =>
      Promise.reject(new DesktopCapError("unsupported", "no message boxes"));
    assertEquals(await fake.beforeQuit(), false);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(await fake.beforeQuit(), true);
    assertEquals(quits.length, 1);

    // No busy agent: no question.
    workspaces.setBusyProvider(undefined);
    const asked = fake.confirms.length;
    assertEquals(await fake.beforeQuit(), true);
    assertEquals(fake.confirms.length, asked);
  } finally {
    off();
    workspaces.setBusyProvider(undefined);
    workspaces.clear();
  }
});

Deno.test("session: Close Window and End Its Shells acts for the window used last, then forgets its key", async () => {
  const fake = app([
    { id: "w1", kind: "window", key: "ws-1" },
    { id: "w2", kind: "window", key: "ws-2" },
  ]);
  const runtime = fakeRuntimeWindows();
  const off = forgetEndedWorkspaces(workspaces, runtime);
  try {
    join("w1");
    join("w2");
    workspaces.addPty("ws-1", "p1");
    session.focus.handler({}, ctxOf("w1"));
    const endWindow = (window: string, menu = true) =>
      session.endWindow.handler({ menu }, ctxOf(window)) as Promise<
        SessionEndWindow
      >;
    // Every window's page hears the click: only the one used last closes.
    assertEquals(await endWindow("w2"), { close: false });
    assertEquals(await endWindow("w1"), { close: true });
    assertEquals(fake.confirms, [], "no busy agent: nothing to ask");
    // Its workspace is ended once the page has closed the window, then its key is forgotten.
    assert(workspaces.has("ws-1"));
    assertEquals(runtime.forgotten, []);
    await fake.close("w1");
    assert(!workspaces.has("ws-1"));
    assertEquals(runtime.forgotten, ["ws-1"]);
    // A late copy of the same click from the other window does nothing.
    assertEquals(await endWindow("w2"), { close: false });
    assert(workspaces.has("ws-2"));
    // The Workspaces menu's "End workspace" (asked in the page) is not the menu's click.
    assertEquals(await endWindow("w2", false), { close: true });
    await fake.close("w2");
    assertEquals(runtime.forgotten, ["ws-1", "ws-2"]);
    // A window that never joined has nothing to end.
    assertEquals(await endWindow("w9", false), { close: false });
  } finally {
    off();
    await fake.quit();
  }
});

Deno.test("session: Close Window and End Its Shells asks first when an agent there is busy", async () => {
  workspaces.clear();
  const fake = fakeExtensionHost([]);
  let now = 10_000;
  const endWindow = createEndWindow(fake.host, () => now);
  try {
    workspaces.join("w1", "ws-1");
    workspaces.addPty("ws-1", "p1");
    workspaces.join("w2", "ws-2");
    workspaces.addPty("ws-2", "p2");
    workspaces.focused("w1");
    workspaces.setBusyProvider(() => [
      { ptyId: "p1", name: "claude" },
      { ptyId: "p2", name: "codex" },
    ]);
    // Cancel: nothing closes, nothing is ended.
    fake.reply = () => Promise.resolve(1);
    assertEquals(await endWindow("w1", true), { close: false });
    assertEquals(fake.confirms, [
      closeQuestion([{ ptyId: "p1", name: "claude" }]),
    ]);
    assertEquals(
      fake.confirms[0].message,
      "An agent is still working in this window",
    );
    assertEquals(fake.confirms[0].buttons, ["Close and End", "Cancel"]);
    assert(!fake.confirms[0].detail?.includes("codex"), "only this window's");
    // The same click heard by another window is ignored; a new click a second later asks again.
    assertEquals(await endWindow("w1", true), { close: false });
    assertEquals(fake.confirms.length, 1);
    now += 1500;
    // While the box is up, every other copy of the click is ignored.
    let press: (n: number | null) => void = () => {};
    fake.reply = () => new Promise((r) => press = r);
    const asking = endWindow("w1", true);
    now += 1500;
    assertEquals(await endWindow("w1", true), { close: false });
    press(0);
    assertEquals(await asking, { close: true });
    assertEquals(fake.confirms.length, 2);
    // A runtime without message boxes: the busy window is not closed.
    workspaces.focused("w2");
    now += 1500;
    fake.reply = () => Promise.reject(new DesktopCapError("unsupported", "x"));
    assertEquals(await endWindow("w2", true), { close: false });
    assert(workspaces.has("ws-2"));
  } finally {
    workspaces.setBusyProvider(undefined);
    workspaces.clear();
  }
});
