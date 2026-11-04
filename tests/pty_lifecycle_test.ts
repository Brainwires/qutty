// Lifecycle tests for the PTY host (desktop/pty.ts) against real shells: kill escalation, exit
// codes and signals, not_found handling, cwd/process tracking, the environment, spawn fallbacks,
// zsh, onPageLoad per window, and the synchronous teardown. Run: deno test -A tests/
//
// Sanitizers stay on except where noted (each `sanitizeOps: false` says why).

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { type DesktopCapCtx, DesktopCapError } from "denext/desktop";
import ext, {
  type PtyDataEvent,
  type PtyExitEvent,
  PtyHost,
} from "../desktop/pty.ts";
import {
  HAS_SH,
  HAS_ZSH,
  marker,
  POSIX,
  Recorder,
  warmUp,
  withEnv,
  withHost,
} from "./pty_helpers.ts";

await warmUp();

const ignore = !POSIX || !HAS_SH;
const SH = "/bin/sh";
const HOME = Deno.env.get("HOME") ?? "/";
const SIGUSR1 = Deno.build.os === "darwin" ? 30 : 10;

/** Run a command in a fresh /bin/sh and return its exit event. */
async function exitOf(
  host: PtyHost,
  rec: Recorder,
  cmd: string,
): Promise<PtyExitEvent> {
  const t = await host.spawn({ cols: 80, rows: 24, shell: SH, cwd: "/tmp" });
  await host.write(t.id, `${cmd}\r`);
  return await rec.waitExit(t.id);
}

Deno.test({
  name: "lifecycle: exit codes and terminating signals",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const cases: [string, number, number | null][] = [
        ["exit 0", 0, null],
        ["exit 1", 1, null],
        ["exit 42", 42, null],
        ["exit 255", 255, null],
        ["exit 256", 0, null], // wraps modulo 256
        ["false; exit $?", 1, null],
        ["kill -KILL $$", 0, 9],
        ["kill -USR1 $$", 0, SIGUSR1],
      ];
      const results = await Promise.all(
        cases.map(([cmd]) => exitOf(host, rec, cmd)),
      );
      results.forEach((e, i) => {
        const [cmd, code, signal] = cases[i];
        assertEquals([e.exitCode, e.signal], [code, signal], cmd);
      });
    }),
});

Deno.test({
  name: "lifecycle: kill escalates to SIGKILL for a shell that ignores SIGHUP",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await host.spawn({
        cols: 80,
        rows: 24,
        shell: SH,
        cwd: "/tmp",
      });
      const m = marker("trapped");
      await host.write(t.id, `trap '' HUP; ${m.cmd}\r`);
      await rec.waitFor(t.id, m.text);
      const t0 = Date.now();
      host.kill(t.id);
      host.kill(t.id); // a second kill must not restart the escalation timer
      // SIGHUP is ignored: still alive a while later (polled, not slept: 1 s of checks).
      await assertRejects(() =>
        rec.until("early exit", () => rec.exits.has(t.id), 1000)
      );
      const again = marker("stillhere");
      await host.write(t.id, `${again.cmd}\r`);
      await rec.waitFor(t.id, again.text);
      const exit = await rec.waitExit(t.id, 10_000);
      const elapsed = Date.now() - t0;
      assertEquals(exit.signal, 9, JSON.stringify(exit));
      assert(elapsed >= 2900, `escalated after ${elapsed} ms (expected ~3000)`);
      assert(elapsed < 8000, `escalated after ${elapsed} ms`);
    }),
});

Deno.test({
  name: "lifecycle: kill hangs up a shell with a foreground job",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await host.spawn({
        cols: 80,
        rows: 24,
        shell: SH,
        cwd: "/tmp",
      });
      await host.write(t.id, "sleep 60\r");
      const deadline = Date.now() + 10_000;
      while ((await host.info(t.id)).process !== "sleep") {
        if (Date.now() > deadline) throw new Error("sleep never ran");
        await new Promise((r) => setTimeout(r, 20));
      }
      host.kill(t.id);
      const exit = await rec.waitExit(t.id, 2500); // well before the 3 s escalation
      assert(exit.signal === 1 || exit.exitCode !== 0, JSON.stringify(exit));
    }),
});

Deno.test({
  name:
    "lifecycle: write/resize/info on unknown or exited ids are not_found; kill is a no-op",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await host.spawn({
        cols: 80,
        rows: 24,
        shell: SH,
        cwd: "/tmp",
      });
      await host.write(t.id, "exit\r");
      await rec.waitExit(t.id);
      for (const id of ["pty-999999", t.id, "", "../etc"]) {
        const w = await assertRejects(() => host.write(id, "x"));
        assertInstanceOf(w, DesktopCapError);
        assertEquals([w.code, w.status], ["not_found", 404]);
        const r = assertThrows(() => host.resize(id, 80, 24));
        assertInstanceOf(r, DesktopCapError);
        assertEquals(r.code, "not_found");
        const i = await assertRejects(() => host.info(id));
        assertInstanceOf(i, DesktopCapError);
        assertEquals(i.code, "not_found");
        host.kill(id); // silently ignored
      }
      // An empty write to a live terminal is a no-op, not an error.
      const live = await host.spawn({
        cols: 80,
        rows: 24,
        shell: SH,
        cwd: "/tmp",
      });
      await host.write(live.id, "");
      host.kill(live.id);
      await rec.waitExit(live.id);
    }),
});

Deno.test({
  name: "lifecycle: info tracks cd and the foreground process",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await host.spawn({
        cols: 80,
        rows: 24,
        shell: SH,
        cwd: "/tmp",
      });
      const info0 = await host.info(t.id);
      assertEquals(info0.id, t.id);
      assertEquals(info0.pid, t.pid);
      const shellNames = ["sh", "bash", "dash", "zsh"];
      assert(shellNames.includes(info0.process), info0.process);
      const real = (p: string) => Deno.realPathSync(p);
      await host.write(t.id, "cd /usr/bin\r");
      let info = info0;
      const deadline = Date.now() + 10_000;
      while ((info = await host.info(t.id)).cwd !== real("/usr/bin")) {
        if (Date.now() > deadline) throw new Error(`cwd stayed ${info.cwd}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      // A foreground job: its name, and its cwd (a subshell cd'd elsewhere).
      await host.write(t.id, "(cd / && exec sleep 30)\r");
      while ((info = await host.info(t.id)).process !== "sleep") {
        if (Date.now() > deadline + 10_000) {
          throw new Error(`process stayed ${info.process}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(info.cwd, "/");
      // Ctrl+C ends it; the shell is the foreground again, back in /usr/bin.
      await host.write(t.id, "\x03");
      while (!shellNames.includes((info = await host.info(t.id)).process)) {
        if (Date.now() > deadline + 20_000) {
          throw new Error(`process stayed ${info.process}`);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(info.cwd, real("/usr/bin"));
      await host.write(t.id, "exit\r");
      await rec.waitExit(t.id);
    }),
});

Deno.test({
  name:
    "lifecycle: the shell's environment (TERM etc. set, parent-terminal vars stripped)",
  ignore,
  fn: () =>
    withEnv({
      TMUX: "/tmp/tmux-1/default,1,0",
      TMUX_PANE: "%1",
      STY: "1.pts-0",
      WINDOW: "0",
      WINDOWID: "123",
      TERMCAP: "xx",
      TERM: "dumb",
      COLORTERM: "nope",
      TERM_PROGRAM: "Other",
      LANG: undefined,
      LC_ALL: undefined,
      LC_CTYPE: undefined,
      BW_TEST_KEEP: "kept-value",
    }, () =>
      withHost(async (host, rec) => {
        const t = await host.spawn({
          cols: 80,
          rows: 24,
          shell: SH,
          cwd: "/tmp",
        });
        const probe = [
          "T=$TERM",
          "C=$COLORTERM",
          "P=$TERM_PROGRAM",
          "L=$LANG",
          "K=$BW_TEST_KEEP",
          "W=$PWD",
          "X=${TMUX+set}${TMUX_PANE+set}${STY+set}${WINDOW+set}${WINDOWID+set}${TERMCAP+set}",
        ].join(" ");
        const m = marker("envdone");
        await rec.waitReady(t.id);
        await host.write(t.id, `echo "E$((1+1)) ${probe} :"; ${m.cmd}\r`);
        await rec.waitFor(t.id, m.text);
        const line = rec.text(t.id).split("\r\n").find((l) =>
          l.startsWith("E2 ")
        );
        assertEquals(
          line,
          "E2 T=xterm-256color C=truecolor P=qutty L=en_US.UTF-8 K=kept-value W=/tmp X= :",
        );
        await host.write(t.id, "exit\r");
        await rec.waitExit(t.id);
      })),
});

Deno.test({
  name: "lifecycle: an existing locale is kept",
  ignore,
  fn: () =>
    withEnv(
      { LANG: undefined, LC_ALL: undefined, LC_CTYPE: "C" },
      () =>
        withHost(async (host, rec) => {
          const t = await host.spawn({
            cols: 80,
            rows: 24,
            shell: SH,
            cwd: "/tmp",
          });
          const m = marker("locdone");
          await host.write(
            t.id,
            `echo "Q$((2+2)) L=\${LANG-unset} C=$LC_CTYPE"; ${m.cmd}\r`,
          );
          await rec.waitFor(t.id, m.text);
          assert(rec.text(t.id).includes("Q4 L=unset C=C"), rec.text(t.id));
          await host.write(t.id, "exit\r");
          await rec.waitExit(t.id);
        }),
    ),
});

Deno.test({
  name:
    "lifecycle: an unusable cwd falls back to $HOME; a bad shell is spawn_failed",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      for (
        const cwd of ["/definitely/not/here", "/etc/hosts", "", "/dev/null"]
      ) {
        const t = await host.spawn({ cols: 80, rows: 24, shell: SH, cwd });
        assertEquals(t.cwd, HOME, `cwd ${JSON.stringify(cwd)}`);
        const m = marker(`pwd${t.id}`);
        await rec.waitReady(t.id);
        await host.write(t.id, `pwd; ${m.cmd}\r`);
        await rec.waitFor(t.id, m.text);
        assert(
          rec.text(t.id).includes(`\r\n${Deno.realPathSync(HOME)}\r\n`) ||
            rec.text(t.id).includes(`\r\n${HOME}\r\n`),
          `pwd in ${t.id}`,
        );
        host.kill(t.id);
        await rec.waitExit(t.id);
      }
      for (const shell of ["/no/such/shell", "/tmp", "/dev"]) {
        const err = await assertRejects(() =>
          host.spawn({ cols: 80, rows: 24, shell })
        );
        assertInstanceOf(err, DesktopCapError);
        assertEquals(err.code, "spawn_failed", shell);
        assert(!err.message.includes(shell), "the message leaks no path");
      }
      assertEquals(host.size, 0);
      // A file that is not executable spawns, and exits non-zero right away.
      const t = await host.spawn({ cols: 80, rows: 24, shell: "/etc/hosts" });
      const exit = await rec.waitExit(t.id);
      assert(exit.exitCode !== 0 || exit.signal !== null, JSON.stringify(exit));
      // Default shell: $SHELL.
      await withEnv({ SHELL: SH }, async () => {
        const d = await host.spawn({ cols: 80, rows: 24 });
        assertEquals(d.shell, SH);
        assertEquals(d.cwd, HOME);
        host.kill(d.id);
        await rec.waitExit(d.id);
      });
    }),
});

Deno.test({
  name: "lifecycle: zsh works as a login shell (empty ZDOTDIR)",
  ignore: !POSIX || !HAS_ZSH,
  fn: async () => {
    const zdot = await Deno.makeTempDir({ prefix: "pty-zdot-" });
    try {
      await withEnv({ ZDOTDIR: zdot }, () =>
        withHost(async (host, rec) => {
          const t = await host.spawn({
            cols: 100,
            rows: 30,
            shell: "/bin/zsh",
            cwd: "/tmp",
          });
          assertEquals(t.shell, "/bin/zsh");
          const m = marker("zshok");
          await host.write(
            t.id,
            `echo Z$((6*7)) $ZSH_VERSION[1]; stty size; ${m.cmd}\r`,
          );
          await rec.waitFor(t.id, m.text);
          assertMatch(rec.text(t.id), /Z42 \d/);
          assert(rec.text(t.id).includes("30 100"));
          assertEquals((await host.info(t.id)).process, "zsh");
          await host.write(t.id, "exit 9\r");
          assertEquals((await rec.waitExit(t.id)).exitCode, 9);
        }));
    } finally {
      await Deno.remove(zdot, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "lifecycle: a background job holding the tty does not keep the terminal alive",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await host.spawn({
        cols: 80,
        rows: 24,
        shell: SH,
        cwd: "/tmp",
      });
      const m = marker("bgready");
      await host.write(t.id, `sleep 2 & ${m.cmd}\r`);
      await rec.waitFor(t.id, m.text);
      const t0 = Date.now();
      await host.write(t.id, "exit 0\r");
      const exit = await rec.waitExit(t.id, 5000);
      assertEquals(exit.exitCode, 0);
      assert(Date.now() - t0 < 1900, `exit took ${Date.now() - t0} ms`);
    }),
});

Deno.test({
  name:
    "lifecycle: setEmit redirects events; a throwing sink does not break the host",
  ignore,
  fn: async () => {
    const a = new Recorder();
    const b = new Recorder();
    const host = new PtyHost(a.emit);
    try {
      const t = await host.spawn({
        cols: 80,
        rows: 24,
        shell: SH,
        cwd: "/tmp",
      });
      const m1 = marker("toA");
      await host.write(t.id, `${m1.cmd}\r`);
      await a.waitFor(t.id, m1.text);
      host.setEmit(b.emit);
      const m2 = marker("toB");
      await host.write(t.id, `${m2.cmd}\r`);
      await b.waitFor(t.id, m2.text);
      assert(!a.text(t.id).includes(m2.text));
      // A sink that throws is logged, and output keeps flowing afterwards.
      let thrown = 0;
      const origError = console.error;
      console.error = () => thrown++;
      try {
        host.setEmit(() => {
          throw new Error("sink down");
        });
        await host.write(t.id, "echo x\r");
        await b.until("a throw", () => thrown > 0);
      } finally {
        console.error = origError;
      }
      host.setEmit(b.emit);
      const m3 = marker("afterthrow");
      await host.write(t.id, `${m3.cmd}\r`);
      await b.waitFor(t.id, m3.text);
      await host.write(t.id, "exit\r");
      await b.waitExit(t.id);
    } finally {
      await host.dispose();
    }
  },
});

Deno.test({
  name: "lifecycle: killAllNow tears down synchronously",
  ignore,
  // The read loops' in-flight 100 ms FFI `poll` on the now-closed masters cannot be awaited
  // through the public API (killAllNow is for process exit and emits no `exit`).
  sanitizeOps: false,
  fn: async () => {
    const rec = new Recorder();
    const host = new PtyHost(rec.emit);
    const terms: { id: string; pid: number }[] = [];
    for (let i = 0; i < 3; i++) {
      terms.push(
        await host.spawn({ cols: 80, rows: 24, shell: SH, cwd: "/tmp" }),
      );
    }
    host.killAllNow();
    assertEquals(host.size, 0);
    await assertRejects(() => host.write(terms[0].id, "x"), DesktopCapError);
    // The shells are gone (hung up): poll `kill -0`.
    for (const t of terms) {
      await rec.until(`pid ${t.pid} gone`, () => {
        try {
          Deno.kill(t.pid, "SIGCONT");
          return false;
        } catch {
          return true;
        }
      }, 10_000);
    }
    await host.dispose(); // nothing left: returns at once
  },
});

// ---------------------------------------------------------------------------------------------
// The extension: handlers, onPageLoad per window
// ---------------------------------------------------------------------------------------------

function ctxFor(
  windowId: string | undefined,
  events: { event: string; data: unknown }[],
): DesktopCapCtx {
  return {
    emit: (event, data) => {
      assert(
        ext.events.includes(event as "data" | "exit"),
        `undeclared event ${event}`,
      );
      events.push({ event, data });
    },
    appSupportDir: "",
    os: Deno.build.os as "darwin" | "linux",
    windowId,
    signal: new AbortController().signal,
    runOnMainThread: () => Promise.reject(new Error("unused")),
    pickedPath: () => {
      throw new Error("unused");
    },
  } as DesktopCapCtx;
}

async function untilEvent(
  events: { event: string; data: unknown }[],
  pred: (e: { event: string; data: unknown }) => boolean,
  what: string,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!events.some(pred)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const exitOfId = (id: string) => (e: { event: string; data: unknown }) =>
  e.event === "exit" && (e.data as PtyExitEvent).id === id;

Deno.test({
  name: "extension: onPageLoad kills only the reloading window's terminals",
  ignore,
  fn: async () => {
    const events: { event: string; data: unknown }[] = [];
    const m = ext.methods;
    const spawn = (win: string | undefined) =>
      m.spawn.handler(
        { cols: 80, rows: 24, shell: SH, cwd: "/tmp" },
        ctxFor(win, events),
      );
    const w1a = await spawn("w1");
    const w1b = await spawn("w1");
    const w2 = await spawn("w2");
    const main = await spawn(undefined); // no window id = the main window
    try {
      await ext.onPageLoad("w1");
      await untilEvent(events, exitOfId(w1a.id), "w1a exit");
      await untilEvent(events, exitOfId(w1b.id), "w1b exit");
      // w2 and main survive and still answer.
      for (const t of [w2, main]) {
        const mk = marker(`alive${t.id}`);
        await m.write.handler({ id: t.id, data: `${mk.cmd}\r` });
        await untilEvent(
          events,
          (e) =>
            e.event === "data" &&
            (e.data as PtyDataEvent).data.includes(mk.text),
          `${t.id} alive`,
        );
      }
      assert(!events.some(exitOfId(w2.id)) && !events.some(exitOfId(main.id)));
      // A window that owns nothing: nothing happens.
      await ext.onPageLoad("w-unknown");
      // onPageLoad() without an id means the main window.
      await ext.onPageLoad();
      await untilEvent(events, exitOfId(main.id), "main exit");
      assert(!events.some(exitOfId(w2.id)));
    } finally {
      await ext.onPageLoad("w2");
      await untilEvent(events, exitOfId(w2.id), "w2 exit");
    }
    await assertRejects(
      () => m.write.handler({ id: w2.id, data: "x" }),
      DesktopCapError,
      "no such terminal",
    );
    await assertRejects(
      () => m.info.handler({ id: w2.id }),
      DesktopCapError,
      "no such terminal",
    );
    assertThrows(
      () => m.resize.handler({ id: w2.id, cols: 80, rows: 24 }),
      DesktopCapError,
    );
    m.kill.handler({ id: w2.id }); // no-op
  },
});
