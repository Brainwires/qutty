// An agent tile's Claude Code session: headless `claude -p` in stream-json mode, run the way the
// companion's brain runs it (desktop/companion-brain.ts): in a hidden PTY of the PTY host (the
// app starts programs through the PTY path), never shown in a tile and not tapped by
// the hub's mirrors. It uses the user's own Claude Code login.
//
// The wrapper (lib/agent/claude-stream.ts `claudeAgentArgv`): `env` sets the agent tile's hub
// variables (QUTTY_SOCK, QUTTY_TILE_ID: its own socket, so it is a hub peer like any agent tile
// and its permission questions reach the tile), bash puts the terminal in raw mode, prints a ready
// line and runs Claude Code with its stdin a pipe from the terminal. Each user message is one
// JSON line written to the PTY; each output line is one event (ClaudeStreamParser). An interrupt
// is a `control_request` line.

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
  AGENT_READY,
  agentUserLine,
  claudeAgentArgv,
  ClaudeStreamParser,
  interruptLine,
} from "../lib/agent/claude-stream.ts";

/** How long Claude Code may take to get its terminal ready. */
const START_TIMEOUT_MS = 15_000;
/** How many diagnostic lines are kept for an exit's reason. */
const LOG_LINES = 6;

/** An agent process's last diagnostic lines, and why it ended in a few words. */
export class ExitLog {
  #lines: string[] = [];
  #name: string;

  /** @param name What the reason calls the agent (`Claude Code`). */
  constructor(name: string) {
    this.#name = name;
  }

  remember(line: string): void {
    this.#lines.push(line);
    if (this.#lines.length > LOG_LINES) this.#lines.shift();
  }

  /** Why it ended (its last diagnostic line when there is one). */
  reason(exit: PtyExitEvent): string {
    const last = this.#lines.at(-1);
    const how = exit.signal
      ? `signal ${exit.signal}`
      : `exit code ${exit.exitCode}`;
    return last
      ? `${this.#name} ended: ${last.slice(0, 200)} (${how})`
      : `${this.#name} ended (${how})`;
  }
}

export interface ClaudeAgentOptions {
  /** The tile's hub variables (its socket). */
  env: Record<string, string>;
  /** The flags that load the hub's MCP server and hooks (none when the user installed them). */
  hubArgs: readonly string[];
  /** The `claude` executable (default: looked up like the `+` picker does). */
  claude?: string;
  /** Every raw output chunk (fixture recording, diagnostics). */
  onRaw?(chunk: string): void;
}

/** Claude Code as an {@linkcode AgentAdapter}. */
export class ClaudeAgentAdapter implements AgentAdapter {
  readonly label = "Claude Code";
  readonly images = true;
  #opts: ClaudeAgentOptions;
  #host: PtyHost | undefined;
  #id: string | undefined;
  #parser = new ClaudeStreamParser();
  #log = new ExitLog("Claude Code");
  #stopped = false;
  #interrupts = 0;

  constructor(opts: ClaudeAgentOptions) {
    this.#opts = opts;
  }

  async start(
    spec: AgentSessionSpec,
    sink: AgentSink,
    _hooks: AgentHooks,
  ): Promise<void> {
    const claude = this.#opts.claude ?? await resolveProgram("claude");
    if (!claude) {
      throw new Error(
        "Claude Code is not installed (no `claude` on PATH or in ~/.local/bin)",
      );
    }
    let ready: () => void = () => {};
    let failed: (e: Error) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    let isReady = false;
    let raw = "";
    const host = new PtyHost((event, data) => {
      if (event === "data") {
        const chunk = (data as PtyDataEvent).data;
        this.#opts.onRaw?.(chunk);
        if (!isReady) {
          raw += chunk;
          if (raw.includes(AGENT_READY)) {
            isReady = true;
            raw = "";
            ready();
          }
        }
        for (const e of this.#parser.push(chunk)) {
          if (e.kind === "log") this.#log.remember(e.message);
          sink.event(e);
        }
        return;
      }
      const exit = data as PtyExitEvent;
      const reason = this.#log.reason(exit);
      this.#host = undefined;
      if (!isReady) failed(new Error(reason));
      else if (!this.#stopped) {
        sink.event({ kind: "exit", reason, at: Date.now() });
      }
    });
    this.#host = host;
    const { program, args } = claudeAgentArgv({
      claude,
      spec,
      hubArgs: this.#opts.hubArgs,
      env: this.#opts.env,
    });
    const spawned = await host.spawn(
      { cols: 400, rows: 50, program, args, cwd: spec.cwd },
      { owner: "agent" },
    );
    this.#id = spawned.id;
    const timer = setTimeout(
      () => failed(new Error("Claude Code did not start in time")),
      START_TIMEOUT_MS,
    );
    try {
      await started;
    } catch (e) {
      this.stop();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: AgentMessage): Promise<void> {
    if (!this.#host || !this.#id) throw new Error("the session is not running");
    await this.#host.write(this.#id, agentUserLine(message));
  }

  async interrupt(): Promise<void> {
    if (!this.#host || !this.#id) return;
    await this.#host.write(
      this.#id,
      interruptLine(`qutty-interrupt-${++this.#interrupts}`),
    );
  }

  stop(): void {
    this.#stopped = true;
    if (this.#host && this.#id) this.#host.kill(this.#id);
  }
}
