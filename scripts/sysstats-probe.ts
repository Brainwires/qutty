// Runs the system monitor's sampler (desktop/sysstats.ts) in this process for a while and prints
// each sample with its own cost, then this process's CPU time over the run. With the packaged
// app's permissions (no `sys`, no `run`):
//
//   deno run --allow-read --allow-env --allow-ffi scripts/sysstats-probe.ts [seconds] [interval-ms]
import process from "node:process";
import { platformReaders, SysSampler } from "../desktop/sysstats.ts";
import { PtyRunner } from "../desktop/ollama.ts";

const seconds = Number(Deno.args[0] ?? 20);
const interval = Number(Deno.args[1] ?? 4000);
const sampler = new SysSampler(
  platformReaders(() => new PtyRunner(undefined)),
);
const pct = (v: number | null) =>
  v === null ? "   –" : `${v.toFixed(0).padStart(3)}%`;
const costs: number[] = [];
const cpu0 = process.cpuUsage();
const t0 = performance.now();
await sampler.sample(); // the baseline (the CPU figure needs two readings)
while (performance.now() - t0 < seconds * 1000) {
  await new Promise((r) => setTimeout(r, interval));
  const s = await sampler.sample();
  costs.push(s.costMs ?? 0);
  console.log(
    `CPU ${pct(s.cpu)}  GPU ${pct(s.gpu)}  mem ${pct(s.mem)}  cost ${
      s.costMs?.toFixed(3)
    } ms`,
  );
}
sampler.close();
const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
console.log(
  `${costs.length} samples; cost per sample: avg ${avg.toFixed(3)} ms, max ${
    Math.max(...costs).toFixed(3)
  } ms`,
);
const used = process.cpuUsage(cpu0);
const wallUs = (performance.now() - t0) * 1000;
const cpuUs = used.user + used.system;
console.log(
  `this process's CPU over the run (Deno start-up excluded): ${
    (cpuUs / 1000).toFixed(1)
  } ms in ${(wallUs / 1e6).toFixed(1)} s = ${
    (100 * cpuUs / wallUs).toFixed(3)
  }%`,
);
