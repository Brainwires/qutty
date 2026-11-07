// The microphone's level while listening (lib/voice/level.ts): the library's RMS spread over the
// pulse's 0–1, the filter that keeps the 20 Hz stream from repeating itself, and the demo's fake
// voice sending a level only while it "listens" (lib/voice/client.ts `createDemoVoice`).

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  FULL,
  LEVEL_MS,
  LEVEL_STEP,
  levelGate,
  normalizeLevel,
  SILENCE,
} from "../lib/voice/level.ts";
import { createDemoVoice } from "../lib/voice/client.ts";

Deno.test("level: the RMS becomes 0–1, silence and nonsense 0", () => {
  assertEquals(LEVEL_MS, 50, "20 Hz");
  assertEquals(normalizeLevel(0), 0);
  assertEquals(normalizeLevel(SILENCE), 0);
  assertEquals(normalizeLevel(-0.3), 0);
  assertEquals(normalizeLevel(Number.NaN), 0);
  assertEquals(normalizeLevel(FULL), 1);
  assertEquals(normalizeLevel(0.9), 1);
  assertEquals(normalizeLevel(Number.POSITIVE_INFINITY), 1);
  assertAlmostEquals(normalizeLevel((SILENCE + FULL) / 2), 0.5, 1e-9);
  // Louder is never less.
  let last = 0;
  for (let rms = 0; rms <= 0.4; rms += 0.01) {
    const n = normalizeLevel(rms);
    assert(n >= last && n <= 1, `${rms} -> ${n}`);
    last = n;
  }
});

Deno.test("level: only changes worth showing are sent; silence once", () => {
  const send = levelGate();
  const sent = [0, 0, 0, 0.5, 0.52, 0.5 + LEVEL_STEP, 0.3, 0, 0, 0.01, 0]
    .filter((l) => send(l));
  assertEquals(sent, [0, 0.5, 0.5 + LEVEL_STEP, 0.3, 0]);
  // A wider step, from a quiet start.
  const coarse = levelGate(0.25);
  assertEquals([0.1, 0.2, 0.4, 0.3, 0].filter((l) => coarse(l)), [0.1, 0.4, 0]);
});

Deno.test("demo voice: a level while it listens, back to 0 when it stops", async () => {
  const voice = createDemoVoice();
  const levels: number[] = [];
  const off = voice.onLevel((l) => levels.push(l));
  await new Promise((r) => setTimeout(r, LEVEL_MS * 2));
  assertEquals(levels, [], "nothing before listening");
  await voice.sttStart("local");
  await new Promise((r) => setTimeout(r, LEVEL_MS * 5));
  await voice.sttStop();
  assert(levels.length >= 2, `${levels.length} levels`);
  assertEquals(levels.at(-1), 0, "settles at 0");
  assert(
    levels.slice(0, -1).every((l) => l > 0 && l <= 1),
    String(levels),
  );
  const count = levels.length;
  await new Promise((r) => setTimeout(r, LEVEL_MS * 3));
  assertEquals(levels.length, count, "nothing after it stopped");

  // A cancel stops it too, and an unsubscribed listener hears nothing.
  await voice.sttStart("local");
  await new Promise((r) => setTimeout(r, LEVEL_MS * 2));
  await voice.sttCancel();
  assertEquals(levels.at(-1), 0);
  off();
  const heard = levels.length;
  await voice.sttStart("local");
  await new Promise((r) => setTimeout(r, LEVEL_MS * 2));
  await voice.sttStop();
  assertEquals(levels.length, heard);
});
