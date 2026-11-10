// The companion's default brain: headless Claude Code in a hidden PTY, the pattern desktop/ssh.ts
// uses for scp/sftp. The packaged app has no `--allow-run`, so the process is started through the
// PTY host's node-pty fork, in a PtyHost of its own that is never shown in a tile (and not tapped
// by the hub: it has no tile socket). It uses the user's own Claude Code login: Qutty holds no API
// key for it.
//
// The protocol (lib/companion/brain.ts): bash puts the terminal in raw mode, prints a ready line
// and runs `claude -p --input-format stream-json --output-format stream-json --verbose
// --include-partial-messages --mcp-config <companion config> --strict-mcp-config --tools ""
// --allowedTools mcp__qutty --no-session-persistence --append-system-prompt <role>`, its stdin a
// pipe from the terminal. Each user turn is one JSON line written to the PTY; each output line is
// one event. One session lives across turns until it exits or is stopped.
//
// The second brain, a local Ollama model (`ollamaCompanionBrain`): lib/companion/inference-brain.ts
// over `@rullama/provider`'s `OllamaChatProvider`, Ollama's native `/api/chat` on 127.0.0.1:11434
// (the app's one `netConnect` permission). It does the whole tool round trip (native
// `tool_calls`, results as `role: "tool"` messages) and takes `ChatOptions.signal`, so stopping
// the companion closes the request and Ollama stops generating.
//
// The third, the API key brain (`anthropicCompanionBrain`): the same loop over Anthropic's
// Messages API (lib/companion/anthropic-provider.ts, api.anthropic.com) with the user's API key,
// which the hub extension keeps in the OS keychain (its own namespace of Denext's secure store)
// and reads for each request; the page never sees it.

import { OllamaChatProvider } from "@rullama/provider";
import {
  ANTHROPIC_MODELS,
  AnthropicApiProvider,
} from "../lib/companion/anthropic-provider.ts";
import {
  type BrainModel,
  COMPANION_MODELS,
} from "../lib/companion/settings.ts";
import { PtyHost, resolveProgram } from "./pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "./pty.ts";
import { detectOllama, OLLAMA_URL } from "./shell-agent.ts";
import {
  type CompanionTools,
  InferenceBrain,
} from "../lib/companion/inference-brain.ts";
import {
  type BrainAdapter,
  type BrainSink,
  claudeBrainArgv,
  READY_MARKER,
  StreamJsonParser,
  userTurnLine,
} from "../lib/companion/brain.ts";

/** How long Claude Code may take to get its terminal ready. */
const START_TIMEOUT_MS = 15_000;
/** How many diagnostic lines are kept for an exit's reason. */
const LOG_LINES = 6;

export interface ClaudeCodeBrainOptions {
  /** The generated MCP config (the hub's companion socket). */
  mcpConfig: string;
  /** The session's working folder (no project of the user's: `~/.qutty/companion`). */
  cwd: string;
  /** The `claude` executable (default: looked up like the `+` picker does). */
  claude?: string;
  model?: string;
  /** Where node-pty's spawn-helper may be copied (the app-support folder). */
  appSupportDir?: string;
  /** Every raw output chunk (fixture recording, diagnostics). */
  onRaw?(chunk: string): void;
}

/** Claude Code as a {@linkcode BrainAdapter}. */
export class ClaudeCodeBrain implements BrainAdapter {
  readonly label = "Claude Code";
  #opts: ClaudeCodeBrainOptions;
  #host: PtyHost | undefined;
  #id: string | undefined;
  #parser = new StreamJsonParser();
  #log: string[] = [];
  #stopped = false;

  constructor(opts: ClaudeCodeBrainOptions) {
    this.#opts = opts;
  }

  async start(sink: BrainSink): Promise<void> {
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
          if (raw.includes(READY_MARKER)) {
            isReady = true;
            raw = "";
            ready();
          }
        }
        for (const e of this.#parser.push(chunk)) {
          if (e.kind === "log") this.#remember(e.message);
          sink.event(e);
        }
        return;
      }
      const exit = data as PtyExitEvent;
      const reason = this.#reason(exit);
      this.#host = undefined;
      if (!isReady) failed(new Error(reason));
      else if (!this.#stopped) sink.exited(reason);
    });
    this.#host = host;
    const { program, args } = claudeBrainArgv({
      claude,
      mcpConfig: this.#opts.mcpConfig,
      ...(this.#opts.model ? { model: this.#opts.model } : {}),
    });
    const spawned = await host.spawn(
      { cols: 400, rows: 50, program, args, cwd: this.#opts.cwd },
      { appSupportDir: this.#opts.appSupportDir, owner: "companion" },
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

  async send(text: string): Promise<void> {
    if (!this.#host || !this.#id) throw new Error("the session is not running");
    await this.#host.write(this.#id, userTurnLine(text));
  }

  stop(): void {
    this.#stopped = true;
    if (this.#host && this.#id) this.#host.kill(this.#id);
  }

  #remember(line: string): void {
    this.#log.push(line);
    if (this.#log.length > LOG_LINES) this.#log.shift();
  }

  /** Why the session ended, in a few words (its last diagnostic line when there is one). */
  #reason(exit: PtyExitEvent): string {
    const last = this.#log.at(-1);
    const how = exit.signal
      ? `signal ${exit.signal}`
      : `exit code ${exit.exitCode}`;
    return last
      ? `${last.slice(0, 200)} (${how})`
      : `Claude Code ended (${how})`;
  }
}

/** Whether Ollama lists `model` (a name without a tag is `:latest`). */
export function ollamaHasModel(
  models: readonly string[],
  model: string,
): boolean {
  return models.includes(model) ||
    (!model.includes(":") && models.includes(`${model}:latest`));
}

/**
 * The companion on Anthropic's API with the user's key (`key()`: the hub's keychain entry, read
 * for every request), `model` one of Settings' aliases (`""`: the default model).
 */
export function anthropicCompanionBrain(
  model: string,
  key: () => Promise<string | null>,
  tools: CompanionTools,
  fetchFn?: typeof fetch,
): BrainAdapter {
  const alias: BrainModel = COMPANION_MODELS.includes(model as BrainModel)
    ? model as BrainModel
    : "";
  const id = ANTHROPIC_MODELS[alias];
  return new InferenceBrain({
    label: `Anthropic API (${id})`,
    provider: new AnthropicApiProvider({
      key,
      model: id,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    }),
    tools,
    async check() {
      if (!await key()) {
        throw new Error("no Anthropic API key is saved (Settings → Companion)");
      }
    },
  });
}

/** The companion on a local Ollama model, with the hub's tools as `tools`. */
export function ollamaCompanionBrain(
  model: string,
  tools: CompanionTools,
  baseUrl = OLLAMA_URL,
): BrainAdapter {
  return new InferenceBrain({
    label: `Ollama (${model})`,
    provider: new OllamaChatProvider(model, baseUrl),
    tools,
    async check() {
      const models = await detectOllama(baseUrl);
      if (models === undefined) {
        throw new Error(`no Ollama answers at ${baseUrl}`);
      }
      if (!ollamaHasModel(models, model)) {
        throw new Error(
          `Ollama has no model "${model}" (ollama pull ${model})`,
        );
      }
    },
  });
}
