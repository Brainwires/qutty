// "Close this window?": the window's close button with Settings → Windows set to ask
// (app/use-window-close.ts). Keep Running (the default: Return) closes the window and leaves its
// shells running for Reopen Closed Window; End Shells ends them (destructive); Cancel (Escape, or
// a click on the backdrop) keeps the window. "Remember my choice" saves Keep or End as the
// setting. Focus starts on Keep Running and Tab stays inside (app/modal.tsx).

import { useEffect, useRef, useState } from "denext";
import { Modal } from "./modal.tsx";
import type { CloseAnswer } from "./use-window-close.ts";

export interface CloseWindowDialogProps {
  /** How many terminals the window shows. */
  terminals: number;
  onAnswer(choice: CloseAnswer, remember: boolean): void;
}

/** "3 terminals are open in this window." (or 1, or none). */
function terminalCount(n: number): string {
  if (n === 0) return "No terminals are open in this window.";
  return `${n} terminal${n === 1 ? " is" : "s are"} open in this window.`;
}

export function CloseWindowDialog(props: CloseWindowDialogProps) {
  const [remember, setRemember] = useState(false);
  const keepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => keepRef.current?.focus(), []);
  const answer = (choice: CloseAnswer) =>
    props.onAnswer(choice, choice !== "cancel" && remember);

  return (
    <Modal
      label="Close this window?"
      testid="close-window"
      class="close-window"
      onClose={() => answer("cancel")}
    >
      <div
        class="close-window-body"
        onKeyDown={(e) => {
          // Return is the default button's, wherever the focus is but on another button (which
          // the browser presses itself).
          if (
            e.key !== "Enter" || (e.target as HTMLElement).tagName === "BUTTON"
          ) {
            return;
          }
          e.preventDefault();
          answer("keep");
        }}
      >
        <div class="modal-head">
          <h2>Close this window?</h2>
        </div>
        <div class="close-window-text">
          <p data-testid="close-window-count">
            {terminalCount(props.terminals)}
          </p>
          <p>
            Its shells can keep running in the background (reattach them later
            with Window → Reopen Closed Window), or end now.
          </p>
          <label class="field field-check">
            <input
              type="checkbox"
              data-testid="close-window-remember"
              checked={remember}
              onChange={(e) =>
                setRemember((e.target as HTMLInputElement).checked)}
            />
            <span class="field-label">Remember my choice</span>
          </label>
          <p class="field-hint">
            You can change it in Settings → Windows.
          </p>
        </div>
        <div class="close-window-actions">
          <button
            type="button"
            class="btn-quiet is-danger"
            data-testid="close-window-end"
            onClick={() => answer("end")}
          >
            End Shells
          </button>
          <span class="close-window-gap" />
          <button
            type="button"
            class="btn-quiet"
            data-testid="close-window-cancel"
            onClick={() => answer("cancel")}
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-primary"
            data-testid="close-window-keep"
            ref={keepRef}
            onClick={() => answer("keep")}
          >
            Keep Running
          </button>
        </div>
      </div>
    </Modal>
  );
}
