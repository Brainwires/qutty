// The demo shell's side of the shell integration marks (lib/shell-marks.ts): the demo backend's
// shell (lib/pty-client.ts `DemoShell`) sends OSC 133 marks like Qutty's zsh plugin does (`A` at
// each prompt, `C` with the line when a command starts, `D;<exit>` when it ends), and its `job`
// command stands in for a long build or test run, so the e2e suite can make Loopy celebrate or
// look sad:
//
//   job <seconds> <exit> <command…>     e.g. `job 1.5 2 make all`
//
// runs "make all" for 1.5 s and ends it with exit status 2.
//
// Client-safe and pure.

/** An OSC 133 mark (`A`, `C;cmdline_url=…`, `D;2`). */
export function osc133(payload: string): string {
  return `\x1b]133;${payload}\x07`;
}

/** The `C` mark for a command line. */
export function runMark(command: string): string {
  return osc133(`C;cmdline_url=${encodeURIComponent(command)}`);
}

/** A demo `job`: what it pretends to run, for how long, and how it ends. */
export interface DemoJob {
  readonly command: string;
  readonly ms: number;
  readonly exitCode: number;
}

/** The longest a demo job may run, ms. */
const MAX_JOB_MS = 120_000;

/** `job <seconds> <exit> <command…>` (the words after `job`); `null` when malformed. */
export function demoJob(args: readonly string[]): DemoJob | null {
  const [secs, exit, ...words] = args;
  const s = Number(secs);
  const code = Number(exit);
  if (
    !Number.isFinite(s) || s < 0 || !Number.isInteger(code) || code < 0 ||
    code > 255
  ) {
    return null;
  }
  const command = words.join(" ").trim();
  if (!command) return null;
  return {
    command,
    ms: Math.min(MAX_JOB_MS, Math.round(s * 1000)),
    exitCode: code,
  };
}

/** The line the demo shell marks as run: a `job`'s pretend command, else the line itself. */
export function markedCommand(line: string): string {
  const [cmd, ...args] = line.trim().split(/\s+/);
  return (cmd === "job" ? demoJob(args)?.command : undefined) ?? line.trim();
}
