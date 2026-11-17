/**
 * An agent tile's permission questions: "may the agent run this tool with this input?" asked by
 * Claude Code through the hub's `approve_tool` (its `--permission-prompt-tool`), or by an
 * in-process adapter, and answered in the tile with Allow / Allow always / Deny.
 *
 * The broker keeps the open questions of one session, answers them, withdraws them (an
 * interrupt, the session ending: denied) and remembers "Allow always" for the rest of the
 * session, per tool. {@linkcode approveToolArgs} reads `approve_tool`'s arguments and
 * {@linkcode approveToolReply} writes the answer Claude Code expects.
 *
 * Pure.
 *
 * @module
 */

import type { PermissionDecision, PermissionRequest } from "./adapter.ts";

/** An open question. */
export interface OpenPermission {
  requestId: string;
  request: PermissionRequest;
}

/** One session's permission questions. */
export class PermissionBroker {
  #open = new Map<
    string,
    { request: PermissionRequest; resolve(d: PermissionDecision): void }
  >();
  #always = new Set<string>();
  #next = 0;
  #prefix: string;

  /** @param prefix Request ids start with it (unique per session). */
  constructor(prefix = "perm") {
    this.#prefix = prefix;
  }

  /** Whether "Allow always" was picked for this tool. */
  allowedAlways(toolName: string): boolean {
    return this.#always.has(toolName);
  }

  /**
   * A new question: its id (to show) and its answer. A tool allowed always answers at once
   * (`requestId` is then `undefined`: nothing to show).
   */
  ask(request: PermissionRequest): {
    requestId?: string;
    answer: Promise<PermissionDecision>;
  } {
    if (this.#always.has(request.toolName)) {
      return { answer: Promise.resolve("allow") };
    }
    const requestId = `${this.#prefix}-${++this.#next}`;
    const answer = new Promise<PermissionDecision>((resolve) => {
      this.#open.set(requestId, { request, resolve });
    });
    return { requestId, answer };
  }

  /** Answer question `requestId`; false when it is not open. */
  answer(requestId: string, decision: PermissionDecision): boolean {
    const open = this.#open.get(requestId);
    if (!open) return false;
    this.#open.delete(requestId);
    if (decision === "always") this.#always.add(open.request.toolName);
    open.resolve(decision);
    return true;
  }

  /** Deny every open question (the turn was interrupted, the session ends); their ids. */
  withdrawAll(): string[] {
    const ids = [...this.#open.keys()];
    for (const id of ids) this.answer(id, "deny");
    return ids;
  }

  /** The open questions, oldest first. */
  open(): OpenPermission[] {
    return [...this.#open].map(([requestId, o]) => ({
      requestId,
      request: o.request,
    }));
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `approve_tool`'s arguments (`{ tool_name, input, tool_use_id }`), or `undefined`. */
export function approveToolArgs(
  args: Record<string, unknown>,
): PermissionRequest | undefined {
  const name = args.tool_name;
  if (typeof name !== "string" || !name || name.length > 200) return undefined;
  return {
    toolName: name,
    input: isObj(args.input) ? args.input : {},
    ...(typeof args.tool_use_id === "string" && args.tool_use_id.length <= 200
      ? { toolUseId: args.tool_use_id }
      : {}),
  };
}

/** What the user said no with, as the agent reads it. */
const DENY_MESSAGE =
  "The user denied this tool call in Qutty. Do not retry it; ask the user what to do instead.";

/** The answer Claude Code's permission prompt tool expects (as the tool result's text). */
export function approveToolReply(
  decision: PermissionDecision,
  input: Record<string, unknown>,
): { behavior: "allow"; updatedInput: Record<string, unknown> } | {
  behavior: "deny";
  message: string;
} {
  return decision === "deny"
    ? { behavior: "deny", message: DENY_MESSAGE }
    : { behavior: "allow", updatedInput: input };
}
