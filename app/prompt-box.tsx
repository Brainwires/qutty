// The prompt box and the side rail, shared by the agent tile (app/agent-tile.tsx: a chat with a
// coding agent) and the harness overlay (app/harness-overlay.tsx: the GUI around a harness's own
// terminal UI). The parts without a DOM are lib/agent/prompt-box.ts.
//
// - `PromptBox`: two lines at least, it grows with its text; Enter sends, Shift+Enter is a new
//   line; ↑ at the text's start (↓ at its end; either end of one line) walks the prompt history
//   (every tile's prompts, this tile's first). Its toolbar: attach files (also by drop or paste),
//   a picture of a web tile (where the engine can take one), saved prompts (inserted at the
//   caret; the current prompt saved), the history menu, hold-to-dictate (with the companion), a
//   Stop / Interrupt button and Send. History and saved prompts live in localStorage.
// - `SideRail`: jump to the top, jump to the latest, maximize / restore the tile, and read aloud
//   (the companion's voice; again to stop).
//
// Each instance names its test ids with a prefix (`agent-input`, `harness-input`). No new
// shortcuts: inside the box the usual text keys. No timers: the caret goes where an insert left it
// in a layout effect.

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "denext";
import type { AgentAttachment } from "../lib/agent/adapter.ts";
import {
  addSaved,
  HISTORY_MAX,
  HISTORY_STORAGE_KEY,
  historyStep,
  insertAtCaret,
  mergeHistory,
  parsePromptList,
  pushPrompt,
  recallsHistory,
  removeSaved,
  SAVED_MAX,
  SAVED_STORAGE_KEY,
} from "../lib/agent/prompt-box.ts";
import { useHtmlOverlay } from "./use-html-overlay.ts";

/** Close a popover on a press outside `ref` or Escape. */
export function useDismiss(
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
// The side rail
// ---------------------------------------------------------------------------------------------

/** A side rail button (an icon; a press does not take the keyboard from where it is). */
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

/** Read aloud in the companion's voice; `speaking` while anything is said. */
export interface Speech {
  speaking: boolean;
  say(text: string): void;
  stop(): void;
}

/** Top, latest, maximize / restore, read aloud. */
export function SideRail(
  props: {
    /** Test ids: `<prefix>-rail`, `<prefix>-top`, … */
    testPrefix: string;
    /** Extra classes (the harness overlay's rail sits beside the terminal, not over it). */
    class?: string;
    speech: Speech | undefined;
    /** What Read aloud reads (`""`: nothing to read); called when it is pressed. */
    speakText(): string;
    /** Whether there is anything to read (the button is disabled otherwise). */
    canSpeak: boolean;
    /** The button's label ("Read the last reply aloud"). */
    speakLabel: string;
    maximized: boolean;
    onTop(): void;
    onLatest(): void;
    onMaximize(): void;
  },
) {
  const { speech, testPrefix: p } = props;
  return (
    <div
      class={`agent-rail${props.class ? ` ${props.class}` : ""}`}
      data-testid={`${p}-rail`}
    >
      <RailButton testid={`${p}-top`} label="Jump to top" onClick={props.onTop}>
        <path d="M3.5 2.5h9M8 13.5V5.5M4.5 9 8 5.5 11.5 9" />
      </RailButton>
      <RailButton
        testid={`${p}-latest`}
        label="Jump to latest"
        onClick={props.onLatest}
      >
        <path d="M3.5 13.5h9M8 2.5v8M4.5 7 8 10.5 11.5 7" />
      </RailButton>
      <RailButton
        testid={`${p}-maximize`}
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
          testid={`${p}-speak`}
          label={speech.speaking ? "Stop reading" : props.speakLabel}
          pressed={speech.speaking}
          disabled={!speech.speaking && !props.canSpeak}
          onClick={() => {
            if (speech.speaking) return speech.stop();
            const text = props.speakText();
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
async function attachmentOf(
  file: File,
  images: boolean,
): Promise<AgentAttachment | string> {
  if (IMAGE_TYPES.test(file.type)) {
    if (!images) {
      return `${file.name}: a picture cannot be typed into a terminal`;
    }
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
  return images
    ? `${file.name}: only images and text files can be attached`
    : `${file.name}: only text files can be attached`;
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

/** Hold-to-dictate (the companion's speech to text). */
export interface Dictation {
  press(): void;
  release(heldMs: number): void;
}

/** Pictures of other tiles to attach (web tiles where the engine can take one). */
export interface Capture {
  tiles(): { id: string; title: string }[];
  /** The picture (attached as a dropped image is), or why not. */
  take(id: string): Promise<File | string>;
}

export interface PromptBoxProps {
  /** Test ids: `<prefix>-input`, `<prefix>-send`, … */
  testPrefix: string;
  /** Extra classes on the box. */
  class?: string;
  /** Sending does nothing yet (the agent has not started). */
  disabled: boolean;
  placeholder: string;
  /** The toolbar's quiet hint. */
  hint: string;
  /** The Send button's text and tooltip. */
  sendLabel: string;
  sendTitle: string;
  /** Messages waiting to be sent (an agent tile's queue), above the text. */
  queue?: readonly string[];
  /** Pictures can be attached (an agent tile; a terminal takes text only). */
  images: boolean;
  /** This tile's own prompts, oldest first (↑ brings them back first). */
  own(): string[];
  /** Send the prompt (trimmed) and its attachments. */
  onSend(text: string, files: AgentAttachment[]): void;
  /** Escape in the box; `true`: it was handled (an agent tile interrupts its turn). */
  onEscape?(): boolean;
  /** The red button before Send (Stop, Interrupt). */
  stop?: { label: string; title: string; testid: string; run(): void };
  /** Dictation and the companion type here: subscribe to what they insert. */
  onInsert?(cb: (s: string) => void): () => void;
  dictation?: Dictation;
  capture?: Capture;
  /** The closest ancestor (a selector) that takes dropped files for the box. */
  dropZone: string;
  /** The box's text area, for the caller (focus it). */
  inputRef?: { current: HTMLTextAreaElement | null };
}

/** A tile's prompt box. */
export function PromptBox(props: PromptBoxProps) {
  const { dictation, capture, testPrefix: p } = props;
  const ownInput = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = props.inputRef ?? ownInput;
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
  const onInsert = props.onInsert;
  useEffect(() => onInsert?.((s) => insertRef.current(s)), [onInsert]);

  /** The history ↑ walks (and its menu lists): every tile's, this tile's on top. */
  const history = () =>
    mergeHistory(loadPrompts(HISTORY_STORAGE_KEY, HISTORY_MAX), props.own());

  const add = async (list: FileList | File[] | null | undefined) => {
    if (!list) return;
    const out: AgentAttachment[] = [];
    const notes: string[] = [];
    for (const f of Array.from(list)) {
      const a = await attachmentOf(f, props.images);
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
    props.onSend(body, files);
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
    if (which === "shot") setShots(capture?.tiles() ?? []);
    setMenu(which);
  };
  const keepSaved = (list: string[]) => {
    setSaved(list);
    savePrompts(SAVED_STORAGE_KEY, list);
  };
  const takeShot = (tileId: string) => {
    setMenu("none");
    inputRef.current?.focus({ preventScroll: true });
    void capture?.take(tileId).then(
      (f) => typeof f === "string" ? attach([], [f]) : add([f]),
      (e) => attach([], [`no picture: ${e instanceof Error ? e.message : e}`]),
    );
  };

  // Files dropped anywhere in the drop zone attach.
  const addRef = useRef(add);
  addRef.current = add;
  const promptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const zone = promptRef.current?.closest<HTMLElement>(props.dropZone);
    if (!zone) return;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.target === zone) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      setDragging(false);
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      e.stopPropagation();
      void addRef.current(e.dataTransfer.files);
    };
    zone.addEventListener("dragover", over);
    zone.addEventListener("dragleave", leave);
    zone.addEventListener("drop", drop);
    return () => {
      zone.removeEventListener("dragover", over);
      zone.removeEventListener("dragleave", leave);
      zone.removeEventListener("drop", drop);
    };
  }, [props.dropZone]);

  const queue = props.queue ?? [];
  const release = () => {
    if (pressAt.current === undefined) return;
    dictation?.release(Date.now() - pressAt.current);
    pressAt.current = undefined;
  };
  return (
    <div
      class={`agent-prompt${props.class ? ` ${props.class}` : ""}${
        dragging ? " is-dragging" : ""
      }`}
      data-testid={`${p}-prompt`}
      ref={promptRef}
    >
      {queue.length > 0 && (
        <div class="agent-queue" data-testid={`${p}-queue`}>
          {queue.map((q, i) => (
            <div class="agent-queued" key={i}>
              <span class="agent-dim">queued ›</span> {q}
            </div>
          ))}
        </div>
      )}
      {(files.length > 0 || note) && (
        <div class="agent-files" data-testid={`${p}-files`}>
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
          data-testid={`${p}-input`}
          rows={2}
          spellcheck={false}
          placeholder={props.placeholder}
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
            if (e.key === "Escape" && props.onEscape?.()) {
              e.preventDefault();
              e.stopPropagation();
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
          data-testid={`${p}-file-input`}
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            void add(input.files).then(() => {
              input.value = "";
            });
          }}
        />
        <ToolButton
          testid={`${p}-attach`}
          label={props.images
            ? "Attach files (or drop or paste them)"
            : "Attach text files (or drop them): typed after the prompt"}
          onClick={() => fileRef.current?.click()}
        >
          <path d="M10.5 4.5 5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2" />
        </ToolButton>
        {capture && (
          <ToolButton
            testid={`${p}-screenshot`}
            label="Attach a picture of a web tile"
            expanded={menu === "shot"}
            onClick={() => openMenu("shot")}
          >
            <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.8l1-1.5h3.4l1 1.5h1.8A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
            <circle cx="8" cy="8.5" r="2.3" />
          </ToolButton>
        )}
        <ToolButton
          testid={`${p}-saved`}
          label="Saved prompts"
          expanded={menu === "saved"}
          onClick={() => openMenu("saved")}
        >
          <path d="M4 2.5h8v11l-4-3-4 3z" />
        </ToolButton>
        <ToolButton
          testid={`${p}-history`}
          label="Prompt history (↑ / ↓ in the box)"
          expanded={menu === "history"}
          onClick={() => openMenu("history")}
        >
          <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8M2.5 2.5v2.3h2.3M8 5v3.2l2.2 1.4" />
        </ToolButton>
        {dictation && (
          <button
            type="button"
            class="agent-tool-btn"
            data-testid={`${p}-mic`}
            title="Hold to dictate into the prompt"
            aria-label="Dictate"
            onPointerDown={(e) => {
              e.preventDefault();
              pressAt.current = Date.now();
              dictation.press();
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
        <span class="agent-hint">{props.hint}</span>
        {props.stop && (
          <button
            type="button"
            class="agent-stop"
            data-testid={props.stop.testid}
            title={props.stop.title}
            onPointerDown={(e) => e.preventDefault()}
            onClick={props.stop.run}
          >
            {props.stop.label}
          </button>
        )}
        <button
          type="button"
          class="agent-send"
          data-testid={`${p}-send`}
          title={props.sendTitle}
          disabled={props.disabled || (!text.trim() && files.length === 0)}
          onClick={send}
        >
          {props.sendLabel}
        </button>
        {menu === "saved" && (
          <div
            class="menu agent-menu agent-pop"
            role="menu"
            data-testid={`${p}-saved-menu`}
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
                  data-testid={`${p}-saved-item`}
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
                  data-testid={`${p}-saved-remove`}
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
              data-testid={`${p}-saved-add`}
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
            data-testid={`${p}-history-menu`}
          >
            {recent.length === 0 && (
              <div class="agent-pop-empty">No prompts yet</div>
            )}
            {recent.map((s, i) => (
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                data-testid={`${p}-history-item`}
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
            data-testid={`${p}-shot-menu`}
          >
            {shots.length === 0 && (
              <div class="agent-pop-empty">No web tile to picture</div>
            )}
            {shots.map((s) => (
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                data-testid={`${p}-shot-item`}
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
