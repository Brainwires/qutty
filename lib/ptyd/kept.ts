/**
 * What a quit that keeps the shells running leaves for the next launch, and how that launch reads
 * it (desktop/kept-shells.ts): the workspaces (their page snapshots) and, per terminal, its
 * program, folder and size.
 *
 * The same record goes two places: to the PTY daemon (its `state`, read back at the next launch,
 * which reattaches every tile to its running shell), and to a file in the app's folder for when
 * the daemon is gone by then (a reboot): the shell tiles then start afresh in their last folder,
 * their old text shown dimmed above the new prompt ({@linkcode respawnPlan}).
 *
 * Pure, so it is tested without a daemon (tests/kept_shells_test.ts).
 *
 * @module
 */

/** The record's version. */
export const KEPT_VERSION = 1;

/** One kept terminal. */
export interface KeptTerminal {
  ptyId: string;
  /** The program (its path). */
  shell: string;
  /** Its folder at the quit (the foreground process's, else the shell's), when known. */
  cwd?: string;
  cols: number;
  rows: number;
  /** Its recent text, plain (only in the file: the daemon has the real replay). */
  history?: string;
}

/** One kept workspace. */
export interface KeptWorkspaceRecord {
  id: string;
  name: string;
  /** The page's snapshot (lib/workspace/session.ts `WorkspaceSnapshot`). */
  snapshot: unknown;
  terms: KeptTerminal[];
}

/** The whole record. */
export interface KeptRecord {
  v: typeof KEPT_VERSION;
  /** When it was written (ms since the epoch). */
  savedAt: number;
  workspaces: KeptWorkspaceRecord[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const dim = (v: unknown) =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 10_000
    ? v as number
    : undefined;

function termOf(v: unknown): KeptTerminal | undefined {
  if (!isObject(v) || typeof v.ptyId !== "string") return undefined;
  if (typeof v.shell !== "string") return undefined;
  const cols = dim(v.cols);
  const rows = dim(v.rows);
  if (cols === undefined || rows === undefined) return undefined;
  return {
    ptyId: v.ptyId,
    shell: v.shell,
    ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
    cols,
    rows,
    ...(typeof v.history === "string" ? { history: v.history } : {}),
  };
}

/** A record from the daemon or the file, checked (`undefined` when it is not one). */
export function parseKept(raw: unknown): KeptRecord | undefined {
  if (
    !isObject(raw) || raw.v !== KEPT_VERSION || !Array.isArray(raw.workspaces)
  ) {
    return undefined;
  }
  const workspaces: KeptWorkspaceRecord[] = [];
  for (const w of raw.workspaces) {
    if (
      !isObject(w) || typeof w.id !== "string" || typeof w.name !== "string"
    ) {
      continue;
    }
    const terms = Array.isArray(w.terms)
      ? w.terms.map(termOf).filter((t): t is KeptTerminal => t !== undefined)
      : [];
    workspaces.push({
      id: w.id,
      name: w.name,
      snapshot: w.snapshot ?? null,
      terms,
    });
  }
  return {
    v: KEPT_VERSION,
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
    workspaces,
  };
}

/** One shell to start again in place of a kept one that is gone (the daemon did not survive). */
export interface ShellRespawn {
  /** The tile's old PTY id (its snapshot names it). */
  ptyId: string;
  /** The shell: the tile's picked one, else the one that ran (the default shell then). */
  shell: string;
  cwd?: string;
  cols: number;
  rows: number;
  history: string;
}

/** The snapshot's tiles (`{ [tileId]: { ptyId, profile } }`), loosely. */
function tilesOf(snapshot: unknown): Record<string, unknown> {
  return isObject(snapshot) && isObject(snapshot.tiles) ? snapshot.tiles : {};
}

/**
 * Which of a kept workspace's terminals start again when the daemon is gone: the plain shell tiles
 * (not an agent, not ssh, not sandboxed), in their last folder, with their history. Other tiles
 * come back as ended (their command is not rerun behind the user's back).
 */
export function respawnPlan(ws: KeptWorkspaceRecord): ShellRespawn[] {
  const byPty = new Map(ws.terms.map((t) => [t.ptyId, t]));
  const out: ShellRespawn[] = [];
  for (const tile of Object.values(tilesOf(ws.snapshot))) {
    if (!isObject(tile) || typeof tile.ptyId !== "string") continue;
    const profile = isObject(tile.profile) ? tile.profile : undefined;
    if (profile?.kind !== "shell" || profile.sandbox === true) continue;
    const term = byPty.get(tile.ptyId);
    if (!term) continue;
    out.push({
      ptyId: term.ptyId,
      shell: typeof profile.shell === "string" ? profile.shell : term.shell,
      ...(term.cwd !== undefined ? { cwd: term.cwd } : {}),
      cols: term.cols,
      rows: term.rows,
      history: term.history ?? "",
    });
  }
  return out;
}

/**
 * `snapshot` with each tile's PTY id mapped through `ptys` (old → new); a tile whose old PTY is
 * not in the map keeps it (it is gone: the tile comes back ended).
 */
export function retarget(
  snapshot: unknown,
  ptys: ReadonlyMap<string, string>,
): unknown {
  if (!isObject(snapshot) || !isObject(snapshot.tiles)) return snapshot;
  const tiles: Record<string, unknown> = {};
  for (const [id, tile] of Object.entries(snapshot.tiles)) {
    const next = isObject(tile) && typeof tile.ptyId === "string"
      ? ptys.get(tile.ptyId)
      : undefined;
    tiles[id] = next !== undefined && isObject(tile)
      ? { ...tile, ptyId: next }
      : tile;
  }
  return { ...snapshot, tiles };
}
