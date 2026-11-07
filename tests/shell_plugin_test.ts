// The shell agent's plugins (resources/shell/qutty.{zsh,bash}) in a real zsh and bash, in a tile
// of a tapped PtyHost whose hub (desktop/hub.ts) has a fake model: typing `, list files` puts the
// model's command into the edit buffer without running it (Enter then runs it), the explanation
// prints above the prompt, the commands run since are the next request's context, and ordinary
// lines (`,foo` with no space, commands containing commas) run as always. qutty-agent goes
// through the real tile socket (`nc -U`).
//
// zsh tests are skipped where there is no zsh (Linux CI); bash is tested with whatever bash
// there is: bash 4+ puts the command into READLINE_LINE, macOS's bash 3.2 into the history
// (Up recalls it). Skipped where `nc` has no `-U`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { PtyHost, setPtyTaps } from "../desktop/pty.ts";
import type { ShellBrain } from "../lib/hub/shell-agent.ts";
import { HAS_ZSH, marker, Recorder } from "./pty_helpers.ts";
import { type Fixture, fixture, HAS_NC, tapHub } from "./socket_helpers.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
});

/** bash's major version (0: no bash). */
function bashMajor(): number {
  if (!BASH) return 0;
  const out = new Deno.Command(BASH, {
    args: ["-c", "echo ${BASH_VERSINFO[0]}"],
    stdout: "piped",
  }).outputSync();
  return Number(new TextDecoder().decode(out.stdout).trim()) || 0;
}
const BASH_MAJOR = bashMajor();

/** The fake model: always proposes `cmd`, and records every prompt. */
class ScriptedBrain implements ShellBrain {
  readonly label = "Scripted";
  prompts: string[] = [];
  constructor(public cmd: string) {}
  complete(_system: string, prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return Promise.resolve(
      `Prints a marker (fake model).\n\`\`\`sh\n${this.cmd}\n\`\`\``,
    );
  }
}

interface Shell {
  f: Fixture;
  rec: Recorder;
  host: PtyHost;
  id: string;
  brain: ScriptedBrain;
  /** Type `text` and wait until the output after it contains `needle`. */
  type(text: string, needle: string): Promise<void>;
  /** The output since `from`. */
  since(from: number): string;
}

/** A hub with a fake model, and a tile running `argv` (rc files in a temp folder). */
async function withShell(
  kind: "zsh" | "bash",
  fn: (s: Shell) => Promise<void>,
): Promise<void> {
  const ran = marker("RANOK");
  const brain = new ScriptedBrain(ran.cmd);
  const g = await fixture({
    shellBrains: {
      findClaude: () => Promise.resolve("/fake/claude"),
      ollamaModels: () => Promise.resolve(undefined),
      claude: () => brain,
      ollama: () => brain,
    },
  });
  const rc = await Deno.makeTempDir({ prefix: "qutty-rc-" });
  const rec = new Recorder();
  const host = new PtyHost(rec.emit, { tapped: true });
  tapHub(g.hub);
  try {
    const plugin = `${ROOT}resources/shell/qutty.${kind}`;
    let args: string[];
    if (kind === "zsh") {
      Deno.writeTextFileSync(
        `${rc}/.zshrc`,
        [
          `HISTFILE=${rc}/hist`,
          "unsetopt PROMPT_SP",
          "PROMPT='P> '",
          "RPROMPT=''",
          `source ${plugin}`,
        ].join("\n") + "\n",
      );
      args = [`ZDOTDIR=${rc}`, `HOME=${rc}`, "/bin/zsh", "-i"];
    } else {
      Deno.writeTextFileSync(
        `${rc}/.bashrc`,
        [
          `HISTFILE=${rc}/hist`,
          "PS1='P> '",
          "PROMPT_COMMAND=",
          `source ${plugin}`,
        ].join("\n") + "\n",
      );
      args = [
        `HOME=${rc}`,
        "BASH_SILENCE_DEPRECATION_WARNING=1",
        BASH!,
        "--noprofile",
        "--rcfile",
        `${rc}/.bashrc`,
        "-i",
      ];
    }
    const { id } = await host.spawn({
      cols: 120,
      rows: 30,
      program: "/usr/bin/env",
      args,
      cwd: rc,
    });
    await rec.waitFor(id, "P> ", 15_000);
    const s: Shell = {
      f: g,
      rec,
      host,
      id,
      brain,
      since: (from) => rec.text(id).slice(from),
      async type(text, needle) {
        const from = rec.text(id).length;
        await host.write(id, text);
        await rec.waitFor(id, needle, 15_000, from);
        // Then the next prompt, the way a person types: after the shell is back at it.
        const at = rec.text(id).indexOf(needle, from) + needle.length;
        await rec.waitFor(id, "P> ", 15_000, at);
        await new Promise((r) => setTimeout(r, 50));
      },
    };
    await fn(s);
  } finally {
    await host.dispose(10_000);
    setPtyTaps(undefined);
    await g.dispose();
    await Deno.remove(rc, { recursive: true }).catch(() => {});
  }
}

/** The marker's output (`<RANOK>`) appears how many times in `text`. */
const ranCount = (text: string) => text.split(marker("RANOK").text).length - 1;

/** The request lands in the buffer: the explanation shows, nothing runs; Enter then runs it. */
async function proposesWithoutRunning(
  s: Shell,
  recall: string,
): Promise<void> {
  const from = s.rec.text(s.id).length;
  await s.type(", list files\r", "Prints a marker (fake model).");
  // The proposal is drawn on the new prompt line: wait for it, give it a moment to (not) run.
  await s.rec.waitFor(
    s.id,
    recall === "" ? "'RAN' 'OK'" : "Up to edit",
    10_000,
    from,
  );
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(
    ranCount(s.since(from)),
    0,
    "the proposal must not run by itself",
  );
  assertEquals(s.brain.prompts.length, 1);
  assert(
    s.brain.prompts[0].endsWith("Request: list files"),
    s.brain.prompts[0],
  );
  const at = s.rec.text(s.id).length;
  await s.type(`${recall}\r`, marker("RANOK").text);
  assertEquals(ranCount(s.since(at)), 1, "Enter runs the proposal");
}

/** Ordinary lines are not requests: `,foo` (no space) and commas inside a command run as usual. */
async function ordinaryLinesRun(s: Shell): Promise<void> {
  const calls = s.brain.prompts.length;
  const commas = marker("A,B");
  await s.type(`${commas.cmd}\r`, commas.text);
  // Run as a command, not sent to the model: "command not found" (Ubuntu's handler words it
  // "Command ',nospace' not found"). Bash redraws the prompt before the line runs, so wait for
  // the error itself.
  await s.type(",nospace\r", "not found");
  const echo = marker("C,D, E");
  await s.type(`${echo.cmd}\r`, echo.text);
  assertEquals(s.brain.prompts.length, calls, "no request for ordinary lines");
}

const ignoreAll = !HAS_NC || Deno.build.os === "windows";

Deno.test({
  name:
    "zsh plugin: `, list files` puts the model's command in the buffer, never runs it; context; ordinary lines",
  ignore: ignoreAll || !HAS_ZSH,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withShell("zsh", async (s) => {
      await proposesWithoutRunning(s, "");
      // The request is in the history: it was not run, the proposal was.
      // `, next`: the command just run is the next request's context, with its exit status.
      await s.type(", next\r", "Prints a marker (fake model).");
      const prompt = s.brain.prompts[1];
      assertStringIncludes(prompt, "[exit 0]");
      assertStringIncludes(prompt, "printf '<%s%s>\\n' 'RAN' 'OK'");
      assertStringIncludes(prompt, "You proposed: printf");
      assert(prompt.endsWith("Request: next"), prompt);
      await s.host.write(s.id, "\x15"); // ^U: drop the proposal
      await ordinaryLinesRun(s);
    });
  },
});

Deno.test({
  name:
    "bash plugin: `, list files` proposes without running (READLINE_LINE on bash 4+, the history on 3.2); ordinary lines",
  ignore: ignoreAll || !BASH,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await withShell("bash", async (s) => {
      if (BASH_MAJOR >= 4) {
        await proposesWithoutRunning(s, "");
      } else {
        await proposesWithoutRunning(s, "\x1b[A");
      }
      await s.type(", next\r", "Prints a marker (fake model).");
      const prompt = s.brain.prompts[1];
      assertStringIncludes(prompt, "[exit 0]");
      assertStringIncludes(prompt, "printf '<%s%s>\\n' 'RAN' 'OK'");
      await s.host.write(s.id, "\x15");
      await ordinaryLinesRun(s);
    });
  },
});
