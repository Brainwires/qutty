// The layout controls popover: pattern grid with live previews, the sliders the engine
// understands, the bar's edge and order, the terminal font, and the shortcut list. Every change goes straight to
// the store, so the cluster animates while the slider moves.

import { useEffect, useMemo, useRef, useState } from "denext";
import { type LayoutOptions, PATTERN_INFO } from "../lib/layout/mod.ts";
import { type KeyPlatform, shortcutLabel } from "../lib/workspace/keys.ts";
import {
  BAR_POSITIONS,
  type BarOrder,
  type BarPosition,
  LAYOUT_RANGES,
  PATTERNS,
  type Settings,
} from "../lib/workspace/store.ts";
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

export interface SettingsPanelProps {
  settings: Settings;
  platform: KeyPlatform;
  onLayout(patch: Partial<LayoutOptions>): void;
  onBarPosition(position: BarPosition): void;
  onBarOrder(order: BarOrder): void;
  onFont(patch: Partial<FontSettings>): void;
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

  return (
    <div
      class="settings"
      ref={panelRef}
      role="dialog"
      aria-label="Layout settings"
      data-testid="settings-panel"
    >
      <div class="settings-head">
        <h2>Layout</h2>
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

      <div class="pattern-grid" role="radiogroup" aria-label="Pattern">
        {PATTERNS.map((p) => (
          <button
            type="button"
            key={p}
            role="radio"
            aria-checked={p === layout.pattern}
            class={`pattern-option${p === layout.pattern ? " is-active" : ""}`}
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
    <section class="font-section" data-testid="font-section">
      <h3>Font</h3>
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
    </section>
  );
}
