/**
 * Codex as an agent tile's backend, the pure half: `codex app-server`'s JSON-RPC (one JSON
 * message per line on stdin / stdout) spoken as a client, its notifications turned into
 * {@linkcode AgentEvent}s, its approval requests asked through the session layer's
 * `hooks.approve`. The process half is desktop/agent-codex.ts; the demo backend drives the same
 * client with a scripted server (lib/agent/codex-demo.ts).
 *
 * Verified against codex-cli 0.167.0 (`codex app-server generate-ts`, and a real handshake under
 * a temporary `CODEX_HOME`: `initialize`, `model/list`, `thread/start`, a failed `thread/resume`
 * and `turn/interrupt`; no turn was run):
 *
 * - The wire: JSON-RPC 2.0 without the `jsonrpc` member. A request `{id, method, params}`, its
 *   answer `{id, result}` or `{id, error: {code, message}}`; a notification `{method, params}`
 *   (the server adds `emittedAtMs`). The server also sends requests (approvals) that want an
 *   answer with the same id.
 * - The handshake: `initialize` (`clientInfo`, `capabilities`), then the `initialized`
 *   notification. Then `thread/start` (`cwd`, `model`, `approvalPolicy`, `sandbox`) or
 *   `thread/resume` (`threadId`, …): the answer has `thread.id` (a UUIDv7: what `codex resume`
 *   takes), `model` and `cwd`. `model/list` lists the models (`data[].id`, `displayName`,
 *   `hidden`, `isDefault`).
 * - A turn: `turn/start` (`threadId`, `input: UserInput[]`) answers `{turn}` at once; the turn
 *   streams `item/started` / `item/completed` (a `ThreadItem`: `agentMessage`, `reasoning`,
 *   `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, …), deltas
 *   (`item/agentMessage/delta`, `item/reasoning/summaryTextDelta`,
 *   `item/commandExecution/outputDelta`), `thread/tokenUsage/updated`, and ends with
 *   `turn/completed` (`turn.status`: completed, interrupted or failed, `turn.error`,
 *   `turn.durationMs`). `turn/interrupt` (`threadId`, `turnId`) stops it.
 * - Approvals: the server requests `item/commandExecution/requestApproval` (`itemId`, `command`,
 *   `cwd`, `reason`) and `item/fileChange/requestApproval` (`itemId`; the changes came with the
 *   item's `item/started`); the answer is `{decision}`: `accept`, `acceptForSession` or
 *   `decline`.
 *
 * Codex's items become the rows Claude Code's would (lib/agent/transcript.ts draws them): a
 * command is `Bash(command)` with its output (a lone read, listing or search the command parser
 * recognised is `Read`, `LS` or `Grep`, so runs of them group as Claude Code's do), a file change
 * is `Edit(path)` (`Write` for a new file) with its diff, an MCP call is `mcp__server__tool`.
 *
 * Pure (the transport comes in as `write`).
 *
 * @module
 */

import type {
  AgentEvent,
  AgentHooks,
  AgentMessage,
  AgentSessionSpec,
  AgentSink,
  PermissionDecision,
  PermissionMode,
  ToolDetail,
} from "./adapter.ts";

/** Printed by the hidden PTY's wrapper once the terminal is in raw mode, before Codex starts. */
export const CODEX_READY = '{"type":"qutty_codex_ready"}';

/** What {@linkcode codexAgentArgv} needs. */
export interface CodexAgentConfig {
  /** The `codex` executable. */
  codex: string;
  /** The tile's hub variables (`QUTTY_SOCK`, `QUTTY_TILE_ID`). */
  env: Readonly<Record<string, string>>;
}

/**
 * The hidden PTY's command: `env` sets the tile's hub variables, bash puts the terminal in raw
 * mode (no echo, no line editing: a message line can be long), prints {@linkcode CODEX_READY}
 * and runs `codex app-server` with its stdin a pipe from the terminal (the wrapper Claude Code's
 * adapter uses, lib/agent/claude-stream.ts).
 */
export function codexAgentArgv(
  cfg: CodexAgentConfig,
): { program: string; args: string[] } {
  const script = "stty raw -echo; " +
    `printf '%s\\n' '${CODEX_READY}'; exec "$0" "$@" < <(exec cat)`;
  return {
    program: "/usr/bin/env",
    args: [
      ...Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`),
      "/bin/bash",
      "-c",
      script,
      cfg.codex,
      "app-server",
    ],
  };
}

/** Codex's approval policy and sandbox for a tile's permission mode. */
export function codexPolicy(
  mode: PermissionMode | undefined,
): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    case "acceptEdits":
      // Edits inside the folder go ahead; Codex asks when it wants out of the sandbox.
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "plan":
      // Looks only: nothing is written, anything else is asked.
      return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default:
      // Asks before anything but known-safe reads, as Claude Code's default mode does.
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
  }
}

/** One user message as `turn/start`'s `input`: images as data URLs, text files inline. */
export function codexInput(message: AgentMessage): unknown[] {
  const files = message.attachments ?? [];
  const texts = files.filter((a) => a.kind === "text").map((a) =>
    `Attached file ${a.name}:\n\n${a.data}`
  );
  const text = [...texts, ...(message.text ? [message.text] : [])].join(
    "\n\n",
  );
  return [
    ...files.filter((a) => a.kind === "image").map((a) => ({
      type: "image",
      url: `data:${a.mediaType};base64,${a.data}`,
    })),
    ...(text ? [{ type: "text", text, text_elements: [] }] : []),
  ];
}

/**
 * A unified diff (`FileUpdateChange.diff`) as hunks. A new file's or a deleted file's text
 * without `@@` headers is one hunk of additions or removals.
 */
export function codexPatch(
  diff: string,
  kind: "add" | "delete" | "update" = "update",
): NonNullable<ToolDetail["patch"]> {
  const lines = diff.replace(/\n$/, "").split("\n");
  const hunks: NonNullable<ToolDetail["patch"]> = [];
  let current: (typeof hunks)[number] | undefined;
  for (const l of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      current = { oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // `diff --git`, `---`, `+++`, `index` headers
    if (l.startsWith("\\")) continue; // "\ No newline at end of file"
    current.lines.push(/^[+\- ]/.test(l) ? l : ` ${l}`);
  }
  if (hunks.length > 0 || !diff) return hunks;
  if (kind === "update") return [];
  const sign = kind === "add" ? "+" : "-";
  return [{
    oldStart: kind === "add" ? 0 : 1,
    newStart: kind === "add" ? 1 : 0,
    lines: lines.map((l) => `${sign}${l}`),
  }];
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** How a Codex item shows as a tool row: its Claude Code-style name and input. */
interface ToolShape {
  name: string;
  input: Record<string, unknown>;
}

/** A `fileChange` item's changes. */
interface FileChange {
  path: string;
  kind: "add" | "delete" | "update";
  diff: string;
}

function fileChanges(item: Json): FileChange[] {
  const raw = Array.isArray(item.changes) ? item.changes : [];
  return raw.filter(isObj).map((c) => {
    const k = isObj(c.kind) ? str(c.kind.type) : str(c.kind);
    return {
      path: str(c.path) ?? "",
      kind: k === "add" || k === "delete" ? k : "update",
      diff: str(c.diff) ?? "",
    };
  });
}

/** The row a command or file change item is drawn as. */
function toolShape(item: Json): ToolShape | undefined {
  switch (item.type) {
    case "commandExecution": {
      const command = str(item.command) ?? "";
      const actions = Array.isArray(item.commandActions)
        ? item.commandActions.filter(isObj)
        : [];
      const one = actions.length === 1 ? actions[0] : undefined;
      if (one?.type === "read" && str(one.path)) {
        return { name: "Read", input: { file_path: one.path, command } };
      }
      if (one?.type === "listFiles") {
        return {
          name: "LS",
          input: { path: str(one.path) ?? ".", command },
        };
      }
      if (one?.type === "search" && str(one.query)) {
        return {
          name: "Grep",
          input: {
            pattern: one.query,
            ...(str(one.path) ? { path: one.path } : {}),
            command,
          },
        };
      }
      return { name: "Bash", input: { command } };
    }
    case "fileChange": {
      const changes = fileChanges(item);
      const first = changes[0]?.path ?? "";
      const allNew = changes.length > 0 &&
        changes.every((c) => c.kind === "add");
      return {
        name: allNew && changes.length === 1 ? "Write" : "Edit",
        input: {
          file_path: first,
          ...(changes.length > 1 ? { files: changes.map((c) => c.path) } : {}),
        },
      };
    }
    case "mcpToolCall":
      return {
        name: `mcp__${str(item.server) ?? "mcp"}__${str(item.tool) ?? "tool"}`,
        input: isObj(item.arguments) ? item.arguments : {},
      };
    case "dynamicToolCall":
      return {
        name: str(item.tool) ?? "tool",
        input: isObj(item.arguments) ? item.arguments : {},
      };
    case "webSearch":
      return {
        name: "WebSearch",
        input: { query: str(item.query) ?? "" },
      };
    case "imageView":
      return { name: "Read", input: { file_path: str(item.path) ?? "" } };
    case "collabAgentToolCall":
      return {
        name: "Agent",
        input: { description: str(item.prompt) ?? str(item.tool) ?? "" },
      };
  }
  return undefined;
}

/** An MCP result's text (its text blocks joined). */
function mcpText(item: Json): string {
  if (isObj(item.error)) return str(item.error.message) ?? "Failed";
  const content = isObj(item.result) && Array.isArray(item.result.content)
    ? item.result.content
    : [];
  return content.filter(isObj).map((b) => str(b.text) ?? "").join("\n");
}

const FAILED = new Set(["failed", "declined"]);

/** The result of a finished tool item, or `undefined` when it is not one. */
function toolResult(
  item: Json,
  output: string,
): { text: string; isError: boolean; detail?: ToolDetail } | undefined {
  const status = str(item.status);
  const failed = status !== undefined && FAILED.has(status);
  switch (item.type) {
    case "commandExecution": {
      const out = str(item.aggregatedOutput) ?? output;
      const exitCode = num(item.exitCode);
      if (status === "declined") {
        return { text: "The user declined this command.", isError: true };
      }
      const isError = failed || (exitCode !== undefined && exitCode !== 0);
      const shape = toolShape(item);
      if (shape?.name === "Read" && !isError) {
        const lines = out.replace(/\n$/, "").split("\n").length;
        return { text: out, isError, detail: { readLines: out ? lines : 0 } };
      }
      return {
        text: out || (isError ? `Exit code ${exitCode ?? "?"}` : ""),
        isError,
        detail: { stdout: out },
      };
    }
    case "fileChange": {
      if (status === "declined") {
        return { text: "The user declined this change.", isError: true };
      }
      const changes = fileChanges(item);
      const each = changes.map((c) => ({
        path: c.path,
        patch: codexPatch(c.diff, c.kind),
      }));
      const patch = each.flatMap((c) => c.patch);
      const paths = changes.map((c) => c.path).join(", ");
      return failed
        ? { text: `The change to ${paths} failed.`, isError: true }
        : {
          text: `Updated ${paths}`,
          isError: false,
          ...(patch.length > 0
            ? {
              detail: {
                patch,
                // The Changes tab's per-file diffs (the row names only the first file).
                ...(each.length > 1 ? { files: each } : {}),
              },
            }
            : {}),
        };
    }
    case "mcpToolCall":
      return { text: mcpText(item), isError: failed || isObj(item.error) };
    case "dynamicToolCall": {
      const items = Array.isArray(item.contentItems)
        ? item.contentItems.filter(isObj)
        : [];
      return {
        text: items.map((b) => str(b.text) ?? "").join("\n"),
        isError: failed || item.success === false,
      };
    }
    case "webSearch":
    case "imageView":
    case "collabAgentToolCall":
      return { text: "", isError: failed };
  }
  return undefined;
}

/** A JSON-RPC request in flight. */
interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** What the client needs. */
export interface CodexClientOptions {
  /** Write one line to the server's stdin (the client adds the newline). */
  write(line: string): Promise<void>;
  sink: AgentSink;
  hooks: AgentHooks;
  /** This app's version, for `clientInfo`. */
  version?: string;
  now?(): number;
}

/** The answer to an approval: once, for the session, or no. */
const DECISIONS: Record<PermissionDecision, string> = {
  allow: "accept",
  always: "acceptForSession",
  deny: "decline",
};

/**
 * A `codex app-server` client for one thread. Feed it the server's output (`push`, any
 * chunking); `open` it, `send` turns, `interrupt` one.
 */
export class CodexAppServer {
  #opts: CodexClientOptions;
  #buf = "";
  #next = 0;
  #pending = new Map<number, Pending>();
  #threadId: string | undefined;
  #turnId: string | undefined;
  /** A turn is under way (from `send` until `turn/completed`). */
  #running = false;
  #interruptWanted = false;
  #turnStarted = 0;
  /** The thread's output tokens when the turn began (usage is cumulative). */
  #tokensAtStart = 0;
  #tokens = 0;
  /** Items whose text came as deltas (their whole copy is skipped). */
  #streamed = new Set<string>();
  /** Command output so far, per item (when the completed item has none). */
  #output = new Map<string, string>();
  /** Items seen started (a file change's approval names only its item). */
  #items = new Map<string, Json>();
  #closed: string | undefined;

  constructor(opts: CodexClientOptions) {
    this.#opts = opts;
  }

  /** The thread's id once open (what `codex resume` takes). */
  get threadId(): string | undefined {
    return this.#threadId;
  }

  #now(): number {
    return this.#opts.now?.() ?? Date.now();
  }

  #emit(e: AgentEvent): void {
    this.#opts.sink.event(e);
  }

  #log(message: string): void {
    this.#emit({ kind: "log", message, at: this.#now() });
  }

  /** The server's raw output; complete lines are handled. */
  push(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).replace(/\r$/, "");
      this.#buf = this.#buf.slice(nl + 1);
      this.line(line);
    }
  }

  /** One line of the server's output. */
  line(raw: string): void {
    const start = raw.indexOf("{");
    if (start < 0) {
      // deno-lint-ignore no-control-regex
      const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
      if (text) this.#log(text);
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(raw.slice(start));
    } catch {
      this.#log(raw.slice(0, 500));
      return;
    }
    if (!isObj(msg)) return;
    const method = str(msg.method);
    const id = msg.id;
    if (method && (typeof id === "number" || typeof id === "string")) {
      void this.#serverRequest(id, method, isObj(msg.params) ? msg.params : {});
    } else if (method) {
      this.#notification(method, isObj(msg.params) ? msg.params : {});
    } else if (typeof id === "number") {
      const p = this.#pending.get(id);
      if (!p) return;
      this.#pending.delete(id);
      if (isObj(msg.error)) {
        p.reject(new Error(str(msg.error.message) ?? "Codex refused"));
      } else p.resolve(msg.result);
    }
  }

  /** Send request `method`; its result. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(this.#closed));
    const id = ++this.#next;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#opts.write(JSON.stringify({ id, method, params })).catch((e) => {
      const p = this.#pending.get(id);
      this.#pending.delete(id);
      p?.reject(e instanceof Error ? e : new Error(String(e)));
    });
    return answer;
  }

  #notify(method: string, params?: unknown): Promise<void> {
    return this.#opts.write(
      JSON.stringify(params === undefined ? { method } : { method, params }),
    );
  }

  #answer(id: number | string, result: unknown): Promise<void> {
    return this.#opts.write(JSON.stringify({ id, result })).catch(() => {});
  }

  /**
   * The handshake and the thread: a new one, or `spec.resumeId` resumed (rejects when Codex has
   * no such thread). Reports the session (thread id, model, folder) and the models.
   */
  async open(spec: AgentSessionSpec): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "qutty",
        title: "Qutty",
        version: this.#opts.version ?? "0",
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    await this.#notify("initialized");
    void this.request("model/list", {}).then(
      (r) => this.#models(r),
      (e) => this.#log(`model/list: ${e instanceof Error ? e.message : e}`),
    );
    const policy = codexPolicy(spec.permissionMode);
    const common = {
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      ...policy,
    };
    let result: unknown;
    if (spec.resumeId) {
      try {
        result = await this.request("thread/resume", {
          threadId: spec.resumeId,
          ...common,
          excludeTurns: true,
        });
      } catch (e) {
        throw new Error(
          `Codex could not resume thread ${spec.resumeId.slice(0, 8)}: ${
            e instanceof Error ? e.message : e
          } (New session starts over)`,
        );
      }
    } else result = await this.request("thread/start", common);
    const r = isObj(result) ? result : {};
    const thread = isObj(r.thread) ? r.thread : {};
    const threadId = str(thread.id);
    if (!threadId) throw new Error("Codex started no thread");
    this.#threadId = threadId;
    this.#emit({
      kind: "session",
      sessionId: threadId,
      ...(str(r.model) ? { model: str(r.model) } : {}),
      ...(str(r.cwd) ? { cwd: str(r.cwd) } : {}),
      at: this.#now(),
    });
  }

  #models(result: unknown): void {
    const data = isObj(result) && Array.isArray(result.data)
      ? result.data.filter(isObj)
      : [];
    const models = data.filter((m) => m.hidden !== true && str(m.id)).map(
      (m) => ({
        id: str(m.id)!,
        label: str(m.displayName) ?? str(m.id)!,
      }),
    );
    if (models.length === 0) return;
    this.#emit({
      kind: "models",
      models: [{ id: "", label: "default" }, ...models],
      at: this.#now(),
    });
  }

  /** One user turn (resolves once Codex took it). */
  async send(message: AgentMessage): Promise<void> {
    if (!this.#threadId) throw new Error("the session is not running");
    this.#running = true;
    this.#interruptWanted = false;
    this.#turnId = undefined;
    this.#turnStarted = this.#now();
    this.#tokensAtStart = this.#tokens;
    let result: unknown;
    try {
      result = await this.request("turn/start", {
        threadId: this.#threadId,
        input: codexInput(message),
      });
    } catch (e) {
      this.#running = false;
      throw e;
    }
    const turn = isObj(result) && isObj(result.turn) ? result.turn : {};
    this.#turnId ??= str(turn.id);
    if (this.#interruptWanted) await this.interrupt();
  }

  /** Stop the turn under way (its end is reported by `turn/completed`). */
  async interrupt(): Promise<void> {
    if (!this.#running || !this.#threadId) return;
    if (!this.#turnId) {
      // `turn/start` has not answered yet: interrupt once it does.
      this.#interruptWanted = true;
      return;
    }
    this.#interruptWanted = false;
    try {
      await this.request("turn/interrupt", {
        threadId: this.#threadId,
        turnId: this.#turnId,
      });
    } catch (e) {
      this.#log(`turn/interrupt: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** The server is gone: requests in flight fail with `reason`. */
  close(reason: string): void {
    this.#closed = reason;
    for (const p of this.#pending.values()) p.reject(new Error(reason));
    this.#pending.clear();
  }

  // --- the server's requests ---------------------------------------------------------------

  async #serverRequest(
    id: number | string,
    method: string,
    params: Json,
  ): Promise<void> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const itemId = str(params.itemId);
        const item = itemId ? this.#items.get(itemId) : undefined;
        const command = str(params.command) ?? str(item?.command) ?? "";
        const decision = await this.#opts.hooks.approve({
          toolName: "Bash",
          input: {
            command,
            ...(str(params.cwd) ? { cwd: str(params.cwd) } : {}),
            ...(str(params.reason) ? { description: str(params.reason) } : {}),
          },
          ...(itemId ? { toolUseId: itemId } : {}),
        });
        return this.#answer(id, { decision: DECISIONS[decision] });
      }
      case "item/fileChange/requestApproval": {
        const itemId = str(params.itemId);
        const item = itemId ? this.#items.get(itemId) : undefined;
        const shape = item ? toolShape(item) : undefined;
        const decision = await this.#opts.hooks.approve({
          toolName: shape?.name ?? "Edit",
          input: {
            ...(shape?.input ?? {}),
            ...(str(params.reason) ? { description: str(params.reason) } : {}),
          },
          ...(itemId ? { toolUseId: itemId } : {}),
        });
        return this.#answer(id, { decision: DECISIONS[decision] });
      }
      default:
        // Questions Qutty does not ask (user input, MCP elicitation, permission profiles): say
        // so, which Codex takes as a refusal.
        this.#log(`unanswered server request ${method}`);
        await this.#opts.write(JSON.stringify({
          id,
          error: { code: -32601, message: `Qutty does not answer ${method}` },
        })).catch(() => {});
    }
  }

  // --- notifications -----------------------------------------------------------------------

  #notification(method: string, p: Json): void {
    const at = this.#now();
    if (
      str(p.threadId) && this.#threadId && str(p.threadId) !== this.#threadId
    ) return; // another thread (a subagent's)
    switch (method) {
      case "turn/started": {
        const turn = isObj(p.turn) ? p.turn : {};
        this.#turnId = str(turn.id) ?? this.#turnId;
        if (this.#interruptWanted) void this.interrupt();
        return;
      }
      case "item/started":
        return this.#itemStarted(isObj(p.item) ? p.item : {}, at);
      case "item/completed":
        return this.#itemCompleted(isObj(p.item) ? p.item : {}, at);
      case "item/agentMessage/delta": {
        const itemId = str(p.itemId);
        const delta = str(p.delta);
        if (!itemId || !delta) return;
        this.#streamed.add(itemId);
        this.#emit({ kind: "text", id: itemId, delta, at });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const itemId = str(p.itemId);
        if (!itemId) return;
        this.#streamed.add(itemId);
        this.#emit({
          kind: "thinking",
          id: itemId,
          delta: str(p.delta) ?? "",
          at,
        });
        return;
      }
      case "item/reasoning/summaryPartAdded": {
        const itemId = str(p.itemId);
        if (itemId && this.#streamed.has(itemId)) {
          this.#emit({ kind: "thinking", id: itemId, delta: "\n\n", at });
        }
        return;
      }
      case "item/commandExecution/outputDelta": {
        const itemId = str(p.itemId);
        if (!itemId) return;
        this.#output.set(
          itemId,
          (this.#output.get(itemId) ?? "") + (str(p.delta) ?? ""),
        );
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = isObj(p.tokenUsage) ? p.tokenUsage : {};
        const total = isObj(usage.total) ? usage.total : {};
        this.#tokens = num(total.outputTokens) ?? this.#tokens;
        return;
      }
      case "turn/completed":
        return this.#turnCompleted(isObj(p.turn) ? p.turn : {}, at);
      case "error": {
        const error = isObj(p.error) ? p.error : {};
        this.#log(
          `${p.willRetry ? "retrying: " : ""}${str(error.message) ?? "error"}`,
        );
        return;
      }
      case "warning":
      case "configWarning":
      case "deprecationNotice":
      case "guardianWarning":
        this.#log(`${method}: ${str(p.message) ?? JSON.stringify(p)}`);
        return;
    }
  }

  #itemStarted(item: Json, at: number): void {
    const id = str(item.id);
    if (!id) return;
    this.#items.set(id, item);
    if (item.type === "reasoning") {
      this.#emit({ kind: "thinking", id, delta: "", at });
      return;
    }
    const shape = toolShape(item);
    if (!shape) return;
    this.#emit({ kind: "toolStart", id, name: shape.name, at });
    this.#emit({ kind: "toolInput", id, ...shape, at });
  }

  #itemCompleted(item: Json, at: number): void {
    const id = str(item.id);
    if (!id) return;
    const seen = this.#items.get(id);
    this.#items.delete(id);
    switch (item.type) {
      case "agentMessage": {
        const text = str(item.text);
        if (!this.#streamed.delete(id) && text) {
          this.#emit({ kind: "text", id, delta: text, at });
        }
        return;
      }
      case "reasoning": {
        if (this.#streamed.delete(id)) return;
        const parts = [
          ...(Array.isArray(item.summary) ? item.summary : []),
          ...(Array.isArray(item.content) ? item.content : []),
        ].filter((s): s is string => typeof s === "string" && s.length > 0);
        if (parts.length > 0) {
          this.#emit({ kind: "thinking", id, delta: parts.join("\n\n"), at });
        }
        return;
      }
      case "plan": {
        const text = str(item.text);
        if (text) {
          this.#emit({ kind: "text", id, delta: `**Plan**\n\n${text}`, at });
        }
        return;
      }
    }
    const shape = toolShape(item);
    const result = toolResult(item, this.#output.get(id) ?? "");
    this.#output.delete(id);
    if (!shape || !result) {
      if (item.type) this.#log(`item ${String(item.type)}`);
      return;
    }
    if (!seen) {
      this.#emit({ kind: "toolStart", id, name: shape.name, at });
    }
    // The completed item's input is the whole one (a file change's diffs may have grown).
    this.#emit({ kind: "toolInput", id, ...shape, at });
    this.#emit({ kind: "toolResult", id, ...result, at });
  }

  #turnCompleted(turn: Json, at: number): void {
    if (!this.#running) return;
    this.#running = false;
    this.#interruptWanted = false;
    this.#turnId = undefined;
    const status = str(turn.status);
    const error = isObj(turn.error) ? str(turn.error.message) : undefined;
    const durationMs = num(turn.durationMs) ??
      Math.max(0, at - this.#turnStarted);
    const outputTokens = Math.max(0, this.#tokens - this.#tokensAtStart);
    const common = {
      durationMs,
      ...(outputTokens > 0 ? { outputTokens } : {}),
      at,
    };
    if (status === "interrupted") {
      this.#emit({
        kind: "turnEnd",
        isError: true,
        subtype: "error_during_execution",
        ...common,
      });
    } else if (status === "failed") {
      this.#emit({
        kind: "turnEnd",
        isError: true,
        subtype: "error",
        result: error ?? "The turn failed.",
        ...common,
      });
    } else {
      this.#emit({
        kind: "turnEnd",
        isError: false,
        subtype: "success",
        ...common,
      });
    }
    this.#streamed.clear();
    this.#output.clear();
  }
}
