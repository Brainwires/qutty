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
} from "../desktop/pty.ts";
import type { DesktopCapCtx } from "denext/desktop";

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
