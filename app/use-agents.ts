// The page's agent tiles: one session per tile in the hub (lib/agent/sessions.ts), followed here
// through the backend's `agent` updates. The store keeps each tile's snapshot (name, model,
// transcript) and tells only that tile when it changes, so a stream of deltas re-renders one
// transcript, not the workspace; the workspace hears only when a tile's group changes (Needs
// you, To review, Working: the Agents panel, the tile's activity), a turn ends, or its session
// does (saved in the entry's `chat`).
//
// A tile that comes back (a reload, a window shown again) attaches to the session it had, or
// resumes its Claude Code session under its saved transcript (lib/workspace/session.ts).

import { useEffect, useMemo, useRef, useState } from "denext";
import type {
  AgentMessage,
  PermissionDecision,
  PermissionMode,
} from "../lib/agent/adapter.ts";
import type { RevertResult } from "../lib/agent/changes.ts";
import type { AgentSnapshot, AgentUpdate } from "../lib/agent/sessions.ts";
import {
  reduceTranscript,
  type Row,
  transcriptText,
} from "../lib/agent/transcript.ts";
import {
  type AgentChat,
  type AgentGroup,
  agentGroup,
  agentHarness,
} from "../lib/agent/tile.ts";
import type { AgentHarness } from "../lib/agent/avatar.ts";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";

/** One agent tile as the page knows it. */
export interface AgentTileState {
  /** The session (absent while it opens, or when it could not). */
  snap?: AgentSnapshot;
  /** A turn finished and the tile has not been focused since. */
  review: boolean;
  /** Why the session could not open. */
  failed?: string;
  /**
   * The Changes tab's reviewed files: per path, the last change accepted or reverted (its tool
   * row id); later changes show again.
   */
  reviewed?: Readonly<Record<string, string>>;
}

/** One tile's summary for the Agents panel and the workspace. */
export interface AgentSummary {
  id: string;
  name: string;
  group: AgentGroup;
  /** What it does or asks, in a few words. */
  detail: string;
  /** The harness it runs on (its avatar's colour). */
  harness: AgentHarness;
}

/** What the store reports to the workspace. */
export interface AgentStoreEvents {
  /** The tile's session changed (saved in its entry). */
  meta(tileId: string, patch: Partial<AgentChat>): void;
  /** Its name changed (its title). */
  named(tileId: string, name: string): void;
  /** A turn ended, well or not (the tile's activity). */
  turnEnded(tileId: string, ok: boolean): void;
  /** The agent wrote something (the tile's activity). */
  output(tileId: string): void;
}

type Listener = () => void;

/** The agent tiles' sessions as the page follows them. */
export class AgentStore {
  #backend: PtyBackend;
  #events: AgentStoreEvents;
  #tiles = new Map<string, AgentTileState>();
  #byAgent = new Map<string, string>();
  #listeners = new Map<string, Set<Listener>>();
  #all = new Set<Listener>();
  #restored = new Map<string, Row[]>();
  #opening = new Set<string>();
  #groups = new Map<string, AgentGroup>();
  #focused: string | null = null;
  /** Text typed into a tile's prompt box from outside (dictation). */
  #inserters = new Map<string, (text: string) => void>();
  /** Updates for sessions this page has not mapped yet (an attach in flight). */
  #early: AgentUpdate[] = [];

  constructor(backend: PtyBackend, events: AgentStoreEvents) {
    this.#backend = backend;
    this.#events = events;
  }

  /** Follow the backend's updates; returns the unsubscribe. */
  listen(): () => void {
    return this.#backend.onAgent((u) => this.#update(u));
  }

  setEvents(events: AgentStoreEvents): void {
    this.#events = events;
  }

  get(tileId: string): AgentTileState | undefined {
    return this.#tiles.get(tileId);
  }

  /** Tile `tileId`'s backend session id. */
  agentOf(tileId: string): string | undefined {
    return this.#tiles.get(tileId)?.snap?.id;
  }

  /** The tile whose session is `agentId` (its hub tile id). */
  tileOf(agentId: string): string | undefined {
    return this.#byAgent.get(agentId);
  }

  subscribe(tileId: string, fn: Listener): () => void {
    let set = this.#listeners.get(tileId);
    if (!set) this.#listeners.set(tileId, set = new Set());
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Hear when any tile's group or name changes. */
  subscribeAll(fn: Listener): () => void {
    this.#all.add(fn);
    return () => this.#all.delete(fn);
  }

  /** Every tile's summary. */
  summaries(): AgentSummary[] {
    return [...this.#tiles].map(([id, s]) => ({
      id,
      name: s.snap?.name ?? "claude",
      group: this.#group(s),
      detail: this.#detail(s),
      harness: agentHarness(),
    }));
  }

  #group(s: AgentTileState): AgentGroup {
    if (s.failed) return "needs";
    return agentGroup(s.snap?.transcript, s.review);
  }

  #detail(s: AgentTileState): string {
    if (s.failed) return s.failed;
    const t = s.snap?.transcript;
    if (!t) return "starting";
    if (t.asking.length > 0) {
      const row = t.rows.find((r) =>
        r.type === "permission" && r.id === t.asking[0]
      );
      return row?.type === "permission"
        ? `asks to run ${row.toolName}`
        : "asks";
    }
    if (!t.running && t.error) return t.error.split("\n")[0].slice(0, 80);
    if (t.running) return "working";
    if (s.review) return "finished";
    return t.exited ? "ended" : "idle";
  }

  /** The saved transcript of a restored tile (used when it opens). */
  restored(tileId: string, rows: Row[]): void {
    this.#restored.set(tileId, rows);
  }

  /** The rows to save for tile `tileId`. */
  rows(tileId: string): readonly Row[] {
    return this.#tiles.get(tileId)?.snap?.transcript.rows ??
      this.#restored.get(tileId) ?? [];
  }

  /** The transcript as text (the companion reads it). */
  text(tileId: string): string {
    const t = this.#tiles.get(tileId)?.snap?.transcript;
    return t ? transcriptText(t).join("\n") : "";
  }

  /** Open tile `tileId`'s session (attach, resume or start). */
  async open(tileId: string, entry: Pick<TerminalEntry, "chat" | "title">) {
    const chat = entry.chat;
    if (!chat || this.#tiles.get(tileId)?.snap || this.#opening.has(tileId)) {
      return;
    }
    this.#opening.add(tileId);
    if (!this.#tiles.has(tileId)) {
      this.#tiles.set(tileId, { review: false });
      this.#changed(tileId);
    }
    const rows = this.#restored.get(tileId);
    try {
      const snap = await this.#backend.agentStart({
        cwd: chat.cwd,
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.session ? { resumeId: chat.session } : {}),
        ...(chat.mode ? { permissionMode: chat.mode } : {}),
        ...(chat.systemPrompt ? { systemPrompt: chat.systemPrompt } : {}),
        ...(chat.allowedTools ? { allowedTools: chat.allowedTools } : {}),
        ...(chat.agentId ? { attach: chat.agentId } : {}),
        ...(entry.title && entry.title !== "claude"
          ? { name: entry.title }
          : {}),
        ...(rows ? { rows } : {}),
      });
      this.#restored.delete(tileId);
      if (!this.#tiles.has(tileId)) {
        // Closed while it opened.
        void this.#backend.agentStop(snap.id).catch(() => {});
        return;
      }
      this.#adopt(tileId, snap);
      this.#events.meta(tileId, {
        agentId: snap.id,
        cwd: snap.spec.cwd,
        ...(snap.transcript.sessionId
          ? { session: snap.transcript.sessionId }
          : {}),
      });
      this.#events.named(tileId, snap.name);
      for (const u of this.#early.splice(0)) this.#update(u);
    } catch (e) {
      this.#set(tileId, {
        review: false,
        failed: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.#opening.delete(tileId);
    }
  }

  #adopt(tileId: string, snap: AgentSnapshot): void {
    const old = this.#tiles.get(tileId);
    if (old?.snap) this.#byAgent.delete(old.snap.id);
    this.#byAgent.set(snap.id, tileId);
    this.#set(tileId, {
      review: old?.review ?? false,
      snap,
      ...(old?.reviewed ? { reviewed: old.reviewed } : {}),
    });
  }

  #set(tileId: string, s: AgentTileState): void {
    this.#tiles.set(tileId, s);
    this.#changed(tileId);
  }

  #changed(tileId: string): void {
    for (const fn of this.#listeners.get(tileId) ?? []) fn();
    const s = this.#tiles.get(tileId);
    const group = s ? this.#group(s) : undefined;
    if (group !== this.#groups.get(tileId)) {
      if (group) this.#groups.set(tileId, group);
      else this.#groups.delete(tileId);
      for (const fn of this.#all) fn();
    }
  }

  #update(u: AgentUpdate): void {
    const tileId = this.#byAgent.get(u.id);
    if (!tileId) {
      // A session being attached right now: keep its updates for a moment.
      if (this.#opening.size > 0) {
        this.#early.push(u);
        if (this.#early.length > 2000) this.#early.shift();
      }
      return;
    }
    const s = this.#tiles.get(tileId);
    if (!s?.snap) return;
    if ("closed" in u) {
      this.#byAgent.delete(u.id);
      this.#set(tileId, { review: false, failed: "The session ended." });
      return;
    }
    if (u.seq <= s.snap.seq) return;
    if ("snapshot" in u) {
      this.#adopt(tileId, u.snapshot);
      this.#events.named(tileId, u.snapshot.name);
      this.#events.meta(tileId, {
        ...(u.snapshot.spec.model ? { model: u.snapshot.spec.model } : {}),
        session: u.snapshot.transcript.sessionId,
      });
      return;
    }
    const e = u.event;
    const transcript = reduceTranscript(s.snap.transcript, e);
    let review = s.review;
    switch (e.kind) {
      case "session":
        if (e.sessionId !== s.snap.transcript.sessionId) {
          this.#events.meta(tileId, { session: e.sessionId });
        }
        break;
      case "user":
        review = false;
        break;
      case "text":
      case "toolStart":
        this.#events.output(tileId);
        break;
      case "turnEnd": {
        if (this.#focused !== tileId) review = true;
        const last = transcript.rows.at(-1);
        this.#events.turnEnded(
          tileId,
          !(last?.type === "footer" && last.outcome === "failed"),
        );
        this.#events.meta(tileId, {
          turns: transcript.rows.filter((r) => r.type === "footer").length,
        });
        break;
      }
    }
    this.#set(tileId, {
      ...s,
      review,
      snap: { ...s.snap, seq: u.seq, transcript },
    });
  }

  /** The workspace's focused tile: looking at a tile clears its "to review". */
  setFocused(tileId: string | null): void {
    this.#focused = tileId;
    const s = tileId ? this.#tiles.get(tileId) : undefined;
    if (tileId && s?.review) this.#set(tileId, { ...s, review: false });
  }

  send(tileId: string, message: AgentMessage): void {
    const id = this.agentOf(tileId);
    if (id) void this.#backend.agentSend(id, message).catch(() => {});
  }

  interrupt(tileId: string): void {
    const id = this.agentOf(tileId);
    if (id) void this.#backend.agentInterrupt(id).catch(() => {});
  }

  answer(tileId: string, requestId: string, decision: PermissionDecision) {
    const id = this.agentOf(tileId);
    if (id) {
      void this.#backend.agentAnswer(id, requestId, decision).catch(() => {});
    }
  }

  /** Another model (`""`: the default) or permission mode, or a new session. */
  restart(
    tileId: string,
    patch: { model?: string; permissionMode?: PermissionMode; fresh?: boolean },
  ): void {
    const id = this.agentOf(tileId);
    if (!id) return;
    if (patch.model !== undefined) {
      this.#events.meta(tileId, { model: patch.model || undefined });
    }
    if (patch.permissionMode) {
      this.#events.meta(tileId, { mode: patch.permissionMode });
    }
    if (patch.fresh) {
      this.#events.meta(tileId, { session: undefined });
      const s = this.#tiles.get(tileId);
      if (s?.reviewed) this.#set(tileId, { ...s, reviewed: {} });
    }
    void this.#backend.agentRestart(id, patch).catch(() => {});
  }

  /** The Changes tab: file `path`'s changes up to row `rowId` are reviewed (accepted, reverted). */
  markReviewed(tileId: string, marks: Readonly<Record<string, string>>): void {
    const s = this.#tiles.get(tileId);
    if (!s) return;
    this.#set(tileId, { ...s, reviewed: { ...s.reviewed, ...marks } });
  }

  /**
   * Revert files the session changed (each after what was reviewed already); each file's result.
   * The reverted ones are marked reviewed.
   */
  async revert(tileId: string, paths: string[]): Promise<RevertResult[]> {
    const id = this.agentOf(tileId);
    if (!id) throw new Error("the session is not open");
    const reviewed = this.#tiles.get(tileId)?.reviewed ?? {};
    const results = await this.#backend.agentRevert(
      id,
      paths.map((path) => ({
        path,
        ...(reviewed[path] ? { after: reviewed[path] } : {}),
      })),
    );
    const marks: Record<string, string> = {};
    for (const r of results) if (r.ok && r.through) marks[r.path] = r.through;
    if (Object.keys(marks).length > 0) this.markReviewed(tileId, marks);
    return results;
  }

  /** Rename the tile's agent; resolves with the name, rejects with the reason. */
  async rename(tileId: string, name: string): Promise<string> {
    const id = this.agentOf(tileId);
    if (!id) throw new Error("the session is not open");
    return await this.#backend.agentRename(id, name);
  }

  /** The tile closed: its session ends. */
  close(tileId: string): void {
    const id = this.agentOf(tileId);
    this.#tiles.delete(tileId);
    this.#restored.delete(tileId);
    this.#changed(tileId);
    this.#listeners.delete(tileId);
    if (id) {
      this.#byAgent.delete(id);
      void this.#backend.agentStop(id).catch(() => {});
    }
  }

  /** Forget a tile without ending its session (the page goes away; it may come back). */
  forget(tileId: string): void {
    const id = this.agentOf(tileId);
    if (id) this.#byAgent.delete(id);
    this.#tiles.delete(tileId);
    this.#changed(tileId);
  }

  /** The prompt box of tile `tileId` takes text from outside (dictation). */
  onInsert(tileId: string, fn: (text: string) => void): () => void {
    this.#inserters.set(tileId, fn);
    return () => {
      if (this.#inserters.get(tileId) === fn) this.#inserters.delete(tileId);
    };
  }

  /** Type `text` into tile `tileId`'s prompt box; false when it has none. */
  insert(tileId: string, text: string): boolean {
    const fn = this.#inserters.get(tileId);
    if (!fn) return false;
    fn(text);
    return true;
  }
}

/**
 * The workspace's agent store: opens a session for every agent tile in `terminals` (new ones, and
 * those a restore brought back), follows the focused tile, and re-renders the workspace when a
 * tile's group changes.
 */
export function useAgents(opts: {
  backend: PtyBackend | null;
  terminals: readonly TerminalEntry[];
  focusedId: string | null;
  events: AgentStoreEvents;
}): { store: AgentStore | null; summaries: AgentSummary[] } {
  const eventsRef = useRef(opts.events);
  eventsRef.current = opts.events;
  const store = useMemo(
    () =>
      opts.backend
        ? new AgentStore(opts.backend, {
          meta: (id, p) => eventsRef.current.meta(id, p),
          named: (id, n) => eventsRef.current.named(id, n),
          turnEnded: (id, ok) => eventsRef.current.turnEnded(id, ok),
          output: (id) => eventsRef.current.output(id),
        })
        : null,
    [opts.backend],
  );
  const [summaries, setSummaries] = useState<AgentSummary[]>([]);
  useEffect(() => {
    if (!store) return;
    const off = store.listen();
    const offAll = store.subscribeAll(() => setSummaries(store.summaries()));
    return () => {
      off();
      offAll();
    };
  }, [store]);
  // Open the agent tiles' sessions (keyed on which tiles are agent tiles).
  const chatKey = opts.terminals.filter((t) => t.chat).map((t) => t.id).join(
    " ",
  );
  useEffect(() => {
    if (!store) return;
    for (const t of opts.terminals) {
      if (t.chat) void store.open(t.id, t);
    }
  }, [store, chatKey]);
  useEffect(() => {
    store?.setFocused(opts.focusedId);
  }, [store, opts.focusedId]);
  // Names come from the summaries too (a rename re-renders the panel).
  return { store, summaries };
}
