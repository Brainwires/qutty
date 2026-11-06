// The demo backend's agent hub (lib/hub-demo.ts) on its own and through the demo backend's
// terminals (lib/pty-client.ts): tiles and names, coalesced snapshots, `ask_user` and its answer
// reaching the asking agent, `/msg` and unread counts, busy → idle, and the integration panel's
// Install / Uninstall over the in-memory home. Fake time drives every timer.
// Run: deno test -A tests/

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
// deno.json is not ours to edit (no "@std/testing" import), so the specifier is inline.
// deno-lint-ignore no-import-prefix
import { FakeTime } from "jsr:@std/testing@^1.0.0/time";
import { createDemoHub } from "../lib/hub-demo.ts";
import type { AskRequest, HubSnapshot } from "../lib/hub/protocol.ts";
import { createDemoBackend, type PtyBackend } from "../lib/pty-client.ts";

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (s: string) => s.replace(ANSI, "");

/** A demo hub with its events recorded. */
function recorded() {
  const snapshots: HubSnapshot[] = [];
  const asks: AskRequest[] = [];
  const closed: string[] = [];
  const hub = createDemoHub({
    tiles: (s) => snapshots.push(s),
    ask: (r) => asks.push(r),
    askClosed: (id) => closed.push(id),
    companion: () => {},
    say: () => {},
    control: () => {},
  });
  return { hub, snapshots, asks, closed };
}

/** Run a test body with fake time, restoring it afterwards. */
function withTime(fn: (time: FakeTime) => Promise<void>): () => Promise<void> {
  return async () => {
    const time = new FakeTime();
    try {
      await fn(time);
    } finally {
      time.restore();
    }
  };
}

Deno.test(
  "demo hub: tiles get the registry's names; snapshots are coalesced and come after the call",
  withTime(async (time) => {
    const { hub, snapshots } = recorded();
    assertEquals(hub.add("demo-1"), "shell-1");
    assertEquals(hub.add("demo-2", "claude"), "claude");
    assertEquals(hub.add("demo-3", "claude"), "claude-2");
    hub.setStatus("demo-2", "busy");
    assertEquals(snapshots, [], "not synchronous");
    await time.tickAsync(0);
    assertEquals(snapshots.length, 1, "one snapshot for the burst");
    const tiles = snapshots[0].tiles;
    assertEquals(snapshots[0].running, true);
    assertEquals(tiles.map((t) => [t.id, t.name, t.harness, t.status]), [
      ["demo-1", "shell-1", undefined, "idle"],
      ["demo-2", "claude", "claude", "busy"],
      ["demo-3", "claude-2", "claude", "idle"],
    ]);
    await hub.setLabel("demo-2", "claude — ~/src");
    hub.remove("demo-3");
    await time.tickAsync(0);
    assertEquals(
      snapshots[1].tiles.map((t) => [t.name, t.label]),
      [["shell-1", undefined], ["claude", "claude — ~/src"]],
    );
    assertEquals((await hub.snapshot()).tiles.length, 2);
    hub.dispose();
  }),
);

Deno.test(
  "demo hub: ask_user waits, is in the snapshot, and the answer reaches the caller once",
  withTime(async (time) => {
    const { hub, asks, closed } = recorded();
    hub.add("demo-1", "codex");
    const replies: (string | null)[] = [];
    const id = hub.ask("demo-1", "Ship it?", ["Yes", "No"], (a) => {
      replies.push(a);
    });
    assertEquals(asks, [{
      id,
      from: "demo-1",
      fromName: "codex",
      text: "Ship it?",
      actions: ["Yes", "No"],
    }]);
    const snap = await hub.snapshot();
    assertEquals(snap.asks.map((a) => a.id), [id]);
    assertEquals(snap.tiles[0].status, "waiting");
    assertEquals(await hub.answer(id, "No"), true);
    assertEquals(await hub.answer(id, "Yes"), false, "already answered");
    assertEquals(replies, ["No"]);
    assertEquals(closed, [id]);
    assertEquals((await hub.snapshot()).asks, []);
    assertEquals((await hub.snapshot()).tiles[0].status, "idle");
    // A dismissal is a null answer; a tile that goes away closes its questions unanswered.
    const second = hub.ask("demo-1", "Again?", ["OK"], (a) => replies.push(a));
    await hub.answer(second, null);
    assertEquals(replies, ["No", null]);
    const third = hub.ask("demo-1", "Still there?", ["OK"], (a) => {
      replies.push(a);
    });
    hub.remove("demo-1");
    assertEquals(closed, [id, second, third]);
    assertEquals(replies, ["No", null]);
    await time.tickAsync(0);
    hub.dispose();
  }),
);

Deno.test("demo hub: messages count as unread until taken", async () => {
  const { hub } = recorded();
  hub.add("demo-1", "claude");
  hub.add("demo-2", "codex");
  assertEquals(hub.send("demo-1", "codex", "hi"), "codex");
  assertEquals(hub.send("demo-1", "CODEX", "again"), "codex");
  assertEquals(hub.send("demo-1", "claude", "me"), undefined, "not to itself");
  assertEquals(hub.send("demo-1", "nobody", "x"), undefined);
  const unread = async () =>
    (await hub.snapshot()).tiles.map((t) => [t.name, t.unread]);
  assertEquals(await unread(), [["claude", 0], ["codex", 2]]);
  assertEquals(hub.take("demo-2"), [
    { fromName: "claude", text: "hi" },
    { fromName: "claude", text: "again" },
  ]);
  assertEquals(hub.take("demo-2"), []);
  assertEquals(await unread(), [["claude", 0], ["codex", 0]]);
  hub.dispose();
});

Deno.test("demo hub: integration Install / Uninstall toggle and restore the files", async () => {
  const { hub } = recorded();
  const before = await hub.integrationStatus();
  assertEquals(before.map((s) => [s.target, s.installed]), [
    ["claude", false],
    ["codex", false],
    ["hermes", false],
    ["zsh", false],
    ["bash", false],
  ]);
  assertEquals(before[0].changes.map((c) => c.path), [
    "~/.claude.json",
    "~/.claude/settings.json",
  ]);
  assertEquals(before[1].changes.map((c) => c.path), ["~/.codex/config.toml"]);
  assertStringIncludes(before[0].changes[0].adds, "/Users/demo/.qutty/bin");
  assertStringIncludes(before[1].changes[0].adds, "[mcp_servers.qutty]");
  const installed = await hub.integrationInstall("claude");
  assertEquals(installed.map((s) => s.installed), [
    true,
    false,
    false,
    false,
    false,
  ]);
  assertEquals(
    (await hub.integrationInstall("codex")).map((s) => s.installed),
    [true, true, false, false, false],
  );
  const after = await hub.integrationUninstall("claude");
  assertEquals(after.map((s) => s.installed), [
    false,
    true,
    false,
    false,
    false,
  ]);
  // The shell agent's opt-in: one line in ~/.zshrc, removed again.
  const zsh = await hub.integrationInstall("zsh");
  assertEquals(zsh.map((s) => s.installed), [false, true, false, true, false]);
  assertStringIncludes(
    zsh[3].changes[0].adds,
    "/Users/demo/.qutty/shell/qutty.zsh",
  );
  assertEquals(
    (await hub.integrationUninstall("zsh")).map((s) => s.installed),
    [false, true, false, false, false],
  );
  assertEquals(after[0].note, undefined, "nothing left behind");
});

// ---------------------------------------------------------------------------------------------
// Through the demo backend's agent terminals
// ---------------------------------------------------------------------------------------------

/** Spawn the demo `program` and collect its output. */
async function agent(be: PtyBackend, time: FakeTime, program: string) {
  const sp = await be.spawn({ cols: 100, rows: 30, program, args: [] });
  let out = "";
  be.onData(sp.id, (d) => out += d);
  await time.tickAsync(0);
  return {
    id: sp.id,
    type: async (s: string) => {
      await be.write(sp.id, s);
      await time.tickAsync(0);
    },
    take: () => {
      const s = plain(out);
      out = "";
      return s;
    },
  };
}

Deno.test(
  "demo backend: agents register with their harness, go busy then idle, /ask and /msg",
  withTime(async (time) => {
    const be = createDemoBackend();
    const snapshots: HubSnapshot[] = [];
    const asks: AskRequest[] = [];
    const closed: string[] = [];
    be.onHubTiles((s) => snapshots.push(s));
    be.onHubAsk((r) => asks.push(r));
    be.onHubAskClosed((id) => closed.push(id));
    const claude = await agent(be, time, "claude");
    const codex = await agent(be, time, "/opt/homebrew/bin/codex");
    const shell = await be.spawn({ cols: 80, rows: 24 });
    await time.tickAsync(0);
    const last = () => snapshots[snapshots.length - 1].tiles;
    const of = (id: string) => last().find((t) => t.id === id)!;
    assertEquals(last().map((t) => [t.name, t.harness]), [
      ["claude", "claude"],
      ["codex", "codex"],
      ["shell-3", undefined],
    ]);
    assertStringIncludes(claude.take(), "/help for commands");

    // A line: busy, then idle again.
    await claude.type("refactor it\r");
    assertStringIncludes(claude.take(), "(demo) claude heard: refactor it");
    assertEquals(of(claude.id).status, "busy");
    await time.tickAsync(1500);
    assertEquals(of(claude.id).status, "idle");

    // /ask: the question goes to the page; the answer is printed in the asking agent.
    await claude.type("/ask Deploy now?\r");
    assertEquals(asks.map((a) => [a.fromName, a.text, a.actions]), [
      ["claude", "Deploy now?", ["Yes", "No"]],
    ]);
    assertEquals(of(claude.id).status, "waiting");
    assertEquals((await be.hubSnapshot()).asks.length, 1);
    claude.take();
    assertEquals(await be.hubAnswer(asks[0].id, "Yes"), true);
    await time.tickAsync(0);
    assertStringIncludes(claude.take(), "(demo) the user answered: Yes");
    assertEquals(closed, [asks[0].id]);
    assertEquals(of(claude.id).status, "idle");

    // /msg: the recipient's unread count, cleared (and the message shown) on its next turn.
    await claude.type("/msg codex please review\r");
    assertStringIncludes(claude.take(), "queued for codex");
    assertEquals(of(codex.id).unread, 1);
    await claude.type("/msg nobody hi\r");
    assertStringIncludes(claude.take(), "no other tile is named nobody");
    await claude.type("/msg codex\r");
    assertStringIncludes(claude.take(), "usage: /msg <name> <text>");
    codex.take();
    await codex.type("ok\r");
    const read = codex.take();
    assertStringIncludes(read, "✉ claude: please review");
    assert(read.indexOf("✉") < read.indexOf("codex heard: ok"), read);
    assertEquals(of(codex.id).unread, 0);
    await codex.type("/help\r");
    assertStringIncludes(codex.take(), "/ask [question]");

    // An agent that exits leaves the hub, and its open question closes.
    await codex.type("/ask\r");
    assertEquals(asks[1].text, "Apply the demo change to notes.md?");
    await codex.type("/exit\r");
    await time.tickAsync(0);
    assertEquals(closed, [asks[0].id, asks[1].id]);
    assertEquals(last().map((t) => t.name), ["claude", "shell-3"]);
    await be.kill(claude.id);
    await be.kill(shell.id);
    await time.tickAsync(0);
    assertEquals(last(), []);
  }),
);
