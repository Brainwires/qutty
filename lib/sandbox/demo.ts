/**
 * A pretend `docker` for the demo backend (plain-browser dev mode and the e2e suite) and the
 * unit tests: the real {@linkcode SandboxController} runs against it, so Settings → Sandbox, the
 * status line and the picker behave as in the app with no Docker anywhere. Its knobs (not
 * installed, daemon down, a failing create) let tests reach every phase.
 *
 * @module
 */

import type { DockerCli, KeepaliveHandle, SandboxStatus } from "./lifecycle.ts";
import { SandboxController } from "./lifecycle.ts";
import type { SandboxSettings } from "./settings.ts";

/** A scripted docker: one container that exists or not, runs or not; the calls made. */
export class DemoDocker implements DockerCli {
  calls: string[] = [];
  installed = true;
  daemon = true;
  /** The image is present (else `pull` is called first). */
  image = false;
  container:
    | { running: boolean; config: string; startedAt: string; user?: string }
    | undefined;
  failRun = false;
  /** Extra replies by command (`network` → its output). */
  replies: Record<string, string> = {};
  keepalives: { args: string[]; released: boolean; end(): void }[] = [];

  run(args: string[]): Promise<{ code: number; out: string }> {
    if (!this.installed) return Promise.reject(new Error("no docker"));
    this.calls.push(args.slice(0, 2).join(" "));
    const ok = (out = "") => Promise.resolve({ code: 0, out });
    const fail = (out: string) => Promise.resolve({ code: 1, out });
    const c = this.container;
    switch (args[0]) {
      case "version":
        return this.daemon
          ? ok("29.9.2\n")
          : fail("Cannot connect to the Docker daemon");
      case "inspect":
        return c
          ? ok(`${c.running}|${c.config}|${c.startedAt}|demo|${c.user ?? ""}`)
          : fail("Error: No such container");
      case "image":
        return this.image ? ok("sha256:1") : fail("No such image");
      case "pull":
        this.image = true;
        return ok();
      case "run": {
        if (this.failRun) return fail("docker: invalid mount config\n");
        const label = (name: string) =>
          args.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
        const user = label("org.qutty.user");
        this.container = {
          running: true,
          config: label("org.qutty.config") ?? "",
          startedAt: new Date().toISOString(),
          ...(user ? { user } : {}),
        };
        return ok("abcdef\n");
      }
      case "start":
        if (c) {
          c.running = true;
          c.startedAt = new Date().toISOString();
        }
        return ok();
      case "stop":
        if (c) c.running = false;
        for (const k of this.keepalives.splice(0)) k.end();
        return ok();
      case "rm":
        this.container = undefined;
        return ok();
      default:
        return ok(this.replies[args[0]] ?? "");
    }
  }

  keepalive(args: string[]): KeepaliveHandle {
    let end = () => {};
    const done = new Promise<void>((r) => (end = r));
    const k = { args, released: false, end };
    this.keepalives.push(k);
    return {
      release: () => {
        k.released = true;
        end();
      },
      done,
    };
  }
}

/** The demo backend's sandbox: one window, the real state machine, a pretend docker. */
export function createDemoSandbox() {
  const ctl = new SandboxController({
    docker: new DemoDocker(),
    name: "qutty-sandbox-main",
    facts: { quttyDir: "/Users/demo/.qutty", hostConfigs: [], linux: false },
  });
  return {
    status: (): Promise<SandboxStatus> => Promise.resolve(ctl.status()),
    configure: (s: SandboxSettings): Promise<SandboxStatus> =>
      Promise.resolve(ctl.configure(s)),
    check: async (): Promise<SandboxStatus> => {
      await ctl.check();
      return ctl.status();
    },
    ensure: async (s: SandboxSettings): Promise<SandboxStatus> => {
      ctl.configure(s);
      await ctl.ensure();
      return ctl.status();
    },
    action: (a: SandboxAction): Promise<SandboxStatus> =>
      a === "restart"
        ? ctl.restart()
        : a === "stop"
        ? ctl.stop()
        : ctl.resetVolume(),
  };
}

/** The status line's buttons. */
export type SandboxAction = "restart" | "stop" | "resetVolume";
