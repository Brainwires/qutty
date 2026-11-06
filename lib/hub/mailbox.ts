/**
 * Per-recipient mailboxes, modelled on Claude Code's SendMessage: a message queues for its
 * recipient and is handed over at the recipient's next opportunity — a hook puts it into the
 * agent's context (`delivered`), or the agent pulls it with `read_messages` / `wait_for_message`
 * (`read`). Each message is handed over once. A short history is kept per mailbox.
 *
 * @module
 */

import type { HubMessage, MessageState } from "./protocol.ts";

/** How many messages a mailbox keeps (handed-over ones are dropped first). */
const MAILBOX_LIMIT = 200;
/** The longest a `wait_for_message` may wait. */
export const MAX_WAIT_MS = 10 * 60_000;

type Waiter = () => void;

/** Every recipient's mailbox. */
export class Mailboxes {
  #boxes = new Map<string, HubMessage[]>();
  #waiters = new Map<string, Set<Waiter>>();
  #next = 0;
  #onChange: (owner: string) => void;

  /** @param onChange Called with the recipient whenever a mailbox's unread count may change. */
  constructor(onChange: (owner: string) => void = () => {}) {
    this.#onChange = onChange;
  }

  /** Queue a message for `msg.to`; returns it with its id, time and state set. */
  post(msg: Omit<HubMessage, "id" | "at" | "state">): HubMessage {
    const full: HubMessage = {
      ...msg,
      id: `msg-${++this.#next}`,
      at: Date.now(),
      state: "queued",
    };
    const box = this.#box(msg.to);
    box.push(full);
    while (box.length > MAILBOX_LIMIT) {
      const i = box.findIndex((m) => m.state !== "queued");
      box.splice(i < 0 ? 0 : i, 1);
    }
    this.#onChange(msg.to);
    for (const w of [...(this.#waiters.get(msg.to) ?? [])]) w();
    return full;
  }

  /** The messages `owner` has not been handed yet, oldest first. */
  pending(owner: string): HubMessage[] {
    return (this.#boxes.get(owner) ?? []).filter((m) => m.state === "queued");
  }

  /** How many messages wait for `owner`. */
  unread(owner: string): number {
    return this.pending(owner).length;
  }

  /** Hand `owner` its pending messages, marking them `state` (`delivered` or `read`). */
  take(owner: string, state: Exclude<MessageState, "queued">): HubMessage[] {
    const out = this.pending(owner);
    for (const m of out) m.state = state;
    if (out.length > 0) this.#onChange(owner);
    return out.map((m) => ({ ...m }));
  }

  /** The last `limit` messages of `owner`'s mailbox, any state. */
  history(owner: string, limit = 50): HubMessage[] {
    return (this.#boxes.get(owner) ?? []).slice(-limit).map((m) => ({ ...m }));
  }

  /**
   * Wait until `owner` has a pending message (or `timeoutMs` passes, or `signal` aborts), then
   * take them as `read`. Resolves `[]` on timeout or abort.
   */
  async waitFor(
    owner: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HubMessage[]> {
    if (this.unread(owner) === 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        let set = this.#waiters.get(owner);
        if (!set) this.#waiters.set(owner, set = new Set());
        const waiters = set;
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(
          done,
          Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS)),
        );
        waiters.add(done);
        signal?.addEventListener("abort", done);
      });
    }
    return signal?.aborted ? [] : this.take(owner, "read");
  }

  /** Forget `owner`'s mailbox (its tile closed); a waiter there resolves empty. */
  drop(owner: string): void {
    this.#boxes.delete(owner);
    const waiters = this.#waiters.get(owner);
    this.#waiters.delete(owner);
    for (const w of [...(waiters ?? [])]) w();
  }

  #box(owner: string): HubMessage[] {
    let box = this.#boxes.get(owner);
    if (!box) this.#boxes.set(owner, box = []);
    return box;
  }
}
