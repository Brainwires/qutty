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
//
// Voice (app/use-voice.ts): a mic button beside Loopy (hold to talk; a short click keeps listening
// until the next click), a Summarize button ("what's going on in the window?") and, while an
// answer is read aloud, a stop button. With review on, a transcript waits in the chat box with
// Send / Edit / Cancel before it goes to the companion (or, in dictate mode, the focused tile).
// Loopy shows the voice turn as the example does: it listens (the head glows), thinks while the
// transcript is made, and moves its mouth while an answer or alert is read aloud (lip-sync).

import { useEffect, useReducer, useRef, useState } from "denext";
import type { Dispatch } from "denext";
import { Loopy, type LoopyProps } from "./loopy.tsx";
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
import type { VoiceApi } from "../use-voice.ts";
import type { VoicePhase } from "../../lib/voice/controller.ts";
import { TALK_STEP_MS, talkStep } from "../../lib/companion/lip-sync.ts";

export interface CompanionOverlayProps {
  backend: PtyBackend;
  corner: CompanionCorner;
  /** Whether the brain may run (else the chat box says how to turn it on). */
  brain: boolean;
  reducedMotion: boolean;
  /** Give the keyboard back to the focused tile. */
  onRefocus(): void;
  /** The voice layer (absent: no mic or summary buttons). */
  voice?: VoiceApi;
  /** The hold-to-talk key's label (`⌘⇧M`), or `""` when it is off. */
  pttLabel?: string;
}

/** What the voice note says in each phase (the error and notes bring their own text). */
const PHASE_NOTE: Partial<Record<VoicePhase, string>> = {
  starting: "Starting the microphone…",
  listening: "Listening…",
  transcribing: "Transcribing…",
};

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

/** A transcript waiting for review in the chat box. */
interface Review {
  transcript: string;
  target: "companion" | "dictate";
  onSend(text: string): void;
  onCancel(): void;
}

/** A transcript under review: Send, Edit (the line becomes editable), Cancel. */
function ReviewBox(props: { review: Review }) {
  const { review } = props;
  const [draft, setDraft] = useState(review.transcript);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  const send = () => {
    const text = draft.trim();
    if (text) review.onSend(text);
    else review.onCancel();
  };
  return (
    <form
      class="companion-chat voice-review"
      data-testid="voice-review"
      data-target={review.target}
      data-loopy-hit=""
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <span class="voice-review-to">
        {review.target === "dictate"
          ? "Type into the focused tile"
          : "Send to Loopy"}
      </span>
      <input
        ref={inputRef}
        type="text"
        class="companion-chat-input"
        data-testid="voice-review-text"
        aria-label="What you said"
        readOnly={!editing}
        value={draft}
        maxLength={4000}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          review.onCancel();
        }}
      />
      <div class="voice-review-actions">
        <button type="submit" data-testid="voice-review-send">Send</button>
        <button
          type="button"
          data-testid="voice-review-edit"
          disabled={editing}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          type="button"
          data-testid="voice-review-cancel"
          onClick={review.onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
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

/** What Loopy does in the voice turn: listens, thinks while transcribing, or speaks. */
function loopyVoice(
  phase: VoicePhase,
  speaking: boolean,
): LoopyProps["voice"] {
  if (phase === "starting" || phase === "listening") return "listening";
  if (phase === "transcribing") return "thinking";
  return speaking ? "speaking" : undefined;
}

/**
 * Loopy's mouth step while something is said: the talking pattern, a step every
 * {@linkcode TALK_STEP_MS}; with reduced motion a steady open mouth. Closed (0) otherwise.
 */
function useTalkStep(speaking: boolean, reducedMotion: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!speaking || reducedMotion) return;
    setTick(0);
    const timer = setInterval(() => setTick((t) => t + 1), TALK_STEP_MS);
    return () => clearInterval(timer);
  }, [speaking, reducedMotion]);
  if (!speaking) return 0;
  return reducedMotion ? 2 : talkStep(tick);
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

  const voice = props.voice;
  const voicePhase = voice?.state.phase ?? "idle";
  const loopyVoiceTurn = loopyVoice(voicePhase, voice?.speaking === true);
  const talk = useTalkStep(
    loopyVoiceTurn === "speaking",
    props.reducedMotion,
  );
  const voiceNote = voice
    ? voice.state.message || PHASE_NOTE[voicePhase] || ""
    : "";
  const review: Review | undefined = voice && voicePhase === "review"
    ? {
      transcript: voice.state.transcript,
      target: voice.state.target,
      onSend: (text) => {
        voice.send(text);
        props.onRefocus();
      },
      onCancel: () => {
        voice.cancel();
        props.onRefocus();
      },
    }
    : undefined;

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
      data-voice={voicePhase}
      data-speaking={voice?.speaking ? "true" : "false"}
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
      {review
        ? <ReviewBox key={review.transcript} review={review} />
        : chatOpen && (
          <ChatBox
            brain={props.brain}
            onSend={(text) => {
              voice?.stopSpeaking();
              void backend.companionSend(text).catch(() => {});
            }}
            onClose={closeChat}
          />
        )}
      {voiceNote && (
        <p
          class="voice-note"
          data-testid="voice-note"
          data-phase={voicePhase}
          role="status"
        >
          {voiceNote}
        </p>
      )}
      <div class="stage">
        <div class="squash" ref={squashRef} data-loopy-hit="">
          <Loopy
            state={model.loopy.state}
            mood={loopyMood(current, model.loopy.state)}
            voice={loopyVoiceTurn}
            level={talk}
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
        {voice && (
          <VoiceButtons
            voice={voice}
            pttLabel={props.pttLabel ?? ""}
            onDone={() => {
              if (!chatOpen) props.onRefocus();
            }}
          />
        )}
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

/** The mic (hold to talk; a short click latches), Summarize, and Stop while speaking. */
function VoiceButtons(props: {
  voice: VoiceApi;
  pttLabel: string;
  /** A voice button was used: give the keyboard back. */
  onDone(): void;
}) {
  const { voice } = props;
  const downAt = useRef<number | undefined>(undefined);
  const phase = voice.state.phase;
  const listening = phase === "listening" || phase === "starting";
  const micTitle = listening
    ? voice.state.latched
      ? "Listening: click to stop"
      : "Listening: let go to stop"
    : `Hold to talk${
      props.pttLabel ? ` (or hold ${props.pttLabel})` : ""
    }; click to keep listening`;
  const up = () => {
    if (downAt.current === undefined) return;
    const held = Date.now() - downAt.current;
    downAt.current = undefined;
    voice.release(held);
    props.onDone();
  };
  return (
    <div class="voice-buttons" data-loopy-hit="">
      <button
        type="button"
        class="voice-mic"
        data-testid="loopy-mic"
        data-phase={phase}
        data-latched={voice.state.latched ? "true" : "false"}
        aria-pressed={listening}
        aria-label={micTitle}
        title={micTitle}
        onPointerDown={(e) => {
          e.preventDefault();
          downAt.current = Date.now();
          voice.press();
        }}
        onPointerUp={up}
        onPointerLeave={up}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
          <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.5" />
        </svg>
      </button>
      <button
        type="button"
        class="voice-summarize"
        data-testid="loopy-summarize"
        aria-label="Summarize the window"
        title="Summarize the window (or say “what's going on?”)"
        onClick={() => {
          voice.summarize();
          props.onDone();
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4h10M3 8h10M3 12h6" />
        </svg>
      </button>
      {voice.speaking && (
        <button
          type="button"
          class="voice-stop"
          data-testid="loopy-stop-speaking"
          aria-label="Stop speaking"
          title="Stop speaking"
          onClick={() => {
            voice.stopSpeaking();
            props.onDone();
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="4" y="4" width="8" height="8" rx="1.5" />
          </svg>
        </button>
      )}
    </div>
  );
}
