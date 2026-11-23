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
  RequestContext,
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
import { tileInput } from "./tile-input.ts";
import { MAX_READ_LINES } from "./mirror.ts";
import type { CompanionTools } from "../companion/inference-brain.ts";
import type {
  PermissionDecision,
  PermissionRequest,
} from "../agent/adapter.ts";
import { approveToolArgs, approveToolReply } from "../agent/permissions.ts";
import { APPROVE_TOOL } from "../agent/claude-stream.ts";
import { optBool, optInt, optStr, str } from "./tool-args.ts";
import {
  contentText,
  readWebTile,
  type ToolBlock,
  ToolContent,
  WEB_TOOLS,
  webToolHost,
} from "./web-tools.ts";

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

// --- argument readers (a bad argument is the caller's mistake: a HubError; lib/hub/tool-args.ts) --

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

/** MCP behaviour hints for a tool (`tools/list`'s `annotations`). */
interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

const READS: ToolHints = { readOnlyHint: true, openWorldHint: false };
const LOCAL: ToolHints = { destructiveHint: false, openWorldHint: false };
const TYPES: ToolHints = { destructiveHint: true, openWorldHint: false };
/** Acting on a web page: what it does reaches the web. */
const BROWSES: ToolHints = { destructiveHint: true, openWorldHint: true };

/**
 * Each tool's hints. Codex runs an MCP tool without asking when its hints say it only reads, or
 * changes nothing destructive and stays within a closed world (here: the window's tiles and
 * mailboxes); otherwise it asks first, and in `codex exec` it refuses. Typing into a terminal,
 * starting a command in a new tile and closing one are marked destructive; so is acting on a web
 * page, which reaches the web. Reading a page is a read, like reading a screen.
 */
export const TOOL_HINTS: Readonly<Record<string, ToolHints>> = {
  whoami: READS,
  list_peers: READS,
  read_screen: READS,
  read_scrollback: READS,
  set_name: LOCAL,
  set_status: LOCAL,
  send_message: LOCAL,
  read_messages: LOCAL,
  wait_for_message: LOCAL,
  ask_user: LOCAL,
  focus_tile: LOCAL,
  deliver: LOCAL,
  write_tile: TYPES,
  spawn_tile: TYPES,
  close_tile: TYPES,
  read_page: READS,
  open_web: BROWSES,
  web_navigate: BROWSES,
  web_go: BROWSES,
  web_click: BROWSES,
  web_type: BROWSES,
  web_scroll: LOCAL,
  web_eval: BROWSES,
  web_screenshot: READS,
};

/** Build the tool registry for `core`; each tool is listed with its {@linkcode TOOL_HINTS}. */
export function buildToolRegistry(core: HubCore): McpToolRegistry {
  const reg = new McpToolRegistry();
  const web = webToolHost({
    tiles: core.webTiles,
    tile: (target) => core.tile(target),
    control: (command) => core.webControl(command),
  });
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
    reg.register(
      name,
      description,
      schema,
      async (args, ctx) => {
        try {
          const value = await run(args, identityOf(ctx), ctx);
          return value instanceof ToolContent
            ? { content: value.content }
            : ok(value);
        } catch (e) {
          if (e instanceof HubError) return fail(e.message);
          throw e;
        }
      },
      TOOL_HINTS[name] ? { annotations: { ...TOOL_HINTS[name] } } : {},
    );

  add(
    "whoami",
    "Which Qutty tile you are in: its id, name, harness, working directory and status.",
    obj({}),
    (_a, who) =>
      who.role === "companion" ? { role: "companion" } : core.self(who),
  );
  add(
    "list_peers",
    "Every tile in this Qutty window (id, name, harness, title, cwd, git worktree and branch, busy/idle/waiting, unread " +
      'messages), plus the companion. Address them by name or id; "companion" is the window\'s assistant. ' +
      'A web tile (kind: "web", id web-1) shows a page: its url, and its title as the label.',
    obj({}),
    (_a, who) => ({
      you: who.role === "tile" ? who.tileId : "companion",
      tiles: core.registry.list(),
      companion: {
        name: "companion",
        note:
          "the window's companion (its assistant): it talks to the user and can act on any tile",
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
    "Tell the window what you are doing: busy, idle, or waiting (for the user). An optional " +
      'short note says how it went ("build failed", "tests pass"); the user may hear it.',
    obj({
      status: { type: "string", enum: [...TILE_STATUSES] },
      note: {
        type: "string",
        description: "A few words, at most 120 characters",
      },
    }, ["status"]),
    (a, who) => {
      const status = str(a, "status") as TileStatus;
      if (!TILE_STATUSES.includes(status)) {
        throw new HubError(`status is one of ${TILE_STATUSES.join(", ")}`);
      }
      const note = optStr(a, "note");
      if (note !== undefined && note.length > 120) {
        throw new HubError('"note" is too long (120 characters at most)');
      }
      const self = core.self(who);
      core.registry.setStatus(self.id, status, note?.replace(/\s+/g, " "));
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
    "The visible screen of a tile, as text (one line per row). For a web tile, its page as " +
      "read_page reads it.",
    obj({ tile: TILE_ARG }, ["tile"]),
    async (a) => {
      const tile = core.tile(str(a, "tile", 256));
      if (tile.kind === "web") {
        let read: Awaited<ReturnType<typeof readWebTile>>;
        try {
          read = await readWebTile(web, tile.id);
        } catch (e) {
          // A page the window cannot look inside (the iframe engine, a closed window): what
          // the hub knows of it, the title and the URL, and why there is no text.
          if (!(e instanceof HubError)) throw e;
          return {
            tile: tile.id,
            name: tile.name,
            kind: "web",
            url: tile.url ?? "",
            title: tile.label ?? "",
            screen: "",
            note: e.message,
          };
        }
        return {
          tile: tile.id,
          name: tile.name,
          kind: "web",
          url: read.tile.url ?? tile.url ?? "",
          title: read.tile.label ?? "",
          screen: read.text,
        };
      }
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
    "(Companion only.) Type text into a tile, as if the user typed it. Set enter: true to press " +
      "Enter after it (to run a command); never spell Enter as a backslash escape in text.",
    obj({
      tile: TILE_ARG,
      text: {
        type: "string",
        description: "What to type (may be empty with enter: true)",
      },
      enter: {
        type: "boolean",
        description: "Press Enter after the text (default false)",
      },
    }, ["tile"]),
    async (a) => {
      const tileId = str(a, "tile", 256);
      const enter = optBool(a, "enter") ?? false;
      const raw = a.text === undefined || a.text === null || a.text === ""
        ? (enter ? "" : str(a, "text"))
        : str(a, "text");
      await core.writeTile(tileId, tileInput(raw, enter));
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

  // --- web tiles (lib/hub/web-tools.ts; read_page is a tile tool too) ---------------------------
  for (const tool of WEB_TOOLS) {
    add(tool.name, tool.description, tool.schema, (a) => tool.run(a, web));
  }
  return reg;
}

/** The agent tiles' side of the hub (lib/agent/sessions.ts): their permission questions. */
export interface HubAgentTiles {
  /** Whether tile `tileId` is an agent tile. */
  has(tileId: string): boolean;
  /** Ask the user, in the tile, whether its agent may run a tool. */
  approve(tileId: string, req: PermissionRequest): Promise<PermissionDecision>;
}

/** Options of {@linkcode createHubHandler}. */
export interface HubHandlerOptions {
  /** Every companion-only tool call, allowed or refused (the audit log). */
  audit?(call: PrivilegedCall): void;
  /** The agent tiles: `approve_tool` is theirs alone (their `--permission-prompt-tool`). */
  agents?: HubAgentTiles;
}

/**
 * `approve_tool`, listed only on an agent tile's own connections: Claude Code's permission prompt
 * tool (lib/agent/claude-stream.ts). The question is shown in the tile; the answer is the JSON
 * Claude Code expects (`{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny",…}`).
 */
const APPROVE_TOOL_DEF = {
  name: APPROVE_TOOL,
  description:
    "(Agent tiles only; Claude Code's permission prompt tool.) Ask the user in the tile whether " +
    "a tool may run.",
  inputSchema: {
    type: "object" as const,
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
};

/** A result's text, for the audit log and the in-process brains (an image is only named). */
const textOf = (r: CallToolResult) =>
  contentText(
    r.content.flatMap((c): ToolBlock[] =>
      c.type === "text"
        ? [{ type: "text" as const, text: String(c.text) }]
        : c.type === "image"
        ? [{ type: "image" as const, data: c.data, mimeType: c.mimeType }]
        : []
    ),
  );

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
    listTools: (ctx) => {
      const listed = tools.listTools();
      const who = ctx?.connection?.identity as HubIdentity | undefined;
      return who?.role === "tile" && opts.agents?.has(who.tileId)
        ? [...listed, APPROVE_TOOL_DEF]
        : listed;
    },
    async callTool(name, args, ctx) {
      let who: HubIdentity;
      try {
        who = identityOf(ctx);
      } catch (e) {
        return fail((e as Error).message);
      }
      if (name === APPROVE_TOOL && opts.agents) {
        if (who.role !== "tile" || !opts.agents.has(who.tileId)) {
          return fail(`${APPROVE_TOOL} is for agent tiles only`);
        }
        const req = approveToolArgs(args);
        if (!req) return fail('"tool_name" must be the name of a tool');
        const decision = await opts.agents.approve(who.tileId, req);
        return ok(JSON.stringify(approveToolReply(decision, req.input)));
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

/**
 * The hub's tools for an in-process brain (lib/companion/inference-brain.ts), called as the
 * companion through `handler`: the same permission check and audit log as a call over the
 * companion socket.
 */
export function companionToolbox(handler: McpHandler): CompanionTools {
  return {
    list: () => handler.listTools(),
    async call(name, args, signal) {
      const ctx = new RequestContext(null);
      ctx.connection = {
        id: "companion-in-process",
        transport: "in-process",
        identity: { role: "companion" } satisfies HubIdentity,
      };
      ctx.signal = signal;
      try {
        const r = await handler.callTool(name, args, ctx);
        return { text: textOf(r), isError: r.isError === true };
      } catch (e) {
        return {
          text: e instanceof Error ? e.message : String(e),
          isError: true,
        };
      }
    },
  };
}

/**
 * The harness an MCP client name stands for (`claude-code` → `claude`), if it is a known one.
 * Checked against the installed clients (2026-11): Hermes Agent 0.23 says `hermes-agent`
 * (`hermes mcp test`), OpenClaw 2026.11 `openclaw-bundle-mcp` (its agent session's MCP runtime,
 * which `openclaw mcp probe` uses too).
 */
export function harnessOfClient(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.startsWith("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  if (n.startsWith("hermes")) return "hermes";
  if (n.startsWith("openclaw")) return "openclaw";
  if (n.includes("gemini")) return "gemini";
  if (n.includes("opencode")) return "opencode";
  return undefined;
}
