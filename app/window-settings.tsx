// Settings → Windows: what a window's close button does (app/use-window-close.ts). The close
// question's "Remember my choice" saves to the same setting, so this is where it is changed back.
// Also "Keep shells running after quitting" (the PTY daemon, desktop/kept-shells.ts).

import { useEffect, useState } from "denext";
import {
  WINDOW_CLOSE_CHOICES,
  type WindowClose,
} from "../lib/workspace/windows.ts";
import { getPtyBackend } from "../lib/pty-client.ts";

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
        <span class="field-hint">{HINTS[props.windowClose]}</span>
      </label>
      <KeepShellsField />
    </div>
  );
}

/**
 * "Keep shells running after quitting": an app-wide setting the app process keeps
 * (desktop/kept-shells.ts), read and changed here directly.
 */
function KeepShellsField() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getPtyBackend().session.keepShells().then(
      (v) => live && setOn(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  if (on === null) return null;
  return (
    <label class="field field-check">
      <input
        type="checkbox"
        data-testid="setting-keep-shells"
        checked={on}
        onChange={(e) => {
          const want = (e.target as HTMLInputElement).checked;
          setOn(want);
          void getPtyBackend().session.setKeepShells(want).then(
            setOn,
            () => setOn(!want),
          );
        }}
      />
      <span class="field-label">Keep shells running after quitting</span>
      <span class="field-hint">
        {on
          ? "Quitting asks whether to keep the shells running; kept shells come back as they were at the next launch. Applies to shells started from now on."
          : "Quitting ends every shell."}
      </span>
    </label>
  );
}
