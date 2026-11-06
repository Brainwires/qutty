/**
 * A fake companion brain for the demo backend (plain-browser development and the e2e suite): a
 * {@linkcode BrainAdapter} with canned answers, run by the real runtime (lib/companion/runtime.ts)
 * so the page sees exactly the updates the desktop app sends. What it understands:
 *
 * - "tile 2" / "what's in tile 2": which tile that is and what it is doing (from the registry);
 * - "open a tile" / "new tile": asks the page to spawn one (the companion's `spawn_tile`);
 * - "/crash": the session dies mid-turn (the runtime's re-attach path);
 * - anything else: an echo.
 *
 * Agents' messages (`/msg companion …` in a demo agent) get "Got it" back as a message, and a
 * bubble saying who wrote.
 *
 * Client-safe.
 *
 * @module
 */

import type { BrainAdapter, BrainSink } from "./brain.ts";
import type { ControlCommand, ControlResult } from "../hub/core.ts";
import type { TileInfo } from "../hub/protocol.ts";

/** What the fake brain can see and do. */
export interface DemoBrainWorld {
  tiles(): TileInfo[];
  /** Message a tile (by name) as the companion. */
  send(to: string, text: string): void;
  /** A companion command through the page (recorded in the audit log). */
  control(command: ControlCommand): Promise<ControlResult>;
}

/** How long the fake brain takes to start, and between words. */
const START_MS = 120;
const WORD_MS = 18;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fake brain. */
export class DemoBrain implements BrainAdapter {
  readonly label = "Demo brain";
  #world: DemoBrainWorld;
  #sink: BrainSink | undefined;
  #alive = false;

  constructor(world: DemoBrainWorld) {
    this.#world = world;
  }

  async start(sink: BrainSink): Promise<void> {
    await sleep(START_MS);
    this.#sink = sink;
    this.#alive = true;
    sink.event({ kind: "ready" });
  }

  async send(text: string): Promise<void> {
    const sink = this.#sink;
    if (!sink || !this.#alive) throw new Error("not running");
    if (text.trim() === "/crash") {
      await sleep(WORD_MS * 3);
      this.#alive = false;
      sink.exited("demo crash");
      return;
    }
    const reply = text.startsWith("[Qutty]")
      ? this.#mail(text)
      : await this.#answer(text);
    let said = "";
    for (const word of reply.split(/(?<= )/)) {
      if (!this.#alive) return;
      await sleep(WORD_MS);
      said += word;
      sink.event({ kind: "text", delta: word });
    }
    sink.event({ kind: "turnEnd", text: said, isError: false });
  }

  stop(): void {
    this.#alive = false;
  }

  /** A turn on agents' messages: answer each sender, tell the user who wrote. */
  #mail(text: string): string {
    const lines = [...text.matchAll(/^- from (\S+) \([^)]*\): (.*)$/gm)];
    for (const [, name, body] of lines) {
      this.#world.send(name, `Got it: ${body}`);
    }
    return lines.map(([, name, body]) => `${name} says: ${body}`).join(" ") ||
      "(quiet)";
  }

  async #answer(text: string): Promise<string> {
    const lower = text.toLowerCase();
    const tiles = this.#world.tiles();
    const n = lower.match(/\btile\s*(\d+)/);
    if (n) {
      const t = tiles[Number(n[1]) - 1];
      return t
        ? `Tile ${n[1]} is ${t.name}${
          t.harness ? ` (${t.harness})` : ""
        }, ${t.status}.`
        : `There is no tile ${n[1]}; I see ${tiles.length}.`;
    }
    if (lower.includes("summarize the window")) {
      return `${tiles.length} tile${tiles.length === 1 ? "" : "s"}: ${
        tiles.map((t) => `${t.name} is ${t.status}`).join(", ")
      }.`;
    }
    if (/\b(open|new|spawn)\b.*\btile\b/.test(lower)) {
      const r = await this.#world.control({ kind: "spawn" });
      return r.ok ? "I opened a new tile." : `I couldn't: ${r.error}`;
    }
    return `(demo) I heard "${text}". In the app, Claude Code answers here.`;
  }
}
