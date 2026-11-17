/**
 * Web tiles in the hub's registry. A web tile lives in a window's page (app/use-web-control.ts),
 * which reports its web tiles whenever they change: the page's own tile id (`t7`), the URL and
 * the title. Page ids are per page, so two windows may both have a `t7`: the hub keys each by
 * its owner (the workspace the reporting window shows; `demo` in the browser demo) and gives it
 * an id of its own, `web-<n>`, plus a default name (`browser`, `browser-2`). Agents see web tiles
 * in `list_peers` with `kind: "web"`, their URL, and their title as the label.
 *
 * Client-safe (the browser demo's hub, lib/hub-demo.ts, uses it too).
 *
 * @module
 */

import type { Registry } from "./registry.ts";
import type { TileInfo } from "./protocol.ts";

/** One web tile as its page reports it. */
export interface WebTileReport {
  /** The page's tile id (`t7`). */
  id: string;
  url: string;
  title?: string;
}

/** Where a web tile lives: its owner (a workspace) and the page's id for it. */
export interface WebTilePlace {
  owner: string;
  local: string;
}

/** The longest title kept as a web tile's label. */
const MAX_LABEL = 200;

/** The web tiles of every owner, mirrored into `registry`. */
export class WebTiles {
  readonly #registry: Registry;
  readonly #onRemove: (id: string) => void;
  readonly #byPlace = new Map<string, string>();
  readonly #places = new Map<string, WebTilePlace>();
  #next = 0;

  /**
   * @param registry Where the web tiles are listed.
   * @param onRemove A web tile went (the hub drops its mailbox; default: it leaves the registry).
   */
  constructor(
    registry: Registry,
    onRemove: (id: string) => void = (id) => registry.remove(id),
  ) {
    this.#registry = registry;
    this.#onRemove = onRemove;
  }

  /** `owner`'s web tiles are now exactly `tiles`: new ones are added, gone ones removed. */
  sync(owner: string, tiles: readonly WebTileReport[]): void {
    const keep = new Set<string>();
    for (const t of tiles) keep.add(this.ensure(owner, t).id);
    for (const [id, place] of [...this.#places]) {
      if (place.owner === owner && !keep.has(id)) this.#drop(id);
    }
  }

  /** The hub's tile for `owner`'s page tile `report.id` (added when new, else updated). */
  ensure(owner: string, report: WebTileReport): TileInfo {
    const key = `${owner}\u0000${report.id}`;
    const label = report.title?.slice(0, MAX_LABEL);
    let id = this.#byPlace.get(key);
    if (id === undefined || !this.#registry.get(id)) {
      id = `web-${++this.#next}`;
      this.#byPlace.set(key, id);
      this.#places.set(id, { owner, local: report.id });
      return this.#registry.add({
        id,
        kind: "web",
        url: report.url,
        ...(label ? { label } : {}),
      });
    }
    this.#registry.setMeta(id, {
      url: report.url,
      ...(label !== undefined ? { label } : {}),
    });
    return this.#registry.get(id)!;
  }

  /** Where web tile `id` lives (`undefined`: it is not a web tile). */
  place(id: string): WebTilePlace | undefined {
    const p = this.#places.get(id);
    return p ? { ...p } : undefined;
  }

  #drop(id: string): void {
    const place = this.#places.get(id);
    if (!place) return;
    this.#places.delete(id);
    this.#byPlace.delete(`${place.owner}\u0000${place.local}`);
    this.#onRemove(id);
  }
}
