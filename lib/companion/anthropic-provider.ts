/**
 * The companion's API key brain: Anthropic's Messages API (`https://api.anthropic.com/v1/messages`)
 * as a `@rullama/core` `Provider`, for lib/companion/inference-brain.ts. A thin layer over
 * `@rullama/provider`'s `AnthropicChatProvider`, which does the request: it keeps each reply's own
 * content blocks (thinking included) in `Message.metadata` and sends them back unchanged, sends no
 * sampling option the caller did not set, and passes the abort signal to `fetch`.
 *
 * What this layer adds:
 * - The key is asked for on every request (`key()`, the hub extension's secure store), and a
 *   provider is made for that request with it, so a key the user removes in Settings is not used
 *   again. The endpoint is always {@linkcode ANTHROPIC_URL}.
 * - The options sent are only the system prompt, the stop sequences, the signal and
 *   {@linkcode MAX_TOKENS}: never a temperature (current models refuse sampling options).
 * - The conversation is tidied first ({@linkcode joinTurns}): empty text is left out and
 *   consecutive non-assistant turns are joined, so parallel tool results arrive together.
 * - A `refusal` stop reason is an error, and the API's errors read as a line a user can act on.
 *
 * Pure apart from the injected key (and the global `fetch` the library calls).
 *
 * @module
 */

import {
  ChatOptions,
  type ChatResponse,
  type ContentBlock,
  Message,
  type Provider,
  type StreamChunk,
  type Tool,
} from "@rullama/core";
import {
  ANTHROPIC_CONTENT_KEY,
  AnthropicChatProvider,
} from "@rullama/provider";
import type { BrainModel } from "./settings.ts";

/** The Messages endpoint (denext.config.ts `netConnect`: api.anthropic.com). */
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** Settings' model choice as an API model id (`""`: Claude Opus 5.5). */
export const ANTHROPIC_MODELS: Readonly<Record<BrainModel, string>> = {
  "": "claude-opus-5-5",
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** The longest reply per request (thinking included); plenty for a companion's turn. */
const MAX_TOKENS = 16_000;

/**
 * How long the API key brain's conversation may grow, in characters of serialized history
 * (roughly 400k tokens at about 4 characters a token, well inside these models' 1M context),
 * before the next turn starts a fresh session. The history is never trimmed instead: dropping the
 * oldest turns would edit it, and preserved thinking (Opus 5.5, Sonnet 5.5) accepts thinking
 * blocks only in an unedited, append-only history (newer accounts get a 400 for an edit).
 */
export const ANTHROPIC_HISTORY_CHARS = 1_600_000;

export interface AnthropicProviderOptions {
  /** The API key (asked for on every request); `null` when none is saved. */
  key(): Promise<string | null>;
  /** The model id ({@linkcode ANTHROPIC_MODELS}). */
  model: string;
}

/** A message's content as blocks, without empty text. */
function blocksOf(m: Message): ContentBlock[] {
  const blocks: ContentBlock[] = typeof m.content === "string"
    ? [{ type: "text", text: m.content }]
    : m.content;
  return blocks.filter((b) => b.type !== "text" || b.text !== "");
}

/** Whether `m` is a reply carrying its own blocks (sent back exactly as they came). */
function hasRawBlocks(m: Message): boolean {
  const raw = (m.metadata as Record<string, unknown> | undefined)?.[
    ANTHROPIC_CONTENT_KEY
  ];
  return m.role === "assistant" && Array.isArray(raw) && raw.length > 0;
}

/**
 * The conversation as it is sent: system messages left out (the system prompt goes in
 * `system`), empty text and empty turns left out, a reply with its own blocks kept as it is, and
 * consecutive user and tool turns joined into one user turn (so the results of parallel tool
 * calls arrive together).
 */
export function joinTurns(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (hasRawBlocks(m)) {
      out.push(m);
      continue;
    }
    const content = blocksOf(m);
    if (content.length === 0) continue;
    const last = out.at(-1);
    if (m.role === "assistant") {
      out.push(new Message({ role: "assistant", content }));
    } else if (last && last.role === "user") {
      out[out.length - 1] = new Message({
        role: "user",
        content: [...blocksOf(last), ...content],
      });
    } else out.push(new Message({ role: "user", content }));
  }
  return out;
}

/** The API's error in a line: its `error.message` (else the text, shortened), a 401 explained. */
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

/** The library's `Anthropic API error (<status>): <body>` as {@linkcode errorLine}. */
function readable(e: unknown): unknown {
  const m = e instanceof Error &&
    /^Anthropic API error \((\d+)\): ([\s\S]*)$/.exec(e.message);
  return m ? new Error(errorLine(Number(m[1]), m[2])) : e;
}

/** Anthropic's Messages API with the user's key, keeping replies intact. */
export class AnthropicApiProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  #key: () => Promise<string | null>;

  constructor(opts: AnthropicProviderOptions) {
    this.#key = opts.key;
    this.model = opts.model;
  }

  maxOutputTokens(): number {
    return MAX_TOKENS;
  }

  /** A provider with the key as it is now (none saved: an error, before any request). */
  async #provider(): Promise<AnthropicChatProvider> {
    const key = await this.#key();
    if (!key) throw new Error("no Anthropic API key (Settings → Companion)");
    return new AnthropicChatProvider(key, this.model, this.name, ANTHROPIC_URL);
  }

  /** The options sent: no sampling options, this provider's reply length. */
  #options(options: ChatOptions): ChatOptions {
    return new ChatOptions({
      max_tokens: MAX_TOKENS,
      ...(options.system ? { system: options.system } : {}),
      ...(options.stop ? { stop: options.stop } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async chat(
    messages: Message[],
    tools: Tool[] | undefined,
    options: ChatOptions,
  ): Promise<ChatResponse> {
    const provider = await this.#provider();
    const response = await provider
      .chat(joinTurns(messages), tools, this.#options(options))
      .catch((e) => Promise.reject(readable(e)));
    if (response.finish_reason === "refusal") {
      throw new Error("Claude declined to answer");
    }
    return response;
  }

  async *streamChat(
    messages: Message[],
    tools: Tool[] | undefined,
    options: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    const provider = await this.#provider();
    try {
      yield* provider.streamChat(
        joinTurns(messages),
        tools,
        this.#options(options),
      );
    } catch (e) {
      throw readable(e);
    }
  }
}
