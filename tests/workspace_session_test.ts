// The page's side of detachable sessions: folding a terminal's replay (lib/workspace/replay.ts),
// the workspace snapshot and the plan that rebuilds it (lib/workspace/session.ts), the store's
// `restore`, the per-workspace layout across launches, the bounded replay ring with a real shell
// (desktop/terminal-sessions.ts), and the desktop client's join and Window menu item
// (lib/session-client.ts).

import { assert, assertEquals } from "@std/assert";
import { foldReplay } from "../lib/workspace/replay.ts";
import {
  type JoinedPty,
  loadWorkspaceLayout,
  planRestore,
  saveWorkspaceLayout,
  snapshotOf,
  workspaceLayoutKey,
} from "../lib/workspace/session.ts";
import { initialState, reduce } from "../lib/workspace/store.ts";
import {
  CLOSE_AND_END_ITEM,
  newWorkspaceId,
  windowMenu,
  workspaceWindow,
} from "../lib/workspace/windows.ts";
import { createDesktopSession } from "../lib/session-client.ts";
import { PtyHost } from "../desktop/pty.ts";
import { TerminalSessions } from "../desktop/terminal-sessions.ts";
import { WorkspaceRegistry } from "../desktop/workspace-host.ts";
import { HAS_SH, POSIX } from "./pty_helpers.ts";
import { fakeExtensionHost, until } from "./session_helpers.ts";

const data = (seq: number, text: string) => ({
  event: "data",
  data: { seq, data: text },
});

Deno.test("replay: folds output in order, with the last seq and the exit", () => {
  const f = foldReplay([
    data(1, "a"),
    data(2, "b\r\n"),
    { event: "exit", data: { exitCode: 2, signal: null } },
  ]);
  assertEquals(f, {
    data: "ab\r\n",
    seq: 2,
    truncated: false,
    exit: { exitCode: 2, signal: null },
  });
  assertEquals(foldReplay([]), { data: "", seq: 0, truncated: false });
  // Junk entries are skipped.
  assertEquals(
    foldReplay([{ event: "data", data: "x" }, { event: "x", data: {} }]).data,
    "",
  );
});

Deno.test("replay: a ring that dropped its start begins at a line break", () => {
  const f = foldReplay([data(7, "\x1b[3"), data(8, "1mred\r\nline two\r\n")]);
  assertEquals([f.truncated, f.data, f.seq], [true, "line two\r\n", 8]);
  assertEquals(foldReplay([data(5, "no newline")]).data, "");
  // A gap (a chunk the ring could not keep) cuts there too: only the unbroken tail is replayed.
  const gap = foldReplay([
    data(1, "old\r\n"),
    data(2, "x\r\n"),
    data(4, "tail\r\nnew\r\n"),
  ]);
  assertEquals([gap.truncated, gap.data, gap.seq], [true, "new\r\n", 4]);
});

const pty = (id: string, extra: Partial<JoinedPty> = {}): JoinedPty => ({
  id,
  cols: 100,
  rows: 30,
  data: `${id}$ `,
  seq: 3,
  truncated: false,
  ...extra,
});

/** A workspace with three tiles (a shell, an agent, an SSH tile), its snapshot. */
function snapshot() {
  let s = initialState();
  for (const id of ["t1", "t2", "t3"]) {
    s = reduce(s, { type: "add", id, now: 10 });
  }
  s = reduce(s, { type: "focus", id: "t2", now: 20 });
  s = reduce(s, { type: "activity", id: "t3" });
  s = reduce(s, { type: "setLayout", patch: { pattern: "columns" } });
  const tiles: Record<string, unknown> = {
    t1: { ptyId: "pty-1", profile: { kind: "shell" }, home: "/Users/me" },
    t2: {
      ptyId: "pty-2",
      profile: {
        kind: "agent",
        program: "/bin/claude",
        name: "claude",
        label: "Claude",
      },
    },
    t3: {
      ptyId: "pty-3",
      profile: { kind: "ssh", target: { host: "box" }, label: "box" },
    },
  };
  return snapshotOf(s, 3, (id) => tiles[id] as never);
}

Deno.test("session: the snapshot carries tiles, order, layout; activity starts clear", () => {
  const snap = snapshot();
  assertEquals(snap.v, 1);
  assertEquals(snap.seq, 3);
  assertEquals(snap.mru, ["t2", "t3", "t1"]);
  assertEquals(snap.layout.pattern, "columns");
  assertEquals(snap.tiles.t1.ptyId, "pty-1");
  assert(snap.terminals.every((t) => !t.activity));
  // It is JSON (it crosses the bridge).
  assertEquals(JSON.parse(JSON.stringify(snap)), snap);
});

Deno.test("session: every tile comes back on its PTY, with its order and layout", () => {
  const plan = planRestore(JSON.parse(JSON.stringify(snapshot())), [
    pty("pty-1"),
    pty("pty-2"),
    pty("pty-3", { exit: { exitCode: 255, signal: null } }),
  ])!;
  assertEquals(plan.tiles.map((t) => [t.id, t.pty?.id, t.profile.kind]), [
    ["t1", "pty-1", "shell"],
    ["t2", "pty-2", "agent"],
    ["t3", "pty-3", "ssh"],
  ]);
  assertEquals(plan.tiles[0].home, "/Users/me");
  assertEquals(plan.mru, ["t2", "t3", "t1"]);
  assertEquals(plan.layout?.pattern, "columns");
  assertEquals(plan.seq, 3);
  // The one that ended while detached comes back ended.
  const t3 = plan.terminals.find((t) => t.id === "t3")!;
  assertEquals([t3.exited, t3.exitCode], [true, 255]);
  assert(!plan.terminals.find((t) => t.id === "t1")!.exited);

  // Through the store: the workspace as it was.
  const s = reduce(initialState(), {
    type: "restore",
    terminals: plan.terminals,
    mru: plan.mru,
    ...(plan.layout ? { layout: plan.layout } : {}),
    previousPattern: plan.previousPattern,
  });
  assertEquals(s.terminals.map((t) => t.id), ["t1", "t2", "t3"]);
  assertEquals([s.focusedId, s.settings.layout.pattern], ["t2", "columns"]);
});

Deno.test("session: a gone PTY leaves its tile ended; an unknown PTY gets a tile", () => {
  const plan = planRestore(snapshot(), [pty("pty-1"), pty("pty-9")])!;
  const byId = new Map(plan.terminals.map((t) => [t.id, t]));
  assertEquals(byId.get("t2")?.exited, true);
  assertEquals(plan.tiles.find((t) => t.id === "t2")?.pty, undefined);
  // pty-9 (started after the last save) gets t4: never a reused id.
  const t4 = plan.tiles.find((t) => t.pty?.id === "pty-9")!;
  assertEquals([t4.id, t4.profile.kind, plan.seq], ["t4", "shell", 4]);
  assertEquals(plan.mru.at(-1), "t4");
});

Deno.test("session: nothing saved and no PTY is a new workspace; junk is ignored", () => {
  assertEquals(planRestore(null, []), null);
  assertEquals(planRestore({ v: 2 }, []), null);
  assertEquals(planRestore("junk", []), null);
  // Only PTYs (a snapshot that never got saved): each gets a tile, no layout.
  const plan = planRestore(null, [pty("pty-5")])!;
  assertEquals(plan.tiles.map((t) => t.id), ["t1"]);
  assertEquals(plan.layout, undefined);
  // A tile with a broken profile is dropped, a broken entry too.
  const snap = JSON.parse(JSON.stringify(snapshot()));
  snap.tiles.t1.profile = { kind: "nope" };
  snap.terminals.push({ id: 42 });
  const p2 = planRestore(snap, [pty("pty-2"), pty("pty-3")])!;
  assertEquals(p2.tiles.map((t) => t.id), ["t2", "t3"]);
});

Deno.test("session: the layout per workspace survives a launch", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assertEquals(loadWorkspaceLayout("ws-1", storage), null);
  saveWorkspaceLayout("ws-1", {
    layout: { pattern: "rows" },
    previousPattern: "grid",
  }, storage);
  assert(store.has(workspaceLayoutKey("ws-1")));
  assertEquals(loadWorkspaceLayout("ws-1", storage), {
    layout: { pattern: "rows" },
    previousPattern: "grid",
  });
  store.set(workspaceLayoutKey("ws-2"), "{not json");
  assertEquals(loadWorkspaceLayout("ws-2", storage), null);
  assertEquals(loadWorkspaceLayout("ws-1", undefined), null);
});

Deno.test("windows: workspace ids are valid window keys; a known one restores its frame", () => {
  const id = newWorkspaceId(() => new Uint8Array([0, 15, 160, 255]));
  assertEquals(id, "ws-000fa0ff");
  assert(/^[A-Za-z0-9._:-]{1,64}$/.test(newWorkspaceId()));
  assertEquals(workspaceWindow("ws-1"), {
    url: "/",
    key: "ws-1",
    title: "Qutty",
  });
  assertEquals(workspaceWindow("ws-1", true).width, 1400);
});

Deno.test({
  name:
    "terminal sessions: the replay ring is bounded and keeps the newest output",
  ignore: !POSIX || !HAS_SH,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const ws = new WorkspaceRegistry();
    const sessions = new TerminalSessions({
      workspaces: ws,
      host: (emit) => new PtyHost(emit),
      replayBytes: 256 * 1024,
    });
    const fake = fakeExtensionHost([{ id: "w1", kind: "window", key: "ws-r" }]);
    sessions.connect(fake.host);
    try {
      const t = await sessions.spawn(
        { cols: 80, rows: 24, shell: "/bin/sh", cwd: "/tmp" },
        { id: "w1" },
      );
      // ~200 KiB of numbered lines, then a last marker.
      await sessions.write(
        t.id,
        "i=0; while [ $i -lt 16000 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; echo END-$((1+1))\r",
        false,
        { id: "w1" },
      );
      await until(
        "the end marker",
        () => fake.text(t.id, "w1").includes("END-2"),
        30_000,
      );
      const [r] = sessions.attachWorkspace("ws-r", "w1");
      assert(r.truncated, "the ring dropped the start");
      assert(r.data.length <= 256 * 1024, `kept ${r.data.length} chars`);
      assert(r.data.includes("END-2"), "the newest output is kept");
      assert(!r.data.includes("line-0-"), "the oldest is gone");
      assert(/^line-\d+-x/.test(r.data), "it starts at a whole line");
    } finally {
      await sessions.disposeAll();
    }
  },
});

Deno.test("session client: join attaches the PTY events first and adopts every terminal", async () => {
  const calls: string[] = [];
  let close = true;
  const menuItems: ((id: string) => void)[] = [];
  const menus: unknown[] = [];
  const guards: ((e: { reason: "close" | "quit" }) =>
    | boolean
    | Promise<boolean>)[] = [];
  let closeGuard = false;
  const session = createDesktopSession({
    desktopExtension: (() =>
      new Proxy({}, {
        get: (_t, method: string) => (args: unknown) => {
          const { menu, confirm } = (args ?? {}) as {
            menu?: boolean;
            confirm?: boolean;
          };
          calls.push(
            `session.${method}${menu === undefined ? "" : `:${menu}`}${
              confirm ? ":confirm" : ""
            }`,
          );
          if (method === "join") {
            return Promise.resolve({
              workspace: { id: "ws-1", name: "Workspace 2" },
              snapshot: null,
              ptys: [pty("pty-7", { seq: 41 })],
            });
          }
          if (method === "endWindow") return Promise.resolve({ close });
          return Promise.resolve(args);
        },
      })) as never,
    onDesktopEvent: (() => () => {}) as never,
    window: {
      openWindow: (o) => (calls.push(`open:${o.key}`), Promise.resolve()),
      closeWindow: () => (calls.push("close"), Promise.resolve()),
      setWindowTitle: (t) => (calls.push(`title:${t}`), Promise.resolve()),
      setAppMenu: (m) => (menus.push(m), Promise.resolve()),
      onAppMenuItem: (fn) => (menuItems.push(fn), () => {}),
      onCloseRequested: (fn) => (guards.push(fn), () => calls.push("unguard")),
      windowCapabilities: () => Promise.resolve({ closeGuard }),
    },
    listen: () => calls.push("listen"),
    adopt: (id, seq) => calls.push(`adopt:${id}@${seq}`),
  });
  const joined = await session.join();
  assertEquals(joined.workspace.id, "ws-1");
  assertEquals(calls, [
    "listen",
    "session.join",
    "adopt:pty-7@41",
    "title:Qutty — Workspace 2",
  ]);
  // The Window menu gets "Close Window and End Its Shells", with no shortcut, once.
  await session.join();
  assertEquals(menus, [windowMenu()]);
  assertEquals(menuItems.length, 1);
  const item = (windowMenu()[0] as unknown as {
    submenu: { id: string; accelerator?: string }[];
  })
    .submenu[0];
  assertEquals([item.id, item.accelerator], [CLOSE_AND_END_ITEM, undefined]);

  await session.reopen("ws-9");
  assertEquals(calls.at(-1), "open:ws-9");

  // A click on it: the extension decides (the window used last, after asking); then it closes.
  calls.length = 0;
  menuItems[0](CLOSE_AND_END_ITEM);
  await until("the close", () => calls.includes("close"));
  assertEquals(calls, ["session.endWindow:true", "close"]);
  // Another window's copy of the click: the extension says no, nothing closes.
  calls.length = 0;
  close = false;
  menuItems[0](CLOSE_AND_END_ITEM);
  await until("the answer", () => calls.length > 0);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(calls, ["session.endWindow:true"]);
  // Other menu items are not Qutty's business.
  calls.length = 0;
  menuItems[0]("something-else");
  assertEquals(calls, []);

  // "End workspace" for this window (asked in the page): ended once the window closes.
  close = true;
  await session.endWindow();
  assertEquals(calls, ["session.endWindow:false", "close"]);

  // The close button set to end the shells: the extension asks about a busy agent first.
  calls.length = 0;
  await session.endWindow({ confirm: true });
  assertEquals(calls, ["session.endWindow:false:confirm", "close"]);
  // Keep Running: the window closes (and detaches) without asking anything.
  calls.length = 0;
  await session.closeWindow();
  assertEquals(calls, ["close"]);

  // No close guard in this runtime: nothing is registered, the window just closes.
  assertEquals(await session.guardClose(() => false), null);
  assertEquals(guards.length, 0);
  // With one, the handler gets the reason and answers for the window.
  closeGuard = true;
  const off = await session.guardClose((reason) => reason === "quit");
  assert(off);
  assertEquals(guards.length, 1);
  assertEquals(await guards[0]({ reason: "close" }), false);
  assertEquals(await guards[0]({ reason: "quit" }), true);
  calls.length = 0;
  off();
  assertEquals(calls, ["unguard"]);
});
