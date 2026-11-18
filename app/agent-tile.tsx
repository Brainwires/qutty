// An agent tile's insides (the frame — position, phase, header, close — is app/tile-cluster.tsx's,
// shared with the terminals and web tiles): a coding agent's chat drawn like a terminal.
//
// - The header (`AgentHead`): a status dot, the agent's name (its hub name; click to edit), the
//   model picker (the backend's models, lib/agent/tile.ts `agentModels`), what it is doing, and a
//   menu: Open in terminal (`claude --resume <session>` or `codex resume <thread>` in a normal
//   tile, in the same folder: the real TUI),
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
//   queues the message. History and saved prompts live in localStorage. The rail and the box
//   are app/prompt-box.tsx, shared with the harness overlay (app/harness-overlay.tsx).
//
// Focus: the focused tile's prompt box takes the keyboard (`focusAgentTile`, and an effect once it
// renders focused), as a terminal does. No new shortcuts: inside the box the usual text keys.
// No timers: the elapsed time while working follows animation frames; the caret goes where an
// insert left it in a layout effect.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "denext";
import {
  type AgentKind,
  agentLabel,
  type PermissionDecision,
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
  agentGroup,
  agentModels,
  groupText,
  modelLabel,
} from "../lib/agent/tile.ts";
import {
  highlight,
  type MdInline,
  parseInline,
  parseMarkdown,
} from "../lib/agent/markdown.ts";
import { lastReply } from "../lib/agent/prompt-box.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import { type AgentStore, type AgentTileState } from "./use-agents.ts";
import { Modal } from "./modal.tsx";
import {
  type Capture,
  type Dictation,
  PromptBox,
  SideRail,
  type Speech,
  useDismiss,
} from "./prompt-box.tsx";

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
  dictation?: Dictation;
  /** Read markdown aloud in the companion's voice; `speaking` while anything is said. */
  speech?: Speech;
  /** Pictures of other tiles to attach (web tiles where the engine can take one; absent: none). */
  capture?: Capture;
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
  const agent = entry.chat?.agent ?? state?.snap?.spec.agent;
  // Ollama and the API run in Qutty: no terminal UI to open the session in.
  const hasTerminal = agent === undefined || agent === "claude" ||
    agent === "codex";
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
          {agentModels(agent, t?.models).map((m) => (
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
            disabled={!hasTerminal || (!t?.sessionId && !entry.chat?.session)}
            title={`Open this session in ${
              agentLabel(agent)
            }'s own terminal UI`}
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

/**
 * The agent's name: text until clicked, then a field (Enter or leaving it renames). The harness
 * overlay's header has one too (`testid` `harness-name`).
 */
export function NameField(
  props: {
    name: string;
    onRename(name: string): Promise<void>;
    testid?: string;
  },
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
      data-testid={props.testid ?? "agent-name"}
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
  const reply = lastReply(t?.rows ?? []);

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
        testPrefix="agent"
        speech={hooks.speech}
        canSpeak={reply !== ""}
        speakText={() => reply}
        speakLabel="Read the last reply aloud"
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
// The prompt box (app/prompt-box.tsx, shared with the harness overlay)
// ---------------------------------------------------------------------------------------------

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
  const running = t?.running ?? false;
  const store = hooks.store;
  const onInsert = useCallback(
    (cb: (s: string) => void) => store.onInsert(id, cb),
    [store, id],
  );
  return (
    <PromptBox
      testPrefix="agent"
      disabled={props.disabled}
      placeholder={running
        ? "Queue a message for when it's done…"
        : "Give your agent a prompt or a task: Enter to send, Shift+Enter for a new line"}
      hint={running ? "esc to interrupt" : "↑↓ history · shift+enter new line"}
      sendLabel={running ? "Queue ↵" : "Send ↵"}
      sendTitle={running ? "Queue (Enter)" : "Send (Enter)"}
      queue={t?.queue ?? []}
      images
      own={() =>
        (t?.rows ?? []).flatMap((r) => r.type === "user" ? [r.text] : [])}
      onSend={(text, files) => {
        store.send(id, {
          text,
          ...(files.length > 0 ? { attachments: files } : {}),
        });
        props.onSent();
      }}
      onEscape={() => {
        if (!running) return false;
        store.interrupt(id);
        return true;
      }}
      {...(running
        ? {
          stop: {
            label: "■ Stop",
            title: "Stop (Esc)",
            testid: "agent-stop",
            run: () => store.interrupt(id),
          },
        }
        : {})}
      onInsert={onInsert}
      {...(hooks.dictation ? { dictation: hooks.dictation } : {})}
      {...(hooks.capture ? { capture: hooks.capture } : {})}
      dropZone=".agent-body"
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------------------------

/** "Claude Code (chat)": which folder the agent works in. */
export function AgentLaunchDialog(
  props: {
    initialCwd: string;
    /** The backend (absent: Claude Code). */
    agent?: AgentKind;
    onOpen(cwd: string): void;
    onCancel(): void;
  },
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
        <div class="agent-launch-title">✻ {agentLabel(props.agent)} (chat)</div>
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
