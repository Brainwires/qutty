// Settings → Ollama: whether Ollama is installed (its version) and its server runs (Open Ollama
// when the app is there), the pulled models (size, modified, capabilities, loaded now), Refresh,
// and the default harness and model the Ollama dialog starts on. The default pair is also a `+`
// picker entry, so "+ opens" (General) can name it. The facts come from app/use-ollama.ts.

import type { PtyBackend } from "../lib/pty-client.ts";
import type { OllamaTracking } from "./use-ollama.ts";
import type { OllamaSettings } from "../lib/ollama/settings.ts";
import { OllamaStatusLine } from "./ollama-dialog.tsx";

export interface OllamaSettingsProps {
  settings: OllamaSettings;
  tracking: OllamaTracking;
  backend: PtyBackend;
  onChange(patch: Partial<OllamaSettings>): void;
}

export function OllamaSettingsSection(props: OllamaSettingsProps) {
  const { settings, tracking, onChange } = props;
  const s = tracking.status;
  const running = new Map(s.running.map((r) => [r.name, r]));
  const installed = s.harnesses.filter((h) => h.installed);
  return (
    <div class="ollama-settings" data-testid="ollama-settings">
      <div class="field">
        <span class="field-label">Ollama</span>
        <span class="field-hint" data-testid="ollama-summary">
          {!tracking.loaded
            ? "Looking for Ollama…"
            : !s.installed
            ? "Not installed."
            : `${s.version ? `Version ${s.version}` : "Installed"} · ${
              s.serverUp ? "server running" : "server not running"
            } · ${s.models.length} model${s.models.length === 1 ? "" : "s"}${
              s.running.length ? ` · ${s.running.length} loaded` : ""
            }`}
        </span>
      </div>
      {tracking.loaded && (
        <OllamaStatusLine status={s} backend={props.backend} />
      )}
      {s.models.length > 0 && (
        <table class="ollama-table" data-testid="ollama-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Capabilities</th>
              <th>Loaded</th>
            </tr>
          </thead>
          <tbody>
            {s.models.map((m) => (
              <tr
                key={m.name}
                data-testid="ollama-table-row"
                data-name={m.name}
              >
                <td>{m.name}</td>
                <td>{m.size}</td>
                <td>{m.modified}</td>
                <td>
                  {m.details
                    ? m.details.capabilities.filter((c) => c !== "completion")
                      .join(", ") || "completion"
                    : "…"}
                </td>
                <td>{running.get(m.name)?.until ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tracking.changes && (
        <div class="field-hint" data-testid="ollama-changes">
          {[
            tracking.changes.added.length
              ? `added ${tracking.changes.added.join(", ")}`
              : "",
            tracking.changes.updated.length
              ? `pulled again ${tracking.changes.updated.join(", ")}`
              : "",
            tracking.changes.removed.length
              ? `removed ${tracking.changes.removed.join(", ")}`
              : "",
          ].filter(Boolean).join(" · ")}
        </div>
      )}
      <label class="field">
        <span class="field-label">Default harness</span>
        <select
          class="field-select"
          data-testid="setting-ollama-harness"
          value={settings.harness ?? ""}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            onChange({ harness: v === "" ? null : v });
          }}
        >
          <option value="">The first installed</option>
          {installed.map((h) => (
            <option value={h.name} key={h.name}>{h.label}</option>
          ))}
          {settings.harness &&
            !installed.some((h) => h.name === settings.harness) && (
            <option value={settings.harness}>
              {settings.harness} (not installed)
            </option>
          )}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Default model</span>
        <select
          class="field-select"
          data-testid="setting-ollama-model"
          value={settings.model ?? ""}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            onChange({ model: v === "" ? null : v });
          }}
        >
          <option value="">The first pulled</option>
          {s.models.map((m) => (
            <option value={m.name} key={m.name}>{m.name}</option>
          ))}
          {settings.model &&
            !s.models.some((m) => m.name === settings.model) && (
            <option value={settings.model}>
              {settings.model} (not pulled)
            </option>
          )}
        </select>
        <span class="field-hint">
          With both set, the pair is a `+` menu entry, and “+ opens” can pick
          it.
        </span>
      </label>
      <div class="sandbox-actions">
        <button
          type="button"
          class="btn-quiet"
          data-testid="ollama-refresh"
          onClick={tracking.refresh}
        >
          Refresh
        </button>
        {settings.recents.length > 0 && (
          <button
            type="button"
            class="btn-quiet"
            data-testid="ollama-clear-recents"
            onClick={() => onChange({ recents: [] })}
          >
            Forget recent pairs
          </button>
        )}
      </div>
    </div>
  );
}
