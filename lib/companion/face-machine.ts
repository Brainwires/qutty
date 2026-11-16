// Ported from Denext's examples/companion (lib/loopy-machine.ts on feat/loopy-voice-tools: the
// crossed-triangle the companion with 13 moods; same author, MIT) unchanged.
//
// The companion's animation state machine: a pure reducer the page runs with `useReducer`. Each
// state is one of the companion's moves (styles.css draws them from the `data-state` attribute);
// the timed ones end on their own when the page sends `settle` after {@linkcode stateDurationMs}.
//
//   hidden ─show/say─▶ appear ─settle─▶ idle ◀─settle─ blink / celebrate
//                                       │ ▲
//                         say(mood) ────┘ └──── settle ─ think / point (held while a bubble is up)
//   any visible state ─dismiss─▶ dismiss ─settle─▶ hidden

/** A move the companion can be in. */
export type FaceState =
  | "hidden"
  | "appear"
  | "idle"
  | "blink"
  | "think"
  | "point"
  | "celebrate"
  | "dismiss";

/** How a message wants the companion to look while it speaks. */
export type FaceMood =
  | "neutral"
  | "thinking"
  | "attention"
  | "success"
  | "confused"
  | "mad"
  | "sad"
  | "excited"
  | "sleepy"
  | "love"
  | "surprised"
  | "shocked"
  | "wow";

/** Every mood, for validation. */
export const MOODS: readonly FaceMood[] = [
  "neutral",
  "thinking",
  "attention",
  "success",
  "confused",
  "mad",
  "sad",
  "excited",
  "sleepy",
  "love",
  "surprised",
  "shocked",
  "wow",
];

/** What the machine holds. */
export interface FaceModel {
  /** The move on screen. */
  readonly state: FaceState;
  /**
   * The mood to take once an `appear` lands (a message that arrived while the companion was
   * hidden).
   */
  readonly pendingMood: FaceMood | null;
}

/** What can happen to the companion. */
export type FaceEvent =
  | { readonly type: "show" }
  | { readonly type: "say"; readonly mood: FaceMood }
  | { readonly type: "blink" }
  | { readonly type: "settle" }
  | { readonly type: "dismiss" };

/** Where the companion starts: folded away until the page shows it. */
export const INITIAL_MODEL: FaceModel = { state: "hidden", pendingMood: null };

/** The move a mood maps to. */
export function moodState(mood: FaceMood): FaceState {
  switch (mood) {
    case "thinking":
    case "confused":
      return "think";
    case "attention":
      return "point";
    case "success":
    case "excited":
    case "love":
    case "wow":
      return "celebrate";
    case "neutral":
    case "mad":
    case "sad":
    case "sleepy":
    case "surprised":
    case "shocked":
      return "idle";
  }
}

/**
 * How long a timed move lasts before the page sends `settle` (its CSS animation is the same
 * length), or `null` for a move that holds until something else happens.
 */
export function stateDurationMs(state: FaceState): number | null {
  switch (state) {
    case "appear":
      return 650;
    case "blink":
      return 160;
    case "celebrate":
      return 1200;
    case "dismiss":
      return 450;
    default:
      return null;
  }
}

/**
 * What the page should send on its own, and after how long: `settle` once a timed move ends, or a
 * `blink` 2.5–6 s into an idle spell. `null` while a move holds.
 *
 * @param state The move on screen.
 * @param random A number in [0, 1) that picks the blink delay (`Math.random` by default).
 */
export function nextTimer(
  state: FaceState,
  random: () => number = Math.random,
): { readonly event: FaceEvent; readonly ms: number } | null {
  if (state === "idle") {
    return { event: { type: "blink" }, ms: 2_500 + random() * 3_500 };
  }
  const ms = stateDurationMs(state);
  return ms === null ? null : { event: { type: "settle" }, ms };
}

/** Whether the companion is on screen (anything but `hidden` and the fold-away). */
export function isVisible(state: FaceState): boolean {
  return state !== "hidden" && state !== "dismiss";
}

const at = (
  state: FaceState,
  pendingMood: FaceMood | null = null,
): FaceModel => ({
  state,
  pendingMood,
});

/** Where `settle` goes from the current move. */
function settled(model: FaceModel): FaceModel {
  switch (model.state) {
    case "appear":
      return at(model.pendingMood ? moodState(model.pendingMood) : "idle");
    case "blink":
    case "celebrate":
    case "think":
    case "point":
      return at("idle");
    case "dismiss":
      return at("hidden");
    default:
      return model;
  }
}

/**
 * The next model for `event`. Unknown or meaningless events (a blink while hidden, a settle while
 * idle) return the model unchanged, so the page may send them freely.
 */
export function transition(model: FaceModel, event: FaceEvent): FaceModel {
  switch (event.type) {
    case "show":
      return model.state === "hidden" || model.state === "dismiss"
        ? at("appear")
        : model;
    case "say":
      // Hidden (or folding away): spring back up first, then take the mood.
      if (!isVisible(model.state)) return at("appear", event.mood);
      // Still landing: take the mood once the landing ends.
      if (model.state === "appear") return at("appear", event.mood);
      return at(moodState(event.mood));
    case "blink":
      return model.state === "idle" ? at("blink") : model;
    case "settle":
      return settled(model);
    case "dismiss":
      return isVisible(model.state) ? at("dismiss") : model;
  }
}
