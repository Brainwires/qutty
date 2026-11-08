// Settings → System monitor: the CPU / GPU meter in the switcher bar (off by default), and Loopy
// looking hot while the machine is busy (on, with Lively), with its thresholds (lib/sysstats.ts).
// The figures come from desktop/sysstats.ts every few seconds, only while one of the two is on.

import { MONITOR_RANGES, type MonitorSettings } from "../lib/sysstats.ts";

export interface MonitorSettingsProps {
  settings: MonitorSettings;
  /** Settings → Companion → Lively (the hot face needs it). */
  lively: boolean;
  onChange(patch: Partial<MonitorSettings>): void;
}

export function MonitorSettingsSection(props: MonitorSettingsProps) {
  const { settings, onChange } = props;
  const range = (
    key: "hotAt" | "coolAt" | "sustainS",
    label: string,
    unit: string,
  ) => (
    <label class="field">
      <span class="field-label">
        {label} <output>{settings[key]}{unit}</output>
      </span>
      <input
        type="range"
        min={MONITOR_RANGES[key].min}
        max={MONITOR_RANGES[key].max}
        step={1}
        value={settings[key]}
        disabled={!settings.hotLoopy}
        data-testid={`setting-monitor-${key}`}
        onInput={(e) => onChange({ [key]: Number(e.currentTarget.value) })}
      />
    </label>
  );
  return (
    <div class="monitor-settings" data-testid="monitor-settings">
      <label class="field field-check">
        <input
          type="checkbox"
          data-testid="setting-monitor-meter"
          checked={settings.meter}
          onChange={(e) =>
            onChange({ meter: (e.target as HTMLInputElement).checked })}
        />
        <span class="field-label">CPU / GPU meter in the bar</span>
      </label>
      <label class="field field-check">
        <input
          type="checkbox"
          data-testid="setting-monitor-hot"
          checked={settings.hotLoopy}
          onChange={(e) =>
            onChange({ hotLoopy: (e.target as HTMLInputElement).checked })}
        />
        <span class="field-label">Loopy gets hot when the machine is busy</span>
      </label>
      {range("hotAt", "Hot at", "%")}
      {range("coolAt", "Cool below", "%")}
      {range("sustainS", "For at least", " s")}
      <span class="field-hint">
        Hot once the CPU or the GPU stays at or above the first figure, cool
        again once both stay below the second. {props.lively
          ? "Loopy only looks hot while it has nothing else to show."
          : "Needs Lively on (Companion)."}{" "}
        Sampled every 4 s (12 s in the background, never while the window is
        hidden), only while one of these is on.
      </span>
    </div>
  );
}
