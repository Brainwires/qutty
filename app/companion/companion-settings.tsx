// Settings → Companion: where Loopy is drawn (in the window; floating comes with Denext
// multi-window; or off, when `ask_user` questions use the ask dialog instead), its corner, whether
// it is lively (idle expressions, eyes that follow the pointer), its reactions (sleepy at night,
// celebrate and sad over finished jobs: app/companion/reaction-settings.tsx), whether its brain may run, which
// brain (headless Claude Code with its model, a local Ollama model that can call tools, from the
// Ollama helper's tracked models, or Anthropic's API with the user's key, which the hub keeps in
// the OS keychain: app/companion/api-key-field.tsx) and the brain's status, and "Companion
// activity": the
// companion's privileged actions from the audit log, newest first (the full log is
// companion-audit.jsonl in the app-support folder).

import { useEffect, useState } from "denext";
import {
  type AuditEntry,
  COMPANION_CORNERS,
  COMPANION_MODES,
  type CompanionMode,
  type CompanionStatus,
} from "../../lib/companion/protocol.ts";
import {
  BRAIN_ENGINES,
  type BrainEngine,
  type BrainModel,
  COMPANION_MODELS,
  type CompanionSettings,
} from "../../lib/companion/settings.ts";
import { ANTHROPIC_MODELS } from "../../lib/companion/anthropic-provider.ts";
import { hasTools, type OllamaStatus } from "../../lib/ollama/cli.ts";
import type { PtyBackend } from "../../lib/pty-client.ts";
import { detectPlatform } from "../../lib/workspace/keys.ts";
import { ReactionSettings } from "./reaction-settings.tsx";
import { ApiKeyField } from "./api-key-field.tsx";

export interface CompanionSettingsProps {
  settings: CompanionSettings;
  backend: PtyBackend | null;
  /** The Ollama helper's status (its pulled models), when Ollama is installed. */
  ollama?: OllamaStatus;
  onChange(patch: Partial<CompanionSettings>): void;
}

const ENGINE_LABEL: Record<BrainEngine, string> = {
  claude: "Claude Code",
  ollama: "Ollama",
  anthropic: "API key",
};

const ENGINE_HINT: Record<BrainEngine, string> = {
  claude: "Headless Claude Code with your own login.",
  ollama:
    "A local Ollama model on this computer; it calls the hub's tools itself.",
  anthropic:
    "Anthropic's API with your own API key: what you ask Loopy, and what its tools read from your tiles, is sent to api.anthropic.com and billed to that key.",
};

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

/** The API key brain's models, by their API id. */
function apiModelLabel(m: BrainModel): string {
  const id = ANTHROPIC_MODELS[m];
  return m ? id : `${id} (default)`;
}

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
          data-testid="setting-companion-lively"
          checked={settings.lively}
          disabled={!shown}
          onChange={(e) =>
            onChange({ lively: (e.target as HTMLInputElement).checked })}
        />
        <span class="field-label">
          Lively (idle expressions and eyes follow the pointer)
        </span>
      </label>
      <ReactionSettings settings={settings} shown={shown} onChange={onChange} />
      <label class="field field-check">
        <input
          type="checkbox"
          data-testid="setting-companion-brain"
          checked={settings.brain}
          disabled={!shown}
          onChange={(e) =>
            onChange({ brain: (e.target as HTMLInputElement).checked })}
        />
        <span class="field-label">Brain</span>
      </label>
      <BrainChoice
        settings={settings}
        backend={props.backend}
        disabled={!shown || !settings.brain}
        {...(props.ollama ? { ollama: props.ollama } : {})}
        onChange={onChange}
      />
      <span class="field-hint" data-testid="companion-brain-status">
        {status
          ? `${status.adapter}: ${status.enabled ? status.state : "off"}${
            status.detail ? ` (${status.detail})` : ""
          }`
          : "Status unknown"}. It starts on first use and acts on tiles through
        the agent hub.
      </span>
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

/** The API key brain's Anthropic key: kept by the hub in the OS keychain. */
function AnthropicKey(props: { backend: PtyBackend }) {
  const { backend } = props;
  return (
    <ApiKeyField
      name="Anthropic"
      testid="companion-key-anthropic"
      has={async () => (await backend.companionKeyStatus()).anthropic}
      save={(key) => backend.companionKeySet(key)}
      remove={() => backend.companionKeyClear()}
      demo={backend.kind !== "desktop"}
      platform={detectPlatform()}
    />
  );
}

/** The brain (Claude Code with its model, an Ollama model that can call tools, or the API). */
function BrainChoice(props: {
  settings: CompanionSettings;
  backend: PtyBackend | null;
  disabled: boolean;
  ollama?: OllamaStatus;
  onChange(patch: Partial<CompanionSettings>): void;
}) {
  const { settings, disabled, onChange } = props;
  const toolModels = (props.ollama?.models ?? []).filter((m) =>
    hasTools(m) === true
  );
  // A saved model that is gone (or not read yet) stays listed, so the choice is not lost.
  const listed = toolModels.map((m) => m.name);
  if (settings.ollamaModel && !listed.includes(settings.ollamaModel)) {
    listed.push(settings.ollamaModel);
  }
  return (
    <>
      <div class="field">
        <span class="field-label">Brain runs on</span>
        <div class="segmented" role="radiogroup" aria-label="Brain runs on">
          {BRAIN_ENGINES.map((e) => (
            <button
              type="button"
              key={e}
              role="radio"
              aria-checked={e === settings.engine}
              class={e === settings.engine ? "is-active" : ""}
              data-testid="setting-companion-engine"
              data-value={e}
              disabled={disabled}
              onClick={() =>
                onChange(
                  e === "ollama" && !settings.ollamaModel && toolModels[0]
                    ? { engine: e, ollamaModel: toolModels[0].name }
                    : { engine: e },
                )}
            >
              {ENGINE_LABEL[e]}
            </button>
          ))}
        </div>
        <span class="field-hint" data-testid="companion-engine-hint">
          {ENGINE_HINT[settings.engine]}
        </span>
      </div>
      {settings.engine === "anthropic" && props.backend && (
        <AnthropicKey backend={props.backend} />
      )}
      {settings.engine !== "ollama"
        ? (
          <label class="field">
            <span class="field-label">Model</span>
            <select
              class="field-select"
              data-testid="setting-companion-model"
              value={settings.model}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  model: (e.target as HTMLSelectElement).value as BrainModel,
                })}
            >
              {COMPANION_MODELS.map((m) => (
                <option value={m} key={m || "default"}>
                  {settings.engine === "anthropic"
                    ? apiModelLabel(m)
                    : MODEL_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        )
        : (
          <label class="field">
            <span class="field-label">Ollama model</span>
            <select
              class="field-select"
              data-testid="setting-companion-ollama-model"
              value={settings.ollamaModel}
              disabled={disabled || listed.length === 0}
              onChange={(e) =>
                onChange({
                  ollamaModel: (e.target as HTMLSelectElement).value,
                })}
            >
              {!settings.ollamaModel && (
                <option value="">
                  Choose a model
                </option>
              )}
              {listed.map((m) => <option value={m} key={m}>{m}</option>)}
            </select>
            <span class="field-hint" data-testid="companion-ollama-hint">
              {!props.ollama?.installed
                ? "Ollama is not installed (Settings → Ollama)."
                : !props.ollama.serverUp
                ? "The Ollama server is not running."
                : toolModels.length === 0
                ? "No pulled model can call tools (the Ollama library's Tools filter lists some)."
                : "Only the pulled models that can call tools are listed."}
            </span>
          </label>
        )}
    </>
  );
}
