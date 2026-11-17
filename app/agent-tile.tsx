// An agent tile's insides (the frame — position, phase, header, close — is app/tile-cluster.tsx's,
// shared with the terminals and web tiles): a coding agent's chat drawn like a terminal.
//
// - The header (`AgentHead`): a status dot, the agent's name (its hub name; click to edit), the
//   model picker (Claude Code's aliases, lib/agent/tile.ts), what it is doing, and a menu: Open in
//   terminal (`claude --resume <session>` in a normal tile, in the same folder: the real TUI),
//   New session, Close.
// - The body (`AgentBody`): the transcript (lib/agent/transcript.ts rows) in the terminal's font
//   and colours — the user's prompts after a `>`, the assistant's markdown, thinking (dim,
//   collapsed), tool calls as `● Tool(arg)` rows with a `⎿` summary that expand to the diff, the
//   command and its output, or the input and result; permission questions with Allow, Allow
//   always and Deny; a footer per turn (done · tok/s · time · cost). It sticks to the bottom
//   unless you scrolled up ("Jump to latest").
// - The side rail: jump to the top, jump to the latest, maximize / restore the tile (the tile's
//   own control), and read the last reply aloud (the companion's voice; again to stop).
// - The prompt box: two lines at least, it grows with its text; Enter sends, Shift+Enter is a new
//   line; ↑ at the text's start (↓ at its end; either end of one line) walks the prompt history
//   (lib/agent/prompt-box.ts: every tile's prompts, this tile's first). Its toolbar: attach files
//   (also by drop or paste; images go as images), a picture of a web tile (where the engine can
//   take one), saved prompts (inserted at the caret; the current prompt saved), the history menu,
//   hold-to-dictate (with the companion), Stop (or Escape) and Send; typing while the agent works
//   queues the message. History and saved prompts live in localStorage.
//
// Focus: the focused tile's prompt box takes the keyboard (`focusAgentTile`, and an effect once it
// renders focused), as a terminal does. No new shortcuts: inside the box the usual text keys.
// No timers: the elapsed time while working follows animation frames; the caret goes where an
// insert left it in a layout effect.

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "denext";
import type {
  AgentAttachment,
  PermissionDecision,
} from "../lib/agent/adapter.ts";
import {
  diffLines,
  displayItems,
  footerText,
  formatDuration,
  type Row,
  toolSummary,
  toolTitle,
  type Transcript,
} from "../lib/agent/transcript.ts";
import {
  AGENT_MODELS,
  agentGroup,
  groupText,
  modelLabel,
} from "../lib/agent/tile.ts";
import {
  highlight,
  type MdInline,
  parseInline,
  parseMarkdown,
} from "../lib/agent/markdown.ts";
import {
  addSaved,
  HISTORY_MAX,
  HISTORY_STORAGE_KEY,
  historyStep,
  insertAtCaret,
  lastReply,
  mergeHistory,
  parsePromptList,
  pushPrompt,
  recallsHistory,
  removeSaved,
  SAVED_MAX,
  SAVED_STORAGE_KEY,
} from "../lib/agent/prompt-box.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import { type AgentStore, type AgentTileState } from "./use-agents.ts";
import { useHtmlOverlay } from "./use-html-overlay.ts";
import { Modal } from "./modal.tsx";

/** What the workspace gives agent tiles. */
export interface AgentTileHooks {
  store: AgentStore;
  /** The terminal font (Settings → Font). */
  font: { family: string; size: number; lineHeight: number };
  /** The theme's terminal colours, as CSS variables for the transcript. */
  palette: Record<string, string>;
  /** Open a link (a web tile where they show any site, else the default browser). */
  openUrl(url: string): void;
  /** Run `claude --resume <session>` in a terminal tile in the agent's folder. */
  openInTerminal(tileId: string): void;
  /** The tile's name changed in its header. */
  rename(tileId: string, name: string): Promise<void>;
  close(tileId: string): void;
  /** Hold-to-dictate from the mic button (absent: no voice). */
  dictation?: { press(): void; release(heldMs: number): void };
  /** Read markdown aloud in the companion's voice; `speaking` while anything is said. */
  speech?: { speaking: boolean; say(text: string): void; stop(): void };
  /** Pictures of other tiles to attach (web tiles where the engine can take one; absent: none). */
  capture?: {
    tiles(): { id: string; title: string }[];
    /** The picture (attached as a dropped image is), or why not. */
    take(id: string): Promise<File | string>;
  };
}

/** The selector of agent tile `id`'s prompt box. */
const promptOf = (id: string) =>
  `[data-testid="tile"][data-id="${
    CSS.escape(id)
  }"] [data-testid="agent-input"]`;

/** Give agent tile `id` the keyboard: its prompt box (focus already inside the tile stays). */
export function focusAgentTile(id: string): void {
  const input = document.querySelector<HTMLTextAreaElement>(promptOf(id));
  const tile = input?.closest("[data-testid=tile]");
  if (tile?.contains(document.activeElement)) return;
  input?.focus({ preventScroll: true });
}

/** Tile `id`'s state in the store, re-rendering when it changes. */
function useAgentState(
  store: AgentStore,
  id: string,
): AgentTileState | undefined {
  const [state, setState] = useState(() => store.get(id));
  useEffect(() => {
    setState(store.get(id));
    return store.subscribe(id, () => setState(store.get(id)));
  }, [store, id]);
  return state;
}

/** Milliseconds since `since`, updated each animation frame (seconds resolution). */
function useElapsed(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    let raf = 0;
    let shown = -1;
    const tick = () => {
      const t = Date.now();
      const s = Math.floor((t - since) / 1000);
      if (s !== shown) {
        shown = s;
        setNow(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, now - since);
}

/** Close a popover on a press outside `ref` or Escape. */
function useDismiss(
  open: boolean,
  ref: { current: HTMLElement | null },
  close: () => void,
): void {
  useHtmlOverlay(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    globalThis.addEventListener("pointerdown", onDown, true);
    globalThis.addEventListener("keydown", onKey, true);
    return () => {
      globalThis.removeEventListener("pointerdown", onDown, true);
      globalThis.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
}

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------

/** An agent tile's header controls (after the tile's own title, which CSS hides). */
export function AgentHead(
  props: { entry: TerminalEntry; hooks: AgentTileHooks },
) {
  const { entry, hooks } = props;
  const id = entry.id;
  const state = useAgentState(hooks.store, id);
  const t = state?.snap?.transcript;
  const group = state?.failed ? "needs" : agentGroup(t, state?.review ?? false);
  const elapsed = useElapsed(t?.running ? t.turnStartedAt : undefined);
  const [menu, setMenu] = useState<"none" | "model" | "more">("none");
  const anchor = useRef<HTMLSpanElement | null>(null);
  useDismiss(menu !== "none", anchor, () => setMenu("none"));
  const model = entry.chat?.model ?? state?.snap?.spec.model;
  const status = t?.running && t.asking.length === 0
    ? `working ${formatDuration(elapsed).replace(/\.\ds$/, "s")}`
    : groupText(group);
  return (
    <span class="agent-head" ref={anchor} data-testid="agent-head">
      <span
        class="agent-dot"
        data-group={group}
        data-testid="agent-dot"
        aria-hidden="true"
      />
      <NameField
        name={entry.title}
        onRename={(name) => hooks.rename(id, name)}
      />
      <button
        type="button"
        class="agent-model"
        data-testid="agent-model"
        title="Model"
        aria-haspopup="menu"
        aria-expanded={menu === "model"}
        onClick={() => setMenu(menu === "model" ? "none" : "model")}
      >
        {modelLabel(model)}
        <span class="agent-caret" aria-hidden="true">▾</span>
      </button>
      <span
        class="agent-status"
        data-testid="agent-status"
        data-group={group}
        title={state?.failed ?? t?.error ?? ""}
      >
        {status}
      </span>
      <button
        type="button"
        class="agent-more"
        data-testid="agent-menu"
        title="More"
        aria-label="Agent menu"
        aria-haspopup="menu"
        aria-expanded={menu === "more"}
        onClick={() => setMenu(menu === "more" ? "none" : "more")}
      >
        ⋯
      </button>
      {menu === "model" && (
        <div class="menu agent-menu" role="menu" data-testid="agent-models">
          {AGENT_MODELS.map((m) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={(model ?? "") === m.id}
              class={`menu-item${(model ?? "") === m.id ? " is-active" : ""}`}
              data-model={m.id}
              key={m.id || "default"}
              onClick={() => {
                setMenu("none");
                if ((model ?? "") !== m.id) {
                  hooks.store.restart(id, { model: m.id });
                }
              }}
            >
              <span class="menu-check">
                {(model ?? "") === m.id ? "●" : ""}
              </span>
              <span class="menu-label">{m.label}</span>
            </button>
          ))}
        </div>
      )}
      {menu === "more" && (
        <div class="menu agent-menu" role="menu" data-testid="agent-more">
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            data-testid="agent-open-terminal"
            disabled={!t?.sessionId && !entry.chat?.session}
            title="Open this session in Claude Code's own terminal UI"
            onClick={() => {
              setMenu("none");
              hooks.openInTerminal(id);
            }}
          >
            <span class="menu-label">Open in terminal</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            data-testid="agent-new-session"
            onClick={() => {
              setMenu("none");
              hooks.store.restart(id, { fresh: true });
            }}
          >
            <span class="menu-label">New session</span>
          </button>
          <div class="menu-sep" />
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            data-testid="agent-close"
            onClick={() => {
              setMenu("none");
              hooks.close(id);
            }}
          >
            <span class="menu-label">Close</span>
          </button>
        </div>
      )}
    </span>
  );
}

/** The agent's name: text until clicked, then a field (Enter or leaving it renames). */
function NameField(
  props: { name: string; onRename(name: string): Promise<void> },
) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const commit = () => {
    const name = draft?.trim();
    setDraft(null);
    if (!name || name === props.name) return;
    props.onRename(name).then(
      () => setError(""),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  };
  return (
    <input
      class={`agent-name${error ? " is-error" : ""}`}
      data-testid="agent-name"
      aria-label="Agent name"
      spellcheck={false}
      title={error || "Rename"}
      value={draft ?? props.name}
      size={Math.max(4, Math.min(24, (draft ?? props.name).length + 1))}
      onFocus={() => setDraft(props.name)}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(props.name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------

/** How close to the bottom still counts as "at the bottom" (px). */
const STICK_PX = 24;

/** An agent tile's transcript and prompt box. */
export function AgentBody(
  props: {
    entry: TerminalEntry;
    hooks: AgentTileHooks;
    focused: boolean;
    /** The tile is maximized (the rail's button reads Restore). */
    maximized: boolean;
    onMaximize(): void;
    onRestore(): void;
  },
) {
  const { entry, hooks } = props;
  const id = entry.id;
  const state = useAgentState(hooks.store, id);
  const t = state?.snap?.transcript;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);

  // Stick to the bottom as rows arrive, unless scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const at = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stuckRef.current = at;
    if (at !== stuck) setStuck(at);
  };
  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = true;
    setStuck(true);
    el.scrollTop = el.scrollHeight;
  };
  const toTop = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuckRef.current = false;
    setStuck(false);
    el.scrollTop = 0;
  };

  // The focused tile's prompt box takes the keyboard once it renders (and once a dialog that
  // had it, the folder question, has gone).
  useEffect(() => {
    if (!props.focused) return;
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) focusAgentTile(id);
  }, [props.focused, id, !!state?.snap]);

  const style: Record<string, string> = {
    "--agent-font": hooks.font.family,
    "--agent-size": `${hooks.font.size}px`,
    "--agent-lh": String(hooks.font.lineHeight),
    ...hooks.palette,
  };
  const elapsed = useElapsed(t?.running ? t.turnStartedAt : undefined);

  return (
    <div
      class="tile-body agent-body"
      data-testid="agent-body"
      ref={rootRef}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "Escape" && t?.running) {
          e.preventDefault();
          hooks.store.interrupt(id);
        }
      }}
    >
      <div
        class="agent-scroll"
        ref={scrollRef}
        data-testid="agent-scroll"
        onScroll={onScroll}
      >
        <div class="agent-log" data-testid="agent-log">
          {state?.failed && (
            <div class="agent-row agent-error" data-testid="agent-failed">
              ! {state.failed}
            </div>
          )}
          {!state?.failed && (!t || t.rows.length === 0) && (
            <div class="agent-welcome" data-testid="agent-welcome">
              <div class="agent-welcome-title">✻ {entry.title}</div>
              <div>
                {t ? `in ${entry.chat?.cwd ?? t.cwd ?? "~"}` : "starting…"}
              </div>
              <div class="agent-dim">
                Enter sends · Shift+Enter new line · Esc interrupts
              </div>
            </div>
          )}
          {t && <Rows t={t} hooks={hooks} tileId={id} />}
          {t?.running && (
            <div class="agent-working" data-testid="agent-working">
              <span class="agent-spinner" aria-hidden="true">✻</span>{" "}
              {t.asking.length > 0 ? "Waiting for you…" : "Working…"}{" "}
              <span class="agent-dim">
                {formatDuration(elapsed)} · esc to interrupt
              </span>
            </div>
          )}
        </div>
      </div>
      <SideRail
        rows={t?.rows ?? []}
        speech={hooks.speech}
        maximized={props.maximized}
        onTop={toTop}
        onLatest={jump}
        onMaximize={props.maximized ? props.onRestore : props.onMaximize}
      />
      {!stuck && (
        <button
          type="button"
          class="agent-jump"
          data-testid="agent-jump"
          onClick={jump}
        >
          ↓ Jump to latest
        </button>
      )}
      <Prompt
        id={id}
        hooks={hooks}
        transcript={t}
        disabled={!state?.snap}
        onSent={jump}
      />
    </div>
  );
}

/** A side rail button (an icon; a press does not take the keyboard from the prompt box). */
function RailButton(
  props: {
    testid: string;
    label: string;
    disabled?: boolean;
    pressed?: boolean;
    onClick(): void;
    children: ReactNode;
  },
) {
  return (
    <button
      type="button"
      class="agent-rail-btn"
      data-testid={props.testid}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      aria-pressed={props.pressed}
      onPointerDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      <svg
        viewBox="0 0 16 16"
        width="13"
        height="13"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {props.children}
      </svg>
    </button>
  );
}

/** Top, latest, maximize / restore, read aloud: beside the transcript. */
function SideRail(
  props: {
    rows: readonly Row[];
    speech: AgentTileHooks["speech"];
    maximized: boolean;
    onTop(): void;
    onLatest(): void;
    onMaximize(): void;
  },
) {
  const { speech } = props;
  const reply = lastReply(props.rows);
  return (
    <div class="agent-rail" data-testid="agent-rail">
      <RailButton testid="agent-top" label="Jump to top" onClick={props.onTop}>
        <path d="M3.5 2.5h9M8 13.5V5.5M4.5 9 8 5.5 11.5 9" />
      </RailButton>
      <RailButton
        testid="agent-latest"
        label="Jump to latest"
        onClick={props.onLatest}
      >
        <path d="M3.5 13.5h9M8 2.5v8M4.5 7 8 10.5 11.5 7" />
      </RailButton>
      <RailButton
        testid="agent-maximize"
        label={props.maximized ? "Restore tile" : "Maximize tile"}
        pressed={props.maximized}
        onClick={props.onMaximize}
      >
        {props.maximized
          ? <path d="M6 2.5V6H2.5M10 13.5V10h3.5M2.5 2.5 6 6M13.5 13.5 10 10" />
          : <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />}
      </RailButton>
      {speech && (
        <RailButton
          testid="agent-speak"
          label={speech.speaking ? "Stop reading" : "Read the last reply aloud"}
          pressed={speech.speaking}
          disabled={!speech.speaking && !reply}
          onClick={() => speech.speaking ? speech.stop() : speech.say(reply)}
        >
          <path d="M2.5 6H5l3.5-3v10L5 10H2.5z" />
          {speech.speaking
            ? <path d="M11 6.5l3 3M14 6.5l-3 3" />
            : (
              <path d="M10.75 5.75a3.2 3.2 0 0 1 0 4.5M12.6 4a5.6 5.6 0 0 1 0 8" />
            )}
        </RailButton>
      )}
    </div>
  );
}

/** The transcript's rows, a run of look-only tool calls as one. */
function Rows(props: { t: Transcript; hooks: AgentTileHooks; tileId: string }) {
  const { t } = props;
  return (
    <>
      {displayItems(t.rows).map((item) =>
        item.kind === "group"
          ? (
            <ToolGroup
              key={item.id}
              label={item.label}
              rows={item.rows}
              t={t}
            />
          )
          : (
            <RowView
              key={item.row.id}
              row={item.row}
              t={t}
              hooks={props.hooks}
              tileId={props.tileId}
            />
          )
      )}
    </>
  );
}

function RowView(
  props: { row: Row; t: Transcript; hooks: AgentTileHooks; tileId: string },
) {
  const { row, hooks } = props;
  switch (row.type) {
    case "user":
      return (
        <div
          class="agent-row agent-user"
          data-testid="agent-row"
          data-type="user"
        >
          <span class="agent-mark">&gt;</span>
          <div class="agent-user-text">
            {row.text}
            {row.attachments?.map((a) => (
              <span class="agent-attached" key={a.name}>
                {a.kind === "image" ? "▣" : "▤"} {a.name}
              </span>
            ))}
          </div>
        </div>
      );
    case "text":
      return (
        <div
          class="agent-row agent-text"
          data-testid="agent-row"
          data-type="text"
        >
          <span class="agent-mark agent-bullet">●</span>
          <Markdown text={row.text} openUrl={hooks.openUrl} />
        </div>
      );
    case "thinking":
      return <Thinking row={row} />;
    case "tool":
      return <ToolRow row={row} t={props.t} />;
    case "permission":
      return (
        <Permission
          row={row}
          t={props.t}
          onAnswer={(d) => hooks.store.answer(props.tileId, row.id, d)}
        />
      );
    case "error":
      return (
        <div
          class="agent-row agent-error"
          data-testid="agent-row"
          data-type="error"
        >
          <span class="agent-mark">!</span>
          <div>{row.text}</div>
        </div>
      );
    case "notice":
      return (
        <div
          class="agent-row agent-notice"
          data-testid="agent-row"
          data-type="notice"
        >
          · {row.text}
        </div>
      );
    case "footer":
      return (
        <div
          class="agent-row agent-footer"
          data-testid="agent-footer"
          data-outcome={row.outcome}
        >
          {footerText(row)}
        </div>
      );
  }
}

function Thinking(props: { row: Extract<Row, { type: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const { row } = props;
  return (
    <div
      class="agent-row agent-thinking"
      data-testid="agent-row"
      data-type="thinking"
    >
      <button
        type="button"
        class="agent-toggle"
        disabled={!row.text}
        onClick={() => setOpen(!open)}
      >
        ✻ Thinking{row.tokens ? ` · ${row.tokens} tok` : ""}
        {row.text ? (open ? " ▾" : " ▸") : ""}
      </button>
      {open && row.text && <div class="agent-thinking-text">{row.text}</div>}
    </div>
  );
}

/** The most output lines shown before "show all". */
const OUTPUT_LINES = 24;

function ToolRow(
  props: {
    row: Extract<Row, { type: "tool" }>;
    t: Transcript;
    nested?: boolean;
  },
) {
  const { row } = props;
  const [open, setOpen] = useState(false);
  const title = toolTitle(row.name, row.input, props.t.cwd);
  return (
    <div
      class={`agent-row agent-tool${props.nested ? " is-nested" : ""}`}
      data-testid="agent-tool"
      data-tool={row.name}
      data-status={row.status}
      data-open={open ? "true" : undefined}
    >
      <button
        type="button"
        class="agent-tool-head"
        data-testid="agent-tool-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class="agent-mark agent-tool-dot" data-status={row.status}>
          ●
        </span>
        <span class="agent-tool-name">{title.name}</span>
        {title.arg && <span class="agent-tool-arg">({title.arg})</span>}
      </button>
      <div class="agent-tool-sum" data-testid="agent-tool-summary">
        <span class="agent-elbow">⎿</span> {toolSummary(row)}
      </div>
      {open && <ToolDetailView row={row} />}
    </div>
  );
}

function ToolGroup(
  props: {
    label: string;
    rows: Extract<Row, { type: "tool" }>[];
    t: Transcript;
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <div class="agent-row agent-tool agent-group" data-testid="agent-group">
      <button
        type="button"
        class="agent-tool-head"
        aria-expanded={open}
        onClick={() =>
          setOpen(!open)}
      >
        <span class="agent-mark agent-tool-dot" data-status="done">●</span>
        <span class="agent-tool-name">{props.label}</span>
        <span class="agent-dim">{open ? " ▾" : " (expand)"}</span>
      </button>
      {open &&
        props.rows.map((r) => (
          <ToolRow
            key={r.id}
            row={r}
            t={props.t}
            nested
          />
        ))}
    </div>
  );
}

/** What a tool row expands to. */
function ToolDetailView(props: { row: Extract<Row, { type: "tool" }> }) {
  const { row } = props;
  const d = row.detail;
  if (d?.patch && d.patch.length > 0) {
    return (
      <pre class="agent-detail agent-diff" data-testid="agent-diff">
        {diffLines(d.patch).map((l, i) => (
          <div class={`diff-line diff-${diffClass(l.sign)}`} key={i}>
            <span class="diff-sign">{l.sign === "@" ? "" : l.sign}</span>
            {l.text}
          </div>
        ))}
      </pre>
    );
  }
  if (row.name === "Bash") {
    const cmd = typeof row.input?.command === "string" ? row.input.command : "";
    const out = d?.stdout !== undefined || d?.stderr !== undefined
      ? `${d.stdout ?? ""}${d.stderr ? `\n${d.stderr}` : ""}`
      : row.result ?? "";
    return (
      <div class="agent-detail" data-testid="agent-detail">
        <pre class="agent-cmd">$ {cmd}</pre>
        <Clipped text={out} />
      </div>
    );
  }
  if (row.name === "Write" && typeof row.input?.content === "string") {
    return (
      <div class="agent-detail" data-testid="agent-detail">
        <Clipped text={row.input.content} />
      </div>
    );
  }
  if (row.name === "Edit" && row.input && !d?.patch) {
    // A refused or failed edit: what it would have changed.
    const old = String(row.input.old_string ?? "");
    const neu = String(row.input.new_string ?? "");
    return (
      <pre class="agent-detail agent-diff" data-testid="agent-diff">
        {old.split("\n").map((l, i) => (
          <div class="diff-line diff-del" key={`o${i}`}>
            <span class="diff-sign">-</span>
            {l}
          </div>
        ))}
        {neu.split("\n").map((l, i) => (
          <div class="diff-line diff-add" key={`n${i}`}>
            <span class="diff-sign">+</span>
            {l}
          </div>
        ))}
      </pre>
    );
  }
  return (
    <div class="agent-detail" data-testid="agent-detail">
      {row.input && Object.keys(row.input).length > 0 && (
        <pre class="agent-args">{JSON.stringify(row.input, null, 2)}</pre>
      )}
      {row.result !== undefined && <Clipped text={row.result} />}
    </div>
  );
}

const diffClass = (sign: string) =>
  sign === "+" ? "add" : sign === "-" ? "del" : sign === "@" ? "hunk" : "ctx";

/** Long output, cut to its first lines until "show all". */
function Clipped(props: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = props.text.replace(/\n$/, "").split("\n");
  const cut = !all && lines.length > OUTPUT_LINES;
  return (
    <>
      <pre class="agent-out">
        {(cut ? lines.slice(0, OUTPUT_LINES) : lines).join("\n") ||
          "(no output)"}
      </pre>
      {cut && (
        <button
          type="button"
          class="agent-link-btn"
          data-testid="agent-show-all"
          onClick={() => setAll(true)}
        >
          … {lines.length - OUTPUT_LINES} more lines (show all)
        </button>
      )}
    </>
  );
}

function Permission(
  props: {
    row: Extract<Row, { type: "permission" }>;
    t: Transcript;
    onAnswer(d: PermissionDecision): void;
  },
) {
  const { row } = props;
  const title = toolTitle(row.toolName, row.input, props.t.cwd);
  const open = !row.decision && props.t.asking.includes(row.id);
  const preview = row.toolName === "Bash"
    ? String(row.input.command ?? "")
    : row.toolName === "Edit"
    ? `- ${String(row.input.old_string ?? "")}\n+ ${
      String(row.input.new_string ?? "")
    }`
    : row.toolName === "Write"
    ? String(row.input.content ?? "").split("\n").slice(0, 12).join("\n")
    : "";
  return (
    <div
      class={`agent-row agent-perm${open ? " is-open" : ""}`}
      data-testid="agent-permission"
      data-decision={row.decision ?? ""}
    >
      <div class="agent-perm-q">
        <span class="agent-mark">?</span>
        Allow <b>{title.name}</b>
        {title.arg && <span class="agent-tool-arg">({title.arg})</span>}?
      </div>
      {preview && <pre class="agent-perm-preview">{preview}</pre>}
      {open
        ? (
          <div class="agent-perm-actions">
            <button
              type="button"
              class="btn-primary agent-btn"
              data-testid="agent-allow"
              onClick={() => props.onAnswer("allow")}
            >
              Allow
            </button>
            <button
              type="button"
              class="btn-quiet agent-btn"
              data-testid="agent-allow-always"
              title={`Allow ${title.name} for the rest of this session`}
              onClick={() => props.onAnswer("always")}
            >
              Allow always
            </button>
            <button
              type="button"
              class="btn-quiet agent-btn is-danger"
              data-testid="agent-deny"
              onClick={() => props.onAnswer("deny")}
            >
              Deny
            </button>
          </div>
        )
        : (
          <div class="agent-perm-done" data-testid="agent-permission-done">
            <span class="agent-elbow">⎿</span> {row.decision === "deny"
              ? "Denied"
              : row.decision === "always"
              ? `Allowed (always, for ${title.name})`
              : row.decision === "allow"
              ? "Allowed"
              : "Withdrawn"}
          </div>
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------

function Inline(props: { text: string; openUrl(url: string): void }) {
  return (
    <>
      {parseInline(props.text).map((r: MdInline, i) => {
        switch (r.kind) {
          case "text":
            return r.text;
          case "code":
            return <code key={i} class="md-code">{r.text}</code>;
          case "strong":
            return <strong key={i}>{r.text}</strong>;
          case "em":
            return <em key={i}>{r.text}</em>;
          case "link":
            return (
              <a
                key={i}
                href={r.href}
                class="md-link"
                title={r.href}
                onClick={(e) => {
                  e.preventDefault();
                  props.openUrl(r.href);
                }}
              >
                {r.text}
              </a>
            );
        }
      })}
    </>
  );
}

function Markdown(props: { text: string; openUrl(url: string): void }) {
  const blocks = parseMarkdown(props.text);
  return (
    <div class="md">
      {blocks.map((b, i): ReactNode => {
        switch (b.kind) {
          case "heading":
            return (
              <div key={i} class={`md-h md-h${Math.min(b.level, 3)}`}>
                <Inline text={b.text} openUrl={props.openUrl} />
              </div>
            );
          case "paragraph":
            return (
              <p key={i} class="md-p">
                <Inline text={b.text} openUrl={props.openUrl} />
              </p>
            );
          case "list":
            return (
              <div key={i} class="md-list">
                {b.items.map((item, j) => (
                  <div class="md-li" key={j}>
                    <span class="md-li-mark">
                      {b.ordered ? `${b.start + j}.` : "-"}
                    </span>
                    <span>
                      <Inline text={item} openUrl={props.openUrl} />
                    </span>
                  </div>
                ))}
              </div>
            );
          case "quote":
            return (
              <div key={i} class="md-quote">
                <Inline text={b.text} openUrl={props.openUrl} />
              </div>
            );
          case "rule":
            return <div key={i} class="md-rule" />;
          case "code":
            return (
              <pre key={i} class="md-pre" data-lang={b.lang || undefined}>
                {highlight(b.text, b.lang).map((tok, j) =>
                  tok.t === "plain"
                    ? tok.s
                    : <span key={j} class={`hl-${tok.t}`}>{tok.s}</span>
                )}
              </pre>
            );
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The prompt box
// ---------------------------------------------------------------------------------------------

/** The largest file attached as text (characters). */
const MAX_TEXT_FILE = 512 * 1024;
/** The largest image attached (bytes). */
const MAX_IMAGE = 3 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const TEXT_NAME =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|csv|tsv|log|xml|html?|css|scss|less|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|bash|fish|sql|lua|pl|r|ex|exs|erl|hs|ml|scala|clj|vue|svelte|dockerfile|gitignore|env)$/i;

/** A dropped or pasted file as an attachment, or why not. */
async function attachmentOf(file: File): Promise<AgentAttachment | string> {
  if (IMAGE_TYPES.test(file.type)) {
    if (file.size > MAX_IMAGE) {
      return `${file.name} is too large (3 MB at most)`;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return {
      name: file.name || "image.png",
      kind: "image",
      mediaType: file.type,
      data: btoa(bin),
    };
  }
  if (file.type.startsWith("text/") || TEXT_NAME.test(file.name)) {
    if (file.size > MAX_TEXT_FILE) {
      return `${file.name} is too large (512 KB at most)`;
    }
    return {
      name: file.name,
      kind: "text",
      mediaType: file.type || "text/plain",
      data: await file.text(),
    };
  }
  return `${file.name}: only images and text files can be attached`;
}

/** A stored list of prompts (none where storage is blocked). */
function loadPrompts(key: string, max: number): string[] {
  try {
    return parsePromptList(globalThis.localStorage?.getItem(key), max);
  } catch {
    return [];
  }
}

function savePrompts(key: string, list: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(list));
  } catch {
    // Full or blocked: the list just is not kept.
  }
}

/** How many prompts the history menu lists. */
const HISTORY_MENU = 30;

/** A toolbar icon button. */
function ToolButton(
  props: {
    testid: string;
    label: string;
    expanded?: boolean;
    disabled?: boolean;
    onClick(): void;
    children: ReactNode;
  },
) {
  return (
    <button
      type="button"
      class="agent-tool-btn"
      data-testid={props.testid}
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      {...(props.expanded === undefined
        ? {}
        : { "aria-haspopup": "menu", "aria-expanded": props.expanded })}
      onClick={props.onClick}
    >
      <svg
        viewBox="0 0 16 16"
        width="14"
        height="14"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {props.children}
      </svg>
    </button>
  );
}

type PromptMenu = "none" | "saved" | "history" | "shot";

function Prompt(
  props: {
    id: string;
    hooks: AgentTileHooks;
    transcript: Transcript | undefined;
    disabled: boolean;
    onSent(): void;
  },
) {
  const { id, hooks, transcript: t } = props;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<AgentAttachment[]>([]);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<PromptMenu>("none");
  const menuRef = useRef<HTMLDivElement | null>(null);
  useDismiss(menu !== "none", menuRef, () => setMenu("none"));
  /** The lists a menu shows, read from storage as it opens. */
  const [saved, setSaved] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [shots, setShots] = useState<{ id: string; title: string }[]>([]);
  /** Where ↑ is in the history (-1: not recalling), what it walks, and the text before it. */
  const recall = useRef(-1);
  const walk = useRef<string[]>([]);
  const draft = useRef("");
  /** Where the caret goes once the text set with it renders. */
  const caret = useRef<number | null>(null);
  const pressAt = useRef<number | undefined>(undefined);

  // Grow with the text (two lines at least: the CSS), and put the caret where an insert left it.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
    if (caret.current !== null) {
      el.selectionStart = el.selectionEnd = caret.current;
      caret.current = null;
    }
  }, [text]);

  /** Show `value` with the caret at `at` (its end by default) and the keyboard in the box. */
  const place = (value: string, at = value.length) => {
    caret.current = at;
    setText(value);
    inputRef.current?.focus({ preventScroll: true });
  };
  /** `s` typed at the caret (over the selection). */
  const insert = (s: string) => {
    const el = inputRef.current;
    if (!el) return;
    const at = insertAtCaret(
      el.value,
      el.selectionStart ?? el.value.length,
      el.selectionEnd ?? el.value.length,
      s,
    );
    recall.current = -1;
    place(at.value, at.caret);
  };
  const insertRef = useRef(insert);
  insertRef.current = insert;

  // Dictation and the companion type here.
  useEffect(
    () => hooks.store.onInsert(id, (s) => insertRef.current(s)),
    [hooks.store, id],
  );

  /** This tile's prompts, oldest first. */
  const own = () =>
    (t?.rows ?? []).flatMap((r) => r.type === "user" ? [r.text] : []);
  /** The history ↑ walks (and its menu lists): every tile's, this tile's on top. */
  const history = () =>
    mergeHistory(loadPrompts(HISTORY_STORAGE_KEY, HISTORY_MAX), own());

  const add = async (list: FileList | File[] | null | undefined) => {
    if (!list) return;
    const out: AgentAttachment[] = [];
    const notes: string[] = [];
    for (const f of Array.from(list)) {
      const a = await attachmentOf(f);
      if (typeof a === "string") notes.push(a);
      else out.push(a);
    }
    attach(out, notes);
  };
  const attach = (out: AgentAttachment[], notes: string[]) => {
    if (out.length > 0) setFiles((cur) => [...cur, ...out].slice(0, 8));
    setNote(notes.join(" · "));
  };

  const send = () => {
    const body = text.trim();
    if ((!body && files.length === 0) || props.disabled) return;
    hooks.store.send(id, {
      text: body,
      ...(files.length > 0 ? { attachments: files } : {}),
    });
    if (body) {
      savePrompts(
        HISTORY_STORAGE_KEY,
        pushPrompt(loadPrompts(HISTORY_STORAGE_KEY, HISTORY_MAX), body),
      );
    }
    setText("");
    setFiles([]);
    setNote("");
    recall.current = -1;
    props.onSent();
  };

  /** ↑ / ↓ through the history, when the caret is at the end it points to. */
  const recallKey = (e: KeyboardEvent, el: HTMLTextAreaElement): boolean => {
    const dir = e.key === "ArrowUp"
      ? "up"
      : e.key === "ArrowDown"
      ? "down"
      : null;
    if (!dir || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
    if (
      !recallsHistory(
        dir,
        el.value,
        el.selectionStart ?? 0,
        el.selectionEnd ?? 0,
      )
    ) return false;
    if (recall.current < 0) {
      walk.current = history();
      draft.current = el.value;
    }
    const step = historyStep(walk.current, recall.current, dir, draft.current);
    if (!step) return false;
    recall.current = step.index;
    place(step.text);
    return true;
  };

  const openMenu = (which: PromptMenu) => {
    if (menu === which) return setMenu("none");
    if (which === "saved") {
      setSaved(loadPrompts(SAVED_STORAGE_KEY, SAVED_MAX));
    }
    if (which === "history") {
      setRecent(history().reverse().slice(0, HISTORY_MENU));
    }
    if (which === "shot") setShots(hooks.capture?.tiles() ?? []);
    setMenu(which);
  };
  const keepSaved = (list: string[]) => {
    setSaved(list);
    savePrompts(SAVED_STORAGE_KEY, list);
  };
  const takeShot = (tileId: string) => {
    setMenu("none");
    inputRef.current?.focus({ preventScroll: true });
    void hooks.capture?.take(tileId).then(
      (f) => typeof f === "string" ? attach([], [f]) : add([f]),
      (e) => attach([], [`no picture: ${e instanceof Error ? e.message : e}`]),
    );
  };

  // Files dropped anywhere on the tile's body attach.
  const addRef = useRef(add);
  addRef.current = add;
  const promptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const body = promptRef.current?.closest<HTMLElement>(".agent-body");
    if (!body) return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.target === body) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      setDragging(false);
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      void addRef.current(e.dataTransfer.files);
    };
    body.addEventListener("dragover", over);
    body.addEventListener("dragleave", leave);
    body.addEventListener("drop", drop);
    return () => {
      body.removeEventListener("dragover", over);
      body.removeEventListener("dragleave", leave);
      body.removeEventListener("drop", drop);
    };
  }, []);

  const running = t?.running ?? false;
  const queue = t?.queue ?? [];
  const release = () => {
    if (pressAt.current === undefined) return;
    hooks.dictation?.release(Date.now() - pressAt.current);
    pressAt.current = undefined;
  };
  return (
    <div
      class={`agent-prompt${dragging ? " is-dragging" : ""}`}
      data-testid="agent-prompt"
      ref={promptRef}
    >
      {queue.length > 0 && (
        <div class="agent-queue" data-testid="agent-queue">
          {queue.map((q, i) => (
            <div class="agent-queued" key={i}>
              <span class="agent-dim">queued ›</span> {q}
            </div>
          ))}
        </div>
      )}
      {(files.length > 0 || note) && (
        <div class="agent-files" data-testid="agent-files">
          {files.map((f, i) => (
            <span class="agent-file" key={`${f.name}-${i}`}>
              {f.kind === "image" ? "▣" : "▤"} {f.name}
              <button
                type="button"
                class="agent-file-x"
                aria-label={`Remove ${f.name}`}
                onClick={() =>
                  setFiles(files.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
          {note && <span class="agent-note">{note}</span>}
        </div>
      )}
      <div class="agent-input-row">
        <span class="agent-caret-mark" aria-hidden="true">&gt;</span>
        <textarea
          ref={inputRef}
          class="agent-input"
          data-testid="agent-input"
          rows={2}
          spellcheck={false}
          placeholder={running
            ? "Queue a message for when it's done…"
            : "Give your agent a prompt or a task: Enter to send, Shift+Enter for a new line"}
          value={text}
          onInput={(e) => {
            recall.current = -1;
            setText((e.target as HTMLTextAreaElement).value);
          }}
          onPaste={(e) => {
            const cd = (e as unknown as ClipboardEvent).clipboardData;
            if (cd && cd.files.length > 0) {
              e.preventDefault();
              void add(cd.files);
            }
          }}
          onKeyDown={(e) => {
            const ev = e as unknown as KeyboardEvent;
            if (ev.isComposing) return;
            if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              send();
              return;
            }
            if (e.key === "Escape" && running) {
              e.preventDefault();
              e.stopPropagation();
              hooks.store.interrupt(id);
              return;
            }
            if (recallKey(ev, e.target as HTMLTextAreaElement)) {
              e.preventDefault();
            }
          }}
        />
      </div>
      <div class="agent-tools" ref={menuRef}>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="agent-file-input"
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            void add(input.files).then(() => {
              input.value = "";
            });
          }}
        />
        <ToolButton
          testid="agent-attach"
          label="Attach files (or drop or paste them)"
          onClick={() => fileRef.current?.click()}
        >
          <path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2" />
        </ToolButton>
        {hooks.capture && (
          <ToolButton
            testid="agent-screenshot"
            label="Attach a picture of a web tile"
            expanded={menu === "shot"}
            onClick={() => openMenu("shot")}
          >
            <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.8l1-1.5h3.4l1 1.5h1.8A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
            <circle cx="8" cy="8.5" r="2.3" />
          </ToolButton>
        )}
        <ToolButton
          testid="agent-saved"
          label="Saved prompts"
          expanded={menu === "saved"}
          onClick={() => openMenu("saved")}
        >
          <path d="M4 2.5h8v11l-4-3-4 3z" />
        </ToolButton>
        <ToolButton
          testid="agent-history"
          label="Prompt history (↑ / ↓ in the box)"
          expanded={menu === "history"}
          onClick={() => openMenu("history")}
        >
          <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.5 2.5v2.3h2.3M8 5v3.2l2.2 1.4" />
        </ToolButton>
        {hooks.dictation && (
          <button
            type="button"
            class="agent-tool-btn"
            data-testid="agent-mic"
            title="Hold to dictate into the prompt"
            aria-label="Dictate"
            onPointerDown={(e) => {
              e.preventDefault();
              pressAt.current = Date.now();
              hooks.dictation?.press();
            }}
            onPointerUp={release}
            onPointerLeave={release}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <rect
                x="5.5"
                y="1.75"
                width="5"
                height="8.5"
                rx="2.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              />
              <path
                d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5v2"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
          </button>
        )}
        <span class="agent-hint">
          {running ? "esc to interrupt" : "↑↓ history · shift+enter new line"}
        </span>
        {running && (
          <button
            type="button"
            class="agent-stop"
            data-testid="agent-stop"
            title="Stop (Esc)"
            onClick={() => hooks.store.interrupt(id)}
          >
            ■ Stop
          </button>
        )}
        <button
          type="button"
          class="agent-send"
          data-testid="agent-send"
          title={running ? "Queue (Enter)" : "Send (Enter)"}
          disabled={props.disabled || (!text.trim() && files.length === 0)}
          onClick={send}
        >
          {running ? "Queue ↵" : "Send ↵"}
        </button>
        {menu === "saved" && (
          <div
            class="menu agent-menu agent-pop"
            role="menu"
            data-testid="agent-saved-menu"
          >
            {saved.length === 0 && (
              <div class="agent-pop-empty">No saved prompts yet</div>
            )}
            {saved.map((s, i) => (
              <div class="agent-pop-row" key={`${i}-${s}`}>
                <button
                  type="button"
                  role="menuitem"
                  class="menu-item"
                  data-testid="agent-saved-item"
                  title={s}
                  onClick={() => {
                    setMenu("none");
                    insert(s);
                  }}
                >
                  <span class="menu-label">{s}</span>
                </button>
                <button
                  type="button"
                  class="agent-file-x"
                  data-testid="agent-saved-remove"
                  aria-label={`Remove saved prompt ${i + 1}`}
                  title="Remove"
                  onClick={() => keepSaved(removeSaved(saved, i))}
                >
                  ×
                </button>
              </div>
            ))}
            <div class="menu-sep" />
            <button
              type="button"
              role="menuitem"
              class="menu-item"
              data-testid="agent-saved-add"
              disabled={!text.trim()}
              onClick={() => keepSaved(addSaved(saved, text))}
            >
              <span class="menu-label">+ Save the current prompt</span>
            </button>
          </div>
        )}
        {menu === "history" && (
          <div
            class="menu agent-menu agent-pop"
            role="menu"
            data-testid="agent-history-menu"
          >
            {recent.length === 0 && (
              <div class="agent-pop-empty">No prompts yet</div>
            )}
            {recent.map((s, i) => (
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                data-testid="agent-history-item"
                key={`${i}-${s}`}
                title={s}
                onClick={() => {
                  setMenu("none");
                  recall.current = -1;
                  place(s);
                }}
              >
                <span class="menu-label">{s}</span>
              </button>
            ))}
          </div>
        )}
        {menu === "shot" && (
          <div
            class="menu agent-menu agent-pop"
            role="menu"
            data-testid="agent-shot-menu"
          >
            {shots.length === 0 && (
              <div class="agent-pop-empty">No web tile to picture</div>
            )}
            {shots.map((s) => (
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                data-testid="agent-shot-item"
                key={s.id}
                onClick={() => takeShot(s.id)}
              >
                <span class="menu-label">{s.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------------------------

/** "Claude Code (chat)": which folder the agent works in. */
export function AgentLaunchDialog(
  props: { initialCwd: string; onOpen(cwd: string): void; onCancel(): void },
) {
  const [cwd, setCwd] = useState(props.initialCwd);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <Modal
      label="New agent"
      testid="agent-launch"
      class="agent-launch"
      onClose={props.onCancel}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (cwd.trim()) props.onOpen(cwd.trim());
        }}
      >
        <div class="agent-launch-title">✻ Claude Code (chat)</div>
        <label class="agent-launch-label" for="agent-launch-cwd">
          Working folder
        </label>
        <input
          id="agent-launch-cwd"
          ref={ref}
          class="agent-launch-input"
          data-testid="agent-launch-cwd"
          spellcheck={false}
          value={cwd}
          onInput={(e) => setCwd((e.target as HTMLInputElement).value)}
        />
        <div class="agent-launch-actions">
          <button
            type="button"
            class="btn-quiet"
            data-testid="agent-launch-cancel"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn-primary"
            data-testid="agent-launch-open"
          >
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}
