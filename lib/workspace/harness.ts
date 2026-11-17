/**
 * The harness overlay's logic (app/harness-overlay.tsx draws it): which coding-agent harness a
 * terminal tile runs, if any, how the prompt box types a prompt into it, which key interrupts it,
 * and the screen's text as something worth reading aloud.
 *
 * Detection reads what Qutty already knows about a tile, strongest first:
 *
 * - the agent hub's registration (`qutty-hook` SessionStart, or the MCP handshake, sets the
 *   tile's `harness`);
 * - the agent tool the tile was launched as (the `+` picker's `agent:claude`, an Ollama pair);
 * - the foreground process (`info`: `claude`, `codex`, `gemini`, `opencode`, `aider`, …);
 * - the title the program set (OSC 0 / 2: Claude Code's "✳ Claude Code", "Codex", …).
 *
 * A shell in the foreground means the harness has exited (the hub keeps a tile's harness once it
 * registered), so nothing is detected then, and nothing in an exited tile.
 *
 * Pure and client-safe.
 *
 * @module
 */

import { tileInput } from "../hub/tile-input.ts";
import { harnessLabel, OLLAMA_HARNESSES } from "../ollama/harnesses.ts";

/** A harness the overlay knows how to frame. */
export interface HarnessSpec {
  /** The hub's name for it (`claude`, `codex`, …). */
  id: string;
  /** Its product name (`Claude Code`). */
  label: string;
  /** The header's glyph. */
  glyph: string;
  /** What its Interrupt button sends: Esc for most TUIs, Ctrl+C where Esc does nothing. */
  interrupt: string;
}

const ESC = "\x1b";
const CTRL_C = "\x03";

/** The harnesses with a look of their own, and the process names and titles that give them away. */
const KNOWN:
  readonly (HarnessSpec & { processes: string[]; title?: RegExp })[] = [
    {
      id: "claude",
      label: "Claude Code",
      glyph: "✻",
      interrupt: ESC,
      processes: ["claude"],
      title: /\bclaude code\b/i,
    },
    {
      id: "codex",
      label: "Codex",
      glyph: "◎",
      interrupt: ESC,
      processes: ["codex"],
      title: /\bcodex\b/i,
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      glyph: "✦",
      interrupt: ESC,
      processes: ["gemini"],
      title: /\bgemini\b/i,
    },
    {
      id: "opencode",
      label: "OpenCode",
      glyph: "◇",
      interrupt: ESC,
      processes: ["opencode"],
      title: /\bopencode\b/i,
    },
    {
      id: "aider",
      label: "aider",
      glyph: "◆",
      // aider reads its prompt with prompt_toolkit: Ctrl+C stops a reply, Esc does nothing.
      interrupt: CTRL_C,
      processes: ["aider"],
      title: /\baider\b/i,
    },
  ];

/** Shells: in the foreground, the harness that ran in the tile has exited. */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "login",
  "demo-sh",
]);

/** The spec for a harness name (`claude`); an unknown harness gets a plain one. */
export function harnessSpec(name: string): HarnessSpec {
  const id = name.trim().toLowerCase();
  const known = KNOWN.find((h) => h.id === id);
  if (known) {
    const { processes: _p, title: _t, ...spec } = known;
    return spec;
  }
  return { id, label: harnessLabel(id), glyph: "◆", interrupt: ESC };
}

/** A harness name from a foreground process name (`claude`, `/usr/local/bin/codex`). */
function byProcess(process: string): string | undefined {
  const base = process.trim().split("/").pop()?.toLowerCase() ?? "";
  const known = KNOWN.find((h) => h.processes.includes(base));
  if (known) return known.id;
  return OLLAMA_HARNESSES.some((h) => h.name === base) ? base : undefined;
}

/** A harness name from the title a program set. */
function byTitle(title: string): string | undefined {
  return KNOWN.find((h) => h.title?.test(title))?.id;
}

/** Whether a process name is a shell (`-zsh`, a login shell, counts). */
export function isShellProcess(process: string): boolean {
  const base = process.trim().split("/").pop()?.replace(/^-/, "")
    .toLowerCase() ?? "";
  return SHELLS.has(base);
}

/** What {@linkcode detectHarness} reads about a tile. */
export interface HarnessSignals {
  /** The agent hub's harness for the tile (`TileInfo.harness`). */
  hubHarness?: string;
  /** The agent tool it was launched as (`claude`, or `claude · qwen3:8b` for an Ollama pair). */
  agent?: string;
  /** The foreground process, from the last `info` poll (unset until one came back). */
  process?: string;
  /** The title the program set (OSC 0 / 2). */
  programTitle?: string;
  /** The tile's program ended. */
  exited?: boolean;
  /** An SSH tile: its foreground process is always `ssh`, so only the hub can say. */
  ssh?: boolean;
}

/** The harness tile `t` runs now, or `null`. */
export function detectHarness(t: HarnessSignals): HarnessSpec | null {
  if (t.exited) return null;
  if (t.process !== undefined && isShellProcess(t.process)) return null;
  const agent = t.agent?.split(" · ")[0];
  const name = t.hubHarness ||
    agent ||
    (t.ssh ? undefined : t.process && byProcess(t.process)) ||
    (t.ssh ? undefined : t.programTitle && byTitle(t.programTitle));
  return name ? harnessSpec(name) : null;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * What the prompt box writes to the terminal to send `text`, in order: the text as xterm pastes
 * it (line breaks as carriage returns, wrapped in bracketed-paste markers when the program turned
 * that mode on, DECSET 2004), then Enter on its own. A trailing line break (or a literal `\r` /
 * `\n`, as `write_tile` reads them) is the Enter, never text. Paste markers inside the text are
 * dropped, so a prompt cannot end the paste early. Empty text: just Enter.
 */
export function promptChunks(text: string, bracketed: boolean): string[] {
  const typed = tileInput(text, true);
  const body = typed.slice(0, -1)
    .replaceAll(PASTE_START, "")
    .replaceAll(PASTE_END, "")
    .replace(/\r?\n/g, "\r");
  if (!body) return ["\r"];
  return [bracketed ? `${PASTE_START}${body}${PASTE_END}` : body, "\r"];
}

/** A text file attached in the prompt box, as it is typed after the prompt. */
export interface PromptFile {
  name: string;
  text: string;
}

/** The prompt with its attached text files after it, each in a fence named after it. */
export function withFiles(text: string, files: readonly PromptFile[]): string {
  const parts = [text.trim()];
  for (const f of files) {
    const body = f.text.replace(/\n$/, "");
    const fence = body.includes("```") ? "````" : "```";
    parts.push(`${f.name}:\n${fence}\n${body}\n${fence}`);
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

/** Box-drawing and block characters TUIs draw their frames with. */
const FRAME = /[─-▟]/g;

/**
 * The screen's text, as something to read aloud: the frames TUIs draw (box-drawing characters)
 * and blank lines gone, each line trimmed.
 */
export function speakableScreen(screen: string): string {
  return screen.split("\n")
    .map((l) => l.replace(FRAME, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l !== "" && /[\p{L}\p{N}]/u.test(l))
    .join("\n");
}
