// Settings → Tiles: the activity indicators an unfocused tile and its chip wear (Full, Subtle or
// Off, and which states show; lib/workspace/activity.ts), and what a tile's header is titled
// (the program's own title, or the process and folder).

import {
  ACTIVITY_INDICATORS,
  ACTIVITY_TOGGLES,
  type ActivityIndicators,
  type ActivitySettings,
  TILE_TITLES,
  type TileTitle,
} from "../lib/workspace/activity.ts";

export interface TileSettingsProps {
  activity: ActivitySettings;
  tileTitle: TileTitle;
  onActivity(patch: Partial<ActivitySettings>): void;
  onTileTitle(tileTitle: TileTitle): void;
}

const INDICATOR_LABELS: Record<ActivityIndicators, string> = {
  full: "Full",
  subtle: "Subtle",
  off: "Off",
};

const INDICATOR_HINTS: Record<ActivityIndicators, string> = {
  full:
    "Unfocused tiles tint their header, shimmer while a command runs and wear a coloured border when they need you.",
  subtle:
    "Unfocused tiles show a coloured dot in their header, and a coloured border when they need you.",
  off: "Tiles and chips show no activity.",
};

const TOGGLE_LABELS: Record<typeof ACTIVITY_TOGGLES[number], string> = {
  bell: "A bell, or an agent waiting for you",
  failed: "A command that failed",
  done: "A command that finished (a few seconds)",
  output: "New output",
};

const TITLE_LABELS: Record<TileTitle, string> = {
  program: "Program title",
  process: "Process title",
};

export function TileSettingsSection(props: TileSettingsProps) {
  const { activity } = props;
  return (
    <div class="tile-settings" data-testid="tile-settings">
      <div class="field">
        <span class="field-label">Activity indicators</span>
        <div
          class="segmented"
          role="radiogroup"
          aria-label="Activity indicators"
        >
          {ACTIVITY_INDICATORS.map((m) => (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={m === activity.indicators}
              class={m === activity.indicators ? "is-active" : ""}
              data-testid="setting-activity-indicators"
              data-value={m}
              onClick={() => props.onActivity({ indicators: m })}
            >
              {INDICATOR_LABELS[m]}
            </button>
          ))}
        </div>
        <span class="field-hint">
          {INDICATOR_HINTS[activity.indicators]}
        </span>
      </div>
      {ACTIVITY_TOGGLES.map((key) => (
        <label class="field field-check" key={key}>
          <input
            type="checkbox"
            data-testid={`setting-activity-${key}`}
            checked={activity[key]}
            disabled={activity.indicators === "off"}
            onChange={(e) =>
              props.onActivity({
                [key]: (e.target as HTMLInputElement).checked,
              })}
          />
          <span class="field-label">{TOGGLE_LABELS[key]}</span>
        </label>
      ))}
      <span class="field-hint">
        A running command shows while the main switch is on. Focusing a tile
        clears what it showed.
      </span>
      <label class="field">
        <span class="field-label">Tile title</span>
        <select
          class="field-select"
          data-testid="setting-tile-title"
          value={props.tileTitle}
          onChange={(e) =>
            props.onTileTitle(
              (e.target as HTMLSelectElement).value as TileTitle,
            )}
        >
          {TILE_TITLES.map((t) => (
            <option value={t} key={t}>{TITLE_LABELS[t]}</option>
          ))}
        </select>
        <span class="field-hint">
          {props.tileTitle === "program"
            ? "The title the program sets (a remote shell, vim, an agent), else the process and folder."
            : "The foreground process and its folder, whatever the program sets."}
        </span>
      </label>
    </div>
  );
}
