// Loopy's reactions to finished jobs (lib/companion/reactions.ts): the workspace hands the overlay
// each new reaction, and this plays it for a moment — the `success` mood with the example's
// `celebrate` hop (no hop with reduced motion), or the `sad` face — when nothing above reactions
// holds Loopy's face (lib/companion/loopy-priority.ts `mayStartReaction`). One that arrives while
// a question, a message, thinking or a voice turn is up is dropped: it is brief news.

import { useEffect, useRef, useState } from "denext";
import type { Dispatch } from "denext";
import type { CompanionEvent } from "../../lib/companion/companion-state.ts";
import { type Reaction, REACTION_MS } from "../../lib/companion/reactions.ts";

export interface LoopyReactionOptions {
  /** The latest reaction (a new `id` plays it). */
  readonly reaction: Reaction | undefined;
  /** Nothing above reactions holds the face now. */
  readonly canStart: boolean;
  readonly reducedMotion: boolean;
  readonly dispatch: Dispatch<CompanionEvent>;
  /** It played (the workspace may say it aloud). */
  readonly onShown?: (reaction: Reaction) => void;
}

/** The reaction playing, or `null`. */
export function useLoopyReaction(opts: LoopyReactionOptions): Reaction | null {
  const [active, setActive] = useState<Reaction | null>(null);
  const live = useRef(opts);
  live.current = opts;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = opts.reaction?.id;
  useEffect(() => {
    const o = live.current;
    const r = o.reaction;
    if (!r || !o.canStart) return;
    setActive(r);
    if (r.kind === "celebrate" && !o.reducedMotion) {
      o.dispatch({ type: "say", mood: "success" });
    }
    o.onShown?.(r);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setActive(null), REACTION_MS[r.kind]);
  }, [id]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return active;
}
