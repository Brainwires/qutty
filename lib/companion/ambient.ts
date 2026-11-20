/**
 * The companion's own lines, the rules behind app/companion/use-companion-ambient.ts:
 *
 * - **Quote of the day** (Settings → Companion, on by default): one quote per local calendar day,
 *   the same everywhere ({@linkcode quoteForDay} hashes the date), shown at startup and, if the
 *   app stayed open past midnight, at the first human interaction of the new day. Once a day
 *   across every window: the window that shows it records the day in shared storage
 *   ({@linkcode claimDay}), and a day already recorded (or a later one) is never shown again.
 * - **Encouragement** (off by default): now and then a short comforting or inspiring line, after a
 *   random stretch of active use ({@linkcode encourageDelayMs}), only while nothing else wants the
 *   companion ({@linkcode mayEncourage}), drawn from a shuffled bag so no line repeats before every
 *   line has been said ({@linkcode drawFromBag}).
 * - **Activity**: the workspace windows note the user's last interaction in shared storage
 *   ({@linkcode ACTIVITY_KEY}), so the floating companion, which rarely gets events of its own,
 *   knows when the user types and when a new day's first interaction happens.
 *
 * Client-safe and pure (storage and randomness are passed in).
 *
 * @module
 */

import type { EncourageFrequency } from "./settings.ts";
import { type CompanionMessage, readingTimeMs } from "./messages.ts";
import type { Quote } from "./quotes.ts";

/** The part of `Storage` used here (a fake in the tests). */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** Shared storage: the day the quote of the day was last shown, and by which window. */
export const QUOTE_DAY_KEY = "qutty.companion.quoteDay";
/** Shared storage: the encouragement bag (the lines not said yet this round). */
const ENCOURAGE_BAG_KEY = "qutty.companion.encourageBag";
/** Shared storage: the user's last interaction in any workspace window. */
export const ACTIVITY_KEY = "qutty.companion.activity";

// --- days ------------------------------------------------------------------------------------

/** The local calendar day of `ms` as `YYYY-MM-DD` (sorts like the dates it names). */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The next local midnight after `ms`. */
export function nextMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// --- quote of the day ------------------------------------------------------------------------

/** FNV-1a over `text`: a small, stable hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Day `day`'s quote, and with `offset` the ones after it ("Another"): the same for every window
 * and every run.
 */
export function quoteForDay(
  day: string,
  quotes: readonly Quote[],
  offset = 0,
): Quote {
  return quotes[(hash(day) + offset) % quotes.length];
}

/** What {@linkcode QUOTE_DAY_KEY} holds. */
interface DayClaim {
  readonly day: string;
  readonly by: string;
}

/** The recorded claim, or `null` (none, or unreadable). */
function readClaim(store: KeyValueStore): DayClaim | null {
  try {
    const raw = JSON.parse(store.getItem(QUOTE_DAY_KEY) ?? "null");
    return raw && typeof raw.day === "string" && typeof raw.by === "string"
      ? { day: raw.day, by: raw.by }
      : null;
  } catch {
    return null;
  }
}

/**
 * Claim day `today`'s quote for window `by`: `true` (and recorded) unless that day, or a later
 * one, was claimed already. Storage failing reads as "already shown" (nothing repeats).
 */
export function claimDay(
  store: KeyValueStore,
  today: string,
  by: string,
): boolean {
  try {
    const claim = readClaim(store);
    if (claim && claim.day >= today) return false;
    store.setItem(QUOTE_DAY_KEY, JSON.stringify({ day: today, by }));
    return true;
  } catch {
    return false;
  }
}

/** Whether window `by` still holds day `today`'s claim (two windows claiming at once: one wins). */
export function holdsClaim(
  store: KeyValueStore,
  today: string,
  by: string,
): boolean {
  const claim = readClaim(store);
  return claim?.day === today && claim.by === by;
}

/** The longest a quote stays up by itself, ms. */
const QUOTE_MS = 30_000;

/** The bubble's id for day `day`'s quote number `n` (0 first, then each "Another"). */
export const quoteBubbleId = (day: string, n: number) => `quote:${day}:${n}`;
/** The quote bubble's "Another" button. */
export const ANOTHER_ACTION = "another";

/** A quote as a bubble: the line, who said it, an "Another" button. */
export function quoteBubble(quote: Quote, id: string): CompanionMessage {
  return {
    id,
    kind: "say",
    text: quote.text,
    cite: quote.author,
    mood: "neutral",
    actions: [{ id: ANOTHER_ACTION, label: "Another" }],
    timeoutMs: Math.min(QUOTE_MS, readingTimeMs(quote.text) * 2),
  };
}

// --- encouragement ---------------------------------------------------------------------------

const MINUTE = 60_000;

/** The stretch of active use between two lines, per frequency, ms. */
export const ENCOURAGE_WINDOWS: Readonly<
  Record<EncourageFrequency, readonly [number, number]>
> = {
  rarely: [120 * MINUTE, 240 * MINUTE],
  sometimes: [45 * MINUTE, 90 * MINUTE],
  often: [20 * MINUTE, 40 * MINUTE],
};

/** A random stretch of active use before the next line (`random` in [0, 1)). */
export function encourageDelayMs(
  frequency: EncourageFrequency,
  random: () => number = Math.random,
): number {
  const [min, max] = ENCOURAGE_WINDOWS[frequency];
  return Math.round(min + (max - min) * random());
}

/** No line while the user typed this recently, ms. */
export const TYPING_QUIET_MS = 5_000;
/** Time counts as active use while the last interaction is at most this old, ms. */
const ACTIVE_WITHIN_MS = 5 * MINUTE;

/**
 * The active use between two checks at `prev` and `now`: all of it while the user's last
 * interaction is recent, none after a long absence. At most `maxStep` (a suspended machine does not
 * count its sleep).
 */
export function activeSpan(
  prev: number,
  now: number,
  lastActivity: number,
  maxStep: number,
): number {
  if (now - lastActivity > ACTIVE_WITHIN_MS) return 0;
  return Math.max(0, Math.min(maxStep, now - prev));
}

/** What decides whether a line may be said now. */
export interface EncourageGate {
  /** Settings → Companion → Encouragement. */
  readonly enabled: boolean;
  /** Any bubble on screen or waiting (a question, a message, an agent's note, a reply). */
  readonly bubble: boolean;
  /** The chat or review box is open, a voice turn runs, or the companion thinks. */
  readonly busy: boolean;
  /** The companion sleeps (night) or the page is hidden. */
  readonly away: boolean;
  /** The last keystroke, ms (0: none). */
  readonly typedAt: number;
  readonly now: number;
}

/** Whether a line may be said now. */
export function mayEncourage(g: EncourageGate): boolean {
  return g.enabled && !g.bubble && !g.busy && !g.away &&
    g.now - g.typedAt >= TYPING_QUIET_MS;
}

/** What {@linkcode ENCOURAGE_BAG_KEY} holds: the pool's size and the indexes not said yet. */
interface Bag {
  readonly size: number;
  readonly left: readonly number[];
}

/** The stored bag when it is for a pool of `size` and well formed, else `null`. */
function readBag(store: KeyValueStore, size: number): Bag | null {
  try {
    const raw = JSON.parse(store.getItem(ENCOURAGE_BAG_KEY) ?? "null");
    if (!raw || raw.size !== size || !Array.isArray(raw.left)) return null;
    const left = (raw.left as unknown[]).filter((i): i is number =>
      Number.isInteger(i) && (i as number) >= 0 && (i as number) < size
    );
    return { size, left };
  } catch {
    return null;
  }
}

/**
 * The next line's index in a pool of `size`: a random one of those not said yet this round; when
 * all have been, a new round starts (never with the line just said, when there are two or more).
 * The bag is kept in `store`, so it lasts across restarts and windows.
 */
export function drawFromBag(
  store: KeyValueStore,
  size: number,
  random: () => number = Math.random,
  last?: number,
): number {
  let left = readBag(store, size)?.left ?? [];
  const fresh = left.length === 0;
  if (fresh) left = Array.from({ length: size }, (_, i) => i);
  let at = Math.min(left.length - 1, Math.floor(random() * left.length));
  // A new round never opens with the line that closed the last one.
  if (fresh && size > 1 && left[at] === last) at = (at + 1) % left.length;
  const pick = left[at];
  const rest = left.filter((_, i) => i !== at);
  try {
    store.setItem(ENCOURAGE_BAG_KEY, JSON.stringify({ size, left: rest }));
  } catch {
    // Storage full or off: the line is still said.
  }
  return pick;
}

/** An encouraging line as a bubble (calm with reduced motion, warm otherwise). */
export function encourageBubble(
  text: string,
  id: string,
  reducedMotion: boolean,
): CompanionMessage {
  return {
    id,
    kind: "say",
    text,
    mood: reducedMotion ? "neutral" : "love",
    actions: [],
    timeoutMs: readingTimeMs(text),
  };
}

// --- activity --------------------------------------------------------------------------------

/** The user's last interaction anywhere, and last keystroke, ms. */
export interface Activity {
  readonly at: number;
  readonly typedAt: number;
}

/** How often a window writes its activity at most, ms. */
export const ACTIVITY_WRITE_MS = 2_000;

/** The shared activity, or none. */
export function readActivity(store: KeyValueStore): Activity {
  try {
    const raw = JSON.parse(store.getItem(ACTIVITY_KEY) ?? "null");
    return {
      at: typeof raw?.at === "number" ? raw.at : 0,
      typedAt: typeof raw?.typedAt === "number" ? raw.typedAt : 0,
    };
  } catch {
    return { at: 0, typedAt: 0 };
  }
}

/**
 * Whether a window that last wrote its activity at `wroteAt` writes it again at `now`: every
 * {@linkcode ACTIVITY_WRITE_MS}, and always for the first interaction of a new day (the floating
 * companion's quote of the day waits for it).
 */
export function shouldWriteActivity(wroteAt: number, now: number): boolean {
  return now - wroteAt >= ACTIVITY_WRITE_MS ||
    dayKey(now) !== dayKey(wroteAt);
}
