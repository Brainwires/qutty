// An agent tile on a model Qutty calls itself (lib/agent/inference-agent.ts): a local Ollama model
// (`@rullama/provider`'s `OllamaChatProvider`, Ollama's API on 127.0.0.1:11434, the companion's
// Ollama brain's way) or Anthropic's Messages API with the user's key (the companion's API key
// brain's provider, the key read from the hub's keychain entry for every request; the page never
// sees it).
//
// The coding tools' host: files are read with Deno's read permission and written through the
// libc helpers (no `--allow-write`, desktop/libc.ts); commands run in a hidden PTY of their own
// (every program the app starts goes through the PTY path, desktop/pty.ts), `bash -lc` in the
// session's folder, stdout and stderr together, killed when the turn is interrupted.

import { OllamaChatProvider } from "@rullama/provider";
import {
  ANTHROPIC_HISTORY_CHARS,
  ANTHROPIC_MODELS,
  AnthropicApiProvider,
} from "../lib/companion/anthropic-provider.ts";
import {
  type BrainModel,
  COMPANION_MODELS,
} from "../lib/companion/settings.ts";
import {
  type CodingHost,
  InferenceAgentAdapter,
} from "../lib/agent/inference-agent.ts";
import type { AgentAdapter, AgentSessionSpec } from "../lib/agent/adapter.ts";
import { ollamaHasModel } from "./companion-brain.ts";
import { writeFileAtomic } from "./libc.ts";
import { PtyHost } from "./pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "./pty.ts";
import { detectOllama, OLLAMA_URL } from "./shell-agent.ts";

/** The longest a command may run. */
const COMMAND_TIMEOUT_MS = 10 * 60_000;

/** The desktop's {@linkcode CodingHost}. */
export const desktopCodingHost: CodingHost = {
  readFile: (path) => Deno.readTextFile(path),
  async writeFile(path, text) {
    const mode = await Deno.stat(path).then(
      (s) => (s.mode ?? 0o644) & 0o777,
      () => 0o644,
    );
    writeFileAtomic(path, new TextEncoder().encode(text), mode);
  },
  async run(command, cwd, signal) {
    let output = "";
    let done: (exit: PtyExitEvent) => void = () => {};
    const exited = new Promise<PtyExitEvent>((r) => done = r);
    const host = new PtyHost((event, data) => {
      if (event === "data") output += (data as PtyDataEvent).data;
      else done(data as PtyExitEvent);
    });
    const { id } = await host.spawn(
      {
        cols: 200,
        rows: 50,
        program: "/bin/bash",
        // No hub variables (the command is the agent's, not a tile's), no tty output processing.
        args: [
          "-c",
          'unset QUTTY_SOCK QUTTY_TILE_ID QUTTY_HUB QUTTY_TILE_TOKEN; stty raw -echo; exec /bin/bash -lc "$0" </dev/null',
          command,
        ],
        cwd,
      },
      { owner: "agent" },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<"stopped" | "timeout">((r) => {
      timer = setTimeout(() => r("timeout"), COMMAND_TIMEOUT_MS);
      if (signal.aborted) r("stopped");
      signal.addEventListener("abort", () => r("stopped"), { once: true });
    });
    try {
      const end = await Promise.race([exited, stopped]);
      if (end === "stopped" || end === "timeout") {
        host.kill(id);
        return {
          stdout: output,
          stderr: end === "timeout" ? "(timed out)" : "(interrupted)",
          code: 130,
        };
      }
      // deno-lint-ignore no-control-regex
      const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      return { stdout: clean, stderr: "", code: end.exitCode ?? 1 };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** What the inference sessions need from the hub. */
export interface InferenceAgentDeps {
  /** The Anthropic API key (the hub's keychain entry), `null` when none is saved. */
  anthropicKey(): Promise<string | null>;
  host?: CodingHost;
  ollamaUrl?: string;
  fetch?: typeof fetch;
  /** Ollama's models (`/api/tags`; `undefined`: no answer). Tests pass a fake. */
  detect?(baseUrl: string): Promise<string[] | undefined>;
}

/** The models the Anthropic agent's picker offers (the companion's aliases). */
export const ANTHROPIC_AGENT_MODELS = COMPANION_MODELS.map((m) => ({
  id: m,
  label: m || "default",
}));

/** A session on Anthropic's API, `spec.model` one of the companion's aliases. */
export function anthropicAgent(
  spec: AgentSessionSpec,
  deps: InferenceAgentDeps,
): InferenceAgentAdapter {
  const alias: BrainModel = COMPANION_MODELS.includes(spec.model as BrainModel)
    ? spec.model as BrainModel
    : "";
  const model = ANTHROPIC_MODELS[alias];
  return new InferenceAgentAdapter({
    label: `Anthropic API (${model})`,
    provider: new AnthropicApiProvider({
      key: deps.anthropicKey,
      model,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    }),
    host: deps.host ?? desktopCodingHost,
    model,
    history: { fresh: ANTHROPIC_HISTORY_CHARS },
    async check() {
      if (!await deps.anthropicKey()) {
        throw new Error("no Anthropic API key is saved (Settings → Companion)");
      }
      return ANTHROPIC_AGENT_MODELS;
    },
  });
}

/**
 * A session on a local Ollama model: `spec.model`, else the first model Ollama lists (the
 * picker offers them all). The model is checked on start.
 */
export function ollamaAgent(
  spec: AgentSessionSpec,
  deps: InferenceAgentDeps,
  models: string[],
): InferenceAgentAdapter {
  const baseUrl = deps.ollamaUrl ?? OLLAMA_URL;
  const model = spec.model || models[0] || "";
  return new InferenceAgentAdapter({
    label: `Ollama (${model})`,
    provider: new OllamaChatProvider(model, baseUrl),
    host: deps.host ?? desktopCodingHost,
    model,
    temperature: 0.2,
    check() {
      if (!model) throw new Error("Ollama has no models (ollama pull <model>)");
      if (!ollamaHasModel(models, model)) {
        throw new Error(
          `Ollama has no model "${model}" (ollama pull ${model})`,
        );
      }
      return Promise.resolve([
        { id: "", label: `default (${models[0]})` },
        ...models.map((m) => ({ id: m, label: m })),
      ]);
    },
  });
}

/**
 * A session on a local Ollama model, built once Ollama said what it has (the model must be known
 * before the adapter is): `start` lists the models, then starts the real adapter.
 */
export function deferredOllamaAgent(
  spec: AgentSessionSpec,
  deps: InferenceAgentDeps,
): AgentAdapter {
  const baseUrl = deps.ollamaUrl ?? OLLAMA_URL;
  let inner: AgentAdapter | undefined;
  let stopped = false;
  return {
    label: "Ollama",
    images: false,
    async start(spec2, sink, hooks) {
      const models = await (deps.detect ?? detectOllama)(baseUrl);
      if (models === undefined) {
        throw new Error(`no Ollama answers at ${baseUrl}`);
      }
      if (stopped) throw new Error("stopped");
      inner = ollamaAgent(spec, deps, models);
      await inner.start(spec2, sink, hooks);
    },
    send: (m) =>
      inner ? inner.send(m) : Promise.reject(new Error("not started")),
    interrupt: () => inner?.interrupt() ?? Promise.resolve(),
    stop() {
      stopped = true;
      inner?.stop();
    },
  };
}
