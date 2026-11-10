/**
 * The companion's API key brain: Anthropic's Messages API (`https://api.anthropic.com/v1/messages`)
 * as a `@rullama/core` `Provider`, for lib/companion/inference-brain.ts. A thin layer over
 * `@rullama/provider`'s `AnthropicChatProvider`, which does the request: it reads the key on every
 * request, keeps each reply's own content blocks (thinking included) in `Message.metadata` and
 * sends them back unchanged, leaves out empty text and joins consecutive user and tool turns,
 * sends no sampling option the caller did not set, and passes the abort signal to `fetch`.
 *
 * What this layer adds:
 * - The key comes from `key()` (the hub extension's secure store) on every request, so a key the
 *   user removes in Settings is not used again; with none saved, no request is made. The endpoint
 *   is always {@linkcode ANTHROPIC_URL}.
 * - Claude Opus 5.5 and Sonnet 5.5 get the server-side refusal fallback (the `anthropic-beta`
 *   header and `fallbacks: "default"`).
 * - The options sent are only the system prompt, the stop sequences, the signal and
 *   {@linkcode MAX_TOKENS}: never a temperature (current models refuse sampling options).
 * - A `refusal` stop reason is an error naming its category, and the API's errors read as a line
 *   a user can act on.
 *
 * Pure apart from the injected key and `fetch`.
 *
 * @module
 */

import {
  ChatOptions,
  type ChatResponse,
  type Message,
  type Provider,
  type StreamChunk,
  type Tool,
} from "@rullama/core";
import {
  ANTHROPIC_STOP_DETAILS_KEY,
  AnthropicChatProvider,
  type AnthropicStopDetails,
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

/** Server-side refusal fallback ("default": the API picks the fallback model per refusal). */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models that take the server-side refusal fallback (Haiku has none). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

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
  /** `fetch` (tests). */
  fetch?: typeof fetch;
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

/** A refusal as an error, naming its category when the API gave one. */
function refusal(response: ChatResponse): Error {
  const metadata = response.message.metadata as
    | Record<string, unknown>
    | undefined;
  const details = metadata?.[ANTHROPIC_STOP_DETAILS_KEY] as
    | AnthropicStopDetails
    | undefined;
  const category = details?.category;
  return new Error(
    `Claude declined to answer${category ? ` (${category})` : ""}`,
  );
}

/** Anthropic's Messages API with the user's key, keeping replies intact. */
export class AnthropicApiProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  #provider: AnthropicChatProvider;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    const fallback = FALLBACK_MODELS.has(opts.model);
    this.#provider = new AnthropicChatProvider({
      apiKey: async () => {
        const key = await opts.key();
        if (!key) {
          throw new Error("no Anthropic API key (Settings → Companion)");
        }
        return key;
      },
      model: opts.model,
      baseUrl: ANTHROPIC_URL,
      ...(fallback
        ? {
          extraHeaders: { "anthropic-beta": FALLBACK_BETA },
          extraBody: { fallbacks: "default" },
        }
        : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  maxOutputTokens(): number {
    return MAX_TOKENS;
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
    const response = await this.#provider
      .chat(messages, tools, this.#options(options))
      .catch((e) => Promise.reject(readable(e)));
    if (response.finish_reason === "refusal") throw refusal(response);
    return response;
  }

  async *streamChat(
    messages: Message[],
    tools: Tool[] | undefined,
    options: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    try {
      yield* this.#provider.streamChat(messages, tools, this.#options(options));
    } catch (e) {
      throw readable(e);
    }
  }
}
