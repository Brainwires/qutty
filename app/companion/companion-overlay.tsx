// Loopy in the window: the companion overlay in a corner of the tile area. Its speech bubble
// shows, one at a time and in arrival order:
//
// - agents' `ask_user` questions, with a button per answer (the waiting caller gets the label;
//   the close button answers "dismissed"). This replaces the ask dialog (app/ask-dialog.tsx),
//   which stays as the fallback while the companion is Off;
// - `qutty-hook say …` messages (a `--wait` sender gets the button pressed);
// - the companion's replies, streamed in as its brain writes them, and its notes on agents'
//   messages.
//
// Clicking Loopy opens the chat box under the bubble: what is typed there goes to the companion's
// brain (desktop/companion.ts). Loopy thinks (its `think` move) while the brain works, and a dot
// beside it shows the brain's status. Everything else in the overlay lets clicks through to the
// tiles underneath (`pointer-events: none` but on Loopy, the bubble and the chat box).
//
// The bubble never takes the keyboard by itself (a question can arrive mid-typing); after a
// button or the close, the keyboard goes back to the focused tile. Escape in the chat box closes
// it the same way.

import { useEffect, useReducer, useRef, useState } from "denext";
import type { Dispatch } from "denext";
import { Loopy } from "./loopy.tsx";
import { SpeechBubble } from "./speech-bubble.tsx";
import {
  type CompanionEvent,
  companionReducer,
  INITIAL_COMPANION,
} from "../../lib/companion/companion-state.ts";
import {
  type LoopyModel,
  type LoopyMood,
  type LoopyState,
  nextTimer,
} from "../../lib/companion/loopy-machine.ts";
import type { LoopyMessage } from "../../lib/companion/messages.ts";
import {
  askAnswer,
  askBubble,
  askBubbleId,
  askIdOf,
  turnBubble,
} from "../../lib/companion/bubbles.ts";
import type {
  CompanionCorner,
  CompanionStatus,
} from "../../lib/companion/protocol.ts";
import type { AskRequest } from "../../lib/hub/protocol.ts";
import type { PtyBackend } from "../../lib/pty-client.ts";

export interface CompanionOverlayProps {
  backend: PtyBackend;
  corner: CompanionCorner;
  /** Whether the brain may run (else the chat box says how to turn it on). */
  brain: boolean;
  reducedMotion: boolean;
  /** Give the keyboard back to the focused tile. */
  onRefocus(): void;
}

/** What the status dot says. */
const STATE_LABEL: Record<CompanionStatus["state"], string> = {
  stopped: "asleep (wakes on first use)",
  starting: "starting",
  ready: "ready",
  thinking: "thinking",
  error: "stopped with an error",
};

/** Squash and stretch, through the Web Animations API where the engine has it. */
function squash(el: Element | null): void {
  const target = el as (Element & { animate?: Element["animate"] }) | null;
  if (typeof target?.animate !== "function") return;
  target.animate([
    { transform: "scale(1, 1)" },
    { transform: "scale(1.18, 0.8)", offset: 0.3 },
    { transform: "scale(0.9, 1.12)", offset: 0.6 },
    { transform: "scale(1.03, 0.97)", offset: 0.85 },
    { transform: "scale(1, 1)" },
  ], { duration: 420, easing: "ease-out" });
}

/** End timed moves on time, and blink now and then while idle. */
function useTimedMoves(
  loopy: LoopyModel,
  dispatch: Dispatch<CompanionEvent>,
): void {
  useEffect(() => {
    const next = nextTimer(loopy.state);
    if (!next) return;
    const timer = setTimeout(() => dispatch(next.event), next.ms);
    return () => clearTimeout(timer);
  }, [loopy]);
}

/** The bubbles' sources: questions, `say` messages, the brain's turns and status. */
function useCompanionFeed(
  backend: PtyBackend,
  dispatch: Dispatch<CompanionEvent>,
  closed: Set<string>,
) {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const asks = useRef(new Map<string, AskRequest>());
  const waiting = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    const enqueue = (message: LoopyMessage) => {
      if (!closed.has(message.id)) dispatch({ type: "enqueue", message });
    };
    const addAsk = (request: AskRequest) => {
      asks.current.set(request.id, request);
      enqueue(askBubble(request));
    };
    const offs = [
      backend.onHubAsk(addAsk),
      backend.onHubAskClosed((id) => {
        closed.add(askBubbleId(id));
        dispatch({ type: "drop", id: askBubbleId(id) });
      }),
      backend.onHubSay(({ message, wait }) => {
        if (wait) waiting.current.add(message.id);
        enqueue({ ...message, kind: "say" });
      }),
      backend.onCompanion((update) => {
        if (update.kind === "status") return setStatus(update.status);
        if (update.kind === "tool") {
          return setNotes((n) => ({
            ...n,
            [`turn:${update.turn}`]: `using ${update.name}`,
          }));
        }
        if (update.kind !== "turn") return;
        const bubble = turnBubble(update);
        if (!bubble || closed.has(bubble.id)) return;
        dispatch({ type: "enqueue", message: bubble });
        dispatch({ type: "update", id: bubble.id, patch: bubble });
        if (update.done) {
          setNotes((n) => {
            const { [bubble.id]: _gone, ...rest } = n;
            return rest;
          });
        }
      }),
    ];
    backend.hubSnapshot().then(
      (snapshot) => {
        if (live) snapshot.asks.forEach(addAsk);
      },
      () => {},
    );
    backend.companionStatus().then(
      (s) => {
        if (live) setStatus((now) => now ?? s.status);
      },
      () => {},
    );
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, [backend]);

  /** A bubble is done (a button: `actionId`; closed: `null`): answer whoever waits for it. */
  const answer = (message: LoopyMessage, actionId: string | null) => {
    const askId = askIdOf(message.id);
    if (askId) {
      const request = asks.current.get(askId);
      asks.current.delete(askId);
      void backend.hubAnswer(askId, askAnswer(request, message, actionId))
        .catch(() => {});
    } else if (waiting.current.delete(message.id)) {
      void backend.companionSayDone(message.id, actionId).catch(() => {});
    }
  };

  return { status, notes, answer };
}

/** The chat box: one line to the companion; Escape closes it. */
function ChatBox(props: {
  brain: boolean;
  onSend(text: string): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const off = !props.brain;
  return (
    <form
      class="companion-chat"
      data-testid="loopy-chat"
      data-loopy-hit=""
      onSubmit={(e) => {
        e.preventDefault();
        const text = draft.trim();
        if (!text || off) return;
        props.onSend(text);
        setDraft("");
      }}
    >
      <input
        ref={inputRef}
        type="text"
        class="companion-chat-input"
        data-testid="loopy-chat-input"
        aria-label="Ask Loopy"
        placeholder={off
          ? "My brain is off (Settings → Companion)"
          : "Ask Loopy…"}
        disabled={off}
        value={draft}
        maxLength={4000}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }}
      />
      <button
        type="submit"
        class="companion-chat-send"
        data-testid="loopy-chat-send"
        aria-label="Send"
        title="Send"
        disabled={off || !draft.trim()}
      >
        ↵
      </button>
    </form>
  );
}

/**
 * The mood Loopy wears: the message's on screen (as in the example), else `thinking` while it
 * thinks with nothing to show (the brain working), else none (bare steel).
 */
function loopyMood(
  current: LoopyMessage | undefined,
  state: LoopyState,
): LoopyMood | undefined {
  if (current) return current.mood;
  return state === "think" ? "thinking" : undefined;
}

/** Loopy, its bubble and its chat box, in a corner of the tile area. */
export function CompanionOverlay(props: CompanionOverlayProps) {
  const { backend } = props;
  const [model, dispatch] = useReducer(companionReducer, INITIAL_COMPANION);
  // Bubbles finished here: a late snapshot or update must not bring them back.
  const closedRef = useRef(new Set<string>());
  const squashRef = useRef<HTMLDivElement>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const feed = useCompanionFeed(backend, dispatch, closedRef.current);
  useTimedMoves(model.loopy, dispatch);
  useEffect(() => dispatch({ type: "show" }), []);

  const current = model.queue[0];
  const thinking = feed.status?.state === "thinking" ||
    feed.status?.state === "starting";
  // Working with nothing to show (agents' messages, the brain starting): Loopy thinks.
  const loopyState = model.loopy.state;
  useEffect(() => {
    if (current) return;
    if (thinking && loopyState === "idle") {
      dispatch({ type: "say", mood: "thinking" });
    } else if (!thinking && loopyState === "think") {
      dispatch({ type: "settle" });
    }
  }, [thinking, loopyState, current?.id]);

  const finish = (message: LoopyMessage, actionId: string | null) => {
    closedRef.current.add(message.id);
    feed.answer(message, actionId);
    dispatch({ type: "finish", id: message.id });
  };
  /** Finished by a click in the bubble: the keyboard goes back to the tile. */
  const finishByHand = (message: LoopyMessage, actionId: string | null) => {
    finish(message, actionId);
    if (!chatOpen) props.onRefocus();
  };
  const poke = () => {
    if (!props.reducedMotion) squash(squashRef.current);
    setChatOpen((open) => !open);
  };
  const closeChat = () => {
    setChatOpen(false);
    props.onRefocus();
  };

  const status = feed.status;
  const statusLabel = status
    ? `${status.adapter}: ${
      status.enabled ? STATE_LABEL[status.state] : "off"
    }${status.detail && status.state === "error" ? ` (${status.detail})` : ""}`
    : "";

  return (
    <div
      class="companion-overlay"
      data-testid="companion-overlay"
      data-corner={props.corner}
      data-loopy-state={model.loopy.state}
      data-brain={status ? (status.enabled ? status.state : "off") : ""}
    >
      <div class="bubble-slot">
        {current && (
          <SpeechBubble
            key={current.id}
            message={current}
            note={feed.notes[current.id]}
            more={model.queue.length - 1}
            onAction={(id) => finishByHand(current, id)}
            onClose={() => finish(current, null)}
          />
        )}
      </div>
      {chatOpen && (
        <ChatBox
          brain={props.brain}
          onSend={(text) => void backend.companionSend(text).catch(() => {})}
          onClose={closeChat}
        />
      )}
      <div class="stage">
        <div class="squash" ref={squashRef} data-loopy-hit="">
          <Loopy
            state={model.loopy.state}
            mood={loopyMood(current, model.loopy.state)}
          />
          <button
            type="button"
            class="poke"
            data-testid="loopy-poke"
            aria-label={chatOpen
              ? "Close the chat with Loopy"
              : "Talk to Loopy"}
            aria-expanded={chatOpen}
            title={chatOpen ? "Close the chat" : "Talk to Loopy"}
            onClick={poke}
          />
        </div>
        {status && (
          <span
            class="companion-status"
            data-testid="loopy-status"
            data-state={status.enabled ? status.state : "off"}
            title={statusLabel}
            aria-label={statusLabel}
            role="img"
          />
        )}
      </div>
    </div>
  );
}
