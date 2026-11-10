// The companion's half of the hub (desktop/hub.ts builds one): its privileged identity, the
// brain runtime, the audit log, `qutty-hook say` messages and the page's answers to the commands
// the companion sends it.
//
// - Identity: a socket of its own whose connections are `{ role: "companion" }` (the only
//   identity allowed the companion-only tools). It sits in a folder with mode 0300 under the
//   per-process socket folder, named with a random token: a tile can still find the folder, but
//   cannot list it. Isolation in Qutty is cooperative (every tile is the same macOS user); this
//   keeps an agent from stumbling onto the companion's socket.
// - Brain: lib/companion/runtime.ts over an adapter (default: desktop/companion-brain.ts, Claude
//   Code with an MCP config pointing at that socket through the `qutty-mcp` shim; or a local
//   Ollama model through `@rullama/inference`, calling the hub's tools in process as the
//   companion: lib/companion/inference-brain.ts; or Anthropic's API with the user's key, the
//   same loop, the key read from the hub's keychain entry for each request).
// - Audit: every companion-only call (and every refused one) appended as a JSON line to
//   `companion-audit.jsonl` in the app-support folder, and shown in Settings.
// - Page round trips: a `say` waiting for its button, and a `control` command (spawn / close /
//   focus) waiting for the page to carry it out.

import { ensureDir, writeFileAtomic } from "./pty.ts";
import { chmodPath, removeDir, unlinkPath } from "./hub-socket.ts";
import {
  anthropicCompanionBrain,
  ClaudeCodeBrain,
  ollamaCompanionBrain,
} from "./companion-brain.ts";
import { ANTHROPIC_MODELS } from "../lib/companion/anthropic-provider.ts";
import {
  type AuditEntry,
  AuditLog,
  parseAuditLines,
} from "../lib/companion/audit.ts";
import {
  type BrainAdapter,
  companionMcpConfig,
} from "../lib/companion/brain.ts";
import { CompanionRuntime } from "../lib/companion/runtime.ts";
import type { CompanionTools } from "../lib/companion/inference-brain.ts";
import type { BrainEngine } from "../lib/companion/settings.ts";
import type {
  CompanionStatus,
  CompanionUpdate,
} from "../lib/companion/protocol.ts";
import {
  type LoopyMessage,
  MAX_TIMEOUT_MS,
  parseSayRequest,
} from "../lib/companion/messages.ts";
import { parseSayArgs } from "../lib/companion/say-args.ts";
import type {
  ControlCommand,
  ControlResult,
  HubCore,
} from "../lib/hub/core.ts";
import type { PrivilegedCall } from "../lib/hub/protocol.ts";

const encoder = new TextEncoder();

/** The audit file's name in the app-support folder. */
export const AUDIT_FILE = "companion-audit.jsonl";
/** Past this size the audit file is moved to `companion-audit.1.jsonl` and a new one begun. */
const AUDIT_ROTATE_BYTES = 1 << 20;
/** How long the page has to carry out a control command. */
const CONTROL_TIMEOUT_MS = 10_000;
/** How long a waited-for `say` past its own timeout is held. */
const SAY_SLACK_MS = 2_000;

/** What the companion sends the page. */
export type CompanionEmit = (
  event: "companion" | "say" | "control",
  data: unknown,
) => void;

/** Pending answers by id, each with a timeout. */
class Replies<T> {
  #open = new Map<string, (value: T) => void>();

  wait(id: string, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, fallback), ms);
      this.#open.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  /** Answer `id`; false when nobody waits for it (any more). */
  settle(id: string, value: T): boolean {
    const done = this.#open.get(id);
    if (!done) return false;
    this.#open.delete(id);
    done(value);
    return true;
  }

  /** Answer every waiter with `value` (shutdown). */
  settleAll(value: T): void {
    for (const id of [...this.#open.keys()]) this.settle(id, value);
  }
}

/** A random hex token. */
function token(bytes = 16): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The companion socket's folder under the per-process socket folder. */
export function companionSocketDir(socketDir: string): string {
  return `${socketDir}/companion`;
}

/** Remove the companion folder (its mode 0300 is lifted first so it can be read). */
export async function removeCompanionDir(dir: string): Promise<void> {
  chmodPath(dir, 0o700);
  try {
    for await (const f of Deno.readDir(dir)) unlinkPath(`${dir}/${f.name}`);
  } catch { /* gone */ }
  removeDir(dir);
}

export interface CompanionHostOptions {
  core: HubCore;
  /** The per-process socket folder (the companion's socket and MCP config go there). */
  socketDir: string;
  /** The `qutty-mcp` shim. */
  mcpShim: string;
  /** `~/.qutty`: the brain's working folder is `companion/` in it. */
  quttyDir: string;
  /** Where the audit log is written (none: memory only). */
  appSupportDir?: string;
  emit: CompanionEmit;
  /** Start listening on the companion socket (desktop/hub.ts serves it as the companion). */
  listen(path: string): void;
  /** The hub's tools as the companion, for an in-process brain (Ollama, the API key brain). */
  tools?: () => CompanionTools;
  /** The API key brain's Anthropic key (the hub's keychain entry; `null`: none saved). */
  anthropicKey?: () => Promise<string | null>;
  /** Another brain (tests). Default: Claude Code, or Ollama when Settings picks it. */
  createBrain?: (cfg: BrainConfig) => BrainAdapter;
}

/** What a new brain session is made from. */
export interface BrainConfig {
  mcpConfig: string;
  model?: string;
  engine?: BrainEngine;
}

/** The label Settings shows for a brain choice. */
function adapterLabel(engine: BrainEngine, model: string | undefined): string {
  if (engine === "ollama") return `Ollama (${model ?? "no model"})`;
  if (engine === "anthropic") {
    const id = ANTHROPIC_MODELS[(model ?? "") as keyof typeof ANTHROPIC_MODELS];
    return `Anthropic API (${id ?? ANTHROPIC_MODELS[""]})`;
  }
  return "Claude Code";
}

/** The companion's runtime, identity, audit log and page round trips. */
export class CompanionHost {
  readonly runtime: CompanionRuntime;
  readonly audit: AuditLog;
  readonly socket: string;
  readonly mcpConfig: string;
  #opts: CompanionHostOptions;
  #emit: CompanionEmit;
  #says = new Replies<string | null>();
  #controls = new Replies<ControlResult>();
  #nextControl = 0;
  #model: string | undefined;
  #engine: BrainEngine = "claude";

  constructor(opts: CompanionHostOptions) {
    this.#opts = opts;
    this.#emit = opts.emit;
    const dir = companionSocketDir(opts.socketDir);
    this.socket = `${dir}/${token()}.sock`;
    this.mcpConfig = `${opts.socketDir}/companion-mcp.json`;
    this.audit = new AuditLog(
      opts.appSupportDir
        ? (line) => appendAudit(`${opts.appSupportDir}/${AUDIT_FILE}`, line)
        : undefined,
      (entry) => this.#send({ kind: "activity", entry }),
    );
    const createBrain = opts.createBrain ??
      ((cfg) => {
        if (cfg.engine === "ollama") {
          if (!opts.tools) throw new Error("the hub's tools are not available");
          if (!cfg.model) {
            throw new Error("no Ollama model is chosen (Settings → Companion)");
          }
          return ollamaCompanionBrain(cfg.model, opts.tools());
        }
        if (cfg.engine === "anthropic") {
          if (!opts.tools) throw new Error("the hub's tools are not available");
          const key = opts.anthropicKey;
          if (!key) throw new Error("the OS keychain is not available");
          return anthropicCompanionBrain(cfg.model ?? "", key, opts.tools());
        }
        return new ClaudeCodeBrain({
          mcpConfig: cfg.mcpConfig,
          cwd: `${opts.quttyDir}/companion`,
          ...(cfg.model ? { model: cfg.model } : {}),
          ...(opts.appSupportDir ? { appSupportDir: opts.appSupportDir } : {}),
        });
      });
    this.runtime = new CompanionRuntime({
      mailbox: opts.core.mailboxes,
      adapter: "Claude Code",
      enabled: false, // until the page sends its settings
      createBrain: () =>
        createBrain({
          mcpConfig: this.mcpConfig,
          engine: this.#engine,
          ...(this.#model ? { model: this.#model } : {}),
        }),
      emit: (update) => this.#send(update),
      log: (line) => console.error(`companion: ${line}`),
    });
  }

  setEmit(emit: CompanionEmit): void {
    this.#emit = emit;
  }

  #send(update: CompanionUpdate): void {
    this.#emit("companion", { ...update, at: Date.now() });
  }

  /** Bind the socket, write the MCP config and read the audit file's tail. */
  async start(): Promise<void> {
    const dir = companionSocketDir(this.#opts.socketDir);
    ensureDir(dir, 0o700);
    chmodPath(dir, 0o700);
    this.#opts.listen(this.socket);
    chmodPath(dir, 0o300); // traversable, not listable
    writeFileAtomic(
      this.mcpConfig,
      encoder.encode(companionMcpConfig(this.#opts.mcpShim, this.socket)),
      0o600,
    );
    ensureDir(this.#opts.quttyDir, 0o755);
    ensureDir(`${this.#opts.quttyDir}/companion`, 0o700);
    if (this.#opts.appSupportDir) {
      const text = await Deno.readTextFile(
        `${this.#opts.appSupportDir}/${AUDIT_FILE}`,
      ).catch(() => "");
      this.audit.seed(parseAuditLines(text));
    }
  }

  /** Stop the brain, answer every waiter, remove the socket folder. */
  async stop(): Promise<void> {
    this.runtime.stop();
    this.#says.settleAll(null);
    this.#controls.settleAll({ ok: false, error: "Qutty is quitting" });
    unlinkPath(this.mcpConfig);
    await removeCompanionDir(companionSocketDir(this.#opts.socketDir));
  }

  /** A companion-only call (or a refused attempt), from the MCP handler. */
  record(call: PrivilegedCall): void {
    this.audit.record(call);
  }

  status(): { status: CompanionStatus; activity: AuditEntry[] } {
    return { status: this.runtime.status(), activity: this.audit.recent() };
  }

  /**
   * The page's settings: whether the brain may run, which one, and its model ("" = the
   * engine's default).
   */
  configure(
    enabled: boolean,
    model: string,
    engine: BrainEngine = "claude",
  ): CompanionStatus {
    const next = model || undefined;
    if (next !== this.#model || engine !== this.#engine) {
      this.#model = next;
      this.#engine = engine;
      this.runtime.setAdapter(adapterLabel(engine, next));
      this.runtime.restart();
    }
    this.runtime.setEnabled(enabled);
    return this.runtime.status();
  }

  // --- `qutty-hook say` ------------------------------------------------------------------------

  /**
   * A `say` line from a tile's `qutty-hook say …`: show it in Loopy's bubble; with `--wait`,
   * resolve with the button pressed (`null`: closed or timed out). Throws a usage or validation
   * error the shim prints.
   */
  async say(
    args: readonly string[],
    fromName: string,
  ): Promise<{ id: string; action?: string | null }> {
    const { message, wait } = parseSayRequest(parseSayArgs(args));
    const shown: LoopyMessage = { ...message, from: fromName };
    const answer = wait
      ? this.#says.wait(
        message.id,
        (message.timeoutMs || MAX_TIMEOUT_MS) + SAY_SLACK_MS,
        null,
      )
      : undefined;
    this.#emit("say", { message: shown, wait, at: Date.now() });
    if (!answer) return { id: message.id };
    return { id: message.id, action: await answer };
  }

  /** The page's answer to a waited-for `say`. */
  sayDone(id: string, action: string | null): boolean {
    return this.#says.settle(id, action);
  }

  // --- control commands --------------------------------------------------------------------------

  /** Send a command to the page and wait for its answer ({@linkcode HubEnv.control}). */
  control(command: ControlCommand): Promise<ControlResult> {
    const requestId = `ctl-${++this.#nextControl}`;
    const answer = this.#controls.wait(requestId, CONTROL_TIMEOUT_MS, {
      ok: false,
      error: "the window did not answer (is it open?)",
    });
    this.#emit("control", { requestId, command, at: Date.now() });
    return answer;
  }

  /** The page carried out (or failed) control command `requestId`. */
  controlDone(requestId: string, result: ControlResult): boolean {
    return this.#controls.settle(requestId, result);
  }
}

/**
 * Append `line` to the audit file: read it, add the line, write it back atomically (the app has
 * no `--allow-write`, and libc's variadic `open` cannot be called safely through FFI on arm64, so
 * there is no O_APPEND here). Past {@linkcode AUDIT_ROTATE_BYTES} the file moves to `.1`.
 */
export async function appendAudit(path: string, line: string): Promise<void> {
  let text = await Deno.readTextFile(path).catch(() => "");
  if (text.length > AUDIT_ROTATE_BYTES) {
    writeFileAtomic(
      path.replace(/\.jsonl$/, ".1.jsonl"),
      encoder.encode(text),
      0o600,
    );
    text = "";
  }
  if (text && !text.endsWith("\n")) text += "\n";
  writeFileAtomic(path, encoder.encode(text + line), 0o600);
}
