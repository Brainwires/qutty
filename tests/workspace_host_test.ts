// The workspace host's state machine (desktop/workspace-host.ts), without windows or PTYs:
// join / detach / reattach / drop, the PTY ↔ workspace ↔ window mapping, ending (at once, or once
// the window has closed), the list, the quit guard's decision, where the hub's events go with
// several windows, and what desktop.ts hands Denext (desktop/windows.ts: the Dock's reopen, the
// forgotten window keys).

import { assert, assertEquals } from "@std/assert";
import {
  askVisibleIn,
  hubEventTarget,
  WorkspaceRegistry,
} from "../desktop/workspace-host.ts";
import { dockReopenWindow, forgetEndedWorkspaces } from "../desktop/windows.ts";
import { workspaceWindow } from "../lib/workspace/windows.ts";
import { fakeRuntimeWindows } from "./session_helpers.ts";

function registry() {
  let now = 1000;
  const r = new WorkspaceRegistry({ now: () => now });
  return { r, tick: (ms: number) => (now += ms) };
}

Deno.test("workspaces: a window joins the workspace its key names, created once", () => {
  const { r } = registry();
  const a = r.join("main", "main");
  assertEquals([a.id, a.name, a.created, a.snapshot], [
    "main",
    "Workspace 1",
    true,
    null,
  ]);
  const b = r.join("window-1", "ws-b");
  assertEquals([b.id, b.name, b.created], ["ws-b", "Workspace 2", true]);
  // A reload joins again: same workspace, not created, its snapshot back.
  r.save("main", { v: 1 });
  const again = r.join("main", "main");
  assertEquals([again.created, again.snapshot], [false, { v: 1 }]);
  // A window without a key gets a workspace of its own.
  assertEquals(r.join("window-9", undefined).id, "win-window-9");
  assertEquals(r.workspaceOfWindow("window-1"), "ws-b");
  assertEquals(r.windowOf("ws-b"), "window-1");
});

Deno.test("workspaces: closing a window detaches its workspace; reopening attaches it", () => {
  const { r, tick } = registry();
  r.join("main", "main");
  r.addPty("main", "pty-1");
  r.addPty("main", "pty-2");
  assertEquals(r.windowOfPty("pty-1"), "main");
  tick(500);
  assertEquals(r.windowClosed("main"), "main");
  assertEquals(r.windowOf("main"), undefined);
  assertEquals(r.windowOfPty("pty-1"), null, "detached: nowhere");
  assertEquals(r.windowOfPty("pty-9"), undefined, "unknown: everywhere");
  assertEquals(r.list(), [{
    id: "main",
    name: "Workspace 1",
    state: "detached",
    terminals: 2,
    running: 2,
    busy: 0,
    detachedAt: 1500,
  }]);
  assertEquals(r.lastDetached(), "main");
  // The window that opens with its key shows it again (a new window id).
  r.join("window-3", "main");
  assertEquals(r.windowOfPty("pty-2"), "window-3");
  assertEquals(r.list()[0].state, "attached");
  assertEquals(r.lastDetached(), undefined);
});

Deno.test("workspaces: an exited shell still counts as a terminal, not as running", () => {
  const { r } = registry();
  let changes = 0;
  r.onChanged(() => changes++);
  r.join("main", "main");
  r.addPty("main", "pty-1");
  r.addPty("main", "pty-2");
  const before = changes;
  r.ptyExited("pty-1");
  r.ptyExited("pty-1"); // once
  r.ptyExited("pty-9"); // unknown
  assertEquals(changes, before + 1);
  assertEquals(
    [r.list()[0].terminals, r.list()[0].running],
    [2, 1],
  );
  r.removePty("pty-1"); // its tile closed
  assertEquals([r.list()[0].terminals, r.list()[0].running], [1, 1]);
});

Deno.test("workspaces: an empty workspace is dropped, not detached", () => {
  const { r } = registry();
  r.join("main", "main");
  r.windowClosed("main");
  assertEquals(r.list(), []);
  // A detached workspace whose last terminal goes away is dropped too.
  r.join("w", "ws-x");
  r.addPty("ws-x", "pty-1");
  r.windowClosed("w");
  r.removePty("pty-1");
  assertEquals(r.has("ws-x"), false);
  // An attached one stays (its window shows it, empty).
  r.join("w2", "ws-y");
  r.addPty("ws-y", "pty-2");
  r.removePty("pty-2");
  assertEquals(r.has("ws-y"), true);
});

Deno.test("workspaces: a spawn before join joins; a window moving to another workspace detaches the old one", () => {
  const { r } = registry();
  assertEquals(r.workspaceForWindow("main", "main"), "main");
  r.addPty("main", "pty-1");
  r.join("main", "ws-other");
  assertEquals(r.list().find((w) => w.id === "main")?.state, "detached");
  assertEquals(r.workspaceOfWindow("main"), "ws-other");
});

Deno.test("workspaces: ending one tells the listeners and forgets it", () => {
  const { r } = registry();
  const ended: [string, string[]][] = [];
  const off = r.onEnded((id, ptys) => ended.push([id, ptys]));
  let changes = 0;
  r.onChanged(() => changes++);
  r.join("main", "main");
  r.addPty("main", "pty-1");
  r.addPty("main", "pty-2");
  assertEquals(r.end("main"), ["pty-1", "pty-2"]);
  assertEquals(ended, [["main", ["pty-1", "pty-2"]]]);
  assertEquals(r.has("main"), false);
  assertEquals(r.workspaceOfWindow("main"), undefined);
  assertEquals(r.workspaceOfPty("pty-1"), undefined);
  assertEquals(r.end("main"), [], "twice is nothing");
  assert(changes >= 4);
  off();
  r.join("w", "ws-z");
  r.end("ws-z");
  assertEquals(ended.length, 1);
});

Deno.test("workspaces: the list counts busy agents and orders attached first", () => {
  const { r, tick } = registry();
  r.join("main", "main");
  r.join("w2", "ws-2");
  r.join("w3", "ws-3");
  for (
    const [ws, p] of [["main", "p1"], ["ws-2", "p2"], ["ws-3", "p3"], [
      "ws-3",
      "p4",
    ]]
  ) {
    r.addPty(ws, p);
  }
  r.setBusyProvider(
    () => [{ ptyId: "p3", name: "claude" }, { ptyId: "gone", name: "x" }],
  );
  r.windowClosed("w3");
  tick(10);
  r.windowClosed("main");
  r.focused("w2");
  const list = r.list();
  assertEquals(list.map((w) => [w.id, w.state, w.busy]), [
    ["ws-2", "attached", 0],
    ["main", "detached", 0],
    ["ws-3", "detached", 1],
  ]);
  assertEquals(r.lastDetached(), "main");
});

Deno.test("workspaces: the quit goes ahead with no busy agent", () => {
  const { r } = registry();
  r.join("main", "main");
  r.addPty("main", "p1");
  assertEquals(r.beforeQuit(), { allow: true });
});

Deno.test("workspaces: a busy agent cancels the quit, with the agents to ask about", () => {
  const { r, tick } = registry();
  r.join("main", "main");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "p2");
  r.setBusyProvider(() => [{ ptyId: "p2", name: "codex" }]);
  assertEquals(r.beforeQuit(), {
    allow: false,
    busy: [{ ptyId: "p2", name: "codex" }],
  });
  // Cancel: the next quit asks again.
  r.answerQuit(false);
  assertEquals(r.beforeQuit().allow, false);
  // Quit anyway: the next quit (issued again right after) goes through, once.
  r.answerQuit(true);
  assertEquals(r.beforeQuit(), { allow: true });
  assertEquals(r.beforeQuit().allow, false);
  // A confirmation is good for a short while only.
  r.answerQuit(true);
  tick(60_000);
  assertEquals(r.beforeQuit().allow, false);
  // A busy agent in a detached workspace counts too.
  r.windowClosed("w2");
  assertEquals(r.beforeQuit().allow, false);
});

Deno.test("workspaces: busyIn names the busy agents of one workspace", () => {
  const { r } = registry();
  r.join("w1", "ws-1");
  r.addPty("ws-1", "p1");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "p2");
  r.addPty("ws-2", "p3");
  r.setBusyProvider(() => [
    { ptyId: "p1", name: "claude" },
    { ptyId: "p3", name: "codex" },
    { ptyId: "p9", name: "gone" },
  ]);
  assertEquals(r.busyIn("ws-2"), [{ ptyId: "p3", name: "codex" }]);
  assertEquals(r.busyIn("ws-1").map((t) => t.name), ["claude"]);
  assertEquals(r.busyIn("nope"), []);
});

Deno.test("workspaces: endOnClose ends the workspace when its window closes, not before", () => {
  const { r } = registry();
  const ended: [string, string[]][] = [];
  r.onEnded((id, ptys) => ended.push([id, ptys]));
  r.join("w1", "ws-1");
  r.addPty("ws-1", "p1");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "p2");
  assert(r.endOnClose("ws-1"));
  // Still shown: nothing is ended until the page has closed its window.
  assertEquals(ended, []);
  assertEquals(r.windowOf("ws-1"), "w1");
  assertEquals(r.windowClosed("w1"), "ws-1");
  assertEquals(ended, [["ws-1", ["p1"]]]);
  assert(!r.has("ws-1"), "ended, not detached");
  assertEquals(r.workspaceOfPty("p1"), undefined);
  // Another window's close still detaches.
  r.windowClosed("w2");
  assertEquals(r.list().map((w) => [w.id, w.state]), [["ws-2", "detached"]]);
  // A detached workspace is ended at once; an unknown one is refused.
  assert(r.endOnClose("ws-2"));
  assertEquals(ended.map(([id]) => id), ["ws-1", "ws-2"]);
  assert(!r.endOnClose("ws-2"));
  assertEquals(r.list(), []);
});

Deno.test("workspaces: an endOnClose mark goes with the workspace", () => {
  const { r } = registry();
  r.join("w1", "ws-1");
  r.addPty("ws-1", "p1");
  r.endOnClose("ws-1");
  // Ended another way first (the Workspaces menu), then shown again in a new window: the new
  // window's close detaches as usual.
  r.end("ws-1");
  r.join("w3", "ws-1");
  r.addPty("ws-1", "p2");
  r.windowClosed("w3");
  assertEquals(r.list().map((w) => [w.id, w.state]), [["ws-1", "detached"]]);
});

Deno.test("windows: a Dock click with no window reopens the workspace detached last, else a new one", () => {
  const { r, tick } = registry();
  const none = fakeRuntimeWindows();
  // No workspace at all: a fresh one, with a size.
  const fresh = dockReopenWindow(r, none)!;
  assert(fresh.key?.startsWith("ws-") && fresh.width !== undefined);
  r.join("w1", "ws-1");
  r.addPty("ws-1", "p1");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "p2");
  r.windowClosed("w2");
  tick(10);
  r.windowClosed("w1");
  // The last detached one, with no size (its frame comes back).
  assertEquals(dockReopenWindow(r, none), workspaceWindow("ws-1"));
  // A workspace window still open (hidden or minimized): nothing new opens.
  const hidden = fakeRuntimeWindows([{ id: "w3", kind: "window", key: "x" }]);
  assertEquals(dockReopenWindow(r, hidden), undefined);
  // The tray panel does not count.
  const panel = fakeRuntimeWindows([{ id: "panel", kind: "panel" }]);
  assertEquals(dockReopenWindow(r, panel), workspaceWindow("ws-1"));
});

Deno.test("windows: an ended workspace's key is forgotten, a closed one's is not", () => {
  const { r } = registry();
  const windows = fakeRuntimeWindows();
  const off = forgetEndedWorkspaces(r, windows);
  r.join("w1", "ws-1");
  r.addPty("ws-1", "p1");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "p2");
  r.join("w3", "ws-3");
  r.addPty("ws-3", "p3");
  // Closing detaches: the key stays for Reopen Closed Window and the Dock.
  r.windowClosed("w1");
  assertEquals(windows.forgotten, []);
  // Ending a detached workspace (the Workspaces menu) forgets it.
  r.end("ws-1");
  assertEquals(windows.forgotten, ["ws-1"]);
  // "Close Window and End Its Shells": forgotten once the window has closed.
  r.endOnClose("ws-2");
  assertEquals(windows.forgotten, ["ws-1"]);
  r.windowClosed("w2");
  assertEquals(windows.forgotten, ["ws-1", "ws-2"]);
  // The quit clears the registry without ending: the keys stay for the restored session.
  r.clear();
  assertEquals(windows.forgotten, ["ws-1", "ws-2"]);
  off();
  r.join("w4", "ws-4");
  r.end("ws-4");
  assertEquals(windows.forgotten, ["ws-1", "ws-2"]);
});
Deno.test("workspaces: a failing busy provider or listener never breaks the host", () => {
  const { r } = registry();
  r.setBusyProvider(() => {
    throw new Error("hub gone");
  });
  r.onChanged(() => {
    throw new Error("listener");
  });
  r.join("main", "main");
  assertEquals(r.beforeQuit(), { allow: true });
  r.setBusyProvider(undefined);
  assertEquals(r.list()[0].busy, 0);
});

Deno.test("hub routing: tiles and closes to every window, an agent's question to its own", () => {
  const { r } = registry();
  r.join("main", "main");
  r.addPty("main", "pty-1");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "pty-2");
  r.focused("w2");
  assertEquals(hubEventTarget(r, "tiles", {}), {});
  assertEquals(hubEventTarget(r, "askClosed", { id: "a" }), {});
  assertEquals(hubEventTarget(r, "ask", { from: "pty-1" }), { window: "main" });
  // The companion's question, its replies and commands: the active window.
  assertEquals(hubEventTarget(r, "ask", { from: "companion" }), {
    window: "w2",
  });
  assertEquals(hubEventTarget(r, "companion", {}), { window: "w2" });
  assertEquals(hubEventTarget(r, "say", {}), { window: "w2" });
  assertEquals(hubEventTarget(r, "control", {}), { window: "w2" });
  // A detached tile's question waits (the snapshot shows it on reattach).
  r.windowClosed("main");
  assertEquals(hubEventTarget(r, "ask", { from: "pty-1" }), null);
  assertEquals(askVisibleIn(r, "pty-1", "w2"), false);
  assertEquals(askVisibleIn(r, "pty-2", "w2"), true);
  assertEquals(askVisibleIn(r, "companion", "w2"), true);
  // No window joined anything: every window.
  r.windowClosed("w2");
  assertEquals(hubEventTarget(r, "companion", {}), {});
});
