// The workspace's broadcast state (cluster ssh, lib/broadcast.ts): the mode, the checked tiles,
// and a big paste waiting for confirmation. The selection follows the open tiles (a closed tile
// leaves it) and is handed to the terminal manager, which does the routing. Never persisted.

import { useCallback, useEffect, useMemo, useRef, useState } from "denext";
import {
  activeMembers,
  BROADCAST_OFF,
  type BroadcastState,
  pruneMembers,
  setMember,
  toggleBroadcast,
} from "../lib/broadcast.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";

/** A paste into a broadcasting tile, held until the user says where it goes. */
export interface HeldPaste {
  id: string;
  data: string;
  /** How many tiles it would reach. */
  tiles: number;
}

export interface UseBroadcastOptions {
  manager: TerminalManager | null;
  terminals: TerminalEntry[];
  /** Put the keyboard back in the focused terminal. */
  refocus(): void;
}

export function useBroadcast(opts: UseBroadcastOptions) {
  const { manager, terminals } = opts;
  const [state, setState] = useState<BroadcastState>(BROADCAST_OFF);
  const [held, setHeld] = useState<HeldPaste | null>(null);
  const refocusRef = useRef(opts.refocus);
  refocusRef.current = opts.refocus;

  const openIds = terminals.map((t) => t.id).join(" ");
  useEffect(() => {
    setState((s) => pruneMembers(s, openIds ? openIds.split(" ") : []));
  }, [openIds]);

  useEffect(() => {
    manager?.setBroadcast(activeMembers(state));
  }, [manager, state]);

  // A paste held for a broadcast that has since ended is dropped (nothing is sent).
  useEffect(() => {
    if (!state.on) setHeld(null);
  }, [state.on]);

  const toggle = useCallback(() => {
    setState(toggleBroadcast);
    refocusRef.current();
  }, []);

  const setChecked = useCallback((id: string, on: boolean) => {
    setState((s) => setMember(s, id, on));
    refocusRef.current();
  }, []);

  const hold = useCallback((id: string, data: string, tiles: number) => {
    setHeld({ id, data, tiles });
  }, []);

  /** Where the held paste goes: every member, the tile it was pasted in, or nowhere. */
  const heldRef = useRef(held);
  heldRef.current = held;
  const resolvePaste = useCallback((to: "all" | "one" | "none") => {
    const h = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    if (h && to !== "none") manager?.sendHeldPaste(h.id, h.data, to === "all");
    refocusRef.current();
  }, [manager]);

  const members = useMemo(() => new Set(state.members), [state.members]);
  const nonSsh = useMemo(
    () => terminals.filter((t) => members.has(t.id) && !t.ssh).length,
    [terminals, members],
  );

  return {
    on: state.on,
    state,
    members,
    /** How many checked tiles are not SSH tiles (the banner warns). */
    nonSsh,
    held,
    toggle,
    setChecked,
    hold,
    resolvePaste,
  };
}
