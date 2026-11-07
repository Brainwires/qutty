/**
 * The hub's tile registry: one entry per PTY, with a unique name agents address each other by.
 * A tile gets a default name from its harness (`claude`, `claude-2`) or `shell-<n>`; an agent
 * renames itself with `set_name`. Names are matched case-insensitively and may not collide with
 * a tile id, another name, or the reserved addresses (`companion`, `all`, `user`).
 *
 * @module
 */

import {
  BROADCAST,
  COMPANION,
  type TileInfo,
  type TileStatus,
  USER,
} from "./protocol.ts";

/** The longest name `set_name` accepts. */
const MAX_NAME = 40;
const RESERVED = new Set([COMPANION, BROADCAST, USER]);

/** Why a name is unusable, or `null` when it is fine (uniqueness is checked separately). */
export function nameProblem(name: string): string | null {
  if (name.length === 0 || name.length > MAX_NAME) {
    return `a name has 1 to ${MAX_NAME} characters`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return "a name uses letters, digits, '.', '_' and '-' (starting with a letter or digit)";
  }
  if (RESERVED.has(name.toLowerCase())) return `"${name}" is reserved`;
  if (/^pty-\d+$/i.test(name)) return "a name cannot look like a tile id";
  return null;
}

/** What a new tile starts with. */
export interface TileSeed {
  id: string;
  harness?: string;
  /** The Ollama model it was launched on. */
  model?: string;
  label?: string;
  cwd?: string;
  /** It runs in the window's shared Docker sandbox. */
  sandbox?: boolean;
}

/** The tiles, keyed by id. */
export class Registry {
  #tiles = new Map<string, TileInfo>();
  /** Tiles whose name is still the default (renamed when their harness becomes known). */
  #defaultNamed = new Set<string>();
  #onChange: () => void;

  /** @param onChange Called after every change (the page's badges re-render from a snapshot). */
  constructor(onChange: () => void = () => {}) {
    this.#onChange = onChange;
  }

  add(seed: TileSeed): TileInfo {
    const tile: TileInfo = {
      id: seed.id,
      name: this.#freeName(
        seed.harness ?? `shell-${seed.id.replace(/\D/g, "")}`,
      ),
      status: "idle",
      unread: 0,
      ...(seed.harness ? { harness: seed.harness } : {}),
      ...(seed.model ? { model: seed.model } : {}),
      ...(seed.label ? { label: seed.label } : {}),
      ...(seed.cwd ? { cwd: seed.cwd } : {}),
      ...(seed.sandbox ? { sandbox: true } : {}),
    };
    this.#tiles.set(tile.id, tile);
    this.#defaultNamed.add(tile.id);
    this.#onChange();
    return { ...tile };
  }

  remove(id: string): boolean {
    this.#defaultNamed.delete(id);
    const had = this.#tiles.delete(id);
    if (had) this.#onChange();
    return had;
  }

  get(id: string): TileInfo | undefined {
    const t = this.#tiles.get(id);
    return t ? { ...t } : undefined;
  }

  /** Every tile, in creation order. */
  list(): TileInfo[] {
    return [...this.#tiles.values()].map((t) => ({ ...t }));
  }

  /** The tile `target` names: an id, or a name (case-insensitive). */
  resolve(target: string): TileInfo | undefined {
    const byId = this.#tiles.get(target);
    if (byId) return { ...byId };
    const lower = target.toLowerCase();
    for (const t of this.#tiles.values()) {
      if (t.name.toLowerCase() === lower) return { ...t };
    }
    return undefined;
  }

  /** Rename `id`; throws an Error with the reason when the name is unusable or taken. */
  rename(id: string, name: string): TileInfo {
    const tile = this.#require(id);
    const problem = nameProblem(name);
    if (problem) throw new Error(problem);
    const owner = this.resolve(name);
    if (owner && owner.id !== id) {
      throw new Error(`"${name}" is already the name of ${owner.id}`);
    }
    tile.name = name;
    this.#defaultNamed.delete(id);
    this.#onChange();
    return { ...tile };
  }

  /**
   * Record the tile's harness (a hook or the MCP handshake said who it is). A tile still on its
   * default name takes the harness's name.
   */
  setHarness(id: string, harness: string): void {
    const tile = this.#tiles.get(id);
    if (!tile || tile.harness === harness) return;
    tile.harness = harness;
    if (this.#defaultNamed.has(id)) tile.name = this.#freeName(harness, id);
    this.#onChange();
  }

  /** A new status; `note` (from `set_status`) says how it went, and any other change clears it. */
  setStatus(id: string, status: TileStatus, note?: string): void {
    const tile = this.#tiles.get(id);
    if (!tile || (tile.status === status && tile.note === note)) return;
    tile.status = status;
    if (note === undefined) delete tile.note;
    else tile.note = note;
    this.#onChange();
  }

  setUnread(id: string, unread: number): void {
    this.#patch(id, { unread });
  }

  /** The harness's session id (`undefined`: none, e.g. a new session that sent no id). */
  setSession(id: string, session: string | undefined): void {
    const tile = this.#tiles.get(id);
    if (!tile || tile.session === session) return;
    if (session === undefined) delete tile.session;
    else tile.session = session;
    this.#onChange();
  }

  /** The page's title or a new working directory. */
  setMeta(id: string, meta: { label?: string; cwd?: string }): void {
    const patch: Partial<TileInfo> = {};
    if (meta.label !== undefined) patch.label = meta.label;
    if (meta.cwd !== undefined) patch.cwd = meta.cwd;
    this.#patch(id, patch);
  }

  #patch(id: string, patch: Partial<TileInfo>): void {
    const tile = this.#tiles.get(id);
    if (!tile) return;
    const changed = (Object.keys(patch) as (keyof TileInfo)[]).some((k) =>
      tile[k] !== patch[k]
    );
    if (!changed) return;
    Object.assign(tile, patch);
    this.#onChange();
  }

  #require(id: string): TileInfo {
    const tile = this.#tiles.get(id);
    if (!tile) throw new Error(`no such tile: ${id}`);
    return tile;
  }

  /** `base`, or `base-2`, `base-3`… — the first one no other tile (than `self`) uses. */
  #freeName(base: string, self?: string): string {
    const clean =
      base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "")
        .slice(0, MAX_NAME - 4) || "tile";
    const taken = (n: string) => {
      const t = this.resolve(n);
      return (t !== undefined && t.id !== self) || nameProblem(n) !== null;
    };
    if (!taken(clean)) return clean;
    for (let i = 2;; i++) {
      if (!taken(`${clean}-${i}`)) return `${clean}-${i}`;
    }
  }
}
