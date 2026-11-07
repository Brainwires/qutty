/**
 * The page's side of detachable sessions: the snapshot of a workspace it saves in the app's
 * process (desktop/session.ts) as it changes, and the plan to rebuild it when a window shows the
 * workspace again — after its window was closed and reopened, or after a page reload. A snapshot
 * maps each tile to its PTY (and what it runs), so every terminal comes back in its own tile with
 * the layout, MRU order and focus it had. Pure, so it is tested without a DOM
 * (tests/workspace_session_test.ts).
 *
 * @module
 */

import type { LayoutOptions, LayoutPattern } from "../layout/mod.ts";
import { SHELL_PROFILE, type TerminalProfile } from "../ssh-ui.ts";
import type { FoldedReplay } from "./replay.ts";
import { PATTERNS, type TerminalEntry, type WorkspaceState } from "./store.ts";

/** One tile's terminal: its PTY now (`null` while none runs), what it runs, its home folder. */
export interface TileSnapshot {
  ptyId: string | null;
  profile: TerminalProfile;
  home?: string;
}

/** What the page saves of its workspace. */
export interface WorkspaceSnapshot {
  v: 1;
  /** The tile id counter (`t<seq>`), so a restored workspace never reuses an id. */
  seq: number;
  terminals: TerminalEntry[];
  mru: string[];
  layout: LayoutOptions;
  previousPattern: LayoutPattern | null;
  tiles: Record<string, TileSnapshot>;
}

/** A terminal the backend handed to this window (desktop/terminal-sessions.ts `PtyReplay`). */
export interface JoinedPty extends FoldedReplay {
  id: string;
  cols: number;
  rows: number;
}

/** One tile to rebuild. */
export interface RestoredTile {
  id: string;
  profile: TerminalProfile;
  home?: string;
  /** Its terminal, with the replay to redraw; absent when it is gone (the tile shows it ended). */
  pty?: JoinedPty;
}

/** How to rebuild a workspace. */
export interface RestorePlan {
  seq: number;
  terminals: TerminalEntry[];
  mru: string[];
  layout?: LayoutOptions;
  previousPattern: LayoutPattern | null;
  tiles: RestoredTile[];
}

/** The snapshot of `state`, with the terminal manager's view of each tile. */
export function snapshotOf(
  state: WorkspaceState,
  seq: number,
  tile: (id: string) => TileSnapshot | undefined,
): WorkspaceSnapshot {
  const tiles: Record<string, TileSnapshot> = {};
  for (const t of state.terminals) {
    const s = tile(t.id);
    if (s) tiles[t.id] = s;
  }
  return {
    v: 1,
    seq,
    // Activity is a "since you looked" hint: it starts clear when the workspace is shown again.
    terminals: state.terminals.map((t) => ({ ...t, activity: false })),
    mru: [...state.mru],
    layout: { ...state.settings.layout },
    previousPattern: state.previousPattern,
    tiles,
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
  return {
    ...(v as unknown as TerminalEntry),
    createdAt: num(v.createdAt, 0),
    lastUsedAt: num(v.lastUsedAt, 0),
    exited: v.exited === true,
    exitCode: typeof v.exitCode === "number" ? v.exitCode : null,
    activity: false,
  };
}

/** The snapshot's parts, validated (`undefined` for anything that is not a v1 snapshot). */
function parseSnapshot(raw: unknown): WorkspaceSnapshot | undefined {
  if (!isObject(raw) || raw.v !== 1 || !Array.isArray(raw.terminals)) {
    return undefined;
  }
  const tiles: Record<string, TileSnapshot> = {};
  for (const [id, t] of Object.entries(isObject(raw.tiles) ? raw.tiles : {})) {
    const profile = isObject(t) ? profileOf(t.profile) : undefined;
    if (!profile || !isObject(t)) continue;
    tiles[id] = {
      ptyId: typeof t.ptyId === "string" ? t.ptyId : null,
      profile,
      ...(typeof t.home === "string" ? { home: t.home } : {}),
    };
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
    layout:
      (isObject(raw.layout) ? raw.layout : {}) as unknown as LayoutOptions,
    previousPattern: PATTERNS.includes(previous as LayoutPattern)
      ? previous as LayoutPattern
      : null,
    tiles,
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
    const pty = tile.ptyId !== null ? byId.get(tile.ptyId) : undefined;
    if (pty) claimed.add(pty.id);
    const exit = pty ? pty.exit : undefined;
    terminals.push(
      pty && !exit ? { ...entry, exited: false, exitCode: null } : {
        ...entry,
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
    ...(snap ? { layout: snap.layout } : {}),
    previousPattern: snap?.previousPattern ?? null,
    tiles,
  };
}
