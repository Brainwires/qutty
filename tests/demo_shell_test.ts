// The in-browser demo shell (`createDemoBackend` in lib/pty-client.ts): every command, line
// editing, control keys, `top`, and the backend's spawn/kill/info/exit plumbing. Fake time drives
// the shell's start-up timer, `top`'s 1 s ticker and `date`. Run: deno test -A tests/

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
// deno.json is not ours to edit (no "@std/testing" import), so the specifier is inline.
// deno-lint-ignore no-import-prefix
import { FakeTime } from "jsr:@std/testing@^1.0.0/time";
import {
  createDemoBackend,
  type PtyBackend,
  type PtyExit,
} from "../lib/pty-client.ts";

const ESC = "\x1b";
const PROMPT = "demo:~$ ";

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const plain = (s: string) => s.replace(ANSI, "");

/** Fake time pinned to a known instant (so `date` is checkable). */
const T0 = new Date("2026-11-03T12:34:56Z");

interface Session {
  be: PtyBackend;
  id: string;
  pid: number;
  time: FakeTime;
  /** Raw output since the last `take()`. */
  raw: () => string;
  /** Plain (ANSI-stripped) output since the last `take()`, and reset. */
  take: () => string;
  type: (s: string) => Promise<void>;
  exits: PtyExit[];
}

async function session(
  time: FakeTime,
  opts: { cols?: number; rows?: number; be?: PtyBackend } = {},
): Promise<Session> {
  const be = opts.be ?? createDemoBackend();
  const sp = await be.spawn({ cols: opts.cols ?? 80, rows: opts.rows ?? 24 });
  let out = "";
  be.onData(sp.id, (d) => out += d);
  const exits: PtyExit[] = [];
  be.onExit(sp.id, (e) => exits.push(e));
  await time.tickAsync(0); // the banner + prompt
  return {
    be,
    id: sp.id,
    pid: sp.pid,
    time,
    raw: () => out,
    take: () => {
      const s = plain(out);
      out = "";
      return s;
    },
    type: async (s) => {
      await be.write(sp.id, s);
      await time.tickAsync(0);
    },
    exits,
  };
}

/** Run one test body with fake time, restoring it afterwards. */
function withTime(fn: (time: FakeTime) => Promise<void>): () => Promise<void> {
  return async () => {
    const time = new FakeTime(T0);
    try {
      await fn(time);
    } finally {
      time.restore();
    }
  };
}

/** Type a command line and return its plain output, with the echo and next prompt peeled off. */
async function run(s: Session, cmd: string): Promise<string> {
  s.take();
  await s.type(`${cmd}\r`);
  const out = s.take();
  assert(
    out.startsWith(`${cmd}\r\n`),
    `echo of ${JSON.stringify(cmd)}: ${JSON.stringify(out)}`,
  );
  const body = out.slice(cmd.length + 2);
  assert(
    body.endsWith("$ "),
    `prompt after ${cmd}: ${JSON.stringify(out.slice(-40))}`,
  );
  return body.slice(0, body.lastIndexOf("demo:"));
}

// ---------------------------------------------------------------------------------------------
// Start-up and the backend surface
// ---------------------------------------------------------------------------------------------

Deno.test(
  "demo: banner and prompt arrive after spawn and are buffered for a late subscriber",
  withTime(async (time) => {
    const be = createDemoBackend();
    const sp = await be.spawn({ cols: 80, rows: 24 });
    assertMatch(sp.id, /^demo-\d+$/);
    assertEquals(sp.shell, "demo-sh");
    assertEquals(sp.cwd, "/Users/demo");
    await time.tickAsync(0);
    let out = "";
    be.onData(sp.id, (d) => out += d);
    const p = plain(out);
    assert(p.startsWith("Qutty demo backend"), p);
    assert(p.includes("Type help for commands.\r\n\r\n"));
    assert(p.endsWith(PROMPT));
    await be.kill(sp.id);
  }),
);

Deno.test(
  "demo: spawn options, pids, info, and isolated sessions",
  withTime(async (time) => {
    const be = createDemoBackend();
    const a = await be.spawn({
      cols: 80,
      rows: 24,
      shell: "/bin/zsh",
      cwd: "/tmp",
    });
    const b = await be.spawn({ cols: 80, rows: 24 });
    assertEquals([a.shell, a.cwd], ["/bin/zsh", "/tmp"]);
    assertEquals(b.pid, a.pid + 1);
    assert(a.id !== b.id);
    assertEquals(await be.info(a.id), {
      id: a.id,
      pid: a.pid,
      process: "demo-sh",
      cwd: "/Users/demo",
    });
    assertEquals((await be.info(b.id)).pid, b.pid);
    const sa = await session(time, { be });
    const sb = await session(time, { be });
    sa.take();
    sb.take();
    await sa.type("echo only-a\r");
    assert(sa.take().includes("only-a"));
    assertEquals(sb.take(), "", "no cross-talk");
    for (const id of [a.id, b.id, sa.id, sb.id]) await be.kill(id);
  }),
);

Deno.test(
  "demo: kill ends the session with SIGHUP; unknown ids",
  withTime(async (time) => {
    const s = await session(time);
    await s.be.kill(s.id);
    await time.tickAsync(0);
    assertEquals(s.exits, [{ exitCode: 0, signal: 1 }]);
    await s.be.kill(s.id); // already gone: a no-op
    await s.be.kill("demo-999");
    await assertRejects(() => s.be.write(s.id, "x"), Error, "no such terminal");
    await assertRejects(
      () => s.be.resize(s.id, 1, 1),
      Error,
      "no such terminal",
    );
    await assertRejects(() => s.be.info("nope"), Error, "no such terminal");
    // A late onExit still learns how it ended.
    const late: PtyExit[] = [];
    s.be.onExit(s.id, (e) => late.push(e));
    await time.tickAsync(0);
    assertEquals(late, [{ exitCode: 0, signal: 1 }]);
  }),
);

Deno.test(
  "demo: a session killed before it starts prints nothing",
  withTime(async (time) => {
    const be = createDemoBackend();
    const sp = await be.spawn({ cols: 80, rows: 24 });
    const exits: PtyExit[] = [];
    be.onExit(sp.id, (e) => exits.push(e));
    await be.kill(sp.id);
    await time.tickAsync(0);
    let out = "";
    be.onData(sp.id, (d) => out += d);
    assertEquals(out, "", "no banner after the exit");
    assertEquals(exits, [{ exitCode: 0, signal: 1 }]);
  }),
);

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

Deno.test(
  "demo: help lists every command",
  withTime(async (time) => {
    const s = await session(time);
    const out = await run(s, "help");
    for (
      const c of [
        "help",
        "ls",
        "date",
        "echo",
        "clear",
        "top",
        "colors",
        "stress",
        "size",
        "pwd",
        "cd",
        "whoami",
        "exit",
      ]
    ) {
      assert(new RegExp(`\\b${c}\\b`).test(out), `help mentions ${c}`);
    }
    assert(out.startsWith("Qutty demo shell"));
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: ls, whoami, echo, unknown command, empty line",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    await s.type("ls\r");
    const raw = s.raw();
    // Directories are bold blue, executables green.
    assert(raw.includes(`${ESC}[38;5;75m${ESC}[1mSource${ESC}[0m`));
    assert(raw.includes(`${ESC}[38;5;114mbuild.sh${ESC}[0m`));
    assertEquals(
      plain(raw),
      "ls\r\nApplications  Desktop  Documents  Downloads  Source  notes.md  build.sh  todo.txt\r\n" +
        PROMPT,
    );
    assertEquals(await run(s, "whoami"), "demo\r\n");
    assertEquals(
      await run(s, "echo   a  b c  "),
      "a b c\r\n",
      "whitespace collapses",
    );
    assertEquals(await run(s, "echo"), "\r\n");
    assertEquals(
      await run(s, "frobnicate --x"),
      "demo-sh: command not found: frobnicate\r\n",
    );
    assertEquals(await run(s, "   "), "");
    s.take();
    await s.type("\r");
    assertEquals(s.take(), `\r\n${PROMPT}`);
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: date prints the current time",
  withTime(async (time) => {
    const s = await session(time);
    assertEquals(await run(s, "date"), `${T0.toString()}\r\n`);
    time.tick(86_400_000);
    assertEquals(
      await run(s, "date"),
      `${new Date(T0.getTime() + 86_400_000).toString()}\r\n`,
    );
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: clear (command and Ctrl+L)",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    await s.type("clear\r");
    assertEquals(
      s.raw().slice("clear\r\n".length, "clear\r\n".length + 11),
      `${ESC}[2J${ESC}[3J${ESC}[H`,
    );
    assert(plain(s.raw()).endsWith(PROMPT));
    s.take();
    // Ctrl+L mid-line: clear, prompt, then the line typed so far.
    await s.type("ec");
    s.take();
    await s.type("\x0c");
    const r = s.raw();
    assert(r.startsWith(`${ESC}[2J${ESC}[H`), JSON.stringify(r));
    assertEquals(plain(r), `${PROMPT}ec`);
    s.take();
    await s.type("ho kept\r");
    assertEquals(s.take(), `ho kept\r\nkept\r\n${PROMPT}`);
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: pwd and cd update the prompt and info's cwd",
  withTime(async (time) => {
    const s = await session(time);
    assertEquals(await run(s, "pwd"), "/Users/demo\r\n");
    s.take();
    await s.type("cd /tmp\r");
    assertEquals(s.take(), `cd /tmp\r\ndemo:/tmp$ `);
    assertEquals((await s.be.info(s.id)).cwd, "/tmp");
    await s.type("pwd\r");
    assertEquals(s.take(), `pwd\r\n/tmp\r\ndemo:/tmp$ `);
    await s.type("cd\r");
    assertEquals(s.take(), `cd\r\n${PROMPT}`);
    await s.type("cd Source\r");
    assertEquals(s.take(), `cd Source\r\ndemo:~/Source$ `);
    await s.type("cd ~\r");
    assertEquals(s.take(), `cd ~\r\n${PROMPT}`);
    assertEquals((await s.be.info(s.id)).cwd, "/Users/demo");
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: size follows resize",
  withTime(async (time) => {
    const s = await session(time, { cols: 80, rows: 24 });
    assertEquals(await run(s, "size"), "24 80\r\n");
    await s.be.resize(s.id, 132, 50);
    assertEquals(await run(s, "size"), "50 132\r\n");
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: colors prints all 256 background colours",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    await s.type("colors\r");
    const raw = s.raw();
    for (let i = 0; i < 256; i++) {
      assert(
        raw.includes(`${ESC}[48;5;${i}m ${String(i).padStart(3)} ${ESC}[0m`),
        `colour ${i}`,
      );
    }
    // 16 system colours on one line, then rows of 6; plus the trailing println.
    const body = raw.slice("colors\r\n".length, raw.lastIndexOf("demo"));
    assertEquals(body.split("\r\n").length - 1, 1 + 40 + 1);
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: stress prints n lines (default 2000, clamped to 1..200000)",
  withTime(async (time) => {
    const s = await session(time);
    const lines = async (arg: string) => {
      const out = await run(s, `stress${arg}`);
      const ls = out.split("\r\n").slice(0, -1);
      ls.forEach((l, i) =>
        assert(l.startsWith(`line ${i + 1} `), `${arg}: ${l}`)
      );
      return ls.length;
    };
    assertEquals(await lines(" 5"), 5);
    assertEquals(await lines(""), 2000);
    assertEquals(await lines(" 0"), 2000);
    assertEquals(await lines(" abc"), 2000);
    assertEquals(await lines(" -7"), 1);
    assertEquals(await lines(" 999999"), 200_000);
    // Each line carries (i % 60) middle dots.
    const out = await run(s, "stress 61");
    assertEquals(out.split("\r\n")[59], `line 60 `);
    assertEquals(out.split("\r\n")[60], `line 61 ·`);
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: exit, exit with a code, and input after exit",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    await s.be.write(s.id, "exit\recho never\r");
    assertEquals(s.take(), "exit\r\nlogout\r\n", "nothing runs after exit");
    await time.tickAsync(0);
    assertEquals(s.exits, [{ exitCode: 0, signal: null }]);
    await assertRejects(() => s.be.write(s.id, "x"), Error, "no such terminal");

    const t = await session(time);
    await t.type("exit 3\r");
    assertEquals(t.exits, [{ exitCode: 3, signal: null }]);
    const u = await session(time);
    await u.type("exit nope\r");
    assertEquals(u.exits, [{ exitCode: 0, signal: null }]);
  }),
);

// ---------------------------------------------------------------------------------------------
// top
// ---------------------------------------------------------------------------------------------

for (const [how, key] of [["q", "q"], ["Ctrl+C", "\x03"]] as const) {
  Deno.test(
    `demo: top ticks every second and quits with ${how}`,
    withTime(async (time) => {
      const s = await session(time, { cols: 80, rows: 10 });
      s.take();
      await s.type("top\r");
      const first = s.raw();
      assert(
        first.includes(`${ESC}[?1049h${ESC}[?25l`),
        "alternate screen, cursor hidden",
      );
      assertEquals((await s.be.info(s.id)).process, "top");
      const frame = plain(first);
      assert(frame.includes(`demo top — ${T0.toLocaleTimeString()}`), frame);
      // rows - 5 process lines.
      const procLines = frame.split("\r\n").filter((l) => /^\d{3,} /.test(l));
      assertEquals(procLines.length, 5);
      assert(!frame.includes(PROMPT), "no prompt while top runs");

      s.take();
      await time.tickAsync(1000);
      const second = plain(s.take());
      assert(
        second.includes(
          `demo top — ${new Date(T0.getTime() + 1000).toLocaleTimeString()}`,
        ),
      );
      await time.tickAsync(3000);
      assertEquals(
        plain(s.raw()).split("demo top —").length - 1,
        3,
        "one frame per second",
      );

      // Other keys are swallowed, not echoed or run.
      s.take();
      await s.type("ls\r");
      assertEquals(s.raw(), "");

      await s.type(key);
      const r = s.raw();
      assert(
        r.includes(`${ESC}[?25h${ESC}[?1049l`),
        "leaves the alternate screen",
      );
      assert(plain(r).endsWith(PROMPT));
      assertEquals((await s.be.info(s.id)).process, "demo-sh");
      s.take();
      await time.tickAsync(5000);
      assertEquals(s.raw(), "", "the ticker stopped");
      assertEquals(await run(s, "echo back"), "back\r\n");
      await s.be.kill(s.id);
    }),
  );
}

Deno.test(
  "demo: top's table fills the width; kill while top runs stops the ticker",
  withTime(async (time) => {
    const s = await session(time, { cols: 100, rows: 30 });
    s.take();
    await s.type("top\r");
    const header = plain(s.raw()).split("\r\n").find((l) =>
      l.startsWith("PID")
    );
    assertEquals(header?.length, 100);
    await s.be.kill(s.id);
    await time.tickAsync(0);
    s.take();
    await time.tickAsync(5000);
    assertEquals(s.raw(), "");
    assertEquals(s.exits, [{ exitCode: 0, signal: 1 }]);
  }),
);

// ---------------------------------------------------------------------------------------------
// Line editing and control keys
// ---------------------------------------------------------------------------------------------

Deno.test(
  "demo: backspace (DEL and BS) erases one character, including an emoji",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    await s.type("echo abc\x7f\x7fZ\r");
    assertEquals(s.take(), `echo abc\b \b\b \bZ\r\naZ\r\n${PROMPT}`);
    await s.type("echo x😀\x08\r");
    assertEquals(s.take(), `echo x😀\b \b\r\nx\r\n${PROMPT}`);
    // Backspace on an empty line does nothing.
    await s.type("\x7f\x7f");
    assertEquals(s.take(), "");
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: Ctrl+C abandons the line; Ctrl+U erases it",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    await s.type("echo nope\x03");
    assertEquals(s.take(), `echo nope^C\r\n${PROMPT}`);
    await s.type("\r");
    assertEquals(s.take(), `\r\n${PROMPT}`, "the line was cleared");
    await s.type("héllo\x15");
    assertEquals(s.take(), `héllo${"\b \b".repeat(5)}`);
    await s.type("echo ok\r");
    assertEquals(s.take(), `echo ok\r\nok\r\n${PROMPT}`);
    await s.be.kill(s.id);
  }),
);

Deno.test(
  "demo: Ctrl+D exits on an empty line only, and nothing after it is processed",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    await s.type("abc\x04");
    assertEquals(s.take(), "abc", "ignored on a non-empty line");
    await s.type("\x15");
    s.take();
    await s.type("\x04ls\r");
    assertEquals(s.take(), "logout\r\n");
    assertEquals(s.exits, [{ exitCode: 0, signal: null }]);
  }),
);

Deno.test(
  "demo: escape sequences are dropped, tab becomes a space, LF works as Enter",
  withTime(async (time) => {
    const s = await session(time);
    s.take();
    // Arrows, a CSI with parameters, SS3 (F1), and Alt+x.
    await s.type(`ec${ESC}[A${ESC}[1;5Dho${ESC}OP${ESC}x\tz\n`);
    assertEquals(s.take(), `echo z\r\nz\r\n${PROMPT}`);
    // Other C0 controls are ignored.
    await s.type("\x01\x02\x07echo c0\r");
    assertEquals(s.take(), `echo c0\r\nc0\r\n${PROMPT}`);
    // Several lines in one write run in order.
    await s.type("echo 1\recho 2\r");
    assertEquals(s.take(), `echo 1\r\n1\r\n${PROMPT}echo 2\r\n2\r\n${PROMPT}`);
    await s.be.kill(s.id);
  }),
);
