// Settings → Companion: its name (in the chat box, its labels, its brain's system prompt and the
// voice summary's address), where the companion is drawn (in the window; floating, in a
// transparent window of its own on top of the others, grayed out with the reason where the system
// cannot float it, with whether that window shows on every Space; or off, when `ask_user`
// questions use the ask dialog instead), its corner in the window,
// whether it is lively (idle expressions, eyes that follow the pointer), its reactions (sleepy at
// night, celebrate and sad over finished jobs: app/companion/reaction-settings.tsx), whether its
// brain may run, which brain (headless Claude Code with its model, a local Ollama model that can
// call tools, from the Ollama helper's tracked models, or Anthropic's API with the user's key,
// which the hub keeps in the OS keychain: app/companion/api-key-field.tsx) and the brain's status,
// and "Companion activity": the companion's privileged actions from the audit log, newest first
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
  BRAIN_ENGINES,
  type BrainEngine,
  type BrainModel,
  COMPANION_MODELS,
  COMPANION_NAME_MAX,
  companionName,
  type CompanionSettings,
  DEFAULT_COMPANION_NAME,
} from "../../lib/companion/settings.ts";
import { ANTHROPIC_MODELS } from "../../lib/companion/anthropic-provider.ts";
import { hasTools, type OllamaStatus } from "../../lib/ollama/cli.ts";
import type { PtyBackend } from "../../lib/pty-client.ts";
import { detectPlatform } from "../../lib/workspace/keys.ts";
import { ReactionSettings } from "./reaction-settings.tsx";
import { MessageSettings } from "./message-settings.tsx";
import { ApiKeyField } from "./api-key-field.tsx";
import { SettingsGroup, SettingsLink } from "../settings-ui.tsx";
import type { FloatingSupport } from "../../lib/companion/floating.ts";

export interface CompanionSettingsProps {
  settings: CompanionSettings;
  backend: PtyBackend | null;
  /** The Ollama helper's status (its pulled models), when Ollama is installed. */
  ollama?: OllamaStatus;
  /** Whether the companion can float here, and why not (absent: not known yet). */
  floating?: FloatingSupport;
  /** Settings → Voice → Voice mode, offered here too. */
  voiceMode?: boolean;
  onVoiceMode?(on: boolean): void;
  onChange(patch: Partial<CompanionSettings>): void;
}

/** What Settings says of where the companion is, for `mode`. */
function modeHint(
  settings: CompanionSettings,
  floating: FloatingSupport | undefined,
): string {
  const name = settings.name;
  if (settings.mode === "off") {
    return "Off: agents' questions open a card instead, and the brain does not run.";
  }
  if (settings.mode === "floating" && floating?.ok) {
    return `${name} floats in a window of its own, above the others, wherever you put it (drag ${name}): the questions and messages of every workspace, and a chat with its brain (click ${name}). Clicks pass through around it.`;
  }
  const fallback = settings.mode === "floating" && floating && !floating.ok
    ? `${floating.reason} `
    : "";
  return `${fallback}${name} sits in a corner of the window: agents' questions, qutty-hook say, and a chat with its brain (click ${name}).`;
}

const ENGINE_LABEL: Record<BrainEngine, string> = {
  claude: "Claude Code",
  ollama: "Ollama",
  anthropic: "API key",
};

/** What each brain is, for the companion called `name`. */
function engineHint(engine: BrainEngine, name: string): string {
  switch (engine) {
    case "claude":
      return "Headless Claude Code with your own login.";
    case "ollama":
      return "A local Ollama model on this computer; it calls the hub's tools itself.";
    case "anthropic":
      return `Anthropic's API with your own API key: what you ask ${name}, and what its tools read from your tiles, is sent to api.anthropic.com and billed to that key.`;
  }
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
  const floats = settings.mode === "floating" && props.floating?.ok === true;
  const floatOff = props.floating && !props.floating.ok
    ? props.floating.reason
    : undefined;
  return (
    <div class="companion-settings" data-testid="companion-settings">
      <SettingsGroup title="Companion" testid="companion-section">
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
                disabled={m === "floating" && floatOff !== undefined &&
                  settings.mode !== "floating"}
                title={m === "floating" ? floatOff : undefined}
                onClick={() => onChange({ mode: m })}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <span class="field-hint" data-testid="companion-mode-hint">
            {modeHint(settings, props.floating)}
          </span>
        </div>
        <NameField
          name={settings.name}
          onChange={(name) => onChange({ name })}
        />
        <label class="field">
          <span class="field-label">Corner</span>
          <select
            class="field-select"
            data-testid="setting-companion-corner"
            value={settings.corner}
            disabled={!shown || floats}
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
            data-testid="setting-companion-all-spaces"
            checked={settings.floatAllSpaces}
            disabled={!floats}
            onChange={(e) =>
              onChange({
                floatAllSpaces: (e.target as HTMLInputElement).checked,
              })}
          />
          <span class="field-label">
            Floating: on every Space (every virtual desktop)
          </span>
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
      </SettingsGroup>
      <SettingsGroup title="Reactions">
        <ReactionSettings
          settings={settings}
          shown={shown}
          onChange={onChange}
        />
      </SettingsGroup>
      <SettingsGroup title="Messages">
        <MessageSettings
          settings={settings}
          shown={shown}
          {...(props.onVoiceMode
            ? {
              voiceMode: props.voiceMode === true,
              onVoiceMode: props.onVoiceMode,
            }
            : {})}
          onChange={onChange}
        />
      </SettingsGroup>
      <SettingsGroup title="Brain">
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
            : "Status unknown"}. It starts on first use and acts on tiles
          through the agent hub.
        </span>
      </SettingsGroup>
      <SettingsGroup title="Activity">
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
      </SettingsGroup>
    </div>
  );
}

/**
 * The companion's name. Edited as a draft and saved when the field is left or Enter is pressed
 * (saving sanitizes it: emptied, it is Companion again), so a name being typed is not trimmed or
 * reset under the cursor.
 */
function NameField(props: { name: string; onChange(name: string): void }) {
  const [draft, setDraft] = useState(props.name);
  useEffect(() => setDraft(props.name), [props.name]);
  const save = () => {
    const name = companionName(draft);
    setDraft(name);
    if (name !== props.name) props.onChange(name);
  };
  return (
    <label class="field">
      <span class="field-label">Name</span>
      <input
        type="text"
        class="font-custom"
        data-testid="setting-companion-name"
        placeholder={DEFAULT_COMPANION_NAME}
        value={draft}
        maxLength={COMPANION_NAME_MAX}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
      <span class="field-hint">
        What it is called in the chat box, its labels and its brain's
        instructions; say it to ask for the summary ("{props.name}, what's going
        on?"). Empty: {DEFAULT_COMPANION_NAME}.
      </span>
    </label>
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
          {engineHint(settings.engine, settings.name)}
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
                ? (
                  <>
                    Ollama is not installed (<SettingsLink
                      tab="agents"
                      target="ollama-settings"
                    >
                      Settings → Agents → Ollama
                    </SettingsLink>).
                  </>
                )
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
