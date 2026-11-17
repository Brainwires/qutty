// The workspace's broadcast state (cluster ssh, lib/broadcast.ts): the mode, the checked tiles,
// and a big paste waiting for confirmation. Turning it on checks every visible terminal tile
// (`defaultMembers`); the banner's All / None / Only SSH replace the selection. The selection follows the open tiles (a closed tile
// leaves it) and is handed to the terminal manager, which does the routing. Never persisted.

import { useCallback, useEffect, useMemo, useRef, useState } from "denext";
import {
  activeMembers,
  BROADCAST_OFF,
  type BroadcastState,
  defaultMembers,
  pruneMembers,
  setMember,
  setMembers,
  sshMembers,
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
  /** The tiles the cluster shows right now (read when the mode is turned on, and by All). */
  visibleIds(): ReadonlySet<string>;
  /** Put the keyboard back in the focused terminal. */
  refocus(): void;
}

export function useBroadcast(opts: UseBroadcastOptions) {
  const { manager, terminals } = opts;
  const [state, setState] = useState<BroadcastState>(BROADCAST_OFF);
  const [held, setHeld] = useState<HeldPaste | null>(null);
  const refocusRef = useRef(opts.refocus);
  refocusRef.current = opts.refocus;
  const visibleRef = useRef(opts.visibleIds);
  visibleRef.current = opts.visibleIds;
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  /** The visible terminal tiles: what turning it on, and All, check. */
  const defaults = () =>
    defaultMembers(terminalsRef.current, visibleRef.current());

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
    const members = defaults();
    setState((s) => toggleBroadcast(s, members));
    refocusRef.current();
  }, []);

  /** The banner's All, None and Only SSH. */
  const select = useCallback((which: "all" | "none" | "ssh") => {
    const ids = which === "none"
      ? []
      : which === "all"
      ? defaults()
      : sshMembers(terminalsRef.current, visibleRef.current());
    setState((s) => setMembers(s, ids));
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
  // How many visible SSH tiles there are (Only SSH shows when there are any). A function: the
  // visible tiles are known only later in the workspace's render, where the banner asks.
  const sshTiles = () =>
    sshMembers(terminalsRef.current, visibleRef.current()).length;

  return {
    on: state.on,
    state,
    members,
    /** How many checked tiles are not SSH tiles (the banner warns). */
    nonSsh,
    /** How many visible SSH tiles there are (call it after the layout is known). */
    sshTiles,
    held,
    toggle,
    select,
    setChecked,
    hold,
    resolvePaste,
  };
}
