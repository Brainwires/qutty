// A tile moving from one window to another, in the app's process (TODO.md, "New Window"). The PTY
// lives here, so a terminal tile's move only changes its owner: its workspace (desktop/workspace-host.ts)
// and the window its events go to (`TerminalSessions.handOver`, denext's owned resources). The
// shell keeps running, and the window it lands in redraws it from its replay ring. A web tile moves
// as its page (its URL and title): it loads again in the other window. The hub knows a tile by
// its PTY id (`QUTTY_SOCK`, `QUTTY_TILE_ID`), which does not change, so agents' `list_peers` and
// messages follow the tile; an agent's question goes to the window that shows it now.
//
// Both snapshots change in one synchronous step: the tile leaves the source workspace's snapshot
// and waits in the target's as an arrival until the target's page saves it (`ackArrivals`). So a
// page that reloads, or a window that closes, in the middle finds the tile in exactly one
// workspace: a page joining takes its workspace's arrivals into its snapshot, and a late save from
// the source page that still has the tile drops it (`departures`).
//
// The gesture (app/use-tile-move.ts): a header dragged out of its window asks `dragOver` with the
// pointer's screen position while it is outside; the window under it (Denext's window frames,
// front to back by the most recent focus: Denext has no z-order) is told (`dragHover`, so it
// highlights where the tile would land) and the one left is told it was left. Released over a
// window, the tile moves there; released over no window of the app, it tears off into a new
// window there (`openWindow` at a position), unless it is the source window's only tile (then
// nothing happens). The tile header's menu moves it by name ("Move to Window"), or to a new window.
//
// The last tile leaving its window closes that window, and its workspace is ended once closed (as
// "Close Window and End Its Shells" does; it has no terminals left). A sandboxed terminal keeps
// running in the container of the workspace it started in, which stays up until it goes
// (`WorkspaceRegistry.onRetired`).
//
// Events (the `session` extension's; one-shot, to one window): `tileArrived` `{ move }` (the target
// page pulls its arrivals: `arrivals`), `tileLeft` `{ tile, move }` (the source page drops the
// tile), `dragHover` `{ from, title, x, y }` or `{ from, leave: true }`.

import type { DesktopOpenWindowOptions } from "denext/desktop";
import { objectSchema, str } from "./schema.ts";
import type { WorkspaceRegistry } from "./workspace-host.ts";
import type { PtyReplay, TerminalSessions } from "./terminal-sessions.ts";
import {
  type MovedTile,
  movedTileOf,
  withoutTile,
} from "../lib/workspace/session.ts";
import {
  type Frame,
  moveId,
  screenOffset,
  type ScreenPoint,
  tearOffFrame,
  windowAt,
  type WindowFrame,
} from "../lib/workspace/tile-move.ts";
import { newWorkspaceId, workspaceWindow } from "../lib/workspace/windows.ts";

/** Another window a tile can move to (the header menu's "Move to Window"). */
export interface MoveTarget {
  /** Its window id. */
  window: string;
  /** Its workspace's id and name (the window's title is `Qutty — <name>`). */
  workspace: string;
  name: string;
}

/** Where a page asks a tile to go. */
export type MoveDestination =
  /** That window (the menu). */
  | { window: string }
  /** Wherever the pointer was released (screen coordinates; the source page's viewport origin). */
  | { screen: ScreenPoint; origin: ScreenPoint }
  /** A new window: at the pointer when given, else where Denext puts a new window. */
  | { newWindow: true; screen?: ScreenPoint; origin?: ScreenPoint };

/** What a page asks for to move one of its tiles. */
export interface MoveRequest {
  /** The tile's id in the source window. */
  tileId: string;
  /** The tile (lib/workspace/session.ts `MovedTile`; validated here). */
  tile: unknown;
  to: MoveDestination;
  /** It is the source window's only tile: the window closes after it leaves. */
  last: boolean;
  /** The source window's size (a torn-off window opens at it). */
  size?: { width: number; height: number };
}

/** What a move answers. */
export type MoveResult =
  | { moved: true; move: string; window: string; created: boolean }
  | {
    moved: false;
    /** `last`: the only tile would tear off (nothing to do); else why it could not move. */
    reason: "last" | "invalid" | "no-window" | "not-owner" | "open-failed";
  };

/** A tile waiting in a window, as its page pulls it (`arrivals`). */
export interface TileArrival {
  move: string;
  tile: MovedTile;
  /** Where it was dropped (the page's CSS px); absent: the menu. */
  at?: { x: number; y: number };
  /** Its terminal, handed to this window with its replay (absent: a web tile, or it is gone). */
  pty?: PtyReplay;
}

/** What a page sends while a dragged tile is outside its window. */
export interface DragOver {
  screen: ScreenPoint;
  origin: ScreenPoint;
  /** The tile's title (the target shows it). */
  title: string;
}

/** What the window under a dragged tile hears (`dragHover`). */
export type DragHover =
  | { from: string; title: string; x: number; y: number }
  | { from: string; leave: true };

/** What a pending arrival keeps. */
interface Pending {
  tile: MovedTile;
  at?: { x: number; y: number };
}

/** What the mover acts through: the registry, the terminals, the host's windows and events. */
export interface TileMoveDeps {
  workspaces: WorkspaceRegistry;
  sessions: Pick<TerminalSessions, "handOver" | "ownerOf">;
  /** A one-shot event to one window's page (`host.emit(event, data, { window, retain: false })`). */
  emit(event: string, data: unknown, window: string): void;
  /** The open windows (`host.windows()`). */
  windows(): readonly { id: string; kind: string; key?: string }[];
  /** A window's frame on screen, `null` where the runtime cannot say. */
  bounds(id: string): Frame | null;
  /** Open a window (`host.openWindow`); throws when it cannot. */
  openWindow(options: DesktopOpenWindowOptions): { id: string };
  /** Close a window for good, without its page's close guard. */
  closeWindow(id: string): void;
  newWorkspaceId?: () => string;
  now?: () => number;
}

/** Moves tiles between windows (one per app; the `session` extension's). */
export class TileMover {
  readonly #d: TileMoveDeps;
  #moves = 0;
  /** Each dragging window's hovered window. */
  readonly #hover = new Map<string, string>();

  constructor(deps: TileMoveDeps) {
    this.#d = deps;
  }

  /** The other windows window `from` can move a tile to, most recently focused first. */
  targets(from: string): MoveTarget[] {
    const ws = this.#d.workspaces;
    const names = new Map(ws.list().map((w) => [w.id, w.name]));
    return this.#others(from).flatMap((window) => {
      const workspace = ws.workspaceOfWindow(window);
      return workspace === undefined
        ? []
        : [{ window, workspace, name: names.get(workspace) ?? workspace }];
    });
  }

  /**
   * The windows other than `from` that show a workspace: the most recently focused first (the
   * best guess at the front one where windows overlap), then the rest.
   */
  #others(from: string): string[] {
    const ws = this.#d.workspaces;
    const open = this.#d.windows().filter((w) =>
      w.kind !== "panel" && w.id !== from &&
      ws.workspaceOfWindow(w.id) !== undefined
    ).map((w) => w.id);
    const focus = ws.focusOrder().filter((w) => open.includes(w));
    return [...focus, ...open.filter((w) => !focus.includes(w))];
  }

  #frames(from: string): WindowFrame[] {
    return this.#others(from).flatMap((id) => {
      const bounds = this.#d.bounds(id);
      return bounds ? [{ id, bounds }] : [];
    });
  }

  /** The window under screen point `p` from window `from`'s drag, and the point in it. */
  #hit(from: string, p: ScreenPoint, origin: ScreenPoint) {
    const offset = screenOffset(origin, this.#d.bounds(from));
    return { hit: windowAt(this.#frames(from), p, offset), offset };
  }

  /**
   * A tile of window `from` is dragged outside it: the window under the pointer is told where (and
   * the one it left, that it was left). Returns the window under it (`null`: none).
   */
  dragOver(from: string, over: DragOver): { target: string | null } {
    const { hit } = this.#hit(from, over.screen, over.origin);
    const before = this.#hover.get(from);
    if (before !== undefined && before !== hit?.id) this.#leave(from);
    if (hit) {
      this.#hover.set(from, hit.id);
      const event: DragHover = {
        from,
        title: String(over.title).slice(0, 200),
        x: hit.x,
        y: hit.y,
      };
      this.#d.emit("dragHover", event, hit.id);
    }
    return { target: hit?.id ?? null };
  }

  /** Window `from`'s drag ended (dropped, cancelled, back inside): the hovered window is told. */
  dragEnd(from: string): void {
    this.#leave(from);
  }

  #leave(from: string): void {
    const target = this.#hover.get(from);
    this.#hover.delete(from);
    if (target === undefined) return;
    const event: DragHover = { from, leave: true };
    this.#d.emit("dragHover", event, target);
  }

  /** Move a tile of window `from` (see {@linkcode MoveRequest}). */
  move(from: string, req: MoveRequest): MoveResult {
    this.#leave(from);
    const d = this.#d;
    const ws = d.workspaces;
    const fromWs = ws.workspaceOfWindow(from);
    const tile = movedTileOf(req.tile);
    if (fromWs === undefined) return { moved: false, reason: "no-window" };
    if (!tile || typeof req.tileId !== "string") {
      return { moved: false, reason: "invalid" };
    }
    const pty = "ptyId" in tile.tile ? tile.tile.ptyId : null;
    if (
      pty !== null &&
      (d.sessions.ownerOf(pty) !== from || ws.workspaceOfPty(pty) !== fromWs)
    ) return { moved: false, reason: "not-owner" };

    // Where to: a window, or a new one.
    let target: string | undefined;
    let at: { x: number; y: number } | undefined;
    let tearOff: { screen?: ScreenPoint; origin?: ScreenPoint } | undefined;
    const to = req.to;
    if ("window" in to) {
      target = to.window;
    } else if ("newWindow" in to) {
      tearOff = { screen: to.screen, origin: to.origin };
    } else {
      const { hit } = this.#hit(from, to.screen, to.origin);
      if (hit) {
        target = hit.id;
        at = { x: hit.x, y: hit.y };
      } else tearOff = { screen: to.screen, origin: to.origin };
    }
    let created = false;
    let toWs: string | undefined;
    if (tearOff) {
      // Tearing a window's only tile off would just be the window moving.
      if (req.last) return { moved: false, reason: "last" };
      const key = (d.newWorkspaceId ?? newWorkspaceId)();
      const frame = tearOff.screen
        ? tearOffFrame(
          tearOff.screen,
          screenOffset(tearOff.origin ?? tearOff.screen, d.bounds(from)),
          req.size ?? null,
        )
        : {};
      try {
        target = d.openWindow({ ...workspaceWindow(key, true), ...frame }).id;
      } catch (err) {
        console.error("tile move: could not open a window", err);
        return { moved: false, reason: "open-failed" };
      }
      // The window's page joins later; its workspace exists from now on, holding the tile.
      toWs = ws.join(target, key).id;
      created = true;
    } else {
      if (target === undefined || target === from) {
        return { moved: false, reason: "no-window" };
      }
      toWs = ws.workspaceOfWindow(target);
      if (toWs === undefined || toWs === fromWs) {
        return { moved: false, reason: "no-window" };
      }
    }

    // The move itself: both workspaces in one step.
    const move = moveId(++this.#moves, (d.now ?? Date.now)());
    ws.save(fromWs, withoutTile(ws.snapshotOf(fromWs), req.tileId));
    ws.departed(fromWs, req.tileId);
    // A tile that arrived in the source window and moves on before its page saved it.
    ws.ackArrivals(
      fromWs,
      ws.arrivals(fromWs).filter((a) => sameTile(a.tile, tile)).map((a) =>
        a.move
      ),
    );
    if (pty !== null) {
      ws.movePty(pty, toWs);
      d.sessions.handOver(pty, target);
    }
    const pending: Pending = { tile, ...(at ? { at } : {}) };
    ws.addArrival(toWs, move, pending);
    d.emit("tileArrived", { move }, target);
    d.emit("tileLeft", { tile: req.tileId, move }, from);
    if (req.last) {
      // The window it left is empty: it closes, and its workspace ends once it has.
      ws.endOnClose(fromWs);
      d.closeWindow(from);
    }
    return { moved: true, move, window: target, created };
  }

  /**
   * The tiles waiting in window `window`'s workspace, for its page to show: each terminal handed
   * to the window again with its replay. They stay pending until the page saves them.
   */
  arrivals(window: string): TileArrival[] {
    const d = this.#d;
    const id = d.workspaces.workspaceOfWindow(window);
    if (id === undefined) return [];
    return d.workspaces.arrivals(id).map(({ move, tile }) => {
      const p = tile as Pending;
      const ptyId = "ptyId" in p.tile.tile ? p.tile.tile.ptyId : null;
      const pty = ptyId !== null && d.workspaces.workspaceOfPty(ptyId) === id
        ? d.sessions.handOver(ptyId, window)
        : undefined;
      return {
        move,
        tile: p.tile,
        ...(p.at ? { at: p.at } : {}),
        ...(pty ? { pty } : {}),
      };
    });
  }

  /** The tiles pending in workspace `id` (a page joining it takes them into its snapshot). */
  static pendingTiles(pending: readonly { tile: unknown }[]): MovedTile[] {
    return pending.map((p) => (p.tile as Pending).tile);
  }
}

/** Whether a pending arrival is `tile` (moving on): its PTY, or a web tile's page and age. */
function sameTile(pending: unknown, tile: MovedTile): boolean {
  const p = (pending as Pending).tile;
  if ("ptyId" in p.tile && "ptyId" in tile.tile) {
    return p.tile.ptyId !== null && p.tile.ptyId === tile.tile.ptyId;
  }
  return "web" in p.tile && "web" in tile.tile &&
    p.tile.web.url === tile.tile.web.url &&
    p.entry.createdAt === tile.entry.createdAt;
}

// ---------------------------------------------------------------------------------------------
// The page's inputs (validated before the handlers run)
// ---------------------------------------------------------------------------------------------

const isPoint = (v: unknown): v is ScreenPoint =>
  typeof v === "object" && v !== null &&
  Number.isFinite((v as ScreenPoint).x) &&
  Number.isFinite((v as ScreenPoint).y);

const pointOf = (v: ScreenPoint): ScreenPoint => ({ x: v.x, y: v.y });

/** Where a tile goes, from a page (untrusted), or `undefined`. */
function destinationOf(v: unknown): MoveDestination | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.window === "string" && o.window.length <= 64) {
    return { window: o.window };
  }
  if (o.newWindow === true) {
    return {
      newWindow: true,
      ...(isPoint(o.screen) ? { screen: pointOf(o.screen) } : {}),
      ...(isPoint(o.origin) ? { origin: pointOf(o.origin) } : {}),
    };
  }
  if (isPoint(o.screen) && isPoint(o.origin)) {
    return { screen: pointOf(o.screen), origin: pointOf(o.origin) };
  }
  return undefined;
}

/** `moveTile`'s input. */
export const moveInput = objectSchema<MoveRequest>((v, issues) => {
  const to = destinationOf(v.to);
  if (!to) {
    issues.push({
      message: "to must be { window }, { screen, origin } or { newWindow }",
      path: ["to"],
    });
  }
  const size = v.size as Record<string, unknown> | undefined;
  const width = size?.width;
  const height = size?.height;
  const okSize = typeof width === "number" && typeof height === "number" &&
    Number.isFinite(width) && Number.isFinite(height) && width > 0 &&
    height > 0;
  return {
    tileId: str(v, "tileId", issues, 64),
    tile: v.tile,
    to: to ?? { window: "" },
    last: v.last === true,
    ...(okSize ? { size: { width, height } } : {}),
  };
});

/** `dragOver`'s input. */
export const dragOverInput = objectSchema<DragOver>((v, issues) => {
  if (!isPoint(v.screen) || !isPoint(v.origin)) {
    issues.push({ message: "screen and origin must be points" });
  }
  return {
    screen: isPoint(v.screen) ? pointOf(v.screen) : { x: 0, y: 0 },
    origin: isPoint(v.origin) ? pointOf(v.origin) : { x: 0, y: 0 },
    title: typeof v.title === "string" ? v.title.slice(0, 200) : "",
  };
});
