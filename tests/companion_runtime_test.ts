// The companion runtime (lib/companion/runtime.ts) over a scripted brain: lazy start, turns one at
// a time (the user first, then agents' messages, formatted with their senders), streamed text,
// "(quiet)" turns, Settings' on/off, a brain that cannot start, and re-attach: a brain that dies
// mid-turn puts its messages back, and the next session gets them again.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CompanionRuntime } from "../lib/companion/runtime.ts";
import type { BrainAdapter, BrainSink } from "../lib/companion/brain.ts";
import type { CompanionUpdate } from "../lib/companion/protocol.ts";
import { Mailboxes } from "../lib/hub/mailbox.ts";
import { COMPANION } from "../lib/hub/protocol.ts";
import { waitUntil } from "./hub_helpers.ts";

/** A brain the test drives: it records turns; the test answers them. */
class ScriptedBrain implements BrainAdapter {
  readonly label = "scripted";
  sink: BrainSink | undefined;
  turns: string[] = [];
  stopped = false;
  constructor(readonly startError?: string) {}
  start(sink: BrainSink): Promise<void> {
    if (this.startError) return Promise.reject(new Error(this.startError));
    this.sink = sink;
    return Promise.resolve();
  }
  send(text: string): Promise<void> {
    this.turns.push(text);
    return Promise.resolve();
  }
  stop(): void {
    this.stopped = true;
  }
  /** Answer the current turn with `text`, streamed in two deltas. */
  reply(text: string, isError = false): void {
    const half = Math.ceil(text.length / 2);
    this.sink!.event({ kind: "text", delta: text.slice(0, half) });
    this.sink!.event({ kind: "text", delta: text.slice(half) });
    this.sink!.event({ kind: "turnEnd", text, isError });
  }
}

function setup(
  opts: { enabled?: boolean; startError?: string; now?: () => number } = {},
) {
  const mailbox = new Mailboxes((owner) => {
    if (owner === COMPANION && mailbox.unread(COMPANION) > 0) {
      runtime.mailArrived();
    }
  });
  const brains: ScriptedBrain[] = [];
  const updates: CompanionUpdate[] = [];
  const runtime = new CompanionRuntime({
    mailbox,
    adapter: "Scripted",
    enabled: opts.enabled ?? true,
    textThrottleMs: 0,
    retryAfterMs: 1000,
    ...(opts.now ? { now: opts.now } : {}),
    emit: (u) => updates.push(u),
    createBrain: () => {
      const b = new ScriptedBrain(opts.startError);
      brains.push(b);
      return b;
    },
  });
  const states = () =>
    updates.flatMap((u) => u.kind === "status" ? [u.status.state] : []);
  const doneTurns = () =>
    updates.filter((u): u is Extract<CompanionUpdate, { kind: "turn" }> =>
      u.kind === "turn" && u.done
    );
  const post = (text: string, from = "pty-2", fromName = "codex") =>
    mailbox.post({ from, fromName, to: COMPANION, text });
  return { runtime, mailbox, brains, updates, states, doneTurns, post };
}

Deno.test("runtime: starts on first use, streams the reply, ends the turn; one session for later turns", async () => {
  const t = setup();
  assertEquals(t.brains.length, 0, "nothing runs before it is used");
  assertEquals(t.runtime.status().state, "stopped");
  const turn = t.runtime.userSays("what's in tile 1?");
  await waitUntil(
    () => t.brains[0]?.turns.length === 1,
    1000,
    "the first turn",
  );
  assertEquals(t.brains[0].turns, ["what's in tile 1?"]);
  assertEquals(t.states(), ["starting", "ready", "thinking"]);
  t.brains[0].reply("Tile 1 is a shell.");
  await waitUntil(() => t.doneTurns().length === 1);
  const streamed = t.updates.filter((u) => u.kind === "turn" && !u.done);
  assert(streamed.length >= 1, "the reply streams before it is done");
  assertEquals(t.doneTurns()[0], {
    kind: "turn",
    turn,
    source: "user",
    text: "Tile 1 is a shell.",
    done: true,
  });
  assertEquals(t.runtime.status().state, "ready");
  t.runtime.userSays("and tile 2?");
  await waitUntil(() => t.brains[0].turns.length === 2);
  assertEquals(t.brains.length, 1, "the same session");
  t.runtime.stop();
});

Deno.test("runtime: turns go one at a time — typed lines first, then agents' messages (with their senders)", async () => {
  const t = setup();
  t.runtime.userSays("one");
  t.runtime.userSays("two");
  await waitUntil(() => t.brains[0]?.turns.length === 1);
  const msg = t.post("please review my diff");
  assertEquals(t.brains[0].turns.length, 1, "nothing is sent mid-turn");
  t.brains[0].reply("first");
  await waitUntil(() => t.brains[0].turns.length === 2);
  assertEquals(t.brains[0].turns[1], "two");
  t.brains[0].reply("second");
  await waitUntil(() => t.brains[0].turns.length === 3);
  assertStringIncludes(
    t.brains[0].turns[2],
    "[Qutty] A message from another tile:",
  );
  assertStringIncludes(
    t.brains[0].turns[2],
    `from codex (pty-2, ${msg.id}): please review my diff`,
  );
  assertEquals(t.mailbox.history(COMPANION)[0].state, "delivered");
  t.brains[0].reply("(quiet)");
  await waitUntil(() => t.doneTurns().length === 3);
  const last = t.doneTurns()[2];
  assertEquals([last.source, last.quiet], ["mail", true]);
  assert(
    !t.updates.some((u) => u.kind === "turn" && u.source === "mail" && !u.done),
    "an agents' turn is not streamed (it may be quiet)",
  );
  t.runtime.stop();
});

Deno.test("re-attach: the brain dies mid-turn → its messages go back; the next use starts a new session that gets them", async () => {
  let now = 0;
  const t = setup({ now: () => now });
  t.post("are the tests green?");
  await waitUntil(
    () => t.brains[0]?.turns.length === 1,
    1000,
    "the message turn",
  );
  assertEquals(t.mailbox.unread(COMPANION), 0);
  // The process exits before the turn ends.
  t.brains[0].sink!.exited("Claude Code ended (exit code 1)");
  assertEquals(t.runtime.status().state, "error");
  assertEquals(t.runtime.status().detail, "Claude Code ended (exit code 1)");
  assertEquals(t.mailbox.unread(COMPANION), 1, "put back in the mailbox");
  assertEquals(t.mailbox.pending(COMPANION)[0].text, "are the tests green?");
  // A new message right after a failure does not restart it at once…
  t.post("ping");
  assertEquals(t.brains.length, 1);
  // …the user does (or a message after the retry delay).
  now = 500;
  t.runtime.userSays("hello again");
  await waitUntil(
    () => t.brains[1]?.turns.length === 1,
    1000,
    "the new session",
  );
  assertEquals(t.brains[1].turns[0], "hello again");
  t.brains[1].reply("hi");
  await waitUntil(() => t.brains[1].turns.length === 2);
  assertStringIncludes(t.brains[1].turns[1], "2 messages");
  assertStringIncludes(t.brains[1].turns[1], "are the tests green?");
  assertStringIncludes(t.brains[1].turns[1], "ping");
  t.runtime.stop();
});

Deno.test("re-attach: a user turn cut off by the exit ends with the reason; queued lines restart it", async () => {
  const t = setup();
  t.runtime.userSays("long question");
  await waitUntil(() => t.brains[0]?.turns.length === 1);
  t.runtime.userSays("queued line");
  t.brains[0].sink!.exited("killed");
  await waitUntil(
    () => t.brains[1]?.turns.length === 1,
    1000,
    "restart for the queued line",
  );
  const cut = t.doneTurns()[0];
  assertEquals(cut.isError, true);
  assertStringIncludes(cut.text, "killed");
  assertEquals(t.brains[1].turns, ["queued line"]);
  t.runtime.stop();
});

Deno.test("runtime: off in Settings — nothing starts, the user is told; on again delivers what waited", async () => {
  const t = setup({ enabled: false });
  t.post("hello companion");
  t.runtime.userSays("hi");
  assertEquals(t.brains.length, 0);
  const told = t.doneTurns()[0];
  assertEquals(told.isError, true);
  assertStringIncludes(told.text, "Settings");
  t.runtime.setEnabled(true);
  await waitUntil(
    () => t.brains[0]?.turns.length === 1,
    1000,
    "the waiting message",
  );
  assertStringIncludes(t.brains[0].turns[0], "hello companion");
  // Off mid-turn: the session stops and the message goes back.
  t.runtime.setEnabled(false);
  assert(t.brains[0].stopped);
  assertEquals(t.mailbox.unread(COMPANION), 1);
  assertEquals(t.runtime.status(), {
    enabled: false,
    state: "stopped",
    adapter: "Scripted",
  });
});

Deno.test("runtime: a brain that cannot start → error status, the waiting line gets the reason, messages wait", async () => {
  const t = setup({ startError: "Claude Code is not installed" });
  t.post("hi");
  t.runtime.userSays("hello?");
  await waitUntil(() => t.runtime.status().state === "error");
  assertEquals(t.runtime.status().detail, "Claude Code is not installed");
  await waitUntil(() => t.doneTurns().length >= 1);
  assertStringIncludes(t.doneTurns().at(-1)!.text, "not installed");
  assertEquals(t.mailbox.unread(COMPANION), 1);
});

Deno.test("runtime: voice transcripts are marked; subscribers see every update", async () => {
  const t = setup();
  const seen: string[] = [];
  const off = t.runtime.subscribe((u) => seen.push(u.kind));
  t.runtime.userSays("what's going on", "voice");
  await waitUntil(() => t.brains[0]?.turns.length === 1);
  assertStringIncludes(t.brains[0].turns[0], "by voice");
  t.brains[0].reply("All quiet.");
  await waitUntil(() => t.doneTurns().length === 1);
  off();
  assert(seen.includes("status") && seen.includes("turn"));
  t.runtime.stop();
});
