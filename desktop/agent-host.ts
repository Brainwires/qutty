// The agent tiles in the hub extension (desktop/hub.ts): the sessions (lib/agent/sessions.ts) on
// Claude Code (desktop/agent-claude.ts), and the page's requests, validated. Each session is a hub
// tile of its own (its socket, name and status: the hub's `#agentTileOpen`), so its Claude Code is
// a hub peer like any agent tile, and its permission questions come back through the hub's
// `approve_tool` to the tile.

import {
  type AgentHubSide,
  AgentSessions,
  type AgentStartRequest,
  type AgentUpdate,
} from "../lib/agent/sessions.ts";
import {
  type AgentAdapter,
  type AgentSessionSpec,
  PERMISSION_MODES,
  type PermissionMode,
} from "../lib/agent/adapter.ts";
import { isModelName, isSessionId } from "../lib/agent/claude-stream.ts";
import { sanitizeRows } from "../lib/agent/transcript.ts";
import { ClaudeAgentAdapter } from "./agent-claude.ts";
import { type Issue, objectSchema, str } from "./schema.ts";

/** What {@linkcode agentSessions} needs from the hub. */
export interface AgentSessionsOptions {
  emit(update: AgentUpdate): void;
  hub: AgentHubSide;
  /** The flags that load the hub's MCP server and hooks into Claude Code. */
  hubArgs(): string[];
  /** Another backend (tests). */
  createAdapter?: (
    spec: AgentSessionSpec,
    tile: { id: string; env: Record<string, string> },
  ) => AgentAdapter;
}

/** The agent tiles' sessions, on Claude Code unless told otherwise. */
export function agentSessions(opts: AgentSessionsOptions): AgentSessions {
  return new AgentSessions({
    emit: opts.emit,
    hub: opts.hub,
    createAdapter: opts.createAdapter ??
      ((_spec, tile) =>
        new ClaudeAgentAdapter({
          env: tile.env,
          hubArgs: opts.hubArgs(),
        })),
  });
}

/** `agentStart`'s input. */
export interface AgentStartInput {
  cwd: string;
  model?: string;
  resumeId?: string;
  permissionMode?: PermissionMode;
  name?: string;
  attach?: string;
  rows?: unknown;
}

const optModel = (v: Record<string, unknown>, issues: Issue[]) => {
  if (v.model === undefined || v.model === "") return undefined;
  if (typeof v.model !== "string" || !isModelName(v.model)) {
    issues.push({ message: "model must be a model name", path: ["model"] });
    return undefined;
  }
  return v.model;
};

const optMode = (v: Record<string, unknown>, issues: Issue[]) => {
  if (v.permissionMode === undefined) return undefined;
  const mode = PERMISSION_MODES.find((m) => m === v.permissionMode);
  if (!mode) {
    issues.push({
      message: `permissionMode is one of ${PERMISSION_MODES.join(", ")}`,
      path: ["permissionMode"],
    });
  }
  return mode;
};

export const agentStartInput = objectSchema<AgentStartInput>((v, issues) => {
  const model = optModel(v, issues);
  const mode = optMode(v, issues);
  const resumeId = typeof v.resumeId === "string" && isSessionId(v.resumeId)
    ? v.resumeId
    : undefined;
  return {
    cwd: str(v, "cwd", issues, 4096),
    ...(model ? { model } : {}),
    ...(resumeId ? { resumeId } : {}),
    ...(mode ? { permissionMode: mode } : {}),
    ...(typeof v.name === "string" && v.name
      ? { name: v.name.slice(0, 40) }
      : {}),
    ...(typeof v.attach === "string" && /^agent-\d+$/.test(v.attach)
      ? { attach: v.attach }
      : {}),
    ...(v.rows !== undefined ? { rows: v.rows } : {}),
  };
});

/**
 * The session request for `input`: the folder made absolute (`~` is the home folder) and checked,
 * the saved rows sanitized. Throws when the folder is not one.
 */
export async function agentStartRequest(
  input: AgentStartInput,
  home: string,
  owner: string | undefined,
): Promise<AgentStartRequest> {
  const raw = input.cwd.trim();
  const cwd = raw === "~"
    ? home
    : raw.startsWith("~/")
    ? `${home.replace(/\/+$/, "")}/${raw.slice(2)}`
    : raw;
  if (!cwd.startsWith("/")) throw new Error(`not an absolute folder: ${raw}`);
  const info = await Deno.stat(cwd).catch(() => undefined);
  if (!info?.isDirectory) throw new Error(`no such folder: ${raw}`);
  return {
    cwd: cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.resumeId ? { resumeId: input.resumeId } : {}),
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.attach ? { attach: input.attach } : {}),
    ...(input.rows !== undefined ? { rows: sanitizeRows(input.rows) } : {}),
    ...(owner ? { owner } : {}),
  };
}

export const idInput = objectSchema<{ id: string }>((v, issues) => ({
  id: str(v, "id", issues, 64),
}));

export const sendAgentInput = objectSchema<{ id: string; message: unknown }>(
  (v, issues) => {
    if (typeof v.message !== "object" || v.message === null) {
      issues.push({ message: "message must be an object", path: ["message"] });
    }
    return { id: str(v, "id", issues, 64), message: v.message };
  },
);

export const answerAgentInput = objectSchema<
  { id: string; requestId: string; decision: "allow" | "always" | "deny" }
>((v, issues) => {
  const decision = (["allow", "always", "deny"] as const).find((d) =>
    d === v.decision
  );
  if (!decision) {
    issues.push({
      message: "decision is allow, always or deny",
      path: ["decision"],
    });
  }
  return {
    id: str(v, "id", issues, 64),
    requestId: str(v, "requestId", issues, 128),
    decision: decision ?? "deny",
  };
});

export const restartAgentInput = objectSchema<
  {
    id: string;
    model?: string;
    permissionMode?: PermissionMode;
    fresh?: boolean;
  }
>((v, issues) => {
  const mode = optMode(v, issues);
  // `""` is "the default model".
  const model = v.model === "" ? "" : optModel(v, issues);
  return {
    id: str(v, "id", issues, 64),
    ...(model !== undefined ? { model } : {}),
    ...(mode ? { permissionMode: mode } : {}),
    ...(v.fresh === true ? { fresh: true } : {}),
  };
});

export const renameAgentInput = objectSchema<{ id: string; name: string }>(
  (v, issues) => ({
    id: str(v, "id", issues, 64),
    name: str(v, "name", issues, 40),
  }),
);
