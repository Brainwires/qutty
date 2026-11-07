// The quit question: Cmd+Q kills every terminal, so with an agent at work the app asks first
// (desktop.ts cancels the quit and sends the question here). Quit answers and quits the app;
// Cancel (or Escape) keeps everything running.

import { useEffect, useRef } from "denext";
import { Modal } from "./modal.tsx";
import type { QuitRequest } from "../lib/session-client.ts";

export function QuitDialog(props: {
  request: QuitRequest;
  onAnswer(quit: boolean): void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  const n = props.request.busy.length;
  return (
    <Modal
      label="Quit Qutty?"
      testid="quit-dialog"
      class="quit"
      onClose={() => props.onAnswer(false)}
    >
      <div class="modal-head">
        <h2>
          {n === 1
            ? "An agent is still working"
            : `${n} agents are still working`}
        </h2>
      </div>
      <div class="quit-body">
        <p>Quitting ends every terminal, in every window, including:</p>
        <ul class="quit-busy">
          {props.request.busy.map((t) => <li key={t.ptyId}>{t.name}</li>)}
        </ul>
      </div>
      <div class="modal-foot">
        <span class="modal-foot-end">
          <button
            type="button"
            class="btn-quiet"
            data-testid="quit-cancel"
            ref={cancelRef}
            onClick={() => props.onAnswer(false)}
          >
            Cancel
          </button>{" "}
          <button
            type="button"
            class="btn-primary"
            data-testid="quit-confirm"
            onClick={() => props.onAnswer(true)}
          >
            Quit anyway
          </button>
        </span>
      </div>
    </Modal>
  );
}
