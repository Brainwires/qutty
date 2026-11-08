/**
 * The demo backend's system monitor (lib/pty-client.ts, `denext dev` and the e2e suite): a calm
 * machine that drifts a little, until the demo shell's `load <cpu> [gpu]` pins the figures (and
 * `load off` lets them drift again).
 *
 * Client-safe.
 *
 * @module
 */

import type { SysSample } from "./sysstats.ts";

/** The pinned figures, or `null` for the calm drift. */
let pinned: { cpu: number; gpu: number } | null = null;

/** Pin the demo's CPU and GPU figures (`null`: drift again). */
function setDemoLoad(load: { cpu: number; gpu: number } | null): void {
  pinned = load;
}

/** `load` in the demo shell: what to print. */
export function demoLoadCommand(args: string[]): string {
  if (args[0] === "off" || args.length === 0) {
    setDemoLoad(null);
    return "load: the demo machine is calm again";
  }
  const pct = (s: string | undefined, fallback: number) => {
    const n = Number(s);
    return Number.isFinite(n) && s !== undefined
      ? Math.min(100, Math.max(0, n))
      : fallback;
  };
  const cpu = pct(args[0], 0);
  const gpu = pct(args[1], cpu);
  setDemoLoad({ cpu, gpu });
  return `load: CPU ${cpu}% · GPU ${gpu}%`;
}

/** A demo sample at `now`. */
export function demoSample(now = Date.now()): SysSample {
  if (pinned) {
    return { cpu: pinned.cpu, gpu: pinned.gpu, mem: 41, at: now, costMs: 0 };
  }
  const t = now / 1000;
  return {
    cpu: 14 + 6 * Math.sin(t / 7),
    gpu: 9 + 5 * Math.sin(t / 11),
    mem: 41,
    at: now,
    costMs: 0,
  };
}
