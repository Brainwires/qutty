// The in-browser stand-in for moving tiles between windows (desktop/tile-move.ts): pages of the
// demo opened with `?peers=<name>` find each other over a BroadcastChannel and are each other's
// "windows" (`Workspace <name>`). The e2e suite opens two of them to drive the header menu's
// "Move to Window". A demo terminal lives in its page's JavaScript, so moving one takes its state
// and replay record to the other page, which starts it again under an id of its own (the desktop
// app's PTY keeps its id: only its owner changes). The demo cannot open windows, so there is no
// tear-off and no cross-window drag here.
//
// Client-safe.

import type { DemoTileMoves } from "./session-client.ts";
import type { MovedTile } from "./workspace/session.ts";
import type {
  DragHover,
  MoveResult,
  MoveTarget,
  TileArrival,
} from "../desktop/session.ts";
import type { JoinedPty } from "./workspace/session.ts";

/** A demo terminal on its way to another page: whatever its page needs to start it again. */
export interface DemoPtyState {
  shell: unknown;
  record: unknown;
}

/** What the demo backend does for a move (lib/pty-client.ts). */
export interface DemoMoveHooks {
  /** Take terminal `id` out of this page (no exit is reported), or `undefined` when unknown. */
  exportPty(id: string): DemoPtyState | undefined;
  /** Start a terminal from another page's state here: its new id and replay. */
  importPty(state: DemoPtyState): JoinedPty;
}

const CHANNEL = "qutty-demo-windows";

type Message =
  | { type: "hello"; self: MoveTarget; reply?: boolean }
  | { type: "bye"; window: string }
  | {
    type: "move";
    to: string;
    move: string;
    tile: MovedTile;
    pty?: DemoPtyState;
  };

/** A small fan-out of callbacks. */
function listeners<T>() {
  const set = new Set<(v: T) => void>();
  return {
    on(cb: (v: T) => void) {
      set.add(cb);
      return () => void set.delete(cb);
    },
    emit(v: T) {
      for (const cb of [...set]) cb(v);
    },
  };
}

/** The demo's moves for a page named `name` (`?peers=<name>`). */
export function createDemoMoves(
  name: string,
  hooks: DemoMoveHooks,
): DemoTileMoves {
  const self: MoveTarget = {
    window: `demo-${name}`,
    workspace: `demo-${name}`,
    name: `Workspace ${name}`,
  };
  const peers = new Map<string, MoveTarget>();
  const pending: TileArrival[] = [];
  const arrived = listeners<void>();
  const left = listeners<{ tile: string; move: string }>();
  let n = 0;
  const ch = typeof BroadcastChannel === "function"
    ? new BroadcastChannel(CHANNEL)
    : null;
  const post = (m: Message) => ch?.postMessage(m);
  ch?.addEventListener("message", (e) => {
    const m = (e as MessageEvent<Message>).data;
    if (m.type === "hello") {
      peers.set(m.self.window, m.self);
      if (!m.reply) post({ type: "hello", self, reply: true });
    } else if (m.type === "bye") {
      peers.delete(m.window);
    } else if (m.type === "move" && m.to === self.window) {
      const pty = m.pty ? hooks.importPty(m.pty) : undefined;
      const tile: MovedTile = pty && "ptyId" in m.tile.tile
        ? { ...m.tile, tile: { ...m.tile.tile, ptyId: pty.id } }
        : m.tile;
      pending.push({ move: m.move, tile, ...(pty ? { pty } : {}) });
      arrived.emit();
    }
  });
  post({ type: "hello", self });
  globalThis.addEventListener?.("pagehide", () => {
    post({ type: "bye", window: self.window });
  });

  return {
    workspace: { id: self.workspace, name: self.name },
    newWindow: false,
    drag: false,
    targets: () => Promise.resolve([...peers.values()]),
    move(request): Promise<MoveResult> {
      const to = "window" in request.to ? peers.get(request.to.window) : null;
      if (!to) return Promise.resolve({ moved: false, reason: "no-window" });
      const tile = request.tile as MovedTile;
      const ptyId = "ptyId" in tile.tile ? tile.tile.ptyId : null;
      const pty = ptyId !== null ? hooks.exportPty(ptyId) : undefined;
      if (ptyId !== null && !pty) {
        return Promise.resolve({ moved: false, reason: "not-owner" });
      }
      const move = `demo-mv-${name}-${++n}`;
      post({
        type: "move",
        to: to.window,
        move,
        tile,
        ...(pty ? { pty } : {}),
      });
      left.emit({ tile: request.tileId, move });
      return Promise.resolve({
        moved: true,
        move,
        window: to.window,
        created: false,
      });
    },
    arrivals: () => Promise.resolve([...pending]),
    ack(moves) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (moves.includes(pending[i].move)) pending.splice(i, 1);
      }
    },
    dragOver: () => Promise.resolve({ target: null }),
    dragEnd: () => Promise.resolve(),
    onArrived: (cb) => arrived.on(cb),
    onLeft: (cb) => left.on(cb),
    onHover: (_cb: (e: DragHover) => void) => () => {},
    onRequest: () => () => {},
  };
}
