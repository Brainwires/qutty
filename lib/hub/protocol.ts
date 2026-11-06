/**
 * The agent hub's shared shapes: what a tile looks like in the registry, a message, an `ask_user`
 * request, the tool names and who may call which. Client-safe (no Deno APIs): the page imports
 * these for the tile badges and the ask dialog; desktop/hub.ts and the rest of lib/hub/ build on
 * them.
 *
 * @module
 */

/** What a tile's agent is doing, as its hooks (or `set_status`) report it. */
export type TileStatus = "busy" | "idle" | "waiting";

/** Every status, for validation. */
export const TILE_STATUSES: readonly TileStatus[] = ["busy", "idle", "waiting"];

/** One tile (one PTY) as the hub knows it. */
export interface TileInfo {
  /** The PTY id (`pty-3`): `QUTTY_TILE_ID` in the tile's environment. */
  id: string;
  /** A unique, user-friendly name (`claude`, `codex-2`, `shell-4`), settable with `set_name`. */
  name: string;
  /** The agent harness in the tile (`claude`, `codex`, …), once it is known. */
  harness?: string;
  /** The tile's title as the page shows it. */
  label?: string;
  /** Its working directory, when known. */
  cwd?: string;
  status: TileStatus;
  /** It runs in the window's shared Docker sandbox (its cwd is a path inside the container). */
  sandbox?: boolean;
  /** How its last `set_status` went ("build failed"), until its status changes again. */
  note?: string;
  /** Messages waiting for this tile (not yet handed to it). */
  unread: number;
}

/** The companion's address (`send_message({ to: "companion" })`). */
export const COMPANION = "companion";
/** Messages from the user (an `ask_user` answer that was not waited for) come from here. */
export const USER = "user";
/** `send_message({ to: "all" })`: every other tile. */
export const BROADCAST = "all";

/** Where a message sits in its recipient's mailbox. */
export type MessageState = "queued" | "delivered" | "read";

/** One message. */
export interface HubMessage {
  id: string;
  /** The sender: a tile id, {@linkcode COMPANION} or {@linkcode USER}. */
  from: string;
  /** The sender's name when it was sent. */
  fromName: string;
  /** The recipient: a tile id or {@linkcode COMPANION}. */
  to: string;
  text: string;
  /** The message this one answers. */
  replyTo?: string;
  /** Epoch ms. */
  at: number;
  /**
   * `queued` until the recipient gets it: `delivered` when a hook put it into the agent's
   * context, `read` when the agent pulled it (`read_messages` / `wait_for_message`).
   */
  state: MessageState;
}

/** An `ask_user` question, shown by the page (Loopy's bubble in phase 2; a dialog for now). */
export interface AskRequest {
  id: string;
  /** The asking tile's id (or {@linkcode COMPANION}). */
  from: string;
  fromName: string;
  text: string;
  /** Button labels; the default is OK. */
  actions: string[];
}

/** The page's answer to an {@linkcode AskRequest}: the button picked, or `null` (dismissed). */
export interface AskAnswer {
  id: string;
  action: string | null;
}

/** Who is on the other end of a hub connection (set by the socket it came through). */
export type HubIdentity =
  | { role: "tile"; tileId: string }
  | { role: "companion" };

/** The tools every tile's agent gets. */
export const TILE_TOOLS = [
  "whoami",
  "list_peers",
  "set_name",
  "set_status",
  "send_message",
  "read_messages",
  "wait_for_message",
  "read_screen",
  "read_scrollback",
  "ask_user",
] as const;

/** The tools only the companion may call: they act on other tiles. */
export const COMPANION_TOOLS = [
  "write_tile",
  "spawn_tile",
  "close_tile",
  "focus_tile",
  "deliver",
] as const;

/**
 * The permission matrix: a tile may call the tile tools; the companion may call everything. A
 * tile never types into another tile; it asks that tile's agent (`send_message`) or the
 * companion. Unknown tools are nobody's.
 */
export function canCall(identity: HubIdentity, tool: string): boolean {
  if ((TILE_TOOLS as readonly string[]).includes(tool)) return true;
  if ((COMPANION_TOOLS as readonly string[]).includes(tool)) {
    return identity.role === "companion";
  }
  return false;
}

/** One privileged call (or a refused attempt at one), for the companion's audit log. */
export interface PrivilegedCall {
  tool: string;
  /** `companion`, or the tile id that tried. */
  by: string;
  args: Record<string, unknown>;
  /** Whether it was allowed and succeeded. */
  ok: boolean;
  /** Why it failed or was refused. */
  error?: string;
}

/** What the page's tile badges are drawn from (the hub's `tiles` event and `snapshot`). */
export interface HubSnapshot {
  /** Whether the hub is running (false: it failed to start; the app works without it). */
  running: boolean;
  tiles: TileInfo[];
}

/** Which agent configs the integration panel manages. */
export type IntegrationTarget = "claude" | "codex";

/** One file the integration installer would change, and how. */
export interface IntegrationChange {
  /** The file (`~/.claude.json`, …), with the home folder shown as `~`. */
  path: string;
  /** What is added: the exact text of the entry. */
  adds: string;
}

/** The integration panel's view of one agent. */
export interface IntegrationStatus {
  target: IntegrationTarget;
  label: string;
  /** Our entries are present (all of them). */
  installed: boolean;
  /** Some of our entries are present, or one with our name that we did not write. */
  note?: string;
  /** What Install writes (and Uninstall removes). */
  changes: IntegrationChange[];
}
