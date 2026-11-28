// The `+` split button: `+` opens a new terminal (the default shell, or what Settings says plain
// `+` opens), and the arrow beside it opens a menu of what a new tile can be, in submenus
// (lib/launcher.ts `launchTree`): Web Browser ▸ (Open, History, Bookmark Manager), Shell ▸ (the
// default shell first, then the other installed shells), SSH ▸ (Connections Manager, then the
// saved hosts), Terminal ▸ (the agent tools, Claude Code, Codex, ..., in a terminal with Qutty's
// overlay, and Ollama's recent harness × model pairs) and Coding ▸ (Qutty's chat view on Claude
// Code, Codex, Ollama, the Anthropic API, each with its presets, and "Ollama models…"
// (app/ollama-dialog.tsx) when Ollama is installed). Below them: "Run in sandbox" while the window
// has a shared sandbox, Source Control and Worktrees….
//
// Keyboard (the platform's menu conventions): the arrow is a menu button (Enter, Space or ↓ opens
// the menu with the first row focused); ↑/↓ move (wrapping), Home/End jump, → (or Enter, Space)
// on a submenu's row opens it with its first row focused, ← or Escape closes it and puts the
// keyboard back on its row; Enter picks; Escape on the top menu closes it and puts the keyboard
// back in the terminal (the bar's Escape handler). The menu only has keys while it has focus, so
// nothing is taken from the terminal. The pointer opens a submenu after resting on its row a
// moment (`SUBMENU_OPEN_MS`); an open submenu gives way only after the pointer rests on another
// row for `SUBMENU_SWITCH_MS`, so a diagonal move into it never closes it. A submenu goes beside
// the menu, flipped to the other side or moved up where the window's edge is near.
//
// While the window has a shared sandbox, "Run in sandbox" (a checkbox item, Enter / Space or a
// click toggles it without closing the menu) says whether the shell or agent picked next runs
// in the sandbox or on the host; it starts from Settings' "new tiles open in the sandbox".

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "denext";
import { useHtmlOverlay } from "./use-html-overlay.ts";
import {
  flyoutPosition,
  type LaunchCommand,
  type LaunchEntry,
  type LaunchGroup,
  type LaunchGroupId,
  type LaunchNode,
  type LaunchSection,
  launchTree,
  moveIndex,
  SUBMENU_OPEN_MS,
  SUBMENU_SWITCH_MS,
} from "../lib/launcher.ts";
import { isTintId } from "../lib/workspace/themes.ts";
import type { AgentKind } from "../lib/agent/adapter.ts";

export interface LaunchMenuProps {
  open: boolean;
  /** The backend's entries (empty while the backend has not answered yet). */
  sections: LaunchSection[];
  /** The `+` button's tooltip (what plain `+` opens). */
  plusTitle: string;
  /** The entry plain `+` opens (marked in the menu), if not the default shell. */
  plusEntryId?: string;
  onNew(): void;
  onToggle(open: boolean): void;
  onLaunch(entry: LaunchEntry): void;
  /** SSH → Connections Manager. */
  onConnections(): void;
  /** Web Browser → Open: a new web tile (absent where web tiles can't show any site). */
  onWebPage?(): void;
  /**
   * Coding → Claude Code (beside an installed Claude Code; Codex beside Codex, Ollama with Ollama
   * installed, Anthropic API with a saved key): a new agent tile (app/agent-tile.tsx) on that
   * backend; with a preset's id, one of the presets listed under its backend's row.
   */
  onAgentChat?(agent: AgentKind, presetId?: string): void;
  /** An Anthropic API key is saved: offer Coding → Anthropic API. */
  apiKeyChat?: boolean;
  /** Settings → Agents → Presets: each a row under its backend's (`agent` absent: Claude Code's). */
  agentPresets?: readonly { id: string; name: string; agent?: AgentKind }[];
  /** Web Browser → Bookmark Manager (app/bookmark-manager.tsx). */
  onBookmarks?(): void;
  /** Web Browser → History: the pages web tiles visited (app/history-dialog.tsx). */
  onHistory?(): void;
  /**
   * "Source Control": a Source Control tile for the focused terminal's repository; "Worktrees…"
   * (`show`): the same at its worktrees (app/scm-tile.tsx).
   */
  onSourceControl?(show?: "worktrees"): void;
  /** The "Run in sandbox" toggle (absent while the sandbox is off). */
  sandbox?: { on: boolean; onToggle(): void };
  /**
   * Coding → "Ollama models…" (the harness × model dialog, the library, pulls), with the count of
   * library models new since the last look.
   */
  ollama?: { newCount: number; onOpen(): void };
}

const ITEM = "[role=menuitem],[role=menuitemcheckbox]";

/** A command row's test id (the ones the menu always had). */
function commandTestId(node: Extract<LaunchNode, { type: "command" }>): string {
  return node.preset ? "launch-agent-preset" : `launch-${node.id}`;
}

/** The icon of a command row. */
function commandIcon(cmd: LaunchCommand): LaunchIconKind {
  switch (cmd.kind) {
    case "webPage":
      return "web";
    case "webHistory":
      return "history";
    case "webBookmarks":
      return "bookmarks";
    case "connections":
      return "connections";
    case "agentChat":
      return "chat";
    case "ollamaModels":
      return "ollama";
  }
}

const GROUP_ICONS: Record<LaunchGroupId, LaunchIconKind> = {
  web: "web",
  shell: "shell",
  ssh: "ssh",
  terminal: "agent",
  coding: "chat",
};

export function LaunchMenu(props: LaunchMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const subRef = useRef<HTMLDivElement | null>(null);
  useHtmlOverlay(props.open);
  // The open submenu, and where it goes once measured.
  const [sub, setSub] = useState<LaunchGroupId | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // A submenu opened by key takes the keyboard on its first row once it renders.
  const focusSub = useRef(false);
  const hover = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHover = () => {
    if (hover.current !== undefined) clearTimeout(hover.current);
    hover.current = undefined;
  };

  const groups = useMemo(
    () =>
      launchTree(props.sections, {
        web: {
          open: props.onWebPage !== undefined,
          history: props.onHistory !== undefined,
          bookmarks: props.onBookmarks !== undefined,
        },
        chat: props.onAgentChat !== undefined,
        ollama: props.ollama !== undefined,
        anthropic: props.apiKeyChat === true,
        ...(props.agentPresets ? { presets: props.agentPresets } : {}),
      }),
    [
      props.sections,
      props.onWebPage !== undefined,
      props.onHistory !== undefined,
      props.onBookmarks !== undefined,
      props.onAgentChat !== undefined,
      props.ollama !== undefined,
      props.apiKeyChat === true,
      props.agentPresets,
    ],
  );
  const openGroup = groups.find((g) => g.id === sub);

  // Closing the menu closes its submenu; no hover timer outlives it.
  useEffect(() => {
    if (!props.open) {
      setSub(null);
      setPos(null);
    }
    return cancelHover;
  }, [props.open]);

  // Opening puts the keyboard on the first row, so ↑/↓ work right away (mouse or keys); if the
  // entries were still loading, once they arrive.
  const loaded = props.sections.length > 0;
  useEffect(() => {
    const menu = menuRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (!props.open || !menu) return;
    if (active && active.matches(ITEM) && menu.contains(active)) return;
    if (active && subRef.current?.contains(active)) return;
    menu.querySelector<HTMLElement>(ITEM)?.focus();
  }, [props.open, loaded]);

  // The open submenu beside its row, inside the window; then the keyboard, if opened by key.
  const subKey = openGroup ? `${openGroup.id}:${openGroup.items.length}` : "";
  useLayoutEffect(() => {
    const el = subRef.current;
    const menu = menuRef.current;
    const row = menu?.querySelector<HTMLElement>(
      `[data-testid=launch-sub][data-sub="${sub}"]`,
    );
    if (!el || !menu || !row) return;
    const m = menu.getBoundingClientRect();
    const vw = globalThis.innerWidth || 1000;
    setPos(flyoutPosition(
      row.getBoundingClientRect(),
      m,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: vw, height: globalThis.innerHeight || 800 },
      // A menu in the window's right half (the bar on the right) opens its submenus leftward.
      { prefer: m.left + m.width / 2 > vw / 2 ? "left" : "right" },
    ));
    if (focusSub.current) {
      focusSub.current = false;
      el.querySelector<HTMLElement>(ITEM)?.focus();
    }
  }, [subKey]);

  const open = (id: LaunchGroupId, focus: boolean) => {
    cancelHover();
    focusSub.current = focus;
    if (id === sub) {
      // Already open: by key, its first row takes the keyboard.
      if (focus) {
        focusSub.current = false;
        subRef.current?.querySelector<HTMLElement>(ITEM)?.focus();
      }
      return;
    }
    setPos(null);
    setSub(id);
  };
  const close = (refocus: boolean) => {
    cancelHover();
    if (refocus) {
      menuRef.current?.querySelector<HTMLElement>(
        `[data-testid=launch-sub][data-sub="${sub}"]`,
      )?.focus();
    }
    setSub(null);
    setPos(null);
  };

  /** The pointer came to rest on a row of the top menu: `id`'s submenu, or none, in a moment. */
  const hoverRow = (id: LaunchGroupId | null) => {
    cancelHover();
    if (id === sub) return;
    if (id === null && sub === null) return;
    hover.current = setTimeout(() => {
      hover.current = undefined;
      // The keyboard in the submenu that goes: back on its row, so the keys still work.
      if (subRef.current?.contains(document.activeElement)) {
        menuRef.current?.querySelector<HTMLElement>(
          `[data-testid=launch-sub][data-sub="${sub}"]`,
        )?.focus();
      }
      if (id === null) {
        setSub(null);
        setPos(null);
      } else {
        focusSub.current = false;
        setPos(null);
        setSub(id);
      }
    }, sub === null ? SUBMENU_OPEN_MS : SUBMENU_SWITCH_MS);
  };

  const onMenuKey = (
    e: { key: string; preventDefault(): void; stopPropagation(): void },
  ) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>(ITEM)];
    const active = document.activeElement as HTMLElement | null;
    const at = items.indexOf(active!);
    let next = -1;
    if (e.key === "ArrowDown") next = moveIndex(items.length, at, 1);
    else if (e.key === "ArrowUp") next = moveIndex(items.length, at, -1);
    else if (e.key === "Home") next = items.length > 0 ? 0 : -1;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowRight") {
      const id = active?.dataset.sub as LaunchGroupId | undefined;
      if (!id) return;
      e.preventDefault();
      open(id, true);
      return;
    } else if (e.key === "Escape" && sub !== null) {
      // An open submenu closes first (the bar lets this Escape through to here).
      e.preventDefault();
      e.stopPropagation();
      close(false);
      return;
    } else if (e.key === "Tab") {
      // Leaving the menu closes it (focus moves on as usual).
      props.onToggle(false);
      return;
    } else return;
    e.preventDefault();
    const target = items[next];
    target?.focus();
    // Moving off a submenu's row closes it.
    if (sub !== null && target?.dataset.sub !== sub) close(false);
  };

  const onSubKey = (
    e: { key: string; preventDefault(): void; stopPropagation(): void },
  ) => {
    const el = subRef.current;
    if (!el) return;
    const items = [...el.querySelectorAll<HTMLElement>(ITEM)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") items[moveIndex(items.length, at, 1)]?.focus();
    else if (e.key === "ArrowUp") {
      items[moveIndex(items.length, at, -1)]?.focus();
    } else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items[items.length - 1]?.focus();
    else if (e.key === "ArrowLeft" || e.key === "Escape") close(true);
    else if (e.key === "Tab") return props.onToggle(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const runCommand = (cmd: LaunchCommand) => {
    switch (cmd.kind) {
      case "webPage":
        return props.onWebPage?.();
      case "webHistory":
        return props.onHistory?.();
      case "webBookmarks":
        return props.onBookmarks?.();
      case "connections":
        return props.onConnections();
      case "agentChat":
        return cmd.presetId === undefined
          ? props.onAgentChat?.(cmd.agent)
          : props.onAgentChat?.(cmd.agent, cmd.presetId);
      case "ollamaModels":
        return props.ollama?.onOpen();
    }
  };

  const entryRow = (node: Extract<LaunchNode, { type: "entry" }>) => {
    const entry = node.entry;
    return (
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
        title={node.detail}
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
  };

  const commandRow = (node: Extract<LaunchNode, { type: "command" }>) => {
    const newCount = node.command.kind === "ollamaModels"
      ? props.ollama?.newCount ?? 0
      : 0;
    return (
      <button
        type="button"
        role="menuitem"
        class={`menu-item launch-item${node.preset ? " launch-preset" : ""}`}
        data-testid={commandTestId(node)}
        data-id={node.preset && node.command.kind === "agentChat"
          ? node.command.presetId
          : undefined}
        key={node.id}
        title={node.detail}
        onClick={() => runCommand(node.command)}
      >
        <LaunchIcon kind={commandIcon(node.command)} />
        <span class="menu-label">{node.label}</span>
        {newCount > 0 && (
          <span
            class="launch-badge is-new"
            data-testid="launch-ollama-new"
            title={`${newCount} library model${
              newCount === 1 ? "" : "s"
            } updated since you last looked`}
          >
            {newCount} new
          </span>
        )}
      </button>
    );
  };

  const groupRow = (group: LaunchGroup) => {
    const isOpen = group.id === sub;
    const hasNew = group.id === "coding" && (props.ollama?.newCount ?? 0) > 0;
    return (
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        class={`menu-item launch-item launch-group${isOpen ? " is-open" : ""}`}
        data-testid="launch-sub"
        data-part="launch-group"
        data-sub={group.id}
        key={group.id}
        title={group.detail}
        onPointerEnter={() => hoverRow(group.id)}
        onPointerLeave={() => {
          // Leaving before it opened: it does not open.
          if (sub !== group.id) cancelHover();
        }}
        onClick={(e) =>
          open(group.id, (e as unknown as MouseEvent).detail === 0)}
      >
        <LaunchIcon kind={GROUP_ICONS[group.id]} />
        <span class="menu-label">{group.title}</span>
        {hasNew && (
          <span
            class="launch-dot"
            aria-hidden="true"
            data-testid="launch-sub-new"
          />
        )}
        <LaunchIcon kind="chevron" />
      </button>
    );
  };

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
          aria-label="Choose what the new tile opens"
          title="Choose what the new tile opens"
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
          aria-label="New tile"
          data-testid="launch-menu"
          data-part="launch-menu"
          ref={menuRef}
          onKeyDown={onMenuKey}
        >
          {groups.map((group) =>
            // While the shells are still being looked for, a line says so in Shell's place.
            group.id === "ssh" && !loaded
              ? [
                <div
                  class="launch-empty"
                  data-testid="launch-loading"
                  key="loading"
                >
                  Looking for shells…
                </div>,
                groupRow(group),
              ]
              : groupRow(group)
          )}
          {(props.sandbox || props.onSourceControl) && (
            <div class="launch-sep" role="separator" />
          )}
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
              onPointerEnter={() => hoverRow(null)}
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
          {props.onSourceControl && (
            <>
              <button
                type="button"
                role="menuitem"
                class="menu-item launch-item"
                data-testid="launch-source-control"
                title="Source Control for the focused terminal's repository"
                onPointerEnter={() => hoverRow(null)}
                onClick={() => props.onSourceControl?.()}
              >
                <LaunchIcon kind="scm" />
                <span class="menu-label">Source Control</span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="menu-item launch-item"
                data-testid="launch-worktrees"
                title="New Worktree, Open Worktree as a workspace, Remove Worktree"
                onPointerEnter={() => hoverRow(null)}
                onClick={() => props.onSourceControl?.("worktrees")}
              >
                <LaunchIcon kind="scm" />
                <span class="menu-label">Worktrees…</span>
              </button>
            </>
          )}
        </div>
      )}
      {props.open && openGroup && (
        <div
          class="menu launch-submenu"
          role="menu"
          aria-label={openGroup.title}
          data-testid="launch-submenu"
          data-part="launch-submenu"
          data-sub={openGroup.id}
          data-launch-submenu=""
          ref={subRef}
          style={{
            left: `${pos?.left ?? -9999}px`,
            top: `${pos?.top ?? -9999}px`,
          }}
          onKeyDown={onSubKey}
          onPointerEnter={cancelHover}
        >
          {openGroup.items.map((node, i) =>
            node.type === "separator"
              ? <div class="launch-sep" role="separator" key={`sep${i}`} />
              : node.type === "entry"
              ? entryRow(node)
              : commandRow(node)
          )}
        </div>
      )}
    </div>
  );
}

type LaunchIconKind =
  | LaunchEntry["kind"]
  | "connections"
  | "sandbox"
  | "web"
  | "bookmarks"
  | "history"
  | "chat"
  | "scm"
  | "chevron";

/** A small glyph per entry kind. */
function LaunchIcon(props: { kind: LaunchIconKind }) {
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
    case "bookmarks":
      return (
        <svg {...common}>
          <path d="M4.5 2.5h7v11L8 10.5l-3.5 3z" {...stroke} />
        </svg>
      );
    case "history":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" {...stroke} />
          <path d="M8 5v3l2 1.5" {...stroke} />
        </svg>
      );
    case "web":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" {...stroke} />
          <path
            d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11"
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
    case "scm":
      return (
        <svg {...common}>
          <circle cx="5" cy="3.8" r="1.6" {...stroke} />
          <circle cx="5" cy="12.2" r="1.6" {...stroke} />
          <circle cx="11" cy="6" r="1.6" {...stroke} />
          <path d="M5 5.4v5.2M11 7.6c0 2.4-6 1.8-6 3" {...stroke} />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path
            d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z M5 6.2h6M5 8.2h4"
            {...stroke}
          />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common} class="launch-icon launch-chevron">
          <path d="M6 3.5 10.5 8 6 12.5" {...stroke} />
        </svg>
      );
  }
}
