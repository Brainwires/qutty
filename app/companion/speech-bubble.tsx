// The speech bubble the companion talks in: the text, up to three buttons, and a close button. It
// closes itself after `message.timeoutMs` (0: only when the user closes it or presses a button).
//
// Ported from Denext's examples/companion (components/SpeechBubble.tsx; same author, MIT). Qutty
// adds who a message is from (an agent's `ask_user`, a `qutty-hook say`), a small note under the
// text (the tool the companion is using), and test ids.
import { useEffect } from "denext";
import type { CompanionMessage } from "../../lib/companion/messages.ts";

/** The props of {@linkcode SpeechBubble}. */
export interface SpeechBubbleProps {
  /** What to say. */
  readonly message: CompanionMessage;
  /** A small line under the text (`using read_screen`). */
  readonly note?: string;
  /** How many more messages wait behind this one. */
  readonly more?: number;
  /** A button was pressed (the bubble is done). */
  readonly onAction: (actionId: string) => void;
  /** The bubble closed: the close button, or its time ran out. */
  readonly onClose: () => void;
}

/** A speech bubble pointing at the companion. */
export function SpeechBubble(
  { message, note, more = 0, onAction, onClose }: SpeechBubbleProps,
) {
  useEffect(() => {
    if (message.timeoutMs <= 0) return;
    const timer = setTimeout(onClose, message.timeoutMs);
    return () => clearTimeout(timer);
  }, [message.id, message.timeoutMs]);

  return (
    <div
      class="bubble"
      data-mood={message.mood}
      data-kind={message.kind ?? "say"}
      data-companion-hit=""
      data-testid="companion-bubble"
      data-message-id={message.id}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        class="bubble-close"
        aria-label="Close"
        data-testid="companion-bubble-close"
        onClick={() => onClose()}
      >
        ×
      </button>
      {(message.from || more > 0) && (
        <p class="bubble-from">
          {message.from && (
            <span data-testid="companion-bubble-from">{message.from}</span>
          )}
          {message.kind === "ask" && <span class="bubble-asks">asks</span>}
          {more > 0 && (
            <span class="bubble-more" data-testid="companion-bubble-more">
              +{more} more
            </span>
          )}
        </p>
      )}
      <p class="bubble-text" data-testid="companion-bubble-text">
        {message.text}
      </p>
      {note && (
        <p class="bubble-note" data-testid="companion-bubble-note">
          {note}
        </p>
      )}
      {message.actions.length > 0 && (
        <div class="bubble-actions">
          {message.actions.map((a) => (
            <button
              type="button"
              key={a.id}
              data-testid="companion-action"
              data-action={a.label}
              onClick={() => onAction(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
