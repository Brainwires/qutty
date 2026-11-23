/**
 * The page's side of detachable sessions: the snapshot of a workspace it saves in the app's
 * process (desktop/session.ts) as it changes, and the plan to rebuild it when a window shows the
 * workspace again — after its window was closed and reopened, or after a page reload. A snapshot
 * maps each tile to its PTY (and what it runs), so every terminal comes back in its own tile with
 * the layout, MRU order, tile order and focus it had. Pure, so it is tested without a DOM
 * (tests/workspace_session_test.ts).
 *
 * The layout is also kept per workspace in localStorage, which outlives a quit: a workspace window
 * the next launch reopens (`desktop.app.restoreWindows`) gets its layout back, with fresh shells.
 *
 * @module
 */

import type { LayoutOptions, LayoutPattern } from "../layout/mod.ts";
import { SHELL_PROFILE, type TerminalProfile } from "../ssh-ui.ts";
import type { FoldedReplay } from "./replay.ts";
import { clearSignals } from "./activity.ts";
import {
  PATTERNS,
  type SettingsStorage,
  type TerminalEntry,
  type WorkspaceState,
} from "./store.ts";
import { sanitizeWebPage, type WebPage, webTitle } from "../web/url.ts";
import { type AgentChat, sanitizeChat } from "../agent/tile.ts";
import { sanitizeScmTile, type ScmTile, scmTitle } from "../scm/tile.ts";
import { type WorktreeMark, worktreeMarkOf } from "../scm/worktrees.ts";
import { type Row, sanitizeRows, savedRows } from "../agent/transcript.ts";
import { sanitizeOrder } from "./tile-order.ts";
import { sanitizeTileZoom } from "./tile-zoom.ts";
import {
  type FreeformState,
  sanitizeFreeform,
  sanitizeViewMode,
  type ViewMode,
} from "./freeform.ts";

/** One tile's terminal: its PTY now (`null` while none runs), what it runs, its home folder. */
export interface TerminalTileSnapshot {
  ptyId: string | null;
  profile: TerminalProfile;
  home?: string;
}

/** A web tile: the page it shows (it has no PTY; restoring it reopens that page). */
export interface WebTileSnapshot {
  web: WebPage;
}

/**
 * An agent tile: its session (in its entry's `chat`) and a capped copy of its transcript
 * (lib/agent/transcript.ts `savedRows`): a resumed Claude Code session does not replay it.
 */
export interface ChatTileSnapshot {
  chat: AgentChat;
  rows: Row[];
}

/** A Source Control tile: the repository it shows (no PTY; restoring it shows it again). */
export interface ScmTileSnapshot {
  scm: ScmTile;
}

/** One tile as saved: a terminal, a web tile, an agent tile or a Source Control tile. */
export type TileSnapshot =
  | TerminalTileSnapshot
  | WebTileSnapshot
  | ChatTileSnapshot
  | ScmTileSnapshot;

/** What the page saves of its workspace. */
export interface WorkspaceSnapshot {
  v: 1;
  /** The tile id counter (`t<seq>`), so a restored workspace never reuses an id. */
  seq: number;
  terminals: TerminalEntry[];
  mru: string[];
  /** The tile order (lib/workspace/tile-order.ts; absent in an older snapshot: the MRU). */
  order?: string[];
  layout: LayoutOptions;
  previousPattern: LayoutPattern | null;
  tiles: Record<string, TileSnapshot>;
  /** Tiled or free-form (absent in a snapshot saved before the free-form view: tiled). */
  view?: ViewMode;
  /** The free-form rects, z-order and maximized tile (kept while tiled too). */
  freeform?: FreeformState;
  /** The worktree a worktree workspace was opened for (lib/scm/worktrees.ts). */
  worktree?: WorktreeMark;
}

/** A terminal the backend handed to this window (desktop/terminal-sessions.ts `PtyReplay`). */
export interface JoinedPty extends FoldedReplay {
  id: string;
  cols: number;
  rows: number;
}

/** One terminal tile to rebuild. */
export interface RestoredTerminalTile {
  id: string;
  profile: TerminalProfile;
  home?: string;
  /** Its terminal, with the replay to redraw; absent when it is gone (the tile shows it ended). */
  pty?: JoinedPty;
}

/** One web tile to rebuild (its page is in its entry: nothing for the terminal manager). */
export interface RestoredWebTile {
  id: string;
  web: WebPage;
}

/** One agent tile to rebuild: its saved transcript (its session is in its entry). */
export interface RestoredChatTile {
  id: string;
  chat: AgentChat;
  rows: Row[];
}

/** One Source Control tile to rebuild (its repository is in its entry). */
export interface RestoredScmTile {
  id: string;
  scm: ScmTile;
}

/** One tile to rebuild. */
export type RestoredTile =
  | RestoredTerminalTile
  | RestoredWebTile
  | RestoredChatTile
  | RestoredScmTile;

/** How to rebuild a workspace. */
export interface RestorePlan {
  seq: number;
  terminals: TerminalEntry[];
  mru: string[];
  /** Every tile, in its place in the tile order. */
  order: string[];
  layout?: LayoutOptions;
  previousPattern: LayoutPattern | null;
  tiles: RestoredTile[];
  view: ViewMode;
  /** Only the rebuilt tiles' entries. */
  freeform: FreeformState;
  /** The worktree a worktree workspace was opened for. */
  worktree?: WorktreeMark;
}

/**
 * The snapshot of `state`, with the terminal manager's view of each terminal tile (a web tile
 * saves its page, from its entry; an agent tile its session and `chatRows`, capped).
 */
export function snapshotOf(
  state: WorkspaceState,
  seq: number,
  tile: (id: string) => TerminalTileSnapshot | undefined,
  chatRows: (id: string) => readonly Row[] = () => [],
): WorkspaceSnapshot {
  const tiles: Record<string, TileSnapshot> = {};
  for (const t of state.terminals) {
    const s = t.web
      ? { web: { ...t.web } }
      : t.chat
      ? { chat: { ...t.chat }, rows: savedRows(chatRows(t.id)) }
      : t.scm
      ? { scm: { ...t.scm } }
      : tile(t.id);
    if (s) tiles[t.id] = s;
  }
  return {
    v: 1,
    seq,
    // Activity is a "since you looked" hint: it starts clear when the workspace is shown again,
    // and a program's title comes back only if its replay sets it again.
    terminals: state.terminals.map(clearSignals),
    mru: [...state.mru],
    order: [...state.order],
    layout: { ...state.settings.layout },
    previousPattern: state.previousPattern,
    tiles,
    view: state.view,
    freeform: {
      rects: { ...state.freeform.rects },
      z: [...state.freeform.z],
      maximized: state.freeform.maximized,
    },
    ...(state.worktree ? { worktree: { ...state.worktree } } : {}),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A profile from storage: the right kind with the fields it needs, else `undefined`. */
function profileOf(v: unknown): TerminalProfile | undefined {
  if (!isObject(v)) return undefined;
  switch (v.kind) {
    case "shell":
      return v as unknown as TerminalProfile;
    case "agent":
      return typeof v.program === "string" && typeof v.name === "string"
        ? v as unknown as TerminalProfile
        : undefined;
    case "ssh":
      return isObject(v.target) && typeof v.label === "string"
        ? v as unknown as TerminalProfile
        : undefined;
    default:
      return undefined;
  }
}

/** A terminal entry from storage, or `undefined` when it is not one. */
function entryOf(v: unknown): TerminalEntry | undefined {
  if (!isObject(v) || typeof v.id !== "string" || typeof v.title !== "string") {
    return undefined;
  }
  const num = (x: unknown, d: number) =>
    typeof x === "number" && Number.isFinite(x) ? x : d;
  const { minimized: _m, zoom: _z, ...entry } = v as unknown as TerminalEntry;
  const zoom = sanitizeTileZoom(v.zoom);
  return {
    ...clearSignals(entry),
    // Its own zoom comes back with it (lib/workspace/tile-zoom.ts).
    ...(zoom !== undefined ? { zoom } : {}),
    createdAt: num(v.createdAt, 0),
    lastUsedAt: num(v.lastUsedAt, 0),
    exited: v.exited === true,
    exitCode: typeof v.exitCode === "number" ? v.exitCode : null,
    activity: false,
    // A minimized tile comes back minimized (in the switcher bar, its shell running).
    ...(v.minimized === true ? { minimized: true } : {}),
  };
}

/** One tile's snapshot from storage: a web page, or a terminal with a known profile. */
function tileSnapshotOf(t: unknown): TileSnapshot | undefined {
  if (!isObject(t)) return undefined;
  const web = sanitizeWebPage(t.web);
  if (web) return { web };
  const chat = sanitizeChat(t.chat);
  if (chat) return { chat, rows: sanitizeRows(t.rows) };
  const scm = t.scm === undefined ? undefined : sanitizeScmTile(t.scm);
  if (scm) return { scm };
  const profile = profileOf(t.profile);
  if (!profile) return undefined;
  return {
    ptyId: typeof t.ptyId === "string" ? t.ptyId : null,
    profile,
    ...(typeof t.home === "string" ? { home: t.home } : {}),
  };
}

/** The snapshot's parts, validated (`undefined` for anything that is not a v1 snapshot). */
function parseSnapshot(raw: unknown): WorkspaceSnapshot | undefined {
  if (!isObject(raw) || raw.v !== 1 || !Array.isArray(raw.terminals)) {
    return undefined;
  }
  const tiles: Record<string, TileSnapshot> = {};
  for (const [id, t] of Object.entries(isObject(raw.tiles) ? raw.tiles : {})) {
    const tile = tileSnapshotOf(t);
    if (tile) tiles[id] = tile;
  }
  const previous = raw.previousPattern;
  return {
    v: 1,
    seq: typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : 0,
    terminals: raw.terminals.map(entryOf).filter((e): e is TerminalEntry =>
      !!e
    ),
    mru: Array.isArray(raw.mru)
      ? raw.mru.filter((x) => typeof x === "string")
      : [],
    ...(Array.isArray(raw.order)
      ? { order: raw.order.filter((x) => typeof x === "string") }
      : {}),
    layout:
      (isObject(raw.layout) ? raw.layout : {}) as unknown as LayoutOptions,
    previousPattern: PATTERNS.includes(previous as LayoutPattern)
      ? previous as LayoutPattern
      : null,
    tiles,
    view: sanitizeViewMode(raw.view),
    freeform: raw.freeform as FreeformState | undefined,
    ...(worktreeMarkOf(raw) ? { worktree: worktreeMarkOf(raw) } : {}),
  };
}

/** The number in a `t<n>` tile id (0 for any other id). */
const seqOf = (id: string) => /^t(\d+)$/.exec(id)?.[1] ?? "0";

/**
 * How to rebuild a workspace from the page's last snapshot and the terminals the backend handed
 * over. Every tile whose PTY is there comes back on it (ended, with how it ended, if it ended
 * while detached); a tile whose PTY is gone comes back ended; a PTY no tile names (started just
 * before the window closed, after the last save) gets a tile of its own. `null`: nothing to
 * rebuild (a new workspace: the page opens its first shell).
 */
export function planRestore(
  raw: unknown,
  ptys: readonly JoinedPty[],
): RestorePlan | null {
  const snap = parseSnapshot(raw);
  if (!snap && ptys.length === 0) return null;
  const byId = new Map(ptys.map((p) => [p.id, p]));
  const claimed = new Set<string>();
  const terminals: TerminalEntry[] = [];
  const tiles: RestoredTile[] = [];
  for (const entry of snap?.terminals ?? []) {
    const tile = snap!.tiles[entry.id];
    if (!tile || terminals.some((t) => t.id === entry.id)) continue;
    if ("chat" in tile) {
      // An agent tile reopens on its session (attached, or resumed) under its saved transcript.
      const {
        ssh: _s,
        agent: _a,
        sandbox: _b,
        exitMessage: _m,
        web: _w,
        ...rest
      } = entry;
      terminals.push({
        ...rest,
        chat: tile.chat,
        exited: false,
        exitCode: null,
      });
      tiles.push({ id: entry.id, chat: tile.chat, rows: tile.rows });
      continue;
    }
    if ("scm" in tile) {
      // A Source Control tile shows its repository again; it has no PTY either.
      const {
        ssh: _s,
        agent: _a,
        sandbox: _b,
        exitMessage: _m,
        chat: _c,
        web: _w,
        ...rest
      } = entry;
      terminals.push({
        ...rest,
        scm: tile.scm,
        title: scmTitle(tile.scm),
        exited: false,
        exitCode: null,
      });
      tiles.push({ id: entry.id, scm: tile.scm });
      continue;
    }
    if ("web" in tile) {
      // A web tile reopens at its last page; it has no PTY, so it never ended.
      const {
        ssh: _s,
        agent: _a,
        sandbox: _b,
        exitMessage: _m,
        chat: _c,
        zoom: _z,
        ...rest
      } = entry;
      terminals.push({
        ...rest,
        web: tile.web,
        title: webTitle(tile.web),
        exited: false,
        exitCode: null,
      });
      tiles.push({ id: entry.id, web: tile.web });
      continue;
    }
    const pty = tile.ptyId !== null ? byId.get(tile.ptyId) : undefined;
    if (pty) claimed.add(pty.id);
    const exit = pty ? pty.exit : undefined;
    // A terminal's entry never carries a page (a web tile is known by its tile snapshot).
    const { web: _web, chat: _chat, scm: _scm, ...term } = entry;
    terminals.push(
      pty && !exit ? { ...term, exited: false, exitCode: null } : {
        ...term,
        exited: true,
        exitCode: exit?.exitCode ?? entry.exitCode,
        exitSignal: exit?.signal ?? entry.exitSignal ?? null,
      },
    );
    tiles.push({
      id: entry.id,
      profile: tile.profile,
      ...(tile.home !== undefined ? { home: tile.home } : {}),
      ...(pty ? { pty } : {}),
    });
  }
  let seq = Math.max(
    snap?.seq ?? 0,
    ...terminals.map((t) => Number(seqOf(t.id))),
  );
  const now = Date.now();
  for (const pty of ptys) {
    if (claimed.has(pty.id)) continue;
    const id = `t${++seq}`;
    terminals.push({
      id,
      title: "shell",
      createdAt: now,
      lastUsedAt: now,
      exited: pty.exit !== undefined,
      exitCode: pty.exit?.exitCode ?? null,
      activity: false,
    });
    tiles.push({ id, profile: SHELL_PROFILE, pty });
  }
  const ids = new Set(terminals.map((t) => t.id));
  const mru = [...new Set(snap?.mru ?? [])].filter((id) => ids.has(id));
  for (const t of terminals) if (!mru.includes(t.id)) mru.push(t.id);
  if (terminals.length === 0) return null;
  return {
    seq,
    terminals,
    mru,
    order: sanitizeOrder(snap?.order, mru),
    ...(snap ? { layout: snap.layout } : {}),
    previousPattern: snap?.previousPattern ?? null,
    tiles,
    view: snap?.view ?? "tiled",
    freeform: sanitizeFreeform(snap?.freeform, ids),
    ...(snap?.worktree ? { worktree: snap.worktree } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// A tile moving to another window (desktop/tile-move.ts)
// ---------------------------------------------------------------------------------------------

/**
 * A tile on its way to another window: its entry (title, SSH / agent / sandbox marks, how it
 * ended) and its snapshot (its PTY and profile, or its page). The window it lands in gives it an id
 * of its own.
 */
export interface MovedTile {
  entry: TerminalEntry;
  tile: TileSnapshot;
  /** Its size in the window it left (a free-form drop keeps it). */
  size?: { w: number; h: number };
}

/** The most a moved tile may weigh as JSON (its entry and profile: well under a KiB in practice). */
const MAX_MOVED_TILE_CHARS = 32 * 1024;

/**
 * A moved tile from a page (untrusted): validated, or `undefined`. A web tile keeps its page in
 * its entry; a terminal's entry never carries one; neither arrives minimized.
 */
export function movedTileOf(raw: unknown): MovedTile | undefined {
  if (!isObject(raw)) return undefined;
  try {
    if (JSON.stringify(raw).length > MAX_MOVED_TILE_CHARS) return undefined;
  } catch {
    return undefined;
  }
  const entry = entryOf(raw.entry);
  const tile = tileSnapshotOf(raw.tile);
  // An agent tile's session belongs to its window's hub: it does not move.
  if (!entry || !tile || "chat" in tile || entry.chat) return undefined;
  const { minimized: _m, web: _w, scm: _c, ...rest } = entry;
  const size = isObject(raw.size) && isSize(raw.size.w) && isSize(raw.size.h)
    ? { size: { w: Math.round(raw.size.w), h: Math.round(raw.size.h) } }
    : {};
  return {
    entry: "web" in tile
      ? { ...rest, web: tile.web }
      : "scm" in tile
      ? { ...rest, scm: tile.scm }
      : rest,
    tile,
    ...size,
  };
}

const isSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Whether snapshot `raw` has tile `id`. */
export function snapshotHasTile(raw: unknown, id: string): boolean {
  return isObject(raw) && isObject(raw.tiles) && id in raw.tiles;
}

/**
 * Snapshot `raw` without tile `id` (it moved to another window): its entry, its place in the MRU
 * and tile orders, its tile and its free-form geometry. Anything that is not a v1 snapshot is
 * returned as it is.
 */
export function withoutTile(raw: unknown, id: string): unknown {
  if (!isObject(raw) || raw.v !== 1) return raw;
  const drop = (v: unknown) => Array.isArray(v) ? v.filter((x) => x !== id) : v;
  const out: Record<string, unknown> = {
    ...raw,
    terminals: Array.isArray(raw.terminals)
      ? raw.terminals.filter((t) => !(isObject(t) && t.id === id))
      : raw.terminals,
    mru: drop(raw.mru),
  };
  if (raw.order !== undefined) out.order = drop(raw.order);
  if (isObject(raw.tiles)) {
    const { [id]: _gone, ...tiles } = raw.tiles;
    out.tiles = tiles;
  }
  if (isObject(raw.freeform)) {
    const ff = raw.freeform;
    const rects = isObject(ff.rects) ? { ...ff.rects } : ff.rects;
    if (isObject(rects)) delete rects[id];
    out.freeform = {
      ...ff,
      rects,
      z: drop(ff.z),
      maximized: ff.maximized === id ? null : ff.maximized,
    };
  }
  return out;
}

/**
 * Snapshot `raw` with the tiles that moved into its workspace while no page took them (the page
 * was loading, or reloaded before it saved them): each gets the next `t<n>` id and is the most
 * recent tile, so the window shows it focused. A workspace with no snapshot yet (a window torn off
 * for the tile) gets one with only them (its layout and view are the page's own).
 */
export function withArrivals(
  raw: unknown,
  arrivals: readonly MovedTile[],
): unknown {
  if (arrivals.length === 0) return raw;
  const snap = parseSnapshot(raw);
  const base: Record<string, unknown> = isObject(raw) && snap
    ? { ...raw }
    : { v: 1, previousPattern: null };
  const terminals = [...(snap?.terminals ?? [])];
  const tiles: Record<string, TileSnapshot> = { ...(snap?.tiles ?? {}) };
  const order = [...(snap?.order ?? snap?.mru ?? [])];
  let mru = [...(snap?.mru ?? [])];
  let seq = Math.max(
    snap?.seq ?? 0,
    ...terminals.map((t) => Number(seqOf(t.id))),
  );
  for (const a of arrivals) {
    const id = `t${++seq}`;
    terminals.push({ ...clearSignals(a.entry), id });
    tiles[id] = a.tile;
    mru = [id, ...mru];
    order.push(id);
  }
  return { ...base, seq, terminals, mru, order, tiles };
}

// ---------------------------------------------------------------------------------------------
// The layout per workspace, across launches
// ---------------------------------------------------------------------------------------------

/** The localStorage key of workspace `id`'s layout. */
export function workspaceLayoutKey(id: string): string {
  return `qutty.workspace.${id}.v1`;
}

/** What is kept of a workspace across launches. */
export interface StoredWorkspaceLayout {
  layout: Partial<LayoutOptions>;
  previousPattern: LayoutPattern | null;
  /** Its view (absent: tiled). Free-form rects are not kept: the next launch's tiles are new. */
  view?: ViewMode;
}

/** Workspace `id`'s layout from an earlier launch, or `null`. */
export function loadWorkspaceLayout(
  id: string,
  storage: SettingsStorage | null | undefined,
): StoredWorkspaceLayout | null {
  try {
    const raw = storage?.getItem(workspaceLayoutKey(id));
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!isObject(v) || !isObject(v.layout)) return null;
    return {
      layout: v.layout as Partial<LayoutOptions>,
      previousPattern: PATTERNS.includes(v.previousPattern as LayoutPattern)
        ? v.previousPattern as LayoutPattern
        : null,
      view: sanitizeViewMode(v.view),
    };
  } catch {
    return null;
  }
}

/** Keep workspace `id`'s layout for the next launch (failures are swallowed). */
export function saveWorkspaceLayout(
  id: string,
  value: StoredWorkspaceLayout,
  storage: SettingsStorage | null | undefined,
): void {
  try {
    storage?.setItem(workspaceLayoutKey(id), JSON.stringify(value));
  } catch { /* private mode, quota */ }
}
