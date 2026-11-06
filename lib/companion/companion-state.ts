// The companion's whole state: Loopy's move (lib/companion/loopy-machine.ts) and the queue of
// messages waiting to be said, the first one on screen. A pure reducer, so the overlay component
// stays thin and the flow is unit-tested: a message springs Loopy up in its mood, the next one
// takes over when a bubble closes, and folding up drops them all.
//
// Ported from Denext's examples/companion (lib/companion-state.ts; same author, MIT). Qutty adds:
//
// - `update`: a message already queued changes (the companion's reply streams in: its text grows,
//   and its mood goes from `thinking` to `neutral` when the turn ends). On screen, a new mood
//   moves Loopy; a message without a timeout keeps its place until it is closed.
// - `drop`: a message leaves the queue wherever it is (an `ask_user` question answered elsewhere).
//
// While the companion works on a turn with nothing on screen, the overlay sends the machine's own
// `say` (mood `thinking`), and `settle` when the turn ends.

import {
  INITIAL_MODEL,
  type LoopyEvent,
  type LoopyModel,
  transition,
} from "./loopy-machine.ts";
import type { LoopyMessage } from "./messages.ts";

/** The most messages waiting behind the one on screen; more are dropped. */
export const MAX_QUEUE = 20;

/** Loopy's move and the messages to say. */
export interface CompanionModel {
  readonly loopy: LoopyModel;
  /** The message on screen first, then the waiting ones. */
  readonly queue: readonly LoopyMessage[];
}

/** What can happen: one of Loopy's own events, or a message arriving, changing, finishing, or all dropped. */
export type CompanionEvent =
  | LoopyEvent
  | { readonly type: "enqueue"; readonly message: LoopyMessage }
  | {
    readonly type: "update";
    readonly id: string;
    readonly patch: Partial<Omit<LoopyMessage, "id">>;
  }
  | { readonly type: "finish"; readonly id: string }
  | { readonly type: "drop"; readonly id: string }
  | { readonly type: "foldUp" };

/** Nothing to say, folded away. */
export const INITIAL_COMPANION: CompanionModel = {
  loopy: INITIAL_MODEL,
  queue: [],
};

/** Loopy's move for `message` coming on screen. */
const sayIt = (loopy: LoopyModel, message: LoopyMessage) =>
  transition(loopy, { type: "say", mood: message.mood });

/** A new message: on screen at once when nothing else is, else at the back of the queue. */
function enqueue(
  model: CompanionModel,
  message: LoopyMessage,
): CompanionModel {
  if (model.queue.length > MAX_QUEUE) return model;
  if (model.queue.some((m) => m.id === message.id)) return model;
  const queue = [...model.queue, message];
  return {
    queue,
    loopy: model.queue.length === 0 ? sayIt(model.loopy, message) : model.loopy,
  };
}

/** Message `id` changed; a new mood on screen moves Loopy. Unknown ids change nothing. */
function update(
  model: CompanionModel,
  id: string,
  patch: Partial<Omit<LoopyMessage, "id">>,
): CompanionModel {
  const i = model.queue.findIndex((m) => m.id === id);
  if (i < 0) return model;
  const before = model.queue[i];
  const after: LoopyMessage = { ...before, ...patch, id };
  const queue = model.queue.map((m, j) => j === i ? after : m);
  const moved = i === 0 && after.mood !== before.mood;
  return { queue, loopy: moved ? sayIt(model.loopy, after) : model.loopy };
}

/** The message on screen is done: say the next one, or settle down. */
function finish(model: CompanionModel, id: string): CompanionModel {
  if (model.queue[0]?.id !== id) return model;
  const queue = model.queue.slice(1);
  const loopy = queue.length > 0
    ? sayIt(model.loopy, queue[0])
    : transition(model.loopy, { type: "settle" });
  return { queue, loopy };
}

/** Message `id` goes, on screen (then like `finish`) or waiting. */
function drop(model: CompanionModel, id: string): CompanionModel {
  if (model.queue[0]?.id === id) return finish(model, id);
  const queue = model.queue.filter((m) => m.id !== id);
  return queue.length === model.queue.length ? model : { ...model, queue };
}

/** The next model for `event`. */
export function companionReducer(
  model: CompanionModel,
  event: CompanionEvent,
): CompanionModel {
  switch (event.type) {
    case "enqueue":
      return enqueue(model, event.message);
    case "update":
      return update(model, event.id, event.patch);
    case "finish":
      return finish(model, event.id);
    case "drop":
      return drop(model, event.id);
    case "foldUp":
      return { queue: [], loopy: transition(model.loopy, { type: "dismiss" }) };
    default:
      return { ...model, loopy: transition(model.loopy, event) };
  }
}
