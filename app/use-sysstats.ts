// The lite system monitor in the page (Settings → System monitor): asks the backend for a sample
// (Denext's `system.stats()` in the app, lib/sysstats-demo.ts in the demo) every few seconds while the bar meter or Loopy's hot face wants one, and
// works out the smoothed figures and whether the machine is hot (lib/sysstats.ts). Kept light:
//
// - one timer chain, no interval: the next sample is asked for only once the last one is in;
// - every 4 s with the window focused, every 12 s in the background, and none at all while it is
//   hidden (minimised, another space) or when neither the meter nor the hot face is on;
// - React state changes only when a rounded figure or the hot flag does.
//
// With `?test=1&statsMs=<n>` (the e2e suite) the cadence is `n` ms.

import { useEffect, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import {
  COOL,
  type HotState,
  type HotThresholds,
  NO_STATS,
  sampleDelay,
  smooth,
  type Smoothed,
  stepHot,
} from "../lib/sysstats.ts";
import { isTestMode } from "../lib/test-hooks.ts";

export interface SysStatsOptions {
  backend: PtyBackend | null;
  /** Someone wants the figures (the bar meter, or the hot face). */
  active: boolean;
  thresholds: HotThresholds;
}

export interface SysStats {
  /** The smoothed figures (`null` each until the first reading, or not available). */
  stats: Smoothed;
  hot: boolean;
}

/** The test cadence override (`?test=1&statsMs=300`), or undefined. */
function testCadence(): number | undefined {
  if (!isTestMode()) return undefined;
  const n = Number(
    new URLSearchParams(globalThis.location?.search ?? "").get("statsMs"),
  );
  return n > 0 ? n : undefined;
}

const same = (a: Smoothed, b: Smoothed) =>
  (["cpu", "gpu", "mem"] as const).every((k) =>
    (a[k] === null ? null : Math.round(a[k]!)) ===
      (b[k] === null ? null : Math.round(b[k]!))
  );

/** The system monitor's figures and the hot flag; see the module comment. */
export function useSysStats(opts: SysStatsOptions): SysStats {
  const { backend, active } = opts;
  const [view, setView] = useState<SysStats>({ stats: NO_STATS, hot: false });
  const { hotAt, coolAt, sustainMs } = opts.thresholds;

  useEffect(() => {
    if (!backend || !active) {
      setView({ stats: NO_STATS, hot: false });
      return;
    }
    const t: HotThresholds = { hotAt, coolAt, sustainMs };
    const fixed = testCadence();
    let stats: Smoothed = NO_STATS;
    let hot: HotState = COOL;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let stopped = false;

    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (stopped || inFlight) return;
      const delay = fixed ?? sampleDelay(
        document.visibilityState === "hidden" ? "hidden" : "visible",
        document.hasFocus(),
      );
      if (delay !== null) timer = setTimeout(take, delay);
    };
    const take = async () => {
      inFlight = true;
      try {
        const sample = await backend.sysSample();
        if (stopped) return;
        const next = smooth(stats, sample);
        hot = stepHot(hot, next, sample.at, t);
        const changed = !same(next, stats);
        stats = next;
        setView((v) =>
          !changed && v.hot === hot.hot ? v : { stats, hot: hot.hot }
        );
      } catch { /* no reading this time */ }
      inFlight = false;
      schedule();
    };

    void take();
    // Hidden → stop; shown or focused → back to the quicker cadence (a sample comes soon).
    const wake = () => schedule();
    document.addEventListener("visibilitychange", wake);
    globalThis.addEventListener("focus", wake);
    globalThis.addEventListener("blur", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      globalThis.removeEventListener("focus", wake);
      globalThis.removeEventListener("blur", wake);
    };
  }, [backend, active, hotAt, coolAt, sustainMs]);

  return view;
}
