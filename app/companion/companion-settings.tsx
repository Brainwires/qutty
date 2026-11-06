// Settings → Companion: where Loopy is drawn (in the window; floating comes with Denext
// multi-window; or off, when `ask_user` questions use the ask dialog instead), its corner,
// whether its brain (headless Claude Code) may run and with which model, the brain's status, and
// "Companion activity": the companion's privileged actions from the audit log, newest first
// (the full log is companion-audit.jsonl in the app-support folder).

import { useEffect, useState } from "denext";
import {
  type AuditEntry,
  COMPANION_CORNERS,
  COMPANION_MODES,
  type CompanionMode,
  type CompanionStatus,
} from "../../lib/companion/protocol.ts";
import {
  type BrainModel,
  COMPANION_MODELS,
  type CompanionSettings,
} from "../../lib/companion/settings.ts";
import type { PtyBackend } from "../../lib/pty-client.ts";

export interface CompanionSettingsProps {
  settings: CompanionSettings;
  backend: PtyBackend | null;
  onChange(patch: Partial<CompanionSettings>): void;
}

const MODE_LABEL: Record<CompanionMode, string> = {
  window: "In window",
  floating: "Floating",
  off: "Off",
};

const MODEL_LABEL: Record<BrainModel, string> = {
  "": "Claude Code's default",
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
};

/** How many activity entries are listed. */
const ACTIVITY_ROWS = 12;

/** One line of an audit entry's arguments (`tile: pty-2, text: "ls\r"`). */
function argsLine(args: Record<string, unknown>): string {
  return Object.entries(args).map(([k, v]) =>
    `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`
  ).join(", ");
}

/** The brain's status and the activity list, followed live. */
function useCompanionInfo(backend: PtyBackend | null) {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [activity, setActivity] = useState<AuditEntry[]>([]);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    backend.companionStatus().then((s) => {
      if (!live) return;
      setStatus((now) => now ?? s.status);
      setActivity((now) => now.length > 0 ? now : s.activity);
    }, () => {});
    const off = backend.onCompanion((u) => {
      if (u.kind === "status") setStatus(u.status);
      if (u.kind === "activity") {
        setActivity((a) => [u.entry, ...a].slice(0, 50));
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [backend]);
  return { status, activity };
}

export function CompanionSettingsSection(props: CompanionSettingsProps) {
  const { settings, onChange } = props;
  const { status, activity } = useCompanionInfo(props.backend);
  const shown = settings.mode !== "off";
  return (
    <div class="companion-settings" data-testid="companion-settings">
      <div class="field">
        <span class="field-label">Companion</span>
        <div class="segmented" role="radiogroup" aria-label="Companion">
          {COMPANION_MODES.map((m) => (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={m === settings.mode}
              class={m === settings.mode ? "is-active" : ""}
              data-testid="setting-companion-mode"
              data-value={m}
              disabled={m === "floating"}
              title={m === "floating"
                ? "Later: a window of its own, once Denext has multi-window"
                : undefined}
              onClick={() => onChange({ mode: m })}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <span class="field-hint">
          {shown
            ? "Loopy sits in a corner of the window: agents' questions, qutty-hook say, and a chat with its brain (click Loopy)."
            : "Off: agents' questions open a card instead, and the brain does not run."}
        </span>
      </div>
      <label class="field">
        <span class="field-label">Corner</span>
        <select
          class="field-select"
          data-testid="setting-companion-corner"
          value={settings.corner}
          disabled={!shown}
          onChange={(e) =>
            onChange({
              corner: (e.target as HTMLSelectElement)
                .value as CompanionSettings["corner"],
            })}
        >
          {COMPANION_CORNERS.map((c) => (
            <option value={c} key={c}>{c.replace("-", " ")}</option>
          ))}
        </select>
      </label>
      <label class="field field-check">
        <input
          type="checkbox"
          data-testid="setting-companion-brain"
          checked={settings.brain}
          disabled={!shown}
          onChange={(e) =>
            onChange({ brain: (e.target as HTMLInputElement).checked })}
        />
        <span class="field-label">Brain (Claude Code, your own login)</span>
      </label>
      <label class="field">
        <span class="field-label">Model</span>
        <select
          class="field-select"
          data-testid="setting-companion-model"
          value={settings.model}
          disabled={!shown || !settings.brain}
          onChange={(e) =>
            onChange({
              model: (e.target as HTMLSelectElement).value as BrainModel,
            })}
        >
          {COMPANION_MODELS.map((m) => (
            <option value={m} key={m || "default"}>{MODEL_LABEL[m]}</option>
          ))}
        </select>
        <span class="field-hint" data-testid="companion-brain-status">
          {status
            ? `${status.adapter}: ${status.enabled ? status.state : "off"}${
              status.detail ? ` (${status.detail})` : ""
            }`
            : "Status unknown"}. It starts on first use and acts on tiles
          through the agent hub.
        </span>
      </label>
      <div class="field">
        <span class="field-label">Companion activity</span>
        {activity.length === 0
          ? <span class="field-hint">Nothing yet.</span>
          : (
            <ol class="companion-activity" data-testid="companion-activity">
              {activity.slice(0, ACTIVITY_ROWS).map((e, i) => (
                <li
                  key={`${e.at}-${i}`}
                  data-testid="companion-activity-row"
                  data-ok={String(e.ok)}
                  title={e.error ?? ""}
                >
                  <time>{new Date(e.at).toLocaleTimeString()}</time>
                  <b>{e.tool}</b>
                  <span>
                    {e.by === "companion" ? "" : `by ${e.by} `}
                    {argsLine(e.args)}
                  </span>
                  {!e.ok && <em>{e.error ?? "failed"}</em>}
                </li>
              ))}
            </ol>
          )}
      </div>
    </div>
  );
}
