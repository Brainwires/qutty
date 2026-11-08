/**
 * The companion's second brain: `@rullama/inference`'s `runAgentLoop` over a `@rullama/provider`
 * chat provider (a local Ollama model through its native `/api/chat`, desktop/companion-brain.ts),
 * with the hub's tools as the loop's tools.
 *
 * The tools are called in process, as the companion: {@linkcode CompanionTools} is the hub's own
 * MCP handler (lib/hub/tools.ts `companionToolbox`) with a companion request context, so a call
 * goes through the same permission check and audit log as the Claude Code brain's calls over the
 * companion socket, without a socket, a shim process or an MCP handshake.
 *
 * One instance is one session: the conversation is kept across turns (trimmed to the last
 * {@linkcode MAX_MESSAGES} messages, at a user turn so a tool call never loses its result). The
 * provider is not streamed (a tool round needs the whole reply anyway), so each assistant
 * message's text arrives in one `text` event.
 *
 * Stopping aborts the turn's signal, which goes to the provider as `ChatOptions.signal`: the
 * request's connection is closed, so Ollama stops generating. The call is also raced against the
 * signal, so a provider that ignores it still ends the turn at once.
 *
 * Pure apart from the injected provider and tools.
 *
 * @module
 */

import {
  ChatOptions,
  type ChatResponse,
  type ContentBlock,
  Message,
  type Provider,
  type Tool,
  ToolResult,
  type ToolUse,
} from "@rullama/core";
import { CommunicationHub, FileLockManager } from "@rullama/agent";
import { type AgentRuntime, runAgentLoop } from "@rullama/inference/runtime";
import type { BrainAdapter, BrainSink } from "./brain.ts";
import { COMPANION_SYSTEM_PROMPT } from "./brain.ts";

/** A hub tool as `tools/list` describes it. */
export interface CompanionToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The hub's tools, called as the companion. */
export interface CompanionTools {
  list(): CompanionToolDef[];
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }>;
}

export interface InferenceBrainOptions {
  /** What Settings shows (`Ollama (qwen3.8:27b-mlx)`). */
  label: string;
  provider: Provider;
  tools: CompanionTools;
  /** Checked on start (the server answers, the model exists); throws a reason a user can act on. */
  check?(): Promise<void>;
  /** The system prompt ({@linkcode COMPANION_SYSTEM_PROMPT}). */
  systemPrompt?: string;
  /** Model calls per turn (default 12). */
  maxIterations?: number;
}

/** How many messages a session keeps. */
const MAX_MESSAGES = 60;
/** The longest tool result handed to the model (a local model's context is small). */
export const MAX_TOOL_TEXT = 16_000;

/** A hub tool as the provider's tool. */
export function toProviderTool(def: CompanionToolDef): Tool {
  const schema = def.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: def.name,
    description: def.description,
    input_schema: {
      type: "object",
      properties: schema.properties ?? {},
      required: schema.required ?? [],
    },
  };
}

/** The tool calls in a reply. */
function toolUsesOf(response: ChatResponse): ToolUse[] {
  const content = response.message.content;
  if (typeof content === "string") return [];
  return content.flatMap((b) =>
    b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : []
  );
}

/** The text of a reply (its text blocks joined). */
function replyText(response: ChatResponse): string {
  const content = response.message.content;
  if (typeof content === "string") return content.trim();
  return content.filter((b): b is Extract<ContentBlock, { type: "text" }> =>
    b.type === "text"
  ).map((b) => b.text).join("").trim();
}

/**
 * `messages` without its oldest turns, so at most `max` remain: the cut is made before a user's
 * text message, so the kept part never starts with a tool result whose call was dropped.
 */
export function trimConversation(
  messages: readonly Message[],
  max = MAX_MESSAGES,
): Message[] {
  if (messages.length <= max) return [...messages];
  for (let i = messages.length - max; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") {
      return messages.slice(i);
    }
  }
  // One turn longer than `max`: keep only its user message onward.
  const lastUser = messages.findLastIndex((m) =>
    m.role === "user" && typeof m.content === "string"
  );
  return messages.slice(Math.max(0, lastUser));
}

const aborted = () => new Error("stopped");

/** Settle with `p`, or reject as soon as `signal` aborts (whether or not the provider honours it). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

/** The companion on `runAgentLoop`. */
export class InferenceBrain implements BrainAdapter {
  readonly label: string;
  #opts: InferenceBrainOptions;
  #sink: BrainSink | undefined;
  #tools: Tool[] = [];
  #messages: Message[] = [];
  #stop = new AbortController();
  #turns = 0;

  constructor(opts: InferenceBrainOptions) {
    this.#opts = opts;
    this.label = opts.label;
  }

  async start(sink: BrainSink): Promise<void> {
    await this.#opts.check?.();
    this.#tools = this.#opts.tools.list().map(toProviderTool);
    this.#sink = sink;
    sink.event({ kind: "ready" });
  }

  send(text: string): Promise<void> {
    if (!this.#sink) {
      return Promise.reject(new Error("the session is not running"));
    }
    void this.#turn(this.#sink, text);
    return Promise.resolve();
  }

  stop(): void {
    this.#stop.abort();
  }

  async #turn(sink: BrainSink, text: string): Promise<void> {
    const signal = this.#stop.signal;
    this.#messages = trimConversation([...this.#messages, Message.user(text)]);
    const texts: string[] = [];
    const say = (t: string) => {
      if (!t || signal.aborted) return;
      const delta = texts.length > 0 ? `\n\n${t}` : t;
      texts.push(t);
      sink.event({ kind: "text", delta });
    };
    let result: { success: boolean; output: string };
    try {
      result = await runAgentLoop(
        this.#runtime(sink, say, signal),
        new CommunicationHub(),
        new FileLockManager(),
        signal,
      );
    } catch (e) {
      result = {
        success: false,
        output: e instanceof Error ? e.message : String(e),
      };
    }
    if (signal.aborted) return; // stopped on purpose: no events
    sink.event({
      kind: "turnEnd",
      text: result.success
        ? texts.join("\n\n")
        : texts.join("\n\n") || result.output,
      isError: !result.success,
    });
  }

  #runtime(
    sink: BrainSink,
    say: (text: string) => void,
    signal: AbortSignal,
  ): AgentRuntime {
    const id = `companion-${++this.#turns}`;
    const options = new ChatOptions({
      temperature: 0.2,
      max_tokens: 1024,
      system: this.#opts.systemPrompt ?? COMPANION_SYSTEM_PROMPT,
      signal,
    });
    const add = (m: Message) => this.#messages.push(m);
    return {
      agentId: () => id,
      maxIterations: () => this.#opts.maxIterations ?? 12,
      callProvider: () =>
        abortable(
          this.#opts.provider.chat(this.#messages, this.#tools, options),
          signal,
        ),
      extractToolUses: toolUsesOf,
      isCompletion: (r) => toolUsesOf(r).length === 0,
      executeTool: async (use) => {
        sink.event({ kind: "toolUse", name: use.name, input: use.input });
        const args = use.input && typeof use.input === "object" &&
            !Array.isArray(use.input)
          ? use.input as Record<string, unknown>
          : {};
        const r = await this.#opts.tools.call(use.name, args, signal);
        return new ToolResult(
          use.id,
          r.text.slice(0, MAX_TOOL_TEXT),
          r.isError,
        );
      },
      getLockRequirement: () => undefined,
      onProviderResponse: (r) => {
        add(r.message);
        say(replyText(r));
      },
      onToolResult: (_use, r) => {
        add(
          new Message({
            role: "tool",
            content: [{
              type: "tool_result",
              tool_use_id: r.tool_use_id,
              content: r.content,
              ...(r.is_error ? { is_error: true } : {}),
            }],
          }),
        );
      },
      onCompletion: (r) => {
        add(r.message);
        const t = replyText(r);
        say(t);
        return Promise.resolve(t);
      },
      onIterationLimit: (n) => `I gave up after ${n} steps without an answer.`,
    };
  }
}
