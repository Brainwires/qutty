/**
 * Which face Loopy wears when several want it at once, as one pure function so the order is
 * unit-tested and the overlay (app/companion/companion-overlay.tsx) only draws the answer:
 *
 *   attention (an agent's ask_user question)
 *   > another message on screen (a reply, `qutty-hook say`)
 *   > thinking / a voice turn
 *   > a reaction (sad or celebrate, brief: lib/companion/reactions.ts)
 *   > hot (lib/sysstats.ts)
 *   > excited (the pointer came near: lib/companion/loopy-life.ts)
 *   > sleepy (at night: lib/companion/sleepy.ts)
 *   > idle life (micro-expressions, the eyes on the pointer)
 *
 * A face lower in the list never covers one above it; a reaction that arrives while a higher face
 * is up is dropped (it is brief news, stale a moment later), and anything above sleepy wakes
 * Loopy.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { LoopyMood } from "./loopy-machine.ts";
import type { ReactionKind } from "./reactions.ts";

/** A face that wants Loopy, highest first. */
export const FACE_LAYERS = [
  "attention",
  "message",
  "thinking",
  "voice",
  "reaction",
  "hot",
  "excited",
  "sleepy",
  "life",
] as const;

export type FaceLayer = typeof FACE_LAYERS[number];

/** What wants Loopy's face right now. */
export interface FaceInputs {
  /** A message is on screen, and whether it is a question (`attention`). */
  readonly message: "attention" | "other" | null;
  /** The companion's brain works (Loopy thinks). */
  readonly thinking: boolean;
  /** A voice turn: listening, transcribing, speaking. */
  readonly voice: boolean;
  /** A reaction is playing. */
  readonly reaction: ReactionKind | null;
  /** The machine is hot (and Settings allows the hot face). */
  readonly hot: boolean;
  /** The pointer's excitement is on. */
  readonly excited: boolean;
  /** Loopy sleeps (at night, idle). */
  readonly sleepy: boolean;
}

/** The rank of a layer: 0 is the highest. */
function rank(layer: FaceLayer): number {
  return FACE_LAYERS.indexOf(layer);
}

/** The face on top. */
export function topLayer(i: FaceInputs): FaceLayer {
  if (i.message === "attention") return "attention";
  if (i.message === "other") return "message";
  if (i.thinking) return "thinking";
  if (i.voice) return "voice";
  if (i.reaction) return "reaction";
  if (i.hot) return "hot";
  if (i.excited) return "excited";
  if (i.sleepy) return "sleepy";
  return "life";
}

/** Whether a new reaction may start now: nothing above reactions is up. */
export function mayStartReaction(i: FaceInputs): boolean {
  return rank(topLayer({ ...i, reaction: null })) > rank("reaction");
}

/** Whether something above sleepy wants Loopy (it wakes). */
export function wakesLoopy(i: FaceInputs): boolean {
  return rank(topLayer({ ...i, sleepy: false })) < rank("sleepy");
}

/** What the overlay draws for the top layer. */
export interface FaceChoice {
  readonly layer: FaceLayer;
  /**
   * The mood to wear when no message gives one (the reaction's, excited, sleepy); `undefined`
   * leaves the overlay's own (a message's mood, thinking) or none.
   */
  readonly mood: LoopyMood | undefined;
  /** The hot face. */
  readonly hot: boolean;
  /** The idle life (micro-expressions, delight) may show. */
  readonly life: boolean;
}

/** The face for `i`. */
export function chooseFace(i: FaceInputs): FaceChoice {
  const layer = topLayer(i);
  const mood: LoopyMood | undefined = layer === "reaction"
    ? (i.reaction === "celebrate" ? "success" : "sad")
    : layer === "excited"
    ? "excited"
    : layer === "sleepy"
    ? "sleepy"
    : undefined;
  return { layer, mood, hot: layer === "hot", life: layer === "life" };
}
