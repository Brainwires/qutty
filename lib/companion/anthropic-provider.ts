/**
 * The companion's API key brain: Anthropic's Messages API (`https://api.anthropic.com/v1/messages`)
 * as a `@rullama/core` `Provider`, for lib/companion/inference-brain.ts.
 *
 * Why not `@rullama/provider`'s `AnthropicChatProvider`: its reply parser keeps only text and
 * tool calls, so a current model's `thinking` blocks would be dropped from the conversation sent
 * back (and Claude Opus 5.5 / Sonnet 5.5 expect them back unchanged); it always sends
 * `temperature` (`ChatOptions` defaults it), which those models refuse; and it does not pass the
 * abort signal to `fetch`. This one keeps each reply's content blocks exactly as they came
 * (`Message.metadata`, which other providers ignore) and sends them back as they were, sends no
 * sampling options, and aborts the request when the companion is stopped.
 *
 * The key is asked for on every request (`key()`, the hub extension's secure store), so a key the
 * user removes in Settings is not used again. It is sent only to {@linkcode ANTHROPIC_URL}.
 *
 * Pure apart from the injected `fetch` and key.
 *
 * @module
 */

import {
  type ChatOptions,
  type ChatResponse,
  type ContentBlock,
  Message,
  type Provider,
  type StreamChunk,
  type Tool,
} from "@rullama/core";
import type { BrainModel } from "./settings.ts";

/** The host the API key brain calls (denext.config.ts `netConnect`). */
const ANTHROPIC_HOST = "api.anthropic.com";
/** The Messages endpoint. */
export const ANTHROPIC_URL = `https://${ANTHROPIC_HOST}/v1/messages`;
const ANTHROPIC_VERSION = "2023-06-01";
/** Server-side refusal fallback ("default": the API picks the fallback model per refusal). */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Settings' model choice as an API model id (`""`: Claude Opus 5.5). */
export const ANTHROPIC_MODELS: Readonly<Record<BrainModel, string>> = {
  "": "claude-opus-5-5",
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** Models that take the server-side refusal fallback (Haiku has none). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

/** The longest reply per request (thinking included); plenty for a companion's turn. */
const MAX_TOKENS = 16_000;

/** A content block as the API sends and takes it. */
type WireBlock = { type: string; [field: string]: unknown };
interface WireMessage {
  role: "user" | "assistant";
  content: WireBlock[];
}
interface WireResponse {
  content?: WireBlock[];
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Where a reply's own blocks are kept on its message. */
const RAW = "anthropicContent";

export interface AnthropicProviderOptions {
  /** The API key (asked for on every request); `null` when none is saved. */
  key(): Promise<string | null>;
  /** The model id ({@linkcode ANTHROPIC_MODELS}). */
  model: string;
  /** `fetch` (tests). */
  fetch?: typeof fetch;
}

/** One core block as the API takes it (`null`: not sent, e.g. an image the hub never makes). */
function wireBlock(block: ContentBlock): WireBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
    default:
      return null;
  }
}

/**
 * The conversation as the API takes it: system messages left out (the system prompt goes in
 * `system`), tool results as user turns, a reply this provider made sent back exactly as it came,
 * and consecutive turns of one role joined (so the results of parallel tool calls arrive
 * together).
 */
export function wireMessages(messages: readonly Message[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const raw = (m.metadata as Record<string, unknown> | undefined)?.[RAW];
    const content: WireBlock[] = role === "assistant" && Array.isArray(raw)
      ? raw as WireBlock[]
      : typeof m.content === "string"
      ? (m.content ? [{ type: "text", text: m.content }] : [])
      : m.content.map(wireBlock).filter((b): b is WireBlock => b !== null);
    if (content.length === 0) continue;
    const last = out.at(-1);
    if (last?.role === role) last.content = [...last.content, ...content];
    else out.push({ role, content });
  }
  return out;
}

/** The core content of a reply: its text and tool calls (thinking stays in the raw blocks). */
function coreContent(blocks: readonly WireBlock[]): ContentBlock[] {
  return blocks.flatMap((b): ContentBlock[] =>
    b.type === "text" && typeof b.text === "string"
      ? [{ type: "text", text: b.text }]
      : b.type === "tool_use" && typeof b.id === "string" &&
          typeof b.name === "string"
      ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} }]
      : []
  );
}

/** The API's error body in a line (its `error.message`, else the text, shortened). */
function errorLine(status: number, text: string): string {
  let message = text.trim();
  try {
    const body = JSON.parse(text) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch { /* not JSON */ }
  const why = status === 401
    ? "the API key was refused (Settings → Companion)"
    : `Anthropic API error ${status}`;
  return message ? `${why}: ${message.slice(0, 300)}` : why;
}

/** Anthropic's Messages API with the user's key, keeping replies intact. */
export class AnthropicApiProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  #opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    this.#opts = opts;
    this.model = opts.model;
  }

  maxOutputTokens(): number {
    return MAX_TOKENS;
  }

  /** The request body (exported for the tests through {@linkcode AnthropicApiProvider.body}). */
  body(
    messages: readonly Message[],
    tools: readonly Tool[] | undefined,
    options: Pick<ChatOptions, "system">,
  ): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      ...(options.system ? { system: options.system } : {}),
      messages: wireMessages(messages),
      ...(tools && tools.length > 0
        ? {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
        }
        : {}),
      ...(FALLBACK_MODELS.has(this.model) ? { fallbacks: "default" } : {}),
    };
  }

  async chat(
    messages: Message[],
    tools: Tool[] | undefined,
    options: ChatOptions,
  ): Promise<ChatResponse> {
    const key = await this.#opts.key();
    if (!key) throw new Error("no Anthropic API key (Settings → Companion)");
    const response = await (this.#opts.fetch ?? fetch)(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        ...(FALLBACK_MODELS.has(this.model)
          ? { "anthropic-beta": FALLBACK_BETA }
          : {}),
      },
      body: JSON.stringify(this.body(messages, tools, options)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(errorLine(response.status, text));
    const reply = JSON.parse(text) as WireResponse;
    if (reply.stop_reason === "refusal") {
      const category = reply.stop_details?.category;
      throw new Error(
        `Claude declined to answer${category ? ` (${category})` : ""}`,
      );
    }
    const blocks = Array.isArray(reply.content) ? reply.content : [];
    const input = reply.usage?.input_tokens ?? 0;
    const output = reply.usage?.output_tokens ?? 0;
    return {
      message: new Message({
        role: "assistant",
        content: coreContent(blocks),
        metadata: { [RAW]: blocks },
      }),
      usage: {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
      },
      finish_reason: reply.stop_reason,
    };
  }

  // deno-lint-ignore require-yield
  async *streamChat(): AsyncIterable<StreamChunk> {
    throw new Error("the companion's API key brain does not stream");
  }
}
