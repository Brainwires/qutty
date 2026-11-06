/**
 * One window's shared sandbox: a small state machine over the `docker` CLI (injected, so the
 * tests drive it with a fake). It creates the container on first use, reuses it while its
 * settings are unchanged, says when they changed (applied by Restart), keeps it alive only as
 * long as the app (the keepalive) unless "keep running" is on, and can stop it, restart it and
 * reset its home volume.
 *
 * Phases: `off` (Settings → Sandbox is off) · `unavailable` (no docker, or the daemon is not
 * running) · `stopped` · `starting` (pulling the image, creating or starting) · `running` ·
 * `error` (the last attempt failed; the next one tries again).
 *
 * @module
 */

import {
  BRIDGE_ARGS,
  type ContainerState,
  inspectArgs,
  keepaliveArgs,
  parseGateways,
  parseInspect,
  runArgs,
  type SandboxSpec,
  sandboxSpec,
  specHash,
  VERSION_ARGS,
} from "./docker.ts";
import { DEFAULT_SANDBOX, type SandboxSettings } from "./settings.ts";

/** How the controller runs docker. */
export interface DockerCli {
  /**
   * Run `docker <args>` to completion: its exit code and output (ANSI and `\r` removed).
   * Rejects when docker cannot be started at all (not installed).
   */
  run(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ code: number; out: string }>;
  /** Start a long-lived `docker <args>` (the keepalive). */
  keepalive(args: string[]): KeepaliveHandle;
}

/** A running keepalive. */
export interface KeepaliveHandle {
  /** Let the container outlive the app (the keepalive exits without stopping it). */
  release(): void;
  /** Settles when the keepalive process ended. */
  readonly done: Promise<void>;
}

export type SandboxPhase =
  | "off"
  | "unavailable"
  | "stopped"
  | "starting"
  | "running"
  | "error";

/** What Settings shows. */
export interface SandboxStatus {
  phase: SandboxPhase;
  /** Why it is unavailable or failed, or what it is doing while starting. */
  message?: string;
  container: string;
  image: string;
  /** ISO time the container started (running only). */
  startedAt?: string;
  /** The settings changed since the container was created: Restart applies them. */
  stale?: boolean;
  /** Docker's server version, once known. */
  docker?: string;
}

/** A running sandbox, ready for `docker exec`. */
export interface SandboxReady {
  container: string;
  /** The project folder mounted ("" for none). */
  project: string;
  /** Extra addresses the hub should listen on (native Linux: the bridge gateway). */
  bridge: string[];
}

export interface SandboxFacts {
  /** `~/.qutty` on the host. */
  quttyDir: string;
  /** The host agent config folders that exist (`~/.claude`, `~/.codex`). */
  hostConfigs: string[];
  /** Native Linux Docker. */
  linux: boolean;
  /** The home volume (tests use their own). */
  volume?: string;
}

/** How long a pull may take; other commands get a minute. */
const PULL_MS = 30 * 60_000;
const RUN_MS = 60_000;

/** The last line or two of docker's output, for a message. */
function tail(out: string): string {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.slice(-2).join(" ").slice(0, 300) || "docker failed";
}

export class SandboxController {
  readonly name: string;
  #docker: DockerCli;
  #facts: SandboxFacts;
  #settings: SandboxSettings = { ...DEFAULT_SANDBOX };
  #status: SandboxStatus;
  #ensuring: Promise<SandboxReady> | undefined;
  #keepalive: KeepaliveHandle | undefined;
  #bridge: string[] | undefined;
  #onChange: (status: SandboxStatus) => void;

  constructor(opts: {
    docker: DockerCli;
    name: string;
    facts: SandboxFacts;
    onChange?: (status: SandboxStatus) => void;
  }) {
    this.#docker = opts.docker;
    this.name = opts.name;
    this.#facts = opts.facts;
    this.#onChange = opts.onChange ?? (() => {});
    this.#status = {
      phase: "off",
      container: this.name,
      image: this.#settings.image,
    };
  }

  get settings(): SandboxSettings {
    return { ...this.#settings };
  }

  status(): SandboxStatus {
    return { ...this.#status };
  }

  #spec(): SandboxSpec {
    return sandboxSpec(this.#settings, { name: this.name, ...this.#facts });
  }

  #set(patch: Partial<SandboxStatus>, replace = false): void {
    const base: SandboxStatus = replace
      ? {
        phase: this.#status.phase,
        container: this.name,
        image: this.#settings.image,
        ...(this.#status.docker ? { docker: this.#status.docker } : {}),
      }
      : this.#status;
    this.#status = { ...base, ...patch, image: this.#settings.image };
    this.#onChange(this.status());
  }

  /** New settings from the page. A running container keeps running (stale if they differ). */
  configure(settings: SandboxSettings): SandboxStatus {
    const before = this.#settings;
    this.#settings = { ...settings };
    if (settings.keepRunning !== before.keepRunning) this.#applyKeep();
    const phase = this.#status.phase;
    if (settings.mode === "off" && phase !== "running") {
      this.#set({ phase: "off" }, true);
    } else if (phase === "off") {
      this.#set({ phase: "stopped" }, true);
      void this.check();
    } else if (phase === "running") {
      this.#set({ stale: this.#created !== specHash(this.#spec()) });
    } else this.#set({});
    return this.status();
  }

  /** The config hash of the running container. */
  #created: string | undefined;

  /** Whether docker can be used: sets `unavailable` (with why) or leaves the phase. */
  async check(): Promise<boolean> {
    let r: { code: number; out: string };
    try {
      r = await this.#docker.run(VERSION_ARGS, { timeoutMs: 15_000 });
    } catch (e) {
      this.#set({
        phase: "unavailable",
        message: `Docker is not installed (${
          e instanceof Error ? e.message : String(e)
        }). Install Docker Desktop to use the sandbox.`,
      }, true);
      return false;
    }
    const version = r.out.split("\n").map((l) => l.trim()).find((l) =>
      /^\d+\.\d+/.test(l)
    );
    if (r.code !== 0 || !version) {
      this.#set({
        phase: "unavailable",
        message:
          "Docker is not running. Start Docker Desktop (or the docker service), then try again.",
      }, true);
      return false;
    }
    if (this.#status.phase === "unavailable") {
      this.#set(
        {
          phase: this.#settings.mode === "off" ? "off" : "stopped",
          docker: version,
        },
        true,
      );
    } else this.#set({ docker: version });
    return true;
  }

  /** Make sure the container runs (one attempt at a time; callers share it). */
  ensure(): Promise<SandboxReady> {
    if (this.#settings.mode === "off") {
      return Promise.reject(
        new Error("the sandbox is off (Settings → Sandbox)"),
      );
    }
    this.#ensuring ??= this.#ensure().finally(() => {
      this.#ensuring = undefined;
    });
    return this.#ensuring;
  }

  async #ensure(): Promise<SandboxReady> {
    try {
      if (!(await this.check())) throw new Error(this.#status.message);
      const spec = this.#spec();
      const hash = specHash(spec);
      let state = await this.#inspect();
      if (state && !state.running) {
        if (state.config === hash) {
          this.#set({ phase: "starting", message: "starting the container" });
          await this.#must(["start", this.name], RUN_MS);
        } else {
          await this.#docker.run(["rm", "-f", this.name], {
            timeoutMs: RUN_MS,
          });
          state = undefined;
        }
      }
      if (!state) await this.#create(spec);
      state = await this.#inspect();
      if (!state?.running) throw new Error("the container did not start");
      this.#created = state.config;
      this.#applyKeep();
      this.#set({
        phase: "running",
        startedAt: state.startedAt,
        stale: state.config !== hash,
      }, true);
      return {
        container: this.name,
        project: this.#settings.project,
        bridge: await this.#bridgeAddresses(),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (this.#status.phase !== "unavailable") {
        this.#set({ phase: "error", message }, true);
      }
      throw new Error(message);
    }
  }

  async #create(spec: SandboxSpec): Promise<void> {
    const have = await this.#docker.run(
      ["image", "inspect", "--format", "{{.Id}}", spec.image],
      { timeoutMs: RUN_MS },
    );
    if (have.code !== 0) {
      this.#set({ phase: "starting", message: `pulling ${spec.image}` });
      await this.#must(["pull", spec.image], PULL_MS);
    }
    this.#set({ phase: "starting", message: "creating the container" });
    await this.#must(runArgs(spec), RUN_MS);
  }

  async #must(args: string[], timeoutMs: number): Promise<string> {
    const r = await this.#docker.run(args, { timeoutMs });
    if (r.code !== 0) throw new Error(`docker ${args[0]}: ${tail(r.out)}`);
    return r.out;
  }

  async #inspect(): Promise<ContainerState | undefined> {
    const r = await this.#docker.run(inspectArgs(this.name), {
      timeoutMs: RUN_MS,
    });
    return r.code === 0 ? parseInspect(r.out) : undefined;
  }

  async #bridgeAddresses(): Promise<string[]> {
    if (!this.#facts.linux || !this.#settings.network) return [];
    if (this.#bridge) return this.#bridge;
    const r = await this.#docker.run(BRIDGE_ARGS, { timeoutMs: RUN_MS });
    this.#bridge = r.code === 0 ? parseGateways(r.out) : [];
    return this.#bridge;
  }

  /** Start or release the keepalive to match "keep running" (only while running). */
  #applyKeep(): void {
    if (this.#settings.keepRunning) {
      this.#keepalive?.release();
      this.#keepalive = undefined;
      return;
    }
    if (this.#keepalive || this.#created === undefined) return;
    const handle = this.#docker.keepalive(keepaliveArgs(this.name));
    this.#keepalive = handle;
    void handle.done.then(() => {
      if (this.#keepalive === handle) this.#keepalive = undefined;
    });
  }

  /** Stop the container (its tiles end). */
  async stop(): Promise<SandboxStatus> {
    await this.#ensuring?.catch(() => {});
    this.#keepalive?.release();
    this.#keepalive = undefined;
    this.#created = undefined;
    await this.#docker.run(["stop", "-t", "2", this.name], {
      timeoutMs: RUN_MS,
    });
    this.#set(
      { phase: this.#settings.mode === "off" ? "off" : "stopped" },
      true,
    );
    return this.status();
  }

  /** Stop and start again; with changed settings the container is created anew. */
  async restart(): Promise<SandboxStatus> {
    const stale = this.#status.stale === true;
    await this.stop();
    if (stale) {
      await this.#docker.run(["rm", "-f", this.name], { timeoutMs: RUN_MS });
    }
    await this.ensure().catch(() => {});
    return this.status();
  }

  /**
   * Remove the container and the home volume (agent logins and tools installed in `$HOME` go
   * with it). Fails while another window's sandbox still uses the volume.
   */
  async resetVolume(): Promise<SandboxStatus> {
    await this.stop();
    await this.#docker.run(["rm", "-f", this.name], { timeoutMs: RUN_MS });
    const volume = this.#spec().volume;
    const r = await this.#docker.run(["volume", "rm", volume], {
      timeoutMs: RUN_MS,
    });
    if (r.code !== 0 && !/no such volume/i.test(r.out)) {
      this.#set({
        phase: "error",
        message: `docker volume rm: ${tail(r.out)}`,
      });
    }
    return this.status();
  }
}
