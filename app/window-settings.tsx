// Settings → Windows: what a window's close button does (app/use-window-close.ts). The close
// question's "Remember my choice" saves to the same setting, so this is where it is changed back.

import {
  WINDOW_CLOSE_CHOICES,
  type WindowClose,
} from "../lib/workspace/windows.ts";

export interface WindowSettingsProps {
  windowClose: WindowClose;
  onChange(windowClose: WindowClose): void;
}

const LABELS: Record<WindowClose, string> = {
  ask: "Ask each time",
  keep: "Keep shells running",
  end: "End shells",
};

const HINTS: Record<WindowClose, string> = {
  ask: "The window asks whether to keep its shells running or end them.",
  keep:
    "The window closes and its shells keep running: Window → Reopen Closed Window or the menu-bar / tray icon brings them back.",
  end:
    "The window closes and its shells end (an agent still working is asked about first).",
};

export function WindowSettingsSection(props: WindowSettingsProps) {
  return (
    <div class="window-settings" data-testid="window-settings">
      <label class="field">
        <span class="field-label">When a window closes</span>
        <select
          class="field-select"
          data-testid="setting-window-close"
          value={props.windowClose}
          onChange={(e) =>
            props.onChange(
              (e.target as HTMLSelectElement).value as WindowClose,
            )}
        >
          {WINDOW_CLOSE_CHOICES.map((c) => (
            <option value={c} key={c}>{LABELS[c]}</option>
          ))}
        </select>
        <span class="field-hint">
          {HINTS[props.windowClose]} Quitting ends every shell either way.
        </span>
      </label>
    </div>
  );
}
