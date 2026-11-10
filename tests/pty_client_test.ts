// The page-side PTY client (lib/pty-client.ts) without a desktop runtime: the desktop backend runs
// over a fake bridge + event source (injected through `createDesktopBackend(deps)`), and the
// shared fan-out (`PtyEvents`) is tested directly, with fake time for the 30 s TTL.
// Run: deno test -A tests/

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
// deno.json is not ours to edit (no "@std/testing" import), so the specifier is inline.
// deno-lint-ignore no-import-prefix
import { FakeTime } from "jsr:@std/testing@^1.0.0/time";
import {
  createDemoBackend,
  createDesktopBackend,
  demoBackend,
  desktopBackend,
  type DesktopBridgeDeps,
  getPtyBackend,
  isDesktop,
  PtyEvents,
  type PtyExit,
  type SshTransferEvent,
} from "../lib/pty-client.ts";

// ---------------------------------------------------------------------------------------------
// A fake `denext/desktop/client`
// ---------------------------------------------------------------------------------------------

type Handler = (data: unknown) => void;

class FakeBridge {
  /** Every RPC, in order. */
  calls: { method: string; args: unknown }[] = [];
  /** Per-method responders; the default resolves `undefined`. */
  responders: Record<string, (args: unknown) => unknown> = {};
  /** `cap:event` → handlers. */
  handlers = new Map<string, Set<Handler>>();
  subscribeCount = 0;
  extensionNames: string[] = [];
  /** Snapshot of the subscriptions at the moment `spawn` was called. */
  subscribedAtSpawn: string[] = [];

  deps(): DesktopBridgeDeps {
    const desktopExtension = ((name: string) => {
      this.extensionNames.push(name);
      return new Proxy({}, {
        get: (_t, method) => {
          if (typeof method !== "string" || method === "then") return undefined;
          return (args: unknown) => {
            if (method === "spawn") {
              this.subscribedAtSpawn = [...this.handlers.keys()];
            }
            this.calls.push({ method, args });
            try {
              return Promise.resolve(this.responders[method]?.(args));
            } catch (err) {
              return Promise.reject(err);
            }
          };
        },
      });
    }) as unknown as DesktopBridgeDeps["desktopExtension"];
    const onDesktopEvent = ((cap: string, event: string, handler: Handler) => {
      this.subscribeCount++;
      const key = `${cap}:${event}`;
      let set = this.handlers.get(key);
      if (!set) this.handlers.set(key, set = new Set());
      set.add(handler);
      return () => set!.delete(handler);
    }) as unknown as DesktopBridgeDeps["onDesktopEvent"];
    // Denext's `system` (the `systemStats` capability), not an extension.
    const system: DesktopBridgeDeps["system"] = {
      stats: (options) => {
        this.calls.push({ method: "system.stats", args: options });
        return Promise.resolve({
          at: 1234,
          cpu: { total: 23.5 },
          gpu: { utilization: null },
          memory: { pressure: 41 },
        });
      },
    };
    return { desktopExtension, onDesktopEvent, system };
  }

  fire(event: "data" | "exit", data: unknown): void {
    for (const h of this.handlers.get(`pty:${event}`) ?? []) h(data);
  }
  transfer(
    data: Partial<SshTransferEvent> & { transferId: string; seq: number },
  ): void {
    const event = {
      kind: "upload",
      percent: 0,
      filesDone: 0,
      done: false,
      ...data,
    };
    for (const h of this.handlers.get("ssh:transfer") ?? []) h(event);
  }
  hub(event: "tiles" | "ask" | "askClosed", data: unknown): void {
    for (const h of this.handlers.get(`hub:${event}`) ?? []) h(data);
  }
  // The extension sends a terminal's events as `{ id, data }` (desktop/terminal-sessions.ts).
  data(id: string, seq: number, data: string): void {
    this.fire("data", { id, data: { seq, data } });
  }
  exit(id: string, exitCode = 0, signal: number | null = null): void {
    this.fire("exit", { id, data: { exitCode, signal } });
  }
}

function setup() {
  const bridge = new FakeBridge();
  const backend = createDesktopBackend(bridge.deps());
  return { bridge, backend };
}

/** Collects one id's output. */
function collect(
  backend: { onData(id: string, cb: (d: string) => void): () => void },
  id: string,
) {
  const chunks: string[] = [];
  const off = backend.onData(id, (d) => chunks.push(d));
  return { chunks, text: () => chunks.join(""), off };
}

const microtask = () => new Promise<void>((r) => queueMicrotask(r));

// ---------------------------------------------------------------------------------------------
// Desktop backend over the fake bridge
// ---------------------------------------------------------------------------------------------

Deno.test("desktop: kind, extension name, and no bridge traffic at creation", () => {
  const { bridge, backend } = setup();
  assertEquals(backend.kind, "desktop");
  assertEquals(bridge.extensionNames, [
    "pty",
    "ssh",
    "hub",
    "sandbox",
    "ollama",
    "links",
    "session",
  ]);
  assertEquals(bridge.calls, []);
  assertEquals(bridge.subscribeCount, 0, "subscribes lazily");
});

Deno.test("desktop: the links methods go to the links extension as they are", async () => {
  const { bridge, backend } = setup();
  await backend.linkResolve(undefined, ["a.ts"]);
  await backend.linkResolve("/p", ["b.ts"]);
  await backend.linkOpen({ kind: "reveal", path: "/p" });
  await backend.linkEditors();
  await backend.linkEdit({ command: "zed {file}", file: "/p/a", line: 2 });
  assertEquals(bridge.calls, [
    { method: "resolve", args: { paths: ["a.ts"] } },
    { method: "resolve", args: { cwd: "/p", paths: ["b.ts"] } },
    { method: "open", args: { kind: "reveal", path: "/p" } },
    { method: "editors", args: {} },
    { method: "edit", args: { command: "zed {file}", file: "/p/a", line: 2 } },
  ]);
});

Deno.test("desktop: a system monitor sample is one system.stats() call, as the monitor's figures", async () => {
  const { bridge, backend } = setup();
  assertEquals(await backend.sysSample(), {
    cpu: 23.5,
    gpu: null,
    mem: 41,
    at: 1234,
  });
  assertEquals(bridge.calls, [{ method: "system.stats", args: undefined }]);
});

Deno.test("desktop: spawn subscribes to data and exit before calling the extension", async () => {
  const { bridge, backend } = setup();
  bridge.responders.spawn = () => ({
    id: "pty-1",
    pid: 42,
    shell: "/bin/zsh",
    cwd: "/tmp",
  });
  const res = await backend.spawn({ cols: 80, rows: 24, cwd: "/tmp" });
  assertEquals(res, { id: "pty-1", pid: 42, shell: "/bin/zsh", cwd: "/tmp" });
  assertEquals(bridge.calls, [{
    method: "spawn",
    args: { cols: 80, rows: 24, cwd: "/tmp" },
  }]);
  assertEquals(bridge.subscribedAtSpawn.sort(), ["pty:data", "pty:exit"]);
});

Deno.test("desktop: subscribes once however many spawns and listeners", async () => {
  const { bridge, backend } = setup();
  bridge.responders.spawn = () => ({ id: "x", pid: 1, shell: "s", cwd: "/" });
  backend.onData("a", () => {});
  backend.onExit("a", () => {});
  await backend.spawn({ cols: 1, rows: 1 });
  await backend.spawn({ cols: 1, rows: 1 });
  backend.onData("b", () => {});
  assertEquals(bridge.subscribeCount, 2);
});

Deno.test("desktop: write/resize/kill/info forward exactly their arguments", async () => {
  const { bridge, backend } = setup();
  bridge.responders.info = (a) => ({
    ...(a as object),
    pid: 7,
    process: "vim",
    cwd: "/x",
  });
  await backend.write("pty-3", "ls\r");
  await backend.resize("pty-3", 120, 40);
  await backend.kill("pty-3");
  const info = await backend.info("pty-3");
  assertEquals(bridge.calls, [
    { method: "write", args: { id: "pty-3", data: "ls\r" } },
    { method: "resize", args: { id: "pty-3", cols: 120, rows: 40 } },
    { method: "kill", args: { id: "pty-3" } },
    { method: "info", args: { id: "pty-3" } },
  ]);
  assertEquals(info, { id: "pty-3", pid: 7, process: "vim", cwd: "/x" });
  // write/resize/kill resolve to undefined whatever the bridge answers.
  bridge.responders.write = () => "ignored";
  assertStrictEquals(await backend.write("pty-3", "x"), undefined);
});

Deno.test("desktop: ssh methods forward to the ssh extension with exactly their arguments", async () => {
  const { bridge, backend } = setup();
  bridge.responders.sshHosts = () => ({ hosts: [], recents: [] });
  bridge.responders.sshCommand = () => ({
    program: "ssh",
    args: ["--", "a"],
    label: "a",
  });
  bridge.responders.sshUpload = () => ({ transferId: "t1" });
  bridge.responders.sshList = () => ({ path: "/", entries: [] });
  assertEquals(await backend.sshHosts(), { hosts: [], recents: [] });
  await backend.sshSaveHost({ alias: "a", user: "u" });
  await backend.sshDeleteHost("a");
  assertEquals((await backend.sshCommand({ alias: "a" })).label, "a");
  const upload = { target: { alias: "a" }, localPaths: ["/x"], remoteDir: "~" };
  assertEquals(await backend.sshUpload(upload), { transferId: "t1" });
  const download = { target: { host: "h" }, remotePath: "/r" };
  await backend.sshDownload(download);
  const list = { target: { alias: "a" }, path: "/etc" };
  assertEquals(await backend.sshList(list), { path: "/", entries: [] });
  await backend.sshCancel("t1");
  assertEquals(bridge.calls, [
    { method: "sshHosts", args: {} },
    { method: "sshSaveHost", args: { alias: "a", user: "u" } },
    { method: "sshDeleteHost", args: { alias: "a" } },
    { method: "sshCommand", args: { target: { alias: "a" } } },
    { method: "sshUpload", args: upload },
    { method: "sshDownload", args: download },
    { method: "sshList", args: list },
    { method: "sshCancel", args: { transferId: "t1" } },
  ]);
  // Starting a transfer subscribes to its events (once), before the extension is asked.
  assertEquals([...bridge.handlers.keys()], ["ssh:transfer"]);
  assertEquals(bridge.subscribeCount, 1);
});

Deno.test("desktop: transfer events are fanned out, deduped per transfer by seq, also after done", () => {
  const { bridge, backend } = setup();
  const got: string[] = [];
  const off = backend.onTransfer((e) =>
    got.push(`${e.transferId}:${e.seq}:${e.percent}`)
  );
  backend.onTransfer(() => {});
  assertEquals(
    bridge.subscribeCount,
    1,
    "one subscription however many listeners",
  );
  bridge.transfer({ transferId: "t1", seq: 1, percent: 10 });
  bridge.transfer({ transferId: "t1", seq: 1, percent: 10 }); // replay
  bridge.transfer({ transferId: "t1", seq: 2, percent: 50 });
  bridge.transfer({ transferId: "t2", seq: 1, percent: 5 }); // another transfer's own numbering
  bridge.transfer({ transferId: "t1", seq: 3, percent: 100, done: true });
  bridge.transfer({ transferId: "t1", seq: 3, percent: 100, done: true }); // replay after done
  bridge.transfer({ transferId: "t1", seq: 2, percent: 50 }); // stale
  assertEquals(got, ["t1:1:10", "t1:2:50", "t2:1:5", "t1:3:100"]);
  off();
  bridge.transfer({ transferId: "t2", seq: 2, percent: 50 });
  assertEquals(got.length, 4);
});

Deno.test("desktop: bridge errors reach the caller", async () => {
  const { bridge, backend } = setup();
  const boom = new Error("not_found");
  for (const m of ["spawn", "write", "resize", "kill", "info"]) {
    bridge.responders[m] = () => {
      throw boom;
    };
  }
  await assertRejects(
    () => backend.spawn({ cols: 80, rows: 24 }),
    Error,
    "not_found",
  );
  await assertRejects(() => backend.write("a", "x"), Error, "not_found");
  await assertRejects(() => backend.resize("a", 1, 1), Error, "not_found");
  await assertRejects(() => backend.kill("a"), Error, "not_found");
  await assertRejects(() => backend.info("a"), Error, "not_found");
});

Deno.test("desktop: hub methods forward to the hub extension with exactly their arguments", async () => {
  const { bridge, backend } = setup();
  const snapshot = { running: true, tiles: [], asks: [] };
  bridge.responders.snapshot = () => snapshot;
  bridge.responders.answer = () => true;
  bridge.responders.integrationStatus = () => [];
  bridge.responders.integrationInstall = () => {
    throw new Error("~/.claude.json already has a qutty entry");
  };
  assertEquals(await backend.hubSnapshot(), snapshot);
  assertEquals(await backend.hubAnswer("ask-1", "Yes"), true);
  await backend.hubAnswer("ask-2", null);
  assertStrictEquals(await backend.hubSetLabel("pty-3", "vim"), undefined);
  assertEquals(await backend.integrationStatus(), []);
  await assertRejects(
    () => backend.integrationInstall("claude"),
    Error,
    "already has a qutty entry",
  );
  await backend.integrationUninstall("codex");
  assertEquals(bridge.calls, [
    { method: "snapshot", args: {} },
    { method: "answer", args: { id: "ask-1", action: "Yes" } },
    { method: "answer", args: { id: "ask-2", action: null } },
    { method: "setLabel", args: { id: "pty-3", label: "vim" } },
    { method: "integrationStatus", args: {} },
    { method: "integrationInstall", args: { target: "claude" } },
    { method: "integrationUninstall", args: { target: "codex" } },
  ]);
  assertEquals(bridge.subscribeCount, 0, "no events subscribed by calls");
});

Deno.test("desktop: hub events subscribe once, lazily; asks are deduped by id, also after closing", () => {
  const { bridge, backend } = setup();
  const tiles: number[] = [];
  const asks: string[] = [];
  const closed: string[] = [];
  backend.onHubTiles((s) => tiles.push(s.tiles.length));
  const offAsk = backend.onHubAsk((r) => asks.push(r.id));
  backend.onHubAskClosed((id) => closed.push(id));
  assertEquals(
    [...bridge.handlers.keys()].sort(),
    ["hub:ask", "hub:askClosed", "hub:tiles"],
  );
  assertEquals(bridge.subscribeCount, 3);
  const ask = (id: string) => ({
    id,
    from: "pty-1",
    fromName: "claude",
    text: "?",
    actions: [],
  });
  bridge.hub("tiles", { running: true, tiles: [] });
  bridge.hub("ask", ask("a1"));
  bridge.hub("ask", ask("a1")); // replay
  bridge.hub("ask", ask("a2"));
  bridge.hub("askClosed", { id: "a1" });
  bridge.hub("ask", ask("a1")); // replayed after it closed
  bridge.hub("askClosed", { id: "a3" });
  bridge.hub("ask", ask("a3")); // closed before it arrived
  assertEquals(tiles, [0]);
  assertEquals(asks, ["a1", "a2"]);
  assertEquals(closed, ["a1", "a3"]);
  offAsk();
  bridge.hub("ask", ask("a4"));
  assertEquals(asks, ["a1", "a2"]);
});

Deno.test("desktop: output before the first subscriber is delivered to it, once", async () => {
  const { bridge, backend } = setup();
  bridge.responders.spawn = () => {
    // The shell's banner races spawn's reply.
    bridge.data("pty-1", 1, "Last login: ");
    bridge.data("pty-1", 2, "today\r\n");
    return { id: "pty-1", pid: 1, shell: "/bin/sh", cwd: "/" };
  };
  const { id } = await backend.spawn({ cols: 80, rows: 24 });
  bridge.data(id, 3, "$ ");
  const first = collect(backend, id);
  assertEquals(
    first.chunks,
    ["Last login: today\r\n$ "],
    "backlog arrives as one chunk",
  );
  const second = collect(backend, id);
  assertEquals(
    second.chunks,
    [],
    "the backlog goes to the first subscriber only",
  );
  bridge.data(id, 4, "ls\r\n");
  assertEquals(first.text(), "Last login: today\r\n$ ls\r\n");
  assertEquals(second.text(), "ls\r\n");
  first.off();
  second.off();
});

Deno.test("desktop: fan-out to many subscribers, unsubscribe, and re-buffering", () => {
  const { bridge, backend } = setup();
  const subs = Array.from({ length: 5 }, () => collect(backend, "pty-9"));
  bridge.data("pty-9", 1, "a");
  for (const s of subs) assertEquals(s.text(), "a");
  subs[0].off();
  subs[0].off(); // idempotent
  bridge.data("pty-9", 2, "b");
  assertEquals(subs[0].text(), "a");
  for (const s of subs.slice(1)) assertEquals(s.text(), "ab");
  for (const s of subs.slice(1)) s.off();
  // Nobody listens: output is buffered again for the next subscriber (a remounted tile).
  bridge.data("pty-9", 3, "c");
  bridge.data("pty-9", 4, "d");
  for (const s of subs) assertEquals(s.text().includes("c"), false);
  const late = collect(backend, "pty-9");
  assertEquals(late.chunks, ["cd"]);
  late.off();
});

Deno.test("desktop: output is routed by id", () => {
  const { bridge, backend } = setup();
  const a = collect(backend, "pty-1");
  const b = collect(backend, "pty-2");
  bridge.data("pty-1", 1, "one");
  bridge.data("pty-2", 1, "two");
  bridge.data("pty-1", 2, "uno");
  bridge.data("pty-3", 1, "three");
  assertEquals(a.text(), "oneuno");
  assertEquals(b.text(), "two");
  const c = collect(backend, "pty-3");
  assertEquals(c.text(), "three");
  a.off();
  b.off();
  c.off();
});

Deno.test("desktop: seq dedupe drops replays and stale frames, per id", () => {
  const { bridge, backend } = setup();
  const a = collect(backend, "pty-1");
  const b = collect(backend, "pty-2");
  for (let s = 1; s <= 3; s++) bridge.data("pty-1", s, `a${s}`);
  // A reconnect replays the buffer: every frame is a repeat.
  for (let s = 1; s <= 3; s++) bridge.data("pty-1", s, `a${s}`);
  bridge.data("pty-1", 2, "stale");
  bridge.data("pty-1", 0, "zero");
  bridge.data("pty-1", -1, "negative");
  // Ids have independent sequences.
  bridge.data("pty-2", 1, "b1");
  bridge.data("pty-2", 1, "b1");
  bridge.data("pty-1", 4, "a4");
  // A gap (a lost frame) is not waited for: later frames still arrive.
  bridge.data("pty-1", 7, "a7");
  bridge.data("pty-1", 5, "late");
  assertEquals(a.chunks, ["a1", "a2", "a3", "a4", "a7"]);
  assertEquals(b.chunks, ["b1"]);
  a.off();
  b.off();
});

Deno.test("desktop: seq dedupe also covers output buffered before a subscriber", async () => {
  const { bridge, backend } = setup();
  await backend.spawn({ cols: 80, rows: 24 }); // starts listening
  bridge.data("pty-1", 1, "x");
  bridge.data("pty-1", 1, "x");
  bridge.data("pty-1", 2, "y");
  bridge.data("pty-1", 1, "x");
  const a = collect(backend, "pty-1");
  assertEquals(a.chunks, ["xy"]);
  a.off();
});

Deno.test("desktop: a replay after the exit does not repeat the output", async () => {
  const { bridge, backend } = setup();
  const a = collect(backend, "pty-1");
  const exits: PtyExit[] = [];
  backend.onExit("pty-1", (e) => exits.push(e));
  bridge.data("pty-1", 1, "hello ");
  bridge.data("pty-1", 2, "world");
  bridge.exit("pty-1", 0);
  // The at-least-once stream reconnects and replays its buffer, exit included.
  bridge.data("pty-1", 1, "hello ");
  bridge.data("pty-1", 2, "world");
  bridge.exit("pty-1", 0);
  await microtask();
  assertEquals(a.text(), "hello world");
  assertEquals(exits, [{ exitCode: 0, signal: null }]);
  a.off();
});

Deno.test("desktop: onExit is delivered once, to every subscriber, with code and signal", async () => {
  const { bridge, backend } = setup();
  const got: [string, PtyExit][] = [];
  backend.onExit("pty-1", (e) => got.push(["a", e]));
  backend.onExit("pty-1", (e) => got.push(["b", e]));
  const offC = backend.onExit("pty-1", (e) => got.push(["c", e]));
  backend.onExit("pty-2", (e) => got.push(["other", e]));
  offC();
  bridge.exit("pty-1", 0, 1);
  bridge.exit("pty-1", 5, null); // a repeat: ignored, even with different values
  assertEquals(got, [["a", { exitCode: 0, signal: 1 }], ["b", {
    exitCode: 0,
    signal: 1,
  }]]);

  // Subscribing after the exit: delivered asynchronously (a microtask), with the first values.
  const late: PtyExit[] = [];
  const off = backend.onExit("pty-1", (e) => late.push(e));
  assertEquals(late, [], "not synchronous");
  await microtask();
  assertEquals(late, [{ exitCode: 0, signal: 1 }]);
  off(); // a no-op, must not throw
  assertEquals(got.length, 2);
});

Deno.test("desktop: an exit does not drop output that is still buffered", async () => {
  const { bridge, backend } = setup();
  await backend.spawn({ cols: 80, rows: 24 }); // starts listening
  bridge.data("pty-1", 1, "bye\r\n");
  bridge.exit("pty-1", 3);
  const a = collect(backend, "pty-1");
  assertEquals(a.text(), "bye\r\n");
  a.off();
});

// ---------------------------------------------------------------------------------------------
// PtyEvents: the early-output buffer, its cap and its TTL
// ---------------------------------------------------------------------------------------------

Deno.test("PtyEvents: claiming the backlog clears the TTL timer (no leaked timer)", () => {
  // Real timers on purpose: the op sanitizer fails this test if the 30 s timer survives.
  const ev = new PtyEvents();
  ev.emitData("a", "1");
  ev.emitData("a", "2");
  const got: string[] = [];
  const off = ev.onData("a", (d) => got.push(d));
  assertEquals(got, ["12"]);
  off();
});

Deno.test("PtyEvents: unclaimed output expires after 30 s (fake time)", () => {
  const time = new FakeTime();
  try {
    const ev = new PtyEvents();
    ev.emitData("a", "early");
    time.tick(29_999);
    ev.emitData("a", "+later"); // does not extend the TTL: it counts from the first chunk
    time.tick(1);
    const got: string[] = [];
    const off = ev.onData("a", (d) => got.push(d));
    assertEquals(got, [], "dropped at 30 s");
    off();

    // Expired just before claiming vs just after: 29 999 ms is still there.
    ev.emitData("b", "kept");
    time.tick(29_999);
    const gotB: string[] = [];
    const offB = ev.onData("b", (d) => gotB.push(d));
    assertEquals(gotB, ["kept"]);
    offB();
    time.tick(60_000); // the cleared timer must not fire into a later buffer
    ev.emitData("b", "x");
    assertEquals(gotB, ["kept"], "no subscriber: buffered, not delivered");
    const gotB2: string[] = [];
    const offB2 = ev.onData("b", (d) => gotB2.push(d));
    assertEquals(gotB2, ["x"]);
    offB2();
  } finally {
    time.restore();
  }
});

Deno.test("PtyEvents: after expiry a new buffer starts with a fresh TTL", () => {
  const time = new FakeTime();
  try {
    const ev = new PtyEvents();
    ev.emitData("a", "old");
    time.tick(30_000);
    ev.emitData("a", "new");
    time.tick(29_000);
    const got: string[] = [];
    const off = ev.onData("a", (d) => got.push(d));
    assertEquals(got, ["new"]);
    off();
  } finally {
    time.restore();
  }
});

Deno.test("PtyEvents: TTLs are per id", () => {
  const time = new FakeTime();
  try {
    const ev = new PtyEvents();
    ev.emitData("a", "A");
    time.tick(20_000);
    ev.emitData("b", "B");
    time.tick(10_000); // a expires, b has 20 s left
    const got: string[] = [];
    ev.onData("a", (d) => got.push(`a:${d}`))();
    ev.onData("b", (d) => got.push(`b:${d}`))();
    assertEquals(got, ["b:B"]);
  } finally {
    time.restore();
  }
});

Deno.test("PtyEvents: the backlog is capped at 512K chars, keeping the newest output", () => {
  const time = new FakeTime();
  try {
    const ev = new PtyEvents();
    const CAP = 512 * 1024;
    const chunks: string[] = [];
    for (let i = 0; i < 700; i++) {
      // 1 KiB chunks, each tagged so order and contiguity can be checked.
      const tag = `<${i}>`;
      chunks.push(tag + "x".repeat(1024 - tag.length));
    }
    for (const c of chunks) ev.emitData("a", c);
    let backlog = "";
    ev.onData("a", (d) => backlog += d)();
    assertEquals(backlog.length, CAP);
    assertEquals(
      backlog,
      chunks.slice(700 - 512).join(""),
      "the newest 512 chunks, in order",
    );
  } finally {
    time.restore();
  }
});

Deno.test("PtyEvents: cap with uneven chunks keeps a contiguous suffix within the cap", () => {
  const time = new FakeTime();
  try {
    const ev = new PtyEvents();
    const CAP = 512 * 1024;
    let all = "";
    let seed = 1;
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const len = 1 + (seed % 9000);
      const c = String.fromCharCode(65 + (i % 26)).repeat(len);
      all += c;
      ev.emitData("a", c);
    }
    let backlog = "";
    ev.onData("a", (d) => backlog += d)();
    assert(backlog.length <= CAP, `backlog ${backlog.length}`);
    assert(backlog.length > CAP - 9000, "drops no more than needed");
    assert(all.endsWith(backlog), "a suffix of the stream");
  } finally {
    time.restore();
  }
});

Deno.test("PtyEvents: a single chunk larger than the cap is kept whole (documented limit)", () => {
  const time = new FakeTime();
  try {
    const ev = new PtyEvents();
    const big = "z".repeat(600 * 1024);
    ev.emitData("a", big);
    let backlog = "";
    ev.onData("a", (d) => backlog += d)();
    assertEquals(backlog.length, big.length);
    // ...but it is dropped as soon as a newer chunk arrives.
    ev.emitData("b", big);
    ev.emitData("b", "tail");
    let b = "";
    ev.onData("b", (d) => b += d)();
    assertEquals(b, "tail");
  } finally {
    time.restore();
  }
});

Deno.test("PtyEvents: empty chunks are buffered but an empty backlog is not delivered", () => {
  const time = new FakeTime();
  try {
    const ev = new PtyEvents();
    ev.emitData("a", "");
    const got: string[] = [];
    ev.onData("a", (d) => got.push(d))();
    assertEquals(got, []);
  } finally {
    time.restore();
  }
});

Deno.test("PtyEvents: exit is sticky, once, and independent of data subscribers", async () => {
  const ev = new PtyEvents();
  const got: PtyExit[] = [];
  ev.onExit("a", (e) => got.push(e));
  ev.emitExit("a", { exitCode: 2, signal: null });
  ev.emitExit("a", { exitCode: 9, signal: 9 });
  assertEquals(got, [{ exitCode: 2, signal: null }]);
  // Re-subscribing after delivery: the stored exit, asynchronously.
  const again: PtyExit[] = [];
  ev.onExit("a", (e) => again.push(e));
  await microtask();
  assertEquals(again, [{ exitCode: 2, signal: null }]);
  // Data after exit is still fanned out (the host never sends it, but nothing breaks).
  const data: string[] = [];
  const off = ev.onData("a", (d) => data.push(d));
  ev.emitData("a", "late");
  assertEquals(data, ["late"]);
  off();
});

Deno.test("PtyEvents: a subscriber that unsubscribes during delivery does not skip others", () => {
  const ev = new PtyEvents();
  const got: string[] = [];
  let offA = () => {};
  offA = ev.onData("a", (d) => {
    got.push(`A${d}`);
    offA();
  });
  const offB = ev.onData("a", (d) => got.push(`B${d}`));
  ev.emitData("a", "1");
  ev.emitData("a", "2");
  assertEquals(got, ["A1", "B1", "B2"]);
  offB();
});

// ---------------------------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------------------------

Deno.test("selection: outside the desktop window the demo backend is used", () => {
  assertEquals(isDesktop(), false);
  assertEquals(getPtyBackend().kind, "demo");
  assertStrictEquals(getPtyBackend(), demoBackend(), "a singleton");
  assertStrictEquals(demoBackend(), demoBackend());
  assert(
    createDemoBackend() !== demoBackend(),
    "create* gives a fresh instance",
  );
});

Deno.test("selection: the desktop marker picks the desktop backend; ?pty=demo forces the demo", () => {
  const g = globalThis as { __denext?: unknown };
  const hadLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  g.__denext = {
    desktop: true,
    os: Deno.build.os === "darwin" ? "darwin" : "linux",
  };
  try {
    assertEquals(isDesktop(), true);
    const be = getPtyBackend();
    assertEquals(be.kind, "desktop");
    assertStrictEquals(be, desktopBackend());
    Object.defineProperty(globalThis, "location", {
      value: { search: "?pty=demo" },
      configurable: true,
    });
    assertEquals(getPtyBackend().kind, "demo");
    Object.defineProperty(globalThis, "location", {
      value: { search: "?pty=other&x=1" },
      configurable: true,
    });
    assertEquals(getPtyBackend().kind, "desktop");
    // A marker without the desktop flag, or an unknown os, is not the desktop.
    g.__denext = { desktop: false, os: "darwin" };
    assertEquals(isDesktop(), false);
    g.__denext = { desktop: true, os: "plan9" };
    assertEquals(isDesktop(), false);
  } finally {
    delete g.__denext;
    if (hadLocation) Object.defineProperty(globalThis, "location", hadLocation);
    else delete (globalThis as { location?: unknown }).location;
  }
  assertInstanceOf(getPtyBackend(), Object);
  assertEquals(getPtyBackend().kind, "demo");
});
