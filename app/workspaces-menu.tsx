// The Workspaces menu (desktop app): a button in the switcher bar that lists the workspaces whose
// windows are closed (their terminals still run) to reopen or end for real, opens a new window,
// and ends this window's own workspace. A badge counts the detached ones. Ending asks once more,
// on the same button, since it kills the workspace's terminals.

import { useEffect, useRef, useState } from "denext";
import type { WorkspaceInfo } from "../lib/session-client.ts";
import type { SessionView } from "./use-session.ts";
import { formatAge } from "../lib/workspace/format.ts";

/** "3 terminals · 1 agent busy". */
function summary(w: WorkspaceInfo): string {
  const parts = [`${w.terminals} terminal${w.terminals === 1 ? "" : "s"}`];
  if (w.busy > 0) parts.push(`${w.busy} agent${w.busy === 1 ? "" : "s"} busy`);
  return parts.join(" · ");
}

/** End, then "End? kills N" on a second click. */
function EndButton(
  props: { w: WorkspaceInfo; onEnd(): void; label?: string },
) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      class={`btn-quiet ws-end${armed ? " is-armed" : ""}`}
      data-testid="ws-end"
      title="Kill its terminals and forget it"
      onClick={() => {
        if (armed || props.w.terminals === 0) props.onEnd();
        else setArmed(true);
      }}
      onBlur={() => setArmed(false)}
    >
      {armed
        ? `Kill ${props.w.terminals} terminal${
          props.w.terminals === 1 ? "" : "s"
        }?`
        : props.label ?? "End"}
    </button>
  );
}

export function WorkspacesMenu(props: {
  session: SessionView;
  now: number;
  newWindowLabel: string;
}) {
  const { session } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const detached = session.workspaces.filter((w) => w.state === "detached");
  const self = session.workspaces.find((w) => w.id === session.workspace?.id);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    globalThis.addEventListener("pointerdown", onDown, true);
    globalThis.addEventListener("keydown", onKey, true);
    return () => {
      globalThis.removeEventListener("pointerdown", onDown, true);
      globalThis.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!session.multiWindow) return null;
  return (
    <div class="menu-anchor" ref={ref}>
      <button
        type="button"
        class={`bar-btn bar-workspaces${open ? " is-open" : ""}`}
        data-testid="bar-workspaces"
        aria-expanded={open}
        aria-label="Workspaces"
        title={detached.length > 0
          ? `Workspaces (${detached.length} with its window closed)`
          : "Workspaces"}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
          <rect
            x="1.75"
            y="4.75"
            width="9.5"
            height="9.5"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
          <path
            d="M4.75 1.75h8a1.5 1.5 0 0 1 1.5 1.5v8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        {detached.length > 0 && (
          <span class="ws-badge" data-testid="ws-badge">{detached.length}</span>
        )}
      </button>
      {open && (
        <div class="menu menu-workspaces" role="menu" data-testid="ws-menu">
          <div class="launch-heading">Closed windows</div>
          {detached.length === 0 && (
            <p class="ws-none">
              None. Closing a window keeps its terminals running here.
            </p>
          )}
          {detached.map((w) => (
            <div class="ws-row" key={w.id} data-testid="ws-row" data-ws={w.id}>
              <div class="ws-text">
                <span class="ws-name">{w.name}</span>
                <span class="ws-meta">
                  {summary(w)}
                  {w.detachedAt !== undefined &&
                    ` · closed ${formatAge(props.now, w.detachedAt)}`}
                </span>
              </div>
              <button
                type="button"
                class="btn-primary"
                data-testid="ws-reopen"
                onClick={() => {
                  setOpen(false);
                  session.reopen(w.id);
                }}
              >
                Reopen
              </button>
              <EndButton
                w={w}
                onEnd={() =>
                  session.end(w.id)}
              />
            </div>
          ))}
          <div class="launch-sep" />
          <button
            type="button"
            class="menu-item"
            data-testid="ws-new-window"
            onClick={() => {
              setOpen(false);
              session.newWindow();
            }}
          >
            <span class="menu-label">New window</span>
            <kbd>{props.newWindowLabel}</kbd>
          </button>
          {self && (
            <div class="ws-row ws-self">
              <div class="ws-text">
                <span class="ws-name">This window: {self.name}</span>
                <span class="ws-meta">
                  Closing it keeps its terminals running.
                </span>
              </div>
              <EndButton
                w={self}
                label="End workspace"
                onEnd={() => session.end(self.id)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
