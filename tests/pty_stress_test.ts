// Stress tests for the PTY host (desktop/pty.ts) against real shells: many concurrent sessions,
// large and binary output, UTF-8 split across reads, write bursts and 1 MiB pastes, resize storms,
// and descriptor leaks. Every wait polls for a condition with a timeout; nothing sleeps a fixed
// time. Run: deno test -A tests/
//
// The resource and op sanitizers stay on: libc, node-pty and spawn-helper are loaded once at
// module load (`warmUp`), and each test disposes its host, which waits for every terminal's
// `exit` (emitted only after its read loop has finished and its master fd is closed).

import { assert, assertEquals } from "@std/assert";
import {
  between,
  HAS_SH,
  marker,
  openFds,
  POSIX,
  Recorder,
  warmUp,
  withHost,
} from "./pty_helpers.ts";
import { PtyHost } from "../desktop/pty.ts";

await warmUp();

const ignore = !POSIX || !HAS_SH;
const SH = "/bin/sh";

/** Spawn /bin/sh in a temp dir, turn echo off, and wait until it answers. */
async function quietShell(host: PtyHost, rec: Recorder, cols = 120, rows = 40) {
  const t = await host.spawn({ cols, rows, shell: SH, cwd: "/tmp" });
  const ready = marker(`ready${t.id}`);
  await host.write(t.id, `stty -echo; ${ready.cmd}\r`);
  await rec.waitFor(t.id, ready.text);
  return t;
}

Deno.test({
  name: "stress: 20 concurrent sessions keep their output and exit codes apart",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const N = 20;
      const terms = await Promise.all(
        Array.from({ length: N }, () =>
          host.spawn({ cols: 80, rows: 24, shell: SH, cwd: "/tmp" })),
      );
      assertEquals(
        new Set(terms.map((t) =>
          t.id
        )).size,
        N,
      );
      assertEquals(new Set(terms.map((t) => t.pid)).size, N);
      assertEquals(host.size, N);
      // Every session computes something only it can print, then exits with its own code.
      await Promise.all(terms.map((t, i) =>
        host.write(
          t.id,
          `${
            marker(`s${i}x${i * i}`).cmd
          }; i=0; while [ $i -lt 50 ]; do echo ${t.id}-line-$i; i=$((i+1)); done; exit ${
            i + 1
          }\r`,
        )
      ));
      for (const [i, t] of terms.entries()) {
        const exit = await rec.waitExit(t.id, 30_000);
        assertEquals(exit, { id: t.id, exitCode: i + 1, signal: null });
      }
      for (const [i, t] of terms.entries()) {
        const out = rec.text(t.id);
        assert(out.includes(`<s${i}x${i * i}>`), `${t.id} printed its marker`);
        assert(
          out.includes(`${t.id}-line-49`),
          `${t.id} printed all its lines`,
        );
        for (const [j, other] of terms.entries()) {
          if (j === i) continue;
          assert(
            !out.includes(`<s${j}x${j * j}>`),
            `${t.id} saw ${other.id}'s marker`,
          );
          assert(
            !out.includes(`${other.id}-line-`),
            `${t.id} saw ${other.id}'s lines`,
          );
        }
        // seq is 1, 2, 3, ... per terminal.
        rec.data.get(t.id)!.forEach((d, k) => assertEquals(d.seq, k + 1));
      }
      assertEquals(host.size, 0);
    }),
});

Deno.test({
  name: "stress: 5 MB of `yes` output arrives byte-exact, in order, coalesced",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await quietShell(host, rec);
      const start = marker("bigstart");
      const end = marker("bigend");
      const t0 = performance.now();
      // -opost: no ONLCR. With it, macOS's tty now and then emits "\r\r\n" when its output
      // queue fills between the \r and the \n (seen only under load; the kernel's doing, not a
      // loss here), so the byte-exact check runs on untranslated output.
      await host.write(
        t.id,
        `stty -opost; ${start.cmd}; yes | head -c 5000000; ${end.cmd}; stty opost\r`,
      );
      await rec.waitFor(t.id, end.text, 60_000);
      const ms = performance.now() - t0;
      const body = between(rec.text(t.id), `${start.text}\n`, end.text);
      // Exactly 2 500 000 "y\n" lines.
      assertEquals(body.length, 5_000_000);
      assert(body === "y\n".repeat(2_500_000), "every line is y");
      const events = rec.data.get(t.id)!;
      events.forEach((d, k) => assertEquals(d.seq, k + 1));
      const max = Math.max(...events.map((e) => e.data.length));
      assert(max <= 128 * 1024, `largest event ${max}`);
      assert(
        events.length < 5_000_000 / 4096,
        `${events.length} events: not coalesced`,
      );
      console.log(
        `5 MB: ${Math.round(ms)} ms, ${events.length} events, max ${max}`,
      );
      await host.write(t.id, "exit\r");
      await rec.waitExit(t.id);
    }),
});

Deno.test({
  name: "stress: all output is flushed before the exit event",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await quietShell(host, rec);
      const start = marker("tailstart");
      await host.write(
        t.id,
        `${start.cmd}; head -c 300000 /dev/zero | tr '\\0' z; exit 4\r`,
      );
      const exit = await rec.waitExit(t.id, 30_000);
      assertEquals(exit.exitCode, 4);
      const text = rec.text(t.id);
      const body = text.slice(
        text.lastIndexOf(`${start.text}\r\n`) + start.text.length + 2,
      );
      assertEquals(
        body.replace(/[^z]/g, "").length,
        300_000,
        "no output lost at exit",
      );
      // The exit event is the last event for the terminal.
      assertEquals(
        rec.log.filter((l) => l.endsWith(`:${t.id}`)).at(-1),
        `exit:${t.id}`,
      );
    }),
});

/** A deterministic mix of 1-, 2-, 3- and 4-byte UTF-8 characters (no newlines). */
function utf8Corpus(units: number): string {
  const alphabet = ["a", "é", "€", "😀", "中", "𝄞", "ß", "́", "Ω", "🏳️‍🌈", "~"];
  let s = "";
  let x = 7;
  for (let i = 0; i < units; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += alphabet[x % alphabet.length];
  }
  return s;
}

Deno.test({
  name:
    "stress: UTF-8 split across reads (incl. 1-byte writes) decodes exactly",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const dir = await Deno.makeTempDir({ prefix: "pty-utf8-" });
      try {
        const big = utf8Corpus(60_000);
        const small = utf8Corpus(1_500);
        await Deno.writeTextFile(`${dir}/big.txt`, big);
        await Deno.writeTextFile(`${dir}/small.txt`, small);
        const t = await quietShell(host, rec);
        for (
          const [name, cmd, want] of [
            ["cat", `cat ${dir}/big.txt`, big],
            // dd bs=1 writes one byte per syscall, so reads end mid-character all the time.
            ["dd", `dd if=${dir}/small.txt bs=1 2>/dev/null`, small],
          ] as const
        ) {
          const s = marker(`u8s${name}`);
          const e = marker(`u8e${name}`);
          const from = rec.text(t.id).length;
          await host.write(t.id, `${s.cmd}; ${cmd}; ${e.cmd}\r`);
          await rec.waitFor(t.id, e.text, 30_000, from);
          const got = between(rec.text(t.id), `${s.text}\r\n`, e.text);
          assertEquals(got.length, want.length, `${name}: length`);
          assert(got === want, `${name}: content`);
          assert(!got.includes("�"), `${name}: no replacement characters`);
        }
        // No event ever carries half a surrogate pair.
        for (const d of rec.data.get(t.id)!) {
          assert(
            d.data.isWellFormed(),
            `event ${d.seq} is not well-formed UTF-16`,
          );
        }
        await host.write(t.id, "exit\r");
        await rec.waitExit(t.id);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }),
});

Deno.test({
  name:
    "stress: binary and control bytes pass through like a one-shot UTF-8 decode",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const dir = await Deno.makeTempDir({ prefix: "pty-bin-" });
      try {
        // Every byte value but \n, 64 times over, plus raw ANSI/bell/backspace sequences.
        const unit = Array.from({ length: 256 }, (_, i) => i).filter((b) =>
          b !== 0x0a
        );
        const bytes = new Uint8Array([
          ...Array.from({ length: 64 }, () => unit).flat(),
          ...new TextEncoder().encode(
            "\x1b[31mred\x1b[0m\x07\b\t\x1b]0;title\x07",
          ),
        ]);
        await Deno.writeFile(`${dir}/bin`, bytes);
        const t = await quietShell(host, rec);
        const s = marker("binstart");
        const e = marker("binend");
        await host.write(t.id, `${s.cmd}; cat ${dir}/bin; ${e.cmd}\r`);
        await rec.waitFor(t.id, e.text, 30_000);
        const got = between(rec.text(t.id), `${s.text}\r\n`, e.text);
        // The streaming decoder must agree with decoding everything at once.
        const want = new TextDecoder().decode(bytes);
        assertEquals(got.length, want.length);
        assert(got === want, "binary output differs from a one-shot decode");
        assert(
          got.includes("\x00\x01\x02\x03"),
          "NULs and C0 controls survive",
        );
        assert(got.includes("\x1b[31mred\x1b[0m\x07"));
        await host.write(t.id, "exit\r");
        await rec.waitExit(t.id);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }),
});

/** Type `lines` into `cat > file` with echo off and return what the file got. */
async function pasteThroughCat(
  host: PtyHost,
  rec: Recorder,
  id: string,
  file: string,
  send: () => Promise<void>,
): Promise<string> {
  const ready = marker(`catready${id}`);
  const done = marker(`catdone${id}`);
  const from = rec.text(id).length;
  await host.write(id, `${ready.cmd}; cat > ${file}; ${done.cmd}\r`);
  await rec.waitFor(id, ready.text, 15_000, from);
  await send();
  await host.write(id, "\x04"); // EOF at the start of a line ends cat
  await rec.waitFor(id, done.text, 60_000, from);
  return await Deno.readTextFile(file);
}

Deno.test({
  name: "stress: 2000 unawaited writes keep their order (write chain)",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const dir = await Deno.makeTempDir({ prefix: "pty-burst-" });
      try {
        const t = await quietShell(host, rec);
        const lines = Array.from({ length: 2000 }, (_, i) =>
          `burst-${i}-${"é".repeat(i % 7)}\n`);
        const got = await pasteThroughCat(
          host,
          rec,
          t.id,
          `${dir}/out`,
          async () => {
            await Promise.all(lines.map((l) =>
              host.write(t.id, l)
            ));
          },
        );
        assertEquals(got, lines.join(""));
        await host.write(t.id, "exit\r");
        await rec.waitExit(t.id);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }),
});

Deno.test({
  name: "stress: a 1 MiB paste arrives intact (EAGAIN back-pressure)",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const dir = await Deno.makeTempDir({ prefix: "pty-paste-" });
      try {
        const t = await quietShell(host, rec);
        // 16 384 lines of 64 bytes (canonical mode caps a line at MAX_CANON, so keep them short).
        const lines: string[] = [];
        for (let i = 0; i < 16_384; i++) {
          const head = `L${i}:`;
          lines.push(
            head +
              "abcdefghijklmnopqrstuvwxyz0123456789".repeat(2).slice(
                0,
                63 - head.length,
              ) + "\n",
          );
        }
        const paste = lines.join("");
        assertEquals(new TextEncoder().encode(paste).length, 1 << 20);
        const t0 = performance.now();
        const got = await pasteThroughCat(host, rec, t.id, `${dir}/paste`, () =>
          host.write(t.id, paste));
        console.log(`1 MiB paste: ${Math.round(performance.now() - t0)} ms`);
        assertEquals(got.length, paste.length);
        assert(got === paste, "paste content differs");
        await host.write(t.id, "exit\r");
        await rec.waitExit(t.id);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }),
});

Deno.test({
  name: "stress: a resize storm settles on the last size",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const t = await quietShell(host, rec);
      let x = 3;
      for (let i = 0; i < 500; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        host.resize(t.id, 1 + (x % 400), 1 + ((x >> 9) % 200));
      }
      // Extremes are accepted.
      host.resize(t.id, 1, 1);
      host.resize(t.id, 10_000, 10_000);
      const big = marker("szbig");
      await host.write(t.id, `stty size; ${big.cmd}\r`);
      await rec.waitFor(t.id, big.text);
      assert(
        rec.text(t.id).includes("10000 10000"),
        "the extreme size took effect",
      );
      host.resize(t.id, 137, 43);
      const done = marker("szdone");
      const from = rec.text(t.id).length;
      await host.write(t.id, `stty size; ${done.cmd}\r`);
      await rec.waitFor(t.id, done.text, 15_000, from);
      assert(
        rec.text(t.id).slice(from).includes("43 137"),
        rec.text(t.id).slice(from),
      );
      // Interleaved with writes: still alive and answering.
      const alive = marker("alive");
      for (let i = 0; i < 100; i++) {
        host.resize(t.id, 80 + (i % 40), 24 + (i % 10));
        if (i % 10 === 0) void host.write(t.id, ":\r");
      }
      host.resize(t.id, 90, 30);
      await host.write(t.id, `stty size; ${alive.cmd}\r`);
      await rec.waitFor(t.id, alive.text);
      assert(rec.text(t.id).includes("30 90"));
      await host.write(t.id, "exit\r");
      assertEquals((await rec.waitExit(t.id)).exitCode, 0);
    }),
});

Deno.test({
  name: "stress: 50 sessions spawned and killed leak no tty/ptmx descriptors",
  ignore,
  fn: () =>
    withHost(async (host, rec) => {
      const before = openFds();
      const terms = [];
      for (let i = 0; i < 50; i++) {
        terms.push(
          await host.spawn({ cols: 80, rows: 24, shell: SH, cwd: "/tmp" }),
        );
      }
      // While alive: one master each (the spare ptmx and the slave node-pty leaks are closed).
      const live = openFds().length - before.length;
      assert(live <= 50 * 2 + 4, `${live} fds for 50 live terminals`);
      for (const [i, t] of terms.entries()) {
        if (i % 2 === 0) host.kill(t.id);
        else await host.write(t.id, "exit\r");
      }
      for (const t of terms) await rec.waitExit(t.id);
      assertEquals(host.size, 0);
      const after = openFds();
      const leaked = after.filter((fd) => !before.includes(fd));
      // node-pty 1.1.0 still leaks the kqueue of its macOS exit thread (1 per terminal; it cannot
      // be told apart from Deno's own kqueues). Anything beyond that is ours.
      const allowed = Deno.build.os === "darwin" ? 50 : 0;
      assert(
        leaked.length <= allowed,
        `${leaked.length} fds leaked by 50 terminals (allowed ${allowed})`,
      );
      // And none of them is a terminal device.
      for (const fd of leaked) {
        let chr = false;
        try {
          chr = Deno.statSync(`/dev/fd/${fd}`).isCharDevice ?? false;
        } catch { /* a kqueue cannot be stat'ed */ }
        assert(!chr, `fd ${fd} is a leaked character device (a pty)`);
      }
      console.log(
        `fds: ${before.length} before, +${live} live, +${leaked.length} after exit`,
      );
    }),
});
