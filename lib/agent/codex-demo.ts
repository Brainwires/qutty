/**
 * The demo backend's Codex (plain-browser development and the e2e suite): the real client
 * (lib/agent/codex-app-server.ts) talking to a scripted `codex app-server` in the page, so the
 * demo drives the tile exactly as a real Codex session's JSON-RPC would:
 *
 * - any prompt: reasoning, a line of text, `cat notes.md` (a read: a `Read` row), a file change
 *   to `notes.md` that asks for approval (Allow applies it, Deny declines it), `git diff --stat`,
 *   and a markdown answer, then the turn's end;
 * - a prompt with `slow`: the same, a step every 400 ms (time to interrupt it);
 * - a prompt with `fail`: the turn fails (`turn.status: failed`);
 * - a prompt with `hello`: a one-line answer, no tools.
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
import { CodexAppServer } from "./codex-app-server.ts";

/** The demo's folder for paths. */
const DEMO_CWD = "/Users/demo/project";

const DIFF = [
  "@@ -1,2 +1,2 @@",
  "-hello from a file",
  "+goodbye from a file",
  " second line",
].join("\n");

type Json = Record<string, unknown>;

/**
 * A scripted `codex app-server`: give it the client's lines (`receive`), it answers through
 * `out` (each line as the server would print it). Also the unit tests' fake server.
 */
export class FakeCodexServer {
  #out: (line: string) => void;
  #thread = "019a0000-0000-7000-8000-00000000c0de";
  #turn = 0;
  /** The turn under way (its id; a new turn or an interrupt changes it). */
  #running: string | undefined;
  #next = 1000;
  #waiting = new Map<number, (result: Json) => void>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #tokens = 0;
  /** Every request the client made, in order (tests read it). */
  readonly requests: { method: string; params: Json }[] = [];
  /** Answer `thread/resume` with this error (tests). */
  resumeError: string | undefined;

  constructor(out: (line: string) => void) {
    this.#out = out;
  }

  #send(v: unknown): void {
    this.#out(JSON.stringify(v));
  }

  #notify(method: string, params: Json): void {
    this.#send({ method, params, emittedAtMs: Date.now() });
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

  /** Ask the client (an approval); its answer. */
  #ask(method: string, params: Json): Promise<Json> {
    const id = ++this.#next;
    const answer = new Promise<Json>((r) => this.#waiting.set(id, r));
    this.#send({ id, method, params });
    return answer;
  }

  /** One line from the client. */
  receive(line: string): void {
    const msg = JSON.parse(line) as Json;
    const id = msg.id as number | undefined;
    const method = msg.method as string | undefined;
    if (!method) {
      // The answer to one of our requests.
      const r = id !== undefined ? this.#waiting.get(id) : undefined;
      if (r && id !== undefined) {
        this.#waiting.delete(id);
        r((msg.result ?? {}) as Json);
      }
      return;
    }
    const params = (msg.params ?? {}) as Json;
    this.requests.push({ method, params });
    if (id === undefined) return; // `initialized`
    const ok = (result: unknown) => this.#send({ id, result });
    switch (method) {
      case "initialize":
        return ok({
          userAgent: "qutty/0.0.0-demo",
          codexHome: "/Users/demo/.codex",
          platformFamily: "unix",
          platformOs: "macos",
        });
      case "model/list":
        return ok({
          data: [
            { id: "gpt-demo", displayName: "GPT Demo", hidden: false },
            {
              id: "gpt-demo-mini",
              displayName: "GPT Demo Mini",
              hidden: false,
            },
            { id: "internal", displayName: "Internal", hidden: true },
          ],
          nextCursor: null,
        });
      case "thread/start":
      case "thread/resume": {
        if (method === "thread/resume") {
          if (this.resumeError) {
            return this.#send({
              id,
              error: { code: -32600, message: this.resumeError },
            });
          }
          this.#thread = String(params.threadId);
        }
        return ok({
          thread: { id: this.#thread },
          model: (params.model as string | undefined) ?? "gpt-demo",
          cwd: (params.cwd as string | undefined) ?? DEMO_CWD,
        });
      }
      case "turn/start": {
        const turnId = `turn-${++this.#turn}`;
        this.#running = turnId;
        ok({ turn: { id: turnId, status: "inProgress", items: [] } });
        const input = Array.isArray(params.input) ? params.input : [];
        const text = input.map((i) => (i as Json).text ?? "").join(" ");
        void this.#script(turnId, String(text));
        return;
      }
      case "turn/interrupt": {
        ok({});
        const turnId = String(params.turnId);
        if (this.#running !== turnId) return;
        this.#running = undefined;
        for (const r of this.#waiting.values()) r({ decision: "cancel" });
        this.#waiting.clear();
        this.#notify("turn/completed", {
          threadId: this.#thread,
          turn: {
            id: turnId,
            status: "interrupted",
            error: null,
            durationMs: 5,
          },
        });
        return;
      }
      default:
        return this.#send({
          id,
          error: { code: -32601, message: `no method ${method}` },
        });
    }
  }

  async #script(turnId: string, prompt: string): Promise<void> {
    const live = () => this.#running === turnId;
    const lower = prompt.toLowerCase();
    const step = lower.includes("slow") ? 400 : 20;
    const threadId = this.#thread;
    const base = { threadId, turnId };
    let item = 0;
    const id = () => `item-${turnId}-${++item}`;
    const message = async (text: string) => {
      const itemId = id();
      this.#notify("item/started", {
        ...base,
        item: { type: "agentMessage", id: itemId, text: "" },
      });
      for (const word of text.split(/(?<=\s)/)) {
        if (!live()) return;
        this.#notify("item/agentMessage/delta", {
          ...base,
          itemId,
          delta: word,
        });
        await this.#sleep(step / 4);
      }
      this.#notify("item/completed", {
        ...base,
        item: { type: "agentMessage", id: itemId, text },
      });
    };
    const command = async (
      command: string,
      output: string,
      actions: Json[] = [],
    ) => {
      const itemId = id();
      const item = {
        type: "commandExecution",
        id: itemId,
        command,
        cwd: DEMO_CWD,
        commandActions: actions,
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
      };
      this.#notify("item/started", { ...base, item });
      await this.#sleep(step);
      if (!live()) return;
      this.#notify("item/commandExecution/outputDelta", {
        ...base,
        itemId,
        delta: output,
      });
      this.#notify("item/completed", {
        ...base,
        item: {
          ...item,
          status: "completed",
          aggregatedOutput: output,
          exitCode: 0,
          durationMs: step,
        },
      });
    };
    const end = (status: "completed" | "failed", error?: string) => {
      if (!live()) return;
      this.#running = undefined;
      this.#tokens += status === "completed" ? 180 : 0;
      this.#notify("thread/tokenUsage/updated", {
        ...base,
        tokenUsage: {
          total: { outputTokens: this.#tokens },
          last: { outputTokens: 180 },
        },
      });
      this.#notify("turn/completed", {
        threadId,
        turn: {
          id: turnId,
          status,
          error: error ? { message: error } : null,
          durationMs: 1200,
        },
      });
    };

    this.#notify("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    await this.#sleep(step);
    if (!live()) return;
    if (lower.includes("fail")) {
      return end("failed", "stream disconnected before completion (demo)");
    }
    if (lower.includes("hello") && !lower.includes("slow")) {
      await message("Hello! I am the demo Codex.");
      return end("completed");
    }
    const reasoning = id();
    this.#notify("item/started", {
      ...base,
      item: { type: "reasoning", id: reasoning, summary: [], content: [] },
    });
    this.#notify("item/reasoning/summaryTextDelta", {
      ...base,
      itemId: reasoning,
      delta: "Looking at notes.md",
      summaryIndex: 0,
    });
    this.#notify("item/completed", {
      ...base,
      item: {
        type: "reasoning",
        id: reasoning,
        summary: ["Looking at notes.md"],
        content: [],
      },
    });
    await message("I'll read the notes first.");
    if (!live()) return;
    await command("cat notes.md", "hello from a file\nsecond line\n", [
      {
        type: "read",
        command: "cat notes.md",
        name: "notes.md",
        path: `${DEMO_CWD}/notes.md`,
      },
    ]);
    if (!live()) return;
    const changeId = id();
    const change = {
      type: "fileChange",
      id: changeId,
      changes: [{
        path: `${DEMO_CWD}/notes.md`,
        kind: { type: "update", move_path: null },
        diff: DIFF,
      }],
      status: "inProgress",
    };
    this.#notify("item/started", { ...base, item: change });
    const answer = await this.#ask("item/fileChange/requestApproval", {
      ...base,
      itemId: changeId,
      startedAtMs: Date.now(),
      reason: null,
    });
    if (!live()) return;
    const accepted = answer.decision === "accept" ||
      answer.decision === "acceptForSession";
    this.#notify("item/completed", {
      ...base,
      item: { ...change, status: accepted ? "completed" : "declined" },
    });
    await this.#sleep(step);
    if (!live()) return;
    await command(
      "git diff --stat",
      accepted ? " notes.md | 2 +-\n 1 file changed\n" : "",
    );
    if (!live()) return;
    await message(
      accepted
        ? "## Done\n\nI changed **notes.md** so the greeting reads *goodbye*."
        : "You declined the change, so nothing changed.",
    );
    end("completed");
  }

  /** Stop every scripted step. */
  stop(): void {
    this.#running = undefined;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }
}

/** A scripted Codex session: the real client over {@linkcode FakeCodexServer}. */
export class DemoCodexAdapter implements AgentAdapter {
  readonly label = "Codex (demo)";
  readonly images = true;
  #client: CodexAppServer | undefined;
  #server: FakeCodexServer | undefined;

  async start(
    spec: AgentSessionSpec,
    sink: AgentSink,
    hooks: AgentHooks,
  ): Promise<void> {
    let client: CodexAppServer | undefined = undefined;
    // The server answers on a later tick, as a process would.
    const server = new FakeCodexServer((line) =>
      queueMicrotask(() => client?.line(line))
    );
    client = new CodexAppServer({
      write: (line) => {
        queueMicrotask(() => server.receive(line));
        return Promise.resolve();
      },
      sink,
      hooks,
    });
    this.#server = server;
    this.#client = client;
    await client.open(spec);
  }

  send(message: AgentMessage): Promise<void> {
    if (!this.#client) {
      return Promise.reject(new Error("the session is not running"));
    }
    return this.#client.send(message);
  }

  interrupt(): Promise<void> {
    return this.#client?.interrupt() ?? Promise.resolve();
  }

  stop(): void {
    this.#server?.stop();
    this.#client?.close("stopped");
    this.#client = undefined;
  }
}
