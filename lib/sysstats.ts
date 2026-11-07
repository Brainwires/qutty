/**
 * The lite system monitor's logic (CPU and GPU use, memory pressure), kept pure so it is
 * unit-tested; desktop/sysstats.ts reads the counters (Mach and IOKit through FFI on macOS,
 * `/proc` and sysfs on Linux) and app/use-sysstats.ts asks for a sample every few seconds.
 *
 * - CPU: the busy share of the tick counters between two readings (Mach `host_statistics`,
 *   `/proc/stat`).
 * - GPU: the driver's own utilisation figure (IOKit's `PerformanceStatistics`, AMD's
 *   `gpu_busy_percent`, `nvidia-smi`), parsed here when it comes as text.
 * - Smoothing: an exponential moving average over the samples.
 * - "Hot": a hysteresis state machine over the smoothed figures (hot after the CPU or GPU stays
 *   at or above `hotAt` for `sustainMs`; cool again after both stay below `coolAt` that long), so
 *   Loopy's hot face does not flicker. {@linkcode mayShowHot} says when it may show.
 *
 * Client-safe and pure.
 *
 * @module
 */

// --- samples --------------------------------------------------------------------------------

/** One reading of the machine, in percent (0–100); `null`: not available here. */
export interface SysSample {
  readonly cpu: number | null;
  readonly gpu: number | null;
  /** Memory pressure: the share of memory in use or unavailable. */
  readonly mem: number | null;
  /** When it was taken (ms since the epoch). */
  readonly at: number;
  /** How long the backend spent taking it (ms, its own cost). */
  readonly costMs?: number;
}

/** Cumulative CPU time counters: the busy and the total ticks since boot. */
export interface CpuTicks {
  readonly busy: number;
  readonly total: number;
}

/** Mach's `host_cpu_load_info`: [user, system, idle, nice] ticks. */
export function machTicks(load: ArrayLike<number>): CpuTicks {
  const [user, system, idle, nice] = [load[0], load[1], load[2], load[3]];
  return { busy: user + system + nice, total: user + system + idle + nice };
}

/** The counters are 32-bit on macOS and wrap: the forward distance from `a` to `b`. */
function delta(a: number, b: number, wrap: number | undefined): number {
  const d = b - a;
  return d < 0 && wrap ? d + wrap : d;
}

/**
 * The CPU's busy share between two readings, in percent; `null` when no time passed (or the
 * counters went backwards without a wrap to explain it). `wrap`: the counters' modulus (2^32 for
 * Mach's `natural_t`), none for 64-bit ones.
 */
export function cpuPercent(
  prev: CpuTicks,
  next: CpuTicks,
  wrap?: number,
): number | null {
  const total = delta(prev.total, next.total, wrap);
  const busy = delta(prev.busy, next.busy, wrap);
  if (!(total > 0) || busy < 0) return null;
  return clampPct((busy / total) * 100);
}

/**
 * The aggregate `cpu` line of Linux's `/proc/stat`: user nice system idle iowait irq softirq
 * steal (guest time is already in user and nice). Idle and iowait are the idle ticks.
 */
export function parseProcStat(text: string): CpuTicks | null {
  const line = text.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
  const [
    user,
    nice,
    system,
    idle,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
  ] = n;
  const idleAll = idle + iowait;
  const total = user + nice + system + idleAll + irq + softirq + steal;
  return { busy: total - idleAll, total };
}

/** Memory pressure from Linux's `/proc/meminfo`: 100 − MemAvailable / MemTotal. */
export function parseMeminfo(text: string): number | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (!total || available === null) return null;
  return clampPct(100 - (available / total) * 100);
}

/** The keys IOKit's `PerformanceStatistics` names the GPU's busy share by, best first. */
export const GPU_UTILISATION_KEYS = [
  "Device Utilization %", // Apple silicon, Intel graphics
  "GPU Activity(%)", // AMD on macOS
  "Renderer Utilization %",
] as const;

/**
 * The busiest GPU in `ioreg -r -c IOAccelerator -d 1` output (the fallback when IOKit cannot be
 * read through FFI): each accelerator's `PerformanceStatistics` dictionary, its first known key.
 */
export function parseIoregGpu(text: string): number | null {
  let best: number | null = null;
  for (
    const [, body] of text.matchAll(/"PerformanceStatistics" = \{([^}]*)\}/g)
  ) {
    for (const key of GPU_UTILISATION_KEYS) {
      const esc = key.replace(/[()%]/g, (c) => `\\${c}`);
      const m = new RegExp(`"${esc}"=(\\d+)`).exec(body);
      if (m) {
        best = Math.max(best ?? 0, clampPct(Number(m[1])));
        break;
      }
    }
  }
  return best;
}

/**
 * The busiest GPU in `nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits`
 * output (one number per GPU; the header and a `%` are tolerated).
 */
export function parseNvidiaSmi(text: string): number | null {
  let best: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(line);
    if (m) best = Math.max(best ?? 0, clampPct(Number(m[1])));
  }
  return best;
}

/** AMD's sysfs `gpu_busy_percent` (a bare number). */
export function parseBusyPercent(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() && Number.isFinite(n) ? clampPct(n) : null;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
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
