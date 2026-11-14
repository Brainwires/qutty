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

// The demo shell's other tile signals (lib/workspace/activity.ts), so the e2e suite can drive
// every activity state and the program title:
//
//   bell [seconds]          ring the bell (BEL), now or after a delay (to look elsewhere first)
//   later <seconds> <text…> print text after a delay, as a background job would (plain output)
//   title [-0] [text…]      set the window title with OSC 2 (`-0`: OSC 0); no text clears it

/** The longest a demo `bell` or `later` waits, ms. */
const MAX_DELAY_MS = 60_000;

/** A delay in seconds → ms (capped); `null` when it is not one. */
function delayMs(secs: string): number | null {
  const s = Number(secs);
  return secs.trim() !== "" && Number.isFinite(s) && s >= 0
    ? Math.min(MAX_DELAY_MS, Math.round(s * 1000))
    : null;
}

/** `bell [seconds]`'s delay (ms); `null` when malformed. */
export function demoBellDelay(args: readonly string[]): number | null {
  if (args.length === 0) return 0;
  return args.length === 1 ? delayMs(args[0]) : null;
}

/** `later <seconds> <text…>`: when and what to print; `null` when malformed. */
export function demoLater(
  args: readonly string[],
): { ms: number; text: string } | null {
  const [secs, ...words] = args;
  const ms = secs === undefined ? null : delayMs(secs);
  const text = words.join(" ");
  return ms === null || !text ? null : { ms, text };
}

/** `title [-0] [text…]`: the OSC 0 / 2 sequence that sets (or, with no text, clears) the title. */
export function demoTitle(args: readonly string[]): string {
  const osc0 = args[0] === "-0";
  const text = (osc0 ? args.slice(1) : args).join(" ");
  return `\x1b]${osc0 ? 0 : 2};${text}\x07`;
}
