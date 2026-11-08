// Settings → Companion → Reactions: Loopy sleepy at night (with its hours), a hop of joy when a
// long job finishes well, a brief sad face when one fails, how long a shell command must run to
// count (and whether any long command counts, not only builds and tests), and the short line
// beside Loopy saying what finished (lib/companion/reactions.ts, lib/companion/sleepy.ts).

import {
  type CompanionSettings,
  REACTION_RANGES,
} from "../../lib/companion/settings.ts";
import { formatMinute, parseMinute } from "../../lib/companion/sleepy.ts";

export interface ReactionSettingsProps {
  settings: CompanionSettings;
  /** The companion is shown (else everything here is off). */
  shown: boolean;
  onChange(patch: Partial<CompanionSettings>): void;
}

type Flag =
  | "nightSleepy"
  | "celebrate"
  | "sad"
  | "reactAnyCommand"
  | "reactBubble";

export function ReactionSettings(props: ReactionSettingsProps) {
  const { settings, shown, onChange } = props;
  const check = (key: Flag, label: string, disabled = false) => (
    <label class="field field-check">
      <input
        type="checkbox"
        data-testid={`setting-companion-${key}`}
        checked={settings[key]}
        disabled={!shown || disabled}
        onChange={(e) =>
          onChange({ [key]: (e.target as HTMLInputElement).checked })}
      />
      <span class="field-label">{label}</span>
    </label>
  );
  const hour = (key: "nightFrom" | "nightTo", label: string) => (
    <label class="field">
      <span class="field-label">{label}</span>
      <input
        type="time"
        class="field-select"
        data-testid={`setting-companion-${key}`}
        value={formatMinute(settings[key])}
        disabled={!shown || !settings.nightSleepy}
        onChange={(e) => {
          const m = parseMinute((e.target as HTMLInputElement).value);
          if (m !== null) onChange({ [key]: m });
        }}
      />
    </label>
  );
  const jobs = settings.celebrate || settings.sad;
  return (
    <div
      class="field reaction-settings"
      data-testid="companion-reactions"
      role="group"
      aria-label="Reactions"
    >
      <span class="field-label">Reactions</span>
      {check("nightSleepy", "Sleepy at night (when the pointer rests)")}
      <div class="reaction-hours">
        {hour("nightFrom", "From")}
        {hour("nightTo", "Until")}
      </div>
      {check("celebrate", "Celebrate when a long job succeeds")}
      {check("sad", "Look sad when one fails")}
      <label class="field">
        <span class="field-label">
          Shell commands that ran at least{" "}
          <output>{settings.reactMinS} s</output>
        </span>
        <input
          type="number"
          class="field-select"
          data-testid="setting-companion-reactMinS"
          min={REACTION_RANGES.reactMinS.min}
          max={REACTION_RANGES.reactMinS.max}
          step={1}
          value={settings.reactMinS}
          disabled={!shown || !jobs}
          onChange={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v > 0) onChange({ reactMinS: v });
          }}
        />
      </label>
      {check(
        "reactAnyCommand",
        "Any long command, not only builds and tests",
        !jobs,
      )}
      {check("reactBubble", "Say what finished beside Loopy", !jobs)}
      <span class="field-hint">
        Shell tiles need the shell integration (Settings → Agent integration:
        zsh or bash), which marks where each command starts and ends; agents'
        status notes ("tests passed", "build failed") count too. Never over a
        question, thinking or a voice turn. Spoken only with the matching voice
        alert on.
      </span>
    </div>
  );
}
