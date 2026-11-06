/**
 * The hub's MCP tools, on `@rullama/mcp-server`'s `McpToolRegistry`, and the `McpHandler` every
 * connection is served with. Who is calling comes from the connection (`ctx.connection.identity`,
 * set by the socket the client came through), never from the arguments. Every tool is listed for
 * everyone; a tile calling a companion-only tool gets an error result (see `canCall`).
 *
 * @module
 */

import {
  type McpHandler,
  McpToolRegistry,
  type RequestContext,
} from "@rullama/mcp-server";
import type { CallToolResult } from "@rullama/mcp-client";
import {
  canCall,
  COMPANION_TOOLS,
  type HubIdentity,
  type PrivilegedCall,
  TILE_STATUSES,
  type TileStatus,
} from "./protocol.ts";
import { type HubCore, HubError } from "./core.ts";
import { MAX_WAIT_MS } from "./mailbox.ts";
import { MAX_READ_LINES } from "./mirror.ts";

/** The server name agents see (`mcp__qutty__…` in Claude Code). */
const SERVER_NAME = "qutty";
/** Sent as `serverInfo.version`. */
const SERVER_VERSION = "0.1.0";

const ok = (value: unknown): CallToolResult => ({
  content: [{
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }],
});

const fail = (message: string): CallToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

// --- argument readers (a bad argument is the caller's mistake: a HubError) ------------------------

function str(
  args: Record<string, unknown>,
  key: string,
  max = 32 * 1024,
): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new HubError(`"${key}" must be a non-empty string`);
  }
  if (v.length > max) throw new HubError(`"${key}" is too long`);
  return v;
}

function optStr(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  return args[key] === undefined || args[key] === null
    ? undefined
    : str(args, key);
}

function optInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new HubError(`"${key}" must be an integer in ${min}..${max}`);
  }
  return v;
}

function optBool(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new HubError(`"${key}" must be true or false`);
  }
  return v;
}

function actionsOf(args: Record<string, unknown>): string[] {
  const v = args.actions;
  if (v === undefined || v === null) return [];
  if (
    !Array.isArray(v) || v.length > 6 ||
    v.some((a) => typeof a !== "string" || a.length === 0 || a.length > 40)
  ) {
    throw new HubError('"actions" is a list of up to 6 short button labels');
  }
  return v as string[];
}

/** The caller, from the connection it came on. */
function identityOf(ctx: RequestContext): HubIdentity {
  const id = ctx.connection?.identity as HubIdentity | undefined;
  if (!id || (id.role !== "tile" && id.role !== "companion")) {
    throw new HubError("unidentified connection");
  }
  return id;
}

const TILE_ARG = {
  type: "string",
  description: "A tile id (pty-3) or name (list_peers shows both)",
};
const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

/** Build the tool registry for `core`. */
export function buildToolRegistry(core: HubCore): McpToolRegistry {
  const reg = new McpToolRegistry();
  const add = (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    run: (
      args: Record<string, unknown>,
      who: HubIdentity,
      ctx: RequestContext,
    ) => unknown,
  ) =>
    reg.register(name, description, schema, async (args, ctx) => {
      try {
        return ok(await run(args, identityOf(ctx), ctx));
      } catch (e) {
        if (e instanceof HubError) return fail(e.message);
        throw e;
      }
    });

  add(
    "whoami",
    "Which Qutty tile you are in: its id, name, harness, working directory and status.",
    obj({}),
    (_a, who) =>
      who.role === "companion" ? { role: "companion" } : core.self(who),
  );
  add(
    "list_peers",
    "Every tile in this Qutty window (id, name, harness, title, cwd, busy/idle/waiting, unread " +
      'messages), plus the companion. Address them by name or id; "companion" is the window\'s assistant.',
    obj({}),
    (_a, who) => ({
      you: who.role === "tile" ? who.tileId : "companion",
      tiles: core.registry.list(),
      companion: {
        name: "companion",
        note:
          "the window's assistant (Loopy): it talks to the user and can act on any tile",
      },
    }),
  );
  add(
    "set_name",
    "Rename your tile, so other agents can address you by a meaningful name.",
    obj({ name: { type: "string", description: "Letters, digits, . _ -" } }, [
      "name",
    ]),
    (a, who) => {
      try {
        return core.registry.rename(core.self(who).id, str(a, "name", 64));
      } catch (e) {
        throw e instanceof HubError ? e : new HubError((e as Error).message);
      }
    },
  );
  add(
    "set_status",
    "Tell the window what you are doing: busy, idle, or waiting (for the user).",
    obj({ status: { type: "string", enum: [...TILE_STATUSES] } }, ["status"]),
    (a, who) => {
      const status = str(a, "status") as TileStatus;
      if (!TILE_STATUSES.includes(status)) {
        throw new HubError(`status is one of ${TILE_STATUSES.join(", ")}`);
      }
      const self = core.self(who);
      core.registry.setStatus(self.id, status);
      return core.registry.get(self.id);
    },
  );
  add(
    "send_message",
    'Send a message to another tile\'s agent (by name or id), to "companion", or to "all" other ' +
      "tiles. It reaches the recipient at its next opportunity (between tool calls or when it " +
      "would stop). You cannot type into another tile; ask its agent instead.",
    obj({
      to: {
        type: "string",
        description: 'A tile name or id, "companion" or "all"',
      },
      text: { type: "string" },
      replyTo: {
        type: "string",
        description: "The id of the message you answer",
      },
    }, ["to", "text"]),
    (a, who) => {
      const sent = core.send(
        who,
        str(a, "to", 256),
        str(a, "text"),
        optStr(a, "replyTo"),
      );
      return { sent: sent.map((m) => ({ id: m.id, to: m.to })) };
    },
  );
  add(
    "read_messages",
    "Messages sent to you that you have not seen yet (they are marked read). all: true returns " +
      "the recent history instead.",
    obj({ all: { type: "boolean" } }),
    (a, who) => ({ messages: core.read(who, optBool(a, "all") ?? false) }),
  );
  add(
    "wait_for_message",
    "Wait until a message arrives for you (or timeoutMs passes), then return it.",
    obj({ timeoutMs: { type: "integer", minimum: 0, maximum: MAX_WAIT_MS } }),
    async (a, who, ctx) => ({
      messages: await core.wait(
        who,
        optInt(a, "timeoutMs", 0, MAX_WAIT_MS) ?? 60_000,
        ctx.signal,
      ),
    }),
  );
  add(
    "read_screen",
    "The visible screen of a tile, as text (one line per row).",
    obj({ tile: TILE_ARG }, ["tile"]),
    async (a) => {
      const tile = core.tile(str(a, "tile", 256));
      const mirror = core.envMirror(tile.id);
      return {
        tile: tile.id,
        name: tile.name,
        screen: (await mirror.screen()).join("\n"),
      };
    },
  );
  add(
    "read_scrollback",
    "Lines of a tile's scrollback. Without offset, the last `lines` lines (default 200); offset " +
      "counts from the oldest line kept. grep (a case-insensitive regular expression) returns " +
      "only matching lines, with their line numbers.",
    obj({
      tile: TILE_ARG,
      offset: { type: "integer", minimum: 0 },
      lines: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
      grep: { type: "string" },
    }, ["tile"]),
    async (a) => {
      const tile = core.tile(str(a, "tile", 256));
      const offset = optInt(a, "offset", 0, Number.MAX_SAFE_INTEGER);
      const lines = optInt(a, "lines", 1, MAX_READ_LINES);
      const grep = optStr(a, "grep");
      const page = await core.envMirror(tile.id).scrollback({
        ...(offset !== undefined ? { offset } : {}),
        ...(lines !== undefined ? { lines } : {}),
        ...(grep !== undefined ? { grep } : {}),
      });
      return {
        tile: tile.id,
        total: page.total,
        start: page.start,
        text: page.lines.map((l) => `${l.n}: ${l.text}`).join("\n"),
      };
    },
  );
  add(
    "ask_user",
    "Ask the user something, with optional buttons (actions). wait: true (the default) waits for " +
      "the answer; wait: false returns at once and the answer arrives as a message.",
    obj({
      text: { type: "string" },
      actions: { type: "array", items: { type: "string" }, maxItems: 6 },
      wait: { type: "boolean" },
    }, ["text"]),
    async (a, who, ctx) => {
      const wait = optBool(a, "wait") ?? true;
      const { id, answer } = core.ask(who, str(a, "text"), actionsOf(a), {
        wait,
        signal: ctx.signal,
      });
      if (!answer) {
        return { id, status: "asked; the answer will arrive as a message" };
      }
      const action = await answer;
      return action === null
        ? { id, answered: false, note: "dismissed or timed out" }
        : { id, answered: true, action };
    },
  );

  // --- companion only ---------------------------------------------------------------------------
  add(
    "write_tile",
    "(Companion only.) Type text into a tile, as if the user typed it. Include \\r to press Enter.",
    obj({ tile: TILE_ARG, text: { type: "string" } }, ["tile", "text"]),
    async (a) => {
      await core.writeTile(str(a, "tile", 256), str(a, "text"));
      return "written";
    },
  );
  add(
    "spawn_tile",
    "(Companion only.) Open a new tile: the login shell, or a `+` picker entry (profile: " +
      '"shell:/bin/bash", "agent:claude", "ssh:myhost"). With command, that line is typed into ' +
      "the new tile and run. Returns the new tile's id and name.",
    obj({
      command: {
        type: "string",
        description: "A shell command line to run in it",
      },
      profile: {
        type: "string",
        description: "A + picker entry id (default: the login shell)",
      },
    }),
    async (a) => {
      const command = optStr(a, "command");
      const profile = optStr(a, "profile");
      const { tileId } = await core.control({
        kind: "spawn",
        ...(command ? { command } : {}),
        ...(profile ? { profile } : {}),
      });
      const tile = tileId ? core.registry.get(tileId) : undefined;
      return tile
        ? { tile: tile.id, name: tile.name }
        : { tile: tileId ?? null };
    },
  );
  add(
    "close_tile",
    "(Companion only.) Close a tile (its program is hung up).",
    obj({ tile: TILE_ARG }, ["tile"]),
    async (a) => {
      await core.control({
        kind: "close",
        tileId: core.tile(str(a, "tile", 256)).id,
      });
      return "closed";
    },
  );
  add(
    "focus_tile",
    "(Companion only.) Bring a tile to the front and give it the keyboard.",
    obj({ tile: TILE_ARG }, ["tile"]),
    async (a) => {
      await core.control({
        kind: "focus",
        tileId: core.tile(str(a, "tile", 256)).id,
      });
      return "focused";
    },
  );
  add(
    "deliver",
    "(Companion only.) Nudge an idle agent tile whose agent has no hooks: type a one-line " +
      "notice of its pending messages into its prompt and press Enter.",
    obj({ tile: TILE_ARG }, ["tile"]),
    async (a) => ({ pending: await core.deliver(str(a, "tile", 256)) }),
  );
  return reg;
}

/** Options of {@linkcode createHubHandler}. */
export interface HubHandlerOptions {
  /** Every companion-only tool call, allowed or refused (the audit log). */
  audit?(call: PrivilegedCall): void;
}

/** A result's text, for the audit log. */
const textOf = (r: CallToolResult) =>
  r.content.map((c) => ("text" in c ? String(c.text) : "")).join(" ");

/**
 * The `McpHandler` for every hub connection: the registry's tools, the permission check, the
 * audit of companion-only calls, and the harness learnt from the client's `initialize`
 * (`claude-code` → `claude`).
 */
export function createHubHandler(
  core: HubCore,
  tools: McpToolRegistry,
  opts: HubHandlerOptions = {},
): McpHandler {
  const privileged = (name: string) =>
    (COMPANION_TOOLS as readonly string[]).includes(name);
  const audit = (
    name: string,
    who: HubIdentity,
    args: Record<string, unknown>,
    ok: boolean,
    error?: string,
  ) => {
    if (!privileged(name) || !opts.audit) return;
    try {
      opts.audit({
        tool: name,
        by: who.role === "companion" ? "companion" : who.tileId,
        args,
        ok,
        ...(error ? { error } : {}),
      });
    } catch { /* the log must never fail a call */ }
  };
  return {
    serverInfo: () => ({ name: SERVER_NAME, version: SERVER_VERSION }),
    capabilities: () => ({ tools: { listChanged: false } }),
    listTools: () => tools.listTools(),
    async callTool(name, args, ctx) {
      let who: HubIdentity;
      try {
        who = identityOf(ctx);
      } catch (e) {
        return fail((e as Error).message);
      }
      if (!tools.hasTool(name)) return fail(`unknown tool: ${name}`);
      if (!canCall(who, name)) {
        audit(name, who, args, false, "refused: companion only");
        return fail(
          `${name} is for the companion only. Ask the tile's agent (send_message) or the ` +
            "companion to do it.",
        );
      }
      try {
        const result = await tools.dispatch(name, args, ctx);
        audit(
          name,
          who,
          args,
          !result.isError,
          result.isError ? textOf(result) : undefined,
        );
        return result;
      } catch (e) {
        audit(
          name,
          who,
          args,
          false,
          e instanceof Error ? e.message : String(e),
        );
        throw e;
      }
    },
    // deno-lint-ignore require-await
    async onInitialize(params, ctx) {
      const who = ctx?.connection?.identity as HubIdentity | undefined;
      const harness = harnessOfClient(params.clientInfo.name);
      if (who?.role === "tile" && harness) {
        core.registry.setHarness(who.tileId, harness);
      }
    },
  };
}

/** The harness an MCP client name stands for (`claude-code` → `claude`), if it is a known one. */
export function harnessOfClient(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.startsWith("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  if (n.includes("gemini")) return "gemini";
  if (n.includes("opencode")) return "opencode";
  return undefined;
}
