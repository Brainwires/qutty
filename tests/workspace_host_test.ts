// The workspace host's state machine (desktop/workspace-host.ts), without windows or PTYs:
// join / detach / reattach / drop, the PTY ↔ workspace ↔ window mapping, ending, the list, the
// quit guard, and where the hub's events go with several windows.

import { assert, assertEquals } from "@std/assert";
import {
  askVisibleIn,
  hubEventTarget,
  WorkspaceRegistry,
} from "../desktop/workspace-host.ts";

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

Deno.test("workspaces: a busy agent cancels the quit and asks in its window", () => {
  const { r, tick } = registry();
  r.join("main", "main");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "p2");
  r.setBusyProvider(() => [{ ptyId: "p2", name: "codex" }]);
  const d = r.beforeQuit();
  assertEquals(d, {
    allow: false,
    window: "w2",
    request: { busy: [{ ptyId: "p2", name: "codex" }], at: 1000 },
  });
  assertEquals(r.pendingQuit()?.busy.length, 1);
  // Cancel: the next quit asks again.
  r.answerQuit(false);
  assertEquals(r.pendingQuit(), undefined);
  assertEquals(r.beforeQuit().allow, false);
  // Quit anyway: the next quit (the page's quitApp) goes through, once.
  r.answerQuit(true);
  assertEquals(r.beforeQuit(), { allow: true });
  assertEquals(r.beforeQuit().allow, false);
  // A confirmation is good for a short while only.
  r.answerQuit(true);
  tick(60_000);
  assertEquals(r.beforeQuit().allow, false);
  // An unanswered question is forgotten after a while.
  tick(10 * 60_000);
  assertEquals(r.pendingQuit(), undefined);
});

Deno.test("workspaces: a busy agent in a detached workspace asks in the active window, else reopens it", () => {
  const { r } = registry();
  r.join("w1", "ws-1");
  r.addPty("ws-1", "p1");
  r.join("w2", "ws-2");
  r.addPty("ws-2", "p2");
  r.setBusyProvider(() => [{ ptyId: "p1", name: "claude" }]);
  r.windowClosed("w1");
  const d1 = r.beforeQuit();
  assert(!d1.allow && d1.window === "w2");
  r.windowClosed("w2");
  const d2 = r.beforeQuit();
  assert(!d2.allow && d2.window === undefined && d2.open === "ws-1");
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
