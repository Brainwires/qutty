// Settings → Sandbox: one shared Docker container for the window (Off / Shared container), its
// image, the project folder it sees (read/write or read-only), network, keep running after the
// window closes, whether new tiles open in it, the opt-in host agent configs, and a status line
// (image, uptime, Restart, Stop, Reset volume). The option is disabled with the reason when
// Docker is not installed or not running. The lifecycle runs in desktop/sandbox.ts.
//
// `useSandboxSettings` sends the settings to the backend whenever they change.

import { useEffect, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import {
  SANDBOX_MODES,
  type SandboxMode,
  type SandboxSettings,
} from "../lib/sandbox/settings.ts";
import type { SandboxStatus } from "../lib/sandbox/lifecycle.ts";
import type { SandboxAction } from "../lib/sandbox/demo.ts";
import { HOST_CONFIG_DIR } from "../lib/sandbox/docker.ts";

/** Keep the backend's copy of this window's sandbox settings current. */
export function useSandboxSettings(
  backend: PtyBackend | null,
  settings: SandboxSettings,
): void {
  const key = JSON.stringify(settings);
  useEffect(() => {
    if (!backend) return;
    void backend.sandboxConfigure(settings).catch(() => {});
  }, [backend, key]);
}

/** How often the status line is refreshed while shown. */
const POLL_MS = 2000;

/** `3 h 12 min`, `4 min`, `12 s`. */
function uptimeLabel(startedAt: string, now: number): string {
  const ms = now - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const MODE_LABEL: Record<SandboxMode, string> = {
  off: "Off",
  shared: "Shared container",
};

const PHASE_LABEL: Record<SandboxStatus["phase"], string> = {
  off: "Off",
  unavailable: "Unavailable",
  stopped: "Not running (starts with the first sandboxed tile)",
  starting: "Starting",
  running: "Running",
  error: "Failed",
};

function useSandboxStatus(backend: PtyBackend | null, settingsKey: string) {
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const read = () =>
      backend.sandboxStatus().then((s) => live && setStatus(s), () => {});
    void backend.sandboxCheck().then((s) => live && setStatus(s), () => {});
    const timer = setInterval(() => {
      setNow(Date.now());
      void read();
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [backend]);
  // A settings change: read the status again once the workspace has sent them (its effect runs
  // after this child's).
  useEffect(() => {
    if (!backend) return;
    let live = true;
    const t = setTimeout(() => {
      void backend.sandboxStatus().then((s) => live && setStatus(s), () => {});
    }, 50);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [backend, settingsKey]);
  return { status, setStatus, now };
}

export interface SandboxSettingsProps {
  settings: SandboxSettings;
  backend: PtyBackend | null;
  onChange(patch: Partial<SandboxSettings>): void;
}

export function SandboxSettingsSection(props: SandboxSettingsProps) {
  const { settings, onChange, backend } = props;
  const { status, setStatus, now } = useSandboxStatus(
    backend,
    JSON.stringify(settings),
  );
  const [busy, setBusy] = useState(false);
  // The text fields as typed (the store keeps the checked form).
  const [image, setImage] = useState(settings.image);
  const [project, setProject] = useState(settings.project);
  const unavailable = status?.phase === "unavailable";
  const on = settings.mode === "shared";

  const act = (action: SandboxAction) => {
    if (!backend) return;
    setBusy(true);
    backend.sandboxAction(action).then(setStatus, () => {}).finally(() =>
      setBusy(false)
    );
  };

  const check = (
    key:
      | "projectWritable"
      | "network"
      | "keepRunning"
      | "newTilesInSandbox"
      | "hostAgentConfigs",
    label: string,
  ) => (
    <label class="field field-check">
      <input
        type="checkbox"
        data-testid={`setting-sandbox-${key}`}
        checked={settings[key]}
        disabled={!on}
        onChange={(e) =>
          onChange({ [key]: (e.target as HTMLInputElement).checked })}
      />
      <span class="field-label">{label}</span>
    </label>
  );

  return (
    <div class="sandbox-settings" data-testid="sandbox-settings">
      <div class="field">
        <span class="field-label">Sandbox</span>
        <div class="segmented" role="radiogroup" aria-label="Sandbox">
          {SANDBOX_MODES.map((m) => (
            <button
              type="button"
              key={m}
              role="radio"
              aria-checked={m === settings.mode}
              class={m === settings.mode ? "is-active" : ""}
              data-testid="setting-sandbox-mode"
              data-value={m}
              disabled={m === "shared" && unavailable && !on}
              onClick={() => onChange({ mode: m })}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <span class="field-hint">
          {unavailable
            ? status?.message
            : on
            ? "One Docker container for the window: sandboxed tiles share its files, processes and tools, and agents in it reach the hub."
            : "Tiles run on this Mac. Shared container runs sandboxed tiles in one Docker container."}
        </span>
      </div>
      <label class="field">
        <span class="field-label">Image</span>
        <input
          class="field-select field-text"
          data-testid="setting-sandbox-image"
          value={image}
          disabled={!on}
          spellcheck={false}
          onInput={(e) => setImage((e.target as HTMLInputElement).value)}
          onChange={(e) =>
            onChange({ image: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="field">
        <span class="field-label">Project folder</span>
        <input
          class="field-select field-text"
          data-testid="setting-sandbox-project"
          value={project}
          placeholder="/Users/you/src/project"
          disabled={!on}
          spellcheck={false}
          onInput={(e) => setProject((e.target as HTMLInputElement).value)}
          onChange={(e) =>
            onChange({ project: (e.target as HTMLInputElement).value })}
        />
        <span class="field-hint">
          Mounted at the same path inside; empty for none.
        </span>
      </label>
      {check("projectWritable", "The sandbox may change the project folder")}
      {check("network", "Network (off also cuts agents off from the hub)")}
      {check("newTilesInSandbox", "New tiles open in the sandbox")}
      {check("keepRunning", "Keep running when the window closes")}
      {check(
        "hostAgentConfigs",
        `Mount ~/.claude and ~/.codex read-only at ${HOST_CONFIG_DIR}`,
      )}
      {on && status && (
        <div
          class="sandbox-status"
          data-testid="sandbox-status"
          data-phase={status.phase}
        >
          <div class="sandbox-status-line">
            <span class="sandbox-dot" aria-hidden="true" />
            <span data-testid="sandbox-phase">
              {PHASE_LABEL[status.phase]}
              {status.phase === "running" && status.startedAt
                ? ` · ${uptimeLabel(status.startedAt, now)}`
                : ""}
            </span>
          </div>
          <div class="field-hint" data-testid="sandbox-detail">
            {status.container} · {status.image}
            {status.message && status.phase !== "running"
              ? ` · ${status.message}`
              : ""}
            {status.stale ? " · settings changed: Restart applies them" : ""}
          </div>
          <div class="sandbox-actions">
            <button
              type="button"
              class="btn-quiet"
              data-testid="sandbox-restart"
              disabled={busy || unavailable}
              onClick={() => act("restart")}
            >
              {status.phase === "running" ? "Restart" : "Start"}
            </button>
            <button
              type="button"
              class="btn-quiet"
              data-testid="sandbox-stop"
              disabled={busy || status.phase !== "running"}
              onClick={() => act("stop")}
            >
              Stop
            </button>
            <button
              type="button"
              class="btn-quiet"
              data-testid="sandbox-reset"
              disabled={busy || unavailable}
              title="Remove the container and its home volume (logins and tools installed in the sandbox home)"
              onClick={() => act("resetVolume")}
            >
              Reset volume
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
