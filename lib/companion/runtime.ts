/**
 * The companion runtime: one brain session (lib/companion/brain.ts), fed turns one at a time —
 * what the user types (or, in phase 2b, says) and the messages agents send to `companion` — and
 * its replies streamed to the page as {@linkcode CompanionUpdate}s.
 *
 * - Lazy: the brain starts on first use (a chat line, or a message for the companion) and only
 *   while enabled in Settings.
 * - Re-attach: when the brain exits (crash, logout, killed), the messages it was handed but had
 *   not finished are put back in the companion's mailbox, the turn in flight ends with the reason,
 *   and the next use starts a new session, which gets those messages again.
 * - Voice plugs in here: a transcript is `userSays(text, "voice")`, and spoken answers follow the
 *   `turn` updates (`subscribe`).
 *
 * Pure apart from timers: the hub's mailbox and the brain are injected.
 *
 * @module
 */

import { COMPANION, type HubMessage } from "../hub/protocol.ts";
import { formatMessages } from "../hub/hooks.ts";
import type { BrainAdapter, BrainEvent, BrainState } from "./brain.ts";
import { toolShortName } from "./brain.ts";
import type {
  CompanionStatus,
  CompanionUpdate,
  TurnSource,
} from "./protocol.ts";

/** What the runtime needs of the hub: the companion's mailbox. */
export interface CompanionMailbox {
  unread(owner: string): number;
  take(owner: string, state: "delivered"): HubMessage[];
  requeue(owner: string, ids: readonly string[]): number;
}

/** How the user reached the companion. */
export type UserChannel = "chat" | "voice";

export interface CompanionRuntimeOptions {
  mailbox: CompanionMailbox;
  /** A new brain session (called on each start). */
  createBrain(): BrainAdapter;
  /** The adapter's name for the status. */
  adapter: string;
  emit(update: CompanionUpdate): void;
  enabled?: boolean;
  /** Diagnostics (the brain's non-event output). */
  log?(message: string): void;
  /** How long text updates are coalesced (ms). */
  textThrottleMs?: number;
  /**
   * After the brain failed, how long before a message (not the user) may start it again: a brain
   * that cannot start must not be restarted for every message.
   */
  retryAfterMs?: number;
  now?(): number;
}

/** What a mail turn writes when the user need not hear about it. */
const QUIET = "(quiet)";

interface Turn {
  id: number;
  source: TurnSource;
  text: string;
  /** The companion messages it handles (put back if the brain dies mid-turn). */
  mail: string[];
}

/** The runtime. */
export class CompanionRuntime {
  #opts: CompanionRuntimeOptions;
  #enabled: boolean;
  #adapter: string;
  #brain: BrainAdapter | undefined;
  #state: BrainState = "stopped";
  #detail: string | undefined;
  #inputs: { text: string; turn: number }[] = [];
  #turn: Turn | undefined;
  #nextTurn = 0;
  #failedAt = -Infinity;
  #textTimer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<(update: CompanionUpdate) => void>();

  constructor(opts: CompanionRuntimeOptions) {
    this.#opts = opts;
    this.#enabled = opts.enabled ?? true;
    this.#adapter = opts.adapter;
  }

  status(): CompanionStatus {
    return {
      enabled: this.#enabled,
      state: this.#state,
      ...(this.#detail ? { detail: this.#detail } : {}),
      adapter: this.#adapter,
    };
  }

  /** The adapter's name changed (Settings picked another brain). */
  setAdapter(label: string): void {
    if (label === this.#adapter) return;
    this.#adapter = label;
    this.#emit({ kind: "status", status: this.status() });
  }

  /** Follow every update (besides `emit`): voice output, tests. Returns the unsubscribe. */
  subscribe(listener: (update: CompanionUpdate) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(update: CompanionUpdate): void {
    try {
      this.#opts.emit(update);
    } catch (e) {
      this.#opts.log?.(`emit failed: ${e}`);
    }
    for (const l of [...this.#listeners]) {
      try {
        l(update);
      } catch { /* a listener never breaks the runtime */ }
    }
  }

  #setState(state: BrainState, detail?: string): void {
    if (state === this.#state && detail === this.#detail) return;
    this.#state = state;
    this.#detail = detail;
    this.#emit({ kind: "status", status: this.status() });
  }

  /** Turn the brain on or off (off stops a running session; its messages wait in the mailbox). */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      this.#halt("turned off");
      this.#state = "stopped";
      this.#detail = undefined;
    } else {
      this.#failedAt = -Infinity;
    }
    this.#emit({ kind: "status", status: this.status() });
    if (enabled && this.#opts.mailbox.unread(COMPANION) > 0) this.#ensure();
  }

  /**
   * The user said something (the chat box; a voice transcript in phase 2b). Returns the turn id
   * its reply will carry.
   */
  userSays(text: string, via: UserChannel = "chat"): number {
    const turn = ++this.#nextTurn;
    const body = via === "voice" ? `(The user said, by voice:) ${text}` : text;
    if (!this.#enabled) {
      this.#end(
        { id: turn, source: "user", text: "", mail: [] },
        "I'm switched off. Turn me on in Settings → Companion.",
        true,
      );
      return turn;
    }
    this.#inputs.push({ text: body, turn });
    this.#failedAt = -Infinity; // the user asked: try again even after a failure
    if (this.#ensure()) this.#pump();
    return turn;
  }

  /** A message for the companion was queued: start the brain if needed and hand it over. */
  mailArrived(): void {
    if (!this.#enabled) return;
    const now = this.#opts.now?.() ?? Date.now();
    if (
      !this.#brain && now - this.#failedAt < (this.#opts.retryAfterMs ?? 30_000)
    ) {
      return;
    }
    if (this.#ensure()) this.#pump();
  }

  /** End the session (its settings changed); the next use starts a new one. */
  restart(): void {
    if (!this.#brain) return;
    this.#halt("restarting");
    this.#setState("stopped");
  }

  /** Stop the brain for good (the app quits). */
  stop(): void {
    this.#halt("stopped");
    this.#setState("stopped");
  }

  /** Start the brain unless it runs; whether it is ready for a turn now. */
  #ensure(): boolean {
    if (this.#brain) return this.#state === "ready";
    let brain: BrainAdapter;
    try {
      brain = this.#opts.createBrain();
    } catch (e) {
      this.#failed(`could not start: ${message(e)}`);
      return false;
    }
    this.#brain = brain;
    this.#setState("starting");
    brain.start({
      event: (e) => {
        if (this.#brain === brain) this.#onEvent(e);
      },
      exited: (reason) => {
        if (this.#brain === brain) this.#onExit(reason);
      },
    }).then(
      () => {
        if (this.#brain !== brain) return;
        this.#setState("ready");
        this.#pump();
      },
      (e) => {
        if (this.#brain !== brain) return;
        this.#brain = undefined;
        brain.stop();
        this.#failed(message(e));
      },
    );
    return false;
  }

  /** The brain could not start: the waiting user lines get the reason; messages wait. */
  #failed(reason: string): void {
    this.#failedAt = this.#opts.now?.() ?? Date.now();
    this.#setState("error", reason);
    for (const input of this.#inputs.splice(0)) {
      this.#end(
        { id: input.turn, source: "user", text: "", mail: [] },
        `I couldn't start: ${reason}`,
        true,
      );
    }
  }

  /** Hand the brain its next turn: the user first, then the companion's messages. */
  #pump(): void {
    const brain = this.#brain;
    if (!brain || this.#state !== "ready" || this.#turn) return;
    let turn: Turn;
    let text: string;
    const input = this.#inputs.shift();
    if (input) {
      turn = { id: input.turn, source: "user", text: "", mail: [] };
      text = input.text;
    } else {
      if (this.#opts.mailbox.unread(COMPANION) === 0) return;
      const mail = this.#opts.mailbox.take(COMPANION, "delivered");
      turn = {
        id: ++this.#nextTurn,
        source: "mail",
        text: "",
        mail: mail.map((m) => m.id),
      };
      text = formatMessages(mail);
    }
    this.#turn = turn;
    this.#setState("thinking");
    if (turn.source === "user") this.#emitTurn(turn, false);
    brain.send(text).catch((e) => {
      if (this.#brain === brain) {
        brain.stop();
        this.#onExit(`could not send: ${message(e)}`);
      }
    });
  }

  #onEvent(e: BrainEvent): void {
    const turn = this.#turn;
    switch (e.kind) {
      case "text":
        if (!turn) return;
        turn.text += e.delta;
        if (turn.source === "user") this.#queueText(turn);
        return;
      case "toolUse":
        if (turn) {
          this.#emit({
            kind: "tool",
            turn: turn.id,
            name: toolShortName(e.name),
          });
        }
        return;
      case "turnEnd":
        if (!turn) return;
        this.#turn = undefined;
        this.#end(turn, e.text || turn.text, e.isError);
        this.#setState("ready");
        this.#pump();
        return;
      case "log":
        this.#opts.log?.(e.message);
        return;
      case "ready":
        return;
    }
  }

  /** The brain exited: put its unfinished messages back, end the turn, wait for the next use. */
  #onExit(reason: string): void {
    this.#brain = undefined;
    // First: putting the messages back announces them, and that must not restart it at once.
    this.#failedAt = this.#opts.now?.() ?? Date.now();
    const turn = this.#turn;
    this.#turn = undefined;
    if (turn) {
      this.#opts.mailbox.requeue(COMPANION, turn.mail);
      if (turn.source === "user") {
        this.#end(
          turn,
          `I stopped (${reason}). Ask again and I'll restart.`,
          true,
        );
      }
    }
    this.#setState("error", reason);
    // Typed lines still waiting are the user asking again: start a new session for them.
    if (this.#inputs.length > 0 && this.#enabled) this.#ensure();
  }

  /** Stop the session on purpose (off, quit): nothing is lost, its messages go back. */
  #halt(why: string): void {
    const brain = this.#brain;
    this.#brain = undefined;
    brain?.stop();
    const turn = this.#turn;
    this.#turn = undefined;
    if (turn) {
      this.#opts.mailbox.requeue(COMPANION, turn.mail);
      if (turn.source === "user") this.#end(turn, `(${why})`, true);
    }
    for (const input of this.#inputs.splice(0)) {
      this.#end(
        { id: input.turn, source: "user", text: "", mail: [] },
        `(${why})`,
        true,
      );
    }
  }

  #queueText(turn: Turn): void {
    if (this.#textTimer !== undefined) return;
    this.#textTimer = setTimeout(() => {
      this.#textTimer = undefined;
      if (this.#turn === turn) this.#emitTurn(turn, false);
    }, this.#opts.textThrottleMs ?? 40);
  }

  #emitTurn(turn: Turn, done: boolean, isError = false, quiet = false): void {
    this.#emit({
      kind: "turn",
      turn: turn.id,
      source: turn.source,
      text: turn.text,
      done,
      ...(isError ? { isError } : {}),
      ...(quiet ? { quiet } : {}),
    });
  }

  #end(turn: Turn, text: string, isError: boolean): void {
    clearTimeout(this.#textTimer);
    this.#textTimer = undefined;
    turn.text = text.trim();
    const quiet = turn.source === "mail" && !isError &&
      (turn.text === "" || turn.text.toLowerCase() === QUIET);
    this.#emitTurn(turn, true, isError, quiet);
  }
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
