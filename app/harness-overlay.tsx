// The harness overlay: a GUI around a terminal tile that runs a coding-agent harness (Claude Code,
// Codex, Gemini CLI, opencode, aider, …). The terminal stays the harness's own, real and
// interactive, in the middle; the overlay only frames it (the tile itself is app/tile-cluster.tsx,
// which keeps the terminal's host element in place whether the overlay shows or not, so turning it
// on or off never moves the xterm). Which harness a tile runs is lib/workspace/harness.ts's call.
//
// - The header card (`HarnessHead`, in the tile's header): the harness's glyph, the tile's hub name
//   (click to rename), the harness's name, its model when known, a status dot (busy, idle, waiting
//   for you), a Messages button while the hub holds unread messages for it, and a menu (hide the
//   overlay for this tile, the overlay's setting, close). The tile's own window controls and close
//   button stay beside it.
// - The prompt box (app/prompt-box.tsx, the agent tile's): Enter sends, Shift+Enter is a new line,
//   ↑ / ↓ walk the history; attach text files (typed after the prompt), saved prompts, history,
//   hold-to-dictate (with the companion), Interrupt (while the harness is busy or waiting for you)
//   and Send. Sending types the prompt into the terminal as a paste of it would arrive (bracketed
//   when the harness turned that mode on), then presses Enter; Interrupt sends the harness's
//   interrupt key (Esc, or Ctrl+C for aider).
// - The side rail, beside the terminal: jump to the top of its scrollback, jump to the latest,
//   maximize / restore the tile, and read the screen aloud in the companion's voice.
//
// Keyboard: the terminal keeps the keyboard (a focused tile focuses its terminal, as always);
// clicking the prompt box gives it the keyboard, clicking the terminal gives it back. Dictation
// lands in the prompt box while it has the keyboard (`insertIntoHarnessPrompt`), else in the
// terminal as before. No shortcuts of its own, no timers.

import { type ReactNode, useCallback, useRef, useState } from "denext";
import type { AgentAttachment } from "../lib/agent/adapter.ts";
import type { TileInfo, TileStatus } from "../lib/hub/protocol.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import {
  type HarnessSpec,
  promptPlaceholder,
  speakableScreen,
  withFiles,
} from "../lib/workspace/harness.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import { NameField } from "./agent-tile.tsx";
import {
  type Dictation,
  PromptBox,
  RailButton,
  type Speech,
  useDismiss,
} from "./prompt-box.tsx";

/** What the workspace knows about a tile's harness, for its overlay. */
export interface HarnessView {
  spec: HarnessSpec;
  /** The agent hub's entry for the tile (name, status, unread, model), when it has one. */
  hub?: TileInfo;
}

/** What the workspace gives the harness overlays. */
export interface HarnessHooks {
  manager: TerminalManager;
  /** Rename the tile's hub entry; rejects with the reason. */
  rename(tileId: string, name: string): Promise<void>;
  /** The tile's header menu choice: the overlay on or off for it. */
  setOverlay(tileId: string, on: boolean): void;
  /** Settings → Tiles, at the overlay's switch. */
  openSettings(): void;
  close(tileId: string): void;
  /** Hold-to-dictate from the mic button (absent: no voice). */
  dictation?: Dictation;
  /** Read aloud in the companion's voice. */
  speech?: Speech;
}

/** What the inbox button puts in the prompt box. */
const READ_MESSAGES =
  "Read your Qutty messages (read_messages) and act on them.";

/** Each mounted overlay's prompt box insert, by tile id. */
const inserts = new Map<string, (text: string) => void>();

/** Tile `id`'s harness prompt box, when it has the keyboard. */
function promptInput(id: string): HTMLTextAreaElement | null {
  const el = document.querySelector<HTMLTextAreaElement>(
    `[data-testid="tile"][data-id="${
      CSS.escape(id)
    }"] [data-testid="harness-input"]`,
  );
  return el && el === document.activeElement ? el : null;
}

/**
 * Dictation for tile `id`: into its harness prompt box when that box has the keyboard (`true`);
 * `false` leaves it to the terminal.
 */
export function insertIntoHarnessPrompt(id: string, text: string): boolean {
  const insert = inserts.get(id);
  if (!insert || !promptInput(id)) return false;
  insert(text);
  return true;
}

const STATUS_TEXT: Record<TileStatus, string> = {
  busy: "working",
  idle: "idle",
  waiting: "waiting for you",
};

/** An 18px line icon. */
function Icon(props: { children: ReactNode; size?: number }) {
  const size = props.size ?? 18;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.35"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}

/** What the overlay shows of the harness: the hub's word, else busy while its process runs. */
function harnessStatus(entry: TerminalEntry, view: HarnessView): TileStatus {
  return view.hub?.status ?? (entry.running ? "busy" : "idle");
}

const MAIL = <path d="M2 4.25h12v8.5H2zM2.25 4.5 8 9l5.75-4.5" />;

/** The header card's controls (after the tile's title, which CSS hides). */
export function HarnessHead(
  props: { entry: TerminalEntry; view: HarnessView; hooks: HarnessHooks },
) {
  const { entry, view, hooks } = props;
  const { spec, hub } = view;
  const id = entry.id;
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLSpanElement | null>(null);
  useDismiss(menu, anchor, () => setMenu(false));
  const status = harnessStatus(entry, view);
  const unread = hub?.unread ?? 0;
  return (
    <span
      class="harness-head"
      ref={anchor}
      data-testid="harness-head"
      data-harness={spec.id}
    >
      <span class="harness-avatar" aria-hidden="true">{spec.glyph}</span>
      <span class="harness-ident">
        {hub
          ? (
            <NameField
              name={hub.name}
              testid="harness-name"
              onRename={(name) => hooks.rename(id, name)}
            />
          )
          : <span class="harness-plain-name">{spec.id}</span>}
        <span class="harness-chips">
          <span class="harness-chip is-brand" data-testid="harness-label">
            {spec.label}
          </span>
          {hub?.model && (
            <span
              class="harness-chip"
              title="Model"
              data-testid="harness-model"
            >
              {hub.model}
            </span>
          )}
        </span>
      </span>
      <span
        class="harness-status"
        data-testid="harness-status"
        data-status={status}
        title={hub?.note ?? ""}
      >
        <span class="harness-dot" aria-hidden="true" />
        {STATUS_TEXT[status]}
      </span>
      {unread > 0 && (
        <button
          type="button"
          class="harness-inbox"
          data-testid="harness-inbox"
          title={`${unread} unread message${
            unread === 1 ? "" : "s"
          } for this agent: ask it to read them`}
          onClick={() => inserts.get(id)?.(READ_MESSAGES)}
        >
          <Icon size={15}>{MAIL}</Icon>
          {unread}
        </button>
      )}
      <button
        type="button"
        class="harness-icon-btn"
        data-testid="harness-menu"
        title="More"
        aria-label="Harness overlay menu"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
          <circle cx="8" cy="8" r="1.25" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
        </svg>
      </button>
      {menu && (
        <div
          class="menu agent-menu harness-menu"
          role="menu"
          data-testid="harness-more"
        >
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            data-testid="harness-hide"
            title="Show this tile as a plain terminal (its header menu brings the overlay back)"
            onClick={() => {
              setMenu(false);
              hooks.setOverlay(id, false);
            }}
          >
            <span class="menu-label">Hide GUI overlay</span>
          </button>
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            data-testid="harness-settings"
            onClick={() => {
              setMenu(false);
              hooks.openSettings();
            }}
          >
            <span class="menu-label">Overlay settings…</span>
          </button>
          <div class="menu-sep" />
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            data-testid="harness-close"
            onClick={() => {
              setMenu(false);
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
 * The side rail: round buttons floating at the terminal's right edge, maximize and messages at the
 * top, jump top / latest, help and read aloud at the bottom.
 */
function HarnessRail(
  props: {
    id: string;
    view: HarnessView;
    hooks: HarnessHooks;
    maximized: boolean;
    onMaximize(): void;
    onRestore(): void;
  },
) {
  const { id, view, hooks } = props;
  const { manager, speech } = hooks;
  const unread = view.hub?.unread ?? 0;
  const [help, setHelp] = useState(false);
  const helpRef = useRef<HTMLDivElement | null>(null);
  useDismiss(help, helpRef, () => setHelp(false));
  const interruptKey = view.spec.interrupt === "\x03" ? "Ctrl+C" : "Esc";
  return (
    <div
      class="harness-rail"
      data-testid="harness-rail"
      data-companion-avoid=""
    >
      <div class="harness-rail-group">
        <RailButton
          testid="harness-maximize"
          label={props.maximized ? "Restore tile" : "Maximize tile"}
          pressed={props.maximized}
          onClick={props.maximized ? props.onRestore : props.onMaximize}
        >
          {props.maximized
            ? (
              <path d="M6 2.5V6H2.5M10 13.5V10h3.5M2.5 2.5 6 6M13.5 13.5 10 10" />
            )
            : 
            <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />}
        </RailButton>
        <span class="harness-rail-badged">
          <RailButton
            testid="harness-messages"
            label={unread > 0
              ? `${unread} unread message${
                unread === 1 ? "" : "s"
              }: ask the agent to read them`
              : "No unread messages from other agents"}
            disabled={unread === 0}
            onClick={() => inserts.get(id)?.(READ_MESSAGES)}
          >
            <path d="M2.5 3.5h11v7.5H8l-3 2.5V11H2.5z" />
          </RailButton>
          {unread > 0 && <span class="harness-badge">{unread}</span>}
        </span>
      </div>
      <div class="harness-rail-group" ref={helpRef}>
        <RailButton
          testid="harness-top"
          label="Jump to top"
          onClick={() => manager.scrollTo(id, "top")}
        >
          <path d="M3.5 2.5h9M8 13.5V5.5M4.5 9 8 5.5 11.5 9" />
        </RailButton>
        <RailButton
          testid="harness-latest"
          label="Jump to latest"
          onClick={() => manager.scrollTo(id, "bottom")}
        >
          <path d="M3.5 13.5h9M8 2.5v8M4.5 7 8 10.5 11.5 7" />
        </RailButton>
        <RailButton
          testid="harness-help"
          label="How the overlay works"
          pressed={help}
          onClick={() => setHelp(!help)}
        >
          <circle cx="8" cy="8" r="5.75" />
          <path d="M6.4 6.3a1.7 1.7 0 0 1 3.3.5c0 1.1-1.7 1.4-1.7 2.5M8 11.3v.1" />
        </RailButton>
        {speech && (
          <RailButton
            testid="harness-speak"
            label={speech.speaking ? "Stop reading" : "Read the screen aloud"}
            pressed={speech.speaking}
            onClick={() => {
              if (speech.speaking) return speech.stop();
              const text = speakableScreen(manager.screenText(id));
              if (text) speech.say(text);
            }}
          >
            <path d="M2.5 6H5l3.5-3v10L5 10H2.5z" />
            {speech.speaking
              ? <path d="M11 6.5l3 3M14 6.5l-3 3" />
              : (
                <path d="M10.75 5.75a3.2 3.2 0 0 1 0 4.5M12.6 4a5.6 5.6 0 0 1 0 8" />
              )}
          </RailButton>
        )}
        {help && (
          <div class="harness-help" role="note" data-testid="harness-help-card">
            <div class="harness-help-title">{view.spec.label}, with a GUI</div>
            <ul>
              <li>
                The terminal is the harness's own: click it to type there.
              </li>
              <li>
                <b>Enter</b> sends the prompt box, <b>Shift+Enter</b>{" "}
                is a new line, <b>↑ ↓</b> walk your prompts.
              </li>
              <li>Interrupt sends {interruptKey}.</li>
              <li>
                Right-click the header to turn the overlay off for this tile.
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** The side rail and the prompt box, after the terminal's host in the tile's body frame. */
export function HarnessControls(
  props: {
    entry: TerminalEntry;
    view: HarnessView;
    hooks: HarnessHooks;
    maximized: boolean;
    onMaximize(): void;
    onRestore(): void;
  },
) {
  const { entry, view, hooks } = props;
  const id = entry.id;
  const { manager } = hooks;
  /** The prompts sent from this box, oldest first (↑ brings them back first). */
  const sent = useRef<string[]>([]);
  const onInsert = useCallback((cb: (s: string) => void) => {
    inserts.set(id, cb);
    return () => {
      if (inserts.get(id) === cb) inserts.delete(id);
    };
  }, [id]);
  const send = (text: string, files: AgentAttachment[]) => {
    if (text) sent.current = [...sent.current, text].slice(-50);
    const typed = withFiles(
      text,
      files.flatMap((f) =>
        f.kind === "text" ? [{ name: f.name, text: f.data }] : []
      ),
    );
    void manager.sendPrompt(id, typed);
  };
  const interruptKey = view.spec.interrupt === "\x03" ? "Ctrl+C" : "Esc";
  // Interrupt only while there is a turn to stop (busy, or asking you something).
  const stoppable = harnessStatus(entry, view) !== "idle";
  return (
    <>
      <HarnessRail
        id={id}
        view={view}
        hooks={hooks}
        maximized={props.maximized}
        onMaximize={props.onMaximize}
        onRestore={props.onRestore}
      />
      <PromptBox
        testPrefix="harness"
        class="harness-prompt"
        disabled={false}
        placeholder={promptPlaceholder(view.spec)}
        hint="Enter to send, Shift+Enter for a new line"
        sendLabel="Send"
        sendTitle="Send (Enter): types it into the terminal and presses Enter"
        images={false}
        own={() => sent.current}
        onSend={send}
        {...(stoppable
          ? {
            stop: {
              label: "Interrupt",
              title: `Interrupt ${view.spec.label} (sends ${interruptKey})`,
              testid: "harness-interrupt",
              run: () => manager.sendKeys(id, view.spec.interrupt),
            },
          }
          : {})}
        onInsert={onInsert}
        {...(hooks.dictation ? { dictation: hooks.dictation } : {})}
        dropZone=".harness-frame"
      />
    </>
  );
}
