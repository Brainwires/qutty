/**
 * The agent tile's adapter boundary: what every coding-agent backend implements so one tile UI
 * (app/agent-tile.tsx) can drive it. An adapter runs one model session: it starts in a folder
 * (optionally resuming an earlier session), takes user messages (text plus attachments), can be
 * interrupted, and reports what happens as {@linkcode AgentEvent}s: the assistant's text and
 * thinking as they stream, tool calls and their results, the session's id and model, each turn's
 * usage and timing, errors, and the end of the process.
 *
 * Permissions: Claude Code asks through the hub (its `--permission-prompt-tool` is the hub's
 * `approve_tool`, lib/hub/tools.ts), so its adapter never sees them. An adapter that runs tools
 * in-process (the demo, a future API adapter) asks through `hooks.approve` instead. Either way
 * the question reaches the session layer (lib/agent/sessions.ts), which shows it in the tile.
 *
 * Implementations: Claude Code in desktop/agent-claude.ts (its wire format in
 * lib/agent/claude-stream.ts), Codex in desktop/agent-codex.ts (`codex app-server`'s JSON-RPC in
 * lib/agent/codex-app-server.ts), an in-process loop over Ollama or Anthropic's API in
 * lib/agent/inference-agent.ts (its file and shell tools ask through `hooks.approve`), and the
 * scripted demos in lib/agent/demo.ts and lib/agent/codex-demo.ts.
 *
 * Client-safe and pure (types and small helpers only).
 *
 * @module
 */

/** Claude Code's permission modes (`--permission-mode`); `default` asks for edits and commands. */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

/**
 * Which backend a session runs on: Claude Code, Codex, or the in-process loop over a local Ollama
 * model or Anthropic's API with the user's key. Absent means Claude Code.
 */
export type AgentKind = "claude" | "codex" | "ollama" | "anthropic";

export const AGENT_KINDS: readonly AgentKind[] = [
  "claude",
  "codex",
  "ollama",
  "anthropic",
];

/** What the tile and the `+` menu call a backend. */
export function agentLabel(kind: AgentKind | undefined): string {
  switch (kind ?? "claude") {
    case "codex":
      return "Codex";
    case "ollama":
      return "Ollama";
    case "anthropic":
      return "Anthropic API";
    default:
      return "Claude Code";
  }
}

/** A new tile's name (its hub name until renamed): `claude`, `codex`, `ollama`, `api`. */
export function agentDefaultName(kind: AgentKind | undefined): string {
  return kind === "anthropic" ? "api" : kind ?? "claude";
}

/** What a session starts with. */
export interface AgentSessionSpec {
  /** The backend (absent: Claude Code). */
  agent?: AgentKind;
  /** The working folder (absolute). */
  cwd: string;
  /** A model alias or name (`opus`, `sonnet[1m]`); the user's default when absent. */
  model?: string;
  /** Resume this earlier session (its transcript is not replayed: the tile keeps its own copy). */
  resumeId?: string;
  permissionMode?: PermissionMode;
  /**
   * More instructions for the model, after the harness's own system prompt (a preset's role;
   * Claude Code's `--append-system-prompt`). Adapters that cannot take one ignore it.
   */
  systemPrompt?: string;
  /**
   * Tools allowed without asking (a preset's; Claude Code's `--allowedTools` patterns such as
   * `Read`, `Bash(git diff:*)`). Adapters that cannot take them ignore them.
   */
  allowedTools?: string[];
}

/** A file attached to a message. */
export interface AgentAttachment {
  /** Its file name, as shown. */
  name: string;
  /** An image goes to the model as an image; anything else as text. */
  kind: "image" | "text";
  /** `image/png`, `text/plain`, … */
  mediaType: string;
  /** Base64 for an image, the text itself for a text file. */
  data: string;
}

/** One user message. */
export interface AgentMessage {
  text: string;
  attachments?: AgentAttachment[];
}

/** What a tool result carries besides its text, when the agent reports it (Claude Code does). */
export interface ToolDetail {
  /** An edit's change, as unified-diff hunks (`-old`, `+new`, ` context` lines). */
  patch?: { oldStart: number; newStart: number; lines: string[] }[];
  /**
   * A change to several files at once (Codex's file changes): each file's own hunks (`patch` is
   * all of them together, for the transcript's row).
   */
  files?: {
    path: string;
    patch: { oldStart: number; newStart: number; lines: string[] }[];
  }[];
  /** A command's output. */
  stdout?: string;
  stderr?: string;
  /** The command was interrupted. */
  interrupted?: boolean;
  /** A file written whole: how many lines. */
  wroteLines?: number;
  /** A file read: how many lines came back. */
  readLines?: number;
  /**
   * An edit's or a write's file as it was before (Claude Code's `originalFile`): `null` when the
   * write created it, absent when unknown or too big to keep (the Changes tab's revert).
   */
  original?: string | null;
}

/** A permission question: may the agent run this tool with this input? */
export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** The tool call it is about (Claude Code says which). */
  toolUseId?: string;
}

/** The user's answer: once, for the rest of the session (this tool), or no. */
export type PermissionDecision = "allow" | "always" | "deny";

/** Everything an agent session reports. `at` is epoch ms. */
export type AgentEvent =
  /** The session's identity, as the agent reports it (each turn; repeats are harmless). */
  | {
    kind: "session";
    sessionId: string;
    model?: string;
    cwd?: string;
    at: number;
  }
  /** A message the user sent (the session layer reports it as it hands it to the adapter). */
  | {
    kind: "user";
    text: string;
    attachments?: { name: string; kind: "image" | "text" }[];
    at: number;
  }
  /** Messages typed while a turn ran, waiting for it to end (the whole list each time). */
  | { kind: "queue"; items: string[]; at: number }
  /** More of the assistant's text; `id` names the text block (one row per block). */
  | { kind: "text"; id: string; delta: string; at: number }
  /**
   * More thinking (`delta` may be empty: Claude Code shows only that it thinks, and how many
   * tokens so far).
   */
  | { kind: "thinking"; id: string; delta: string; tokens?: number; at: number }
  /** A tool call began (its input may come later). */
  | { kind: "toolStart"; id: string; name: string; at: number }
  /** A tool call's whole input. */
  | {
    kind: "toolInput";
    id: string;
    name: string;
    input: Record<string, unknown>;
    at: number;
  }
  /** A tool call's result. */
  | {
    kind: "toolResult";
    id: string;
    text: string;
    isError: boolean;
    detail?: ToolDetail;
    at: number;
  }
  /** The agent asks before running a tool; answered through the session layer. */
  | {
    kind: "permission";
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string;
    at: number;
  }
  /** A permission question was answered (or withdrawn: `deny`). */
  | {
    kind: "permissionDone";
    requestId: string;
    decision: PermissionDecision;
    at: number;
  }
  /** The turn was interrupted (Escape, Stop). */
  | { kind: "interrupted"; at: number }
  /** A turn ended. */
  | {
    kind: "turnEnd";
    isError: boolean;
    /** Claude Code's `subtype` (`success`, `error_during_execution`, `error_max_turns`, …). */
    subtype?: string;
    durationMs?: number;
    outputTokens?: number;
    /** What the session has cost so far, in USD (cumulative in Claude Code). */
    costUsd?: number;
    /** The final answer, or why it failed. */
    result?: string;
    at: number;
  }
  /** Something went wrong that is not a turn's result (a start that failed, a write). */
  | { kind: "error"; message: string; at: number }
  /** A diagnostic line (logged, never shown). */
  | { kind: "log"; message: string; at: number }
  /** The agent's process ended. */
  | { kind: "exit"; reason: string; at: number }
  /** The models this backend offers (the header's picker; Codex and Ollama list their own). */
  | { kind: "models"; models: { id: string; label: string }[]; at: number };

/** Where an adapter sends its events. */
export interface AgentSink {
  event(e: AgentEvent): void;
}

/** What the session layer offers an adapter. */
export interface AgentHooks {
  /** Ask the user about a tool call (adapters that run tools themselves). */
  approve(req: PermissionRequest): Promise<PermissionDecision>;
}

/**
 * A coding-agent backend. One instance is one session: `start` it, `send` it messages (one turn
 * at a time: the session layer queues the rest), `interrupt` a turn, `stop` it.
 */
export interface AgentAdapter {
  /** What the tile calls it (`Claude Code`). */
  readonly label: string;
  /** Whether attached images reach the model as images. */
  readonly images: boolean;
  /** Start; resolves once it takes input (rejects with a reason a user can act on). */
  start(
    spec: AgentSessionSpec,
    sink: AgentSink,
    hooks: AgentHooks,
  ): Promise<void>;
  send(message: AgentMessage): Promise<void>;
  /** Stop the turn under way (the session stays). */
  interrupt(): Promise<void>;
  /** End the session (an `exit` event may still follow). */
  stop(): void;
}

/** The longest message text accepted. */
const MAX_MESSAGE = 100_000;
/** The most attachments on one message. */
const MAX_ATTACHMENTS = 8;
/** The largest attachment (base64 or text characters). */
const MAX_ATTACHMENT = 5 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An untrusted message (from the page) made safe, or `undefined` when it is not one. */
export function sanitizeMessage(raw: unknown): AgentMessage | undefined {
  if (!isObj(raw) || typeof raw.text !== "string") return undefined;
  const text = raw.text.slice(0, MAX_MESSAGE);
  const attachments: AgentAttachment[] = [];
  if (Array.isArray(raw.attachments)) {
    for (const a of raw.attachments.slice(0, MAX_ATTACHMENTS)) {
      if (
        !isObj(a) || typeof a.name !== "string" ||
        (a.kind !== "image" && a.kind !== "text") ||
        typeof a.mediaType !== "string" || typeof a.data !== "string" ||
        a.data.length > MAX_ATTACHMENT
      ) continue;
      if (
        a.kind === "image" && !/^image\/(png|jpeg|gif|webp)$/.test(a.mediaType)
      ) {
        continue;
      }
      attachments.push({
        name: a.name.slice(0, 200),
        kind: a.kind,
        mediaType: a.mediaType.slice(0, 100),
        data: a.data,
      });
    }
  }
  if (!text.trim() && attachments.length === 0) return undefined;
  return attachments.length > 0 ? { text, attachments } : { text };
}
