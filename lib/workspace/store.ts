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
  type Rect,
  touch,
} from "../layout/mod.ts";
import {
  DEFAULT_FONT_SETTINGS,
  type FontSettings,
  sanitizeFont,
} from "./fonts.ts";
import { DEFAULT_THEME_ID, sanitizeThemeId, type ThemeId } from "./themes.ts";
import {
  DEFAULT_SKIN,
  sanitizeSkinSettings,
  type SkinSettings,
} from "../skins/settings.ts";
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
  migrateStoredVoice,
  sameVoice,
  sanitizeVoice,
  type VoiceSettings,
} from "../voice/settings.ts";
import { DEFAULT_LINKS, type LinkSettings, sanitizeLinks } from "../links.ts";
import { type AgentPreset, sanitizePresets } from "../agent/presets.ts";
import { sanitizeWebPage, type WebPage, webTitle } from "../web/url.ts";
import { type AgentChat, sanitizeChat } from "../agent/tile.ts";
import { sanitizeScmTile, type ScmTile, scmTitle } from "../scm/tile.ts";
import {
  DEFAULT_SCM_SETTINGS,
  sanitizeScmSettings,
  sanitizeWorktreeMark,
  type ScmSettings,
  type WorktreeMark,
} from "../scm/worktrees.ts";
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
import {
  type ActivitySettings,
  clearSignals,
  DEFAULT_ACTIVITY,
  sanitizeActivity,
  sanitizeProgramTitle,
  sanitizeTileTitle,
  type TileSignals,
  type TileTitle,
} from "./activity.ts";
import {
  dropTile,
  EMPTY_FREEFORM,
  type FreeformState,
  type MinSize,
  raise,
  sanitizeFreeform,
  sanitizeViewMode,
  setMaximized,
  setRect,
  type ViewMode,
} from "./freeform.ts";
import { reduceView, type ViewAction } from "./view.ts";
import { appendId, sanitizeOrder, swapIds } from "./tile-order.ts";
import {
  clampTileZoom,
  isActualSize,
  sanitizeTileZoom,
  stepTileZoom,
} from "./tile-zoom.ts";

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

/**
 * Settings → Appearance → Chat text: the type scale of agent tiles' transcripts and of every prompt
 * box (an agent tile's, a harness overlay's). Not the terminal's font (Settings → Font). The app
 * puts it on <html> as `data-chat-size`; public/styles.css turns it into `--chat-size` (13 / 15 /
 * 17 px body text) and the sizes derived from it.
 */
export type ChatTextSize = "small" | "medium" | "large";
/** Every chat text size, smallest first (the order the settings panel lists them). */
export const CHAT_TEXT_SIZES: readonly ChatTextSize[] = [
  "small",
  "medium",
  "large",
];

/** Every bar position, in the order `cycleBarPosition` walks them. */
export const BAR_POSITIONS: readonly BarPosition[] = [
  "top",
  "bottom",
  "left",
  "right",
];
/** A category (tab) of the Settings dialog (app/settings-panel.tsx), in sidebar order. */
export type SettingsTab =
  | "general"
  | "appearance"
  | "layout"
  | "tiles"
  | "links"
  | "sandbox"
  | "agents"
  | "companion"
  | "voice"
  | "monitor"
  | "scm";
/** Every Settings tab, top to bottom. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  "general",
  "appearance",
  "layout",
  "tiles",
  "links",
  "sandbox",
  "agents",
  "companion",
  "voice",
  "monitor",
  "scm",
];
/** Every pattern, in the order `cyclePattern` walks them. */
export const PATTERNS: readonly LayoutPattern[] = Object.keys(
  PATTERN_INFO,
) as LayoutPattern[];

/**
 * One tile as the workspace sees it. Most are terminals (the xterm/PTY side lives in the
 * terminal manager); a web tile (`web` set) shows a page instead and has no PTY: the terminal
 * manager never hears of its id. Its activity signals (output, a bell, a command running or ended,
 * the program's own title) come from {@linkcode TileSignals} (lib/workspace/activity.ts).
 */
export interface TerminalEntry extends TileSignals {
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
  /**
   * Set for an agent tile (app/agent-tile.tsx): a coding agent's chat, no PTY. Its title is the
   * agent's hub name.
   */
  chat?: AgentChat;
  /** Set for a Source Control tile (app/scm-tile.tsx): the repository it shows, no PTY. */
  scm?: ScmTile;
  /** The foreground process, from the last `info` poll (`claude`, `zsh`; harness detection). */
  process?: string;
  /**
   * This tile's choice of the harness overlay (its header menu's "GUI overlay"); unset: Settings →
   * Tiles → "Show a GUI around agent harnesses".
   */
  guiOverlay?: boolean;
  /**
   * Minimized to the switcher bar: left out of the layout and of focus cycling, its shell (or
   * page) still running. Restoring it (its chip, `focus`, `restoreTile`) tiles it again.
   */
  minimized?: boolean;
  /**
   * The tile's own zoom (View → Zoom In / Zoom Out; lib/workspace/tile-zoom.ts), absent at 100%: a
   * terminal's font over Settings' size, an agent tile's content. Never set on a web tile (its
   * page's zoom is remembered per site).
   */
  zoom?: number;
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
  /**
   * Settings → Layout: focusing a tile moves it to the main (biggest) slot and the others follow
   * by recency (on), or every tile keeps its place, in the workspace's own order (off;
   * lib/workspace/tile-order.ts).
   */
  focusToMain: boolean;
  /** Settings → Appearance → Skin: the skin and the tile frame options (lib/skins/settings.ts). */
  skin: SkinSettings;
  /** The colour theme (see themes.ts). */
  theme: ThemeId;
  /** The Settings tab selected last (the dialog opens on it). */
  settingsTab: SettingsTab;
  /** What plain `+` (and ⌘T) opens: the default shell, the last pick, or one picker entry. */
  plusOpens: PlusOpens;
  /** The picker entry chosen last (`agent:claude`), for `plusOpens: "last"`. */
  lastLaunch: string | null;
  /** Settings → Companion (the companion and its brain; lib/companion/settings.ts). */
  companion: CompanionSettings;
  /** Settings → Voice (spoken answers and alerts, push-to-talk; lib/voice/settings.ts). */
  voice: VoiceSettings;
  /** Settings → Sandbox (the window's shared Docker sandbox; lib/sandbox/settings.ts). */
  sandbox: SandboxSettings;
  /** Settings → Ollama (default and recent harness × model pairs; lib/ollama/settings.ts). */
  ollama: OllamaSettings;
  /** Settings → Links (what opens a file printed with a line; lib/links.ts). */
  links: LinkSettings;
  /** Settings → System monitor (the bar meter, the hot companion; lib/sysstats.ts). */
  monitor: MonitorSettings;
  /** Settings → Source Control (where new worktrees go; lib/scm/worktrees.ts). */
  scm: ScmSettings;
  /** Settings → Windows: what a window's close button does (lib/workspace/windows.ts). */
  windowClose: WindowClose;
  /** Settings → Tiles: the activity indicators (lib/workspace/activity.ts). */
  activity: ActivitySettings;
  /** Settings → Tiles: what a tile's header shows, the program's title or the process's. */
  tileTitle: TileTitle;
  /** Settings → Layout: the view a new workspace starts in (each one keeps its own after). */
  defaultView: ViewMode;
  /**
   * Settings → Tiles: a terminal running a coding-agent harness gets the GUI overlay
   * (app/harness-overlay.tsx), unless its own header menu turned it off.
   */
  harnessOverlay: boolean;
  /**
   * View → "Zoom All Tiles Together": zooming changes one shared level (`sharedZoom`) that every
   * tile in every window shows, instead of the focused tile's own zoom.
   */
  zoomTogether: boolean;
  /** The shared zoom level while tiles zoom together (1: 100%; lib/workspace/tile-zoom.ts). */
  sharedZoom: number;
  /** Settings → Agents → Presets: agent tile roles, picked in the `+` menu (lib/agent/presets.ts). */
  agentPresets: AgentPreset[];
  /**
   * Settings → Agents → Waiting agents: the app icon's badge (the Dock on macOS) counts the tiles
   * whose agent waits for the user (lib/hub/badge.ts).
   */
  dockBadge: boolean;
  /** Settings → Appearance → Chat text: the agent chat's type scale ({@linkcode ChatTextSize}). */
  chatTextSize: ChatTextSize;
}

/** The whole workspace. */
export interface WorkspaceState {
  /** In creation order. */
  terminals: TerminalEntry[];
  /**
   * Most recently used first, the shown tiles ahead of the minimized ones; `mru[0]` is the
   * focused terminal unless every tile is minimized.
   */
  mru: string[];
  /**
   * Every tile in slot order, minimized ones too (they come back to their place): the tiled
   * layout's order while `settings.focusToMain` is off (lib/workspace/tile-order.ts). New tiles
   * go last; turning the setting off seeds it from `mru`.
   */
  order: string[];
  /** The first tile in `mru` that is not minimized, else `null` ({@linkcode shownFocus}). */
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
  /** How this workspace shows its tiles: tiled (the layout engine) or free-form (MDI). */
  view: ViewMode;
  /**
   * The free-form view's rects, z-order and maximized tile (lib/workspace/freeform.ts). Kept
   * while tiled, so switching back gives every tile its place; the focused tile is on top.
   */
  freeform: FreeformState;
  /**
   * The git worktree this workspace was opened for (lib/scm/worktrees.ts): the bar shows
   * "⑂ branch", and new agent tiles start in its folder. Absent for an ordinary workspace.
   */
  worktree?: WorktreeMark;
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
    /** An agent tile (no PTY). */
    chat?: AgentChat;
    /** A Source Control tile (no PTY). */
    scm?: ScmTile;
  }
  | { type: "remove"; id: string }
  /**
   * A tile moved here from another window (lib/workspace/tile-move.ts): its entry under its new
   * `entry.id`, focused, in the slot of tile `before` (tiles in place) or at free-form `rect`.
   */
  | {
    type: "arrive";
    entry: TerminalEntry;
    now: number;
    before?: string;
    rect?: Rect;
  }
  /** A web tile's page changed: where it went, and its title when the engine knows it. */
  | { type: "webPage"; id: string; page: WebPage }
  /** An agent tile's session changed (its id, model, mode, a finished turn). */
  | { type: "chatMeta"; id: string; patch: Partial<AgentChat> }
  /** A Source Control tile's repository or its "follow the focused terminal" changed. */
  | { type: "scmTile"; id: string; patch: Partial<ScmTile> }
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
  /** The `info` poll's title, and its foreground process (harness detection). */
  | { type: "title"; id: string; title: string; process?: string }
  /** Tile `id`'s header menu: the harness overlay on or off for it (`undefined`: as Settings say). */
  | { type: "setGuiOverlay"; id: string; on: boolean | undefined }
  | { type: "setHarnessOverlay"; on: boolean }
  /** Settings → Agents: the app icon's badge of waiting agents on or off. */
  | { type: "setDockBadge"; on: boolean }
  /** Settings → Appearance → Chat text: the agent chat's type scale. */
  | { type: "setChatTextSize"; size: ChatTextSize }
  | { type: "activity"; id: string }
  /** A bell rang in tile `id` (or its agent started waiting for the user). */
  | { type: "bell"; id: string }
  /** A command started (`true`) or was dropped without an end (`false`) in tile `id`. */
  | { type: "commandRunning"; id: string; running: boolean }
  /** A command ended in tile `id` (OSC 133 `D`), with its exit status. */
  | { type: "commandDone"; id: string; exitCode: number | null; now: number }
  /** The program in tile `id` set its title (OSC 0 / 2); empty clears it. */
  | { type: "programTitle"; id: string; title: string }
  | { type: "setActivity"; patch: Partial<ActivitySettings> }
  | { type: "setTileTitle"; tileTitle: TileTitle }
  | { type: "setLayout"; patch: Partial<LayoutOptions> }
  | { type: "cyclePattern"; dir?: 1 | -1 }
  | { type: "toggleMonocle" }
  /**
   * View → Zoom In / Zoom Out on tile `id` (not a web tile: its page zooms itself): its own zoom,
   * or the shared level while tiles zoom together.
   */
  | { type: "zoomTile"; id: string; dir: 1 | -1 }
  /** View → Actual Size on tile `id` (or its zoom indicator): back to 100%. */
  | { type: "resetTileZoom"; id: string }
  /** The shared zoom level (a web tile zooming while tiles zoom together). */
  | { type: "setSharedZoom"; zoom: number }
  /** View → "Zoom All Tiles Together". */
  | { type: "setZoomTogether"; on: boolean }
  /** A tile's Minimize: out of the layout, into the switcher bar (its shell keeps running). */
  | { type: "minimize"; id: string; now: number }
  /** A tile's Maximize: focus it and show it alone (monocle, remembering the pattern). */
  | { type: "maximize"; id: string; now: number }
  /**
   * A tile's Restore: back into the tiled layout, focused, from whichever state it is in
   * (minimized, or maximized in monocle: monocle is left for the pattern it replaced).
   */
  | { type: "restoreTile"; id: string; now: number }
  /** The view and free-form actions (lib/workspace/view.ts). */
  | ViewAction
  | { type: "setBarPosition"; position: BarPosition }
  | { type: "cycleBarPosition" }
  | { type: "setBarOrder"; order: BarOrder }
  | { type: "setInactiveTiles"; mode: InactiveTiles }
  /** Settings → Layout: whether the focused tile moves to the main slot. */
  | { type: "setFocusToMain"; on: boolean }
  /** Tiles `a` and `b` trade places in the tile order (a header dragged onto another tile). */
  | { type: "swapTiles"; a: string; b: string }
  | { type: "setTheme"; theme: ThemeId }
  /** Settings → Appearance → Skin. */
  | { type: "setSkin"; patch: Partial<SkinSettings> }
  | { type: "setPlusOpens"; plusOpens: PlusOpens }
  | { type: "setCompanion"; patch: Partial<CompanionSettings> }
  | { type: "setVoice"; patch: Partial<VoiceSettings> }
  | { type: "setSandbox"; patch: Partial<SandboxSettings> }
  | { type: "setOllama"; patch: Partial<OllamaSettings> }
  | { type: "setLinks"; patch: Partial<LinkSettings> }
  /** Settings → Agents → Presets: the whole list. */
  | { type: "setAgentPresets"; presets: unknown }
  | { type: "setMonitor"; patch: Partial<MonitorSettings> }
  | { type: "setScm"; patch: Partial<ScmSettings> }
  /** This workspace was opened for a worktree (`null`: it is an ordinary one). */
  | { type: "setWorktree"; mark: WorktreeMark | null }
  | { type: "setWindowClose"; windowClose: WindowClose }
  | { type: "launched"; entryId: string }
  | { type: "setSettingsTab"; tab: SettingsTab }
  | { type: "setFont"; patch: Partial<FontSettings> }
  | { type: "hydrateSettings"; settings: Partial<Settings> }
  | {
    /** A workspace shown again (lib/workspace/session.ts): its tiles, order and layout. */
    type: "restore";
    terminals: TerminalEntry[];
    mru: string[];
    /** Its tile order (absent or partial: completed from `mru`). */
    order?: string[];
    layout?: Partial<LayoutOptions>;
    previousPattern: LayoutPattern | null;
    /** Its view (absent: tiled, as a workspace saved before the free-form view was). */
    view?: ViewMode;
    /** Its free-form geometry (sanitized against its tiles). */
    freeform?: unknown;
    /** The worktree it was opened for. */
    worktree?: WorktreeMark;
  };

/** The defaults a fresh workspace starts from. */
export const DEFAULT_SETTINGS: Settings = {
  layout: { ...DEFAULT_LAYOUT_OPTIONS },
  barPosition: "top",
  barOrder: "mru",
  inactiveTiles: "resize",
  focusToMain: true,
  theme: DEFAULT_THEME_ID,
  skin: { ...DEFAULT_SKIN },
  settingsTab: "general",
  plusOpens: "default",
  lastLaunch: null,
  companion: { ...DEFAULT_COMPANION },
  voice: { ...DEFAULT_VOICE },
  sandbox: { ...DEFAULT_SANDBOX },
  ollama: { ...DEFAULT_OLLAMA, recents: [] },
  links: { ...DEFAULT_LINKS },
  monitor: { ...DEFAULT_MONITOR },
  scm: { ...DEFAULT_SCM_SETTINGS },
  windowClose: DEFAULT_WINDOW_CLOSE,
  activity: { ...DEFAULT_ACTIVITY },
  tileTitle: "program",
  defaultView: "tiled",
  harnessOverlay: true,
  zoomTogether: false,
  sharedZoom: 1,
  agentPresets: [],
  dockBadge: true,
  chatTextSize: "medium",
  ...DEFAULT_FONT_SETTINGS,
};

/** A fresh, empty workspace. */
export function initialState(
  settings: Settings = DEFAULT_SETTINGS,
): WorkspaceState {
  return {
    terminals: [],
    mru: [],
    order: [],
    focusedId: null,
    settings: cloneSettings(settings),
    previousPattern: null,
    cycle: null,
    view: "tiled",
    freeform: EMPTY_FREEFORM,
  };
}

function cloneSettings(s: Settings): Settings {
  return {
    ...s,
    layout: { ...s.layout },
    companion: { ...s.companion },
    voice: { ...s.voice },
    sandbox: { ...s.sandbox },
    skin: { ...s.skin },
    links: { ...s.links },
    monitor: { ...s.monitor },
    scm: { ...s.scm },
    activity: { ...s.activity },
    agentPresets: s.agentPresets.map((p) => ({
      ...p,
      ...(p.allowedTools ? { allowedTools: [...p.allowedTools] } : {}),
    })),
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
  if (typeof r.focusToMain === "boolean") out.focusToMain = r.focusToMain;
  if (typeof r.harnessOverlay === "boolean") {
    out.harnessOverlay = r.harnessOverlay;
  }
  if (typeof r.dockBadge === "boolean") out.dockBadge = r.dockBadge;
  if (CHAT_TEXT_SIZES.includes(r.chatTextSize as ChatTextSize)) {
    out.chatTextSize = r.chatTextSize as ChatTextSize;
  }
  if (typeof r.zoomTogether === "boolean") out.zoomTogether = r.zoomTogether;
  if (r.sharedZoom !== undefined) {
    out.sharedZoom = sanitizeTileZoom(r.sharedZoom) ?? 1;
  }
  // Present but unknown (a removed theme, junk) falls back to the default theme.
  if (r.theme !== undefined) out.theme = sanitizeThemeId(r.theme);
  if (r.skin !== undefined) out.skin = sanitizeSkinSettings(r.skin, out.skin);
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
  if (r.scm !== undefined) out.scm = sanitizeScmSettings(r.scm, out.scm);
  if (r.windowClose !== undefined) {
    out.windowClose = sanitizeWindowClose(r.windowClose);
  }
  if (r.companion !== undefined) {
    out.companion = sanitizeCompanion(r.companion, out.companion);
  }
  if (r.activity !== undefined) {
    out.activity = sanitizeActivity(r.activity, out.activity);
  }
  if (r.tileTitle !== undefined) out.tileTitle = sanitizeTileTitle(r.tileTitle);
  if (r.defaultView !== undefined) {
    out.defaultView = sanitizeViewMode(r.defaultView);
  }
  if (r.voice !== undefined) {
    out.voice = sanitizeVoice(migrateStoredVoice(r.voice), out.voice);
  }
  if (r.agentPresets !== undefined) {
    out.agentPresets = sanitizePresets(r.agentPresets);
  }
  if (SETTINGS_TABS.includes(r.settingsTab as SettingsTab)) {
    out.settingsTab = r.settingsTab as SettingsTab;
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

/** The ids of the minimized tiles. */
function minimizedIds(terminals: readonly TerminalEntry[]): Set<string> {
  return new Set(terminals.filter((t) => t.minimized).map((t) => t.id));
}

/** The MRU order of the tiles that are not minimized: what the layout tiles and cycling walks. */
export function shownMru(
  state: {
    readonly terminals: readonly TerminalEntry[];
    readonly mru: readonly string[];
  },
): string[] {
  const min = minimizedIds(state.terminals);
  return state.mru.filter((id) => !min.has(id));
}

/** The tile that has the focus: the most recently used one not minimized (`null`: none). */
export function shownFocus(
  terminals: readonly TerminalEntry[],
  mru: readonly string[],
): string | null {
  return shownMru({ terminals, mru })[0] ?? null;
}

/**
 * Whether tile `id` is maximized (its header offers Restore): shown alone in monocle in the tiled
 * view, filling the area (MDI maximize) in the free-form view.
 */
export function isMaximized(state: WorkspaceState, id: string): boolean {
  if (state.view === "freeform") return state.freeform.maximized === id;
  return state.settings.layout.pattern === "monocle" && state.focusedId === id;
}

/** The maximized tile (see {@linkcode isMaximized}), else `null`. */
export function maximizedId(state: WorkspaceState): string | null {
  const id = state.view === "freeform"
    ? state.freeform.maximized
    : state.focusedId;
  return id !== null && isMaximized(state, id) ? id : null;
}

/** A free-form tile's minimum size: the layout's minimum tile size. */
export function freeformMin(state: WorkspaceState): MinSize {
  const { minTileW, minTileH } = state.settings.layout;
  return { w: minTileW, h: minTileH };
}

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
        ? (t.lastUsedAt === now && !hasLatched(t) ? t : seen(t, now))
        : t
    ),
  };
}

/** Whether `t` carries a signal focusing it clears. */
function hasLatched(t: TerminalEntry): boolean {
  return t.activity || t.bell === true || t.failed === true ||
    t.doneAt !== undefined;
}

/** `t` looked at, at `now`: used then, its latched signals clear (a running command stays). */
function seen(t: TerminalEntry, now: number): TerminalEntry {
  const { bell: _b, failed: _f, doneAt: _d, ...rest } = t;
  return { ...rest, lastUsedAt: now, activity: false };
}

/** A command in tile `id` ended with `exitCode`: failed or done when it was not looked at. */
function commandDone(
  state: WorkspaceState,
  id: string,
  exitCode: number | null,
  now: number,
): WorkspaceState {
  const entry = state.terminals.find((t) => t.id === id);
  if (!entry || entry.web) return state;
  if (id === state.focusedId) {
    return updateTerminal(state, id, { running: undefined });
  }
  const failed = exitCode !== null && exitCode !== 0;
  return updateTerminal(
    state,
    id,
    failed
      ? { running: undefined, failed: true }
      : { running: undefined, doneAt: now },
  );
}

/** The pattern monocle goes back to when nothing (or monocle itself) was remembered. */
const DEFAULT_TILED_PATTERN: LayoutPattern =
  DEFAULT_LAYOUT_OPTIONS.pattern === "monocle"
    ? "cascade"
    : DEFAULT_LAYOUT_OPTIONS.pattern;

function withPattern(
  state: WorkspaceState,
  pattern: LayoutPattern,
  previousPattern: LayoutPattern | null,
): WorkspaceState {
  return {
    ...state,
    settings: {
      ...state.settings,
      layout: { ...state.settings.layout, pattern },
    },
    previousPattern,
  };
}

/** Show the focused tile alone, remembering the pattern to go back to (Mod+Enter, Maximize). */
function enterMonocle(state: WorkspaceState): WorkspaceState {
  const { pattern } = state.settings.layout;
  if (pattern === "monocle") return state;
  return withPattern(state, "monocle", pattern);
}

/** Back to the remembered tiled pattern (else the default one): Mod+Enter, Restore. */
function leaveMonocle(state: WorkspaceState): WorkspaceState {
  if (state.settings.layout.pattern !== "monocle") return state;
  const prev = state.previousPattern;
  return withPattern(
    state,
    prev && prev !== "monocle" ? prev : DEFAULT_TILED_PATTERN,
    null,
  );
}

/** Tile `id` with `minimized` set to `on`, moved to the end of the MRU when minimized. */
function setMinimized(
  state: WorkspaceState,
  id: string,
  on: boolean,
): WorkspaceState {
  const entry = state.terminals.find((t) => t.id === id);
  if (!entry || (entry.minimized === true) === on) return state;
  const terminals = state.terminals.map((t) => {
    if (t.id !== id) return t;
    if (on) return { ...t, minimized: true };
    const { minimized: _m, ...rest } = t;
    return rest;
  });
  const mru = on ? [...state.mru.filter((x) => x !== id), id] : state.mru;
  return {
    ...state,
    terminals,
    mru,
    focusedId: shownFocus(terminals, mru),
    cycle: null,
    // A minimized free-form tile comes back at its own rect, not maximized.
    freeform: on ? setMaximized(state.freeform, id, false) : state.freeform,
  };
}

/**
 * Restore tile `id` and focus it: tiled, into the tiled layout (leaving monocle); free-form, to
 * its free-form rect (no longer maximized).
 */
function restoreTile(
  state: WorkspaceState,
  id: string,
  now: number,
): WorkspaceState {
  if (!state.terminals.some((t) => t.id === id)) return state;
  const shown = withFocus(setMinimized(state, id, false), id, now);
  if (state.view === "tiled") return leaveMonocle(shown);
  return withFreeform(shown, setMaximized(shown.freeform, id, false));
}

/**
 * Maximize tile `id`, focused: tiled, alone in monocle (remembering the pattern); free-form, over
 * the whole area with the others behind it (MDI maximize: no pattern change).
 */
function maximize(
  state: WorkspaceState,
  id: string,
  now: number,
): WorkspaceState {
  if (!state.terminals.some((t) => t.id === id)) return state;
  // In monocle already (another tile picked from the switcher): it is just focused.
  const focused = withFocus(setMinimized(state, id, false), id, now);
  if (state.view === "tiled") return enterMonocle(focused);
  return withFreeform(focused, setMaximized(focused.freeform, id, true));
}

/** Mod+Enter: monocle on / off (tiled), the focused tile maximized / restored (free-form). */
function toggleMonocle(state: WorkspaceState): WorkspaceState {
  if (state.view === "freeform") {
    const id = state.focusedId;
    if (!id) return state;
    // The tile has the focus already: its last use stays as it is (the reducer stays pure).
    const now = state.terminals.find((t) => t.id === id)?.lastUsedAt ?? 0;
    return isMaximized(state, id)
      ? restoreTile(state, id, now)
      : maximize(state, id, now);
  }
  return state.settings.layout.pattern === "monocle"
    ? leaveMonocle(state)
    : enterMonocle(state);
}

/** `state` with free-form geometry `freeform` (the same state when it did not change). */
function withFreeform(
  state: WorkspaceState,
  freeform: FreeformState,
): WorkspaceState {
  return freeform === state.freeform ? state : { ...state, freeform };
}

/** The focused tile drawn on top in the free-form view (clicking a tile raises it, as focus does). */
function focusedOnTop(state: WorkspaceState): WorkspaceState {
  const id = state.focusedId;
  if (!id) return state;
  const z = raise(state.freeform.z, id);
  return z === state.freeform.z ? state : withFreeform(state, {
    ...state.freeform,
    z,
  });
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

/** The zoom actions (lib/workspace/tile-zoom.ts). */
type ZoomAction = Extract<
  WorkspaceAction,
  { type: "zoomTile" | "resetTileZoom" | "setSharedZoom" | "setZoomTogether" }
>;

/** `state` with the shared zoom level at `zoom` (the same state when it is already there). */
function withSharedZoom(state: WorkspaceState, zoom: number): WorkspaceState {
  const sharedZoom = clampTileZoom(zoom);
  return Math.abs(sharedZoom - state.settings.sharedZoom) < 1e-3
    ? state
    : { ...state, settings: { ...state.settings, sharedZoom } };
}

/** Tile `id` at its own zoom `zoom` (100%: none stored); a web tile has none. */
function withTileZoom(
  state: WorkspaceState,
  id: string,
  zoom: number,
): WorkspaceState {
  const entry = state.terminals.find((t) => t.id === id);
  if (!entry || entry.web) return state;
  const next = isActualSize(zoom) ? undefined : clampTileZoom(zoom);
  if (next === entry.zoom) return state;
  const terminals = state.terminals.map((t) => {
    if (t.id !== id) return t;
    const { zoom: _z, ...rest } = t;
    return next === undefined ? rest : { ...rest, zoom: next };
  });
  return { ...state, terminals };
}

/** Zoom In / Zoom Out / Actual Size and the zoom settings. */
function reduceZoom(state: WorkspaceState, action: ZoomAction): WorkspaceState {
  const together = state.settings.zoomTogether;
  switch (action.type) {
    case "zoomTile": {
      if (together) {
        return withSharedZoom(
          state,
          stepTileZoom(state.settings.sharedZoom, action.dir),
        );
      }
      const own = state.terminals.find((t) => t.id === action.id)?.zoom ?? 1;
      return withTileZoom(state, action.id, stepTileZoom(own, action.dir));
    }
    case "resetTileZoom":
      return together
        ? withSharedZoom(state, 1)
        : withTileZoom(state, action.id, 1);
    case "setSharedZoom":
      return withSharedZoom(state, action.zoom);
    case "setZoomTogether":
      return action.on === together ? state : {
        ...state,
        settings: { ...state.settings, zoomTogether: action.on },
      };
  }
}

/** Whether tile `id` is a web tile (no PTY, so no terminal signals). */
function isWeb(state: WorkspaceState, id: string): boolean {
  return state.terminals.some((t) => t.id === id && t.web !== undefined);
}

/** `focus`: a shown tile is focused; a minimized one is restored (as its chip does). */
function focusOrRestore(
  state: WorkspaceState,
  id: string,
  now: number,
): WorkspaceState {
  const entry = state.terminals.find((t) => t.id === id);
  return entry?.minimized
    ? restoreTile(state, id, now)
    : withFocus(state, id, now);
}

/**
 * `state` with `settings`; turning `focusToMain` off seeds the tile order from the MRU, which is
 * the order on screen, so nothing moves.
 */
function withSettings(
  state: WorkspaceState,
  settings: Settings,
): WorkspaceState {
  const seed = state.settings.focusToMain && !settings.focusToMain;
  return { ...state, settings, ...(seed ? { order: [...state.mru] } : {}) };
}

/**
 * The pure state transition. Unknown ids and no-op changes return the same state object. The
 * focused tile always ends on top of the free-form z-order.
 */
export function reduce(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  const next = reduceCore(state, action);
  return next === state ? state : focusedOnTop(next);
}

function reduceCore(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "add": {
      if (state.terminals.some((t) => t.id === action.id)) return state;
      const web = sanitizeWebPage(action.web);
      const chat = web ? undefined : sanitizeChat(action.chat);
      const scm = web || chat ? undefined : sanitizeScmTile(action.scm);
      const entry: TerminalEntry = {
        id: action.id,
        title: action.title ?? action.ssh?.label ?? action.agent?.name ??
          (web
            ? webTitle(web)
            : chat
            ? "claude"
            : scm
            ? scmTitle(scm)
            : "shell"),
        createdAt: action.now,
        lastUsedAt: action.now,
        exited: false,
        exitCode: null,
        activity: false,
        ...(action.ssh ? { ssh: action.ssh } : {}),
        ...(action.agent ? { agent: action.agent } : {}),
        ...(action.sandbox ? { sandbox: true } : {}),
        ...(web ? { web } : {}),
        ...(chat ? { chat } : {}),
        ...(scm ? { scm } : {}),
      };
      return {
        ...state,
        terminals: [...state.terminals, entry],
        mru: touch(state.mru, action.id),
        order: appendId(state.order, action.id),
        focusedId: action.id,
        cycle: null,
      };
    }
    case "arrive": {
      const id = action.entry.id;
      if (state.terminals.some((t) => t.id === id)) return state;
      const { minimized: _m, ...rest } = action.entry;
      const entry: TerminalEntry = {
        ...clearSignals(rest),
        lastUsedAt: action.now,
      };
      const at = action.before === undefined
        ? -1
        : state.order.indexOf(action.before);
      const order = at < 0
        ? appendId(state.order, id)
        : [...state.order.slice(0, at), id, ...state.order.slice(at)];
      return {
        ...state,
        terminals: [...state.terminals, entry],
        mru: touch(state.mru, id),
        order,
        focusedId: id,
        cycle: null,
        freeform: action.rect
          ? setRect(state.freeform, id, action.rect)
          : state.freeform,
      };
    }
    case "remove": {
      if (!state.terminals.some((t) => t.id === action.id)) return state;
      const mru = state.mru.filter((x) => x !== action.id);
      const terminals = state.terminals.filter((t) => t.id !== action.id);
      return {
        ...state,
        terminals,
        mru,
        order: state.order.filter((x) => x !== action.id),
        focusedId: shownFocus(terminals, mru),
        cycle: null,
        freeform: dropTile(state.freeform, action.id),
      };
    }
    case "focus":
      return focusOrRestore(state, action.id, action.now);
    case "focusPrevious": {
      const prev = shownMru(state)[1];
      return prev === undefined ? state : withFocus(state, prev, action.now);
    }
    case "focusOrdinal": {
      // A minimized tile's chip counts too: focusing it restores it.
      const id = barOrderIds(state)[action.ordinal - 1];
      return id === undefined ? state : focusOrRestore(state, id, action.now);
    }
    case "cycle": {
      // Minimized tiles are out of the cycle (as they are out of the layout).
      const shown = shownMru(state);
      if (shown.length < 2) return state;
      const cycle = state.cycle ?? { order: shown, index: 0 };
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
        running: undefined,
        exited: true,
        exitCode: action.exitCode,
        exitSignal: action.signal ?? null,
        exitMessage: action.message,
      });
    case "restarted":
      return updateTerminal(state, action.id, {
        running: undefined,
        programTitle: undefined,
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
        state.terminals.some((t) =>
          t.id === action.id && (t.ssh || t.web || t.scm)
        )
      ) {
        return state;
      }
      return updateTerminal(state, action.id, {
        title: action.title,
        ...(action.process !== undefined ? { process: action.process } : {}),
      });
    case "setGuiOverlay":
      return updateTerminal(state, action.id, {
        guiOverlay: typeof action.on === "boolean" ? action.on : undefined,
      });
    case "setHarnessOverlay":
      if (state.settings.harnessOverlay === action.on) return state;
      return withSettings(state, {
        ...state.settings,
        harnessOverlay: action.on === true,
      });
    case "setDockBadge":
      if (state.settings.dockBadge === action.on) return state;
      return withSettings(state, {
        ...state.settings,
        dockBadge: action.on === true,
      });
    case "setChatTextSize":
      if (
        state.settings.chatTextSize === action.size ||
        !CHAT_TEXT_SIZES.includes(action.size)
      ) return state;
      return withSettings(state, {
        ...state.settings,
        chatTextSize: action.size,
      });
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
    case "chatMeta": {
      const entry = state.terminals.find((t) => t.id === action.id);
      if (!entry?.chat) return state;
      const merged: Record<string, unknown> = {
        ...entry.chat,
        ...action.patch,
      };
      // `undefined` in the patch clears a field.
      for (const [k, v] of Object.entries(action.patch)) {
        if (v === undefined) delete merged[k];
      }
      const chat = sanitizeChat(merged);
      if (!chat || JSON.stringify(chat) === JSON.stringify(entry.chat)) {
        return state;
      }
      return updateTerminal(state, action.id, { chat });
    }
    case "scmTile": {
      const entry = state.terminals.find((t) => t.id === action.id);
      const scm = entry?.scm &&
        sanitizeScmTile({ ...entry.scm, ...action.patch });
      if (!scm || JSON.stringify(scm) === JSON.stringify(entry.scm)) {
        return state;
      }
      return updateTerminal(state, action.id, { scm, title: scmTitle(scm) });
    }
    case "activity":
      if (action.id === state.focusedId) return state;
      return updateTerminal(state, action.id, { activity: true });
    case "bell":
      if (action.id === state.focusedId || isWeb(state, action.id)) {
        return state;
      }
      return updateTerminal(state, action.id, { bell: true });
    case "commandRunning":
      if (isWeb(state, action.id)) return state;
      return updateTerminal(state, action.id, {
        running: action.running ? true : undefined,
      });
    case "commandDone":
      return commandDone(state, action.id, action.exitCode, action.now);
    case "programTitle":
      if (isWeb(state, action.id)) return state;
      return updateTerminal(state, action.id, {
        programTitle: sanitizeProgramTitle(action.title),
      });
    case "setActivity": {
      const activity = sanitizeActivity(action.patch, state.settings.activity);
      if (
        JSON.stringify(activity) === JSON.stringify(state.settings.activity)
      ) {
        return state;
      }
      return { ...state, settings: { ...state.settings, activity } };
    }
    case "setTileTitle": {
      const tileTitle = sanitizeTileTitle(action.tileTitle);
      if (state.settings.tileTitle === tileTitle) return state;
      return { ...state, settings: { ...state.settings, tileTitle } };
    }
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
    case "toggleMonocle":
      return toggleMonocle(state);
    case "minimize":
      return setMinimized(state, action.id, true);
    case "maximize":
      return maximize(state, action.id, action.now);
    case "restoreTile":
      return restoreTile(state, action.id, action.now);
    case "setView":
    case "setDefaultView":
    case "freeformRect":
    case "freeformSeed":
    case "arrange":
      return reduceView(state, action);
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
    case "setFocusToMain":
      if (state.settings.focusToMain === action.on) return state;
      return withSettings(state, {
        ...state.settings,
        focusToMain: action.on === true,
      });
    case "swapTiles": {
      const order = swapIds(state.order, action.a, action.b);
      return order === state.order ? state : { ...state, order: [...order] };
    }
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
    case "setSkin": {
      const skin = sanitizeSkinSettings(action.patch, state.settings.skin);
      if (JSON.stringify(skin) === JSON.stringify(state.settings.skin)) {
        return state;
      }
      return { ...state, settings: { ...state.settings, skin } };
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
        links.web === before.web && links.home === before.home &&
        links.bookmarksBar === before.bookmarksBar
      ) {
        return state;
      }
      return { ...state, settings: { ...state.settings, links } };
    }
    case "setAgentPresets": {
      const agentPresets = sanitizePresets(action.presets);
      if (
        JSON.stringify(agentPresets) ===
          JSON.stringify(state.settings.agentPresets)
      ) {
        return state;
      }
      return { ...state, settings: { ...state.settings, agentPresets } };
    }
    case "setMonitor": {
      const monitor = sanitizeMonitor(action.patch, state.settings.monitor);
      if (JSON.stringify(monitor) === JSON.stringify(state.settings.monitor)) {
        return state;
      }
      return { ...state, settings: { ...state.settings, monitor } };
    }
    case "setScm": {
      const scm = sanitizeScmSettings(
        { ...state.settings.scm, ...action.patch },
        state.settings.scm,
      );
      if (JSON.stringify(scm) === JSON.stringify(state.settings.scm)) {
        return state;
      }
      return { ...state, settings: { ...state.settings, scm } };
    }
    case "setWorktree": {
      const mark = sanitizeWorktreeMark(action.mark);
      if (JSON.stringify(mark) === JSON.stringify(state.worktree)) return state;
      const { worktree: _w, ...rest } = state;
      return mark ? { ...rest, worktree: mark } : rest;
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
    case "setSettingsTab":
      if (
        !SETTINGS_TABS.includes(action.tab) ||
        action.tab === state.settings.settingsTab
      ) return state;
      return {
        ...state,
        settings: { ...state.settings, settingsTab: action.tab },
      };
    case "setFont":
      return withFont(state, action.patch);
    case "zoomTile":
    case "resetTileZoom":
    case "setSharedZoom":
    case "setZoomTogether":
      return reduceZoom(state, action);
    case "hydrateSettings":
      return withSettings(
        state,
        sanitizeSettings(action.settings, state.settings),
      );
    case "restore": {
      const ids = new Set(action.terminals.map((t) => t.id));
      const terminals = action.terminals.map(({ minimized, ...t }) =>
        minimized === true ? { ...t, minimized: true } : t
      );
      // The shown tiles first, then the minimized ones (each in its own MRU order).
      const min = minimizedIds(terminals);
      const known = action.mru.filter((id) => ids.has(id));
      const mru = [
        ...known.filter((id) => !min.has(id)),
        ...known.filter((id) => min.has(id)),
      ];
      return {
        ...state,
        terminals,
        mru,
        order: sanitizeOrder(action.order, mru),
        focusedId: shownFocus(terminals, mru),
        cycle: null,
        view: action.view ?? state.view,
        freeform: action.freeform === undefined
          ? state.freeform
          : sanitizeFreeform(action.freeform, ids),
        previousPattern: action.previousPattern,
        ...(sanitizeWorktreeMark(action.worktree)
          ? { worktree: sanitizeWorktreeMark(action.worktree) }
          : {}),
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
