/**
 * Does the installed Codex trust Qutty's hooks? Qutty writes the trust entries itself
 * (`[hooks.state."<config.toml>:<event>:<n>:0"]` with `trusted_hash`, lib/hub/integration.ts),
 * computing Codex's hash by Codex's own algorithm ({@linkcode codexHookHash}). If a Codex release
 * changes that algorithm, or the trust entries no longer match the hooks, Codex silently skips
 * Qutty's hooks (messages still arrive through `read_messages`, but nothing is pushed).
 *
 * So the app asks Codex itself, once per start and again after an Install: `codex app-server`
 * (stdio JSON-RPC, no model, no network, no login) answers `hooks/list` with each hook's
 * `trustStatus` and `currentHash` (desktop/codex-trust.ts runs it in a hidden PTY). This module
 * is the pure half: the request lines, the answer's parsing, the verdict and its warning, which
 * Settings → Agent integration shows on the Codex row with a Re-trust button.
 *
 * @module
 */

import { CODEX_HOOK_EVENTS } from "./hooks.ts";
import {
  type CodexHookEvent,
  codexHookHash,
  hookCommand,
  type HubPaths,
} from "./launch.ts";

/** One hook as `hooks/list` reports it (the fields Qutty reads). */
export interface ListedCodexHook {
  /** `<config file>:<event>:<group>:<handler>` */
  key: string;
  /** camelCase (`postToolUse`). */
  eventName: string;
  command: string;
  /** `trusted`, `untrusted`, `modified`, … */
  trustStatus: string;
  /** The hash Codex computes for it now (`sha256:…`). */
  currentHash?: string;
}

/** The JSON-RPC id of the `hooks/list` call in {@linkcode codexHooksListRequest}. */
const LIST_ID = 2;

/** What `codex app-server` reads on stdin: initialize, initialized, then `hooks/list` for `cwd`. */
export function codexHooksListRequest(cwd: string): string {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "qutty", version: "0" } },
    },
    { jsonrpc: "2.0", method: "initialized" },
    {
      jsonrpc: "2.0",
      id: LIST_ID,
      method: "hooks/list",
      params: { cwds: [cwd] },
    },
  ].map((m) => JSON.stringify(m) + "\n").join("");
}

/**
 * The hooks in `codex app-server`'s output (JSON lines, maybe `\r\n`, maybe with other lines and
 * notifications between them): the `hooks/list` result's hooks for the first folder, or
 * `undefined` while that answer has not arrived (or is an error).
 */
export function parseHooksListAnswer(
  output: string,
): ListedCodexHook[] | undefined {
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = v as { id?: unknown; result?: { data?: unknown } };
    if (msg?.id !== LIST_ID || typeof msg.result !== "object") continue;
    const data = Array.isArray(msg.result?.data) ? msg.result.data : [];
    const hooks = (data[0] as { hooks?: unknown } | undefined)?.hooks;
    if (!Array.isArray(hooks)) return [];
    return hooks.flatMap((h): ListedCodexHook[] => {
      if (typeof h !== "object" || h === null) return [];
      const o = h as Record<string, unknown>;
      if (
        typeof o.eventName !== "string" || typeof o.command !== "string" ||
        typeof o.trustStatus !== "string"
      ) {
        return [];
      }
      return [{
        key: typeof o.key === "string" ? o.key : "",
        eventName: o.eventName,
        command: o.command,
        trustStatus: o.trustStatus,
        ...(typeof o.currentHash === "string"
          ? { currentHash: o.currentHash }
          : {}),
      }];
    });
  }
  return undefined;
}

/** Codex's verdict on Qutty's hooks. */
export interface CodexTrustCheck {
  /** Every event has Qutty's hook, and Codex trusts each of them. */
  trusted: boolean;
  /** The events whose Qutty hook is untrusted or missing. */
  untrusted: CodexHookEvent[];
  /** Codex hashes one of Qutty's hooks differently from Qutty: its algorithm changed. */
  hashChanged: boolean;
}

/** `hooks/list`'s event name for an event (`PostToolUse` → `postToolUse`). */
const listedEvent = (event: CodexHookEvent) =>
  event[0].toLowerCase() + event.slice(1);

/** The verdict on Qutty's hooks (those running `qutty-hook codex` from `paths`) among `hooks`. */
export function codexTrustCheck(
  hooks: readonly ListedCodexHook[],
  paths: HubPaths,
): CodexTrustCheck {
  const command = hookCommand(paths, "codex");
  const ours = hooks.filter((h) => h.command === command);
  const untrusted: CodexHookEvent[] = [];
  let hashChanged = false;
  for (const event of CODEX_HOOK_EVENTS) {
    const listed = ours.filter((h) => h.eventName === listedEvent(event));
    if (
      listed.length === 0 || listed.some((h) => h.trustStatus !== "trusted")
    ) {
      untrusted.push(event);
    }
    const want = codexHookHash(paths, event);
    if (listed.some((h) => h.currentHash && h.currentHash !== want)) {
      hashChanged = true;
    }
  }
  return { trusted: untrusted.length === 0, untrusted, hashChanged };
}

/** What the Codex row says when Codex does not trust Qutty's hooks (`undefined`: it does). */
export function codexTrustWarning(check: CodexTrustCheck): string | undefined {
  if (check.trusted) return undefined;
  const n = check.untrusted.length;
  const base = n === CODEX_HOOK_EVENTS.length
    ? "The installed Codex trusts none of Qutty's hooks, so it skips them"
    : `The installed Codex does not trust Qutty's ${
      check.untrusted.join(", ")
    } hook${n === 1 ? "" : "s"}, so it skips ${n === 1 ? "it" : "them"}`;
  const why = `${base} (messages still arrive through read_messages).`;
  return check.hashChanged
    ? `${why} This Codex hashes hooks differently from this Qutty, so Re-trust cannot fix it: update Qutty.`
    : `${why} Re-trust writes the trust entries again.`;
}
