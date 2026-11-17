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
//   hold-to-dictate (with the companion), Interrupt and Send. Sending types the prompt into the
//   terminal as a paste of it would arrive (bracketed when the harness turned that mode on), then
//   presses Enter; Interrupt sends the harness's interrupt key (Esc, or Ctrl+C for aider).
// - The side rail, beside the terminal: jump to the top of its scrollback, jump to the latest,
//   maximize / restore the tile, and read the screen aloud in the companion's voice.
//
// Keyboard: the terminal keeps the keyboard (a focused tile focuses its terminal, as always);
// clicking the prompt box gives it the keyboard, clicking the terminal gives it back. Dictation
// lands in the prompt box while it has the keyboard (`insertIntoHarnessPrompt`), else in the
// terminal as before. No shortcuts of its own, no timers.

import { useCallback, useRef, useState } from "denext";
import type { AgentAttachment } from "../lib/agent/adapter.ts";
import type { TileInfo, TileStatus } from "../lib/hub/protocol.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import {
  type HarnessSpec,
  speakableScreen,
  withFiles,
} from "../lib/workspace/harness.ts";
import type { TerminalEntry } from "../lib/workspace/store.ts";
import { NameField } from "./agent-tile.tsx";
import {
  type Dictation,
  PromptBox,
  SideRail,
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
  const status: TileStatus = hub?.status ?? (entry.running ? "busy" : "idle");
  const unread = hub?.unread ?? 0;
  return (
    <span
      class="harness-head"
      ref={anchor}
      data-testid="harness-head"
      data-harness={spec.id}
    >
      <span class="harness-glyph" aria-hidden="true">{spec.glyph}</span>
      {hub
        ? (
          <NameField
            name={hub.name}
            testid="harness-name"
            onRename={(name) => hooks.rename(id, name)}
          />
        )
        : <span class="harness-plain-name">{spec.id}</span>}
      <span class="harness-label" data-testid="harness-label">
        {spec.label}
      </span>
      {hub?.model && (
        <span class="harness-model" title="Model" data-testid="harness-model">
          {hub.model}
        </span>
      )}
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
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M2.5 4.5h11v7h-11zM2.5 4.5 8 9l5.5-4.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </svg>
          {unread}
        </button>
      )}
      <button
        type="button"
        class="agent-more harness-more"
        data-testid="harness-menu"
        title="More"
        aria-label="Harness overlay menu"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
      >
        ⋯
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
  return (
    <>
      <SideRail
        testPrefix="harness"
        class="harness-rail"
        speech={hooks.speech}
        canSpeak
        speakText={() => speakableScreen(manager.screenText(id))}
        speakLabel="Read the screen aloud"
        maximized={props.maximized}
        onTop={() => manager.scrollTo(id, "top")}
        onLatest={() => manager.scrollTo(id, "bottom")}
        onMaximize={props.maximized ? props.onRestore : props.onMaximize}
      />
      <PromptBox
        testPrefix="harness"
        class="harness-prompt"
        disabled={false}
        placeholder={`Message ${view.spec.label}: Enter to send, Shift+Enter for a new line`}
        hint="types into the terminal · ↑↓ history"
        sendLabel="Send ↵"
        sendTitle="Type it into the terminal and press Enter"
        images={false}
        own={() => sent.current}
        onSend={send}
        stop={{
          label: "■ Interrupt",
          title: `Interrupt ${view.spec.label} (sends ${interruptKey})`,
          testid: "harness-interrupt",
          run: () => manager.sendKeys(id, view.spec.interrupt),
        }}
        onInsert={onInsert}
        {...(hooks.dictation ? { dictation: hooks.dictation } : {})}
        dropZone=".harness-frame"
      />
    </>
  );
}
