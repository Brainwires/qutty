// Shell integration marks (OSC 133, lib/shell-marks.ts): parsing the marks, timing a command from
// its start mark to its end mark, and what Qutty's own shell plugins (resources/shell/qutty.zsh,
// qutty.bash) actually print, run in a real zsh and bash where they are installed.

import { assert, assertEquals } from "@std/assert";
import {
  type MarkState,
  NO_MARKS,
  parseOsc133,
  type ShellMark,
  stepMarks,
} from "../lib/shell-marks.ts";

Deno.test("parseOsc133: the four marks and their parameters", () => {
  assertEquals(parseOsc133("A"), { kind: "prompt" });
  assertEquals(parseOsc133("B"), { kind: "input" });
  assertEquals(parseOsc133("C"), { kind: "run" });
  assertEquals(parseOsc133("C;cmdline_url=make%20test%3B%20echo%20100%25"), {
    kind: "run",
    command: "make test; echo 100%",
  });
  assertEquals(parseOsc133("C;cmdline=cargo build"), {
    kind: "run",
    command: "cargo build",
  });
  assertEquals(parseOsc133("D;0"), { kind: "done", exitCode: 0 });
  assertEquals(parseOsc133("D;2"), { kind: "done", exitCode: 2 });
  assertEquals(parseOsc133("D"), { kind: "done", exitCode: null });
  assertEquals(parseOsc133("D;oops"), { kind: "done", exitCode: null });
  assertEquals(
    parseOsc133("D;1;cmdline_url=npm%20test;duration=42"),
    { kind: "done", exitCode: 1, command: "npm test", durationMs: 42_000 },
  );
  // iTerm2's / VS Code's extra parameters are ignored.
  assertEquals(parseOsc133("A;cl=m;aid=123"), { kind: "prompt" });
  assertEquals(parseOsc133("D;0;aid=123"), { kind: "done", exitCode: 0 });
  // Not marks.
  assertEquals(parseOsc133("Z"), undefined);
  assertEquals(parseOsc133(""), undefined);
});

Deno.test("parseOsc133: a command line is one clean, bounded line", () => {
  const run = parseOsc133("C;cmdline_url=echo%0Ahi%1B%5B31m") as {
    command?: string;
  };
  assertEquals(run.command, "echo hi [31m");
  // A malformed escape keeps the text as sent.
  assertEquals(
    (parseOsc133("C;cmdline_url=50%ZZ") as { command?: string }).command,
    "50%ZZ",
  );
  const long = parseOsc133(`C;cmdline=${"x".repeat(1000)}`) as {
    command?: string;
  };
  assertEquals(long.command?.length, 400);
  assertEquals(parseOsc133("C;cmdline=   "), { kind: "run" });
  // A negative or absurd duration is left out.
  assertEquals(parseOsc133("D;0;duration=-3"), { kind: "done", exitCode: 0 });
});

/** Fold `marks` (each at its time) and collect what finished. */
function fold(marks: [ShellMark, number][]) {
  let state: MarkState = NO_MARKS;
  const done = [];
  for (const [mark, at] of marks) {
    const step = stepMarks(state, mark, at);
    state = step.state;
    if (step.done) done.push(step.done);
  }
  return { state, done };
}

Deno.test("stepMarks: C → D is one command, timed by the terminal", () => {
  const { state, done } = fold([
    [{ kind: "prompt" }, 0],
    [{ kind: "run", command: "make" }, 1_000],
    [{ kind: "done", exitCode: 2 }, 31_000],
    [{ kind: "prompt" }, 31_001],
  ]);
  assertEquals(done, [{
    command: "make",
    exitCode: 2,
    durationMs: 30_000,
    at: 31_000,
  }]);
  assertEquals(state, NO_MARKS);
});

Deno.test("stepMarks: a D alone counts only when it says what ran (bash)", () => {
  // The first prompt, an empty line: nothing ran.
  assertEquals(fold([[{ kind: "done", exitCode: 0 }, 5]]).done, []);
  // bash sends the line and the duration with D.
  assertEquals(
    fold([[{
      kind: "done",
      exitCode: 0,
      command: "cargo test",
      durationMs: 25_000,
    }, 9]]).done,
    [{ command: "cargo test", exitCode: 0, durationMs: 25_000, at: 9 }],
  );
  // A D with a line but no timing: the duration is unknown.
  assertEquals(
    fold([[{ kind: "done", exitCode: 0, command: "ls" }, 9]]).done[0]
      .durationMs,
    null,
  );
});

Deno.test("stepMarks: a lost D (a new prompt) forgets the running command", () => {
  const { done } = fold([
    [{ kind: "run", command: "sleep 100" }, 0],
    [{ kind: "prompt" }, 100_000],
    [{ kind: "done", exitCode: 0 }, 200_000],
  ]);
  assertEquals(done, []);
  // B changes nothing.
  assertEquals(
    stepMarks({ running: { since: 1 } }, { kind: "input" }, 2).state,
    { running: { since: 1 } },
  );
});

// --- the plugins, in a real shell -------------------------------------------------------------

const ROOT = new URL("../", import.meta.url);

/** Whether `shell` can be run here. */
async function have(shell: string): Promise<boolean> {
  try {
    const out = await new Deno.Command(shell, {
      args: ["-c", "exit 0"],
      stdout: "null",
      stderr: "null",
    }).output();
    return out.success;
  } catch {
    return false;
  }
}

/** Run `script` in an interactive `shell` with the plugin loaded (a fake Qutty tile). */
async function runShell(
  shell: "zsh" | "bash",
  script: string,
  env: Record<string, string> = {},
): Promise<string> {
  const plugin = new URL(`resources/shell/qutty.${shell}`, ROOT).pathname;
  const args = shell === "zsh"
    ? ["-f", "-i", "-c", `source ${plugin}\n${script}`]
    : ["--norc", "--noprofile", "-i", "-c", `source ${plugin}\n${script}`];
  const out = await new Deno.Command(shell, {
    args,
    env: {
      QUTTY_SOCK: "/nonexistent/qutty.sock",
      QUTTY_AGENT_NOTIFY_EVERY: "off",
      QUTTY_AGENT_BIN: "/usr/bin/false",
      HOME: Deno.makeTempDirSync(),
      ...env,
    },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout);
}

/** The OSC 133 payloads in `text`, in order. */
function marksIn(text: string): string[] {
  // deno-lint-ignore no-control-regex
  return [...text.matchAll(/\x1b\]133;([^\x07]*)\x07/g)].map((m) => m[1]);
}

Deno.test({
  name:
    "qutty.zsh: C with the line before a command, D with its exit and A after",
  ignore: !(await have("zsh")),
  async fn() {
    const out = await runShell(
      "zsh",
      '__qutty_preexec "make test; echo 100%"\n(exit 3)\n__qutty_precmd\n__qutty_precmd',
    );
    const marks = marksIn(out);
    assertEquals(marks, [
      "C;cmdline_url=make test%3B echo 100%25",
      "D;3",
      "A",
      "A",
    ]);
    const parsed = parseOsc133(marks[0]);
    assertEquals(parsed, { kind: "run", command: "make test; echo 100%" });
    // Off: no marks at all.
    const off = await runShell(
      "zsh",
      '__qutty_preexec "make"\n__qutty_precmd',
      { QUTTY_SHELL_MARKS: "off" },
    );
    assertEquals(marksIn(off), []);
  },
});

Deno.test({
  name: "qutty.bash: D with the exit, the line and the duration, then A",
  ignore: !(await have("bash")),
  async fn() {
    // The first prompt sees the history file's entry (none here) and reports nothing; a command
    // added to the history after it is reported with its exit status (`history -s` on the same
    // line replaces that line's own entry, as if the command had been typed).
    const out = await runShell(
      "bash",
      [
        "set -o history",
        "__qutty_precmd",
        'history -s "cargo test; echo 50%"; (exit 2); __qutty_precmd',
      ].join("\n"),
    );
    const marks = marksIn(out);
    assertEquals(marks[0], "A");
    const done = parseOsc133(marks[1]);
    assert(done?.kind === "done", marks[1]);
    assertEquals(done.exitCode, 2);
    assertEquals(done.command, "cargo test; echo 50%");
    assert(
      done.durationMs !== undefined && done.durationMs >= 0 &&
        done.durationMs < 60_000,
      String(done.durationMs),
    );
    assertEquals(marks[2], "A");
    assertEquals(marks.length, 3);
  },
});
