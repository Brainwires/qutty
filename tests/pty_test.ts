// Exercises the PTY backend under this Deno exactly as the desktop extension runs it: node-pty's
// native fork + libc FFI I/O, output coalescing, resize, info, kill and exit — first through the
// PtyHost the extension wraps, then through the extension's own method handlers with a stand-in
// handler context. Run: deno test -A tests/
//
// The sanitizers are off: libc is opened once per process (a resource that lives on), and a
// terminal's read loop polls on Deno's blocking thread pool until the shell's exit is seen.

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import ext, {
  type PtyDataEvent,
  type PtyExitEvent,
  PtyHost,
  resolveProgram,
} from "../desktop/pty.ts";
import type { DesktopCapCtx } from "denext/desktop";
import { withEnv } from "./pty_helpers.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };

/** Collects one host's events and waits for conditions on them. */
class Recorder {
  data = new Map<string, PtyDataEvent[]>();
  exits = new Map<string, PtyExitEvent>();
  emit = (event: "data" | "exit", payload: PtyDataEvent | PtyExitEvent) => {
    if (event === "data") {
      const d = payload as PtyDataEvent;
      const list = this.data.get(d.id) ?? [];
      list.push(d);
      this.data.set(d.id, list);
    } else {
      this.exits.set(payload.id, payload as PtyExitEvent);
    }
  };
  text(id: string): string {
    return (this.data.get(id) ?? []).map((d) => d.data).join("");
  }
  async until(what: string, cond: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

Deno.test("PtyHost: spawn, echo, resize, info, exit", opts, async () => {
  const rec = new Recorder();
  const host = new PtyHost(rec.emit);
  try {
    const t = await host.spawn({
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      shell: "/bin/sh",
    });
    assertMatch(t.id, /^pty-\d+$/);
    assert(t.pid > 0);
    assertEquals(t.shell, "/bin/sh");
    assertEquals(t.cwd, "/tmp");

    await host.write(
      t.id,
      "echo hi-$((40+2)); stty size; echo T=$TERM C=$COLORTERM P=$TERM_PROGRAM\r",
    );
    await rec.until("echo output", () => rec.text(t.id).includes("hi-42"));
    await rec.until("stty size", () => rec.text(t.id).includes("24 80"));
    await rec.until(
      "env",
      () =>
        rec.text(t.id).includes(
          "T=xterm-256color C=truecolor P=qutty",
        ),
    );

    host.resize(t.id, 100, 30);
    await host.write(t.id, "stty size\r");
    await rec.until(
      "resized stty size",
      () => rec.text(t.id).includes("30 100"),
    );

    const info = await host.info(t.id);
    assertEquals(info.pid, t.pid);
    assert(
      ["sh", "bash", "zsh", "dash"].includes(info.process),
      `process: ${info.process}`,
    );
    if (Deno.build.os === "darwin") assertEquals(info.cwd, "/private/tmp");

    // seq increases by one per event.
    const seqs = rec.data.get(t.id)!.map((d) => d.seq);
    seqs.forEach((s, i) => assertEquals(s, i + 1));

    await host.write(t.id, "exit 7\r");
    await rec.until("exit", () => rec.exits.has(t.id));
    assertEquals(rec.exits.get(t.id), { id: t.id, exitCode: 7, signal: null });
    assertEquals(host.size, 0);
    await assertRejects(() => host.write(t.id, "x"), Error, "no such terminal");
  } finally {
    await host.dispose();
  }
});

Deno.test(
  "PtyHost: a program by name with its own args, found on PATH or the bin folders",
  opts,
  async () => {
    const rec = new Recorder();
    const host = new PtyHost(rec.emit);
    try {
      // A bare name is found even when PATH is useless (a Finder-launched app's is).
      let t!: Awaited<ReturnType<PtyHost["spawn"]>>;
      await withEnv({ PATH: "/nonexistent" }, async () => {
        t = await host.spawn({
          cols: 80,
          rows: 24,
          cwd: "/tmp",
          program: "sh",
          args: ["-c", "echo P=$0 A=$1 N=$#; exit 3", "zero", "one"],
        });
      });
      assertMatch(t.shell, /\/bin\/sh$/);
      await rec.until("exit", () => rec.exits.has(t.id));
      assert(rec.text(t.id).includes("P=zero A=one N=1"), rec.text(t.id));
      assertEquals(rec.exits.get(t.id)!.exitCode, 3);

      const abs = await host.spawn({
        cols: 80,
        rows: 24,
        program: "/bin/sh",
        args: ["-c", "exit 0"],
      });
      assertEquals(abs.shell, "/bin/sh");
      await rec.until("exit", () => rec.exits.has(abs.id));

      await assertRejects(
        () =>
          host.spawn({ cols: 80, rows: 24, program: "qutty-no-such-program" }),
        Error,
        "program not found",
      );
      // A relative path is refused (nothing says what it is relative to).
      await assertRejects(
        () => host.spawn({ cols: 80, rows: 24, program: "bin/sh" }),
        Error,
        "program not found",
      );
      await assertRejects(
        () => host.spawn({ cols: 80, rows: 24, program: "/etc/passwd" }),
        Error,
        "program not found",
      );
      assertEquals(await resolveProgram("sh"), "/bin/sh");
      assertEquals(await resolveProgram("qutty-no-such-program"), undefined);
    } finally {
      await host.dispose();
    }
  },
);

Deno.test("PtyHost: output is coalesced", opts, async () => {
  const rec = new Recorder();
  const host = new PtyHost(rec.emit);
  try {
    const t = await host.spawn({
      cols: 120,
      rows: 40,
      cwd: "/tmp",
      shell: "/bin/sh",
    });
    // ~1.9 MB of output, then exit.
    await host.write(
      t.id,
      "i=0; while [ $i -lt 4 ]; do yes 0123456789abcdef0123456789abcdef0123456789 | head -n 10000; i=$((i+1)); done; echo DONE-MARK; exit\r",
    );
    await rec.until("exit", () => rec.exits.has(t.id), 30_000);
    const events = rec.data.get(t.id)!;
    const total = events.reduce((n, e) => n + e.data.length, 0);
    assert(rec.text(t.id).includes("DONE-MARK"));
    assert(total > 1_500_000, `total ${total}`);
    const max = Math.max(...events.map((e) => e.data.length));
    // A flush happens at 64 KiB pending; one read adds at most 64 KiB more.
    assert(max <= 128 * 1024, `largest event ${max}`);
    console.log(
      `coalescing: ${total} chars in ${events.length} events (avg ${
        Math.round(total / events.length)
      }, max ${max})`,
    );
    assert(events.length < total / 1024, `too many events: ${events.length}`);
  } finally {
    await host.dispose();
  }
});

Deno.test(
  "PtyHost: binary writes are raw bytes, text is UTF-8",
  opts,
  async () => {
    const rec = new Recorder();
    const host = new PtyHost(rec.emit);
    // The markers are split by quotes in the command, so only od's run prints them whole.
    const odRun = (n: number, tag: string) =>
      `stty raw -echo; echo ${tag}-''READY; od -An -tx1 -N${n}; echo ${tag}-''END; stty sane\r`;
    try {
      const t = await host.spawn({
        cols: 80,
        rows: 24,
        cwd: "/tmp",
        shell: "/bin/sh",
      });
      // Legacy (X10) mouse reports put coordinates past column 95 in bytes >= 0x80: they must
      // arrive as single bytes, not UTF-8 pairs.
      await host.write(t.id, odRun(3, "BIN"));
      await rec.until(
        "od (binary)",
        () => rec.text(t.id).includes("BIN-READY"),
      );
      await host.write(t.id, "\xa0\xff\xc3", true);
      await rec.until(
        "od output (binary)",
        () => rec.text(t.id).includes("BIN-END"),
      );
      assertMatch(rec.text(t.id), /a0 +ff +c3/);
      // The same character as text is UTF-8: U+00A0 is c2 a0.
      await host.write(t.id, odRun(2, "TXT"));
      await rec.until("od (text)", () => rec.text(t.id).includes("TXT-READY"));
      await host.write(t.id, "\xa0");
      await rec.until(
        "od output (text)",
        () => rec.text(t.id).includes("TXT-END"),
      );
      assertMatch(rec.text(t.id).split("TXT-READY")[1], /c2 +a0/);
      await host.write(t.id, "exit\r");
      await rec.until("exit", () => rec.exits.has(t.id));
    } finally {
      await host.dispose();
    }
  },
);

Deno.test("PtyHost: kill hangs up the shell", opts, async () => {
  const rec = new Recorder();
  const host = new PtyHost(rec.emit);
  try {
    const t = await host.spawn({ cols: 80, rows: 24, shell: "/bin/sh" });
    assertEquals(t.cwd, Deno.env.get("HOME"));
    await host.write(t.id, "echo ready\r");
    await rec.until("ready", () => rec.text(t.id).includes("ready"));
    host.kill(t.id);
    await rec.until("exit after kill", () => rec.exits.has(t.id));
    const e = rec.exits.get(t.id)!;
    assert(e.signal === 1 || e.exitCode !== 0, `exit: ${JSON.stringify(e)}`);
  } finally {
    await host.dispose();
  }
});

Deno.test(
  "extension handlers: validated input, spawn/write/info/kill through the module",
  opts,
  async () => {
    const events: { event: string; data: unknown }[] = [];
    const ctx: DesktopCapCtx = {
      emit: (event, data) => {
        assert(
          ext.events.includes(event as "data" | "exit"),
          `undeclared event ${event}`,
        );
        events.push({ event, data });
      },
      appSupportDir: await Deno.makeTempDir({ prefix: "pty-test-" }),
      os: Deno.build.os as "darwin" | "linux",
      windowId: "main",
      signal: new AbortController().signal,
      runOnMainThread: () => Promise.reject(new Error("unused")),
      pickedPath: () => {
        throw new Error("unused");
      },
    };
    const m = ext.methods;

    // The input schemas the bridge runs before a handler.
    const bad = await m.spawn.input["~standard"].validate({
      cols: 0,
      rows: "x",
    });
    assert(
      "issues" in bad && bad.issues !== undefined && bad.issues.length === 2,
    );
    const good = await m.spawn.input["~standard"].validate({
      cols: 80,
      rows: 24,
    });
    assert(!("issues" in good && good.issues));
    assert((await m.write.input["~standard"].validate({ id: "pty-1" })).issues);

    const spawned = await m.spawn.handler({
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      shell: "/bin/sh",
    }, ctx);
    const text = () =>
      events.filter((e) =>
        e.event === "data" && (e.data as PtyDataEvent).id === spawned.id
      )
        .map((e) => (e.data as PtyDataEvent).data).join("");
    await m.write.handler({ id: spawned.id, data: "echo via-ext-$((1+1))\r" });
    const deadline = Date.now() + 10_000;
    while (!text().includes("via-ext-2")) {
      if (Date.now() > deadline) {
        throw new Error(
          "no output through the extension",
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    m.resize.handler({ id: spawned.id, cols: 90, rows: 20 });
    const info = await m.info.handler({ id: spawned.id });
    assertEquals(info.pid, spawned.pid);

    // A page reload of the owning window kills its terminals.
    await ext.onPageLoad("main");
    while (
      !events.some((e) =>
        e.event === "exit" && (e.data as PtyExitEvent).id === spawned.id
      )
    ) {
      if (Date.now() > deadline + 5_000) {
        throw new Error(
          "no exit after onPageLoad",
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await assertRejects(
      async () => await m.write.handler({ id: spawned.id, data: "x" }),
      Error,
      "no such terminal",
    );
    await Deno.remove(ctx.appSupportDir, { recursive: true });
  },
);
