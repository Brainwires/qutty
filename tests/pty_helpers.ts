// Shared helpers for the real-shell PTY tests (not a test module itself).

import {
  type PtyDataEvent,
  type PtyExitEvent,
  PtyHost,
} from "../desktop/pty.ts";

/** Whether `path` is an executable file on this machine. */
function hasShell(path: string): boolean {
  try {
    const st = Deno.statSync(path);
    return st.isFile && ((st.mode ?? 0o755) & 0o111) !== 0;
  } catch {
    return false;
  }
}

export const HAS_SH = hasShell("/bin/sh");
export const HAS_ZSH = hasShell("/bin/zsh");
export const POSIX = Deno.build.os !== "windows";

/** Collects one host's events (in arrival order) and waits for conditions on them. */
export class Recorder {
  data = new Map<string, PtyDataEvent[]>();
  exits = new Map<string, PtyExitEvent>();
  /** Every event, in order: `data:<id>` / `exit:<id>`. */
  log: string[] = [];
  #text = new Map<string, string>();

  emit = (event: "data" | "exit", payload: PtyDataEvent | PtyExitEvent) => {
    this.log.push(`${event}:${payload.id}`);
    if (event === "data") {
      const d = payload as PtyDataEvent;
      const list = this.data.get(d.id) ?? [];
      list.push(d);
      this.data.set(d.id, list);
      this.#text.set(d.id, (this.#text.get(d.id) ?? "") + d.data);
    } else {
      this.exits.set(payload.id, payload as PtyExitEvent);
    }
  };

  text(id: string): string {
    return this.#text.get(id) ?? "";
  }

  /** Poll `cond` every 10 ms until it holds, or throw after `ms`. */
  async until(what: string, cond: () => boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${ms} ms waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Wait until `id`'s output contains `needle` (after `from` chars, if given). */
  async waitFor(
    id: string,
    needle: string,
    ms = 15_000,
    from = 0,
  ): Promise<void> {
    await this.until(
      `${JSON.stringify(needle)} from ${id} (tail: ${
        JSON.stringify(this.text(id).slice(-200))
      })`,
      () => this.text(id).indexOf(needle, from) >= 0,
      ms,
    );
  }

  async waitExit(id: string, ms = 15_000): Promise<PtyExitEvent> {
    await this.until(`exit of ${id}`, () => this.exits.has(id), ms);
    return this.exits.get(id)!;
  }
}

/**
 * A marker the shell prints but its own command echo never contains: `printf` assembles it from
 * two halves, so the typed line shows `<%s%s>` and only the output shows `<NAME>`.
 */
export function marker(name: string): { cmd: string; text: string } {
  const half = Math.ceil(name.length / 2);
  return {
    cmd: `printf '<%s%s>\\n' '${name.slice(0, half)}' '${name.slice(half)}'`,
    text: `<${name}>`,
  };
}

/** Output between two markers' texts (exclusive), from the last start marker. */
export function between(text: string, start: string, end: string): string {
  const s = text.lastIndexOf(start);
  if (s < 0) throw new Error(`no ${start}`);
  const from = s + start.length;
  const e = text.indexOf(end, from);
  if (e < 0) throw new Error(`no ${end}`);
  return text.slice(from, e);
}

/** A host plus recorder, disposed (every terminal killed and waited for) at the end. */
export async function withHost(
  fn: (host: PtyHost, rec: Recorder) => Promise<void>,
): Promise<void> {
  const rec = new Recorder();
  const host = new PtyHost(rec.emit);
  try {
    await fn(host, rec);
  } finally {
    await host.dispose(10_000);
  }
}

/**
 * Load node-pty, open libc and spawn-helper once, outside any test, so the resource sanitizer
 * does not see the process-lifetime handles (the FFI libraries, the napi addon) as leaks.
 */
export async function warmUp(): Promise<void> {
  if (!POSIX || !HAS_SH) return;
  await withHost(async (host, rec) => {
    const t = await host.spawn({
      cols: 80,
      rows: 24,
      shell: "/bin/sh",
      cwd: "/",
    });
    await host.info(t.id);
    host.resize(t.id, 81, 25);
    await host.write(t.id, "exit 0\r");
    await rec.waitExit(t.id);
  });
}

/** The open fds of this process (macOS / Linux). */
export function openFds(): number[] {
  const dir = Deno.build.os === "linux" ? "/proc/self/fd" : "/dev/fd";
  const fds: number[] = [];
  for (const e of Deno.readDirSync(dir)) fds.push(Number(e.name));
  return fds.sort((a, b) => a - b);
}

/** Run `fn` with `vars` set in Deno's environment (undefined = unset), then restore them. */
export async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
