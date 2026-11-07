// The shell agent's model backends (lib/hub/shell-agent.ts has the logic): one request in, the
// model's text out, no tools, nothing run.
//
// - Claude Code, headless: `claude -p <prompt> --output-format json --tools "" --strict-mcp-config
//   --no-session-persistence --system-prompt <strict prompt> --model haiku`, in a hidden PTY
//   (the packaged app has no `--allow-run`: the pattern of desktop/companion-brain.ts), its
//   stdin /dev/null, in `~/.qutty/shell-agent` (no project folder, so no CLAUDE.md is read).
//   It uses the user's own Claude Code login: Qutty holds no API keys.
// - Ollama, local: `@rullama/provider`'s `OllamaChatProvider` against 127.0.0.1:11434 (the
//   app's only `net` permission, loopback to that port), used when it answers `/api/tags`.
//
// `auto` (the default) picks Claude Code when it is installed, else a running Ollama.
//
// Cancelling (Ctrl-C in `qutty-agent`, an aborted signal): Claude Code's hidden PTY is killed;
// Ollama's request cannot be stopped (`OllamaChatProvider.chat` takes no signal), so the call
// rejects at once and the late answer is dropped.

import { ChatOptions, Message } from "@rullama/core";
import { OllamaChatProvider } from "@rullama/provider";
import { ensureDir, PtyHost, resolveProgram } from "./pty.ts";
import type { PtyDataEvent, PtyExitEvent } from "./pty.ts";
import {
  abortable,
  type BrainChoice,
  CancelledError,
  type ShellBrain,
} from "../lib/hub/shell-agent.ts";

/** How long one model request may take. */
const REQUEST_TIMEOUT_MS = 120_000;
/** How long Ollama may take to answer `/api/tags`. */
const DETECT_TIMEOUT_MS = 800;
/** The default Claude Code model: fast, for a prompt that waits on it. */
export const DEFAULT_CLAUDE_MODEL = "haiku";
export const OLLAMA_URL = "http://127.0.0.1:11434";

/** The hidden PTY's argv: bash drops the hub's variables, turns off the tty's output processing. */
export function claudeShellArgv(
  claude: string,
  system: string,
  prompt: string,
  model: string,
): { program: string; args: string[] } {
  return {
    program: "/bin/bash",
    args: [
      "-c",
      'unset QUTTY_SOCK QUTTY_TILE_ID QUTTY_HUB QUTTY_TILE_TOKEN; stty raw -echo; exec "$0" "$@" </dev/null',
      claude,
      "-p",
      prompt,
      "--output-format",
      "json",
      // No tools at all, no MCP servers, no slash commands, nothing kept on disk.
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--system-prompt",
      system,
      "--model",
      model,
    ],
  };
}

/** Claude Code's `--output-format json` result in `output` (the last `"type":"result"` line). */
export function parseClaudeResult(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l.startsWith("{")
  );
  for (const line of lines.reverse()) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const r = v as { type?: unknown; result?: unknown; is_error?: unknown };
    if (r?.type !== "result") continue;
    const text = typeof r.result === "string" ? r.result : "";
    if (r.is_error === true) {
      throw new Error(`Claude Code: ${text.slice(0, 300) || "failed"}`);
    }
    return text;
  }
  const tail = output.replace(/\s+/g, " ").trim().slice(-200);
  throw new Error(`Claude Code gave no answer${tail ? ` (${tail})` : ""}`);
}

/** Headless Claude Code for one request. */
export class ClaudeShellBrain implements ShellBrain {
  readonly label: string;
  #claude: string;
  #model: string;
  #cwd: string;
  #appSupportDir: string | undefined;

  constructor(
    opts: {
      claude: string;
      model: string;
      cwd: string;
      appSupportDir?: string;
    },
  ) {
    this.#claude = opts.claude;
    this.#model = opts.model;
    this.#cwd = opts.cwd;
    this.#appSupportDir = opts.appSupportDir;
    this.label = `Claude Code (${opts.model})`;
  }

  async complete(
    system: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new CancelledError();
    let output = "";
    let done: (exit: PtyExitEvent) => void = () => {};
    const exited = new Promise<PtyExitEvent>((r) => done = r);
    const host = new PtyHost((event, data) => {
      if (event === "data") output += (data as PtyDataEvent).data;
      else done(data as PtyExitEvent);
    });
    ensureDir(this.#cwd, 0o700);
    const { program, args } = claudeShellArgv(
      this.#claude,
      system,
      prompt,
      this.#model,
    );
    const { id } = await host.spawn(
      { cols: 400, rows: 50, program, args, cwd: this.#cwd },
      { appSupportDir: this.#appSupportDir, owner: "shell-agent" },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), REQUEST_TIMEOUT_MS);
    });
    let onAbort = () => {};
    const aborted = new Promise<"aborted">((r) => {
      onAbort = () => r("aborted");
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const end = await Promise.race([exited, timeout, aborted]);
      if (end === "aborted") {
        host.kill(id);
        throw new CancelledError();
      }
      if (end === "timeout") {
        host.kill(id);
        throw new Error("Claude Code did not answer in time");
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    return parseClaudeResult(output);
  }
}

/** A local Ollama model through `@rullama/provider`. */
export class OllamaShellBrain implements ShellBrain {
  readonly label: string;
  #provider: OllamaChatProvider;

  constructor(model: string, baseUrl = OLLAMA_URL) {
    this.#provider = new OllamaChatProvider(model, baseUrl);
    this.label = `Ollama (${model})`;
  }

  async complete(
    system: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // `chat` takes no signal: its fetch runs on, and its answer is dropped.
    const response = await abortable(
      this.#provider.chat(
        [Message.user(prompt)],
        undefined,
        new ChatOptions({ temperature: 0.2, max_tokens: 1024, system }),
      ),
      signal,
    );
    return response.message.text() ?? "";
  }
}

/** The models of a running Ollama (`undefined`: none answers, or the app may not reach it). */
export async function detectOllama(
  baseUrl = OLLAMA_URL,
): Promise<string[] | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return undefined;
    }
    const body = await res.json() as { models?: { name?: unknown }[] };
    return (body.models ?? []).flatMap((m) =>
      typeof m.name === "string" ? [m.name] : []
    );
  } catch {
    return undefined;
  }
}

/** Where the backends come from (tests replace them). */
export interface ShellBrainDeps {
  findClaude(): Promise<string | undefined>;
  ollamaModels(): Promise<string[] | undefined>;
  claude(claude: string, model: string): ShellBrain;
  ollama(model: string): ShellBrain;
}

/** The real backends: `claude` looked up like the `+` picker does, Ollama on loopback. */
export function defaultShellBrainDeps(
  opts: { cwd: string; appSupportDir?: string },
): ShellBrainDeps {
  return {
    findClaude: () => resolveProgram("claude"),
    ollamaModels: () => detectOllama(),
    claude: (claude, model) =>
      new ClaudeShellBrain({
        claude,
        model,
        cwd: opts.cwd,
        ...(opts.appSupportDir ? { appSupportDir: opts.appSupportDir } : {}),
      }),
    ollama: (model) => new OllamaShellBrain(model),
  };
}

/**
 * The brain for a request: `claude` / `ollama` as asked (an error a user can act on when it is
 * missing), or `auto`: Claude Code when installed, else a running Ollama.
 */
export async function chooseShellBrain(
  deps: ShellBrainDeps,
  choice: BrainChoice,
  model: string,
): Promise<ShellBrain> {
  if (choice !== "ollama") {
    const claude = await deps.findClaude();
    if (claude) return deps.claude(claude, model || DEFAULT_CLAUDE_MODEL);
    if (choice === "claude") {
      throw new Error(
        "Claude Code is not installed (no `claude` on PATH or in ~/.local/bin)",
      );
    }
  }
  const models = await deps.ollamaModels();
  if (models === undefined) {
    throw new Error(
      choice === "ollama"
        ? `no Ollama answers at ${OLLAMA_URL}`
        : "no model: install Claude Code, or start Ollama",
    );
  }
  const picked = model || models[0];
  if (!picked) throw new Error("Ollama has no models (ollama pull <model>)");
  return deps.ollama(picked);
}
