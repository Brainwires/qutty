/**
 * The agent tiles' sessions, one per tile, between the page and the adapters: each session has an
 * id (`agent-3`, its hub tile id too), an adapter started on its first message, a transcript kept
 * here as well as in the page (a page that comes back attaches to it; `read_screen` reads it), a
 * queue of the messages typed while a turn runs, and its permission questions.
 *
 * Everything the page sees is an {@linkcode AgentUpdate}: an event (numbered per session, so a
 * page that attaches mid-stream drops what its snapshot already has) or a whole snapshot (a new
 * session, a rename). The hub side (`AgentHubSide`) makes each session a hub tile: its socket and
 * name, and its status (busy while a turn runs, waiting on a question or an error, idle after).
 *
 * The desktop app runs it in the hub extension with the Claude Code adapter (desktop/hub.ts); the
 * demo backend runs it in the page with the scripted adapter (lib/agent/demo.ts).
 *
 * Pure (no Deno APIs): the adapters and the hub come in through {@linkcode AgentSessionsDeps}.
 *
 * @module
 */

import {
  type AgentAdapter,
  type AgentEvent,
  type AgentMessage,
  type AgentSessionSpec,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  sanitizeMessage,
} from "./adapter.ts";
import { PermissionBroker } from "./permissions.ts";
import {
  emptyTranscript,
  reduceTranscript,
  type Row,
  type Transcript,
  transcriptText,
  withNotice,
} from "./transcript.ts";
import type { TileStatus } from "../hub/protocol.ts";

/** What the page asks for when it opens (or reopens) an agent tile. */
export interface AgentStartRequest {
  cwd: string;
  model?: string;
  /** Resume this Claude Code session. */
  resumeId?: string;
  permissionMode?: PermissionMode;
  /** A preset's system prompt, added to the harness's own. */
  systemPrompt?: string;
  /** A preset's tools allowed without asking. */
  allowedTools?: string[];
  /** The tile's name (the hub name), when it had one. */
  name?: string;
  /** The session this tile had: attach to it when it still runs. */
  attach?: string;
  /** The tile's saved transcript, shown above a resumed session. */
  rows?: Row[];
  /** Who owns it (the workspace): `stopOwnedBy` ends its sessions. */
  owner?: string;
}

/** A session as the page draws it. */
export interface AgentSnapshot {
  id: string;
  /** The number of the last event in it. */
  seq: number;
  /** Its hub name. */
  name: string;
  /** What it was started with (the model and mode the header shows). */
  spec: AgentSessionSpec;
  transcript: Transcript;
}

/** What goes to the page. */
export type AgentUpdate =
  | { id: string; seq: number; event: AgentEvent }
  | { id: string; seq: number; snapshot: AgentSnapshot }
  /** The session ended for good (its tile closed). */
  | { id: string; seq: number; closed: true };

/** The hub's side of an agent tile. */
export interface AgentHubSide {
  /** Make `id` a hub tile; its environment (the socket) and its name. */
  open(id: string, info: { cwd: string; name?: string }): {
    env: Record<string, string>;
    name: string;
  };
  close(id: string): void;
  setStatus(id: string, status: TileStatus, note?: string): void;
  /** Rename the tile (throws with the reason when the name is unusable); the name. */
  rename(id: string, name: string): string;
}

export interface AgentSessionsDeps {
  /** A new adapter for a session (its tile id and hub environment). */
  createAdapter(
    spec: AgentSessionSpec,
    tile: { id: string; env: Record<string, string> },
  ): AgentAdapter;
  emit(update: AgentUpdate): void;
  hub?: AgentHubSide;
  now?(): number;
}

interface Session {
  id: string;
  name: string;
  owner?: string;
  spec: AgentSessionSpec;
  env: Record<string, string>;
  transcript: Transcript;
  seq: number;
  adapter?: AgentAdapter;
  starting?: Promise<boolean>;
  broker: PermissionBroker;
  queue: AgentMessage[];
  stopped: boolean;
}

/** The longest name a page may give. */
const MAX_NAME = 40;

/** The agent tiles' sessions. */
export class AgentSessions {
  #deps: AgentSessionsDeps;
  #sessions = new Map<string, Session>();
  #next = 0;

  constructor(deps: AgentSessionsDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /** Open an agent tile's session, or attach to the one it had. */
  start(req: AgentStartRequest): AgentSnapshot {
    const old = req.attach ? this.#sessions.get(req.attach) : undefined;
    if (old && !old.stopped) return this.#snapshot(old);
    const id = `agent-${++this.#next}`;
    const spec: AgentSessionSpec = {
      cwd: req.cwd,
      ...(req.model ? { model: req.model } : {}),
      ...(req.resumeId ? { resumeId: req.resumeId } : {}),
      ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
      ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.allowedTools?.length ? { allowedTools: req.allowedTools } : {}),
    };
    const hub = this.#deps.hub?.open(id, {
      cwd: req.cwd,
      ...(req.name ? { name: req.name } : {}),
    });
    let transcript = emptyTranscript(req.rows ?? []);
    transcript = {
      ...transcript,
      cwd: req.cwd,
      ...(req.resumeId ? { sessionId: req.resumeId } : {}),
      ...(req.model ? { model: req.model } : {}),
    };
    if (req.resumeId) {
      transcript = withNotice(
        transcript,
        `Resumed session ${req.resumeId.slice(0, 8)}`,
        this.#now(),
      );
    }
    const s: Session = {
      id,
      name: hub?.name ?? req.name ?? "claude",
      ...(req.owner ? { owner: req.owner } : {}),
      spec,
      env: hub?.env ?? {},
      transcript,
      seq: 0,
      broker: new PermissionBroker(id),
      queue: [],
      stopped: false,
    };
    this.#sessions.set(id, s);
    return this.#snapshot(s);
  }

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  /** Session `id` as the page draws it. */
  snapshot(id: string): AgentSnapshot | undefined {
    const s = this.#sessions.get(id);
    return s ? this.#snapshot(s) : undefined;
  }

  #snapshot(s: Session): AgentSnapshot {
    return {
      id: s.id,
      seq: s.seq,
      name: s.name,
      spec: { ...s.spec },
      transcript: s.transcript,
    };
  }

  /** The transcript as text (the hub's `read_screen`). */
  screen(id: string, lines = 200): string[] | undefined {
    const s = this.#sessions.get(id);
    return s ? transcriptText(s.transcript, lines) : undefined;
  }

  /** A message from the page (queued while a turn runs). False: no such session or no message. */
  send(id: string, raw: unknown): boolean {
    const s = this.#sessions.get(id);
    const message = sanitizeMessage(raw);
    if (!s || s.stopped || !message) return false;
    if (s.transcript.running || s.queue.length > 0) {
      s.queue.push(message);
      this.#queueChanged(s);
      return true;
    }
    void this.#dispatch(s, message);
    return true;
  }

  /**
   * Text typed into the tile from outside (the companion's `write_tile`): a prompt once it ends
   * with Enter. Throws when it does not.
   */
  typed(id: string, text: string): void {
    const m = /^([\s\S]*?)\r\n?$|^([\s\S]*?)\n$/.exec(text);
    const prompt = m ? (m[1] ?? m[2] ?? "").trim() : "";
    if (!m) {
      throw new Error(
        "an agent tile takes whole prompts: write the text with enter: true",
      );
    }
    if (!prompt) return;
    this.send(id, { text: prompt });
  }

  #queueChanged(s: Session): void {
    this.#emit(s, {
      kind: "queue",
      items: s.queue.map((m) => m.text),
      at: this.#now(),
    });
  }

  async #dispatch(s: Session, message: AgentMessage): Promise<void> {
    this.#emit(s, {
      kind: "user",
      text: message.text,
      ...(message.attachments?.length
        ? {
          attachments: message.attachments.map((a) => ({
            name: a.name,
            kind: a.kind,
          })),
        }
        : {}),
      at: this.#now(),
    });
    this.#deps.hub?.setStatus(s.id, "busy");
    if (!await this.#ensure(s)) return;
    try {
      await s.adapter!.send(message);
    } catch (e) {
      this.#fail(s, e);
    }
  }

  /** Start the adapter if it is not running; false when it could not start. */
  #ensure(s: Session): Promise<boolean> {
    if (s.adapter) return Promise.resolve(true);
    if (s.starting) return s.starting;
    const spec: AgentSessionSpec = {
      ...s.spec,
      // A session that ran before (this process crashed, the model changed) goes on from there.
      ...(s.transcript.sessionId ? { resumeId: s.transcript.sessionId } : {}),
    };
    const adapter = this.#deps.createAdapter(spec, { id: s.id, env: s.env });
    s.adapter = adapter;
    s.starting = adapter.start(spec, {
      event: (e) => {
        if (s.adapter === adapter && !s.stopped) this.#adapterEvent(s, e);
      },
    }, {
      approve: (req) => this.#ask(s, req),
    }).then(
      () => true,
      (e) => {
        if (s.adapter === adapter) s.adapter = undefined;
        this.#fail(s, e);
        return false;
      },
    ).finally(() => {
      s.starting = undefined;
    });
    return s.starting;
  }

  #fail(s: Session, e: unknown): void {
    if (s.stopped) return;
    const message = e instanceof Error ? e.message : String(e);
    this.#emit(s, { kind: "error", message, at: this.#now() });
    this.#deps.hub?.setStatus(s.id, "waiting", "error");
    // A message that could not go out takes the queue with it.
    if (s.queue.length > 0) {
      s.queue = [];
      this.#queueChanged(s);
    }
  }

  #adapterEvent(s: Session, e: AgentEvent): void {
    this.#emit(s, e);
    switch (e.kind) {
      case "turnEnd": {
        // A question left open by the turn can no longer be answered.
        s.broker.withdrawAll();
        const last = s.transcript.rows.at(-1);
        const failed = last?.type === "footer" && last.outcome === "failed";
        this.#deps.hub?.setStatus(
          s.id,
          failed ? "waiting" : "idle",
          failed ? "error" : undefined,
        );
        const next = s.queue.shift();
        if (next) {
          this.#queueChanged(s);
          void this.#dispatch(s, next);
        }
        return;
      }
      case "exit":
        s.adapter = undefined;
        s.broker.withdrawAll();
        if (s.queue.length > 0) {
          s.queue = [];
          this.#queueChanged(s);
        }
        this.#deps.hub?.setStatus(s.id, "idle", "exited");
        return;
    }
  }

  /** A permission question from the agent (the hub's `approve_tool`, or an adapter). */
  approve(id: string, req: PermissionRequest): Promise<PermissionDecision> {
    const s = this.#sessions.get(id);
    if (!s || s.stopped) return Promise.resolve("deny");
    return this.#ask(s, req);
  }

  async #ask(s: Session, req: PermissionRequest): Promise<PermissionDecision> {
    const { requestId, answer } = s.broker.ask(req);
    if (!requestId) return answer;
    this.#emit(s, {
      kind: "permission",
      requestId,
      toolName: req.toolName,
      input: req.input,
      ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
      at: this.#now(),
    });
    this.#deps.hub?.setStatus(s.id, "waiting", "permission");
    const decision = await answer;
    if (!s.stopped) {
      this.#emit(s, {
        kind: "permissionDone",
        requestId,
        decision,
        at: this.#now(),
      });
      if (s.transcript.running && s.transcript.asking.length === 0) {
        this.#deps.hub?.setStatus(s.id, "busy");
      }
    }
    return decision;
  }

  /** The user answered question `requestId`. */
  answer(id: string, requestId: string, decision: PermissionDecision): boolean {
    return this.#sessions.get(id)?.broker.answer(requestId, decision) ?? false;
  }

  /** Stop the turn under way (Escape, Stop): its questions are denied, the queue dropped. */
  async interrupt(id: string): Promise<boolean> {
    const s = this.#sessions.get(id);
    if (!s || s.stopped) return false;
    if (s.queue.length > 0) {
      s.queue = [];
      this.#queueChanged(s);
    }
    s.broker.withdrawAll();
    if (!s.transcript.running || !s.adapter) return false;
    this.#emit(s, { kind: "interrupted", at: this.#now() });
    try {
      await s.adapter.interrupt();
    } catch (e) {
      this.#fail(s, e);
    }
    return true;
  }

  /**
   * Start over with another model or mode (the session goes on, resumed), or as a new session
   * (`fresh`: an empty transcript).
   */
  restart(
    id: string,
    patch: { model?: string; permissionMode?: PermissionMode; fresh?: boolean },
  ): AgentSnapshot | undefined {
    const s = this.#sessions.get(id);
    if (!s || s.stopped) return undefined;
    this.#stopAdapter(s);
    s.queue = [];
    const spec = { ...s.spec };
    if (patch.fresh) delete spec.resumeId;
    if (patch.model !== undefined) {
      if (patch.model) spec.model = patch.model;
      else delete spec.model;
    }
    if (patch.permissionMode) spec.permissionMode = patch.permissionMode;
    s.spec = spec;
    const now = this.#now();
    if (patch.fresh) {
      s.transcript = withNotice(
        { ...emptyTranscript(), cwd: s.spec.cwd },
        "New session",
        now,
      );
    } else {
      const { running: _x, ...t } = s.transcript;
      s.transcript = withNotice(
        {
          ...t,
          running: false,
          asking: [],
          queue: [],
          ...(s.spec.model ? { model: s.spec.model } : {}),
        },
        patch.model !== undefined
          ? `Model: ${patch.model || "default"}`
          : `Mode: ${s.spec.permissionMode ?? "default"}`,
        now,
      );
    }
    this.#deps.hub?.setStatus(s.id, "idle");
    this.#emitSnapshot(s);
    return this.#snapshot(s);
  }

  /** A line of the session layer's own in the transcript ("Reverted notes.md"). */
  notice(id: string, text: string): boolean {
    const s = this.#sessions.get(id);
    if (!s || s.stopped) return false;
    s.transcript = withNotice(s.transcript, text, this.#now());
    this.#emitSnapshot(s);
    return true;
  }

  /** Rename the session's tile (its hub name); the name it got. Throws with the reason. */
  rename(id: string, name: string): string {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`no such agent: ${id}`);
    const clean = name.trim().slice(0, MAX_NAME);
    s.name = this.#deps.hub ? this.#deps.hub.rename(id, clean) : clean;
    this.#emitSnapshot(s);
    return s.name;
  }

  /** End session `id` (its tile closed). */
  stop(id: string): void {
    const s = this.#sessions.get(id);
    if (!s) return;
    s.stopped = true;
    this.#stopAdapter(s);
    this.#sessions.delete(id);
    this.#deps.hub?.close(id);
    this.#deps.emit({ id, seq: s.seq + 1, closed: true });
  }

  /** End the sessions `owner` opened (its workspace ended). */
  stopOwnedBy(owner: string): void {
    for (const s of [...this.#sessions.values()]) {
      if (s.owner === owner) this.stop(s.id);
    }
  }

  stopAll(): void {
    for (const id of [...this.#sessions.keys()]) this.stop(id);
  }

  /** The ids of the sessions running now. */
  ids(): string[] {
    return [...this.#sessions.keys()];
  }

  #stopAdapter(s: Session): void {
    s.broker.withdrawAll();
    const adapter = s.adapter;
    s.adapter = undefined;
    s.starting = undefined;
    adapter?.stop();
  }

  #emit(s: Session, event: AgentEvent): void {
    s.transcript = reduceTranscript(s.transcript, event);
    s.seq++;
    if (event.kind === "log") return;
    this.#deps.emit({ id: s.id, seq: s.seq, event });
  }

  #emitSnapshot(s: Session): void {
    s.seq++;
    this.#deps.emit({ id: s.id, seq: s.seq, snapshot: this.#snapshot(s) });
  }
}
