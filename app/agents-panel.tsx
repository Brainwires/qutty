// The Agents panel: a switcher-bar button (shown while the window has agent tiles) whose popover
// lists them grouped as Needs you, To review and Working (then Idle), each with its avatar and
// what it does or asks; a click focuses the tile. The button's badge counts the tiles that need you. Registered as
// an HTML overlay so native web views step aside while it is open.

import { useEffect, useRef, useState } from "denext";
import { useHtmlOverlay } from "./use-html-overlay.ts";
import { AGENT_GROUPS } from "../lib/agent/tile.ts";
import type { AgentSummary } from "./use-agents.ts";
import { AgentAvatar } from "./agent-avatar.tsx";

export function AgentsMenu(props: {
  agents: AgentSummary[];
  /** Each tile's current title (its agent's name). */
  nameOf(id: string): string;
  onFocus(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  useHtmlOverlay(open);
  const ref = useRef<HTMLDivElement | null>(null);
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

  if (props.agents.length === 0) return null;
  const needs = props.agents.filter((a) => a.group === "needs").length;
  const working = props.agents.filter((a) => a.group === "working").length;
  return (
    <div class="menu-anchor" ref={ref}>
      <button
        type="button"
        class={`bar-btn bar-agents${open ? " is-open" : ""}`}
        data-testid="bar-agents"
        data-needs={String(needs)}
        aria-expanded={open}
        aria-label="Agents"
        title={`Agents${
          needs ? ` (${needs} need${needs === 1 ? "s" : ""} you)` : ""
        }`}
        onClick={() => setOpen(!open)}
      >
        <span
          class="agents-glyph"
          data-working={working > 0 ? "true" : undefined}
          aria-hidden="true"
        >
          ✻
        </span>
        {needs > 0 && (
          <span class="ws-badge agents-badge" data-testid="agents-badge">
            {needs}
          </span>
        )}
      </button>
      {open && (
        <div class="menu menu-agents" role="menu" data-testid="agents-menu">
          {AGENT_GROUPS.map((g) => {
            const rows = props.agents.filter((a) =>
              a.group === g.id
            );
            if (rows.length === 0) {
              return null;
            }
            return (
              <div
                class="agents-group"
                data-testid="agents-group"
                data-group={g.id}
                key={g.id}
              >
                <div class="launch-heading">
                  {g.label} <span class="agents-count">{rows.length}</span>
                </div>
                {rows.map((a) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="menu-item agents-item"
                    data-testid="agents-item"
                    data-id={a.id}
                    key={a.id}
                    onClick={() => {
                      setOpen(false);
                      props.onFocus(a.id);
                    }}
                  >
                    <span
                      class="agent-dot"
                      data-group={a.group}
                      aria-hidden="true"
                    />
                    <AgentAvatar
                      name={props.nameOf(a.id)}
                      harness={a.harness}
                    />
                    <span class="menu-label">{props.nameOf(a.id)}</span>
                    <span class="agents-detail">{a.detail}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
