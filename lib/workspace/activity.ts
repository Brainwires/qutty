/**
 * Tile activity: what an unfocused tile's header, border and switcher-bar chip say happened in it
 * while you looked elsewhere, as one state per tile. The workspace store keeps the raw signals
 * on each entry ({@linkcode TileSignals}: output, a bell, a command running or ended, from the
 * terminal manager and the shell's OSC 133 marks); the agent hub adds an agent's busy / waiting
 * status; {@linkcode tileActivity} folds them into one {@linkcode ActivityState}, highest first:
 *
 * - `attention`: a bell, or an agent waiting for the user (latched until the tile is focused);
 * - `failed`: a command ended with a non-zero exit while unfocused (latched until focus);
 * - `busy`: a command is running (between OSC 133 `C` and `D`), or the agent is busy (live);
 * - `done`: a command ended with exit 0 while unfocused, for {@linkcode DONE_MS}, then whatever is
 *   below it (cleared by focus too);
 * - `output`: new output while unfocused (latched until focus);
 * - `none`.
 *
 * The focused tile, an exited one and a web tile show nothing (a running command in the focused
 * tile is in plain sight). Settings → Tiles picks Full / Subtle / Off and turns the latched states
 * off one by one ({@linkcode ActivitySettings}); busy follows the main switch.
 *
 * Program titles (OSC 0 / 2) live here too: {@linkcode sanitizeProgramTitle} cleans what a
 * program sets, and {@linkcode displayTitle} picks what a tile's header and chip show.
 *
 * Client-safe and pure.
 *
 * @module
 */

import type { TileStatus } from "../hub/protocol.ts";

/** One tile's activity, as `data-activity` spells it. */
export type ActivityState =
  | "attention"
  | "failed"
  | "busy"
  | "done"
  | "output"
  | "none";

/** How long `done` shows after a command ended well, ms. */
export const DONE_MS = 4000;

/** Settings → Tiles → Activity indicators. */
export type ActivityIndicators = "full" | "subtle" | "off";

/** Every indicator mode, in the order the settings panel lists them. */
export const ACTIVITY_INDICATORS: readonly ActivityIndicators[] = [
  "full",
  "subtle",
  "off",
];

/** Settings → Tiles: the indicators' mode and which latched states show. */
export interface ActivitySettings {
  /** Full (header tint, shimmer, border), Subtle (border and a dot) or Off. */
  indicators: ActivityIndicators;
  /** A bell or an agent waiting for the user (`attention`). */
  bell: boolean;
  /** A command that failed (`failed`). */
  failed: boolean;
  /** A command that ended well (`done`). */
  done: boolean;
  /** New output (`output`). */
  output: boolean;
}

/** The per-state switches, in the order the settings panel lists them. */
export const ACTIVITY_TOGGLES = ["bell", "failed", "done", "output"] as const;

export const DEFAULT_ACTIVITY: ActivitySettings = {
  indicators: "full",
  bell: true,
  failed: true,
  done: true,
  output: true,
};

/** Clamp an untrusted partial activity settings object onto `base`. */
export function sanitizeActivity(
  raw: unknown,
  base: ActivitySettings = DEFAULT_ACTIVITY,
): ActivitySettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof ActivitySettings, unknown>>;
  if (ACTIVITY_INDICATORS.includes(r.indicators as ActivityIndicators)) {
    out.indicators = r.indicators as ActivityIndicators;
  }
  for (const key of ACTIVITY_TOGGLES) {
    if (typeof r[key] === "boolean") out[key] = r[key] as boolean;
  }
  return out;
}

/** Settings → Tiles → Tile title: the program's own title (OSC 0 / 2) or the process and folder. */
export type TileTitle = "program" | "process";

/** Every tile-title choice, in the order the settings panel lists them. */
export const TILE_TITLES: readonly TileTitle[] = ["program", "process"];

/** A stored / untrusted value → a tile-title choice (`program` for anything unknown). */
export function sanitizeTileTitle(raw: unknown): TileTitle {
  return raw === "process" ? "process" : "program";
}

/**
 * The raw signals a tile's entry carries (lib/workspace/store.ts), cleared by focus. None of them
 * outlives the page: a workspace shown again starts with them clear ({@linkcode clearSignals}).
 */
export interface TileSignals {
  /** Output arrived while the tile was not focused. */
  activity: boolean;
  /** A bell rang (or an agent started waiting) while the tile was not focused. */
  bell?: boolean;
  /** A command is running (OSC 133 `C` seen, its `D` not yet). */
  running?: boolean;
  /** A command ended with a non-zero exit while the tile was not focused. */
  failed?: boolean;
  /** When a command ended with exit 0 while the tile was not focused (ms). */
  doneAt?: number;
  /** The title the program set (OSC 0 / 2), sanitized; unset when none or cleared. */
  programTitle?: string;
}

/** `t` with every signal clear (the program title too: a replay sets it again). */
export function clearSignals<T extends TileSignals>(t: T): T {
  const {
    bell: _b,
    running: _r,
    failed: _f,
    doneAt: _d,
    programTitle: _p,
    ...rest
  } = t;
  return { ...rest, activity: false } as T;
}

/** What {@linkcode tileActivity} reads about a tile. */
export interface ActivityInput extends TileSignals {
  focused: boolean;
  exited: boolean;
  /** Set for a web tile (never an indicator). */
  web?: unknown;
  /** The agent hub's status for the tile's agent, if it runs one. */
  agentStatus?: TileStatus;
}

/** The one activity state a tile shows at `now` (ms). */
export function tileActivity(
  t: ActivityInput,
  settings: ActivitySettings,
  now: number,
): ActivityState {
  if (settings.indicators === "off" || t.focused || t.exited || t.web) {
    return "none";
  }
  if (settings.bell && (t.bell || t.agentStatus === "waiting")) {
    return "attention";
  }
  if (settings.failed && t.failed) return "failed";
  if (t.running || t.agentStatus === "busy") return "busy";
  if (settings.done && t.doneAt !== undefined && now < t.doneAt + DONE_MS) {
    return "done";
  }
  if (settings.output && t.activity) return "output";
  return "none";
}

/**
 * When the next `done` decays (ms), so the page can re-render then; `null` when none is showing
 * after `now`.
 */
export function nextDecay(
  tiles: readonly Pick<TileSignals, "doneAt">[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const t of tiles) {
    if (t.doneAt === undefined) continue;
    const at = t.doneAt + DONE_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/** The longest program title kept (characters). */
export const MAX_PROGRAM_TITLE = 200;

/**
 * A title a program set (OSC 0 / 2) made safe to show: control characters (C0, DEL, C1) become
 * spaces, runs of white space one, trimmed, at most {@linkcode MAX_PROGRAM_TITLE} characters.
 * `undefined` when nothing is left (an empty title clears the program's).
 */
export function sanitizeProgramTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const clean = raw
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return undefined;
  const chars = [...clean];
  return chars.length > MAX_PROGRAM_TITLE
    ? chars.slice(0, MAX_PROGRAM_TITLE).join("").trimEnd()
    : clean;
}

/** What {@linkcode displayTitle} reads about a tile. */
export interface TitledTile {
  /** The process / folder title (or an SSH host's label, a web page's title). */
  title: string;
  programTitle?: string;
  web?: unknown;
  /** An agent tool's tile: its command name. */
  agent?: { name: string };
  /** An SSH tile: its host label. */
  ssh?: { label: string };
}

/**
 * The title a tile's header and chip show: the program's own title when it set one and the
 * setting allows, else the process / folder title. A tile known by a name (an agent tool's, an
 * SSH host's) keeps it in front ("claude · Fixing the build") unless the program's title already
 * says it. A web tile always shows its page's title.
 */
export function displayTitle(t: TitledTile, choice: TileTitle): string {
  const program = t.programTitle;
  if (choice !== "program" || !program || t.web) return t.title;
  const name = t.agent?.name ?? t.ssh?.label;
  if (!name || program.toLowerCase().includes(name.toLowerCase())) {
    return program;
  }
  return `${name} · ${program}`;
}
