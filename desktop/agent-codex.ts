// An agent tile's Codex session: `codex app-server` (JSON-RPC over stdio, lib/agent/codex-app-server.ts)
// run the way Claude Code's adapter runs `claude -p` (desktop/agent-claude.ts): in a hidden PTY of
// the PTY host, never shown in a tile and not tapped by the hub's mirrors. It uses the user's own
// Codex login and config (~/.codex), with the tile's hub variables set (its socket), so a Codex
// with Qutty's integration installed is a hub peer like any agent tile.
//
// The wrapper (`codexAgentArgv`): `env` sets the variables, bash puts the terminal in raw mode,
// prints a ready line and runs `codex app-server` with its stdin a pipe from the terminal. Each
// JSON-RPC message is one line each way. Approvals arrive as the server's requests and are asked
// in the tile through `hooks.approve` (the session layer), not through the hub's `approve_tool`.

import { ExitLog } from "./agent-claude.ts";
import { PtyHost, resolveProgram } from "./pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "./pty.ts";
import type {
  AgentAdapter,
  AgentHooks,
  AgentMessage,
  AgentSessionSpec,
  AgentSink,
} from "../lib/agent/adapter.ts";
import {
  CODEX_READY,
  codexAgentArgv,
  CodexAppServer,
} from "../lib/agent/codex-app-server.ts";

/** How long Codex may take to get its terminal ready and answer the handshake. */
const START_TIMEOUT_MS = 20_000;

export interface CodexAgentOptions {
  /** The tile's hub variables (its socket). */
  env: Record<string, string>;
  /** The `codex` executable (default: looked up like the `+` picker does). */
  codex?: string;
  /** Qutty's version (the client info Codex logs). */
  version?: string;
}

/** Codex as an {@linkcode AgentAdapter}. */
export class CodexAgentAdapter implements AgentAdapter {
  readonly label = "Codex";
  readonly images = true;
  #opts: CodexAgentOptions;
  #host: PtyHost | undefined;
  #id: string | undefined;
  #client: CodexAppServer | undefined;
  #log = new ExitLog("Codex");
  #stopped = false;

  constructor(opts: CodexAgentOptions) {
    this.#opts = opts;
  }

  async start(
    spec: AgentSessionSpec,
    sink: AgentSink,
    hooks: AgentHooks,
  ): Promise<void> {
    const codex = this.#opts.codex ?? await resolveProgram("codex");
    if (!codex) {
      throw new Error("Codex is not installed (no `codex` on PATH)");
    }
    let ready: () => void = () => {};
    let failed: (e: Error) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    let isReady = false;
    let raw = "";
    const client = new CodexAppServer({
      write: async (line) => {
        if (!this.#host || !this.#id) {
          throw new Error("the session is not running");
        }
        await this.#host.write(this.#id, `${line}\n`);
      },
      sink: {
        event: (e) => {
          if (e.kind === "log") this.#log.remember(e.message);
          sink.event(e);
        },
      },
      hooks,
      ...(this.#opts.version ? { version: this.#opts.version } : {}),
    });
    this.#client = client;
    const host = new PtyHost((event, data) => {
      if (event === "data") {
        const chunk = (data as PtyDataEvent).data;
        if (!isReady) {
          raw += chunk;
          const at = raw.indexOf(CODEX_READY);
          if (at < 0) return;
          isReady = true;
          const rest = raw.slice(at + CODEX_READY.length);
          raw = "";
          ready();
          client.push(rest);
          return;
        }
        client.push(chunk);
        return;
      }
      const exit = data as PtyExitEvent;
      const reason = this.#log.reason(exit);
      this.#host = undefined;
      client.close(reason);
      if (!isReady) failed(new Error(reason));
      else if (!this.#stopped) {
        sink.event({ kind: "exit", reason, at: Date.now() });
      }
    });
    this.#host = host;
    const { program, args } = codexAgentArgv({ codex, env: this.#opts.env });
    const spawned = await host.spawn(
      { cols: 400, rows: 50, program, args, cwd: spec.cwd },
      { owner: "agent" },
    );
    this.#id = spawned.id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Codex did not start in time")),
        START_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([started.then(() => client.open(spec)), timeout]);
    } catch (e) {
      this.stop();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: AgentMessage): Promise<void> {
    if (!this.#client || !this.#host) {
      throw new Error("the session is not running");
    }
    await this.#client.send(message);
  }

  async interrupt(): Promise<void> {
    await this.#client?.interrupt();
  }

  stop(): void {
    this.#stopped = true;
    this.#client?.close("stopped");
    if (this.#host && this.#id) this.#host.kill(this.#id);
  }
}
