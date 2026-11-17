// The Settings dialog: a modal (app/modal.tsx) centred over the window, a sidebar of categories
// (a vertical tablist, ↑/↓ between them) under a search field, and the selected category's
// groups on the right, scrolling on their own. Every category stays mounted (hidden when not
// selected), so a section's state and its live status survive switching tabs.
//
// Searching shows every category at once, each under its name, and hides the groups and rows
// (`.field`) whose label, hint or choices do not match (the filter runs over the DOM, again
// whenever the content changes: `useSearchFilter`). Clearing the field returns to the tab.
//
// The tab picked last is remembered (`settings.settingsTab`). A deep link (`target`, a control's
// `data-testid`; or a `SettingsLink` inside the dialog: app/settings-ui.tsx) opens its tab and
// scrolls to that row, which flashes. Every change goes straight to the store, so the cluster
// animates while a slider moves.

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "denext";
import { type LayoutOptions, PATTERN_INFO } from "../lib/layout/mod.ts";
import { type KeyPlatform, shortcutLabel } from "../lib/workspace/keys.ts";
import {
  BAR_POSITIONS,
  type BarOrder,
  type BarPosition,
  INACTIVE_TILE_MODES,
  type InactiveTiles,
  LAYOUT_RANGES,
  PATTERNS,
  type Settings,
  SETTINGS_TABS,
  type SettingsTab,
} from "../lib/workspace/store.ts";
import { type ThemeId, THEMES } from "../lib/workspace/themes.ts";
import {
  browserFontProbe,
  CUSTOM_FONT_ID,
  detectInstalledFonts,
  FONT_RANGES,
  type FontSettings,
  fontStack,
  type FontWeightSetting,
  isFamilyInstalled,
  sanitizeCustomFamily,
  sortByInstalled,
  stepFontSize,
} from "../lib/workspace/fonts.ts";
import { PatternPreview } from "./pattern-preview.tsx";
import {
  VIEW_LABELS,
  VIEW_MODES,
  type ViewMode,
} from "../lib/workspace/freeform.ts";
import type { LaunchSection, PlusOpens } from "../lib/launcher.ts";
import { ThemePreview } from "./theme-preview.tsx";
import { AgentIntegration } from "./agent-integration.tsx";
import { CompanionSettingsSection } from "./companion/companion-settings.tsx";
import type { CompanionSettings } from "../lib/companion/settings.ts";
import type { SandboxSettings } from "../lib/sandbox/settings.ts";
import { SandboxSettingsSection } from "./sandbox-settings.tsx";
import { OllamaSettingsSection } from "./ollama-settings.tsx";
import type { OllamaTracking } from "./use-ollama.ts";
import type { OllamaSettings } from "../lib/ollama/settings.ts";
import { VoiceSettingsSection } from "./companion/voice-settings.tsx";
import type { VoiceSettings } from "../lib/voice/settings.ts";
import type { VoiceApi } from "./use-voice.ts";
import type { PtyBackend } from "../lib/pty-client.ts";
import type { LinkSettings } from "../lib/links.ts";
import { LinksSettingsSection } from "./links-settings.tsx";
import { Modal } from "./modal.tsx";
import { MonitorSettingsSection } from "./monitor-settings.tsx";
import { WindowSettingsSection } from "./window-settings.tsx";
import { TileSettingsSection } from "./tile-settings.tsx";
import { SettingsGroup, SettingsNav } from "./settings-ui.tsx";
import type { ActivitySettings, TileTitle } from "../lib/workspace/activity.ts";
import type { WindowClose } from "../lib/workspace/windows.ts";
import type { MonitorSettings } from "../lib/sysstats.ts";

export interface SettingsPanelProps {
  settings: Settings;
  platform: KeyPlatform;
  onLayout(patch: Partial<LayoutOptions>): void;
  /** This workspace's view. */
  view: ViewMode;
  onView(view: ViewMode): void;
  /** The view new workspaces start in (`settings.defaultView`). */
  onDefaultView(view: ViewMode): void;
  onBarPosition(position: BarPosition): void;
  onBarOrder(order: BarOrder): void;
  onInactiveTiles(mode: InactiveTiles): void;
  /** Settings → Layout: whether the focused tile moves to the main spot. */
  onFocusToMain(on: boolean): void;
  /** Settings → Tiles → "Show a GUI around agent harnesses". */
  onHarnessOverlay(on: boolean): void;
  /** Settings → Tiles. */
  onActivity(patch: Partial<ActivitySettings>): void;
  onTileTitle(tileTitle: TileTitle): void;
  onFont(patch: Partial<FontSettings>): void;
  onTheme(theme: ThemeId): void;
  /** A tab was picked (remembered as `settings.settingsTab`). */
  onTab(tab: SettingsTab): void;
  /**
   * A deep link: the `data-testid` of the control to show (its tab is `settings.settingsTab`),
   * scrolled to and flashed once the dialog is open.
   */
  target?: string | null;
  /** The `+` picker's entries, for "+ opens". */
  launchSections: LaunchSection[];
  onPlusOpens(plusOpens: PlusOpens): void;
  /** Settings → Companion. */
  onCompanion(patch: Partial<CompanionSettings>): void;
  /** Settings → Sandbox. */
  onSandbox(patch: Partial<SandboxSettings>): void;
  /** Settings → Voice. */
  onVoice(patch: Partial<VoiceSettings>): void;
  /** Settings → Agents → Ollama: the tracking (the group is left out without it). */
  ollama?: OllamaTracking;
  onOllama(patch: Partial<OllamaSettings>): void;
  /** Settings → Links & web. */
  onLinks(patch: Partial<LinkSettings>): void;
  /** Settings → System monitor. */
  onMonitor(patch: Partial<MonitorSettings>): void;
  /**
   * Settings → General → Windows: what the close button does. Left out where the window's close
   * is not held (the demo, an older runtime).
   */
  onWindowClose?: (windowClose: WindowClose) => void;
  /** The voice layer (its engines' status, the model download, cloud keys). */
  voice: VoiceApi | null;
  /** For Settings → Agents (the tab is left out without one) and the companion's status. */
  backend: PtyBackend | null;
  onClose(): void;
}

/** The sidebar's names for the tabs. */
const TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  appearance: "Appearance",
  layout: "Layout",
  tiles: "Tiles",
  links: "Links & web",
  sandbox: "Sandbox",
  agents: "Agents",
  companion: "Companion",
  voice: "Voice",
  monitor: "System monitor",
};

const SHORTCUTS: [string, string][] = [
  ["Mod+T", "New terminal"],
  ["Mod+W", "Close focused"],
  ["Mod+1…9", "Focus by bar number"],
  ["Mod+]", "Next in recency order"],
  ["Mod+[", "Previous in recency order"],
  ["Mod+`", "Jump to last used"],
  ["Mod+Enter", "Toggle monocle"],
  ["Mod+Shift+L", "Cycle pattern"],
  ["Mod+Shift+B", "Move the bar"],
  ["Mod+Shift+O", "SSH connections"],
  ["Mod+Shift+I", "Broadcast input on / off"],
  ["Mod+=", "Bigger font"],
  ["Mod+-", "Smaller font"],
  ["Mod+0", "Default font size"],
];

const SAMPLE = "~/src ❯ git status  0O1lI {}[] => !=";

/** Which curated families are installed; re-probed when a font finishes loading. */
function useInstalledFonts(): Record<string, boolean> {
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const probe = () => setInstalled(detectInstalledFonts(browserFontProbe()));
    probe();
    const fonts = globalThis.document?.fonts;
    fonts?.addEventListener?.("loadingdone", probe);
    return () => fonts?.removeEventListener?.("loadingdone", probe);
  }, []);
  return installed;
}

// ---- Search ---------------------------------------------------------------------------------

const HIDDEN = "data-search-hidden";

/** The words of a query, lower-cased. */
function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** What a row is found by: its labels, hints and the names of its choices. */
function rowText(el: Element): string {
  const parts = [
    ...el.querySelectorAll(
      ".field-label, .field-hint, option, [role=radio], [role=option], [aria-label]",
    ),
  ].map((e) => `${e.textContent ?? ""} ${e.getAttribute("aria-label") ?? ""}`);
  return parts.join(" ");
}

const matches = (text: string, words: string[]) => {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
};

/**
 * Show the rows of `group` that match `words` (with `context`: the category's and the group's
 * names). A row is a `.field`; anything else (a hint after a checkbox, the pattern grid, a
 * status line) goes with the row before it, or is matched on its own text. Wrappers are walked
 * into. Returns whether anything in the group matched.
 */
function filterGroup(group: Element, words: string[], context: string) {
  const body = group.querySelector(".settings-group-body") ?? group;
  let any = false;
  let prev = false;
  let prevRow: Element | null = null;
  const visit = (el: Element) => {
    for (const child of el.children) {
      let show: boolean;
      if (child.matches(".field")) {
        show = matches(`${context} ${rowText(child)}`, words);
        prev = show;
        prevRow = child;
      } else if (child.querySelector(".field")) {
        child.removeAttribute(HIDDEN);
        visit(child);
        continue;
      } else {
        const own = matches(`${context} ${child.textContent ?? ""}`, words);
        show = prev || own;
        // A hint found on its own brings the row it explains.
        if (own && !prev && prevRow && child.matches(".field-hint")) {
          prevRow.removeAttribute(HIDDEN);
          prev = true;
        }
      }
      child.toggleAttribute(HIDDEN, !show);
      any ||= show;
    }
  };
  visit(body);
  group.toggleAttribute(HIDDEN, !any);
  return any;
}

/** Filter every category under `root`; returns how many groups are shown. */
function applySearch(root: Element, query: string): number {
  const words = queryWords(query);
  if (words.length === 0) {
    for (const el of root.querySelectorAll(`[${HIDDEN}]`)) {
      el.removeAttribute(HIDDEN);
    }
    return -1;
  }
  let shown = 0;
  for (const cat of root.querySelectorAll(".settings-category")) {
    const name = cat.getAttribute("data-label") ?? "";
    let catShown = 0;
    for (const group of cat.querySelectorAll(".settings-group")) {
      const title = group.querySelector(".settings-group-title")?.textContent ??
        "";
      if (filterGroup(group, words, `${name} ${title}`)) catShown++;
    }
    cat.toggleAttribute(HIDDEN, catShown === 0);
    shown += catShown;
  }
  return shown;
}

/**
 * Keep the search applied to `root`: now, and whenever its content changes (a section loading
 * its status, a row appearing). Returns how many groups match (-1 while not searching).
 */
function useSearchFilter(
  root: { current: HTMLElement | null },
  query: string,
): number {
  const [shown, setShown] = useState(-1);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const run = () => setShown(applySearch(el, query));
    run();
    if (queryWords(query).length === 0) return;
    const observer = new MutationObserver(run);
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [query]);
  return shown;
}

/** Scroll to the row holding `[data-testid=target]` in `panel` and flash it; focus the control. */
function showTarget(panel: HTMLElement, target: string): boolean {
  const el = panel.querySelector<HTMLElement>(
    `[data-testid="${CSS.escape(target)}"]`,
  );
  if (!el) return false;
  const row = el.closest<HTMLElement>(".field, .settings-group") ?? el;
  row.scrollIntoView({ block: "center", behavior: "instant" });
  row.removeAttribute("data-flash");
  // Restart the flash (a second link to the same row): reading layout ends the old animation.
  void row.offsetWidth;
  row.setAttribute("data-flash", "");
  row.addEventListener(
    "animationend",
    () => row.removeAttribute("data-flash"),
    { once: true },
  );
  if (el.matches("input, select, button, textarea, [tabindex]")) {
    el.focus({ preventScroll: true });
  }
  return true;
}

// ---- The dialog -----------------------------------------------------------------------------

export function SettingsPanel(props: SettingsPanelProps) {
  const { settings } = props;
  const { layout } = settings;
  const installed = useInstalledFonts();
  // The custom family as typed (the store keeps the sanitised, trimmed form, which would eat a
  // space mid-word if it drove the input).
  const [customDraft, setCustomDraft] = useState(settings.fontFamilyCustom);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  // A deep link waiting for its tab to show (from the workspace, or a link in here).
  const [pending, setPending] = useState<string | null>(props.target ?? null);
  useEffect(() => {
    if (props.target) setPending(props.target);
  }, [props.target]);

  const tabs = SETTINGS_TABS.filter((t) => t !== "agents" || props.backend);
  const tab = tabs.includes(settings.settingsTab)
    ? settings.settingsTab
    : "general";
  const searching = queryWords(query).length > 0;
  const shown = useSearchFilter(contentRef, query);

  // Open on the search field (a deep link focuses its control instead).
  useEffect(() => {
    if (!props.target) searchRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!pending || searching) return;
    const panel = contentRef.current?.querySelector<HTMLElement>(
      `.settings-category[data-tab="${tab}"]`,
    );
    if (panel) showTarget(panel, pending);
    setPending(null);
  }, [pending, tab, searching]);

  const go = useMemo(
    () => (to: SettingsTab, target?: string) => {
      setQuery("");
      props.onTab(to);
      if (target) setPending(target);
      else {
        const panel = contentRef.current;
        if (panel) panel.scrollTop = 0;
      }
    },
    [props.onTab],
  );

  /** ↑/↓ (and Home/End) between the tabs; the tab gets focus and is shown. */
  const onTabKey = (e: { key: string; preventDefault(): void }) => {
    const i = tabs.indexOf(tab);
    const next = e.key === "ArrowDown"
      ? tabs[(i + 1) % tabs.length]
      : e.key === "ArrowUp"
      ? tabs[(i - 1 + tabs.length) % tabs.length]
      : e.key === "Home"
      ? tabs[0]
      : e.key === "End"
      ? tabs[tabs.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    go(next);
    tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)
      ?.focus();
  };

  const slider = (
    key: "decay" | "masterRatio" | "maxVisible" | "gap",
    label: string,
    display: string,
    hint: string,
  ) => {
    const r = LAYOUT_RANGES[key];
    return (
      <label class="field">
        <span class="field-label">
          {label}
          <output>{display}</output>
        </span>
        <input
          type="range"
          min={r.min}
          max={r.max}
          step={r.step}
          value={layout[key]}
          data-testid={`setting-${key}`}
          onInput={(e) =>
            props.onLayout({ [key]: Number(e.currentTarget.value) })}
        />
        <span class="field-hint">{hint}</span>
      </label>
    );
  };

  const content: Record<SettingsTab, ReactNode> = {
    general: (
      <>
        {props.onWindowClose && (
          <SettingsGroup title="Windows" testid="windows-section">
            <WindowSettingsSection
              windowClose={settings.windowClose}
              onChange={props.onWindowClose}
            />
          </SettingsGroup>
        )}
        <SettingsGroup title="New tiles">
          <PlusOpensField
            value={settings.plusOpens}
            sections={props.launchSections}
            onChange={props.onPlusOpens}
          />
        </SettingsGroup>
        <SettingsGroup title="Switcher bar">
          <div class="field">
            <span class="field-label">Bar edge</span>
            <div class="segmented" role="radiogroup" aria-label="Bar edge">
              {BAR_POSITIONS.map((p) => (
                <button
                  type="button"
                  key={p}
                  role="radio"
                  aria-checked={p === settings.barPosition}
                  class={p === settings.barPosition ? "is-active" : ""}
                  data-testid="setting-bar-position"
                  data-value={p}
                  onClick={() => props.onBarPosition(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div class="field">
            <span class="field-label">Bar order</span>
            <div class="segmented" role="radiogroup" aria-label="Bar order">
              {(["mru", "created"] as BarOrder[]).map((o) => (
                <button
                  type="button"
                  key={o}
                  role="radio"
                  aria-checked={o === settings.barOrder}
                  class={o === settings.barOrder ? "is-active" : ""}
                  data-testid="setting-bar-order"
                  data-value={o}
                  onClick={() => props.onBarOrder(o)}
                >
                  {o === "mru" ? "recently used" : "opened"}
                </button>
              ))}
            </div>
          </div>
        </SettingsGroup>
        <SettingsGroup title="Keyboard shortcuts" testid="shortcuts-section">
          <dl class="shortcuts">
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys}>
                <dt>
                  <kbd>{shortcutLabel(keys, props.platform)}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </SettingsGroup>
      </>
    ),
    appearance: (
      <>
        <SettingsGroup title="Theme" testid="theme-section">
          <ThemePicker current={settings.theme} onTheme={props.onTheme} />
        </SettingsGroup>
        <SettingsGroup title="Font" testid="font-section">
          <FontSection
            settings={settings}
            installed={installed}
            customDraft={customDraft}
            onCustomDraft={(v) => {
              setCustomDraft(v);
              props.onFont({ fontFamilyCustom: v });
            }}
            onFont={props.onFont}
          />
        </SettingsGroup>
        <SettingsGroup title="Inactive tiles">
          <div class="field">
            <span class="field-label">Inactive tiles</span>
            <div
              class="segmented"
              role="radiogroup"
              aria-label="Inactive tiles"
            >
              {INACTIVE_TILE_MODES.map((m) => (
                <button
                  type="button"
                  key={m}
                  role="radio"
                  aria-checked={m === settings.inactiveTiles}
                  class={m === settings.inactiveTiles ? "is-active" : ""}
                  data-testid="setting-inactive-tiles"
                  data-value={m}
                  onClick={() => props.onInactiveTiles(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <span class="field-hint">
              {settings.inactiveTiles === "scale"
                ? settings.focusToMain
                  ? "Every terminal keeps the main tile's size; the others are shown scaled down, so focusing one never resizes it."
                  : "Every terminal keeps the main tile's size, the others shown scaled down; the focused one fits its own tile."
                : "Every terminal is fitted to its own tile and resized when the layout changes."}
            </span>
          </div>
        </SettingsGroup>
      </>
    ),
    layout: (
      <>
        <SettingsGroup title="View" testid="layout-section">
          <ViewField
            label="View"
            hint="This workspace: tiles laid out for you, or windows you move and resize."
            testid="setting-view"
            value={props.view}
            onChange={props.onView}
          />
          <ViewField
            label="New workspaces"
            hint="The view a new workspace starts in; each workspace keeps its own."
            testid="setting-default-view"
            value={settings.defaultView}
            onChange={props.onDefaultView}
          />
        </SettingsGroup>
        <SettingsGroup title="Pattern">
          <div class="pattern-grid" role="radiogroup" aria-label="Pattern">
            {PATTERNS.map((p) => (
              <button
                type="button"
                key={p}
                role="radio"
                aria-checked={p === layout.pattern}
                class={`pattern-option${
                  p === layout.pattern ? " is-active" : ""
                }`}
                data-testid="setting-pattern"
                data-pattern={p}
                title={PATTERN_INFO[p].description}
                onClick={() => props.onLayout({ pattern: p })}
              >
                <PatternPreview pattern={p} options={layout} />
                <span>{PATTERN_INFO[p].label}</span>
              </button>
            ))}
          </div>
          <p class="pattern-desc">{PATTERN_INFO[layout.pattern].description}</p>
          <label class="field field-check">
            <input
              type="checkbox"
              data-testid="setting-focus-to-main"
              checked={settings.focusToMain}
              onChange={(e) =>
                props.onFocusToMain((e.target as HTMLInputElement).checked)}
            />
            <span class="field-label">Focused tile moves to the main spot</span>
          </label>
          <span class="field-hint">
            {settings.focusToMain
              ? "Focusing a tile makes it the biggest; the others shift by how recently they were used."
              : "Tiles stay where they are when focused. Drag a tile by its header onto another to swap them."}
          </span>
        </SettingsGroup>
        <SettingsGroup title="Sizes">
          {slider(
            "decay",
            "Size falloff",
            layout.decay >= 0.999 ? "equal" : `×${layout.decay.toFixed(2)}`,
            "How much smaller each older terminal is than the one before it.",
          )}
          {slider(
            "masterRatio",
            "Main share",
            `${Math.round(layout.masterRatio * 100)}%`,
            "The main tile's share in master + stack (a cap for cascade and spiral).",
          )}
          {slider(
            "maxVisible",
            "Tiles shown",
            String(layout.maxVisible),
            "Older terminals beyond this stay in the bar.",
          )}
          {slider(
            "gap",
            "Gap",
            `${layout.gap}px`,
            "Space between tiles and around the edges.",
          )}
        </SettingsGroup>
      </>
    ),
    tiles: (
      <TileSettingsSection
        activity={settings.activity}
        tileTitle={settings.tileTitle}
        harnessOverlay={settings.harnessOverlay}
        onActivity={props.onActivity}
        onTileTitle={props.onTileTitle}
        onHarnessOverlay={props.onHarnessOverlay}
      />
    ),
    links: (
      <SettingsGroup title="Links" testid="links-section">
        <LinksSettingsSection
          settings={settings.links}
          backend={props.backend}
          platform={props.platform}
          onChange={props.onLinks}
        />
      </SettingsGroup>
    ),
    sandbox: (
      <SettingsGroup title="Shared container" testid="sandbox-section">
        <SandboxSettingsSection
          settings={settings.sandbox}
          backend={props.backend}
          onChange={props.onSandbox}
        />
      </SettingsGroup>
    ),
    agents: props.backend && (
      <>
        <SettingsGroup title="Agent integration" testid="integration-section">
          <AgentIntegration backend={props.backend} />
        </SettingsGroup>
        {props.ollama && (
          <SettingsGroup title="Ollama" testid="ollama-section">
            <OllamaSettingsSection
              settings={settings.ollama}
              tracking={props.ollama}
              backend={props.backend}
              onChange={props.onOllama}
            />
          </SettingsGroup>
        )}
      </>
    ),
    companion: (
      <CompanionSettingsSection
        settings={settings.companion}
        backend={props.backend}
        {...(props.ollama ? { ollama: props.ollama.status } : {})}
        onChange={props.onCompanion}
      />
    ),
    voice: (
      <VoiceSettingsSection
        settings={settings.voice}
        name={settings.companion.name}
        platform={props.platform}
        voice={props.voice}
        onChange={props.onVoice}
      />
    ),
    monitor: (
      <SettingsGroup title="System monitor" testid="monitor-section">
        <MonitorSettingsSection
          settings={settings.monitor}
          lively={settings.companion.lively}
          name={settings.companion.name}
          onChange={props.onMonitor}
        />
      </SettingsGroup>
    ),
  };

  return (
    <Modal
      label="Settings"
      testid="settings-panel"
      class="settings-dialog"
      onClose={props.onClose}
    >
      <SettingsNav.Provider value={go}>
        <div class="settings-side">
          <input
            ref={searchRef}
            type="search"
            class="settings-search"
            data-testid="settings-search"
            placeholder="Search settings"
            aria-label="Search settings"
            spellcheck={false}
            autocomplete="off"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <div
            ref={tabsRef}
            class="settings-tabs"
            data-testid="settings-tablist"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings categories"
            onKeyDown={onTabKey}
          >
            {tabs.map((t) => (
              <button
                type="button"
                key={t}
                id={`settings-tab-${t}`}
                role="tab"
                aria-selected={t === tab}
                aria-controls={`settings-tabpanel-${t}`}
                tabIndex={t === tab ? 0 : -1}
                class={`settings-tab${
                  t === tab && !searching ? " is-active" : ""
                }`}
                data-testid="settings-tab"
                data-tab={t}
                onClick={() => go(t)}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <div class="settings-main">
          <div class="settings-head">
            <h2 data-testid="settings-title">
              {searching ? "Search" : TAB_LABELS[tab]}
            </h2>
          </div>
          {searching && shown === 0 && (
            <p class="settings-empty" data-testid="settings-no-results">
              No settings match “{query.trim()}”.
            </p>
          )}
          <div
            ref={contentRef}
            class={`settings-content${searching ? " is-searching" : ""}`}
            data-testid="settings-content"
          >
            {tabs.map((t) => (
              <section
                key={t}
                id={`settings-tabpanel-${t}`}
                class="settings-category"
                role="tabpanel"
                aria-labelledby={`settings-tab-${t}`}
                data-label={TAB_LABELS[t]}
                hidden={!searching && t !== tab}
                data-testid="settings-category"
                data-tab={t}
              >
                {searching && (
                  <h3 class="settings-category-title">{TAB_LABELS[t]}</h3>
                )}
                {content[t]}
              </section>
            ))}
          </div>
          {/* After the content in the tab order (Tab from the sidebar goes into the content). */}
          <button
            type="button"
            class="bar-btn settings-close"
            data-testid="settings-close"
            onClick={props.onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>
      </SettingsNav.Provider>
    </Modal>
  );
}

/**
 * What plain `+` (and the new-terminal shortcut) opens: the default shell, the last thing picked
 * from the `+` menu, or one entry of it. An entry that is not available (yet) stays selectable
 * so a saved choice is not lost while the list loads.
 */
function PlusOpensField(props: {
  value: PlusOpens;
  sections: LaunchSection[];
  onChange(value: PlusOpens): void;
}) {
  const known = props.sections.some((s) =>
    s.entries.some((e) => e.id === props.value)
  );
  const fixed = props.value === "default" || props.value === "last";
  return (
    <label class="field">
      <span class="field-label">+ opens</span>
      <select
        class="field-select"
        data-testid="setting-plus-opens"
        value={props.value}
        onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}
      >
        <option value="default">Default shell</option>
        <option value="last">Last used</option>
        {props.sections.filter((s) => s.entries.length > 0).map((s) => (
          <optgroup label={s.title} key={s.id}>
            {s.entries.map((e) => (
              <option value={e.id} key={e.id}>
                {e.kind === "ssh" ? `ssh ${e.label}` : e.label}
              </option>
            ))}
          </optgroup>
        ))}
        {!fixed && !known && <option value={props.value}>{props.value}</option>}
      </select>
      <span class="field-hint">
        The menu beside + picks anything else.
      </span>
    </label>
  );
}

/** The theme tiles, dark and light groups of three. */
function ThemePicker(
  { current, onTheme }: { current: ThemeId; onTheme(theme: ThemeId): void },
) {
  return (
    <div class="theme-picker" role="radiogroup" aria-label="Theme">
      {(["dark", "light"] as const).map((scheme) => (
        <div class="theme-group" key={scheme} data-scheme={scheme}>
          <span class="theme-group-label" id={`theme-group-${scheme}`}>
            {scheme === "dark" ? "Dark" : "Light"}
          </span>
          <div
            class="theme-grid"
            role="group"
            aria-labelledby={`theme-group-${scheme}`}
          >
            {THEMES.filter((t) =>
              t.scheme === scheme
            ).map((t) => (
              <button
                type="button"
                key={t.id}
                role="radio"
                aria-checked={t.id === current}
                class={`pattern-option theme-option${
                  t.id === current ? " is-active" : ""
                }`}
                data-testid="setting-theme"
                data-value={t.id}
                title={`${t.label} (${scheme})`}
                onClick={() => onTheme(t.id)}
              >
                <ThemePreview theme={t} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

interface FontSectionProps {
  settings: Settings;
  installed: Record<string, boolean>;
  customDraft: string;
  onCustomDraft(value: string): void;
  onFont(patch: Partial<FontSettings>): void;
}

function FontSection(props: FontSectionProps) {
  const { settings, installed } = props;
  const size = FONT_RANGES.fontSize;
  const lh = FONT_RANGES.lineHeight;
  const isCustom = settings.fontFamily === CUSTOM_FONT_ID;
  const customName = sanitizeCustomFamily(props.customDraft);
  const customMissing = useMemo(
    () =>
      isCustom && customName !== "" &&
      !isFamilyInstalled(browserFontProbe(), `"${customName}"`),
    [isCustom, customName],
  );
  const stack = fontStack(settings);
  return (
    <>
      <div class="field">
        <span class="field-label">Typeface</span>
        <div
          class="font-list"
          role="listbox"
          aria-label="Typeface"
          data-testid="font-list"
        >
          {sortByInstalled(installed).map((f) => {
            const missing = installed[f.id] === false;
            const active = settings.fontFamily === f.id;
            return (
              <button
                type="button"
                key={f.id}
                role="option"
                aria-selected={active}
                class={`font-option${active ? " is-active" : ""}${
                  missing ? " is-missing" : ""
                }`}
                data-testid="setting-font-family"
                data-value={f.id}
                data-installed={missing ? "false" : "true"}
                title={missing ? `${f.label} is not installed` : f.label}
                onClick={() => props.onFont({ fontFamily: f.id })}
              >
                <span
                  class="font-option-name"
                  style={{
                    fontFamily: fontStack({
                      fontFamily: f.id,
                      fontFamilyCustom: "",
                    }),
                  }}
                >
                  {f.label}
                </span>
                {missing && <span class="font-option-tag">not installed</span>}
              </button>
            );
          })}
          <button
            type="button"
            role="option"
            aria-selected={isCustom}
            class={`font-option${isCustom ? " is-active" : ""}`}
            data-testid="setting-font-family"
            data-value={CUSTOM_FONT_ID}
            data-installed="true"
            onClick={() => props.onFont({ fontFamily: CUSTOM_FONT_ID })}
          >
            <span class="font-option-name">Custom…</span>
          </button>
        </div>
        {isCustom && (
          <input
            type="text"
            class="font-custom"
            placeholder="Any installed family, e.g. Berkeley Mono"
            spellcheck={false}
            value={props.customDraft}
            data-testid="setting-font-custom"
            onInput={(e) => props.onCustomDraft(e.currentTarget.value)}
          />
        )}
        {isCustom && (
          <span class="field-hint" data-testid="font-custom-hint">
            {customName === ""
              ? "Type a family name; until then the default is used."
              : customMissing
              ? `"${customName}" does not look installed; monospace is used.`
              : "Falls back to monospace when a glyph is missing."}
          </span>
        )}
      </div>

      <div class="field">
        <span class="field-label">
          Size
          <output data-testid="font-size-value">{settings.fontSize}px</output>
        </span>
        <div class="stepper">
          <button
            type="button"
            class="stepper-btn"
            aria-label="Smaller font"
            data-testid="setting-fontSize-dec"
            disabled={settings.fontSize <= size.min}
            onClick={() =>
              props.onFont({ fontSize: stepFontSize(settings.fontSize, -1) })}
          >
            −
          </button>
          <input
            type="range"
            min={size.min}
            max={size.max}
            step={size.step}
            value={settings.fontSize}
            data-testid="setting-fontSize"
            aria-label="Font size"
            onInput={(e) =>
              props.onFont({ fontSize: Number(e.currentTarget.value) })}
          />
          <button
            type="button"
            class="stepper-btn"
            aria-label="Bigger font"
            data-testid="setting-fontSize-inc"
            disabled={settings.fontSize >= size.max}
            onClick={() =>
              props.onFont({ fontSize: stepFontSize(settings.fontSize, 1) })}
          >
            +
          </button>
        </div>
      </div>

      <label class="field">
        <span class="field-label">
          Line height
          <output>{settings.lineHeight.toFixed(2)}</output>
        </span>
        <input
          type="range"
          min={lh.min}
          max={lh.max}
          step={lh.step}
          value={settings.lineHeight}
          data-testid="setting-lineHeight"
          onInput={(e) =>
            props.onFont({ lineHeight: Number(e.currentTarget.value) })}
        />
      </label>

      <div class="field">
        <span class="field-label">Weight</span>
        <div class="segmented" role="radiogroup" aria-label="Font weight">
          {(["normal", "500"] as FontWeightSetting[]).map((w) => (
            <button
              type="button"
              key={w}
              role="radio"
              aria-checked={w === settings.fontWeight}
              class={w === settings.fontWeight ? "is-active" : ""}
              data-testid="setting-fontWeight"
              data-value={w}
              onClick={() => props.onFont({ fontWeight: w })}
            >
              {w === "normal" ? "regular" : "medium"}
            </button>
          ))}
        </div>
      </div>

      <div
        class="font-sample"
        data-testid="font-sample"
        style={{
          fontFamily: stack,
          fontSize: `${settings.fontSize}px`,
          lineHeight: String(settings.lineHeight),
          fontWeight: settings.fontWeight,
        }}
      >
        {SAMPLE}
      </div>
    </>
  );
}

/** A Tiled / Free-form choice (this workspace's view, or new workspaces'). */
function ViewField(props: {
  label: string;
  hint: string;
  testid: string;
  value: ViewMode;
  onChange(view: ViewMode): void;
}) {
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <div class="segmented" role="radiogroup" aria-label={props.label}>
        {VIEW_MODES.map((v) => (
          <button
            type="button"
            key={v}
            role="radio"
            aria-checked={v === props.value}
            class={v === props.value ? "is-active" : ""}
            data-testid={props.testid}
            data-value={v}
            onClick={() => props.onChange(v)}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>
      <span class="field-hint">{props.hint}</span>
    </div>
  );
}
