// Broadcast input (cluster ssh): the selection, the routing rules (only selected tiles, only the
// user's own keys and pastes: never terminal replies, focus or mouse reports), and the paste
// helpers. Pure. Run: deno test -A tests/

import { assert, assertEquals } from "@std/assert";
import {
  activeMembers,
  BROADCAST_OFF,
  broadcastLabel,
  broadcastTargets,
  isTerminalReport,
  pasteFor,
  pasteNeedsConfirm,
  pasteSummary,
  pruneMembers,
  setMember,
  toggleBroadcast,
  unbracketPaste,
} from "../lib/broadcast.ts";

const alive = () => true;
const ON = { on: true, members: ["a", "b", "c"] };
const members = activeMembers(ON);

Deno.test("broadcast: the selection", () => {
  const on = toggleBroadcast(BROADCAST_OFF);
  assertEquals(on, { on: true, members: [] }, "on, nothing checked yet");
  assertEquals(
    setMember(BROADCAST_OFF, "a", true),
    BROADCAST_OFF,
    "off: no-op",
  );
  const two = setMember(setMember(on, "a", true), "b", true);
  assertEquals(two.members, ["a", "b"]);
  assertEquals(setMember(two, "a", true), two, "already checked");
  assertEquals(setMember(two, "a", false).members, ["b"]);
  assertEquals(pruneMembers(two, ["b", "z"]).members, ["b"]);
  assertEquals(pruneMembers(two, ["a", "b"]), two);
  assertEquals(toggleBroadcast(two), BROADCAST_OFF, "off drops the selection");
  // Fewer than two members broadcast nothing.
  assertEquals(activeMembers(on), null);
  assertEquals(activeMembers(setMember(on, "a", true)), null);
  assertEquals([...activeMembers(two)!], ["a", "b"]);
  assertEquals(activeMembers({ on: false, members: ["a", "b"] }), null);
  assertEquals(broadcastLabel(on), "Broadcast: check the tiles to type into");
  assertEquals(broadcastLabel(two), "Broadcasting to 2 tiles");
});

Deno.test("broadcast: typing in a member reaches every other live member", () => {
  assertEquals(broadcastTargets("a", "l", "key", members, alive), ["b", "c"]);
  assertEquals(broadcastTargets("b", "\r", "key", members, alive), ["a", "c"]);
  // Escape, arrows, Ctrl-C and function keys are typing too.
  for (const key of ["\x1b", "\x1b[A", "\x1bOA", "\x03", "\x1b[15~", "\x1b]"]) {
    assertEquals(broadcastTargets("a", key, "key", members, alive), ["b", "c"]);
  }
  assertEquals(
    broadcastTargets("a", "x", "key", members, (id) => id !== "c"),
    ["b"],
    "an exited member is skipped",
  );
  assertEquals(broadcastTargets("a", "x", "paste", members, alive), ["b", "c"]);
});

Deno.test("broadcast: never to tiles that are not selected, never from one", () => {
  assertEquals(broadcastTargets("z", "x", "key", members, alive), []);
  assertEquals(broadcastTargets("a", "x", "key", null, alive), []);
  assertEquals(broadcastTargets("a", "", "key", members, alive), []);
});

Deno.test("broadcast: terminal replies and mouse reports stay in their tile", () => {
  // No mark: xterm wrote it on its own (a reply to a query), whatever it looks like.
  for (const data of ["\x1b[12;40R", "x", "\x1b[?1;2c", "\x1b[I"]) {
    assertEquals(broadcastTargets("a", data, null, members, alive), [], data);
  }
  // Marked or not, a chunk that is a report is never repeated.
  const reports = [
    "\x1b[<0;10;5M", // SGR mouse press
    "\x1b[<0;10;5m", // SGR mouse release
    "\x1b[<64;3;3M", // wheel
    "\x1b[32;10;5M", // urxvt mouse
    "\x1b[M #!", // X10 mouse
    "\x1b[I", // focus in
    "\x1b[O", // focus out
    "\x1b[?1;2c", // DA1 reply
    "\x1b[>0;276;0c", // DA2 reply
    "\x1b[0n", // DSR ok
    "\x1b[?12;40R", // DECXCPR
    "\x1b[?2004;1$y", // DECRQM reply
    "\x1b[4;600;800t", // window size report
    "\x1b]11;rgb:0d0d/1111/1717\x07", // OSC 11 colour reply
    "\x1b]10;rgb:d9d9/e0e0/e8e8\x1b\\",
    "\x1bP1$r0m\x1b\\", // DECRQSS reply
  ];
  for (const data of reports) {
    assert(isTerminalReport(data), JSON.stringify(data));
    assertEquals(broadcastTargets("a", data, "key", members, alive), []);
  }
  // Keys that start the same way are not reports.
  for (
    const data of ["\x1b[A", "\x1b[1;2R", "\x1b]", "\x1bP", "\x1b[15~", "a"]
  ) {
    assertEquals(isTerminalReport(data), false, JSON.stringify(data));
  }
});

Deno.test("broadcast: pastes are rewrapped per tile and big ones confirmed", () => {
  const br = "\x1b[200~ls -la\x1b[201~";
  assertEquals(unbracketPaste(br), "ls -la");
  assertEquals(unbracketPaste("ls"), "ls");
  assertEquals(pasteFor(br, false), "ls -la");
  assertEquals(pasteFor("ls -la", true), br);
  assertEquals(pasteFor(br, true), br);
  assertEquals(pasteNeedsConfirm("ls -la"), false);
  assertEquals(pasteNeedsConfirm(br), false);
  assertEquals(pasteNeedsConfirm("a\rb"), true);
  assertEquals(pasteNeedsConfirm("\x1b[200~a\nb\x1b[201~"), true);
  assertEquals(pasteNeedsConfirm("x".repeat(256)), false);
  assertEquals(pasteNeedsConfirm("x".repeat(257)), true);
  assertEquals(pasteSummary("a\rb\rc"), "3 lines, 5 characters");
  assertEquals(pasteSummary("a\rb\r"), "2 lines, 4 characters");
  assertEquals(pasteSummary("x".repeat(1480)), "1 line, 1,480 characters");
});
