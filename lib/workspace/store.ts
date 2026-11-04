/**
 * Workspace state: the terminals, their MRU order, the focused one, and the user's layout /
 * switcher-bar settings. A pure reducer (`reduce`) plus selectors and localStorage persistence,
 * so the UI is a thin shell around it and the logic is unit-testable without a DOM.
 *
 * Ids are supplied by the caller (`add` takes one) so the reducer stays deterministic.
 *
 * @module
 */

import {
  DEFAULT_LAYOUT_OPTIONS,
  type LayoutOptions,
  type LayoutPattern,
  PATTERN_INFO,
  touch,
} from "../layout/mod.ts";
import {
  DEFAULT_FONT_SETTINGS,
  type FontSettings,
  sanitizeFont,
  stepFontSize,
} from "./fonts.ts";

/** Where the switcher bar sits. */
export type BarPosition = "top" | "bottom" | "left" | "right";
/** How the bar orders its chips. */
export type BarOrder = "mru" | "created";

/** Every bar position, in the order `cycleBarPosition` walks them. */
export const BAR_POSITIONS: readonly BarPosition[] = [
  "top",
  "bottom",
  "left",
  "right",
];
/** Every pattern, in the order `cyclePattern` walks them. */
export const PATTERNS: readonly LayoutPattern[] = Object.keys(
  PATTERN_INFO,
) as LayoutPattern[];

/** One terminal as the workspace sees it (the xterm/PTY side lives in the terminal manager). */
export interface TerminalEntry {
  id: string;
  /** "zsh — ~/Source"; starts as a placeholder until the first `info` poll. */
  title: string;
  createdAt: number;
  lastUsedAt: number;
  exited: boolean;
  exitCode: number | null;
  /** Output arrived while the terminal was not focused (cleared on focus). */
  activity: boolean;
}

/** What is persisted between runs (the terminal font fields come from `FontSettings`). */
export interface Settings extends FontSettings {
  layout: LayoutOptions;
  barPosition: BarPosition;
  barOrder: BarOrder;
}

/** The whole workspace. */
export interface WorkspaceState {
  /** In creation order. */
  terminals: TerminalEntry[];
  /** Most recently used first; `mru[0]` is the focused terminal. */
  mru: string[];
  /** Always `mru[0] ?? null` (kept as a field for readability at call sites). */
  focusedId: string | null;
  settings: Settings;
  /** The pattern to return to when monocle is toggled off; `null` when monocle was picked directly. */
  previousPattern: LayoutPattern | null;
  /**
   * An in-progress alt-tab style cycle: the MRU order when the cycle started and the index into
   * it. Focusing through `cycle` keeps this snapshot so repeated presses walk the list rather
   * than bouncing between the top two; any other focus change, or `endCycle`, drops it.
   */
  cycle: { order: string[]; index: number } | null;
}

/** Everything the UI can do to the workspace. */
export type WorkspaceAction =
  | { type: "add"; id: string; now: number; title?: string }
  | { type: "remove"; id: string }
  | { type: "focus"; id: string; now: number }
  | { type: "focusPrevious"; now: number }
  | { type: "focusOrdinal"; ordinal: number; now: number }
  | { type: "cycle"; dir: 1 | -1; now: number }
  | { type: "endCycle" }
  | { type: "exited"; id: string; exitCode: number }
  | { type: "restarted"; id: string; now: number }
  | { type: "title"; id: string; title: string }
  | { type: "activity"; id: string }
  | { type: "setLayout"; patch: Partial<LayoutOptions> }
  | { type: "cyclePattern"; dir?: 1 | -1 }
  | { type: "toggleMonocle" }
  | { type: "setBarPosition"; position: BarPosition }
  | { type: "cycleBarPosition" }
  | { type: "setBarOrder"; order: BarOrder }
  | { type: "setFont"; patch: Partial<FontSettings> }
  | { type: "stepFontSize"; dir: 1 | -1 }
  | { type: "resetFontSize" }
  | { type: "hydrateSettings"; settings: Partial<Settings> };

/** The defaults a fresh workspace starts from. */
export const DEFAULT_SETTINGS: Settings = {
  layout: { ...DEFAULT_LAYOUT_OPTIONS },
  barPosition: "top",
  barOrder: "mru",
  ...DEFAULT_FONT_SETTINGS,
};

/** A fresh, empty workspace. */
export function initialState(
  settings: Settings = DEFAULT_SETTINGS,
): WorkspaceState {
  return {
    terminals: [],
    mru: [],
    focusedId: null,
    settings: cloneSettings(settings),
    previousPattern: null,
    cycle: null,
  };
}

function cloneSettings(s: Settings): Settings {
  return { ...s, layout: { ...s.layout } };
}

/** The range each numeric layout option is clamped to (mirrors the layout engine's). */
export const LAYOUT_RANGES = {
  decay: { min: 0.3, max: 1, step: 0.05 },
  masterRatio: { min: 0.5, max: 0.85, step: 0.01 },
  maxVisible: { min: 1, max: 16, step: 1 },
  gap: { min: 0, max: 32, step: 1 },
} as const;

function clampNumber(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a (partial, possibly untrusted) layout patch onto a base. */
function sanitizeLayout(
  base: LayoutOptions,
  patch: Partial<LayoutOptions>,
): LayoutOptions {
  const out = { ...base };
  if (patch.pattern !== undefined && PATTERNS.includes(patch.pattern)) {
    out.pattern = patch.pattern;
  }
  if (patch.decay !== undefined) {
    out.decay = clampNumber(
      patch.decay,
      LAYOUT_RANGES.decay.min,
      LAYOUT_RANGES.decay.max,
      base.decay,
    );
  }
  if (patch.masterRatio !== undefined) {
    out.masterRatio = clampNumber(
      patch.masterRatio,
      LAYOUT_RANGES.masterRatio.min,
      LAYOUT_RANGES.masterRatio.max,
      base.masterRatio,
    );
  }
  if (patch.maxVisible !== undefined) {
    out.maxVisible = Math.round(
      clampNumber(
        patch.maxVisible,
        LAYOUT_RANGES.maxVisible.min,
        LAYOUT_RANGES.maxVisible.max,
        base.maxVisible,
      ),
    );
  }
  if (patch.gap !== undefined) {
    out.gap = Math.round(
      clampNumber(
        patch.gap,
        LAYOUT_RANGES.gap.min,
        LAYOUT_RANGES.gap.max,
        base.gap,
      ),
    );
  }
  if (patch.minTileW !== undefined) {
    out.minTileW = clampNumber(patch.minTileW, 80, 2000, base.minTileW);
  }
  if (patch.minTileH !== undefined) {
    out.minTileH = clampNumber(patch.minTileH, 40, 2000, base.minTileH);
  }
  return out;
}

/** Clamp an untrusted partial settings object (from storage) onto the defaults. */
export function sanitizeSettings(
  raw: unknown,
  base: Settings = DEFAULT_SETTINGS,
): Settings {
  const out = cloneSettings(base);
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof Settings, unknown>>;
  if (r.layout && typeof r.layout === "object") {
    out.layout = sanitizeLayout(out.layout, r.layout as Partial<LayoutOptions>);
  }
  if (
    typeof r.barPosition === "string" &&
    BAR_POSITIONS.includes(r.barPosition as BarPosition)
  ) {
    out.barPosition = r.barPosition as BarPosition;
  }
  if (r.barOrder === "mru" || r.barOrder === "created") {
    out.barOrder = r.barOrder;
  }
  return { ...out, ...pickFont(sanitizeFont(pickFont(out), r)) };
}

/** Just the font fields of a settings object. */
function pickFont(s: FontSettings): FontSettings {
  return {
    fontFamily: s.fontFamily,
    fontFamilyCustom: s.fontFamilyCustom,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    fontWeight: s.fontWeight,
  };
}

function withFont(
  state: WorkspaceState,
  patch: Partial<FontSettings>,
): WorkspaceState {
  const font = sanitizeFont(pickFont(state.settings), patch);
  const cur = pickFont(state.settings);
  if (
    (Object.keys(font) as (keyof FontSettings)[]).every((k) =>
      font[k] === cur[k]
    )
  ) {
    return state;
  }
  return { ...state, settings: { ...state.settings, ...font } };
}

// ---------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------

/** Terminal ids in the order the switcher bar shows them. */
export function barOrderIds(state: WorkspaceState): string[] {
  return state.settings.barOrder === "mru"
    ? state.mru
    : state.terminals.map((t) => t.id);
}

/** Look a terminal up by id. */
function terminalById(
  state: WorkspaceState,
  id: string,
): TerminalEntry | undefined {
  return state.terminals.find((t) => t.id === id);
}

/** The MRU rank of a terminal (0 = focused), or -1 when unknown. */
function mruRank(state: WorkspaceState, id: string): number {
  return state.mru.indexOf(id);
}

// ---------------------------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------------------------

function withFocus(
  state: WorkspaceState,
  id: string,
  now: number,
  keepCycle = false,
): WorkspaceState {
  if (!state.terminals.some((t) => t.id === id)) return state;
  const mru = touch(state.mru, id);
  return {
    ...state,
    mru,
    focusedId: id,
    cycle: keepCycle ? state.cycle : null,
    terminals: state.terminals.map((t) =>
      t.id === id
        ? (t.lastUsedAt === now && !t.activity
          ? t
          : { ...t, lastUsedAt: now, activity: false })
        : t
    ),
  };
}

function updateTerminal(
  state: WorkspaceState,
  id: string,
  patch: Partial<TerminalEntry>,
): WorkspaceState {
  let changed = false;
  const terminals = state.terminals.map((t) => {
    if (t.id !== id) return t;
    for (const k of Object.keys(patch) as (keyof TerminalEntry)[]) {
      if (t[k] !== patch[k]) changed = true;
    }
    return changed ? { ...t, ...patch } : t;
  });
  return changed ? { ...state, terminals } : state;
}

/** The pure state transition. Unknown ids and no-op changes return the same state object. */
export function reduce(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "add": {
      if (state.terminals.some((t) => t.id === action.id)) return state;
      const entry: TerminalEntry = {
        id: action.id,
        title: action.title ?? "shell",
        createdAt: action.now,
        lastUsedAt: action.now,
        exited: false,
        exitCode: null,
        activity: false,
      };
      return {
        ...state,
        terminals: [...state.terminals, entry],
        mru: touch(state.mru, action.id),
        focusedId: action.id,
        cycle: null,
      };
    }
    case "remove": {
      if (!state.terminals.some((t) => t.id === action.id)) return state;
      const mru = state.mru.filter((x) => x !== action.id);
      return {
        ...state,
        terminals: state.terminals.filter((t) => t.id !== action.id),
        mru,
        focusedId: mru[0] ?? null,
        cycle: null,
      };
    }
    case "focus":
      return withFocus(state, action.id, action.now);
    case "focusPrevious": {
      const prev = state.mru[1];
      return prev === undefined ? state : withFocus(state, prev, action.now);
    }
    case "focusOrdinal": {
      const id = barOrderIds(state)[action.ordinal - 1];
      return id === undefined ? state : withFocus(state, id, action.now);
    }
    case "cycle": {
      if (state.mru.length < 2) return state;
      const cycle = state.cycle ?? { order: state.mru, index: 0 };
      const n = cycle.order.length;
      const index = (cycle.index + action.dir + n) % n;
      const id = cycle.order[index];
      const next = withFocus(state, id, action.now, true);
      return { ...next, cycle: { order: cycle.order, index } };
    }
    case "endCycle":
      return state.cycle === null ? state : { ...state, cycle: null };
    case "exited":
      return updateTerminal(state, action.id, {
        exited: true,
        exitCode: action.exitCode,
      });
    case "restarted":
      return updateTerminal(state, action.id, {
        exited: false,
        exitCode: null,
        lastUsedAt: action.now,
      });
    case "title":
      return updateTerminal(state, action.id, { title: action.title });
    case "activity":
      if (action.id === state.focusedId) return state;
      return updateTerminal(state, action.id, { activity: true });
    case "setLayout": {
      const layout = sanitizeLayout(state.settings.layout, action.patch);
      const picked = action.patch.pattern;
      return {
        ...state,
        settings: { ...state.settings, layout },
        // Picking a pattern by hand ends any monocle toggle.
        previousPattern: picked !== undefined ? null : state.previousPattern,
      };
    }
    case "cyclePattern": {
      const dir = action.dir ?? 1;
      const i = PATTERNS.indexOf(state.settings.layout.pattern);
      const pattern = PATTERNS[(i + dir + PATTERNS.length) % PATTERNS.length];
      return {
        ...state,
        settings: {
          ...state.settings,
          layout: { ...state.settings.layout, pattern },
        },
        previousPattern: null,
      };
    }
    case "toggleMonocle": {
      const { pattern } = state.settings.layout;
      if (pattern === "monocle") {
        const back = state.previousPattern ?? "cascade";
        return {
          ...state,
          settings: {
            ...state.settings,
            layout: { ...state.settings.layout, pattern: back },
          },
          previousPattern: null,
        };
      }
      return {
        ...state,
        settings: {
          ...state.settings,
          layout: { ...state.settings.layout, pattern: "monocle" },
        },
        previousPattern: pattern,
      };
    }
    case "setBarPosition":
      if (state.settings.barPosition === action.position) return state;
      return {
        ...state,
        settings: { ...state.settings, barPosition: action.position },
      };
    case "cycleBarPosition": {
      const i = BAR_POSITIONS.indexOf(state.settings.barPosition);
      const position = BAR_POSITIONS[(i + 1) % BAR_POSITIONS.length];
      return {
        ...state,
        settings: { ...state.settings, barPosition: position },
      };
    }
    case "setBarOrder":
      if (state.settings.barOrder === action.order) return state;
      return {
        ...state,
        settings: { ...state.settings, barOrder: action.order },
      };
    case "setFont":
      return withFont(state, action.patch);
    case "stepFontSize":
      return withFont(state, {
        fontSize: stepFontSize(state.settings.fontSize, action.dir),
      });
    case "resetFontSize":
      return withFont(state, { fontSize: DEFAULT_FONT_SETTINGS.fontSize });
    case "hydrateSettings":
      return {
        ...state,
        settings: sanitizeSettings(action.settings, state.settings),
      };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

/** The localStorage key; bump the suffix when the shape changes incompatibly. */
export const SETTINGS_STORAGE_KEY = "qutty.settings.v1";

/** A minimal storage interface (localStorage, or a stub in tests). */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): SettingsStorage | undefined {
  try {
    return (globalThis as { localStorage?: SettingsStorage }).localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Read persisted settings; `null` when there are none or they are unreadable. `storage` defaults
 * to localStorage; pass `null` for "no storage".
 */
export function loadSettings(
  storage: SettingsStorage | null | undefined = defaultStorage(),
): Partial<Settings> | null {
  try {
    const raw = storage?.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Partial<Settings>)
      : null;
  } catch {
    return null;
  }
}

/** Persist settings; failures (private mode, quota, no storage) are swallowed. */
export function saveSettings(
  settings: Settings,
  storage: SettingsStorage | null | undefined = defaultStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
