// The SSH backend against a real sshd: a throwaway Alpine container (openssh + tmux) on a random
// loopback port, a generated key, a temporary home. It connects a tile through the new program
// spawn (ssh with the shared-connection options), runs a command, then uploads, lists and
// downloads through the control socket (the key is taken away first, so only the socket can
// have authenticated), checks the no-overwrite naming and the error paths, adds a -L port forward
// to the live master (`ssh -O forward`), connects through it and cancels it, and a tmux-on-connect
// tile. Skipped when Docker is not available. Run: deno test -A tests/
//
// The sanitizers are off, as in the other PTY tests: libc stays open, and ssh's persisted master
// outlives the test by design (it is told to exit at the end).

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { SshService, type SshTransferEvent } from "../desktop/ssh.ts";
import { marker, POSIX, Recorder, withHost } from "./pty_helpers.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };
const USER = "qutty";
const ALIAS = "sshd-test";

/** Run a command; `out` is its stdout, `err` its stderr (docker prints pull progress there). */
async function run(
  cmd: string[],
  timeoutMs = 60_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return {
      ok: r.success,
      out: new TextDecoder().decode(r.stdout),
      err: new TextDecoder().decode(r.stderr),
    };
  } catch (err) {
    return { ok: false, out: "", err: String(err) };
  }
}

const DOCKER = POSIX && (await run(["docker", "info"], 15_000)).ok;

/** The container's setup: sshd, a key-only user (unlocked: adduser -D locks it), fixtures, tmux. */
const SETUP = [
  "apk add --no-cache openssh tmux >/dev/null",
  "ssh-keygen -A",
  `adduser -D -s /bin/sh ${USER}`,
  `sed -i 's/^${USER}:!/${USER}:*/' /etc/shadow`,
  `mkdir -p /home/${USER}/.ssh "/home/${USER}/in dir"`,
  `echo "$PUBKEY" > /home/${USER}/.ssh/authorized_keys`,
  `printf hello > "/home/${USER}/in dir/greet.txt"`,
  `chmod 700 /home/${USER}/.ssh && chmod 600 /home/${USER}/.ssh/authorized_keys`,
  `chown -R ${USER}:${USER} /home/${USER}`,
  // Alpine's sshd_config says `AllowTcpForwarding no`; the forward step needs it.
  "exec /usr/sbin/sshd -D -e -o AllowTcpForwarding=yes",
].join(" && ");

/** A loopback port nothing listens on (right now). */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitForSshd(port: number, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      const buf = new Uint8Array(64);
      const n = await Promise.race([
        conn.read(buf),
        new Promise<null>((r) => setTimeout(() => r(null), 2000)),
      ]);
      conn.close();
      if (
        n && new TextDecoder().decode(buf.subarray(0, n)).startsWith("SSH-")
      ) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("sshd did not come up");
}

Deno.test({
  name:
    "sshd: connect through spawn(program), transfer and list over the control socket, tmux",
  ignore: !DOCKER,
  ...opts,
  fn: async () => {
    // Short paths: the ControlPath (socket) has a 104-byte limit, and macOS's $TMPDIR is long.
    const tmp = await Deno.makeTempDir({ dir: "/tmp", prefix: "qutty-sshd-" });
    const home = `${tmp}/home`;
    await Deno.mkdir(`${home}/.ssh`, { recursive: true, mode: 0o700 });
    await Deno.mkdir(`${home}/Downloads`);
    const key = `${tmp}/id_ed25519`;
    assert(
      (await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]))
        .ok,
    );
    const pubkey = (await Deno.readTextFile(`${key}.pub`)).trim();

    const started = await run([
      "docker",
      "run",
      "-d",
      "--rm",
      "-p",
      "127.0.0.1:0:22",
      "-e",
      `PUBKEY=${pubkey}`,
      "alpine:3.20",
      "sh",
      "-c",
      SETUP,
    ], 180_000);
    assert(started.ok, started.err);
    const cid = started.out.trim().split("\n").at(-1)!;
    const events: SshTransferEvent[] = [];
    const controlPath = `${tmp}/cm-%C`;
    const configFile = `${home}/.ssh/config`;
    let service: SshService | undefined;
    try {
      const portOut = await run(["docker", "port", cid, "22/tcp"]);
      const port = Number(/:(\d+)\s*$/m.exec(portOut.out)?.[1]);
      assert(port > 0, portOut.out);
      await waitForSshd(port);

      // ssh reads the config from the real home, never $HOME: the service passes it with -F.
      await Deno.writeTextFile(
        configFile,
        `Host ${ALIAS}\n  HostName 127.0.0.1\n  Port ${port}\n  User ${USER}\n  IdentityFile ${key}\n` +
          `  IdentitiesOnly yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile ${tmp}/known_hosts\n  LogLevel ERROR\n`,
        { mode: 0o600 },
      );
      service = new SshService({
        home,
        appSupportDir: `${tmp}/support`,
        configFile,
        controlPath,
        emit: (_e, d) => events.push(d),
      });
      const target = { alias: ALIAS };
      const done = (id: string) =>
        events.find((e) => e.transferId === id && e.done);
      const waitDone = async (id: string, rec: Recorder) => {
        await rec.until(`transfer ${id}`, () => done(id) !== undefined, 60_000);
        return done(id)!;
      };

      await withHost(async (host, rec) => {
        // 1. A tile: ssh through the generic program spawn, with the shared-connection options.
        const cmd = await service!.command(target);
        assertEquals(cmd.label, ALIAS);
        assertStringIncludes(cmd.args.join(" "), `ControlPath=${controlPath}`);
        const tile = await host.spawn({
          cols: 100,
          rows: 30,
          program: cmd.program,
          args: cmd.args,
        });
        await rec.waitFor(tile.id, "$", 60_000);
        const m = marker("REMOTE");
        await host.write(tile.id, `${m.cmd}; echo H=$(hostname)\r`);
        await rec.waitFor(tile.id, m.text, 30_000);
        await rec.waitFor(tile.id, "H=", 30_000);
        // The master socket exists now; from here on the key is gone, so every later ssh/scp/sftp
        // can only have authenticated through the socket.
        const sockets = [];
        for await (const e of Deno.readDir(tmp)) {
          if (e.name.startsWith("cm-")) sockets.push(e.name);
        }
        assertEquals(sockets.length, 1, "one control socket");
        await Deno.rename(key, `${key}.away`);

        // 2. Upload a file and a folder (names with spaces) into a remote folder with a space.
        await Deno.mkdir(`${tmp}/local/sub dir`, { recursive: true });
        await Deno.writeTextFile(`${tmp}/local/a.txt`, "A".repeat(1000));
        await Deno.writeTextFile(`${tmp}/local/sub dir/b 1.txt`, "bb");
        await Deno.writeTextFile(`${tmp}/local/sub dir/c.txt`, "ccc");
        const up = await service!.upload({
          target,
          localPaths: [`${tmp}/local/a.txt`, `${tmp}/local/sub dir`],
          remoteDir: "~/in dir",
        });
        const upDone = await waitDone(up.transferId, rec);
        assertEquals(upDone.error, undefined, JSON.stringify(events));
        assertEquals(upDone.fileCount, 3);
        assertEquals(upDone.filesDone, 3);
        assertEquals(upDone.kind, "upload");
        // Events are snapshots per output chunk: a fast transfer may report several files in
        // one, so only the last file is certain to show.
        assertEquals(upDone.percent, 100);
        assert(
          events.some((e) =>
            e.transferId === up.transferId && e.percent === 100 &&
            ["a.txt", "b 1.txt", "c.txt"].includes(e.file ?? "")
          ),
        );

        // 3. List what arrived (through sftp), home and nested, sizes and kinds.
        const listing = await service!.list({ target, path: "~/in dir" });
        assertEquals(listing.path, `/home/${USER}/in dir`);
        assertEquals(
          listing.entries.map((e) =>
            `${e.kind}:${e.name}:${e.kind === "file" ? e.size : "-"}`
          ).sort(),
          ["dir:sub dir:-", "file:a.txt:1000", "file:greet.txt:5"],
        );
        const sub = await service!.list({
          target,
          path: `/home/${USER}/in dir/sub dir`,
        });
        assertEquals(sub.entries.map((e) => [e.name, e.size]).sort(), [[
          "b 1.txt",
          2,
        ], ["c.txt", 3]]);
        const top = await service!.list({ target });
        assertEquals(top.path, `/home/${USER}`);
        assert(
          top.entries.some((e) => e.name === "in dir" && e.kind === "dir"),
        );
        await assertRejects(
          () => service!.list({ target, path: "~/nope" }),
          Error,
          "No such file",
        );

        // 4. Download a file (twice: the second gets " (1)") and a folder, into a chosen folder.
        const dl1 = await service!.download({
          target,
          remotePath: "~/in dir/greet.txt",
          localDir: `${tmp}/dl`,
        })
          .catch(() => undefined);
        assertEquals(dl1, undefined, "a missing local folder is refused");
        await Deno.mkdir(`${tmp}/dl`);
        const d1 = await service!.download({
          target,
          remotePath: "~/in dir/greet.txt",
          localDir: `${tmp}/dl`,
        });
        assertEquals(d1.localPath, `${tmp}/dl/greet.txt`);
        assertEquals((await waitDone(d1.transferId, rec)).error, undefined);
        assertEquals(await Deno.readTextFile(d1.localPath!), "hello");
        const d2 = await service!.download({
          target,
          remotePath: `/home/${USER}/in dir/greet.txt`,
          localDir: `${tmp}/dl`,
        });
        assertEquals(d2.localPath, `${tmp}/dl/greet (1).txt`);
        assertEquals((await waitDone(d2.transferId, rec)).error, undefined);
        assertEquals(
          await Deno.readTextFile(`${tmp}/dl/greet.txt`),
          "hello",
          "the first is untouched",
        );
        assertEquals(
          await Deno.readTextFile(`${tmp}/dl/greet (1).txt`),
          "hello",
        );
        const d3 = await service!.download({
          target,
          remotePath: "~/in dir/sub dir",
          localDir: `${tmp}/dl`,
        });
        assertEquals((await waitDone(d3.transferId, rec)).error, undefined);
        assertEquals(
          await Deno.readTextFile(`${tmp}/dl/sub dir/b 1.txt`),
          "bb",
        );
        // The default folder is ~/Downloads.
        const d4 = await service!.download({
          target,
          remotePath: "~/in dir/a.txt",
        });
        assertEquals(d4.localPath, `${home}/Downloads/a.txt`);
        assertEquals((await waitDone(d4.transferId, rec)).error, undefined);
        assertEquals((await Deno.stat(d4.localPath!)).size, 1000);
        // A missing remote file is an error with scp's message.
        const d5 = await service!.download({
          target,
          remotePath: "~/in dir/missing.txt",
          localDir: `${tmp}/dl`,
        });
        const d5Done = await waitDone(d5.transferId, rec);
        assertStringIncludes(d5Done.error ?? "", "No such file");
        // Every transfer numbered its events from 1 without gaps.
        for (const id of [up, d1, d2, d3, d4, d5].map((t) => t.transferId)) {
          const seqs = events.filter((e) => e.transferId === id).map((e) =>
            e.seq
          );
          assertEquals(seqs, seqs.map((_, i) => i + 1), id);
        }
        assertEquals(service!.size, 0, "nothing left running");

        // 5. Cancel: a transfer that cannot finish (the key is gone and the socket is not used
        // when ControlPath points elsewhere) ends with "cancelled" when told to.
        // (Its own event list: a second service numbers its transfers from 1 again.)
        const loneEvents: SshTransferEvent[] = [];
        const lone = new SshService({
          home,
          configFile,
          controlPath: `${tmp}/none-%C`,
          emit: (_e, d) => loneEvents.push(d),
        });
        try {
          const c = await lone.download({
            target,
            remotePath: "~/in dir/a.txt",
            localDir: `${tmp}/dl`,
          });
          lone.cancel(c.transferId);
          const loneDone = () => loneEvents.find((e) => e.done);
          await rec.until("cancel", () => loneDone() !== undefined, 30_000);
          assert(
            ["cancelled", "Permission denied"].some((w) =>
              loneDone()!.error?.includes(w)
            ),
            loneDone()!.error,
          );
        } finally {
          await lone.dispose();
        }

        // 6. A -L forward added to the live master through its control socket (no key: only the
        // master can carry it), used, then cancelled. It points at the container's own sshd, so
        // what comes through is an SSH banner.
        const status = await service!.forwards(target);
        assertEquals(status, { master: true, active: [] });
        const fwd = {
          kind: "local" as const,
          bind: "127.0.0.1",
          port: freePort(),
          host: "127.0.0.1",
          hostPort: 22,
        };
        const added = await service!.addForward({ target, forward: fwd });
        assertEquals(added, { master: true, active: [fwd] });
        assertEquals((await service!.forwards(target)).active, [fwd]);
        await waitForSshd(fwd.port, 15_000);
        // A port that is taken: ssh's own error comes back.
        const taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
        try {
          await assertRejects(
            () =>
              service!.addForward({
                target,
                forward: { ...fwd, port: (taken.addr as Deno.NetAddr).port },
              }),
            Error,
            "forward",
          );
        } finally {
          taken.close();
        }
        assertEquals((await service!.forwards(target)).active, [fwd]);
        const cancelled = await service!.cancelForward({
          target,
          forward: fwd,
        });
        assertEquals(cancelled, { master: true, active: [] });
        await assertRejects(() =>
          Deno.connect({ hostname: "127.0.0.1", port: fwd.port })
        );
        // No master for a target nobody connected to: not running, and adding is refused.
        const other = { host: "127.0.0.1", port: 1 };
        assertEquals(await service!.forwards(other), {
          master: false,
          active: [],
        });
        await assertRejects(() =>
          service!.addForward({ target: other, forward: fwd })
        );

        // 7. tmux on connect: saved in qutty.conf for the same alias, the tile lands in tmux.
        await service!.saveHost({ alias: ALIAS, tmux: true });
        const tmuxCmd = await service!.command(target);
        assertEquals(tmuxCmd.args.slice(-5), [
          "tmux",
          "new",
          "-A",
          "-s",
          "qutty",
        ]);
        const tmuxTile = await host.spawn({
          cols: 100,
          rows: 30,
          program: "ssh",
          args: tmuxCmd.args,
        });
        await rec.waitFor(tmuxTile.id, "$", 60_000);
        await host.write(tmuxTile.id, "echo T=${TMUX%%,*}\r");
        await rec.waitFor(tmuxTile.id, "T=/tmp/tmux-", 30_000);
        await host.write(tmuxTile.id, "tmux kill-server\r");
        await rec.waitExit(tmuxTile.id, 30_000);

        await host.write(tile.id, "exit\r");
        await rec.waitExit(tile.id, 30_000);
      });
    } finally {
      await service?.dispose();
      // The persisted master (ControlPersist) would otherwise live on for 10 minutes.
      await run([
        "ssh",
        "-F",
        configFile,
        "-o",
        `ControlPath=${controlPath}`,
        "-O",
        "exit",
        ALIAS,
      ], 10_000);
      await run(["docker", "rm", "-f", cid], 30_000);
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  },
});
