// Settings → Companion → Messages: the companion's own lines (a quote of the day, on by default;
// encouragement now and then, off by default, with how often) and voice mode (everything in the
// bubble said aloud; the same setting as Settings → Voice → Voice mode). The rules:
// lib/companion/ambient.ts, lib/voice/bubble-speech.ts.

import {
  type CompanionSettings,
  ENCOURAGE_FREQUENCIES,
  type EncourageFrequency,
} from "../../lib/companion/settings.ts";
import { Check } from "./voice-settings.tsx";

export interface MessageSettingsProps {
  settings: CompanionSettings;
  /** The companion is shown (else everything here is off). */
  shown: boolean;
  /** Settings → Voice → Voice mode (absent: not offered here). */
  voiceMode?: boolean;
  onVoiceMode?(on: boolean): void;
  onChange(patch: Partial<CompanionSettings>): void;
}

const FREQUENCY_LABEL: Record<EncourageFrequency, string> = {
  rarely: "Rarely (every 2–4 hours of use)",
  sometimes: "Sometimes (every 45–90 minutes)",
  often: "Often (every 20–40 minutes)",
};

export function MessageSettings(props: MessageSettingsProps) {
  const { settings, shown, onChange } = props;
  return (
    <div
      class="field message-settings"
      data-testid="companion-messages"
      role="group"
      aria-label="Messages"
    >
      <Check
        testid="setting-companion-quoteOfDay"
        label="Quote of the day (at startup, and on the first use of a new day)"
        checked={settings.quoteOfDay}
        disabled={!shown}
        onChange={(quoteOfDay) => onChange({ quoteOfDay })}
      />
      <Check
        testid="setting-companion-encourage"
        label="Encouragement now and then (a short kind or inspiring line)"
        checked={settings.encourage}
        disabled={!shown}
        onChange={(encourage) => onChange({ encourage })}
      />
      <label class="field">
        <span class="field-label">How often</span>
        <select
          class="field-select"
          data-testid="setting-companion-encourageEvery"
          value={settings.encourageEvery}
          disabled={!shown || !settings.encourage}
          onChange={(e) =>
            onChange({
              encourageEvery: (e.target as HTMLSelectElement)
                .value as EncourageFrequency,
            })}
        >
          {ENCOURAGE_FREQUENCIES.map((f) => (
            <option value={f} key={f}>{FREQUENCY_LABEL[f]}</option>
          ))}
        </select>
      </label>
      {props.onVoiceMode && (
        <Check
          testid="setting-companion-voiceMode"
          label="Voice mode: say everything in the bubble aloud"
          checked={props.voiceMode === true}
          disabled={!shown}
          onChange={props.onVoiceMode}
        />
      )}
      <span class="field-hint">
        Quotes are public-domain lines from long-gone writers, one per day and
        the same in every window; it shows once a day, in one window. An
        encouraging line waits until {settings.name}{" "}
        is free: never over a question or a message, while you type, or while
        {" "}
        {settings.name}{" "}
        sleeps. Voice mode is the same setting as Settings → Voice and uses its
        voice, speed and volume.
      </span>
    </div>
  );
}
