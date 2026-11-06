// `ask_user`: an agent's question to the user, as a card in the bottom-right corner with the
// question, who asks, one button per action and a dismiss (answered as `null`). Questions queue:
// the oldest is shown, with a count of the rest. Open questions are re-read from the hub's
// snapshot when the page loads; a question answered elsewhere, or whose tile went away, closes on
// `askClosed`.
//
// The card never takes the keyboard by itself: a question can arrive while the user is typing,
// and a focused button would turn the next Enter into an answer. Escape dismisses it only while
// focus is inside it (like the other dialogs).
//
// Self-contained on purpose: phase 2 moves these questions into the companion's speech bubble.

import { useEffect, useRef, useState } from "denext";
import type { AskRequest } from "../lib/hub/protocol.ts";
import type { PtyBackend } from "../lib/pty-client.ts";

export interface AskDialogProps {
  backend: PtyBackend;
  /** The last open question was answered: give the keyboard back to the terminal. */
  onDone(): void;
}

/** The buttons for a question (the hub's default is a single OK). */
const actionsOf = (request: AskRequest) =>
  request.actions.length > 0 ? request.actions : ["OK"];

export function AskDialog(props: AskDialogProps) {
  const { backend } = props;
  const [queue, setQueue] = useState<AskRequest[]>([]);
  // Questions answered or closed here: a snapshot that resolves late must not bring them back.
  const closedRef = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    const add = (request: AskRequest) => {
      if (closedRef.current.has(request.id)) return;
      setQueue((q) => q.some((r) => r.id === request.id) ? q : [...q, request]);
    };
    const offAsk = backend.onHubAsk(add);
    const offClosed = backend.onHubAskClosed((id) => {
      closedRef.current.add(id);
      setQueue((q) => q.filter((r) => r.id !== id));
    });
    backend.hubSnapshot().then(
      (snapshot) => {
        if (live) snapshot.asks.forEach(add);
      },
      () => {},
    );
    return () => {
      live = false;
      offAsk();
      offClosed();
    };
  }, [backend]);

  const current = queue[0];
  if (!current) return null;

  const reply = (action: string | null) => {
    closedRef.current.add(current.id);
    setQueue((q) => q.filter((r) => r.id !== current.id));
    // `false` (already answered elsewhere) needs nothing more: it is gone either way.
    void backend.hubAnswer(current.id, action).catch(() => {});
    if (queue.length === 1) props.onDone();
  };

  const textId = `ask-text-${current.id}`;
  return (
    <div
      class="ask"
      role="alertdialog"
      aria-label={`${current.fromName} asks`}
      aria-describedby={textId}
      data-testid="ask-dialog"
      data-ask-id={current.id}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        reply(null);
      }}
    >
      <div class="ask-head">
        <span class="ask-from" data-testid="ask-from">{current.fromName}</span>
        <span class="ask-asks">asks</span>
        {queue.length > 1 && (
          <span class="ask-more" data-testid="ask-more">
            +{queue.length - 1} more
          </span>
        )}
        <button
          type="button"
          class="ask-dismiss"
          data-testid="ask-dismiss"
          aria-label="Dismiss the question"
          title="Dismiss"
          onClick={() => reply(null)}
        >
          ×
        </button>
      </div>
      <p class="ask-text" id={textId} data-testid="ask-text">
        {current.text}
      </p>
      <div class="ask-actions">
        {actionsOf(current).map((action, i) => (
          <button
            type="button"
            key={action}
            class={i === 0 ? "btn-primary" : "btn-quiet"}
            data-testid="ask-action"
            data-action={action}
            onClick={() => reply(action)}
          >
            {action}
          </button>
        ))}
      </div>
    </div>
  );
}
