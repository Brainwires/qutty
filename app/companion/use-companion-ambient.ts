// The companion's own lines (Settings → Companion → Quote of the day, Encouragement), the DOM side
// of lib/companion/ambient.ts, which holds the rules. Kept cheap:
//
// - Quote of the day: once at startup (a moment after the companion lands), and at the first
//   human interaction of a new day: passive `focus` / `keydown` / `pointerdown` listeners that
//   compare the clock with the next midnight (one number) and do nothing else, never delaying or
//   taking the event. The floating companion, which rarely gets events of its own, also follows
//   the workspace windows' activity (`storage` events on ACTIVITY_KEY, written by
//   `useActivityBeacon`). The window that shows it records the day in shared storage, so a second
//   window, or a restart, does not say it again.
// - Encouragement: a check every ENCOURAGE_TICK_MS counts active use (the user interacted in the
//   last few minutes) and, once the random stretch is reached, says a line when nothing else wants
//   the companion (no bubble, chat, voice turn or thinking; not asleep; no keystroke in the last
//   seconds). In test mode, ENCOURAGE_EVENT makes the next line due now (lib/test-hooks.ts).

import { useEffect, useMemo, useRef } from "denext";
import type { Dispatch } from "denext";
import type { CompanionEvent } from "../../lib/companion/companion-state.ts";
import type { CompanionMessage } from "../../lib/companion/messages.ts";
import type { EncourageFrequency } from "../../lib/companion/settings.ts";
import {
  activeSpan,
  ACTIVITY_KEY,
  ANOTHER_ACTION,
  claimDay,
  dayKey,
  drawFromBag,
  encourageBubble,
  encourageDelayMs,
  holdsClaim,
  type KeyValueStore,
  mayEncourage,
  nextMidnight,
  quoteBubble,
  quoteBubbleId,
  quoteForDay,
  readActivity,
  shouldWriteActivity,
} from "../../lib/companion/ambient.ts";
import { QUOTES } from "../../lib/companion/quotes.ts";
import { ENCOURAGEMENTS } from "../../lib/companion/encouragements.ts";
import { clockNow, ENCOURAGE_EVENT, isTestMode } from "../../lib/test-hooks.ts";

/** How long after the companion lands the startup quote comes, ms. */
const STARTUP_QUOTE_MS = 1_200;
/** How long a startup claim waits before it is checked (two windows claiming at once), ms. */
const CLAIM_SETTLE_MS = 300;
/** How often encouragement counts active use, ms. */
const ENCOURAGE_TICK_MS = 30_000;

/** The page's shared storage, if it has one. */
function store(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The interactions that count as the user being here. */
const INTERACTIONS = ["focus", "keydown", "pointerdown"] as const;
const PASSIVE = { capture: true, passive: true } as const;

export interface CompanionAmbientOptions {
  /** This overlay is the place for them (the floating one while it shows; else the window's). */
  readonly enabled: boolean;
  readonly quoteOfDay: boolean;
  readonly encourage: boolean;
  readonly every: EncourageFrequency;
  /** The floating companion: it also follows the workspace windows' activity. */
  readonly floating: boolean;
  /** A bubble is on screen or waiting. */
  readonly bubble: boolean;
  /** The chat or review box is open, a voice turn runs, or the companion thinks. */
  readonly busy: boolean;
  readonly asleep: boolean;
  readonly reducedMotion: boolean;
  readonly dispatch: Dispatch<CompanionEvent>;
}

export interface CompanionAmbient {
  /** A bubble's button was pressed: `true` when it was a quote's "Another" (handled here). */
  onAction(message: CompanionMessage, actionId: string): boolean;
}

/** The quote of the day: at startup, and at the first interaction of a new day. */
function useQuoteOfDay(
  on: boolean,
  floating: boolean,
  self: string,
  dispatch: Dispatch<CompanionEvent>,
): (message: CompanionMessage, actionId: string) => boolean {
  const show = (day: string, n: number) => {
    const quote = quoteForDay(day, QUOTES, n);
    dispatch({
      type: "enqueue",
      message: quoteBubble(quote, quoteBubbleId(day, n)),
    });
  };

  useEffect(() => {
    if (!on) return;
    const s = store();
    if (!s) return;
    let next = nextMidnight(clockNow());
    // Startup: claim, then make sure no other window claimed the same day at the same moment.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const startup = setTimeout(() => {
      const day = dayKey(clockNow());
      if (!claimDay(s, day, self)) return;
      settle = setTimeout(() => {
        if (holdsClaim(s, day, self)) show(day, 0);
      }, CLAIM_SETTLE_MS);
    }, STARTUP_QUOTE_MS);
    // A new day: checked on the interaction itself.
    const onInteraction = () => {
      const now = clockNow();
      if (now < next) return;
      next = nextMidnight(now);
      const day = dayKey(now);
      if (claimDay(s, day, self)) show(day, 0);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACTIVITY_KEY) onInteraction();
    };
    for (const type of INTERACTIONS) {
      globalThis.addEventListener(type, onInteraction, PASSIVE);
    }
    if (floating) globalThis.addEventListener("storage", onStorage);
    return () => {
      clearTimeout(startup);
      clearTimeout(settle);
      for (const type of INTERACTIONS) {
        globalThis.removeEventListener(type, onInteraction, PASSIVE);
      }
      globalThis.removeEventListener("storage", onStorage);
    };
  }, [on, floating]);

  return (message, actionId) => {
    if (actionId !== ANOTHER_ACTION || !message.id.startsWith("quote:")) {
      return false;
    }
    const [, day, n] = message.id.split(":");
    show(day, (Number(n) || 0) + 1);
    return true;
  };
}

/** Encouragement: a line after a random stretch of active use, when nothing else is going on. */
function useEncouragement(opts: CompanionAmbientOptions, on: boolean): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!on) return;
    const s = store();
    let target = encourageDelayMs(optsRef.current.every);
    let active = 0;
    let checkedAt = clockNow();
    let local = { at: clockNow(), typedAt: 0 };
    let last: number | undefined;
    let seq = 0;
    const onInput = (e: Event) => {
      const now = clockNow();
      local = {
        at: now,
        typedAt: e.type === "keydown" ? now : local.typedAt,
      };
    };
    const check = (force = false) => {
      const now = clockNow();
      const shared = s ? readActivity(s) : { at: 0, typedAt: 0 };
      const at = Math.max(local.at, shared.at);
      const typedAt = Math.max(local.typedAt, shared.typedAt);
      active += activeSpan(checkedAt, now, at, ENCOURAGE_TICK_MS * 2);
      checkedAt = now;
      if (force) active = Math.max(active, target);
      const o = optsRef.current;
      const away = o.asleep || document.visibilityState === "hidden";
      if (active < target) return;
      const gate = { enabled: true, bubble: o.bubble, busy: o.busy, away };
      if (!mayEncourage({ ...gate, typedAt, now })) return;
      const pick = s
        ? drawFromBag(s, ENCOURAGEMENTS.length, Math.random, last)
        : Math.floor(Math.random() * ENCOURAGEMENTS.length);
      last = pick;
      active = 0;
      target = encourageDelayMs(o.every);
      o.dispatch({
        type: "enqueue",
        message: encourageBubble(
          ENCOURAGEMENTS[pick],
          `cheer:${now}:${seq++}`,
          o.reducedMotion,
        ),
      });
    };
    const tick = setInterval(() => check(), ENCOURAGE_TICK_MS);
    const onTest = () => check(true);
    globalThis.addEventListener("keydown", onInput, PASSIVE);
    globalThis.addEventListener("pointerdown", onInput, PASSIVE);
    if (isTestMode()) globalThis.addEventListener(ENCOURAGE_EVENT, onTest);
    return () => {
      clearInterval(tick);
      globalThis.removeEventListener("keydown", onInput, PASSIVE);
      globalThis.removeEventListener("pointerdown", onInput, PASSIVE);
      globalThis.removeEventListener(ENCOURAGE_EVENT, onTest);
    };
  }, [on, opts.every]);
}

/** The companion's own lines; see the module comment. */
export function useCompanionAmbient(
  opts: CompanionAmbientOptions,
): CompanionAmbient {
  const self = useMemo(() => crypto.randomUUID(), []);
  const onAction = useQuoteOfDay(
    opts.enabled && opts.quoteOfDay,
    opts.floating,
    self,
    opts.dispatch,
  );
  useEncouragement(opts, opts.enabled && opts.encourage);
  return { onAction };
}

/**
 * A workspace window notes the user's activity in shared storage (at most every few seconds, and
 * at once on a new day's first interaction), for the floating companion (`on`: it shows).
 */
export function useActivityBeacon(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const s = store();
    if (!s) return;
    let wroteAt = 0;
    let typedAt = 0;
    const onInput = (e: Event) => {
      const now = clockNow();
      if (e.type === "keydown") typedAt = now;
      if (!shouldWriteActivity(wroteAt, now)) return;
      wroteAt = now;
      try {
        s.setItem(ACTIVITY_KEY, JSON.stringify({ at: now, typedAt }));
      } catch {
        // Storage full or off: the floating companion goes by its own events.
      }
    };
    for (const type of INTERACTIONS) {
      globalThis.addEventListener(type, onInput, PASSIVE);
    }
    return () => {
      for (const type of INTERACTIONS) {
        globalThis.removeEventListener(type, onInput, PASSIVE);
      }
    };
  }, [on]);
}
