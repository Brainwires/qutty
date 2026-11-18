/**
 * An agent tile on a model Qutty calls itself: a local Ollama model or Anthropic's API with the
 * user's key, through the companion's agent loop (lib/companion/inference-brain.ts
 * `InferenceBrain`, `@rullama/inference`'s `runAgentLoop`), with coding tools instead of the hub's.
 *
 * The tools run in process, in the session's folder, through an injected {@linkcode CodingHost}
 * (the desktop's is desktop/agent-inference.ts): `Read`, `Write`, `Edit` and `Bash`, named and
 * shaped like Claude Code's so the transcript draws them the same way (`Edit`'s diff, `Bash`'s
 * output). Before anything but a read they ask through the session layer's `hooks.approve`
 * (Allow / Allow always / Deny in the tile), as the permission mode says:
 *
 * - `default`: `Write`, `Edit` and `Bash` ask;
 * - `acceptEdits`: `Bash` asks, edits go ahead;
 * - `plan`: only `Read` (the others are refused without asking);
 * - `bypassPermissions`: nothing asks.
 *
 * Each turn's assistant text arrives whole per model call (the provider is not streamed); a tool
 * call starts a new text row. An interrupt aborts the turn (its model request and a running
 * command) and forgets it, so the conversation never holds a tool call without its result.
 *
 * Pure apart from the injected provider and host.
 *
 * @module
 */

import type { Provider } from "@rullama/core";
import {
  type CompanionToolDef,
  type CompanionTools,
  InferenceBrain,
} from "../companion/inference-brain.ts";
import type {
  AgentAdapter,
  AgentEvent,
  AgentHooks,
  AgentMessage,
  AgentSessionSpec,
  AgentSink,
  PermissionMode,
  ToolDetail,
} from "./adapter.ts";

/** What the tools do to the machine (the desktop: Deno's file system and a shell). */
export interface CodingHost {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  /** Run `command` in a shell in `cwd`; killed when `signal` aborts. */
  run(
    command: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** The tools, as the model sees them. */
export const CODING_TOOLS: readonly CompanionToolDef[] = [
  {
    name: "Read",
    description:
      "Read a text file. Paths are relative to the working folder or absolute. Returns the " +
      "file's lines, numbered.",
    inputSchema: {
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description: "Write a whole file (created, or replaced).",
    inputSchema: {
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description:
      "Replace one exact occurrence of old_string with new_string in a file (read it first; " +
      "old_string must match once, whitespace included).",
    inputSchema: {
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "Bash",
    description:
      "Run a shell command in the working folder (bash -lc); returns its output and exit " +
      "code. For listing, searching (rg, grep), building and testing.",
    inputSchema: {
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

/** The system prompt of a coding session in `cwd`. */
export function codingSystemPrompt(cwd: string): string {
  return [
    "You are a coding agent working in a user's project through tools, inside Qutty (a",
    `terminal app). The working folder is ${cwd}.`,
    "Use Read to look at files, Edit for changes to existing files (read them first), Write for",
    "new files, Bash for commands (listing, searching with rg or grep, building, testing).",
    "The user may deny a tool call: then do not retry it, say what you would have done.",
    "Be concise. When done, say in a few lines what you changed.",
  ].join(" ");
}

/** Whether a tool call needs the user's yes in `mode` (`"refuse"`: never allowed). */
export function needsApproval(
  tool: string,
  mode: PermissionMode | undefined,
): boolean | "refuse" {
  if (tool === "Read") return false;
  switch (mode) {
    case "bypassPermissions":
      return false;
    case "plan":
      return "refuse";
    case "acceptEdits":
      return tool === "Bash";
    default:
      return true;
  }
}

/** The longest output handed back from a command or a read. */
const MAX_OUTPUT = 30_000;

const clip = (s: string) =>
  s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (cut)` : s;

/** `path` made absolute against `cwd`. */
export function resolvePath(cwd: string, path: string): string {
  if (path.startsWith("/")) return path;
  const parts = `${cwd.replace(/\/+$/, "")}/${path}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return `/${out.join("/")}`;
}

/** The 1-based line `index` (a character offset) falls on. */
const lineAt = (text: string, index: number) =>
  text.slice(0, index).split("\n").length;

/** One edit's diff hunk: the old lines removed, the new added. */
function editPatch(
  before: string,
  index: number,
  oldString: string,
  newString: string,
): NonNullable<ToolDetail["patch"]> {
  const start = lineAt(before, index);
  return [{
    oldStart: start,
    newStart: start,
    lines: [
      ...oldString.split("\n").map((l) => `-${l}`),
      ...newString.split("\n").map((l) => `+${l}`),
    ],
  }];
}

type ToolOutcome = { text: string; isError: boolean; detail?: ToolDetail };

/** What an inference session is configured with. */
export interface InferenceAgentOptions {
  /** What the tile calls it (`Ollama (qwen3:8b)`). */
  label: string;
  /** The provider (built for the session's model). */
  provider: Provider;
  host: CodingHost;
  /** Checked on start; throws a reason a user can act on. The models to offer, when it lists them. */
  check?(): Promise<{ id: string; label: string }[] | void>;
  /** The model the session runs (the header shows it). */
  model?: string;
  temperature?: number;
  /** Model calls per turn (default 40). */
  maxIterations?: number;
  /** How the conversation is bounded (see `InferenceBrainOptions.history`). */
  history?: "trim" | { fresh: number };
}

/** The in-process coding agent as an {@linkcode AgentAdapter}. */
export class InferenceAgentAdapter implements AgentAdapter {
  readonly label: string;
  /** Turns go to the loop as text: an attached image is mentioned, not sent. */
  readonly images = false;
  #opts: InferenceAgentOptions;
  #brain: InferenceBrain | undefined;
  #sink: AgentSink | undefined;
  #hooks: AgentHooks | undefined;
  #spec: AgentSessionSpec | undefined;
  #turn = 0;
  /** The turn under way (0: none). */
  #running = 0;
  #textId: string | undefined;
  #toolId: string | undefined;
  #started = 0;
  #tools = 0;

  constructor(opts: InferenceAgentOptions) {
    this.#opts = opts;
    this.label = opts.label;
  }

  #emit(e: AgentEvent): void {
    this.#sink?.event(e);
  }

  async start(
    spec: AgentSessionSpec,
    sink: AgentSink,
    hooks: AgentHooks,
  ): Promise<void> {
    const models = await this.#opts.check?.();
    this.#spec = spec;
    this.#sink = sink;
    this.#hooks = hooks;
    const tools: CompanionTools = {
      list: () => [...CODING_TOOLS],
      call: (name, args, signal) => this.#call(name, args, signal),
    };
    const brain = new InferenceBrain({
      label: this.label,
      provider: this.#opts.provider,
      tools,
      systemPrompt: codingSystemPrompt(spec.cwd),
      maxIterations: this.#opts.maxIterations ?? 40,
      maxTokens: 8192,
      ...(this.#opts.history ? { history: this.#opts.history } : {}),
      ...(this.#opts.temperature !== undefined
        ? { temperature: this.#opts.temperature }
        : {}),
    });
    await brain.start({
      event: (e) => {
        const at = Date.now();
        switch (e.kind) {
          case "text": {
            if (!this.#running) return;
            const fresh = !this.#textId;
            this.#textId ??= `t${this.#turn}-${++this.#tools}`;
            const delta = fresh ? e.delta.replace(/^\n+/, "") : e.delta;
            if (delta) {
              this.#emit({ kind: "text", id: this.#textId, delta, at });
            }
            return;
          }
          case "toolUse":
            this.#textId = undefined;
            this.#toolId = e.id ?? `tool-${this.#turn}-${++this.#tools}`;
            return;
          case "turnEnd":
            if (!this.#running) return;
            this.#running = 0;
            this.#emit({
              kind: "turnEnd",
              isError: e.isError,
              subtype: e.isError ? "error" : "success",
              durationMs: at - this.#started,
              ...(e.isError ? { result: e.text || "The turn failed." } : {}),
              at,
            });
            return;
          case "log":
            this.#emit({ kind: "log", message: e.message, at });
            return;
        }
      },
      exited: (reason) => this.#emit({ kind: "exit", reason, at: Date.now() }),
    });
    this.#brain = brain;
    if (models && models.length > 0) {
      this.#emit({ kind: "models", models, at: Date.now() });
    }
  }

  send(message: AgentMessage): Promise<void> {
    if (!this.#brain) {
      return Promise.reject(new Error("the session is not running"));
    }
    this.#running = ++this.#turn;
    this.#textId = undefined;
    this.#started = Date.now();
    const files = message.attachments ?? [];
    const text = [
      ...files.filter((a) => a.kind === "text").map((a) =>
        `Attached file ${a.name}:\n\n${a.data}`
      ),
      ...(files.some((a) => a.kind === "image")
        ? ["(An image was attached; this model is not given images.)"]
        : []),
      ...(message.text ? [message.text] : []),
    ].join("\n\n");
    return this.#brain.send(text);
  }

  interrupt(): Promise<void> {
    if (!this.#running || !this.#brain) return Promise.resolve();
    this.#running = 0;
    this.#brain.interrupt();
    this.#emit({
      kind: "turnEnd",
      isError: true,
      subtype: "error_during_execution",
      durationMs: Date.now() - this.#started,
      at: Date.now(),
    });
    return Promise.resolve();
  }

  stop(): void {
    this.#running = 0;
    this.#brain?.stop();
    this.#brain = undefined;
    this.#sink = undefined;
  }

  /** A tool call: its row, the question when it needs one, the work, the result. */
  async #call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const id = this.#toolId ?? `tool-${this.#turn}-${++this.#tools}`;
    this.#toolId = undefined;
    const turn = this.#running;
    const at = () => Date.now();
    this.#emit({ kind: "toolStart", id, name, at: at() });
    this.#emit({ kind: "toolInput", id, name, input: args, at: at() });
    const done = (r: ToolOutcome) => {
      if (this.#running === turn && !signal.aborted) {
        this.#emit({ kind: "toolResult", id, ...r, at: at() });
      }
      return { text: r.text, isError: r.isError };
    };
    if (!CODING_TOOLS.some((t) => t.name === name)) {
      return done({ text: `No such tool: ${name}`, isError: true });
    }
    const need = needsApproval(name, this.#spec?.permissionMode);
    if (need === "refuse") {
      return done({
        text: `Plan mode: ${name} is not allowed (looking only).`,
        isError: true,
      });
    }
    if (need) {
      const decision = await this.#hooks!.approve({
        toolName: name,
        input: args,
        toolUseId: id,
      });
      if (decision === "deny") {
        return done({
          text: "The user denied this tool call in Qutty.",
          isError: true,
        });
      }
    }
    if (signal.aborted) return { text: "Interrupted", isError: true };
    try {
      return done(await this.#run(name, args, signal));
    } catch (e) {
      return done({
        text: e instanceof Error ? e.message : String(e),
        isError: true,
      });
    }
  }

  async #run(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const cwd = this.#spec?.cwd ?? "/";
    const host = this.#opts.host;
    const pathArg = () => {
      if (typeof args.file_path !== "string" || !args.file_path) {
        throw new Error("file_path is required");
      }
      return resolvePath(cwd, args.file_path);
    };
    switch (name) {
      case "Read": {
        const text = await host.readFile(pathArg());
        const lines = text.replace(/\n$/, "").split("\n");
        return {
          text: clip(lines.map((l, i) => `${i + 1}\t${l}`).join("\n")),
          isError: false,
          detail: { readLines: text ? lines.length : 0 },
        };
      }
      case "Write": {
        const content = typeof args.content === "string" ? args.content : "";
        const path = pathArg();
        await host.writeFile(path, content);
        const lines = content ? content.replace(/\n$/, "").split("\n") : [];
        return {
          text: `Wrote ${path}`,
          isError: false,
          detail: { wroteLines: lines.length },
        };
      }
      case "Edit": {
        const path = pathArg();
        const oldString = typeof args.old_string === "string"
          ? args.old_string
          : "";
        const newString = typeof args.new_string === "string"
          ? args.new_string
          : "";
        if (!oldString) throw new Error("old_string is required");
        const before = await host.readFile(path);
        const index = before.indexOf(oldString);
        if (index < 0) throw new Error(`old_string is not in ${path}`);
        if (before.indexOf(oldString, index + 1) >= 0) {
          throw new Error(
            `old_string occurs more than once in ${path}: give more context`,
          );
        }
        await host.writeFile(
          path,
          before.slice(0, index) + newString +
            before.slice(index + oldString.length),
        );
        return {
          text: `The file ${path} has been updated.`,
          isError: false,
          detail: { patch: editPatch(before, index, oldString, newString) },
        };
      }
      default: {
        const command = typeof args.command === "string" ? args.command : "";
        if (!command.trim()) throw new Error("command is required");
        const r = await host.run(command, cwd, signal);
        const out = clip(
          `${r.stdout}${r.stderr ? `${r.stdout ? "\n" : ""}${r.stderr}` : ""}`,
        );
        return {
          text: r.code === 0 ? out : `${out}\n(exit code ${r.code})`.trim(),
          isError: r.code !== 0,
          detail: {
            stdout: clip(r.stdout),
            stderr: clip(r.stderr),
            interrupted: signal.aborted,
          },
        };
      }
    }
  }
}
