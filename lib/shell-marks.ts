/**
 * Shell integration marks (OSC 133, the FinalTerm / iTerm2 / VS Code / kitty prompt marks): a
 * shell tells the terminal where its prompt starts (`A`), where the command line starts (`B`),
 * that a command runs (`C`) and that it ended with an exit status (`D;<exit>`). Qutty's shell
 * plugin (resources/shell/qutty.zsh, qutty.bash; Settings → Agent integration) sends them, and so
 * does any other shell integration that speaks OSC 133. From them the terminal knows each
 * command's line, how long it ran and how it ended, which Loopy reacts to
 * (lib/companion/reactions.ts).
 *
 * The parameters after the mark are `key=value` pairs; the command line comes as kitty's
 * `cmdline_url=<percent-encoded>` (or `cmdline=<text>`) on `C`, or on `D` where the shell only
 * learns it afterwards (bash). `D` may also carry `duration=<seconds>` (Qutty's: bash has no hook
 * before a command runs, so it measures the time itself from the history entry's timestamp).
 *
 * The terminal wires {@linkcode parseOsc133} to xterm's `registerOscHandler(133, ...)`, which
 * hands it the text after `133;`, and folds each mark into a {@linkcode MarkState} with
 * {@linkcode stepMarks}.
 *
 * Client-safe and pure.
 *
 * @module
 */

/** One OSC 133 mark. */
export type ShellMark =
  | { readonly kind: "prompt" }
  | { readonly kind: "input" }
  | { readonly kind: "run"; readonly command?: string }
  | {
    readonly kind: "done";
    /** The exit status; `null` when the shell sent none (`133;D` alone). */
    readonly exitCode: number | null;
    readonly command?: string;
    /** How long it ran, ms, when the shell measured it. */
    readonly durationMs?: number;
  };

/** The longest command line kept. */
const MAX_COMMAND = 400;

/** `key=value` parameters after the mark (and bare values, for `D`'s exit status). */
function params(parts: readonly string[]): {
  values: string[];
  named: Map<string, string>;
} {
  const values: string[] = [];
  const named = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq > 0) named.set(part.slice(0, eq), part.slice(eq + 1));
    else values.push(part);
  }
  return { values, named };
}

/** The command line in the parameters, decoded, one line, at most {@linkcode MAX_COMMAND}. */
function commandOf(named: Map<string, string>): string | undefined {
  let text = named.get("cmdline");
  const url = named.get("cmdline_url");
  if (url !== undefined) {
    try {
      text = decodeURIComponent(url);
    } catch {
      text = url;
    }
  }
  if (text === undefined) return undefined;
  // deno-lint-ignore no-control-regex
  const line = text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return line ? line.slice(0, MAX_COMMAND) : undefined;
}

/**
 * Parse the payload of an OSC 133 sequence (the text after `133;`): `A`, `B`, `C[;cmdline…]`,
 * `D[;exit][;cmdline…][;duration=s]`. `undefined` for anything else.
 */
export function parseOsc133(data: string): ShellMark | undefined {
  const [mark, ...rest] = data.split(";");
  const { values, named } = params(rest);
  const command = commandOf(named);
  const withCommand = command === undefined ? {} : { command };
  switch (mark) {
    case "A":
      return { kind: "prompt" };
    case "B":
      return { kind: "input" };
    case "C":
      return { kind: "run", ...withCommand };
    case "D": {
      const raw = values[0];
      const exit = raw !== undefined && /^-?\d{1,6}$/.test(raw.trim())
        ? Number(raw.trim())
        : null;
      const secs = Number(named.get("duration"));
      const duration = named.has("duration") && Number.isFinite(secs) &&
          secs >= 0
        ? { durationMs: Math.round(secs * 1000) }
        : {};
      return { kind: "done", exitCode: exit, ...withCommand, ...duration };
    }
    default:
      return undefined;
  }
}

/** A command the shell reported finished. */
export interface CommandDone {
  /** Its command line, when the shell sent it. */
  readonly command?: string;
  /** Its exit status (`null`: not sent). */
  readonly exitCode: number | null;
  /** How long it ran, ms (`null`: unknown, no start was seen and the shell sent none). */
  readonly durationMs: number | null;
  /** When it ended (ms). */
  readonly at: number;
}

/** What the marks remember between two of them: the command running, if any. */
export interface MarkState {
  readonly running:
    | { readonly since: number; readonly command?: string }
    | null;
}

export const NO_MARKS: MarkState = { running: null };

/**
 * Fold `mark` (arrived at `now`, ms) into `state`: a `C` starts a command, the next `D` ends it
 * (`done`). A `D` without a `C` before it (the first prompt, or an empty line: a shell may send
 * one anyway) is a command only when it says what ran.
 */
export function stepMarks(
  state: MarkState,
  mark: ShellMark,
  now: number,
): { state: MarkState; done?: CommandDone } {
  switch (mark.kind) {
    case "run":
      return {
        state: {
          running: {
            since: now,
            ...(mark.command === undefined ? {} : { command: mark.command }),
          },
        },
      };
    case "done": {
      const run = state.running;
      const command = mark.command ?? run?.command;
      if (!run && command === undefined) return { state: NO_MARKS };
      const durationMs = mark.durationMs ??
        (run ? Math.max(0, now - run.since) : null);
      return {
        state: NO_MARKS,
        done: {
          ...(command === undefined ? {} : { command }),
          exitCode: mark.exitCode,
          durationMs,
          at: now,
        },
      };
    }
    // A new prompt with a command still marked running: the shell lost the `D` (Ctrl-C in some
    // setups); forget it rather than time the next one from it.
    case "prompt":
      return { state: state.running ? NO_MARKS : state };
    case "input":
      return { state };
  }
}
