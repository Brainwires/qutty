/**
 * Claude Code as an agent tile's backend, the pure half: the command line, the stream-json
 * input lines, and the parser that turns its stream-json output into {@linkcode AgentEvent}s.
 * The process half is desktop/agent-claude.ts.
 *
 * Verified against Claude Code 2.1.326 (fixtures in tests/fixtures/agent/):
 *
 * - `claude -p --input-format stream-json --output-format stream-json --verbose
 *   --include-partial-messages`: one JSON user message per input line, one event per output line.
 *   `--model`, `--resume <id>`, `--permission-mode`, `--mcp-config`, `--settings` as documented.
 *   `--permission-prompt-tool <mcp tool>` is accepted though `--help` no longer lists it (it
 *   documents `--permission-prompts host`, "the SDK host or --permission-prompt-tool"). The tool
 *   is called with `{ tool_name, input, tool_use_id }` and answers with one text block holding
 *   `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}`.
 * - Interrupt: the input line `{"type":"control_request","request_id":…,"request":{"subtype":
 *   "interrupt"}}`; Claude Code answers `control_response`, reports a user message
 *   `[Request interrupted by user]`, then a `result` with `subtype: "error_during_execution"`.
 * - `system`/`init` comes at the start of every turn (session id, model, cwd). A resumed session
 *   does not replay its history.
 * - Partial messages: `stream_event` wraps the API's stream events (`message_start`,
 *   `content_block_start` / `_delta` / `_stop`). Each content block is then repeated whole as an
 *   `assistant` line (one block per line). Thinking streams empty `thinking_delta`s (display
 *   "updates"); `system`/`thinking_tokens` estimates its size.
 * - Tool results come as `user` lines with `tool_result` blocks, plus `tool_use_result`: an Edit's
 *   `structuredPatch`, Bash's `stdout` / `stderr` / `interrupted`, a Write's `content`, a Read's
 *   `file.numLines`.
 * - `result`: `duration_ms`, `usage.output_tokens` (this turn), `total_cost_usd` (the session so
 *   far), `is_error`, `subtype`, `result` (the final text).
 * - Lines with a string `parent_tool_use_id` belong to a subagent; they are left out.
 *
 * Pure.
 *
 * @module
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentSessionSpec,
  ToolDetail,
} from "./adapter.ts";

/** The hub's MCP server name (`mcp__qutty__approve_tool` in Claude Code). */
const HUB_SERVER = "qutty";
/** The hub tool Claude Code asks for permission through. */
export const APPROVE_TOOL = "approve_tool";
/** {@linkcode APPROVE_TOOL} as Claude Code names it. */
export const PERMISSION_TOOL = `mcp__${HUB_SERVER}__${APPROVE_TOOL}`;

/**
 * Printed by the hidden PTY's wrapper once the terminal is in raw mode, before Claude Code
 * starts (the companion's brain uses the same wrapper, lib/companion/brain.ts).
 */
export const AGENT_READY = '{"type":"qutty_agent_ready"}';

/** What {@linkcode claudeAgentArgv} needs. */
export interface ClaudeAgentConfig {
  /** The `claude` executable. */
  claude: string;
  spec: AgentSessionSpec;
  /** The flags that load the hub's MCP server and hooks (lib/hub/launch.ts `hubArgsFor`). */
  hubArgs: readonly string[];
  /** The tile's hub variables (`QUTTY_SOCK`, `QUTTY_TILE_ID`). */
  env: Readonly<Record<string, string>>;
}

/** A model alias or name Claude Code takes (`opus`, `sonnet[1m]`, `claude-opus-5-5`). */
export function isModelName(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,79}$/.test(s);
}

/** A session id Claude Code takes for `--resume` (a uuid). */
export function isSessionId(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(s);
}

/** Claude Code's flags for an agent tile's session. */
export function claudeAgentFlags(cfg: ClaudeAgentConfig): string[] {
  const { spec } = cfg;
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...cfg.hubArgs,
    "--permission-prompt-tool",
    PERMISSION_TOOL,
    ...(spec.model && isModelName(spec.model) ? ["--model", spec.model] : []),
    ...(spec.resumeId && isSessionId(spec.resumeId)
      ? ["--resume", spec.resumeId]
      : []),
    ...(spec.permissionMode && spec.permissionMode !== "default"
      ? ["--permission-mode", spec.permissionMode]
      : []),
    ...(spec.systemPrompt?.trim()
      ? ["--append-system-prompt", spec.systemPrompt]
      : []),
    ...(spec.allowedTools?.length
      ? ["--allowedTools", spec.allowedTools.join(",")]
      : []),
  ];
}

/**
 * The hidden PTY's command: `env` sets the tile's hub variables, bash puts the terminal in raw
 * mode (no echo, no line editing: an input line can be long), prints {@linkcode AGENT_READY} and
 * runs Claude Code with its stdin a pipe from the terminal (`-p` refuses a tty stdin).
 */
export function claudeAgentArgv(
  cfg: ClaudeAgentConfig,
): { program: string; args: string[] } {
  const script = "stty raw -echo; " +
    `printf '%s\\n' '${AGENT_READY}'; exec "$0" "$@" < <(exec cat)`;
  return {
    program: "/usr/bin/env",
    args: [
      ...Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`),
      "/bin/bash",
      "-c",
      script,
      cfg.claude,
      ...claudeAgentFlags(cfg),
    ],
  };
}

/** One user message as a stream-json input line: text, images and text files. */
export function agentUserLine(message: AgentMessage): string {
  const files = message.attachments ?? [];
  const content: unknown = files.length === 0 ? message.text : [
    ...files.map((a) =>
      a.kind === "image"
        ? {
          type: "image",
          source: { type: "base64", media_type: a.mediaType, data: a.data },
        }
        : { type: "text", text: `Attached file ${a.name}:\n\n${a.data}` }
    ),
    ...(message.text ? [{ type: "text", text: message.text }] : []),
  ];
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
  }) + "\n";
}

/** The interrupt request as an input line. */
export function interruptLine(requestId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  }) + "\n";
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The most text of one tool result kept (characters). */
const MAX_RESULT_TEXT = 64 * 1024;
/** The largest file an edit's `originalFile` is kept for (characters; bigger: not kept). */
const MAX_ORIGINAL = 512 * 1024;

const clip = (s: string, max = MAX_RESULT_TEXT) =>
  s.length > max
    ? `${s.slice(0, max)}\n… (${s.length - max} more characters)`
    : s;

/** A tool result's text: a string, or the text blocks of a content list. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) =>
    isObj(b) && b.type === "text" && typeof b.text === "string"
      ? b.text
      : isObj(b) && b.type === "image"
      ? "[image]"
      : ""
  ).filter(Boolean).join("\n");
}

/** What Claude Code's `tool_use_result` adds to a result, in the tile's terms. */
export function toolDetail(raw: unknown): ToolDetail | undefined {
  if (!isObj(raw)) return undefined;
  const d: ToolDetail = {};
  if (Array.isArray(raw.structuredPatch)) {
    d.patch = raw.structuredPatch.filter(isObj).map((h) => ({
      oldStart: num(h.oldStart) ?? 0,
      newStart: num(h.newStart) ?? 0,
      lines: Array.isArray(h.lines)
        ? h.lines.filter((l): l is string => typeof l === "string").slice(
          0,
          2000,
        )
        : [],
    })).slice(0, 200);
  }
  if (typeof raw.stdout === "string") d.stdout = clip(raw.stdout);
  if (typeof raw.stderr === "string" && raw.stderr) d.stderr = clip(raw.stderr);
  if (raw.interrupted === true) d.interrupted = true;
  if (raw.type === "create" && typeof raw.content === "string") {
    d.wroteLines = raw.content.split("\n").length -
      (raw.content.endsWith("\n") ? 1 : 0);
  }
  if (isObj(raw.file) && num(raw.file.numLines) !== undefined) {
    d.readLines = num(raw.file.numLines);
  }
  // The file before an edit or a write (`null`, or no `originalFile`, on a write that created it).
  if (typeof raw.originalFile === "string") {
    if (raw.originalFile.length <= MAX_ORIGINAL) d.original = raw.originalFile;
  } else if (raw.type === "create") d.original = null;
  return Object.keys(d).length > 0 ? d : undefined;
}

/**
 * Claude Code's stream-json output → {@linkcode AgentEvent}s. Feed it the raw output (any
 * chunking); it splits lines and skips the terminal's escape codes. Text and thinking come from
 * the partial-message deltas when there are any, else from the whole `assistant` lines.
 */
export class ClaudeStreamParser {
  #buf = "";
  #now: () => number;
  /** The message the stream events belong to. */
  #message = "";
  /** Block index → the block's id and type, for the message under way. */
  #blocks = new Map<number, { id: string; type: string }>();
  /** Messages whose text (or thinking) came as deltas: their whole copies are skipped. */
  #streamedText = new Set<string>();
  #streamedThinking = new Set<string>();
  /** The thinking block under way (for `thinking_tokens`). */
  #thinking: string | undefined;
  /** Text blocks seen whole per message (their row ids). */
  #wholeText = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Parse `chunk`; the events from its complete lines. */
  push(chunk: string): AgentEvent[] {
    this.#buf += chunk;
    const out: AgentEvent[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, "");
      this.#buf = this.#buf.slice(nl + 1);
      this.line(line, out);
    }
    return out;
  }

  /** One complete output line. */
  line(raw: string, out: AgentEvent[] = []): AgentEvent[] {
    const at = this.#now();
    const start = raw.indexOf("{");
    if (start < 0) {
      // deno-lint-ignore no-control-regex
      const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
      if (text) out.push({ kind: "log", message: text.slice(0, 500), at });
      return out;
    }
    let v: unknown;
    try {
      v = JSON.parse(raw.slice(start));
    } catch {
      out.push({ kind: "log", message: raw.slice(0, 500), at });
      return out;
    }
    if (!isObj(v) || typeof v.parent_tool_use_id === "string") return out;
    switch (v.type) {
      case "system":
        if (v.subtype === "init" && typeof v.session_id === "string") {
          out.push({
            kind: "session",
            sessionId: v.session_id,
            ...(typeof v.model === "string" ? { model: v.model } : {}),
            ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
            at,
          });
        } else if (v.subtype === "thinking_tokens" && this.#thinking) {
          const tokens = num(v.estimated_tokens);
          if (tokens !== undefined) {
            out.push({
              kind: "thinking",
              id: this.#thinking,
              delta: "",
              tokens,
              at,
            });
          }
        }
        break;
      case "stream_event":
        this.#streamEvent(v.event, at, out);
        break;
      case "assistant":
        this.#assistant(v.message, at, out);
        break;
      case "user":
        this.#user(v, at, out);
        break;
      case "result":
        out.push({
          kind: "turnEnd",
          isError: v.is_error === true || v.subtype !== "success",
          ...(typeof v.subtype === "string" ? { subtype: v.subtype } : {}),
          ...(num(v.duration_ms) !== undefined
            ? { durationMs: num(v.duration_ms) }
            : {}),
          ...(isObj(v.usage) && num(v.usage.output_tokens) !== undefined
            ? { outputTokens: num(v.usage.output_tokens) }
            : {}),
          ...(num(v.total_cost_usd) !== undefined
            ? { costUsd: num(v.total_cost_usd) }
            : {}),
          ...(typeof v.result === "string"
            ? { result: clip(v.result, 4000) }
            : {}),
          at,
        });
        this.#streamedText.clear();
        this.#streamedThinking.clear();
        this.#wholeText.clear();
        break;
    }
    return out;
  }

  #streamEvent(e: unknown, at: number, out: AgentEvent[]): void {
    if (!isObj(e)) return;
    switch (e.type) {
      case "message_start":
        if (isObj(e.message) && typeof e.message.id === "string") {
          this.#message = e.message.id;
          this.#blocks.clear();
        }
        return;
      case "content_block_start": {
        const index = num(e.index);
        const block = e.content_block;
        if (index === undefined || !isObj(block)) return;
        if (block.type === "tool_use" && typeof block.id === "string") {
          this.#blocks.set(index, { id: block.id, type: "tool_use" });
          if (typeof block.name === "string") {
            out.push({ kind: "toolStart", id: block.id, name: block.name, at });
          }
          return;
        }
        const id = `${this.#message}:${index}`;
        this.#blocks.set(index, { id, type: String(block.type) });
        if (block.type === "thinking") {
          this.#thinking = id;
          this.#streamedThinking.add(this.#message);
          out.push({ kind: "thinking", id, delta: "", at });
        }
        return;
      }
      case "content_block_delta": {
        const index = num(e.index);
        const delta = e.delta;
        if (index === undefined || !isObj(delta)) return;
        const block = this.#blocks.get(index);
        const id = block?.id ?? `${this.#message}:${index}`;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          this.#streamedText.add(this.#message);
          if (delta.text) out.push({ kind: "text", id, delta: delta.text, at });
        } else if (
          delta.type === "thinking_delta" && typeof delta.thinking === "string"
        ) {
          if (delta.thinking) {
            out.push({ kind: "thinking", id, delta: delta.thinking, at });
          }
        }
        return;
      }
      case "content_block_stop": {
        const block = this.#blocks.get(num(e.index) ?? -1);
        if (block?.id === this.#thinking) this.#thinking = undefined;
        return;
      }
    }
  }

  #assistant(message: unknown, at: number, out: AgentEvent[]): void {
    if (!isObj(message) || !Array.isArray(message.content)) return;
    const msg = typeof message.id === "string" ? message.id : "";
    for (const block of message.content) {
      if (!isObj(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string") {
        out.push({
          kind: "toolInput",
          id: block.id,
          name: typeof block.name === "string" ? block.name : "tool",
          input: isObj(block.input) ? block.input : {},
          at,
        });
      } else if (
        block.type === "text" && typeof block.text === "string" &&
        !this.#streamedText.has(msg) && block.text
      ) {
        // Without partial messages each block arrives whole, one per line.
        const n = (this.#wholeText.get(msg) ?? 0) + 1;
        this.#wholeText.set(msg, n);
        out.push({ kind: "text", id: `${msg}:t${n}`, delta: block.text, at });
      } else if (
        block.type === "thinking" && typeof block.thinking === "string" &&
        block.thinking && !this.#streamedThinking.has(msg)
      ) {
        out.push({
          kind: "thinking",
          id: `${msg}:thinking`,
          delta: block.thinking,
          at,
        });
      }
    }
  }

  #user(v: Json, at: number, out: AgentEvent[]): void {
    const message = v.message;
    if (!isObj(message) || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!isObj(block)) continue;
      if (
        block.type === "tool_result" && typeof block.tool_use_id === "string"
      ) {
        const detail = toolDetail(v.tool_use_result);
        out.push({
          kind: "toolResult",
          id: block.tool_use_id,
          text: clip(resultText(block.content)),
          isError: block.is_error === true,
          ...(detail ? { detail } : {}),
          at,
        });
      } else if (
        block.type === "text" && typeof block.text === "string" &&
        block.text.startsWith("[Request interrupted")
      ) {
        out.push({ kind: "interrupted", at });
      }
    }
  }
}
