// The companion's own lines (lib/companion/ambient.ts): days and midnight, the quote of the day
// (deterministic per date, once a day across windows, a startup race won by one window), the
// encouragement's schedule and gate, its no-repeat bag, the shared activity, the settings, and
// the data pools themselves.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  activeSpan,
  ACTIVITY_KEY,
  ACTIVITY_WRITE_MS,
  claimDay,
  dayKey,
  drawFromBag,
  ENCOURAGE_WINDOWS,
  encourageBubble,
  encourageDelayMs,
  holdsClaim,
  type KeyValueStore,
  mayEncourage,
  nextMidnight,
  QUOTE_DAY_KEY,
  quoteBubble,
  quoteBubbleId,
  quoteForDay,
  readActivity,
  shouldWriteActivity,
  TYPING_QUIET_MS,
} from "../lib/companion/ambient.ts";
import { QUOTES } from "../lib/companion/quotes.ts";
import { ENCOURAGEMENTS } from "../lib/companion/encouragements.ts";
import {
  DEFAULT_COMPANION,
  sanitizeCompanion,
} from "../lib/companion/settings.ts";

/** A shared storage (every "window" in a test uses the same one). */
function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

/** A seeded random in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

Deno.test("ambient: local day keys sort like dates; midnight is the next day's start", () => {
  assertEquals(dayKey(at(2026, 3, 7, 0, 0)), "2026-03-07");
  assertEquals(dayKey(at(2026, 12, 31, 23, 59)), "2026-12-31");
  assert(dayKey(at(2026, 9, 30)) < dayKey(at(2026, 10, 1)));
  const late = at(2026, 12, 31, 23, 59);
  const mid = nextMidnight(late);
  assertEquals(dayKey(mid), "2027-01-01");
  assertEquals(new Date(mid).getHours(), 0);
  assertEquals(dayKey(mid - 1), "2026-12-31");
  // Exactly at midnight: the next one is a day later.
  assertEquals(dayKey(nextMidnight(mid)), "2027-01-02");
});

Deno.test("ambient: the quote of the day is the same for a date everywhere; Another moves on", () => {
  const a = quoteForDay("2026-11-19", QUOTES);
  assertEquals(quoteForDay("2026-11-19", QUOTES), a);
  // Different days spread over the pool.
  const days = Array.from({ length: 60 }, (_, i) => dayKey(at(2026, 1, 1 + i)));
  const picks = new Set(days.map((d) => quoteForDay(d, QUOTES).text));
  assert(picks.size > 40, `only ${picks.size} distinct quotes in 60 days`);
  const next = quoteForDay("2026-11-19", QUOTES, 1);
  assertNotEquals(next, a);
  const i = QUOTES.indexOf(a);
  assertEquals(next, QUOTES[(i + 1) % QUOTES.length]);
  const bubble = quoteBubble(a, quoteBubbleId("2026-11-19", 0));
  assertEquals(bubble.id, "quote:2026-11-19:0");
  assertEquals(bubble.cite, a.author);
  assertEquals(bubble.actions.map((x) => x.label), ["Another"]);
  assert(bubble.timeoutMs > 0 && bubble.timeoutMs <= 30_000);
});

Deno.test("ambient: the quote shows once a day across windows, again the next day", () => {
  const shared = memoryStore();
  assert(claimDay(shared, "2026-11-19", "w1"), "the first window shows it");
  assertEquals(claimDay(shared, "2026-11-19", "w2"), false);
  assertEquals(claimDay(shared, "2026-11-19", "w1"), false, "not twice");
  // The next day (the app stayed open past midnight): the first window to see it.
  assert(claimDay(shared, "2026-11-20", "w2"));
  assertEquals(claimDay(shared, "2026-11-20", "w1"), false);
  // A clock that went back does not bring an older day back.
  assertEquals(claimDay(shared, "2026-11-18", "w1"), false);
  // Garbage in storage is treated as nothing shown.
  shared.setItem(QUOTE_DAY_KEY, "{not json");
  assert(claimDay(shared, "2026-11-21", "w1"));
  // Storage that throws: nothing shows (no repeats).
  const broken: KeyValueStore = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assertEquals(claimDay(broken, "2026-11-21", "w1"), false);
});

Deno.test("ambient: two windows claiming the same startup: the last writer holds it", () => {
  const shared = memoryStore();
  // Both read "nothing shown" before either wrote (the race the settle check is for).
  shared.setItem(QUOTE_DAY_KEY, JSON.stringify({ day: "2026-11-18", by: "x" }));
  const a = claimDay(shared, "2026-11-19", "a");
  shared.setItem(QUOTE_DAY_KEY, JSON.stringify({ day: "2026-11-18", by: "x" }));
  const b = claimDay(shared, "2026-11-19", "b");
  assert(a && b);
  assertEquals(holdsClaim(shared, "2026-11-19", "a"), false);
  assert(holdsClaim(shared, "2026-11-19", "b"));
});

Deno.test("ambient: encouragement waits a random stretch per frequency", () => {
  for (const f of ["rarely", "sometimes", "often"] as const) {
    const [min, max] = ENCOURAGE_WINDOWS[f];
    assertEquals(encourageDelayMs(f, () => 0), min);
    assert(max - encourageDelayMs(f, () => 0.999999) < 100);
    const r = seeded(7);
    for (let i = 0; i < 50; i++) {
      const d = encourageDelayMs(f, r);
      assert(d >= min && d <= max);
    }
  }
  assertEquals(ENCOURAGE_WINDOWS.sometimes, [45 * 60_000, 90 * 60_000]);
});

Deno.test("ambient: only active use counts toward the stretch", () => {
  const t = 10_000_000;
  assertEquals(activeSpan(t, t + 30_000, t + 20_000, 60_000), 30_000);
  // Away for ten minutes: none.
  assertEquals(activeSpan(t, t + 30_000, t - 10 * 60_000, 60_000), 0);
  // A machine waking from sleep counts one step at most.
  assertEquals(activeSpan(t, t + 3_600_000, t + 3_600_000, 60_000), 60_000);
  assertEquals(activeSpan(t, t - 5, t, 60_000), 0);
});

Deno.test("ambient: never over a bubble, while busy, asleep, hidden or typing", () => {
  const now = 1_000_000;
  const free = {
    enabled: true,
    bubble: false,
    busy: false,
    away: false,
    typedAt: now - TYPING_QUIET_MS,
    now,
  };
  assert(mayEncourage(free));
  assertEquals(mayEncourage({ ...free, enabled: false }), false);
  assertEquals(mayEncourage({ ...free, bubble: true }), false, "a question");
  assertEquals(mayEncourage({ ...free, busy: true }), false, "chat / voice");
  assertEquals(mayEncourage({ ...free, away: true }), false, "asleep");
  assertEquals(
    mayEncourage({ ...free, typedAt: now - 1000 }),
    false,
    "typing a second ago",
  );
});

Deno.test("ambient: lines never repeat until every one has been said", () => {
  const shared = memoryStore();
  const r = seeded(42);
  const size = 12;
  let last: number | undefined;
  for (let round = 0; round < 3; round++) {
    const seen = new Set<number>();
    for (let i = 0; i < size; i++) {
      const pick = drawFromBag(shared, size, r, last);
      if (i === 0 && last !== undefined) {
        assertNotEquals(
          pick,
          last,
          "a new round never starts with the last one",
        );
      }
      assert(!seen.has(pick), `round ${round}: ${pick} again`);
      seen.add(pick);
      last = pick;
    }
    if (round === 0) assertEquals(seen.size, size);
  }
  // A bag for another pool size (the lines changed) starts over.
  const pick = drawFromBag(shared, 3, r);
  assert(pick >= 0 && pick < 3);
  // A one-line pool still works.
  assertEquals(drawFromBag(memoryStore(), 1, r, 0), 0);
});

Deno.test("ambient: an encouraging line is calm with reduced motion", () => {
  const b = encourageBubble("Keep going.", "cheer:1", false);
  assertEquals(b.mood, "love");
  assertEquals(b.actions, []);
  assert(b.timeoutMs >= 4000);
  assertEquals(encourageBubble("Keep going.", "cheer:1", true).mood, "neutral");
});

Deno.test("ambient: activity is written every few seconds, and at once on a new day", () => {
  const t = at(2026, 11, 19, 15);
  assert(shouldWriteActivity(0, t));
  assertEquals(shouldWriteActivity(t, t + 500), false);
  assert(shouldWriteActivity(t, t + ACTIVITY_WRITE_MS));
  const beforeMidnight = at(2026, 11, 19, 23, 59) + 59_500;
  assert(shouldWriteActivity(beforeMidnight, beforeMidnight + 1000));
  const shared = memoryStore();
  assertEquals(readActivity(shared), { at: 0, typedAt: 0 });
  shared.setItem(ACTIVITY_KEY, JSON.stringify({ at: 5, typedAt: 4 }));
  assertEquals(readActivity(shared), { at: 5, typedAt: 4 });
  shared.setItem(ACTIVITY_KEY, "nope");
  assertEquals(readActivity(shared), { at: 0, typedAt: 0 });
});

Deno.test("ambient: settings: quote of the day on, encouragement off, by default; sanitised", () => {
  assertEquals(DEFAULT_COMPANION.quoteOfDay, true);
  assertEquals(DEFAULT_COMPANION.encourage, false);
  assertEquals(DEFAULT_COMPANION.encourageEvery, "sometimes");
  const s = sanitizeCompanion({
    quoteOfDay: false,
    encourage: true,
    encourageEvery: "often",
  });
  assertEquals([s.quoteOfDay, s.encourage, s.encourageEvery], [
    false,
    true,
    "often",
  ]);
  const bad = sanitizeCompanion({
    quoteOfDay: "yes",
    encourage: 1,
    encourageEvery: "hourly",
  });
  assertEquals([bad.quoteOfDay, bad.encourage, bad.encourageEvery], [
    true,
    false,
    "sometimes",
  ]);
});

Deno.test("ambient: the pools: 200+ attributed quotes, 80+ lines, no duplicates", () => {
  assert(QUOTES.length >= 200, `${QUOTES.length} quotes`);
  assertEquals(new Set(QUOTES.map((q) => q.text)).size, QUOTES.length);
  for (const q of QUOTES) {
    assert(q.text.trim() && q.author.trim(), JSON.stringify(q));
    assert(q.text.length <= 200, `too long: ${q.text}`);
  }
  assert(ENCOURAGEMENTS.length >= 80, `${ENCOURAGEMENTS.length} lines`);
  assertEquals(new Set(ENCOURAGEMENTS).size, ENCOURAGEMENTS.length);
  for (const line of ENCOURAGEMENTS) assert(line.length <= 100, line);
});
