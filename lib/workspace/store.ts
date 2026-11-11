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
import { DEFAULT_THEME_ID, sanitizeThemeId, type ThemeId } from "./themes.ts";
import type { SshProfile } from "../ssh-ui.ts";
import { isEntryId, type PlusOpens, sanitizePlusOpens } from "../launcher.ts";
import {
  type CompanionSettings,
  DEFAULT_COMPANION,
  sanitizeCompanion,
} from "../companion/settings.ts";
import {
  DEFAULT_SANDBOX,
  type SandboxSettings,
  sanitizeSandbox,
} from "../sandbox/settings.ts";
import {
  DEFAULT_OLLAMA,
  type OllamaSettings,
  pairOfEntryId,
  rememberPair,
  sanitizeOllama,
} from "../ollama/settings.ts";
import {
  DEFAULT_VOICE,
  sameVoice,
  sanitizeVoice,
  type VoiceSettings,
} from "../voice/settings.ts";
import { DEFAULT_LINKS, type LinkSettings, sanitizeLinks } from "../links.ts";
import { sanitizeWebPage, type WebPage, webTitle } from "../web/url.ts";
import {
  DEFAULT_MONITOR,
  type MonitorSettings,
  sanitizeMonitor,
} from "../sysstats.ts";
import {
  DEFAULT_WINDOW_CLOSE,
  sanitizeWindowClose,
  type WindowClose,
} from "./windows.ts";

/** Where the switcher bar sits. */
export type BarPosition = "top" | "bottom" | "left" | "right";
/** How the bar orders its chips. */
export type BarOrder = "mru" | "created";
/**
 * What happens to the terminals in non-focused tiles: `resize` fits each one to its own tile
 * (its PTY is resized with it); `scale` keeps every terminal at the focused tile's size and shows
 * the inactive ones scaled down, so a focus change never resizes a PTY.
 */
export type InactiveTiles = "resize" | "scale";
/** Every inactive-tile mode, in the order the settings panel lists them. */
export const INACTIVE_TILE_MODES: readonly InactiveTiles[] = [
  "resize",
  "scale",
];

/** Every bar position, in the order `cycleBarPosition` walks them. */
export const BAR_POSITIONS: readonly BarPosition[] = [
  "top",
  "bottom",
  "left",
  "right",
];
/** A collapsible section of the settings panel. */
export type SettingsSection =
  | "layout"
  | "theme"
  | "font"
  | "companion"
  | "voice"
  | "sandbox"
  | "ollama"
  | "links"
  | "monitor"
  | "windows"
  | "integration";
/** Every settings-panel section, top to bottom. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "layout",
  "theme",
  "font",
  "companion",
  "voice",
  "sandbox",
  "ollama",
  "links",
  "monitor",
  "windows",
  "integration",
];
/** Every pattern, in the order `cyclePattern` walks them. */
export const PATTERNS: readonly LayoutPattern[] = Object.keys(
  PATTERN_INFO,
) as LayoutPattern[];

/**
 * One tile as the workspace sees it. Most are terminals (the xterm/PTY side lives in the
 * terminal manager); a web tile (`web` set) shows a page instead and has no PTY: the terminal
 * manager never hears of its id.
 */
export interface TerminalEntry {
  id: string;
  /** "zsh — ~/Source"; starts as a placeholder until the first `info` poll. */
  title: string;
  createdAt: number;
  lastUsedAt: number;
  exited: boolean;
  exitCode: number | null;
  /** The terminating signal, when there was one. */
  exitSignal?: number | null;
  /** Why it never started (an SSH target the backend refused). */
  exitMessage?: string;
  /** Set for an SSH tile: its host label, tint and target. */
  ssh?: SshProfile;
  /** Set for an agent tool's tile (`claude`): its title names the tool, not the process. */
  agent?: TerminalAgent;
  /** It runs in the window's shared Docker sandbox (badge and tint). */
  sandbox?: boolean;
  /** Set for a web tile: the page it shows (lib/web/). Its title is the page's, else the host. */
  web?: WebPage;
  /** Output arrived while the terminal was not focused (cleared on focus). */
  activity: boolean;
}

/** An agent tool a tile runs (lib/launcher.ts). */
export interface TerminalAgent {
  /** The command name (`claude`). */
  name: string;
  /** The menu's name for it (`Claude Code`). */
  label: string;
}

/** What is persisted between runs (the terminal font fields come from `FontSettings`). */
export interface Settings extends FontSettings {
  layout: LayoutOptions;
  barPosition: BarPosition;
  barOrder: BarOrder;
  /** Resize or scale the terminals in non-focused tiles. */
  inactiveTiles: InactiveTiles;
  /** The colour theme (see themes.ts). */
  theme: ThemeId;
  /** The settings-panel sections the user folded away (Agent integration by default). */
  collapsedSections: SettingsSection[];
  /** What plain `+` (and ⌘T) opens: the default shell, the last pick, or one picker entry. */
  plusOpens: PlusOpens;
  /** The picker entry chosen last (`agent:claude`), for `plusOpens: "last"`. */
  lastLaunch: string | null;
  /** Settings → Companion (Loopy and its brain; lib/companion/settings.ts). */
  companion: CompanionSettings;
  /** Settings → Voice (spoken answers and alerts, push-to-talk; lib/voice/settings.ts). */
  voice: VoiceSettings;
  /** Settings → Sandbox (the window's shared Docker sandbox; lib/sandbox/settings.ts). */
  sandbox: SandboxSettings;
  /** Settings → Ollama (default and recent harness × model pairs; lib/ollama/settings.ts). */
  ollama: OllamaSettings;
  /** Settings → Links (what opens a file printed with a line; lib/links.ts). */
  links: LinkSettings;
  /** Settings → System monitor (the bar meter, hot Loopy; lib/sysstats.ts). */
  monitor: MonitorSettings;
  /** Settings → Windows: what a window's close button does (lib/workspace/windows.ts). */
  windowClose: WindowClose;
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
  | {
    type: "add";
    id: string;
    now: number;
    title?: string;
    ssh?: SshProfile;
    agent?: TerminalAgent;
    sandbox?: boolean;
    /** A web tile showing this page (no PTY). */
    web?: WebPage;
  }
  | { type: "remove"; id: string }
  /** A web tile's page changed: where it went, and its title when the engine knows it. */
  | { type: "webPage"; id: string; page: WebPage }
  | { type: "focus"; id: string; now: number }
  | { type: "focusPrevious"; now: number }
  | { type: "focusOrdinal"; ordinal: number; now: number }
  | { type: "cycle"; dir: 1 | -1; now: number }
  | { type: "endCycle" }
  | {
    type: "exited";
    id: string;
    exitCode: number | null;
    signal?: number | null;
    message?: string;
  }
  | { type: "restarted"; id: string; now: number }
  | { type: "title"; id: string; title: string }
  | { type: "activity"; id: string }
  | { type: "setLayout"; patch: Partial<LayoutOptions> }
  | { type: "cyclePattern"; dir?: 1 | -1 }
  | { type: "toggleMonocle" }
  | { type: "setBarPosition"; position: BarPosition }
  | { type: "cycleBarPosition" }
  | { type: "setBarOrder"; order: BarOrder }
  | { type: "setInactiveTiles"; mode: InactiveTiles }
  | { type: "setTheme"; theme: ThemeId }
  | { type: "setPlusOpens"; plusOpens: PlusOpens }
  | { type: "setCompanion"; patch: Partial<CompanionSettings> }
  | { type: "setVoice"; patch: Partial<VoiceSettings> }
  | { type: "setSandbox"; patch: Partial<SandboxSettings> }
  | { type: "setOllama"; patch: Partial<OllamaSettings> }
  | { type: "setLinks"; patch: Partial<LinkSettings> }
  | { type: "setMonitor"; patch: Partial<MonitorSettings> }
  | { type: "setWindowClose"; windowClose: WindowClose }
  | { type: "launched"; entryId: string }
  | { type: "toggleSection"; section: SettingsSection }
  | { type: "setFont"; patch: Partial<FontSettings> }
  | { type: "stepFontSize"; dir: 1 | -1 }
  | { type: "resetFontSize" }
  | { type: "hydrateSettings"; settings: Partial<Settings> }
  | {
    /** A workspace shown again (lib/workspace/session.ts): its tiles, order and layout. */
    type: "restore";
    terminals: TerminalEntry[];
    mru: string[];
    layout?: Partial<LayoutOptions>;
    previousPattern: LayoutPattern | null;
  };

/** The defaults a fresh workspace starts from. */
export const DEFAULT_SETTINGS: Settings = {
  layout: { ...DEFAULT_LAYOUT_OPTIONS },
  barPosition: "top",
  barOrder: "mru",
  inactiveTiles: "resize",
  theme: DEFAULT_THEME_ID,
  // Agent integration is for agents started by hand: folded until someone looks for it.
  collapsedSections: ["integration"],
  plusOpens: "default",
  lastLaunch: null,
  companion: { ...DEFAULT_COMPANION },
  voice: { ...DEFAULT_VOICE },
  sandbox: { ...DEFAULT_SANDBOX },
  ollama: { ...DEFAULT_OLLAMA, recents: [] },
  links: { ...DEFAULT_LINKS },
  monitor: { ...DEFAULT_MONITOR },
  windowClose: DEFAULT_WINDOW_CLOSE,
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
  return {
    ...s,
    layout: { ...s.layout },
    collapsedSections: [...s.collapsedSections],
    companion: { ...s.companion },
    voice: { ...s.voice },
    sandbox: { ...s.sandbox },
    links: { ...s.links },
    monitor: { ...s.monitor },
    ollama: {
      ...s.ollama,
      recents: s.ollama.recents.map((p) => ({ ...p })),
    },
  };
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
  if (INACTIVE_TILE_MODES.includes(r.inactiveTiles as InactiveTiles)) {
    out.inactiveTiles = r.inactiveTiles as InactiveTiles;
  }
  // Present but unknown (a removed theme, junk) falls back to the default theme.
  if (r.theme !== undefined) out.theme = sanitizeThemeId(r.theme);
  if (r.plusOpens !== undefined) out.plusOpens = sanitizePlusOpens(r.plusOpens);
  if (r.lastLaunch === null || isEntryId(r.lastLaunch)) {
    out.lastLaunch = r.lastLaunch;
  }
  if (r.sandbox !== undefined) {
    out.sandbox = sanitizeSandbox(r.sandbox, out.sandbox);
  }
  if (r.ollama !== undefined) out.ollama = sanitizeOllama(r.ollama, out.ollama);
  if (r.links !== undefined) out.links = sanitizeLinks(r.links, out.links);
  if (r.monitor !== undefined) {
    out.monitor = sanitizeMonitor(r.monitor, out.monitor);
  }
  if (r.windowClose !== undefined) {
    out.windowClose = sanitizeWindowClose(r.windowClose);
  }
  if (r.companion !== undefined) {
    out.companion = sanitizeCompanion(r.companion, out.companion);
  }
  if (r.voice !== undefined) out.voice = sanitizeVoice(r.voice, out.voice);
  if (Array.isArray(r.collapsedSections)) {
    out.collapsedSections = SETTINGS_SECTIONS.filter((s) =>
      (r.collapsedSections as unknown[]).includes(s)
    );
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
      const web = sanitizeWebPage(action.web);
      const entry: TerminalEntry = {
        id: action.id,
        title: action.title ?? action.ssh?.label ?? action.agent?.name ??
          (web ? webTitle(web) : "shell"),
        createdAt: action.now,
        lastUsedAt: action.now,
        exited: false,
        exitCode: null,
        activity: false,
        ...(action.ssh ? { ssh: action.ssh } : {}),
        ...(action.agent ? { agent: action.agent } : {}),
        ...(action.sandbox ? { sandbox: true } : {}),
        ...(web ? { web } : {}),
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
        exitSignal: action.signal ?? null,
        exitMessage: action.message,
      });
    case "restarted":
      return updateTerminal(state, action.id, {
        exited: false,
        exitCode: null,
        exitSignal: null,
        exitMessage: undefined,
        lastUsedAt: action.now,
      });
    case "title":
      // An SSH tile keeps its host label (the foreground process there is always `ssh`); a web
      // tile's title is its page's.
      if (
        state.terminals.some((t) => t.id === action.id && (t.ssh || t.web))
      ) {
        return state;
      }
      return updateTerminal(state, action.id, { title: action.title });
    case "webPage": {
      const entry = state.terminals.find((t) => t.id === action.id);
      const page = sanitizeWebPage(action.page);
      if (!entry?.web || !page) return state;
      if (entry.web.url === page.url && entry.web.title === page.title) {
        return state;
      }
      return {
        ...state,
        terminals: state.terminals.map((t) =>
          t.id === action.id ? { ...t, web: page, title: webTitle(page) } : t
        ),
      };
    }
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
    case "setInactiveTiles":
      if (
        state.settings.inactiveTiles === action.mode ||
        !INACTIVE_TILE_MODES.includes(action.mode)
      ) return state;
      return {
        ...state,
        settings: { ...state.settings, inactiveTiles: action.mode },
      };
    case "setTheme": {
      const theme = sanitizeThemeId(action.theme);
      if (state.settings.theme === theme) return state;
      return { ...state, settings: { ...state.settings, theme } };
    }
    case "setWindowClose": {
      const windowClose = sanitizeWindowClose(action.windowClose);
      if (state.settings.windowClose === windowClose) return state;
      return { ...state, settings: { ...state.settings, windowClose } };
    }
    case "setPlusOpens": {
      const plusOpens = sanitizePlusOpens(action.plusOpens);
      if (state.settings.plusOpens === plusOpens) return state;
      return { ...state, settings: { ...state.settings, plusOpens } };
    }
    case "setCompanion": {
      const companion = sanitizeCompanion(
        action.patch,
        state.settings.companion,
      );
      const before = state.settings.companion;
      if (
        (Object.keys(companion) as (keyof CompanionSettings)[]).every((k) =>
          companion[k] === before[k]
        )
      ) return state;
      return { ...state, settings: { ...state.settings, companion } };
    }
    case "setVoice": {
      const voice = sanitizeVoice(action.patch, state.settings.voice);
      if (sameVoice(voice, state.settings.voice)) return state;
      return { ...state, settings: { ...state.settings, voice } };
    }
    case "setSandbox": {
      const sandbox = sanitizeSandbox(action.patch, state.settings.sandbox);
      if (JSON.stringify(sandbox) === JSON.stringify(state.settings.sandbox)) {
        return state;
      }
      return { ...state, settings: { ...state.settings, sandbox } };
    }
    case "setOllama": {
      const ollama = sanitizeOllama(action.patch, state.settings.ollama);
      if (JSON.stringify(ollama) === JSON.stringify(state.settings.ollama)) {
        return state;
      }
      return { ...state, settings: { ...state.settings, ollama } };
    }
    case "setLinks": {
      const links = sanitizeLinks(action.patch, state.settings.links);
      const before = state.settings.links;
      if (
        links.editor === before.editor && links.command === before.command &&
        links.web === before.web
      ) {
        return state;
      }
      return { ...state, settings: { ...state.settings, links } };
    }
    case "setMonitor": {
      const monitor = sanitizeMonitor(action.patch, state.settings.monitor);
      if (JSON.stringify(monitor) === JSON.stringify(state.settings.monitor)) {
        return state;
      }
      return { ...state, settings: { ...state.settings, monitor } };
    }
    case "launched": {
      if (!isEntryId(action.entryId)) return state;
      // An Ollama pair also goes first in the recent pairs.
      const pair = pairOfEntryId(action.entryId);
      const recents = pair
        ? rememberPair(state.settings.ollama.recents, pair)
        : state.settings.ollama.recents;
      if (
        state.settings.lastLaunch === action.entryId &&
        JSON.stringify(recents) ===
          JSON.stringify(state.settings.ollama.recents)
      ) return state;
      return {
        ...state,
        settings: {
          ...state.settings,
          lastLaunch: action.entryId,
          ...(pair ? { ollama: { ...state.settings.ollama, recents } } : {}),
        },
      };
    }
    case "toggleSection": {
      if (!SETTINGS_SECTIONS.includes(action.section)) return state;
      const collapsed = state.settings.collapsedSections;
      const collapsedSections = collapsed.includes(action.section)
        ? collapsed.filter((s) => s !== action.section)
        : SETTINGS_SECTIONS.filter((s) =>
          s === action.section || collapsed.includes(s)
        );
      return { ...state, settings: { ...state.settings, collapsedSections } };
    }
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
    case "restore": {
      const ids = new Set(action.terminals.map((t) => t.id));
      const mru = action.mru.filter((id) => ids.has(id));
      return {
        ...state,
        terminals: action.terminals.map((t) => ({ ...t })),
        mru,
        focusedId: mru[0] ?? null,
        cycle: null,
        previousPattern: action.previousPattern,
        settings: action.layout
          ? {
            ...state.settings,
            layout: sanitizeLayout(state.settings.layout, action.layout),
          }
          : state.settings,
      };
    }
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
