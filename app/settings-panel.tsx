// The settings popover, in collapsible sections: Layout (pattern grid with live previews, the
// sliders the engine understands, the bar's edge and order), Theme (preview tiles, dark and
// light), Fonts (the terminal font), Companion (app/companion/companion-settings.tsx), Agent
// integration (app/agent-integration.tsx; folded by default); the shortcut list stays visible below them. Every change goes straight to the store,
// so the cluster animates while the slider moves.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "denext";
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
  type SettingsSection,
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
import type { LaunchSection, PlusOpens } from "../lib/launcher.ts";
import { ThemePreview } from "./theme-preview.tsx";
import { AgentIntegration } from "./agent-integration.tsx";
import { CompanionSettingsSection } from "./companion/companion-settings.tsx";
import type { CompanionSettings } from "../lib/companion/settings.ts";
import type { SandboxSettings } from "../lib/sandbox/settings.ts";
import { SandboxSettingsSection } from "./sandbox-settings.tsx";
import { VoiceSettingsSection } from "./companion/voice-settings.tsx";
import type { VoiceSettings } from "../lib/voice/settings.ts";
import type { VoiceApi } from "./use-voice.ts";
import type { PtyBackend } from "../lib/pty-client.ts";

export interface SettingsPanelProps {
  settings: Settings;
  platform: KeyPlatform;
  onLayout(patch: Partial<LayoutOptions>): void;
  onBarPosition(position: BarPosition): void;
  onBarOrder(order: BarOrder): void;
  onInactiveTiles(mode: InactiveTiles): void;
  onFont(patch: Partial<FontSettings>): void;
  onTheme(theme: ThemeId): void;
  onToggleSection(section: SettingsSection): void;
  /** The `+` picker's entries, for "+ opens". */
  launchSections: LaunchSection[];
  onPlusOpens(plusOpens: PlusOpens): void;
  /** Settings → Companion. */
  onCompanion(patch: Partial<CompanionSettings>): void;
  /** Settings → Sandbox. */
  onSandbox(patch: Partial<SandboxSettings>): void;
  /** Settings → Voice. */
  onVoice(patch: Partial<VoiceSettings>): void;
  /** The voice layer (its engines' status, the model download, cloud keys). */
  voice: VoiceApi | null;
  /** For Agent integration (the section is left out without one) and the companion's status. */
  backend: PtyBackend | null;
  onClose(): void;
}

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

export function SettingsPanel(props: SettingsPanelProps) {
  const { settings } = props;
  const { layout } = settings;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const installed = useInstalledFonts();
  // The custom family as typed (the store keeps the sanitised, trimmed form, which would eat a
  // space mid-word if it drove the input).
  const [customDraft, setCustomDraft] = useState(settings.fontFamilyCustom);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = panelRef.current;
      if (!el || !(e.target instanceof Element)) return;
      if (el.contains(e.target) || e.target.closest(".bar-settings")) return;
      props.onClose();
    };
    globalThis.addEventListener("pointerdown", onDown, true);
    return () => globalThis.removeEventListener("pointerdown", onDown, true);
  }, [props.onClose]);

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

  const collapsed = settings.collapsedSections;
  const section = (
    id: SettingsSection,
    title: string,
    children: ReactNode,
    testid?: string,
  ) => (
    <Section
      id={id}
      title={title}
      open={!collapsed.includes(id)}
      onToggle={() => props.onToggleSection(id)}
      testid={testid}
    >
      {children}
    </Section>
  );

  return (
    <div
      class="settings"
      ref={panelRef}
      role="dialog"
      aria-label="Settings"
      data-testid="settings-panel"
    >
      <div class="settings-head">
        <h2>Settings</h2>
        <button
          type="button"
          class="bar-btn"
          data-testid="settings-close"
          onClick={props.onClose}
          aria-label="Close settings"
        >
          ×
        </button>
      </div>

      {section(
        "layout",
        "Layout",
        <>
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

          {slider(
            "decay",
            "Size falloff",
            layout.decay >= 0.999 ? "equal" : `×${layout.decay.toFixed(2)}`,
            "How much smaller each older terminal is than the one before it.",
          )}
          {slider(
            "masterRatio",
            "Focused share",
            `${Math.round(layout.masterRatio * 100)}%`,
            "The focused terminal's share in master + stack (a cap for cascade and spiral).",
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
                ? "Every terminal keeps the focused tile's size; the others are shown scaled down, so focusing one never resizes it."
                : "Every terminal is fitted to its own tile and resized when the layout changes."}
            </span>
          </div>
          <PlusOpensField
            value={settings.plusOpens}
            sections={props.launchSections}
            onChange={props.onPlusOpens}
          />
        </>,
      )}

      {section(
        "theme",
        "Theme",
        <ThemePicker current={settings.theme} onTheme={props.onTheme} />,
        "theme-section",
      )}

      {section(
        "font",
        "Fonts",
        <FontSection
          settings={settings}
          installed={installed}
          customDraft={customDraft}
          onCustomDraft={(v) => {
            setCustomDraft(v);
            props.onFont({ fontFamilyCustom: v });
          }}
          onFont={props.onFont}
        />,
        "font-section",
      )}

      {section(
        "companion",
        "Companion",
        <CompanionSettingsSection
          settings={settings.companion}
          backend={props.backend}
          onChange={props.onCompanion}
        />,
        "companion-section",
      )}

      {section(
        "voice",
        "Voice",
        <VoiceSettingsSection
          settings={settings.voice}
          platform={props.platform}
          voice={props.voice}
          onChange={props.onVoice}
        />,
        "voice-section",
      )}

      {section(
        "sandbox",
        "Sandbox",
        <SandboxSettingsSection
          settings={settings.sandbox}
          backend={props.backend}
          onChange={props.onSandbox}
        />,
        "sandbox-section",
      )}

      {props.backend && section(
        "integration",
        "Agent integration",
        <AgentIntegration backend={props.backend} />,
      )}

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
    </div>
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
        {props.sections.map((s) => (
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

interface SectionProps {
  id: SettingsSection;
  title: string;
  open: boolean;
  onToggle(): void;
  testid?: string;
  children: ReactNode;
}

/**
 * A collapsible panel section: a heading button (`aria-expanded`) controlling a region. The body
 * stays mounted when folded (grid rows animate 1fr ↔ 0fr) and is `visibility: hidden` once
 * folded, so its controls drop out of the tab order and the accessibility tree.
 */
function Section(props: SectionProps) {
  const head = `settings-${props.id}-head`;
  const body = `settings-${props.id}-body`;
  return (
    <section
      class={`settings-section${props.open ? " is-open" : ""}`}
      data-testid={props.testid ?? `${props.id}-section`}
      data-section={props.id}
      data-open={props.open ? "true" : "false"}
    >
      <h3 class="section-heading">
        <button
          type="button"
          id={head}
          class="section-toggle"
          aria-expanded={props.open}
          aria-controls={body}
          data-testid="section-toggle"
          data-section={props.id}
          onClick={props.onToggle}
        >
          <span class="section-chevron" aria-hidden="true">›</span>
          {props.title}
        </button>
      </h3>
      <div
        id={body}
        class="section-body"
        role="region"
        aria-labelledby={head}
        data-testid="section-body"
        data-section={props.id}
      >
        <div class="section-inner">{props.children}</div>
      </div>
    </section>
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
