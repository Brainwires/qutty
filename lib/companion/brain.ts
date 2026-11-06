/**
 * The companion's brain: the adapter boundary every model backend implements, and the default
 * one's wire protocol — headless Claude Code in streaming-JSON mode
 * (`claude -p --input-format stream-json --output-format stream-json --verbose
 * --include-partial-messages`): one JSON user message per line in, one JSON event per line out.
 *
 * The adapter is text in, events out, so the chat box, a tile's message and (phase 2b) a voice
 * transcript all reach the brain the same way, and the same events drive the bubble and (later)
 * speech. The runtime (lib/companion/runtime.ts) owns turns, the mailbox and restarts; an adapter
 * only runs a model session.
 *
 * Pure: the process half is desktop/companion-brain.ts. Fixtures recorded from Claude Code
 * 2.1.319 are in tests/fixtures/companion/.
 *
 * @module
 */

/** What the brain is doing, as Loopy shows it. */
export type BrainState =
  /** Not running yet (it starts on first use), or exited cleanly. */
  | "stopped"
  | "starting"
  /** Up and waiting for input. */
  | "ready"
  /** Working on a turn. */
  | "thinking"
  /** It failed to start or died; the next use starts it again. */
  | "error";

/** What an adapter reports while it runs. */
export type BrainEvent =
  /** The session is up and takes input. */
  | { kind: "ready" }
  /** More of the reply's text. */
  | { kind: "text"; delta: string }
  /** It called a tool (a hub tool: read_screen, write_tile, …). */
  | { kind: "toolUse"; name: string; input: unknown }
  /** The turn is over: the whole reply, and whether it failed. */
  | { kind: "turnEnd"; text: string; isError: boolean }
  /** A line that was not an event (diagnostics; logged, never shown). */
  | { kind: "log"; message: string };

/** Where an adapter sends its events. */
export interface BrainSink {
  event(event: BrainEvent): void;
  /** The session ended (crashed, or stopped); `reason` says why, for the status line. */
  exited(reason: string): void;
}

/**
 * A model backend for the companion. One instance is one session: `start` it, `send` it turns
 * (one at a time: the runtime waits for `turnEnd`), `stop` it. A new session is a new instance.
 */
export interface BrainAdapter {
  /** What Settings shows (`Claude Code`). */
  readonly label: string;
  /** Start the session; resolves once it takes input (rejects with a reason a user can act on). */
  start(sink: BrainSink): Promise<void>;
  /** One user turn. */
  send(text: string): Promise<void>;
  /** End the session (no `exited` is reported for it). */
  stop(): void;
}

/**
 * The second adapter's boundary: `@rullama/inference`'s `runAgentLoop` over a
 * `@rullama/provider` (Ollama locally, or an API key), with the hub's tools bridged as the loop's
 * tools. Not built yet (no API key handling in this phase); an implementation fills this in and
 * returns a {@linkcode BrainAdapter}.
 *
 * TODO(companion): implement with `runAgentLoop` once a provider is chosen in Settings.
 */
// fallow-ignore-next-line unused-type
export interface InferenceBrainOptions {
  provider: "ollama" | "anthropic";
  model: string;
  /** Ollama's base URL (default `http://127.0.0.1:11434`). */
  baseUrl?: string;
  /** The system prompt ({@linkcode COMPANION_SYSTEM_PROMPT}). */
  systemPrompt: string;
}

// ---------------------------------------------------------------------------------------------
// Claude Code: the command line
// ---------------------------------------------------------------------------------------------

/** The hub's MCP server name, as the companion's tools are named (`mcp__qutty__read_screen`). */
const COMPANION_MCP_SERVER = "qutty";

/**
 * Printed by the hidden PTY's wrapper once the terminal is in raw mode, before Claude Code
 * starts: input written before it would be echoed and line-edited.
 */
export const READY_MARKER = '{"type":"qutty_ready"}';

/** What the companion is told about itself (`--append-system-prompt`). */
export const COMPANION_SYSTEM_PROMPT = [
  "You are Loopy, the companion of Qutty, a tiling terminal app: an animated paper clip in a",
  "corner of the window. The user talks to you in a chat box under your speech bubble, and",
  "everything you write appears in that bubble (it may also be read aloud), so keep every answer",
  "short: one to three plain sentences, no markdown, no lists, no code blocks.",
  "",
  "You see and control the window through the `qutty` MCP tools. list_peers shows every tile",
  "(id like pty-3, name, harness, title, cwd, busy/idle/waiting); read_screen and read_scrollback",
  "show what a tile shows. You may act on any tile: write_tile types into it (end with \\r to",
  "press Enter), spawn_tile opens one (optionally running a command), close_tile, focus_tile, and",
  "deliver nudges an idle agent tile to read its messages. send_message talks to a tile's agent,",
  "ask_user asks the user with buttons.",
  "",
  'Look before you answer: when the user asks about "tile 2" or "the build", read it first. A',
  "number usually means the n-th tile in list_peers order (pty-n is a good guess). Do what the",
  "user asks, then say briefly what you did. Ask first (ask_user) before anything destructive or",
  "hard to undo: closing a tile that runs something, killing processes, deleting files, git push.",
  "Never type into a tile whose agent is busy unless the user asked for it.",
  "",
  "Turns that start with [Qutty] are messages from agents in other tiles, not from the user.",
  "Handle them, and answer the agent with send_message (to its name, replyTo the message id).",
  "Whatever you write on such a turn is shown to the user: when the user does not need to hear",
  "about it, write exactly (quiet).",
].join("\n");

/** What {@linkcode claudeBrainArgv} needs. */
export interface ClaudeBrainConfig {
  /** The `claude` executable. */
  claude: string;
  /** The generated MCP config: the hub's companion socket as the `qutty` server. */
  mcpConfig: string;
  /** A model alias or name (`haiku`); the user's default when absent. */
  model?: string;
  systemPrompt?: string;
}

/**
 * The hidden PTY's command: bash puts the terminal in raw mode (no echo, no line editing: a
 * stream-json line can be longer than the tty's line limit), prints {@linkcode READY_MARKER},
 * and runs Claude Code with its stdin a pipe from the terminal (`-p` refuses a tty stdin) and its
 * stdout the terminal. QUTTY_SOCK is dropped: the app's environment may carry one when Qutty was
 * started from a Qutty tile, and the companion must not register as that tile.
 */
export function claudeBrainArgv(
  cfg: ClaudeBrainConfig,
): { program: string; args: string[] } {
  const script = "unset QUTTY_SOCK QUTTY_TILE_ID; stty raw -echo; " +
    `printf '%s\\n' '${READY_MARKER}'; exec "$0" "$@" < <(exec cat)`;
  return {
    program: "/bin/bash",
    args: [
      "-c",
      script,
      cfg.claude,
      ...claudeBrainFlags(cfg),
    ],
  };
}

/** Claude Code's flags for the companion session. */
export function claudeBrainFlags(cfg: ClaudeBrainConfig): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Only the hub: no built-in tools (it acts through the tiles), no other MCP servers.
    "--mcp-config",
    cfg.mcpConfig,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    `mcp__${COMPANION_MCP_SERVER}`,
    "--no-session-persistence",
    "--append-system-prompt",
    cfg.systemPrompt ?? COMPANION_SYSTEM_PROMPT,
    ...(cfg.model ? ["--model", cfg.model] : []),
  ];
}

/** The MCP config file: the hub's companion socket, through the `qutty-mcp` shim. */
export function companionMcpConfig(mcpShim: string, socket: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [COMPANION_MCP_SERVER]: {
          type: "stdio",
          command: mcpShim,
          args: [],
          env: { QUTTY_SOCK: socket },
        },
      },
    },
    null,
    2,
  ) + "\n";
}

/** One user turn as a stream-json input line. */
export function userTurnLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  }) + "\n";
}

// ---------------------------------------------------------------------------------------------
// Claude Code: the output
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Claude Code's stream-json output → {@linkcode BrainEvent}s. Feed it the raw output (any
 * chunking); it splits lines, skips the terminal's escape codes and a subagent's events, and
 * reports the reply's text once: from the partial-message deltas when they come, else from the
 * whole assistant message. Separate assistant messages in one turn (text, a tool call, more text)
 * are joined by a blank line.
 */
export class StreamJsonParser {
  #buf = "";
  #ready = false;
  /** Assistant messages whose text came as deltas (their full copy is skipped). */
  #streamed = new Set<string>();
  /** The assistant message the deltas belong to. */
  #current: string | undefined;
  #turnText = "";
  /** The message the turn's text last came from. */
  #lastTextMessage: string | undefined;

  /** Parse `chunk`; the events from its complete lines. */
  push(chunk: string): BrainEvent[] {
    this.#buf += chunk;
    const out: BrainEvent[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, "");
      this.#buf = this.#buf.slice(nl + 1);
      this.#line(line, out);
    }
    return out;
  }

  #line(raw: string, out: BrainEvent[]): void {
    const start = raw.indexOf("{");
    if (start < 0) {
      // Escape codes (`ESC[?25h`) and blank lines; anything else is a diagnostic.
      // deno-lint-ignore no-control-regex
      const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
      if (text) out.push({ kind: "log", message: text });
      return;
    }
    let v: unknown;
    try {
      v = JSON.parse(raw.slice(start));
    } catch {
      out.push({ kind: "log", message: raw.slice(0, 500) });
      return;
    }
    if (!isObj(v)) return;
    // A subagent's events (Task tool) are not the companion talking.
    if (typeof v.parent_tool_use_id === "string") return;
    switch (v.type) {
      case "qutty_ready":
        return;
      case "system":
        if (v.subtype === "init" && !this.#ready) {
          this.#ready = true;
          out.push({ kind: "ready" });
        }
        return;
      case "stream_event":
        return this.#streamEvent(v.event, out);
      case "assistant":
        return this.#assistant(v.message, out);
      case "result":
        return this.#result(v, out);
    }
  }

  #text(messageId: string | undefined, text: string, out: BrainEvent[]): void {
    if (!text) return;
    const sep = this.#turnText && messageId !== this.#lastTextMessage &&
        !/\s$/.test(this.#turnText)
      ? "\n\n"
      : "";
    this.#lastTextMessage = messageId;
    this.#turnText += sep + text;
    out.push({ kind: "text", delta: sep + text });
  }

  #streamEvent(e: unknown, out: BrainEvent[]): void {
    if (!isObj(e)) return;
    if (e.type === "message_start" && isObj(e.message)) {
      this.#current = typeof e.message.id === "string"
        ? e.message.id
        : undefined;
      return;
    }
    if (e.type !== "content_block_delta" || !isObj(e.delta)) return;
    if (e.delta.type !== "text_delta" || typeof e.delta.text !== "string") {
      return;
    }
    if (this.#current) this.#streamed.add(this.#current);
    this.#text(this.#current, e.delta.text, out);
  }

  #assistant(message: unknown, out: BrainEvent[]): void {
    if (!isObj(message) || !Array.isArray(message.content)) return;
    const id = typeof message.id === "string" ? message.id : undefined;
    for (const block of message.content) {
      if (!isObj(block)) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        out.push({ kind: "toolUse", name: block.name, input: block.input });
      } else if (
        block.type === "text" && typeof block.text === "string" &&
        !(id && this.#streamed.has(id))
      ) {
        this.#text(id, block.text, out);
      }
    }
  }

  #result(v: Json, out: BrainEvent[]): void {
    const isError = v.is_error === true || v.subtype !== "success";
    const result = typeof v.result === "string" ? v.result.trim() : "";
    const text = this.#turnText || result ||
      (isError ? `The turn failed (${String(v.subtype ?? "error")}).` : "");
    out.push({ kind: "turnEnd", text, isError });
    this.#turnText = "";
    this.#lastTextMessage = undefined;
    this.#streamed.clear();
  }
}

/** The short name of a tool call (`mcp__qutty__read_screen` → `read_screen`). */
export function toolShortName(name: string): string {
  const prefix = `mcp__${COMPANION_MCP_SERVER}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
