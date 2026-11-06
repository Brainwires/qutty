/**
 * Claude Code hook responses, kept pure. `qutty-hook` forwards each hook's stdin JSON to the hub
 * and prints the hub's reply as the hook's stdout. The shapes follow the hooks reference
 * (https://code.claude.com/docs/en/hooks, checked 2026-11):
 *
 * - `SessionStart`, `UserPromptSubmit`, `PostToolUse`: `hookSpecificOutput.additionalContext`
 *   (with `hookEventName`) is added to the model's context;
 * - `Stop`: `{ decision: "block", reason }` keeps the agent going with `reason` as its next
 *   instruction; anything else lets it stop;
 * - `Notification`: no decision control; its input's `notification_type` says why it fired.
 *
 * Codex (0.167, https://learn.chatgpt.com/docs/hooks and openai/codex `codex-rs/hooks`, checked
 * 2026-11) takes the same input fields and the same output shapes for the events both have. It
 * has no `Notification`; instead `PermissionRequest` fires before an approval prompt (answering
 * `{}` leaves the prompt to the user) and `Interrupt` when the user stops a turn (no `Stop`
 * follows). `Stop`'s `{ decision: "block", reason }` becomes Codex's next continuation prompt.
 *
 * @module
 */

import type { HubMessage, TileStatus } from "./protocol.ts";

/** The events `qutty-hook` is registered for. */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "Notification",
] as const;

/** The events `qutty-hook codex` is registered for (Codex has no `Notification`). */
export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "Interrupt",
] as const;

/** Every event the hub answers. */
export type HookEvent =
  | typeof HOOK_EVENTS[number]
  | typeof CODEX_HOOK_EVENTS[number];

/** Whether the hub answers `event`. */
export function isHookEvent(event: string): event is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(event) ||
    (CODEX_HOOK_EVENTS as readonly string[]).includes(event);
}

/** A hook's stdout JSON (`{}` = nothing to say). */
export type HookOutput =
  | Record<string, never>
  | { decision: "block"; reason: string }
  | {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };

/** The messages, as the agent reads them in its context. */
export function formatMessages(messages: readonly HubMessage[]): string {
  const head = messages.length === 1
    ? "[Qutty] A message from another tile:"
    : `[Qutty] ${messages.length} messages from other tiles:`;
  const body = messages.map((m) =>
    `- from ${m.fromName} (${m.from}, ${m.id}${
      m.replyTo ? `, reply to ${m.replyTo}` : ""
    }): ${m.text}`
  );
  return [
    head,
    ...body,
    "Answer with the qutty MCP tool send_message (to: the sender's name, replyTo: the message id) when a reply is wanted.",
  ].join("\n");
}

/** What `SessionStart` tells the agent about where it runs. */
export function sessionIntro(
  self: { id: string; name: string },
  peers: readonly {
    id: string;
    name: string;
    harness?: string;
    model?: string;
  }[],
): string {
  const others = peers.filter((p) => p.id !== self.id);
  const list = others.length === 0
    ? "no other tiles yet"
    : others.map((p) =>
      `${p.name}${
        p.harness ? ` (${p.harness}${p.model ? ` · ${p.model}` : ""})` : ""
      }`
    ).join(", ");
  return `[Qutty] You run in Qutty tile "${self.name}" (${self.id}). Other tiles: ${list}. ` +
    "The qutty MCP server's tools let you list peers, read any tile's screen or scrollback, " +
    "message other agents or the companion, and ask the user. Messages for you arrive here " +
    "or through read_messages.";
}

/** The status a `Notification` sets, by `notification_type` (`undefined`: unchanged). */
export function notificationStatus(type: unknown): TileStatus | undefined {
  switch (type) {
    case "permission_prompt":
    case "elicitation_dialog":
    case "elicitation_url_dialog":
    case "agent_needs_input":
      return "waiting";
    case "idle_prompt":
      return "idle";
    default:
      return undefined;
  }
}

/** `additionalContext` for `event`, or `{}` when there is nothing to add. */
export function contextOutput(event: HookEvent, text: string): HookOutput {
  return text === ""
    ? {}
    : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** The `Stop` reply: block only when messages are pending. */
export function stopOutput(pending: readonly HubMessage[]): HookOutput {
  return pending.length === 0
    ? {}
    : { decision: "block", reason: formatMessages(pending) };
}
