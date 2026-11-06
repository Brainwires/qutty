/**
 * The companion's shapes shared by the hub (desktop/hub.ts, lib/companion/runtime.ts) and the
 * page (app/companion/): its status, the updates the page follows, the settings it is drawn
 * with, and a `say` message. Client-safe (no Deno APIs).
 *
 * @module
 */

import type { BrainState } from "./brain.ts";
import type { AuditEntry } from "./audit.ts";
import type { LoopyMessage } from "./messages.ts";

export type { AuditEntry, BrainState };

/** Where the companion is drawn: in the window, floating (later: Denext multi-window), or not. */
export type CompanionMode = "window" | "floating" | "off";
/** Every mode, in the order Settings lists them. */
export const COMPANION_MODES: readonly CompanionMode[] = [
  "window",
  "floating",
  "off",
];

/** The window corner Loopy sits in. */
export type CompanionCorner =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left";
/** Every corner. */
export const COMPANION_CORNERS: readonly CompanionCorner[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
];

/** The brain's status, as Loopy and Settings show it. */
export interface CompanionStatus {
  /** Whether the brain may run (Settings → Companion → Brain). */
  enabled: boolean;
  state: BrainState;
  /** Why it is in `error` (or what it is doing), in a few words. */
  detail?: string;
  /** The adapter's name (`Claude Code`). */
  adapter: string;
}

/** Where a turn came from: the user (chat box; voice later) or agents' messages. */
export type TurnSource = "user" | "mail";

/**
 * What the page follows (the hub's `companion` event). Each `turn` update carries the whole text
 * so far, so a replayed or dropped update is harmless.
 */
export type CompanionUpdate =
  | { kind: "status"; status: CompanionStatus }
  | {
    kind: "turn";
    turn: number;
    source: TurnSource;
    text: string;
    done: boolean;
    isError?: boolean;
    /** A turn on agents' messages that the user need not hear about (`(quiet)`). */
    quiet?: boolean;
  }
  | { kind: "tool"; turn: number; name: string }
  | { kind: "activity"; entry: AuditEntry };

/** A `qutty-hook say` message for Loopy's bubble (the hub's `say` event). */
export interface SayEvent {
  message: LoopyMessage;
  /** The sender waits for the button pressed (answer it with `companionSayDone`). */
  wait: boolean;
}
