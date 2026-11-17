// The companion in the window: the companion overlay in a corner of the tile area. Its speech
// bubble shows, one at a time and in arrival order:
//
// - agents' `ask_user` questions, with a button per answer (the waiting caller gets the label;
//   the close button answers "dismissed"). This replaces the ask dialog (app/ask-dialog.tsx),
//   which stays as the fallback while the companion is Off;
// - `qutty-hook say …` messages (a `--wait` sender gets the button pressed);
// - the companion's replies, streamed in as its brain writes them, and its notes on agents'
//   messages.
//
// Clicking the companion opens the chat box under the bubble: what is typed there goes to the
// companion's brain (desktop/companion.ts). The companion thinks (its `think` move) while the brain
// works, and a dot beside it shows the brain's status. Everything else in the overlay lets clicks
// through to the tiles underneath (`pointer-events: none` but on the companion, the bubble and the
// chat box).
//
// Dragging the companion (app/companion/use-companion-drag.ts) moves it to another corner: past a
// few pixels a press is a drag, not a click; on release it snaps to the nearest corner, which is
// saved as Settings → Companion → Corner (`onCorner`).
//
// The bubble never takes the keyboard by itself (a question can arrive mid-typing); after a
// button or the close, the keyboard goes back to the focused tile. Escape in the chat box closes
// it the same way.
//
// Voice (app/use-voice.ts): a mic button beside the companion (hold to talk; a short click keeps
// listening until the next click), a Summarize button ("what's going on in the window?") and, while
// an answer is read aloud, a stop button. With review on, a transcript waits in the chat box with
// Send / Edit / Cancel before it goes to the companion (or, in dictate mode, the focused tile).
// The companion shows the voice turn as the example does: it listens (the head glows), thinks while
// the transcript is made, and moves its mouth while an answer or alert is read aloud (lip-sync).
// While it listens, its head swells with the microphone's level (`voice.level`).
//
// Lively (app/companion/use-companion-life.ts): with nothing on screen, the companion makes small
// faces now and then, its eyes follow the pointer, and it gets excited when the pointer comes near.
//
// Reactions (Settings → Companion → Reactions): a hop of joy or a sad face when a long job
// finishes (app/companion/use-companion-reaction.ts), and sleepy at night
// (app/companion/use-companion-sleep.ts). Which face shows when several want the companion is one
// pure function, lib/companion/face-priority.ts: a question > a message > thinking / voice > a
// reaction > hot > excited > sleepy > the idle life.

import { useEffect, useReducer, useRef, useState } from "denext";
import type { Dispatch } from "denext";
import { CompanionFace, type CompanionFaceProps } from "./companion-face.tsx";
import { DEFAULT_COMPANION_NAME } from "../../lib/companion/settings.ts";
import { SpeechBubble } from "./speech-bubble.tsx";
import {
  boxOf,
  unionBox,
  useAreaOverlays,
  useHtmlOverlay,
} from "../use-html-overlay.ts";
import type { AreaOverlay } from "../../lib/web/overlays.ts";
import {
  type CompanionEvent,
  companionReducer,
  INITIAL_COMPANION,
} from "../../lib/companion/companion-state.ts";
import {
  type FaceModel,
  type FaceMood,
  type FaceState,
  nextTimer,
} from "../../lib/companion/face-machine.ts";
import type { CompanionMessage } from "../../lib/companion/messages.ts";
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
import {
  LEVEL_STEPS,
  TALK_STEP_MS,
  talkStep,
} from "../../lib/companion/lip-sync.ts";
import { useCompanionLife } from "./use-companion-life.ts";
import { useCompanionDrag } from "./use-companion-drag.ts";
import { mayLiven } from "../../lib/companion/face-life.ts";
import { mayShowHot } from "../../lib/sysstats.ts";
import {
  chooseFace,
  type FaceInputs,
  mayStartReaction,
} from "../../lib/companion/face-priority.ts";
import type { Reaction } from "../../lib/companion/reactions.ts";
import { useCompanionSleep } from "./use-companion-sleep.ts";
import { useCompanionReaction } from "./use-companion-reaction.ts";

export interface CompanionOverlayProps {
  backend: PtyBackend;
  /** What the companion is called (Settings → Companion → Name; default "Companion"). */
  name?: string;
  corner: CompanionCorner;
  /** Whether the brain may run (else the chat box says how to turn it on). */
  brain: boolean;
  reducedMotion: boolean;
  /**
   * Settings → Companion → Lively: idle expressions, eyes on the pointer
   * (app/companion/use-companion-life.ts).
   */
  lively?: boolean;
  /** Give the keyboard back to the focused tile. */
  onRefocus(): void;
  /** The companion was dragged to `corner` (saved as Settings → Companion → Corner). */
  onCorner?(corner: CompanionCorner): void;
  /** The voice layer (absent: no mic or summary buttons). */
  voice?: VoiceApi;
  /** The hold-to-talk key's label (`⌘⇧M`), or `""` when it is off. */
  pttLabel?: string;
  /**
   * Qutty's own: the machine is hot (app/use-sysstats.ts, Settings → System monitor). The companion
   * wears its hot face only while it is otherwise idle (lib/sysstats.ts `mayShowHot`).
   */
  hot?: boolean;
  /** The hot face came on (the workspace may say a line about it, rarely). */
  onHotShown?(): void;
  /**
   * Settings → Companion → Reactions: sleepy at night (its hours, minutes since midnight) and
   * the short line beside the companion when it reacts.
   */
  reactions?: {
    readonly nightSleepy: boolean;
    readonly nightFrom: number;
    readonly nightTo: number;
    readonly bubble: boolean;
  };
  /** The latest finished job worth a reaction (app/use-reactions.ts); a new `id` plays it. */
  reaction?: Reaction;
  /** A reaction played (it was not dropped for a face above it). */
  onReactionShown?(reaction: Reaction): void;
  /** Open Settings → Companion at the brain switch (the chat box's link while the brain is off). */
  onOpenSettings?(): void;
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
  avatar: FaceModel,
  dispatch: Dispatch<CompanionEvent>,
): void {
  useEffect(() => {
    const next = nextTimer(avatar.state);
    if (!next) return;
    const timer = setTimeout(() => dispatch(next.event), next.ms);
    return () => clearTimeout(timer);
  }, [avatar]);
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
    const enqueue = (message: CompanionMessage) => {
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
  const answer = (message: CompanionMessage, actionId: string | null) => {
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
function ReviewBox(props: { review: Review; name: string }) {
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
      data-companion-hit=""
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <span class="voice-review-to">
        {review.target === "dictate"
          ? "Type into the focused tile"
          : `Send to ${props.name}`}
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
  /** The companion's name. */
  name: string;
  brain: boolean;
  onSend(text: string): void;
  onClose(): void;
  /** Settings → Companion, offered while the brain is off. */
  onSettings?(): void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const off = !props.brain;
  return (
    <form
      class="companion-chat"
      data-testid="companion-chat"
      data-companion-hit=""
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
        data-testid="companion-chat-input"
        aria-label={`Ask ${props.name}`}
        placeholder={off
          ? "My brain is off (Settings → Companion)"
          : `Ask ${props.name}…`}
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
      {off && props.onSettings
        ? (
          <button
            type="button"
            class="companion-chat-settings"
            data-testid="companion-chat-settings"
            onClick={props.onSettings}
          >
            Settings
          </button>
        )
        : (
          <button
            type="submit"
            class="companion-chat-send"
            data-testid="companion-chat-send"
            aria-label="Send"
            title="Send"
            disabled={off || !draft.trim()}
          >
            ↵
          </button>
        )}
    </form>
  );
}

/**
 * The mood the companion wears: the message's on screen (as in the example), else `thinking` while
 * it thinks with nothing to show (the brain working), else none (bare steel).
 */
function faceMood(
  current: CompanionMessage | undefined,
  state: FaceState,
): FaceMood | undefined {
  if (current) return current.mood;
  return state === "think" ? "thinking" : undefined;
}

/** What the companion does in the voice turn: listens, thinks while transcribing, or speaks. */
function faceVoice(
  phase: VoicePhase,
  speaking: boolean,
): CompanionFaceProps["voice"] {
  if (phase === "starting" || phase === "listening") return "listening";
  if (phase === "transcribing") return "thinking";
  return speaking ? "speaking" : undefined;
}

/**
 * The companion's mouth step while something is said: the talking pattern, a step every
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

/** The companion, its bubble and its chat box, in a corner of the tile area. */
export function CompanionOverlay(props: CompanionOverlayProps) {
  const { backend } = props;
  const [model, dispatch] = useReducer(companionReducer, INITIAL_COMPANION);
  // Bubbles finished here: a late snapshot or update must not bring them back.
  const closedRef = useRef(new Set<string>());
  const squashRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pokeRef = useRef<HTMLButtonElement>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const drag = useCompanionDrag({
    target: pokeRef,
    overlay: overlayRef,
    onDrop: (corner) => props.onCorner?.(corner),
  });
  const feed = useCompanionFeed(backend, dispatch, closedRef.current);
  useTimedMoves(model.avatar, dispatch);
  useEffect(() => dispatch({ type: "show" }), []);

  const current = model.queue[0];
  const thinking = feed.status?.state === "thinking" ||
    feed.status?.state === "starting";
  // Working with nothing to show (agents' messages, the brain starting): the companion thinks.
  const faceState = model.avatar.state;
  useEffect(() => {
    if (current) return;
    if (thinking && faceState === "idle") {
      dispatch({ type: "say", mood: "thinking" });
    } else if (!thinking && faceState === "think") {
      dispatch({ type: "settle" });
    }
  }, [thinking, faceState, current?.id]);

  const finish = (message: CompanionMessage, actionId: string | null) => {
    closedRef.current.add(message.id);
    feed.answer(message, actionId);
    dispatch({ type: "finish", id: message.id });
  };
  /** Finished by a click in the bubble: the keyboard goes back to the tile. */
  const finishByHand = (message: CompanionMessage, actionId: string | null) => {
    finish(message, actionId);
    if (!chatOpen) props.onRefocus();
  };
  const poke = () => {
    if (drag.consumeClick()) return;
    if (!props.reducedMotion) squash(squashRef.current);
    setChatOpen((open) => !open);
  };
  const closeChat = () => {
    setChatOpen(false);
    props.onRefocus();
  };

  const name = props.name ?? DEFAULT_COMPANION_NAME;
  const voice = props.voice;
  const voicePhase = voice?.state.phase ?? "idle";
  const faceVoiceTurn = faceVoice(voicePhase, voice?.speaking === true);
  const talk = useTalkStep(
    faceVoiceTurn === "speaking",
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

  // The faces that want the companion, in their order (lib/companion/face-priority.ts).
  const lively = props.lively !== false;
  const base = {
    lively,
    state: faceState,
    message: current !== undefined,
    voice: faceVoiceTurn !== undefined,
    busy: thinking,
  };
  // Hot: only on an otherwise free face (no question, reply, thinking or voice turn).
  const hotWanted = mayShowHot({
    enabled: lively,
    hot: props.hot === true,
    free: mayLiven({ ...base, awake: true }),
  });
  const inputs: Omit<FaceInputs, "reaction" | "excited" | "sleepy"> = {
    message: current
      ? (current.kind === "ask" || current.mood === "attention"
        ? "attention"
        : "other")
      : null,
    thinking: thinking || faceState === "think",
    voice: faceVoiceTurn !== undefined,
    hot: hotWanted,
  };
  const canReact = mayStartReaction({
    ...inputs,
    reaction: null,
    excited: false,
    sleepy: false,
  });
  const reaction = useCompanionReaction({
    reaction: props.reaction,
    canStart: canReact,
    reducedMotion: props.reducedMotion,
    dispatch,
    ...(props.onReactionShown ? { onShown: props.onReactionShown } : {}),
  });
  const reactions = props.reactions;
  const sleep = useCompanionSleep({
    enabled: reactions?.nightSleepy === true,
    from: reactions?.nightFrom ?? 0,
    to: reactions?.nightTo ?? 0,
    // Anything above sleepy wakes it (excitement cannot start while it sleeps).
    busy: inputs.message !== null || inputs.thinking || inputs.voice ||
      inputs.hot || reaction !== null,
    stage: squashRef,
    reducedMotion: props.reducedMotion,
  });

  const life = useCompanionLife({
    ...base,
    dragging: drag.dragging,
    held: reaction !== null || hotWanted || sleep.asleep,
    stage: squashRef,
    reducedMotion: props.reducedMotion,
    dispatch,
  });
  const face = chooseFace({
    ...inputs,
    reaction: reaction?.kind ?? null,
    excited: life.excited,
    sleepy: sleep.asleep,
  });

  // Over a native web tile (lib/web/overlays.ts): the companion itself stays, so the page makes
  // room for it; its bubble, chat box and notes come and go, so the page under them shows its
  // snapshot meanwhile, as every page does while the companion is dragged.
  const reactionShown = reaction !== null && face.layer === "reaction" &&
    reactions?.bubble !== false;
  const speaking = current !== undefined || review !== undefined || chatOpen ||
    reactionShown || voiceNote !== "";
  useAreaOverlays(overlayRef, (el) => {
    const hit = unionBox(
      [...el.querySelectorAll("[data-companion-hit]")].map((h) => boxOf(h, 6)),
    );
    const areas: AreaOverlay[] = hit ? [{ kind: "keepout", box: hit }] : [];
    if (speaking) areas.push({ kind: "cover", box: boxOf(el, 8) });
    return areas;
  }, [speaking, props.corner, current?.id]);
  useHtmlOverlay(drag.dragging);

  const showHot = face.hot;
  const onHotShown = useRef(props.onHotShown);
  onHotShown.current = props.onHotShown;
  useEffect(() => {
    if (showHot) onHotShown.current?.();
  }, [showHot]);

  const status = feed.status;
  const statusLabel = status
    ? `${status.adapter}: ${
      status.enabled ? STATE_LABEL[status.state] : "off"
    }${status.detail && status.state === "error" ? ` (${status.detail})` : ""}`
    : "";

  return (
    <div
      ref={overlayRef}
      class="companion-overlay"
      data-testid="companion-overlay"
      data-corner={props.corner}
      data-dragging={drag.dragging ? "true" : undefined}
      data-companion-state={model.avatar.state}
      data-brain={status ? (status.enabled ? status.state : "off") : ""}
      data-voice={voicePhase}
      data-speaking={voice?.speaking ? "true" : "false"}
      data-face={face.layer}
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
        ? <ReviewBox key={review.transcript} review={review} name={name} />
        : chatOpen && (
          <ChatBox
            name={name}
            brain={props.brain}
            {...(props.onOpenSettings
              ? { onSettings: props.onOpenSettings }
              : {})}
            onSend={(text) => {
              voice?.stopSpeaking();
              void backend.companionSend(text).catch(() => {});
            }}
            onClose={closeChat}
          />
        )}
      {reaction && face.layer === "reaction" && reactions?.bubble !== false && (
        <p
          class="companion-reaction"
          data-testid="companion-reaction"
          data-kind={reaction.kind}
          role="status"
        >
          {reaction.text}
        </p>
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
        <div class="squash" ref={squashRef} data-companion-hit="">
          <CompanionFace
            label={name}
            state={model.avatar.state}
            mood={faceMood(current, model.avatar.state) ?? face.mood}
            voice={faceVoiceTurn}
            level={faceVoiceTurn === "listening"
              ? (voice?.level ?? 0) * LEVEL_STEPS
              : talk}
            lively={props.lively !== false}
            expression={face.life ? life.expression : undefined}
            hot={showHot}
            asleep={face.layer === "sleepy"}
            stretching={sleep.stretching}
          />
          <button
            ref={pokeRef}
            type="button"
            class="poke"
            data-testid="companion-poke"
            aria-label={chatOpen
              ? `Close the chat with ${name}`
              : `Talk to ${name}`}
            aria-expanded={chatOpen}
            title={chatOpen
              ? `Close the chat (drag to move ${name})`
              : `Talk to ${name} (drag to move it)`}
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
            data-testid="companion-status"
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
    <div class="voice-buttons" data-companion-hit="">
      <button
        type="button"
        class="voice-mic"
        data-testid="companion-mic"
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
        data-testid="companion-summarize"
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
          data-testid="companion-stop-speaking"
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
