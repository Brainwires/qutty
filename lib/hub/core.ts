/**
 * The hub's logic, independent of sockets and the desktop runtime: the registry, the mailboxes,
 * message routing, `ask_user`, hook handling and the companion's actions. desktop/hub.ts wires it
 * to the PTYs, the per-tile sockets and the page; the tests drive it directly.
 *
 * @module
 */

import { Mailboxes } from "./mailbox.ts";
import { Registry, type TileSeed } from "./registry.ts";
import {
  type AskRequest,
  BROADCAST,
  COMPANION,
  type HubIdentity,
  type HubMessage,
  type HubSnapshot,
  type TileInfo,
  USER,
} from "./protocol.ts";
import {
  contextOutput,
  formatMessages,
  HOOK_EVENTS,
  type HookEvent,
  type HookOutput,
  notificationStatus,
  sessionIntro,
  stopOutput,
} from "./hooks.ts";
import type { ScrollbackPage } from "./mirror.ts";

/** The longest message text. */
const MAX_TEXT = 32 * 1024;
/** How long a waited-for `ask_user` stays open. */
const ASK_TIMEOUT_MS = 10 * 60_000;

/** What the hub needs from its environment (desktop/hub.ts; fakes in tests). */
export interface HubEnv {
  /** A tile's screen mirror. */
  mirror(tileId: string):
    | {
      screen(): Promise<string[]>;
      scrollback(
        opts: { offset?: number; lines?: number; grep?: string },
      ): Promise<ScrollbackPage>;
    }
    | undefined;
  /** Type into a tile (companion only). */
  write(tileId: string, text: string): Promise<void>;
  /** Show an `ask_user` question on the page. */
  ask(request: AskRequest): void;
  /** The question was answered or withdrawn: take it off the page. */
  askClosed(id: string): void;
  /** A companion command the page carries out (spawn / close / focus a tile). */
  control(command: ControlCommand): void;
  /** The registry changed. */
  changed(snapshot: HubSnapshot): void;
}

/** A companion command for the page. */
export type ControlCommand =
  | { kind: "spawn"; command?: string; profile?: string }
  | { kind: "close"; tileId: string }
  | { kind: "focus"; tileId: string };

/** A user-facing failure (bad target, bad name, …): becomes an `isError` tool result. */
export class HubError extends Error {
  override name = "HubError";
}

interface OpenAsk {
  request: AskRequest;
  /** Who gets the answer as a message when nobody waits for it. */
  replyTo: HubIdentity;
  resolve?: (action: string | null) => void;
}

/** The hub. */
export class HubCore {
  readonly registry: Registry;
  readonly mailboxes: Mailboxes;
  #env: HubEnv;
  #asks = new Map<string, OpenAsk>();
  #nextAsk = 0;

  constructor(env: HubEnv) {
    this.#env = env;
    this.registry = new Registry(() => this.#env.changed(this.snapshot()));
    this.mailboxes = new Mailboxes((owner) => {
      if (owner !== COMPANION) {
        this.registry.setUnread(owner, this.mailboxes.unread(owner));
      }
    });
  }

  snapshot(): HubSnapshot {
    return { running: true, tiles: this.registry.list() };
  }

  addTile(seed: TileSeed): TileInfo {
    return this.registry.add(seed);
  }

  /** A tile closed: forget it, its mailbox and its open questions. */
  removeTile(id: string): void {
    this.registry.remove(id);
    this.mailboxes.drop(id);
    for (const [askId, ask] of this.#asks) {
      if (ask.replyTo.role === "tile" && ask.replyTo.tileId === id) {
        this.answer(askId, null);
      }
    }
  }

  /** The tile behind a tile identity (throws when it is gone). */
  self(identity: HubIdentity): TileInfo {
    if (identity.role !== "tile") {
      throw new HubError("the companion is not a tile");
    }
    const tile = this.registry.get(identity.tileId);
    if (!tile) throw new HubError("this tile is gone");
    return tile;
  }

  /** The mailbox owner and display name of an identity. */
  #who(identity: HubIdentity): { id: string; name: string } {
    if (identity.role === "companion") {
      return { id: COMPANION, name: COMPANION };
    }
    const tile = this.self(identity);
    return { id: tile.id, name: tile.name };
  }

  /** The tile `target` names (id or name), or a {@linkcode HubError}. */
  tile(target: string): TileInfo {
    const tile = this.registry.resolve(target);
    if (!tile) {
      throw new HubError(
        `no tile is called "${target}" (list_peers shows the names)`,
      );
    }
    return tile;
  }

  /** Tile `id`'s screen mirror, or a {@linkcode HubError} when it has none. */
  envMirror(id: string): NonNullable<ReturnType<HubEnv["mirror"]>> {
    const mirror = this.#env.mirror(id);
    if (!mirror) throw new HubError(`${id} has no screen to read`);
    return mirror;
  }

  /**
   * Route a message: to a tile (id or name), to `companion`, or to `all` (every other tile).
   * Returns the queued messages.
   */
  send(
    from: HubIdentity,
    to: string,
    text: string,
    replyTo?: string,
  ): HubMessage[] {
    if (text.length === 0) throw new HubError("the message is empty");
    if (text.length > MAX_TEXT) {
      throw new HubError(`a message has at most ${MAX_TEXT} characters`);
    }
    const sender = this.#who(from);
    const recipients = to.toLowerCase() === BROADCAST
      ? this.registry.list().map((t) => t.id).filter((id) => id !== sender.id)
      : to.toLowerCase() === COMPANION
      ? [COMPANION]
      : [this.tile(to).id];
    if (recipients.length === 0) {
      throw new HubError("there are no other tiles to send to");
    }
    if (recipients.length === 1 && recipients[0] === sender.id) {
      throw new HubError("a tile cannot message itself");
    }
    return recipients.map((r) =>
      this.mailboxes.post({
        from: sender.id,
        fromName: sender.name,
        to: r,
        text,
        ...(replyTo ? { replyTo } : {}),
      })
    );
  }

  /** `read_messages`: the pending messages (marked read), or with `all` the recent history. */
  read(identity: HubIdentity, all = false): HubMessage[] {
    const owner = this.#who(identity).id;
    if (!all) return this.mailboxes.take(owner, "read");
    const history = this.mailboxes.history(owner);
    this.mailboxes.take(owner, "read");
    return history;
  }

  /** `wait_for_message`: block until a message arrives, the timeout passes or the call is cancelled. */
  wait(
    identity: HubIdentity,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<HubMessage[]> {
    return this.mailboxes.waitFor(this.#who(identity).id, timeoutMs, signal);
  }

  /**
   * `ask_user`: show the question on the page. With `wait`, resolve with the button picked
   * (`null`: dismissed, timed out or cancelled); without, return at once and post the answer to
   * the asker's mailbox when it comes.
   */
  ask(
    from: HubIdentity,
    text: string,
    actions: readonly string[],
    opts: { wait: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): { id: string; answer: Promise<string | null> | null } {
    if (text.length === 0) throw new HubError("the question is empty");
    if (text.length > MAX_TEXT) {
      throw new HubError(`a question has at most ${MAX_TEXT} characters`);
    }
    const sender = this.#who(from);
    const request: AskRequest = {
      id: `ask-${++this.#nextAsk}`,
      from: sender.id,
      fromName: sender.name,
      text,
      actions: actions.length > 0 ? [...actions] : ["OK"],
    };
    const open: OpenAsk = { request, replyTo: from };
    this.#asks.set(request.id, open);
    let answer: Promise<string | null> | null = null;
    if (opts.wait) {
      answer = new Promise((resolve) => {
        const timer = setTimeout(
          () => this.answer(request.id, null),
          opts.timeoutMs ?? ASK_TIMEOUT_MS,
        );
        const onAbort = () => this.answer(request.id, null);
        opts.signal?.addEventListener("abort", onAbort);
        open.resolve = (action) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(action);
        };
      });
    }
    this.#env.ask(request);
    return { id: request.id, answer };
  }

  /** The questions on screen (a page that reloads shows them again). */
  openAsks(): AskRequest[] {
    return [...this.#asks.values()].map((a) => ({ ...a.request }));
  }

  /** The user answered (or dismissed: `null`) question `id`. Unknown ids are ignored. */
  answer(id: string, action: string | null): boolean {
    const open = this.#asks.get(id);
    if (!open) return false;
    this.#asks.delete(id);
    this.#env.askClosed(id);
    if (open.resolve) {
      open.resolve(action);
      return true;
    }
    const owner = open.replyTo.role === "companion"
      ? COMPANION
      : open.replyTo.tileId;
    if (owner === COMPANION || this.registry.get(owner)) {
      this.mailboxes.post({
        from: USER,
        fromName: USER,
        to: owner,
        text: action === null
          ? `The user dismissed your question (${id}).`
          : `The user answered your question (${id}): ${action}`,
        replyTo: id,
      });
    }
    return true;
  }

  // --- the companion's actions ---------------------------------------------------------------

  async writeTile(target: string, text: string): Promise<void> {
    if (text.length > MAX_TEXT) {
      throw new HubError(`at most ${MAX_TEXT} characters at a time`);
    }
    await this.#env.write(this.tile(target).id, text);
  }

  /** `deliver`: type a one-line nudge into an idle tile whose agent has no hooks. */
  async deliver(target: string): Promise<number> {
    const tile = this.tile(target);
    const n = this.mailboxes.unread(tile.id);
    if (n === 0) return 0;
    await this.#env.write(
      tile.id,
      `You have ${n} new Qutty message${
        n === 1 ? "" : "s"
      } — call the qutty read_messages tool.`,
    );
    return n;
  }

  control(command: ControlCommand): void {
    if (command.kind !== "spawn") this.tile(command.tileId);
    this.#env.control(command);
  }

  // --- hooks -----------------------------------------------------------------------------------

  /**
   * A hook fired in tile `tileId` (forwarded by `qutty-hook <harness>`): update the tile's state
   * and answer with what the harness should do. Unknown events answer `{}`.
   */
  hook(
    tileId: string,
    event: string,
    input: Record<string, unknown>,
    harness?: string,
  ): HookOutput {
    const tile = this.registry.get(tileId);
    if (!tile || !(HOOK_EVENTS as readonly string[]).includes(event)) return {};
    if (harness) this.registry.setHarness(tileId, harness);
    if (typeof input.cwd === "string" && input.cwd.startsWith("/")) {
      this.registry.setMeta(tileId, { cwd: input.cwd });
    }
    const take = () => this.mailboxes.take(tileId, "delivered");
    switch (event as HookEvent) {
      case "SessionStart": {
        const self = this.registry.get(tileId)!;
        const pending = take();
        const intro = sessionIntro(self, this.registry.list());
        return contextOutput(
          "SessionStart",
          pending.length > 0 ? `${intro}\n${formatMessages(pending)}` : intro,
        );
      }
      case "UserPromptSubmit":
      case "PostToolUse": {
        this.registry.setStatus(tileId, "busy");
        const pending = take();
        return contextOutput(
          event as HookEvent,
          pending.length > 0 ? formatMessages(pending) : "",
        );
      }
      case "Stop": {
        const pending = take();
        if (pending.length > 0) {
          this.registry.setStatus(tileId, "busy");
          return stopOutput(pending);
        }
        this.registry.setStatus(tileId, "idle");
        return {};
      }
      case "Notification": {
        const status = notificationStatus(input.notification_type);
        if (status) this.registry.setStatus(tileId, status);
        return {};
      }
    }
  }
}
