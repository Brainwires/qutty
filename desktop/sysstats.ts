// The lite system monitor, the desktop side: a desktop extension (`sysstats`) beside `pty`,
// `ssh`, `hub`, `sandbox`, `voice`, `ollama` and `links`. One method, `sample`: the CPU's busy
// share since the previous sample, the GPU's utilisation and the memory pressure, in percent
// (lib/sysstats.ts holds the maths and the parsers). The page (app/use-sysstats.ts) asks every few
// seconds while the bar meter or Loopy's hot face wants it, slower in the background and never
// while the window is hidden, so nothing here runs on its own: no timer, no thread, no process.
//
// The app has no `sys` or `run` permission (only read, env, ffi and loopback net), so:
//
// - macOS: Mach and IOKit through FFI, all in this process. The CPU from `host_statistics`
//   (`HOST_CPU_LOAD_INFO`: four tick counters, a 16-byte read into a buffer we own); the memory
//   pressure from `sysctlbyname("kern.memorystatus_level")`; the GPU from each `IOAccelerator`
//   service's `PerformanceStatistics` dictionary ("Device Utilization %"), the services found once
//   and kept. About 0.2 ms a sample in all. Should IOKit not load, `ioreg` runs in a hidden PTY
//   (desktop/ollama.ts `PtyRunner`) instead, at most every 15 s.
// - Linux: `/proc/stat` and `/proc/meminfo` (read permission); an AMD GPU's sysfs
//   `gpu_busy_percent`; else `nvidia-smi` in a hidden PTY, if it is installed, at most every 15 s
//   (it is the only way to an NVIDIA GPU's figure without the driver's library).
// - Windows: nothing yet (every figure `null`).

import { defineDesktopExtension } from "denext/desktop";
import { emptyInput } from "./schema.ts";
import { resolveProgram } from "./pty.ts";
import { type CommandRunner, PtyRunner } from "./ollama.ts";
import {
  cpuPercent,
  type CpuTicks,
  GPU_UTILISATION_KEYS,
  machTicks,
  parseBusyPercent,
  parseIoregGpu,
  parseMeminfo,
  parseNvidiaSmi,
  parseProcStat,
  type SysSample,
} from "../lib/sysstats.ts";

/** Samples closer together than this share one reading (two pages, a double call). */
const MIN_GAP_MS = 1_000;
/** A command-line GPU reading (ioreg, nvidia-smi) is reused for this long. */
const SLOW_GPU_MS = 15_000;
/** How long to wait before looking for the GPU again after it could not be read. */
const GPU_RETRY_MS = 60_000;
const RUN_TIMEOUT_MS = 5_000;
/** Mach's `natural_t` tick counters wrap at 2^32. */
const MACH_WRAP = 2 ** 32;

/** Reads one figure of the machine (or `null`); `close` frees what it holds. */
export interface Reader {
  read(): Promise<number | null> | number | null;
  close?(): void;
}

/** A command-line GPU figure, read at most every {@linkcode SLOW_GPU_MS} (in the background). */
export class SlowReader implements Reader {
  #last: number | null = null;
  #at = -Infinity;
  #pending: Promise<void> | undefined;
  constructor(
    private readonly fetch: () => Promise<number | null>,
    private readonly now: () => number = Date.now,
  ) {}
  read(): number | null {
    if (!this.#pending && this.now() - this.#at >= SLOW_GPU_MS) {
      this.#at = this.now();
      this.#pending = this.fetch().then(
        (v) => void (this.#last = v),
        () => void (this.#last = null),
      ).finally(() => this.#pending = undefined);
    }
    return this.#last;
  }
}

/** The CPU's share from a cumulative tick counter. */
export class CpuReader implements Reader {
  #prev: CpuTicks | null = null;
  constructor(
    private readonly ticks: () => Promise<CpuTicks | null> | CpuTicks | null,
    private readonly wrap?: number,
  ) {}
  async read(): Promise<number | null> {
    const next = await this.ticks();
    if (!next) return null;
    const prev = this.#prev;
    this.#prev = next;
    return prev ? cpuPercent(prev, next, this.wrap) : null;
  }
}

/** The three readers of a platform. */
export interface Readers {
  cpu: Reader;
  gpu: Reader;
  mem: Reader;
}

/** The sampler: one reading of each figure, timed, at most once a {@linkcode MIN_GAP_MS}. */
export class SysSampler {
  #last: SysSample | undefined;
  #reading: Promise<SysSample> | undefined;
  constructor(
    private readonly readers: Readers,
    private readonly now: () => number = Date.now,
  ) {}

  sample(): Promise<SysSample> {
    const last = this.#last;
    if (last && this.now() - last.at < MIN_GAP_MS) return Promise.resolve(last);
    this.#reading ??= this.#read().finally(() => this.#reading = undefined);
    return this.#reading;
  }

  async #read(): Promise<SysSample> {
    const t0 = performance.now();
    const safe = async (r: Reader) => {
      try {
        return await r.read();
      } catch {
        return null;
      }
    };
    const cpu = await safe(this.readers.cpu);
    const gpu = await safe(this.readers.gpu);
    const mem = await safe(this.readers.mem);
    const costMs = Math.round((performance.now() - t0) * 1000) / 1000;
    this.#last = { cpu, gpu, mem, at: this.now(), costMs };
    return this.#last;
  }

  close(): void {
    for (const r of Object.values(this.readers)) r.close?.();
  }
}

// --- macOS: Mach and IOKit through FFI -------------------------------------------------------

const HOST_CPU_LOAD_INFO = 3;
const CPU_STATE_MAX = 4;
const KERN_SUCCESS = 0;
const kCFStringEncodingUTF8 = 0x08000100;
const kCFNumberSInt64Type = 4n;

const cstr = (s: string) => new TextEncoder().encode(`${s}\0`);

function openLibSystem() {
  return Deno.dlopen("/usr/lib/libSystem.B.dylib", {
    mach_host_self: { parameters: [], result: "u32" },
    host_statistics: {
      parameters: ["u32", "i32", "buffer", "buffer"],
      result: "i32",
    },
    sysctlbyname: {
      parameters: ["buffer", "buffer", "buffer", "pointer", "usize"],
      result: "i32",
    },
  });
}

/** Mach's CPU tick counters and the memory status level, through libSystem. */
export class MachHost {
  #lib = openLibSystem();
  // One send right for the process's life (each `mach_host_self` call adds a reference).
  #host = this.#lib.symbols.mach_host_self();
  #load = new Uint32Array(CPU_STATE_MAX);
  #count = new Uint32Array(1);
  #level = new Int32Array(1);
  #levelSize = new BigUint64Array(1);
  #levelName = cstr("kern.memorystatus_level");

  /**
   * `host_statistics(HOST_CPU_LOAD_INFO)`: the user, system, idle and nice ticks. The kernel
   * folds the CPUs' ticks into these in bursts (up to about a second apart), so two readings
   * close together may be equal (a `null` share, which the moving average skips).
   */
  ticks(): CpuTicks | null {
    this.#count[0] = CPU_STATE_MAX;
    const kr = this.#lib.symbols.host_statistics(
      this.#host,
      HOST_CPU_LOAD_INFO,
      this.#load,
      this.#count,
    );
    return kr === KERN_SUCCESS ? machTicks(this.#load) : null;
  }

  /** Memory pressure: 100 − `kern.memorystatus_level` (the share of memory still available). */
  memPressure(): number | null {
    this.#levelSize[0] = 4n;
    const rc = this.#lib.symbols.sysctlbyname(
      this.#levelName,
      this.#level,
      this.#levelSize,
      null,
      0n,
    );
    if (rc !== 0) return null;
    const level = this.#level[0];
    return level >= 0 && level <= 100 ? 100 - level : null;
  }

  close(): void {
    this.#lib.close();
  }
}

function openIoKit() {
  return Deno.dlopen(
    "/System/Library/Frameworks/IOKit.framework/IOKit",
    {
      IOServiceMatching: { parameters: ["buffer"], result: "pointer" },
      IOServiceGetMatchingServices: {
        parameters: ["u32", "pointer", "buffer"],
        result: "i32",
      },
      IOIteratorNext: { parameters: ["u32"], result: "u32" },
      IOObjectRelease: { parameters: ["u32"], result: "i32" },
      IORegistryEntryCreateCFProperty: {
        parameters: ["u32", "pointer", "pointer", "u32"],
        result: "pointer",
      },
    },
  );
}

function openCoreFoundation() {
  return Deno.dlopen(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    {
      CFStringCreateWithCString: {
        parameters: ["pointer", "buffer", "u32"],
        result: "pointer",
      },
      CFDictionaryGetValue: {
        parameters: ["pointer", "pointer"],
        result: "pointer",
      },
      CFNumberGetValue: {
        parameters: ["pointer", "isize", "buffer"],
        result: "u8",
      },
      CFGetTypeID: { parameters: ["pointer"], result: "usize" },
      CFNumberGetTypeID: { parameters: [], result: "usize" },
      CFDictionaryGetTypeID: { parameters: [], result: "usize" },
      CFRelease: { parameters: ["pointer"], result: "void" },
    },
  );
}

/**
 * The busiest GPU's utilisation from IOKit: each `IOAccelerator` service's
 * `PerformanceStatistics` dictionary, read as a CF property (a small dictionary copy, released at
 * once). The services are found once and kept; looked for again when none can be read.
 */
export class IoKitGpu implements Reader {
  #io = openIoKit();
  #cf = openCoreFoundation();
  #services: number[] = [];
  #foundAt = -Infinity;
  #statsKey: Deno.PointerValue;
  #keys: Deno.PointerValue[];
  #numberType: number | bigint;
  #dictType: number | bigint;
  #out = new BigInt64Array(1);
  #iter = new Uint32Array(1);

  constructor() {
    this.#statsKey = this.#cfString("PerformanceStatistics");
    this.#keys = GPU_UTILISATION_KEYS.map((k) => this.#cfString(k));
    this.#numberType = this.#cf.symbols.CFNumberGetTypeID();
    this.#dictType = this.#cf.symbols.CFDictionaryGetTypeID();
  }

  #cfString(s: string): Deno.PointerValue {
    return this.#cf.symbols.CFStringCreateWithCString(
      null,
      cstr(s),
      kCFStringEncodingUTF8,
    );
  }

  #find(): void {
    this.#release();
    this.#foundAt = Date.now();
    // Consumes the matching dictionary.
    const matching = this.#io.symbols.IOServiceMatching(cstr("IOAccelerator"));
    if (!matching) return;
    if (
      this.#io.symbols.IOServiceGetMatchingServices(0, matching, this.#iter) !==
        KERN_SUCCESS
    ) return;
    const iter = this.#iter[0];
    for (
      let s = this.#io.symbols.IOIteratorNext(iter);
      s;
      s = this.#io.symbols.IOIteratorNext(iter)
    ) {
      this.#services.push(s);
    }
    this.#io.symbols.IOObjectRelease(iter);
  }

  /** One service's figure, or `null`. */
  #readService(service: number): number | null {
    const cf = this.#cf.symbols;
    const stats = this.#io.symbols.IORegistryEntryCreateCFProperty(
      service,
      this.#statsKey,
      null,
      0,
    );
    if (!stats) return null;
    try {
      if (cf.CFGetTypeID(stats) !== this.#dictType) return null;
      for (const key of this.#keys) {
        const value = cf.CFDictionaryGetValue(stats, key);
        if (!value || cf.CFGetTypeID(value) !== this.#numberType) continue;
        if (!cf.CFNumberGetValue(value, kCFNumberSInt64Type, this.#out)) {
          continue;
        }
        const n = Number(this.#out[0]);
        return n >= 0 && n <= 100 ? n : null;
      }
      return null;
    } finally {
      cf.CFRelease(stats);
    }
  }

  read(): number | null {
    if (
      this.#services.length === 0 && Date.now() - this.#foundAt >= GPU_RETRY_MS
    ) {
      this.#find();
    }
    let best: number | null = null;
    for (const s of this.#services) {
      const v = this.#readService(s);
      if (v !== null) best = Math.max(best ?? 0, v);
    }
    // None readable (a GPU switch, a driver restart): look again next time, at most once a minute.
    if (best === null && this.#services.length > 0) this.#release();
    return best;
  }

  #release(): void {
    for (const s of this.#services) this.#io.symbols.IOObjectRelease(s);
    this.#services = [];
  }

  close(): void {
    this.#release();
    for (const k of [this.#statsKey, ...this.#keys]) {
      if (k) this.#cf.symbols.CFRelease(k);
    }
    this.#io.close();
    this.#cf.close();
  }
}

/** A reader that tries `first`, and on its first failure switches to `fallback` for good. */
function withFallback(first: () => Reader, fallback: () => Reader): Reader {
  try {
    return first();
  } catch {
    return fallback();
  }
}

/** A program's output through a hidden PTY (`null` when it is missing or fails). */
function runOutput(
  runner: () => CommandRunner,
  program: string,
  args: string[],
): () => Promise<string | null> {
  let path: Promise<string | undefined> | undefined;
  return async () => {
    path ??= resolveProgram(program);
    const p = await path;
    if (!p) return null;
    const r = await runner().run(p, args, { timeoutMs: RUN_TIMEOUT_MS });
    return r.code === 0 ? r.out : null;
  };
}

/** The macOS readers. */
export function macReaders(runner: () => CommandRunner): Readers {
  const host = new MachHost();
  const ioreg = runOutput(runner, "/usr/sbin/ioreg", [
    "-r",
    "-c",
    "IOAccelerator",
    "-d",
    "1",
  ]);
  return {
    cpu: new CpuReader(() => host.ticks(), MACH_WRAP),
    gpu: withFallback(
      () => new IoKitGpu(),
      () =>
        new SlowReader(async () => {
          const out = await ioreg();
          return out === null ? null : parseIoregGpu(out);
        }),
    ),
    mem: { read: () => host.memPressure(), close: () => host.close() },
  };
}

// --- Linux: /proc and sysfs -------------------------------------------------------------------

async function readText(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

/** AMD GPUs' `gpu_busy_percent` files (found once). */
async function amdBusyFiles(): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir("/sys/class/drm")) {
      if (!/^card\d+$/.test(e.name)) continue;
      const path = `/sys/class/drm/${e.name}/device/gpu_busy_percent`;
      if (await readText(path) !== null) out.push(path);
    }
  } catch { /* no DRM */ }
  return out;
}

/** The Linux readers. */
export function linuxReaders(runner: () => CommandRunner): Readers {
  let amd: Promise<string[]> | undefined;
  const nvidia = runOutput(runner, "nvidia-smi", [
    "--query-gpu=utilization.gpu",
    "--format=csv,noheader,nounits",
  ]);
  const slowNvidia = new SlowReader(async () => {
    const out = await nvidia();
    return out === null ? null : parseNvidiaSmi(out);
  });
  return {
    cpu: new CpuReader(async () => {
      const text = await readText("/proc/stat");
      return text === null ? null : parseProcStat(text);
    }),
    gpu: {
      async read() {
        amd ??= amdBusyFiles();
        let best: number | null = null;
        for (const path of await amd) {
          const text = await readText(path);
          const v = text === null ? null : parseBusyPercent(text);
          if (v !== null) best = Math.max(best ?? 0, v);
        }
        return best ?? slowNvidia.read();
      },
    },
    mem: {
      async read() {
        const text = await readText("/proc/meminfo");
        return text === null ? null : parseMeminfo(text);
      },
    },
  };
}

const NONE: Reader = { read: () => null };

/** The readers for this platform. */
export function platformReaders(runner: () => CommandRunner): Readers {
  if (Deno.build.os === "darwin") return macReaders(runner);
  if (Deno.build.os === "linux") return linuxReaders(runner);
  return { cpu: NONE, gpu: NONE, mem: NONE };
}

// --- the extension ----------------------------------------------------------------------------

let sampler: SysSampler | undefined;
let makeSampler: (() => SysSampler) | undefined;

export default defineDesktopExtension({
  name: "sysstats",
  setup: (host) => {
    let runner: CommandRunner | undefined;
    // Nothing is opened until the page first asks (the meter and the hot face can both be off).
    makeSampler = () =>
      new SysSampler(
        platformReaders(() =>
          runner ??= new PtyRunner(host.appSupportDir || undefined)
        ),
      );
  },
  methods: {
    /** One reading: CPU since the previous one, GPU, memory pressure (%), and its own cost. */
    sample: {
      input: emptyInput,
      handler: (): Promise<SysSample> => {
        if (!makeSampler) {
          throw new Error("the system monitor is not available");
        }
        sampler ??= makeSampler();
        return sampler.sample();
      },
    },
  },
});
