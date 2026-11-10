/**
 * The lite system monitor's logic (CPU and GPU use, memory pressure), kept pure so it is
 * unit-tested. The figures come from Denext's `system.stats()` (`denext desktop add
 * system-stats`, `denext/desktop/client`; lib/pty-client.ts asks for one) and app/use-sysstats.ts
 * asks for a sample every few seconds.
 *
 * - Sample: Denext's `SystemStats` folded to the three figures shown ({@linkcode fromSystemStats}):
 *   the CPU's busy share since this window's previous sample, the busiest GPU, memory pressure.
 * - Smoothing: an exponential moving average over the samples.
 * - "Hot": a hysteresis state machine over the smoothed figures (hot after the CPU or GPU stays
 *   at or above `hotAt` for `sustainMs`; cool again after both stay below `coolAt` that long), so
 *   Loopy's hot face does not flicker. {@linkcode mayShowHot} says when it may show.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { SystemStats } from "denext/desktop/client";

// --- samples --------------------------------------------------------------------------------

/** One reading of the machine, in percent (0–100); `null`: not available here. */
export interface SysSample {
  readonly cpu: number | null;
  readonly gpu: number | null;
  /** Memory pressure: how close the machine is to running out of memory. */
  readonly mem: number | null;
  /** When it was taken (ms since the epoch). */
  readonly at: number;
}

/**
 * Denext's `SystemStats` as the monitor's sample: the aggregate CPU (`cpu.total`), the busiest
 * GPU (`gpu.utilization`) and memory pressure (`memory.pressure`), each `null` where the OS gives
 * no figure. A figure is clamped to 0–100; one that is not a finite number counts as missing.
 */
export function fromSystemStats(s: SystemStats): SysSample {
  return {
    cpu: pct(s.cpu?.total),
    gpu: pct(s.gpu?.utilization),
    mem: pct(s.memory?.pressure),
    at: typeof s.at === "number" && Number.isFinite(s.at) ? s.at : Date.now(),
  };
}

function pct(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(100, Math.max(0, v))
    : null;
}

// --- smoothing ------------------------------------------------------------------------------

/** How much a new sample counts in the moving average. */
const EMA_ALPHA = 0.5;

/** The moving average of `prev` with `next` (either may be missing). */
export function ema(
  prev: number | null,
  next: number | null,
  alpha = EMA_ALPHA,
): number | null {
  if (next === null) return prev;
  if (prev === null) return next;
  return prev + alpha * (next - prev);
}

/** The smoothed CPU, GPU and memory figures. */
export interface Smoothed {
  readonly cpu: number | null;
  readonly gpu: number | null;
  readonly mem: number | null;
}

export const NO_STATS: Smoothed = { cpu: null, gpu: null, mem: null };

/** `prev` with `sample` folded in. */
export function smooth(prev: Smoothed, sample: SysSample): Smoothed {
  return {
    cpu: ema(prev.cpu, sample.cpu),
    gpu: ema(prev.gpu, sample.gpu),
    mem: ema(prev.mem, sample.mem),
  };
}

// --- hot ------------------------------------------------------------------------------------

/** When the machine counts as hot. */
export interface HotThresholds {
  /** Hot once the CPU or the GPU stays at or above this (%). */
  readonly hotAt: number;
  /** Cool again once both stay below this (%). */
  readonly coolAt: number;
  /** How long either condition must hold (ms). */
  readonly sustainMs: number;
}

/** The hysteresis machine's state. */
export interface HotState {
  readonly hot: boolean;
  /** Since when the condition that would flip `hot` has held (`null`: it does not). */
  readonly since: number | null;
}

export const COOL: HotState = { hot: false, since: null };

/** The next state after a reading of `stats` at `now`. */
export function stepHot(
  state: HotState,
  stats: Smoothed,
  now: number,
  t: HotThresholds,
): HotState {
  const peak = Math.max(stats.cpu ?? 0, stats.gpu ?? 0);
  const flipping = state.hot ? peak < t.coolAt : peak >= t.hotAt;
  if (!flipping) {
    return state.since === null ? state : { ...state, since: null };
  }
  const since = state.since ?? now;
  if (now - since >= t.sustainMs) return { hot: !state.hot, since: null };
  return state.since === null ? { ...state, since } : state;
}

/** What decides whether Loopy may show it is hot. */
export interface HotContext {
  /** Settings → System monitor → Loopy gets hot (and Lively on). */
  readonly enabled: boolean;
  readonly hot: boolean;
  /** Loopy is free: idle with nothing on screen (lib/companion/loopy-life.ts `mayLiven`). */
  readonly free: boolean;
}

/**
 * Whether Loopy wears its hot face: never over a question, a reply, thinking, a voice turn or a
 * sad face — only while it is otherwise idle.
 */
export function mayShowHot(ctx: HotContext): boolean {
  return ctx.enabled && ctx.hot && ctx.free;
}

/** What Loopy says (aloud) when it gets hot. */
export const HOT_LINE = "Phew, the CPU is cooking.";
/** At most one hot line this often. */
export const HOT_LINE_EVERY_MS = 30 * 60_000;

/**
 * Whether to say {@linkcode HOT_LINE} now the hot face came on: only with a spoken alert on
 * (Settings → Voice), nothing else being said, and the last line long enough ago.
 */
export function maySayHot(ctx: {
  alertsOn: boolean;
  speaking: boolean;
  lastSaidAt: number | null;
  now: number;
}): boolean {
  return ctx.alertsOn && !ctx.speaking &&
    (ctx.lastSaidAt === null || ctx.now - ctx.lastSaidAt >= HOT_LINE_EVERY_MS);
}

// --- cadence --------------------------------------------------------------------------------

/** How often the page asks for a sample: focused, and in the background. Hidden: never. */
const SAMPLE_MS = { focused: 4_000, blurred: 12_000 } as const;

/** The delay before the next sample, or `null` to stop (the window hidden). */
export function sampleDelay(
  visibility: "visible" | "hidden",
  focused: boolean,
): number | null {
  if (visibility === "hidden") return null;
  return focused ? SAMPLE_MS.focused : SAMPLE_MS.blurred;
}

// --- settings -------------------------------------------------------------------------------

/** Settings → System monitor. */
export interface MonitorSettings {
  /** The CPU / GPU meter in the switcher bar. */
  meter: boolean;
  /** Loopy looks hot while the machine is (needs Settings → Companion → Lively). */
  hotLoopy: boolean;
  hotAt: number;
  coolAt: number;
  /** Seconds either condition must hold. */
  sustainS: number;
}

export const DEFAULT_MONITOR: MonitorSettings = {
  meter: false,
  hotLoopy: true,
  hotAt: 85,
  coolAt: 70,
  sustainS: 10,
};

/** The thresholds' ranges (Settings' number fields). */
export const MONITOR_RANGES = {
  hotAt: { min: 50, max: 100 },
  coolAt: { min: 20, max: 95 },
  sustainS: { min: 2, max: 120 },
} as const;

/** `raw` (storage or a patch) onto `base`, each field checked; cool stays below hot. */
export function sanitizeMonitor(
  raw: unknown,
  base: MonitorSettings = DEFAULT_MONITOR,
): MonitorSettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof MonitorSettings, unknown>>;
  if (typeof r.meter === "boolean") out.meter = r.meter;
  if (typeof r.hotLoopy === "boolean") out.hotLoopy = r.hotLoopy;
  for (const key of ["hotAt", "coolAt", "sustainS"] as const) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const { min, max } = MONITOR_RANGES[key];
      out[key] = Math.round(Math.min(max, Math.max(min, v)));
    }
  }
  if (out.coolAt >= out.hotAt) out.coolAt = Math.max(0, out.hotAt - 5);
  return out;
}

/** The hysteresis thresholds of `s`. */
export function thresholds(s: MonitorSettings): HotThresholds {
  return { hotAt: s.hotAt, coolAt: s.coolAt, sustainMs: s.sustainS * 1000 };
}

/** "CPU 23% · GPU 61%" (a missing figure left out). */
export function formatStats(s: Smoothed): string {
  const part = (label: string, v: number | null) =>
    v === null ? [] : [`${label} ${Math.round(v)}%`];
  return [...part("CPU", s.cpu), ...part("GPU", s.gpu)].join(" · ");
}
