// Moving tiles between windows, the page's half (desktop/tile-move.ts has the app process's):
//
// - The tile header's menu (a right click on the header): "Move to Workspace N" for each other
//   window, and "Move to New Window". The Window menu can ask for the same with the focused tile
//   (`moveRequest`, desktop/session.ts `requestTileMove`).
// - A header dragged out of the window (`WindowDrag`, fed by the cluster's drag hooks: the swap
//   drag of tiled tiles, the free-form move). While the pointer is outside, its screen position
//   goes to the app process once a frame, which tells the window under it; released there, the
//   tile moves there, at the drop point; released over no window of the app, it tears off into a
//   new window (unless it is this window's only tile: then it stays).
// - A tile that leaves: its terminal is let go without being killed (its PTY now belongs to the
//   other window) and its tile removed. The last one leaving closes the window (the app process
//   does, and ends the empty workspace once it has closed).
// - A tile that arrives (pulled once told, and once the workspace is joined): a new id here, its
//   terminal adopted from its replay, focused, in the slot under the drop point (tiles in place)
//   or at the drop point (free-form). A web tile arrives as its page and loads it again.
// - Another window's tile dragged over this one: where it would land is marked (`hover`).

import { useCallback, useEffect, useMemo, useRef, useState } from "denext";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type {
  DragOver,
  MoveResult,
  TileArrival,
  TileMoves,
} from "../lib/session-client.ts";
import type { LayoutTile, Rect } from "../lib/layout/mod.ts";
import type {
  WorkspaceAction,
  WorkspaceState,
} from "../lib/workspace/store.ts";
import { keepsPlaces } from "../lib/workspace/tile-order.ts";
import { arrivalPlace, isOutside } from "../lib/workspace/tile-move.ts";
import type { MovedTile } from "../lib/workspace/session.ts";
import { SHELL_PROFILE } from "../lib/ssh-ui.ts";
import type { LinkMenuItem } from "./link-menu.tsx";

/** What the cluster's drag hooks tell about a header drag that may leave the window. */
export interface WindowDrag {
  /** The pointer moved while tile `id` is dragged; `true` while it is outside the window. */
  move(ev: PointerEvent, id: string): boolean;
  /**
   * The pointer was released. `true`: it was outside the window, so the tile goes to another
   * window (or a new one, or back where it was): the in-window drop must not happen.
   */
  drop(ev: PointerEvent, id: string): boolean;
  /** The drag ended without a release (Escape, a lost capture, the hook went away). */
  cancel(): void;
}

/** Another window's tile over this one: where (page px) and what. */
export interface DropHover {
  title: string;
  x: number;
  y: number;
}

/** The header menu, at the pointer. */
export interface TileMoveMenu {
  x: number;
  y: number;
  title: string;
  items: LinkMenuItem[];
}

export interface TileMoveApi {
  /** Tiles can move to other windows here. */
  enabled: boolean;
  /** The cross-window drag for the cluster's drag hooks (absent: none here). */
  drag: WindowDrag | undefined;
  /** Another window's tile dragged over this one. */
  hover: DropHover | null;
  /**
   * Open the header menu of tile `id` at (`x`, `y`): `extra` items first (the harness overlay's
   * "GUI overlay"), then the windows it can move to.
   */
  openMenu(id: string, x: number, y: number, extra?: LinkMenuItem[]): void;
  menu: TileMoveMenu | null;
  closeMenu(): void;
  /** Move tile `id` to window `to` (`"new"`: a new window). Resolves whether it moved. */
  moveTo(id: string, to: string): Promise<boolean>;
  /** A tile that moved here: show it (its new id; `null`: nothing to show). */
  arrive(arrival: TileArrival): string | null;
}

export function useTileMove(opts: {
  manager: TerminalManager | null;
  moves: TileMoves | undefined;
  state: WorkspaceState;
  seqRef: { current: number };
  /** The tiles drawn now, and the area they are drawn in. */
  tiles: readonly LayoutTile[];
  bounds: Rect;
  cluster: { current: HTMLElement | null };
  run(action: WorkspaceAction): void;
  focus(id: string): void;
  /** Tile `id` left: let go of what the workspace keeps for it (SSH transfers' state). */
  forget(id: string): void;
}): TileMoveApi {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const { moves } = opts;
  const [hover, setHover] = useState<DropHover | null>(null);
  const [menu, setMenu] = useState<TileMoveMenu | null>(null);

  /** Tile `id` went to another window: its terminal is let go (not killed), its tile removed. */
  const leave = useCallback((id: string) => {
    const o = optsRef.current;
    if (!o.state.terminals.some((t) => t.id === id)) return;
    o.manager?.dispose(id, true);
    o.forget(id);
    o.run({ type: "remove", id });
  }, []);

  /** What travels with tile `id`. */
  const movedTile = useCallback((id: string): MovedTile | undefined => {
    const o = optsRef.current;
    const entry = o.state.terminals.find((t) => t.id === id);
    // An agent tile's session belongs to this window's hub: it does not move.
    if (!entry || entry.chat) return undefined;
    const tile = o.tiles.find((t) => t.id === id);
    const size = tile ? { size: { w: tile.rect.w, h: tile.rect.h } } : {};
    if (entry.web) return { entry, tile: { web: entry.web }, ...size };
    const m = o.manager;
    const home = m?.home(id);
    return {
      entry,
      tile: {
        ptyId: m?.ptyId(id) ?? null,
        profile: m?.profile(id) ?? SHELL_PROFILE,
        ...(home !== undefined ? { home } : {}),
      },
      ...size,
    };
  }, []);

  /** Ask the app process to move tile `id`; on success it leaves. */
  const send = useCallback(
    async (
      id: string,
      to: Parameters<TileMoves["move"]>[0]["to"],
    ): Promise<MoveResult | null> => {
      const o = optsRef.current;
      const tile = movedTile(id);
      if (!o.moves || !tile) return null;
      const result = await o.moves.move({
        tileId: id,
        tile,
        to,
        last: o.state.terminals.length === 1,
        size: {
          width: globalThis.outerWidth || globalThis.innerWidth,
          height: globalThis.outerHeight || globalThis.innerHeight,
        },
      }).catch((err) => {
        console.warn("could not move the tile", err);
        return null;
      });
      if (result?.moved) leave(id);
      return result;
    },
    [movedTile, leave],
  );

  const moveTo = useCallback(async (id: string, to: string) => {
    const result = await send(
      id,
      to === "new" ? { newWindow: true } : { window: to },
    );
    return result?.moved === true;
  }, [send]);

  const arrive = useCallback((a: TileArrival): string | null => {
    const o = optsRef.current;
    if (!o.manager) return null;
    const id = `t${++o.seqRef.current}`;
    const { entry, tile, size } = a.tile;
    if ("ptyId" in tile) o.manager.adopt(id, tile.profile, a.pty, tile.home);
    const box = o.cluster.current?.getBoundingClientRect();
    const place = arrivalPlace({
      at: a.at,
      view: o.state.view,
      keepsPlaces: keepsPlaces(o.state),
      tiles: o.tiles,
      cluster: { left: box?.left ?? 0, top: box?.top ?? 0 },
      bounds: o.bounds,
      ...(size ? { size } : {}),
    });
    o.run({
      type: "arrive",
      entry: { ...entry, id },
      now: Date.now(),
      ...place,
    });
    setHover(null);
    o.focus(id);
    return id;
  }, []);

  // A tile of ours that moved away (also when the app process moved it), another window's tile
  // over this one, and the Window menu's "Move Tile to".
  useEffect(() => {
    if (!moves) return;
    const offLeft = moves.onLeft((e) => leave(e.tile));
    const offHover = moves.onHover((e) => {
      setHover("leave" in e ? null : { title: e.title, x: e.x, y: e.y });
    });
    const offRequest = moves.onRequest((to) => {
      const id = optsRef.current.state.focusedId;
      if (id) void moveTo(id, to);
    });
    return () => {
      offLeft();
      offHover();
      offRequest();
    };
  }, [moves, leave, moveTo]);

  const openMenu = useCallback((
    id: string,
    x: number,
    y: number,
    extra: LinkMenuItem[] = [],
  ) => {
    const o = optsRef.current;
    const title = extra.length > 0 ? "Tile" : "Move to Window";
    if (!o.moves || o.state.terminals.find((t) => t.id === id)?.chat) {
      if (extra.length > 0) setMenu({ x, y, title, items: extra });
      return;
    }
    const many = o.state.terminals.length > 1;
    void o.moves.targets().then((targets) => {
      const items: LinkMenuItem[] = [
        ...extra,
        ...targets.map((t) => ({
          action: `move:${t.window}`,
          label: `Move to ${t.name}`,
          run: () => void moveTo(id, t.window),
        })),
      ];
      // A window's only tile tearing off would just be the window again.
      if (o.moves?.newWindow && many) {
        items.push({
          action: "move:new",
          label: "Move to New Window",
          run: () => void moveTo(id, "new"),
        });
      }
      if (items.length > 0) setMenu({ x, y, title, items });
    }, () => {
      if (extra.length > 0) setMenu({ x, y, title, items: extra });
    });
  }, [moveTo]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // The cross-window drag: the pointer's screen position, sent at most once a frame while it is
  // outside the window (and once more when it comes back in).
  const drag = useMemo<WindowDrag | undefined>(() => {
    if (!moves?.drag) return undefined;
    let outside = false;
    let latest: DragOver | null = null;
    let frame = 0;
    let inFlight = false;
    const flush = () => {
      frame = 0;
      if (!latest || inFlight || !outside) return;
      const over = latest;
      latest = null;
      inFlight = true;
      void moves.dragOver(over).catch(() => {}).finally(() => {
        inFlight = false;
        if (latest && outside && frame === 0) {
          frame = requestAnimationFrame(flush);
        }
      });
    };
    const pointOf = (ev: PointerEvent) => ({
      screen: { x: ev.screenX, y: ev.screenY },
      origin: { x: ev.screenX - ev.clientX, y: ev.screenY - ev.clientY },
    });
    const back = () => {
      if (!outside) return;
      outside = false;
      latest = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      void moves.dragEnd().catch(() => {});
    };
    return {
      move(ev, id) {
        const out = isOutside(
          ev.clientX,
          ev.clientY,
          globalThis.innerWidth,
          globalThis.innerHeight,
        );
        if (!out) {
          back();
          return false;
        }
        outside = true;
        const title = optsRef.current.state.terminals.find((t) =>
          t.id === id
        )?.title ?? "";
        latest = { ...pointOf(ev), title };
        if (frame === 0) frame = requestAnimationFrame(flush);
        return true;
      },
      drop(ev, id) {
        const out = isOutside(
          ev.clientX,
          ev.clientY,
          globalThis.innerWidth,
          globalThis.innerHeight,
        );
        if (!out) {
          back();
          return false;
        }
        outside = false;
        latest = null;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        // The app process tells the hovered window it was left, and moves the tile (or not).
        void send(id, pointOf(ev));
        return true;
      },
      cancel: back,
    };
  }, [moves, send]);

  return {
    enabled: moves !== undefined,
    drag,
    hover,
    openMenu,
    menu,
    closeMenu,
    moveTo,
    arrive,
  };
}
