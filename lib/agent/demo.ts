/**
 * The demo backend's agent (plain-browser development and the e2e suite): a scripted Claude Code
 * session. Each turn is replayed as Claude Code's own stream-json lines (the shapes of the
 * recorded fixtures in tests/fixtures/agent/) through the real parser
 * (lib/agent/claude-stream.ts), so the demo drives the tile exactly as the real thing would:
 *
 * - any prompt: thinking, a line of text, a `Read` of `notes.md`, a `Grep`, an `Edit` of
 *   `notes.md` that asks for permission (Allow applies the change, Deny refuses it), a `Bash`
 *   command, and a markdown answer (a heading, a list, a code block, a link), then a footer;
 * - a prompt with `plan`: only the looking (thinking, text, the read and the grep), no edit;
 * - a prompt with `slow`: the same, a step every 400 ms (time to interrupt it);
 * - a prompt with `fail`: the turn fails with an API error;
 * - a prompt with `hello`: a one-line answer, no tools;
 * - a prompt `link <url>`: a one-line answer linking to `<url>`, no tools.
 *
 * Client-safe.
 *
 * @module
 */

import type {
  AgentAdapter,
  AgentHooks,
  AgentMessage,
  AgentSessionSpec,
  AgentSink,
} from "./adapter.ts";
import { ClaudeStreamParser } from "./claude-stream.ts";

/** The demo's folder for paths (the demo has no file system). */
const DEMO_CWD = "/Users/demo/project";

const ANSWER = [
  "## What changed",
  "",
  "I updated **notes.md** so the greeting reads *goodbye*:",
  "",
  "- the first line is replaced",
  "- nothing else moved",
  "",
  "```ts",
  'const greeting = "goodbye"; // was "hello"',
  "export function greet(name: string) {",
  "  return `${greeting}, ${name}`;",
  "}",
  "```",
  "",
  "See [the docs](https://example.com/docs) for more.",
].join("\n");

/** Words of `s` with their spaces, a few per chunk (how deltas arrive). */
function chunks(s: string, per = 3): string[] {
  const words = s.split(/(?<=\s)/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += per) {
    out.push(words.slice(i, i + per).join(""));
  }
  return out;
}

/** A scripted Claude Code session. */
export class DemoAgentAdapter implements AgentAdapter {
  readonly label = "Claude Code (demo)";
  readonly images = true;
  #sink: AgentSink | undefined;
  #hooks: AgentHooks | undefined;
  #parser = new ClaudeStreamParser();
  #session = "";
  #spec: AgentSessionSpec | undefined;
  #turn = 0;
  /** The turn under way: its number (a new turn or an interrupt changes it). */
  #running = 0;
  #msg = 0;
  #cost = 0;
  #timers = new Set<ReturnType<typeof setTimeout>>();

  // deno-lint-ignore require-await
  async start(
    spec: AgentSessionSpec,
    sink: AgentSink,
    hooks: AgentHooks,
  ): Promise<void> {
    this.#spec = spec;
    this.#sink = sink;
    this.#hooks = hooks;
    this.#session = spec.resumeId ??
      `demo-${
        Math.random().toString(16).slice(2, 10)
      }-0000-4000-8000-000000000000`;
  }

  #line(v: unknown): void {
    if (!this.#sink) return;
    for (const e of this.#parser.line(JSON.stringify(v))) this.#sink.event(e);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#timers.delete(t);
        resolve();
      }, ms);
      this.#timers.add(t);
    });
  }

  async send(message: AgentMessage): Promise<void> {
    const turn = ++this.#turn;
    this.#running = turn;
    const live = () => this.#running === turn;
    const prompt = message.text.toLowerCase();
    const step = prompt.includes("slow") ? 400 : 25;
    const started = Date.now();
    this.#line({
      type: "system",
      subtype: "init",
      cwd: this.#spec?.cwd ?? DEMO_CWD,
      session_id: this.#session,
      model: this.#spec?.model ?? "claude-opus-5-5",
      permissionMode: "default",
    });
    const msgStart = () => {
      const id = `msg_demo_${++this.#msg}`;
      this.#line({
        type: "stream_event",
        event: { type: "message_start", message: { id, role: "assistant" } },
      });
      return id;
    };
    const text = async (s: string) => {
      const id = msgStart();
      this.#line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
      });
      for (const c of chunks(s)) {
        if (!live()) return;
        this.#line({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: c },
          },
        });
        await this.#sleep(step / 3);
      }
      this.#line({
        type: "assistant",
        message: { id, content: [{ type: "text", text: s }] },
      });
      this.#line({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      });
    };
    const tool = async (
      name: string,
      input: Record<string, unknown>,
      result: () => Promise<
        { text: string; isError?: boolean; detail?: unknown }
      >,
    ) => {
      const id = msgStart();
      const toolId = `toolu_demo_${this.#msg}`;
      this.#line({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: toolId, name, input: {} },
        },
      });
      this.#line({
        type: "assistant",
        message: {
          id,
          content: [{ type: "tool_use", id: toolId, name, input }],
        },
      });
      await this.#sleep(step);
      if (!live()) return;
      const r = await result.call(this);
      if (!live()) return;
      this.#line({
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolId,
            content: r.text,
            ...(r.isError ? { is_error: true } : {}),
          }],
        },
        ...(r.detail ? { tool_use_result: r.detail } : {}),
      });
      return toolId;
    };
    const end = (isError: boolean, result: string, outputTokens: number) => {
      if (!live()) return;
      this.#running = 0;
      this.#cost += 0.0021;
      this.#line({
        type: "result",
        subtype: isError ? "error_during_execution" : "success",
        is_error: isError,
        duration_ms: Date.now() - started,
        total_cost_usd: this.#cost,
        usage: { output_tokens: outputTokens },
        result,
      });
    };

    await this.#sleep(step);
    if (!live()) return;
    if (prompt.includes("fail")) {
      return end(true, "API Error: 529 overloaded (demo)", 0);
    }
    const link = /^link (\S+)$/i.exec(message.text.trim());
    if (link) {
      const answer = `Here is [the page](${link[1]}).`;
      await text(answer);
      return end(false, answer, 9);
    }
    if (prompt.includes("hello") && !prompt.includes("slow")) {
      await text("Hello! I am the demo agent.");
      return end(false, "Hello! I am the demo agent.", 9);
    }
    // Thinking (empty text, as Claude Code shows it), with a token estimate.
    const thinkId = msgStart();
    this.#line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
    });
    this.#line({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 120,
    });
    this.#line({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    });
    void thinkId;
    await text("I'll read the notes first.");
    if (!live()) return;
    await tool(
      "Read",
      { file_path: `${DEMO_CWD}/notes.md` },
      () =>
        Promise.resolve({
          text: "1\thello from a file\n2\tsecond line\n3\t",
          detail: { type: "text", file: { numLines: 3 } },
        }),
    );
    if (!live()) return;
    await tool(
      "Grep",
      { pattern: "hello", path: DEMO_CWD },
      () => Promise.resolve({ text: "notes.md" }),
    );
    if (!live()) return;
    if (prompt.includes("plan")) {
      // Looks only: no edit, nothing to ask.
      await text("The greeting is on the first line of notes.md.");
      return end(false, "The greeting is on the first line.", 64);
    }
    const editInput = {
      file_path: `${DEMO_CWD}/notes.md`,
      old_string: "hello from a file",
      new_string: "goodbye from a file",
    };
    let allowed = false;
    await tool("Edit", editInput, async () => {
      const decision = await this.#hooks!.approve({
        toolName: "Edit",
        input: editInput,
        toolUseId: `toolu_demo_${this.#msg}`,
      });
      allowed = decision !== "deny";
      return allowed
        ? {
          text: `The file ${DEMO_CWD}/notes.md has been updated successfully.`,
          detail: {
            structuredPatch: [{
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              lines: [
                "-hello from a file",
                "+goodbye from a file",
                " second line",
              ],
            }],
          },
        }
        : {
          text: "The user denied this tool call in Qutty.",
          isError: true,
        };
    });
    if (!live()) return;
    await tool(
      "Bash",
      { command: "git diff --stat", description: "Show the change" },
      () =>
        Promise.resolve({
          text: allowed
            ? " notes.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)"
            : "",
          detail: {
            stdout: allowed
              ? " notes.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)"
              : "",
            stderr: "",
            interrupted: false,
          },
        }),
    );
    if (!live()) return;
    await text(allowed ? ANSWER : "You denied the edit, so nothing changed.");
    end(false, allowed ? ANSWER : "Nothing changed.", allowed ? 214 : 12);
  }

  // deno-lint-ignore require-await
  async interrupt(): Promise<void> {
    if (!this.#running) return;
    this.#running = 0;
    this.#line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    });
    this.#line({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 0,
      total_cost_usd: this.#cost,
      usage: { output_tokens: 0 },
    });
  }

  stop(): void {
    this.#running = 0;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#sink = undefined;
  }
}
