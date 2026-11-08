// The lite system monitor: the tick maths, the parsers (fixtures from real `ioreg`, `/proc` and
// `nvidia-smi` output), the moving average, the hot / cool hysteresis, when Loopy may look hot or
// say so, the cadence and the settings (lib/sysstats.ts); the sampler's own rules and, on macOS,
// the Mach / IOKit FFI readers for real (desktop/sysstats.ts); the demo's `load` (lib/
// sysstats-demo.ts).

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  COOL,
  cpuPercent,
  DEFAULT_MONITOR,
  ema,
  formatStats,
  HOT_LINE_EVERY_MS,
  type HotState,
  machTicks,
  maySayHot,
  mayShowHot,
  NO_STATS,
  parseBusyPercent,
  parseIoregGpu,
  parseMeminfo,
  parseNvidiaSmi,
  parseProcStat,
  sampleDelay,
  sanitizeMonitor,
  smooth,
  type Smoothed,
  stepHot,
  thresholds,
} from "../lib/sysstats.ts";
import {
  CpuReader,
  IoKitGpu,
  MachHost,
  SlowReader,
  SysSampler,
} from "../desktop/sysstats.ts";
import { demoLoadCommand, demoSample } from "../lib/sysstats-demo.ts";

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`./fixtures/sysstats/${name}`, import.meta.url));

// --- ticks -----------------------------------------------------------------------------------

Deno.test("sysstats: Mach's four counters are user, system, idle, nice", () => {
  assertEquals(machTicks([300, 100, 600, 50]), { busy: 450, total: 1050 });
});

Deno.test("sysstats: the CPU's share is the busy ticks over all ticks between two readings", () => {
  const a = machTicks([1000, 500, 8000, 0]);
  const b = machTicks([1300, 600, 8600, 0]); // +400 busy of +1000
  assertEquals(cpuPercent(a, b), 40);
  // No time passed, or the counters went back (a reboot): no figure.
  assertEquals(cpuPercent(a, a), null);
  assertEquals(cpuPercent(b, a), null);
});

Deno.test("sysstats: Mach's 32-bit counters wrap", () => {
  const wrap = 2 ** 32;
  const a = { busy: wrap - 100, total: wrap - 400 };
  const b = { busy: 100, total: 600 }; // +200 busy of +1000, across the wrap
  assertEquals(cpuPercent(a, b, wrap), 20);
});

Deno.test("sysstats: /proc/stat's cpu line (idle and iowait are the idle ticks)", async () => {
  const t = parseProcStat(await fixture("proc-stat.txt"));
  assertEquals(t, { busy: 9390 - 3722, total: 9390 });
  const next = parseProcStat("cpu  4805 356 584 3799 23 23 0 0 0 0\n");
  assertEquals(cpuPercent(t!, next!), 50);
  assertEquals(parseProcStat("intr 1 2 3\n"), null);
  assertEquals(parseProcStat("cpu  a b c d\n"), null);
});

Deno.test("sysstats: /proc/meminfo's pressure is 100 − available / total", async () => {
  assertAlmostEquals(
    parseMeminfo(await fixture("meminfo.txt"))!,
    100 - 8151714 / 16303428 * 100,
    1e-9,
  );
  assertEquals(parseMeminfo("MemTotal: 100 kB\n"), null);
});

// --- GPU text ---------------------------------------------------------------------------------

Deno.test("sysstats: ioreg on Apple silicon gives Device Utilization %", async () => {
  assertEquals(parseIoregGpu(await fixture("ioreg-apple-silicon.txt")), 47);
});

Deno.test("sysstats: ioreg with two GPUs gives the busier (an AMD's GPU Activity(%))", async () => {
  assertEquals(parseIoregGpu(await fixture("ioreg-intel-dual.txt")), 64);
  assertEquals(parseIoregGpu("+-o Nothing\n"), null);
});

Deno.test("sysstats: nvidia-smi's busiest GPU (header and % tolerated)", async () => {
  assertEquals(parseNvidiaSmi(await fixture("nvidia-smi.txt")), 81);
  assertEquals(parseNvidiaSmi("12\n"), 12);
  assertEquals(parseNvidiaSmi("NVIDIA-SMI has failed\n"), null);
});

Deno.test("sysstats: AMD's gpu_busy_percent", () => {
  assertEquals(parseBusyPercent("73\n"), 73);
  assertEquals(parseBusyPercent(""), null);
  assertEquals(parseBusyPercent("x"), null);
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

// --- the sampler -------------------------------------------------------------------------------

Deno.test("sysstats: the CPU reader needs two readings", async () => {
  const ticks = [{ busy: 0, total: 0 }, { busy: 30, total: 100 }];
  const r = new CpuReader(() => ticks.shift() ?? null);
  assertEquals(await r.read(), null);
  assertEquals(await r.read(), 30);
  assertEquals(await r.read(), null); // the counter is gone
});

Deno.test("sysstats: samples within a second share a reading; a failing reader is null", async () => {
  let now = 1000;
  let reads = 0;
  const sampler = new SysSampler({
    cpu: { read: () => ++reads },
    gpu: {
      read: () => {
        throw new Error("no GPU");
      },
    },
    mem: { read: () => Promise.resolve(42) },
  }, () => now);
  const a = await sampler.sample();
  assertEquals([a.cpu, a.gpu, a.mem, a.at], [1, null, 42, 1000]);
  assert(typeof a.costMs === "number" && a.costMs >= 0);
  now += 500;
  assertEquals(await sampler.sample(), a);
  now += 600;
  assertEquals((await sampler.sample()).cpu, 2);
  // Concurrent callers share the one in flight.
  now += 2000;
  const [x, y] = await Promise.all([sampler.sample(), sampler.sample()]);
  assertEquals(x, y);
  assertEquals(reads, 3);
});

Deno.test("sysstats: a command-line GPU figure is fetched at most every 15 s, in the background", async () => {
  let now = 0;
  let fetches = 0;
  const r = new SlowReader(() => Promise.resolve(++fetches * 10), () => now);
  assertEquals(r.read(), null); // started, not in yet
  await Promise.resolve();
  await Promise.resolve();
  now = 4_000;
  assertEquals(r.read(), 10);
  now = 14_000;
  assertEquals(r.read(), 10);
  assertEquals(fetches, 1);
  now = 15_000;
  r.read();
  assertEquals(fetches, 2);
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

// --- the real readers (macOS) ------------------------------------------------------------------

Deno.test({
  name:
    "sysstats: Mach's CPU ticks, the memory level and IOKit's GPU, through FFI",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const host = new MachHost();
    try {
      const a = host.ticks();
      assert(a && a.total > 0 && a.busy > 0 && a.busy <= a.total);
      // Burn a little CPU so the counters move.
      const until = performance.now() + 60;
      while (performance.now() < until) Math.sqrt(Math.random());
      await new Promise((r) => setTimeout(r, 40));
      const cpu = cpuPercent(a, host.ticks()!, 2 ** 32);
      assert(cpu !== null && cpu >= 0 && cpu <= 100, `CPU ${cpu}`);
      const mem = host.memPressure();
      assert(mem !== null && mem >= 0 && mem <= 100, `memory ${mem}`);
    } finally {
      host.close();
    }
    const gpu = new IoKitGpu();
    try {
      // A VM (CI) may have no accelerator: null then, never junk.
      const v = gpu.read();
      assert(v === null || (v >= 0 && v <= 100), `GPU ${v}`);
    } finally {
      gpu.close();
    }
  },
});
