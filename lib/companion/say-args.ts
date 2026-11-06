/**
 * `qutty-hook say <text…> [--mood m] [--action id:label]… [--timeout ms] [--wait]`: the command
 * line of Denext's `loopy-say` (examples/companion/scripts/loopy-say.ts; same author, MIT), parsed
 * by the hub. The shim forwards its arguments as they are (one JSON line on the tile's socket);
 * the hub turns them into the example's `say` request here and validates that with
 * `parseSayRequest` (lib/companion/messages.ts).
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { LoopyMood } from "./loopy-machine.ts";
import type { LoopyAction, SayRequest } from "./messages.ts";

/** A usage error: the shim prints it on stderr and exits 1. */
export class UsageError extends Error {}

/** What the flags have set so far. */
interface Flags {
  mood?: LoopyMood;
  timeoutMs?: number;
  wait: boolean;
  actions: LoopyAction[];
}

/** `<id>:<label>` as an action. */
function action(spec: string): LoopyAction {
  const colon = spec.indexOf(":");
  if (colon <= 0) throw new UsageError("--action takes <id>:<label>");
  return { id: spec.slice(0, colon), label: spec.slice(colon + 1) };
}

/** The flags that take a value, and what each sets. */
const VALUE_FLAGS: Record<string, (f: Flags, v: string) => void> = {
  "--mood": (f, v) => (f.mood = v as LoopyMood),
  "--timeout": (f, v) => (f.timeoutMs = Number(v)),
  "--action": (f, v) => f.actions.push(action(v)),
};

/** Apply flag `args[i]` (and its value); the index of the last argument used. */
function applyFlag(f: Flags, args: readonly string[], i: number): number {
  const name = args[i];
  if (name === "--wait") {
    f.wait = true;
    return i;
  }
  const set = Object.hasOwn(VALUE_FLAGS, name) ? VALUE_FLAGS[name] : undefined;
  if (!set) throw new UsageError(`unknown flag ${name}`);
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value`);
  }
  set(f, value);
  return i + 1;
}

/**
 * The `say` request the words and flags describe (the text may be several words). Throws
 * {@linkcode UsageError}; the request itself is validated by `parseSayRequest`.
 */
export function parseSayArgs(args: readonly string[]): SayRequest {
  const words: string[] = [];
  const f: Flags = { wait: false, actions: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) i = applyFlag(f, args, i);
    else words.push(args[i]);
  }
  const text = words.join(" ").trim();
  if (!text) throw new UsageError("say what?");
  return {
    text,
    ...(f.mood ? { mood: f.mood } : {}),
    ...(f.actions.length ? { actions: f.actions } : {}),
    ...(f.timeoutMs !== undefined ? { timeoutMs: f.timeoutMs } : {}),
    ...(f.wait ? { wait: true } : {}),
  };
}
