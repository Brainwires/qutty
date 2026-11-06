// The `+` split button: `+` opens a new terminal (the default shell, or what Settings says plain
// `+` opens), and the arrow beside it opens a menu of what a new terminal can run: the installed
// shells, agent tools (Claude Code, Codex, ...), Ollama's recent harness × model pairs and
// "Ollama models…" (app/ollama-dialog.tsx) when Ollama is installed, the saved SSH hosts and
// "Connections…".
//
// Keyboard: the arrow is a menu button (Enter, Space or ↓ opens the menu with the first entry
// focused); in the menu ↑/↓ move (wrapping), Home/End jump, Enter launches, Escape closes and
// puts the keyboard back in the terminal (the bar's Escape handler). The menu only has keys while
// it has focus, so nothing is taken from the terminal. The entries come from lib/launcher.ts.
// While the window has a shared sandbox, "Run in sandbox" (a checkbox item, Enter / Space or a
// click toggles it without closing the menu) says whether the shell or agent picked next runs
// in the sandbox or on the host; it starts from Settings' "new tiles open in the sandbox".

import { useEffect, useRef } from "denext";
import {
  type LaunchEntry,
  type LaunchSection,
  moveIndex,
} from "../lib/launcher.ts";
import { isTintId } from "../lib/workspace/themes.ts";

export interface LaunchMenuProps {
  open: boolean;
  /** The menu's sections (empty while the backend has not answered yet). */
  sections: LaunchSection[];
  /** The `+` button's tooltip (what plain `+` opens). */
  plusTitle: string;
  /** The entry plain `+` opens (marked in the menu), if not the default shell. */
  plusEntryId?: string;
  onNew(): void;
  onToggle(open: boolean): void;
  onLaunch(entry: LaunchEntry): void;
  onConnections(): void;
  /** The "Run in sandbox" toggle (absent while the sandbox is off). */
  sandbox?: { on: boolean; onToggle(): void };
  /**
   * The Ollama section's "Ollama models…" item (the harness × model dialog, the library, pulls),
   * with the count of library models new since the last look.
   */
  ollama?: { newCount: number; onOpen(): void };
}

const ITEM = "[role=menuitem],[role=menuitemcheckbox]";

export function LaunchMenu(props: LaunchMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Opening puts the keyboard on the first entry, so ↑/↓ work right away (mouse or keys); if
  // the entries were still loading, once they arrive.
  const loaded = props.sections.length > 0;
  useEffect(() => {
    const menu = menuRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (!props.open || !menu) return;
    if (active?.dataset.id && menu.contains(active)) return; // on an entry already
    menu.querySelector<HTMLElement>(ITEM)?.focus();
  }, [props.open, loaded]);

  const onMenuKey = (e: { key: string; preventDefault(): void }) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>(ITEM)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = moveIndex(items.length, at, 1);
    else if (e.key === "ArrowUp") next = moveIndex(items.length, at, -1);
    else if (e.key === "Home") next = items.length > 0 ? 0 : -1;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") {
      // Leaving the menu closes it (focus moves on as usual).
      props.onToggle(false);
      return;
    } else return;
    e.preventDefault();
    items[next]?.focus();
  };

  const item = (entry: LaunchEntry) => (
    <button
      type="button"
      role="menuitem"
      class={`menu-item launch-item${
        entry.id === props.plusEntryId ? " is-plus" : ""
      }`}
      data-testid="launch-item"
      data-id={entry.id}
      data-kind={entry.kind}
      data-tint={entry.kind === "ssh" && isTintId(entry.host.tint)
        ? entry.host.tint
        : undefined}
      key={entry.id}
      title={entry.detail}
      onClick={() => props.onLaunch(entry)}
    >
      <LaunchIcon kind={entry.kind} />
      <span class="menu-label">{entry.label}</span>
      {entry.kind === "shell" && entry.shell.isDefault && (
        <span class="launch-badge">default</span>
      )}
      {entry.id === props.plusEntryId && <span class="launch-badge">+</span>}
    </button>
  );

  return (
    <div class="menu-anchor launch" data-testid="launch">
      <div class={`split${props.open ? " is-open" : ""}`}>
        <button
          type="button"
          class="bar-btn bar-new"
          data-testid="bar-new"
          onClick={props.onNew}
          title={props.plusTitle}
          aria-label={props.plusTitle}
        >
          +
        </button>
        <button
          type="button"
          class={`bar-btn bar-new-menu${props.open ? " is-open" : ""}`}
          data-testid="bar-new-menu"
          aria-haspopup="menu"
          aria-expanded={props.open}
          aria-label="Choose what the new terminal runs"
          title="Choose what the new terminal runs"
          onClick={() => props.onToggle(!props.open)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !props.open) {
              e.preventDefault();
              props.onToggle(true);
            }
          }}
        >
          <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
            <path
              d="M2 3.5 5 6.5 8 3.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
      {props.open && (
        <div
          class="menu launch-menu"
          role="menu"
          aria-label="New terminal"
          data-testid="launch-menu"
          ref={menuRef}
          onKeyDown={onMenuKey}
        >
          {props.sections.length === 0 && (
            <div class="launch-empty" data-testid="launch-loading">
              Looking for shells…
            </div>
          )}
          {props.sections.map((section) => (
            <div
              class="launch-section"
              role="group"
              aria-label={section.title}
              data-testid="launch-section"
              data-section={section.id}
              key={section.id}
            >
              <div class="launch-heading" aria-hidden="true">
                {section.title}
              </div>
              {section.entries.map(item)}
              {section.id === "ollama" && props.ollama && (
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item launch-item"
                  data-testid="launch-ollama"
                  title="Pick a harness and a local model, browse the Ollama library, pull a model"
                  onClick={props.ollama.onOpen}
                >
                  <LaunchIcon kind="ollama" />
                  <span class="menu-label">Ollama models…</span>
                  {props.ollama.newCount > 0 && (
                    <span
                      class="launch-badge is-new"
                      data-testid="launch-ollama-new"
                      title={`${props.ollama.newCount} library model${
                        props.ollama.newCount === 1 ? "" : "s"
                      } updated since you last looked`}
                    >
                      {props.ollama.newCount} new
                    </span>
                  )}
                </button>
              )}
            </div>
          ))}
          <div class="launch-sep" role="separator" />
          {props.sandbox && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={props.sandbox.on}
              class={`menu-item launch-item launch-sandbox${
                props.sandbox.on ? " is-on" : ""
              }`}
              data-testid="launch-sandbox"
              title="Whether the shell or agent picked next runs in the window's sandbox or on the host"
              onClick={props.sandbox.onToggle}
            >
              <LaunchIcon kind="sandbox" />
              <span class="menu-label">
                {props.sandbox.on ? "Run in sandbox" : "Run on host"}
              </span>
              <span class="launch-check" aria-hidden="true">
                {props.sandbox.on ? "✓" : ""}
              </span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            class="menu-item launch-item"
            data-testid="launch-connections"
            onClick={props.onConnections}
          >
            <LaunchIcon kind="connections" />
            <span class="menu-label">Connections…</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** A small glyph per entry kind. */
function LaunchIcon(
  props: { kind: LaunchEntry["kind"] | "connections" | "sandbox" },
) {
  const common = {
    viewBox: "0 0 16 16",
    width: "13",
    height: "13",
    "aria-hidden": "true",
    class: "launch-icon",
  } as const;
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  } as const;
  switch (props.kind) {
    case "shell":
      return (
        <svg {...common}>
          <path d="M3 4.5 6.5 8 3 11.5M8 12h5" {...stroke} />
        </svg>
      );
    case "ollama":
      return (
        <svg {...common}>
          <path
            d="M5 6.5V4a1.2 1.2 0 0 1 2.4 0M8.6 4a1.2 1.2 0 0 1 2.4 0v2.5M3.5 11a4.5 4.5 0 0 1 9 0v2.5h-9z"
            {...stroke}
          />
        </svg>
      );
    case "agent":
      return (
        <svg {...common}>
          <path
            d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"
            {...stroke}
          />
        </svg>
      );
    case "ssh":
      return (
        <svg {...common}>
          <rect x="2" y="3" width="12" height="4" rx="1" {...stroke} />
          <rect x="2" y="9" width="12" height="4" rx="1" {...stroke} />
        </svg>
      );
    case "sandbox":
      return (
        <svg {...common}>
          <path
            d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z M2.5 5 8 8.2 13.5 5M8 8.2v6"
            {...stroke}
          />
        </svg>
      );
    case "connections":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" {...stroke} />
          <path d="M8 5.5v5M5.5 8h5" {...stroke} />
        </svg>
      );
  }
}
