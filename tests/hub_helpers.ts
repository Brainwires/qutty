// Shared helpers for the agent hub tests (not a test module itself).

import {
  type ControlCommand,
  type ControlResult,
  HubCore,
  type HubEnv,
} from "../lib/hub/core.ts";
import { ScreenMirror } from "../lib/hub/mirror.ts";
import type { ConfigFs } from "../lib/hub/integration.ts";
import type {
  AskRequest,
  HubIdentity,
  HubSnapshot,
} from "../lib/hub/protocol.ts";
import { RequestContext } from "@rullama/mcp-server";

/** A HubEnv that records what the hub asked of its environment. */
export class FakeEnv implements HubEnv {
  mirrors = new Map<string, ScreenMirror>();
  writes: { tileId: string; text: string }[] = [];
  asks: AskRequest[] = [];
  closed: string[] = [];
  controls: ControlCommand[] = [];
  snapshots: HubSnapshot[] = [];
  /** What the page answers a control command with (default: ok; a spawn makes `pty-9`). */
  controlResult: (command: ControlCommand) => ControlResult = (c) =>
    c.kind === "spawn" ? { ok: true, tileId: "pty-9" } : { ok: true };
  companionMails = 0;

  mirror(tileId: string) {
    return this.mirrors.get(tileId);
  }
  write(tileId: string, text: string): Promise<void> {
    this.writes.push({ tileId, text });
    return Promise.resolve();
  }
  ask(request: AskRequest): void {
    this.asks.push(request);
  }
  askClosed(id: string): void {
    this.closed.push(id);
  }
  control(command: ControlCommand): Promise<ControlResult> {
    this.controls.push(command);
    return Promise.resolve(this.controlResult(command));
  }
  companionMail(): void {
    this.companionMails++;
  }
  changed(snapshot: HubSnapshot): void {
    this.snapshots.push(snapshot);
  }
}

/** A hub with tiles `pty-1` (claude), `pty-2` (codex) and `pty-3` (a shell). */
export function hubWithTiles(): { core: HubCore; env: FakeEnv } {
  const env = new FakeEnv();
  const core = new HubCore(env);
  core.addTile({ id: "pty-1", harness: "claude", cwd: "/work/a" });
  core.addTile({ id: "pty-2", harness: "codex", cwd: "/work/b" });
  core.addTile({ id: "pty-3" });
  return { core, env };
}

export const tile = (tileId: string): HubIdentity => ({ role: "tile", tileId });
export const COMPANION_ID: HubIdentity = { role: "companion" };

/** A request context as the server builds it for a connection with `identity`. */
export function ctxFor(
  identity: HubIdentity,
  signal?: AbortSignal,
): RequestContext {
  const ctx = new RequestContext(1);
  ctx.connection = { id: "test", transport: "test", identity };
  if (signal) ctx.signal = signal;
  return ctx;
}

/** The text of a tool result's first content block. */
export function resultText(
  r: { content: { type: string; text?: string }[] },
): string {
  return r.content[0]?.text ?? "";
}

/** Poll `cond` until it returns a truthy value (or throw after `ms`). */
export async function waitUntil<T>(
  cond: () => T | Promise<T>,
  ms = 3000,
  what = "condition",
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** ConfigFs over Deno's file APIs (the app uses libc writes; the logic is the same). */
export const denoConfigFs: ConfigFs = {
  async read(path) {
    try {
      return await Deno.readTextFile(path);
    } catch {
      return undefined;
    }
  },
  async write(path, text, mode) {
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, text, { mode });
    await Deno.chmod(path, mode);
  },
  async remove(path) {
    await Deno.remove(path);
  },
  async mode(path) {
    try {
      return ((await Deno.stat(path)).mode ?? 0) & 0o777;
    } catch {
      return undefined;
    }
  },
  async realPath(path) {
    try {
      return await Deno.realPath(path);
    } catch {
      return path;
    }
  },
};
