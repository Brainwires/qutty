// The shared Docker sandbox against a real Docker (skipped when docker is not installed or not
// running): a container from a small image started through the hidden-PTY docker CLI
// (desktop/sandbox.ts), two sandboxed tiles spawned through the tapped PTY host (a file one
// writes, the other reads), qutty-mcp inside a tile answering whoami / list_peers over TCP +
// token, a host tile beside them, and a cleanup that leaves no container or volume behind. Every
// name is test-specific (`qutty-test-<pid>`), so it never touches a real sandbox.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { installHubFiles } from "../desktop/hub.ts";
import { PtyHost, setPtyTaps, setSandboxProvider } from "../desktop/pty.ts";
import {
  findDocker,
  PtyDockerCli,
  SandboxService,
} from "../desktop/sandbox.ts";
import { DEFAULT_SANDBOX } from "../lib/sandbox/settings.ts";
import { Recorder } from "./pty_helpers.ts";
import { fixture, tapHub } from "./socket_helpers.ts";

const IMAGE = "ubuntu:24.04";

function dockerWorks(): boolean {
  if (Deno.build.os === "windows") return false;
  try {
    return new Deno.Command("docker", {
      args: ["version", "--format", "{{.Server.Version}}"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

function docker(...args: string[]): { ok: boolean; out: string } {
  const r = new Deno.Command("docker", {
    args,
    stdout: "piped",
    stderr: "piped",
  })
    .outputSync();
  return {
    ok: r.success,
    out: new TextDecoder().decode(r.stdout) +
      new TextDecoder().decode(r.stderr),
  };
}

const ignore = !dockerWorks();
const NAME = `qutty-test-${Deno.pid}`;
const VOLUME = `qutty-test-home-${Deno.pid}`;

/** A shell line for a tile, with a marker printed after it (so its output can be awaited). */
const line = (cmd: string, mark: string) => `${cmd}; echo ${mark}-''done\r`;

Deno.test({
  name:
    "docker sandbox: two tiles share one container, qutty-mcp answers over TCP, cleanup is complete",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const f = await fixture();
    await installHubFiles(f.hub.paths);
    const rec = new Recorder();
    const host = new PtyHost(rec.emit, { tapped: true });
    const cli = new PtyDockerCli();
    const sandbox = new SandboxService({
      docker: cli,
      facts: {
        quttyDir: f.hub.paths.dir,
        hostConfigs: [],
        linux: Deno.build.os === "linux",
        volume: VOLUME,
      },
      names: () => NAME,
    });
    tapHub(f.hub);
    setSandboxProvider(sandbox);
    const ctl = sandbox.controller("test");
    try {
      ctl.configure({ ...DEFAULT_SANDBOX, mode: "shared", image: IMAGE });
      const pulled = docker("image", "inspect", IMAGE).ok;
      if (!pulled) assert(docker("pull", IMAGE).ok, "pull the test image");
      await ctl.ensure();
      assertEquals(ctl.status().phase, "running");

      const spawn = (sandboxed: boolean) =>
        host.spawn({
          cols: 120,
          rows: 30,
          ...(sandboxed ? { sandbox: true } : {}),
        }, {
          owner: "test",
        });
      const a = await spawn(true);
      const b = await spawn(true);
      const h = await spawn(false);
      await rec.waitFor(a.id, "#", 20_000).catch(() => {}); // root's prompt

      // A file written in one tile is seen in the other.
      await host.write(
        a.id,
        line("echo shared-$((6*7)) > /tmp/qutty-shared", "A"),
      );
      await rec.waitFor(a.id, "A-done", 20_000);
      await host.write(b.id, line("cat /tmp/qutty-shared", "B"));
      await rec.waitFor(b.id, "B-done", 20_000);
      assertStringIncludes(rec.text(b.id), "shared-42");

      // The shims are on PATH inside, and qutty-mcp reaches the hub over TCP + token.
      const init =
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}';
      const call = (id: number, tool: string) =>
        `{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"${tool}","arguments":{}}}`;
      const script = [
        init,
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        call(2, "whoami"),
        call(3, "list_peers"),
      ].map((l) => `'${l}'`).join(" ");
      await host.write(
        a.id,
        line(
          `(printf '%s\\n' ${script}; sleep 2) | qutty-mcp > /tmp/mcp.out; grep -c '"result"' /tmp/mcp.out; grep -o 'pty-[0-9]*' /tmp/mcp.out | sort -u | tr '\\n' ' '`,
          "M",
        ),
      );
      await rec.waitFor(a.id, "M-done", 30_000);
      const out = rec.text(a.id);
      const answered = out.slice(out.lastIndexOf("M-''done"));
      for (const id of [a.id, b.id, h.id]) {
        assert(new RegExp(`\\b${id}\\b`).test(out), `${id} in ${answered}`);
      }
      const peers = f.hub.core.registry.list();
      assertEquals(peers.find((t) => t.id === a.id)?.sandbox, true);
      assertEquals(peers.find((t) => t.id === h.id)?.sandbox, undefined);

      for (const t of [a, b, h]) host.kill(t.id);
      await rec.until("tiles ended", () => rec.exits.size === 3, 20_000);
    } finally {
      setSandboxProvider(undefined);
      setPtyTaps(undefined);
      await ctl.stop().catch(() => {});
      docker("rm", "-f", NAME);
      docker("volume", "rm", "-f", VOLUME);
      await f.dispose();
    }
    assertEquals(
      docker("ps", "-aq", "--filter", `name=^${NAME}$`).out.trim(),
      "",
    );
    assertEquals(
      docker("volume", "ls", "-q", "--filter", `name=^${VOLUME}$`).out.trim(),
      "",
    );
  },
});

Deno.test({
  name:
    "docker sandbox: the keepalive stops the container when its docker CLI dies",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const name = `${NAME}-ka`;
    const quttyDir = await Deno.makeTempDir({ prefix: "qutty-ka" });
    await Deno.mkdir(`${quttyDir}/bin`);
    const cli = new PtyDockerCli();
    const sandbox = new SandboxService({
      docker: cli,
      facts: {
        quttyDir,
        hostConfigs: [],
        linux: Deno.build.os === "linux",
        volume: `${VOLUME}-ka`,
      },
      names: () => name,
    });
    const ctl = sandbox.controller("ka");
    try {
      ctl.configure({
        ...DEFAULT_SANDBOX,
        mode: "shared",
        image: IMAGE,
        network: false,
      });
      await ctl.ensure();
      const running = () =>
        docker("inspect", "--format", "{{.State.Running}}", name).out.trim();
      assertEquals(running(), "true");
      // What the app's exit does to the keepalive: its docker CLI process dies.
      const until = Date.now() + 10_000;
      while (
        !docker("top", name, "-o", "pid,args").out.includes("while read") &&
        Date.now() < until
      ) await new Promise((r) => setTimeout(r, 100));
      assertStringIncludes(
        docker("top", name, "-o", "pid,args").out,
        "while read",
      );
      const ka = new Deno.Command("pkill", {
        args: ["-f", `docker exec -i ${name} `],
      }).outputSync();
      assert(ka.success, "the keepalive's docker CLI was found");
      const deadline = Date.now() + 20_000;
      while (running() === "true" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assertEquals(running(), "false");
    } finally {
      docker("rm", "-f", name);
      docker("volume", "rm", "-f", `${VOLUME}-ka`);
      await Deno.remove(quttyDir, { recursive: true }).catch(() => {});
    }
    assert(await findDocker());
  },
});
