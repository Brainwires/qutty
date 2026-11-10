// The lite system monitor: Denext's `SystemStats` folded to the monitor's sample, the moving
// average, the hot / cool hysteresis, when Loopy may look hot or say so, the cadence and the
// settings (lib/sysstats.ts); the demo's `load` (lib/sysstats-demo.ts).

import { assert, assertEquals } from "@std/assert";
import {
  COOL,
  DEFAULT_MONITOR,
  ema,
  formatStats,
  fromSystemStats,
  HOT_LINE_EVERY_MS,
  type HotState,
  maySayHot,
  mayShowHot,
  NO_STATS,
  sampleDelay,
  sanitizeMonitor,
  smooth,
  type Smoothed,
  stepHot,
  thresholds,
} from "../lib/sysstats.ts";
import { demoLoadCommand, demoSample } from "../lib/sysstats-demo.ts";

// --- samples -----------------------------------------------------------------------------------

Deno.test("sysstats: Denext's SystemStats gives the CPU total, the busiest GPU, memory pressure", () => {
  assertEquals(
    fromSystemStats({
      at: 1000,
      cpu: { total: 23.5, cores: [41, 6] },
      gpu: {
        utilization: 12,
        devices: [{ name: "Apple M3", utilization: 12 }],
      },
      memory: { pressure: 38, usedBytes: 1, totalBytes: 2 },
    }),
    { cpu: 23.5, gpu: 12, mem: 38, at: 1000 },
  );
  // A figure the OS does not report stays missing; out-of-range ones are clamped.
  assertEquals(
    fromSystemStats({
      at: 2000,
      cpu: { total: null },
      gpu: { utilization: null },
      memory: { pressure: 140 },
    }),
    { cpu: null, gpu: null, mem: 100, at: 2000 },
  );
});

// --- smoothing ---------------------------------------------------------------------------------

Deno.test("sysstats: the moving average halves the way to each new sample", () => {
  assertEquals(ema(null, 40), 40);
  assertEquals(ema(40, 80), 60);
  assertEquals(ema(60, null), 60);
  const s = smooth(NO_STATS, { cpu: 20, gpu: null, mem: 50, at: 0 });
  assertEquals(s, { cpu: 20, gpu: null, mem: 50 });
  assertEquals(smooth(s, { cpu: 60, gpu: 10, mem: 50, at: 1 }), {
    cpu: 40,
    gpu: 10,
    mem: 50,
  });
});

// --- hot -----------------------------------------------------------------------------------------

const T = thresholds(DEFAULT_MONITOR); // hot ≥ 85 for 10 s, cool < 70 for 10 s
const at = (cpu: number, gpu: number | null = null): Smoothed => ({
  cpu,
  gpu,
  mem: null,
});

/** Run the machine over (time in s, figures) readings; the hot flag after each. */
function run(readings: [number, Smoothed][], from: HotState = COOL) {
  let s = from;
  return readings.map(([t, stats]) => (s = stepHot(s, stats, t * 1000, T)).hot);
}

Deno.test("sysstats: hot only after 10 s at or above 85%, on the CPU or the GPU", () => {
  assertEquals(
    run([[0, at(90)], [4, at(92)], [8, at(95)], [12, at(91)]]),
    [false, false, false, true],
  );
  assertEquals(
    run([[0, at(10, 88)], [5, at(10, 90)], [10, at(10, 86)]]),
    [false, false, true],
  );
});

Deno.test("sysstats: a dip below 85% starts the 10 s over", () => {
  assertEquals(
    run([[0, at(90)], [4, at(90)], [8, at(80)], [12, at(90)], [20, at(90)], [
      22,
      at(90),
    ]]),
    [false, false, false, false, false, true],
  );
});

Deno.test("sysstats: cool again only after 10 s below 70% (hysteresis: 75% stays hot)", () => {
  const hot: HotState = { hot: true, since: null };
  assertEquals(
    run([[0, at(75)], [20, at(78)], [40, at(72)]], hot),
    [true, true, true],
  );
  assertEquals(
    run(
      [[0, at(60)], [4, at(65)], [8, at(80)], [12, at(50)], [22, at(40)]],
      hot,
    ),
    [true, true, true, true, false],
  );
  // Both must be cool: a busy GPU keeps it hot.
  assertEquals(run([[0, at(10, 90)], [30, at(10, 90)]], hot), [true, true]);
});

Deno.test("sysstats: no figures at all is cool", () => {
  assertEquals(run([[0, NO_STATS], [30, NO_STATS]]), [false, false]);
});

Deno.test("sysstats: Loopy looks hot only when enabled, hot and otherwise free", () => {
  assert(mayShowHot({ enabled: true, hot: true, free: true }));
  assert(!mayShowHot({ enabled: false, hot: true, free: true }));
  assert(!mayShowHot({ enabled: true, hot: false, free: true }));
  // A question (attention), a reply, thinking, a voice turn: not free.
  assert(!mayShowHot({ enabled: true, hot: true, free: false }));
});

Deno.test("sysstats: the hot line only with a spoken alert on, silence, and rarely", () => {
  const base = { alertsOn: true, speaking: false, lastSaidAt: null, now: 1e9 };
  assert(maySayHot(base));
  assert(!maySayHot({ ...base, alertsOn: false }));
  assert(!maySayHot({ ...base, speaking: true }));
  assert(!maySayHot({ ...base, lastSaidAt: 1e9 - HOT_LINE_EVERY_MS + 1 }));
  assert(maySayHot({ ...base, lastSaidAt: 1e9 - HOT_LINE_EVERY_MS }));
});

// --- cadence and settings ----------------------------------------------------------------------

Deno.test("sysstats: every 4 s focused, 12 s in the background, never while hidden", () => {
  assertEquals(sampleDelay("visible", true), 4_000);
  assertEquals(sampleDelay("visible", false), 12_000);
  assertEquals(sampleDelay("hidden", true), null);
});

Deno.test("sysstats: the settings: meter off, hot Loopy on, thresholds clamped, cool below hot", () => {
  assertEquals(DEFAULT_MONITOR.meter, false);
  assertEquals(DEFAULT_MONITOR.hotLoopy, true);
  assertEquals(sanitizeMonitor(null), DEFAULT_MONITOR);
  assertEquals(
    sanitizeMonitor({ meter: true, hotAt: 400, coolAt: -3, sustainS: 0.4 }),
    { ...DEFAULT_MONITOR, meter: true, hotAt: 100, coolAt: 20, sustainS: 2 },
  );
  assertEquals(sanitizeMonitor({ hotAt: 60 }).coolAt, 55);
  assertEquals(sanitizeMonitor({ meter: "yes", hotAt: "9" }), DEFAULT_MONITOR);
  assertEquals(thresholds(DEFAULT_MONITOR), {
    hotAt: 85,
    coolAt: 70,
    sustainMs: 10_000,
  });
});

Deno.test("sysstats: CPU 23% · GPU 61%", () => {
  assertEquals(formatStats(at(23.4, 60.6)), "CPU 23% · GPU 61%");
  assertEquals(formatStats(at(5)), "CPU 5%");
  assertEquals(formatStats(NO_STATS), "");
});

// --- the demo -----------------------------------------------------------------------------------

Deno.test("sysstats: the demo's load pins the figures; load off lets them drift", () => {
  assertEquals(demoLoadCommand(["95"]), "load: CPU 95% · GPU 95%");
  assertEquals([demoSample(0).cpu, demoSample(0).gpu], [95, 95]);
  assertEquals(demoLoadCommand(["120", "30"]), "load: CPU 100% · GPU 30%");
  demoLoadCommand(["off"]);
  const calm = demoSample(0);
  assert(calm.cpu! < 30 && calm.gpu! < 30);
});
