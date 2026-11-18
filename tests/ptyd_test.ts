// The PTY daemon (desktop/ptyd.ts), its client (desktop/ptyd-client.ts), the keeper of the shells
// a quit keeps (desktop/kept-shells.ts) and their pure parts (lib/ptyd/), over an in-memory
// transport and a fake `Deno.openPty`. The real socket and real shells are in
// tests/ptyd_integration_test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  cutToLine,
  encodeLine,
  historyPrelude,
  LineDecoder,
  parseRequest,
  plainHistory,
  ptydSocketName,
  ptydSocketVersion,
  ReplayRing,
} from "../lib/ptyd/protocol.ts";
import { parseKept, respawnPlan, retarget } from "../lib/ptyd/kept.ts";
import { PtyDaemon } from "../desktop/ptyd.ts";
import { PtydClient } from "../desktop/ptyd-client.ts";
import {
  foregroundGroup,
  type PtyDataEvent,
  type PtyExitEvent,
  PtyHost,
} from "../desktop/pty.ts";
import { TerminalSessions } from "../desktop/terminal-sessions.ts";
import { WorkspaceRegistry } from "../desktop/workspace-host.ts";
import {
  type KeeperDeps,
  KEPT_FILE,
  PREFS_FILE,
  ShellKeeper,
} from "../desktop/kept-shells.ts";
import { guardQuit, keepQuestion } from "../desktop/session.ts";
import { fakeOpenPty, pipePair } from "./ptyd_helpers.ts";
import { fakeExtensionHost, until } from "./session_helpers.ts";

// ---------------------------------------------------------------------------------------------
// The protocol's pure parts
// ---------------------------------------------------------------------------------------------

Deno.test("ptyd protocol: requests are checked", () => {
  assertEquals(parseRequest("nope"), { id: null, error: "not JSON" });
  assertEquals(parseRequest('{"op":"list"}'), {
    id: null,
    error: "no request id",
  });
  assertEquals(parseRequest('{"id":1,"op":"list"}'), {
    id: 1,
    req: { op: "list" },
  });
  assertEquals(parseRequest('{"id":2,"op":"bogus"}'), {
    id: 2,
    error: 'unknown op "bogus"',
  });
  // A relative program, a bad size, an unknown signal: refused.
  const spawn = {
    id: 3,
    op: "spawn",
    sid: "pty-1",
    cmd: "/bin/sh",
    args: ["-l"],
    env: { A: "b" },
    cols: 80,
    rows: 24,
  };
  assert("req" in parseRequest(JSON.stringify(spawn)));
  assert("error" in parseRequest(JSON.stringify({ ...spawn, cmd: "sh" })));
  assert("error" in parseRequest(JSON.stringify({ ...spawn, cols: 0 })));
  assert("error" in parseRequest(JSON.stringify({ ...spawn, env: { A: 1 } })));
  assert(
    "error" in
      parseRequest('{"id":4,"op":"kill","sid":"pty-1","signal":"SIGSTOP"}'),
  );
  assertEquals(
    parseRequest('{"id":5,"op":"kill","sid":"pty-1","signal":"SIGHUP"}'),
    { id: 5, req: { op: "kill", sid: "pty-1", signal: "SIGHUP" } },
  );
});

Deno.test("ptyd protocol: socket names carry the version", () => {
  assertEquals(ptydSocketName(1), "ptyd-1.sock");
  assertEquals(ptydSocketVersion("ptyd-7.sock"), 7);
  assertEquals(ptydSocketVersion("1234"), undefined);
});

Deno.test("ptyd protocol: lines are framed across chunks and UTF-8 splits", () => {
  const d = new LineDecoder();
  const bytes = new TextEncoder().encode(
    encodeLine({ a: "é" }) + encodeLine({ b: 2 }),
  );
  const out: string[] = [];
  for (const b of bytes) out.push(...d.push(new Uint8Array([b])));
  assertEquals(out.map((l) => JSON.parse(l)), [{ a: "é" }, { b: 2 }]);
});

Deno.test("ptyd protocol: the replay ring keeps the newest bytes", () => {
  const r = new ReplayRing(10);
  r.push("12345");
  r.push("67890");
  assertEquals(r.text(), { text: "1234567890", truncated: false });
  r.push("ab");
  assertEquals(r.text(), { text: "67890ab", truncated: true });
  r.push("x".repeat(25));
  assertEquals(r.text().text, "x".repeat(10));
  assertEquals(r.tail(3), { text: "xxx", truncated: true });
  const whole = new ReplayRing(100);
  whole.push("all of it");
  assertEquals(whole.tail(50), { text: "all of it", truncated: false });
  assertEquals(cutToLine("partial\nwhole\n", true), "whole\n");
  assertEquals(cutToLine("whole\n", false), "whole\n");
});

Deno.test("ptyd protocol: plain history drops escapes and keeps the last write of a line", () => {
  const raw = "\x1b]0;title\x07\x1b[1;32mgreen\x1b[0m\r\n" +
    "progress 10%\rprogress 99%\r\n\x1b[?2004h$ ls\r\n\r\n";
  assertEquals(plainHistory(raw), "green\nprogress 99%\n$ ls");
  assertEquals(plainHistory("a\nb\nc", 2), "b\nc");
  assertEquals(historyPrelude("", "x"), "");
  const p = historyPrelude("one\ntwo", "restored");
  assert(p.startsWith("\x1b[2mone\r\ntwo\r\n"));
  assert(p.includes("restored"));
  assert(p.endsWith("\x1b[0m\r\n"));
});

// ---------------------------------------------------------------------------------------------
// The kept record
// ---------------------------------------------------------------------------------------------

const SNAPSHOT = {
  v: 1,
  tiles: {
    t1: { ptyId: "pty-1", profile: { kind: "shell" } },
    t2: { ptyId: "pty-2", profile: { kind: "agent", program: "/x/claude" } },
    t3: { ptyId: "pty-3", profile: { kind: "shell", shell: "/bin/bash" } },
    t4: { ptyId: "pty-4", profile: { kind: "shell", sandbox: true } },
    t5: { web: { url: "https://example.com" } },
  },
};

Deno.test("kept record: parsed, and only plain shell tiles start again", () => {
  assertEquals(parseKept({ v: 2, workspaces: [] }), undefined);
  const rec = parseKept({
    v: 1,
    savedAt: 5,
    workspaces: [{
      id: "ws-a",
      name: "Workspace 1",
      snapshot: SNAPSHOT,
      terms: [
        {
          ptyId: "pty-1",
          shell: "/bin/zsh",
          cwd: "/tmp",
          cols: 80,
          rows: 24,
          history: "h1",
        },
        { ptyId: "pty-2", shell: "/x/claude", cols: 80, rows: 24 },
        { ptyId: "pty-3", shell: "/bin/bash", cols: 100, rows: 30 },
        { ptyId: "pty-4", shell: "/usr/bin/docker", cols: 80, rows: 24 },
        { ptyId: "bad", cols: 0 },
      ],
    }],
  })!;
  assertEquals(rec.workspaces[0].terms.length, 4);
  assertEquals(respawnPlan(rec.workspaces[0]), [
    {
      ptyId: "pty-1",
      shell: "/bin/zsh",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      history: "h1",
    },
    { ptyId: "pty-3", shell: "/bin/bash", cols: 100, rows: 30, history: "" },
  ]);
  const moved = retarget(
    SNAPSHOT,
    new Map([["pty-1", "pty-9"]]),
  ) as typeof SNAPSHOT;
  assertEquals(moved.tiles.t1.ptyId, "pty-9");
  assertEquals(moved.tiles.t3.ptyId, "pty-3");
  assertEquals(moved.tiles.t5, SNAPSHOT.tiles.t5);
});

// ---------------------------------------------------------------------------------------------
// The daemon over the fake transport
// ---------------------------------------------------------------------------------------------

/** A daemon with a fake `Deno.openPty`, and a way to connect clients to it. */
function daemon(greeting?: string) {
  const ptys = fakeOpenPty(greeting);
  let idle = 0;
  const d = new PtyDaemon({
    openPty: ptys.open,
    onIdle: () => idle++,
    pid: 4242,
  });
  const served: Promise<void>[] = [];
  const connect = () => {
    const [server, app] = pipePair();
    served.push(d.serve(server));
    return new PtydClient(app);
  };
  return { d, ptys, connect, idle: () => idle, served };
}

const SPAWN = {
  cmd: "/bin/sh",
  args: ["-l"],
  env: { A: "1" },
  clearEnv: true,
  cols: 80,
  rows: 24,
};

Deno.test("ptyd: spawn, output, input, resize, exit over the client", async () => {
  const { ptys, connect } = daemon();
  const c = connect();
  assertEquals(await c.hello(), { v: 1, pid: 4242 });
  const pty = await c.open("pty-1", SPAWN);
  const fake = ptys.opened[0];
  assertEquals(fake.options.env, { A: "1" });
  assertEquals(fake.options.clearEnv, true);
  const reader = pty.readable.getReader();
  fake.print("héllo");
  assertEquals(new TextDecoder().decode((await reader.read()).value), "héllo");
  const w = pty.writable.getWriter();
  await w.write(new Uint8Array([0x61, 0xff, 0x80]));
  assertEquals([...fake.input].map((ch) => ch.charCodeAt(0)), [
    0x61,
    0xfffd,
    0xfffd,
  ]);
  pty.resize(100, 30);
  await until("resize", () => fake.sizes.length === 1);
  assertEquals(fake.sizes, [[100, 30]]);
  fake.exit(3);
  assertEquals((await pty.status).code, 3);
  assert((await reader.read()).done);
  const [s] = await c.list();
  assertEquals(s.exit, { code: 3, signal: null });
  await c.close();
});

Deno.test("ptyd: output printed before the spawn's answer is not lost", async () => {
  const { connect } = daemon("$ ");
  const c = connect();
  for (let i = 0; i < 20; i++) {
    const pty = await c.open(`pty-${i}`, SPAWN);
    const { value } = await pty.readable.getReader().read();
    assertEquals(new TextDecoder().decode(value), "$ ", `terminal ${i}`);
  }
  await c.close();
});

Deno.test("ptyd: a terminal its app did not let go ends with the app's connection", async () => {
  const { d, ptys, connect, idle } = daemon();
  const c = connect();
  await c.open("pty-1", SPAWN);
  await c.close();
  await until("hang-up", () => ptys.opened[0].ended);
  assertEquals(ptys.opened[0].signals, ["SIGHUP"]);
  await until("idle", () => idle() === 1);
  assertEquals(d.running, 0);
});

Deno.test("ptyd: a kept terminal outlives its app; the next one adopts it with its replay", async () => {
  const { d, ptys, connect, idle } = daemon();
  const first = connect();
  const pty = await first.open("pty-7", SPAWN);
  ptys.opened[0].print("$ export X=1\r\n");
  await until("output", () => d.running === 1);
  pty.detach();
  await first.request("setState", { state: { kept: true } });
  await first.close();
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(ptys.opened[0].ended, false);
  assertEquals(idle(), 0, "a kept shell keeps the daemon up");
  // Output while nobody is attached goes to the replay.
  ptys.opened[0].print("later\r\n");

  const next = connect();
  assertEquals((await next.request("getState", {})).state, { kept: true });
  const [s] = await next.list();
  assertEquals([s.sid, s.attached], ["pty-7", false]);
  const adopted = await next.adopt(s.sid, s.pid);
  assertEquals(adopted.replay, "$ export X=1\r\nlater\r\n");
  assertEquals(adopted.truncated, false);
  const w = adopted.pty.writable.getWriter();
  await w.write(new TextEncoder().encode("echo $X\r"));
  assertEquals(ptys.opened[0].input, "echo $X\r");
  // Ended while attached: the exit comes through.
  ptys.opened[0].exit(0);
  assertEquals((await adopted.pty.status).code, 0);
  await next.request("release", { sid: "pty-7" });
  await next.close();
  await until("idle", () => idle() === 1);
});

Deno.test("ptyd: a kept terminal that ended while detached reports its exit at the attach", async () => {
  const { ptys, connect } = daemon();
  const first = connect();
  const pty = await first.open("pty-1", SPAWN);
  pty.detach();
  await first.request("list", {});
  await first.close();
  ptys.opened[0].print("bye\r\n");
  ptys.opened[0].exit(1);
  const next = connect();
  let [s] = await next.list();
  for (let i = 0; i < 100 && !s.exit; i++) {
    await new Promise((r) => setTimeout(r, 10));
    [s] = await next.list();
  }
  assertEquals(s.exit, { code: 1, signal: null });
  const adopted = await next.adopt(s.sid, s.pid);
  assertEquals(adopted.exit, { code: 1, signal: null });
  assertEquals((await adopted.pty.status).code, 1);
  await next.close();
});

Deno.test("ptyd: errors are answered; shutdown ends every shell and the daemon", async () => {
  const { ptys, connect, idle } = daemon();
  const c = connect();
  await assertRejects(
    () => c.request("write", { sid: "nope", data: "x" }),
    Error,
    "no such terminal",
  );
  await c.open("pty-1", SPAWN);
  await assertRejects(() => c.open("pty-1", SPAWN), Error, "sid in use");
  await assertRejects(
    () => c.request("setState", { state: "x".repeat(5 * 1024 * 1024) }),
    Error,
    "too large",
  );
  await c.request("shutdown", {});
  await until("shells ended", () => ptys.opened[0].ended);
  await until("idle", () => idle() === 1);
  await c.close();
});

Deno.test("ptyd: with no client and nothing running, the start check ends it", () => {
  const { d, idle } = daemon();
  d.idleCheck();
  assertEquals(idle(), 1);
});

// ---------------------------------------------------------------------------------------------
// The PTY host over the daemon, and the keeper
// ---------------------------------------------------------------------------------------------

Deno.test("PtyHost: a terminal in the daemon runs like a local one; adopt and release", async () => {
  const { ptys, connect } = daemon();
  const c = connect();
  const events: (PtyDataEvent | PtyExitEvent)[] = [];
  const host = new PtyHost((_e, d) => void events.push(d), {
    openPty: () => {
      throw new Error("not local");
    },
  });
  const t = await host.spawn(
    { cols: 80, rows: 24, shell: "/bin/sh", cwd: "/" },
    {
      open: (id, o) => c.open(id, o),
      prelude: "old text\r\n",
    },
  );
  assert(host.isRemote(t.id));
  ptys.opened[0].print("new");
  await until(
    "output",
    () => events.some((e) => "data" in e && e.data.includes("new")),
  );
  const text = events.map((e) => "data" in e ? e.data : "").join("");
  assertEquals(text, "old text\r\nnew");
  await host.write(t.id, "ls\r");
  assertEquals(ptys.opened[0].input, "ls\r");
  // Let go: no exit, the daemon keeps it.
  host.release(t.id);
  assertEquals(host.isRunning(t.id), false);
  await c.request("list", {});
  assertEquals(ptys.opened[0].ended, false);

  // Another host adopts it under its id; later spawns get ids after it.
  const adopted = await c.adopt(t.id, ptys.opened[0].pid);
  const host2 = new PtyHost((_e, d) => void events.push(d), {
    openPty: (o) => fakeOpenPty().open(o),
  });
  host2.adopt("pty-41", adopted.pty, {
    shell: "/bin/sh",
    cwd: "/",
    replay: adopted.replay,
  });
  const next = await host2.spawn({
    cols: 80,
    rows: 24,
    shell: "/bin/sh",
    cwd: "/",
  });
  assertEquals(next.id, "pty-42");
  host2.kill("pty-41");
  await until(
    "exit",
    () => events.some((e) => "exitCode" in e && e.id === "pty-41"),
  );
  host2.killAllNow();
  await c.close();
});

Deno.test("PtyHost: output after the foreground group changed says so (a program quit back to its shell)", async () => {
  const local = fakeOpenPty();
  const events: PtyDataEvent[] = [];
  const groups = new Map<number, number>();
  const host = new PtyHost(
    (e, d) => void (e === "data" && events.push(d as PtyDataEvent)),
    { openPty: local.open, foreground: (pid) => groups.get(pid) },
  );
  const t = await host.spawn({
    cols: 80,
    rows: 24,
    shell: "/bin/sh",
    cwd: "/",
  });
  const pty = local.opened[0];
  const print = async (s: string) => {
    const n = events.length;
    pty.print(s);
    await until(JSON.stringify(s), () => events.length > n);
    return events.at(-1)!;
  };
  // No group yet, then the shell's: the first one known is not a change.
  assertEquals((await print("starting\r\n")).fg, undefined);
  groups.set(pty.pid, 100);
  assertEquals((await print("$ ")).fg, undefined);
  // A harness starts (its own group), runs, and quits back to the shell's prompt.
  groups.set(pty.pid, 200);
  assertEquals((await print("✻ Claude Code\r\n")).fg, 200);
  assertEquals((await print("working…\r\n")).fg, undefined);
  groups.set(pty.pid, 100);
  assertEquals((await print("$ ")).fg, 100);
  // The OS will not say (the program is gone): nothing reported.
  groups.delete(pty.pid);
  assertEquals((await print("x")).fg, undefined);
  host.kill(t.id);
  await until("the exit", () => pty.ended);
});

Deno.test("foregroundGroup: undefined for a process that does not exist", () => {
  assertEquals(foregroundGroup(2 ** 30), undefined);
});

/** Fake files for the keeper. */
function memoryFiles(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readText: (p: string) => Promise.resolve(files.get(p)),
    writeText: (p: string, t: string) => void files.set(p, t),
    remove: (p: string) => void files.delete(p),
  };
}

/** One app launch: a registry, terminal sessions and a keeper over the shared daemon. */
function launch(
  dmn: ReturnType<typeof daemon> | undefined,
  files: ReturnType<typeof memoryFiles>,
  answers: number[] = [],
) {
  const workspaces = new WorkspaceRegistry();
  const local = fakeOpenPty();
  const sessions = new TerminalSessions({
    workspaces,
    host: (emit) => new PtyHost(emit, { openPty: local.open }),
  });
  const fake = fakeExtensionHost([{ id: "main", kind: "main", key: "ws-a" }]);
  sessions.connect(fake.host);
  const keeper = new ShellKeeper();
  const clients: PtydClient[] = [];
  const deps: KeeperDeps = {
    sessions,
    workspaces,
    socketDir: () => Promise.resolve("/fake"),
    connect: () => {
      if (!dmn) return Promise.reject(new Error("none"));
      const c = dmn.connect();
      clients.push(c);
      return Promise.resolve(c);
    },
    otherDaemons: () => Promise.resolve([]),
    shutdownDaemon: () => Promise.resolve(),
    appSupportDir: "/app",
    ...files,
    confirm: () => Promise.resolve(answers.shift() ?? 0),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    connectWaitMs: 50,
  };
  /** The app's process ends: its connections to the daemon close. */
  const exit = async () => {
    for (const c of clients) await c.close();
  };
  return { workspaces, sessions, keeper, deps, local, fake, exit };
}

Deno.test("keeper: a kept workspace comes back on its running shells at the next launch", async () => {
  const dmn = daemon();
  const files = memoryFiles();
  const one = launch(dmn, files);
  await one.keeper.start(one.deps);
  assertEquals(one.keeper.keepShells, true);
  one.workspaces.join("main", "ws-a");
  const t = await one.sessions.spawn({
    cols: 90,
    rows: 20,
    shell: "/bin/sh",
    cwd: "/",
  }, {
    id: "main",
  });
  assert(
    one.sessions.host.isRemote(t.id),
    "the tile's shell runs in the daemon",
  );
  // A sandboxed tile stays in the app.
  dmn.ptys.opened[0].print("$ cd /tmp\r\n");
  one.workspaces.save("ws-a", SNAPSHOT_FOR(t.id));
  await until("output", () => dmn.d.running === 1);
  assertEquals(one.keeper.keepable(), 1);
  assertEquals(await one.keeper.keepForNextLaunch(), 1);
  assertEquals(one.sessions.remoteIds(), []);
  const file = JSON.parse(files.files.get(`/app/${KEPT_FILE}`)!);
  assertEquals(file.workspaces[0].id, "ws-a");
  assertEquals(file.workspaces[0].terms[0].ptyId, t.id);
  assert(file.workspaces[0].terms[0].history.includes("$ cd /tmp"));
  // The app quits: its connection ends; the kept shell does not.
  await one.fake.quit();
  await one.exit();
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(dmn.ptys.opened[0].ended, false);

  const two = launch(dmn, files);
  await two.keeper.start(two.deps);
  assertEquals(two.workspaces.ptysOf("ws-a"), [t.id]);
  assertEquals(
    files.files.has(`/app/${KEPT_FILE}`),
    false,
    "the record is used up",
  );
  // The restored window joins and gets the tile back on the same shell, with its replay.
  const joined = two.workspaces.join("main", "ws-a");
  assertEquals((joined.snapshot as typeof SNAPSHOT).tiles.t1.ptyId, t.id);
  await until(
    "the replay",
    () =>
      two.sessions.attachWorkspace("ws-a", "main")[0]?.data.includes(
        "$ cd /tmp",
      ) === true,
  );
  const [replay] = two.sessions.attachWorkspace("ws-a", "main");
  assertEquals(replay.id, t.id);
  assertEquals([replay.cols, replay.rows], [90, 20]);
  assert(replay.data.includes("$ cd /tmp"));
  // "End Shells" at this quit: the daemon ends it once the app is gone.
  await two.fake.quit();
  await until("the shell's end", () => dmn.ptys.opened[0].ended);
  await two.exit();
  await until("the daemon's end", () => dmn.idle() === 1);
});

Deno.test("keeper: a quit right after a tile moved to another window keeps the moved tile", async () => {
  const dmn = daemon();
  const files = memoryFiles();
  const one = launch(dmn, files);
  await one.keeper.start(one.deps);
  one.workspaces.join("main", "ws-a");
  one.workspaces.join("other", "ws-b");
  const t = await one.sessions.spawn({
    cols: 80,
    rows: 24,
    shell: "/bin/sh",
    cwd: "/",
  }, { id: "main" });
  await until("the shell", () => dmn.d.running === 1);
  one.workspaces.save("ws-a", {
    v: 1,
    seq: 1,
    terminals: [MOVED_ENTRY("t1")],
    mru: ["t1"],
    tiles: { t1: { ptyId: t.id, profile: { kind: "shell" } } },
  });
  // The move (desktop/tile-move.ts): the source snapshot loses the tile, the terminal changes
  // workspace, and the target holds it as a pending arrival until its page saves it. The quit
  // comes before that save.
  one.workspaces.save("ws-a", {
    v: 1,
    seq: 1,
    terminals: [],
    mru: [],
    tiles: {},
  });
  one.workspaces.movePty(t.id, "ws-b");
  one.workspaces.addArrival("ws-b", "m-1", {
    tile: {
      entry: MOVED_ENTRY("t1"),
      tile: { ptyId: t.id, profile: { kind: "shell" } },
    },
  });
  assertEquals(await one.keeper.keepForNextLaunch(), 1);
  const file = JSON.parse(files.files.get(`/app/${KEPT_FILE}`)!);
  const kept = file.workspaces.find((w: { id: string }) => w.id === "ws-b");
  assertEquals(kept.terms.map((x: { ptyId: string }) => x.ptyId), [t.id]);
  const keptTiles = Object.values(
    kept.snapshot.tiles as Record<string, { ptyId?: string }>,
  );
  assertEquals(
    keptTiles.map((x) => x.ptyId),
    [t.id],
    "the moved tile is in the record",
  );
  await one.fake.quit();
  await one.exit();

  // The next launch: the target window comes back with the tile on its running shell.
  const two = launch(dmn, files);
  await two.keeper.start(two.deps);
  assertEquals(two.workspaces.ptysOf("ws-b"), [t.id]);
  const joined = two.workspaces.join("other", "ws-b");
  const tiles = Object.values(
    (joined.snapshot as { tiles: Record<string, { ptyId?: string }> }).tiles,
  );
  assertEquals(tiles.map((x) => x.ptyId), [t.id]);
  await two.fake.quit();
  await until("the shell's end", () => dmn.ptys.opened[0].ended);
  await two.exit();
});

/** A tile entry as a snapshot (or a moved tile) holds it. */
function MOVED_ENTRY(id: string) {
  return {
    id,
    title: "zsh",
    createdAt: 1,
    lastUsedAt: 2,
    exited: false,
    exitCode: null,
    activity: false,
  };
}

/** A snapshot with one shell tile on `pty`. */
function SNAPSHOT_FOR(pty: string) {
  return { v: 1, tiles: { t1: { ptyId: pty, profile: { kind: "shell" } } } };
}

Deno.test("keeper: with the daemon gone, the shell tiles start again in their folder with their history", async () => {
  const record = {
    v: 1,
    savedAt: 1,
    workspaces: [{
      id: "ws-a",
      name: "Workspace 3",
      snapshot: SNAPSHOT_FOR("pty-5"),
      terms: [{
        ptyId: "pty-5",
        shell: "/bin/sh",
        cwd: "/tmp",
        cols: 70,
        rows: 20,
        history: "$ make\nok",
      }],
    }],
  };
  // No daemon at all, and a fresh one with nothing kept (the sidecar started it after a reboot).
  for (const dmn of [undefined, daemon()]) {
    const files = memoryFiles({
      [`/app/${KEPT_FILE}`]: JSON.stringify(record),
    });
    const app = launch(dmn, files);
    await app.keeper.start(app.deps);
    const [pty] = app.workspaces.ptysOf("ws-a");
    assert(pty !== undefined && pty !== "pty-5");
    const opened = dmn ? dmn.ptys.opened : app.local.opened;
    assertEquals(opened[0].options.cwd, "/tmp");
    await restoredWorkspace(app, pty, files.files);
    await app.exit();
  }
});

/** The respawned workspace: its snapshot on the new PTY, its dimmed history, the record used up. */
async function restoredWorkspace(
  app: ReturnType<typeof launch>,
  pty: string,
  files: Map<string, string>,
): Promise<void> {
  const snap = app.workspaces.snapshotOf("ws-a") as ReturnType<
    typeof SNAPSHOT_FOR
  >;
  assertEquals(snap.tiles.t1.ptyId, pty);
  await until(
    "the history",
    () =>
      app.sessions.attachWorkspace("ws-a", "main")[0]?.data.includes(
        "\x1b[2m$ make\r\nok\r\n",
      ) === true,
  );
  assertEquals(app.workspaces.list()[0].name, "Workspace 3");
  assertEquals(files.size, 0);
  await app.sessions.disposeAll();
}

Deno.test("keeper: the setting is saved, and off means shells run in the app", async () => {
  const dmn = daemon();
  const files = memoryFiles({ [`/app/${PREFS_FILE}`]: '{"keepShells":false}' });
  const app = launch(dmn, files);
  await app.keeper.start(app.deps);
  assertEquals(app.keeper.keepShells, false);
  app.workspaces.join("main", "ws-a");
  const t = await app.sessions.spawn({
    cols: 80,
    rows: 24,
    shell: "/bin/sh",
    cwd: "/",
  }, {
    id: "main",
  });
  assertEquals(app.sessions.host.isRemote(t.id), false);
  assertEquals(app.keeper.keepable(), 0);
  app.keeper.setKeepShells(true);
  assertEquals(files.files.get(`/app/${PREFS_FILE}`), '{"keepShells":true}');
  await app.sessions.disposeAll();
  await app.fake.quit();
});

Deno.test("quit: the keep question, its default and its three answers", async () => {
  const q = keepQuestion(2, []);
  assertEquals(q.buttons, ["Keep Shells Running", "End Shells", "Cancel"]);
  assertEquals([q.defaultId, q.cancelId], [0, 2]);
  assertEquals(q.message, "2 shells are running");
  assert(
    keepQuestion(1, [{ ptyId: "pty-1", name: "claude" }]).detail!.includes(
      "claude",
    ),
  );
  for (
    const [answer, quits, kept] of [[0, true, 1], [1, true, 0], [2, false, 0]]
  ) {
    const host = fakeExtensionHost();
    let keptCalls = 0;
    const off = guardQuit(
      { ...host.host, confirm: () => Promise.resolve(answer as number) },
      {
        keepable: () => 1,
        keepForNextLaunch: () => Promise.resolve(++keptCalls),
      },
    );
    assertEquals(await host.beforeQuit(), quits, `answer ${answer}`);
    assertEquals(keptCalls, kept);
    off();
  }
});
