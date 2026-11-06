// A modal dialog shell shared by the connection manager and the download picker: a backdrop
// (a click on it closes), Escape closes, and Tab cycles inside the dialog so the terminals
// behind it never take the keyboard. The dialog's own content decides what gets focus first.
//
// Escape is handled on the dialog element: a nested control that uses Escape itself (the host
// form going back to the detail view) stops its propagation first.

import type { ReactNode } from "denext";

export interface ModalProps {
  label: string;
  testid: string;
  /** Extra classes on the dialog (its size). */
  class?: string;
  onClose(): void;
  children: ReactNode;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `root`: from the last focusable to the first, and back. */
function trapTab(
  root: HTMLElement,
  e: { shiftKey: boolean; preventDefault(): void },
): void {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) =>
    el.offsetParent !== null
  );
  if (all.length === 0) return;
  const first = all[0];
  const last = all[all.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

export function Modal(props: ModalProps) {
  return (
    <div
      class="modal-backdrop"
      data-testid={`${props.testid}-backdrop`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class={`modal${props.class ? ` ${props.class}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        data-testid={props.testid}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onClose();
          } else if (e.key === "Tab") {
            trapTab(e.currentTarget as HTMLElement, e);
          }
        }}
      >
        {props.children}
      </div>
    </div>
  );
}
