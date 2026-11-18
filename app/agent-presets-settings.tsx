// Settings → Agents → Presets: the agent tile roles the `+` menu offers under each backend's
// "(chat)" item (lib/agent/presets.ts). A list (pick one to edit it, Add, Delete) and a small
// editor: the name, the backend (Claude Code, Codex, Ollama, Anthropic API), the model (the
// backend's aliases, or a name typed for Codex and Ollama, whose lists come from them), the
// permission mode, the tools allowed without asking, and a system prompt added to
// the harness's own. Text is saved when its field is left; choices right away. A tile copies its
// preset when it opens, so editing one changes the next tiles, not the open ones.

import { useRef, useState } from "denext";
import {
  AGENT_KINDS,
  type AgentKind,
  agentLabel,
  PERMISSION_MODES,
  type PermissionMode,
} from "../lib/agent/adapter.ts";
import {
  type AgentPreset,
  MAX_PRESET_NAME,
  MAX_PRESETS,
  MAX_SYSTEM_PROMPT,
  nextPresetId,
  parseToolList,
} from "../lib/agent/presets.ts";
import { agentModels, MODE_LABELS, modeHint } from "../lib/agent/tile.ts";

export function AgentPresetsSection(
  props: {
    presets: readonly AgentPreset[];
    onChange(presets: AgentPreset[]): void;
  },
) {
  const { presets } = props;
  const [selected, setSelected] = useState<string | null>(
    presets[0]?.id ?? null,
  );
  /** Text being typed (saved when its field is left): `field` → value. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const current = presets.find((p) => p.id === selected) ?? presets[0];
  // Claude Code's and the API's models are known here; Codex and Ollama list theirs at run time.
  const listsModels = !current?.agent || current.agent === "anthropic";
  const models = agentModels(current?.agent);

  // The list as last changed here: two fields saved in one go (a blur, then a pick) build on
  // each other, not on the props of the last render.
  const latest = useRef(presets);
  latest.current = presets;
  const change = (next: AgentPreset[]) => {
    latest.current = next;
    props.onChange(next);
  };

  const update = (patch: Partial<AgentPreset>) => {
    if (!current) return;
    change(
      latest.current.map((p) => {
        if (p.id !== current.id) return p;
        const next: AgentPreset = { ...p, ...patch };
        // An emptied field goes (the default).
        for (const k of Object.keys(patch) as (keyof AgentPreset)[]) {
          const v = next[k];
          if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) {
            delete next[k];
          }
        }
        return next;
      }),
    );
  };
  /** Save a text field from its value as it is (the draft may not have re-rendered yet). */
  const commit = (
    field: "name" | "model" | "systemPrompt" | "tools",
    value: string,
  ) => {
    setDraft(({ [field]: _gone, ...rest }) => rest);
    if (field === "model") update({ model: value.trim() });
    else if (field === "name") {
      if (value.trim()) update({ name: value.trim() });
    } else if (field === "systemPrompt") update({ systemPrompt: value.trim() });
    else update({ allowedTools: parseToolList(value) });
  };
  const add = () => {
    const id = nextPresetId(presets);
    change([
      ...latest.current,
      { id, name: `Preset ${presets.length + 1}` },
    ]);
    setSelected(id);
    setDraft({});
  };
  const remove = () => {
    if (!current) return;
    const rest = latest.current.filter((p) => p.id !== current.id);
    change(rest);
    setSelected(rest[0]?.id ?? null);
    setDraft({});
  };

  return (
    <div class="agent-presets" data-testid="agent-presets">
      <div class="field">
        <span class="field-label">Presets</span>
        <div class="agent-preset-list" role="listbox" aria-label="Presets">
          {presets.map((p) => (
            <button
              type="button"
              role="option"
              aria-selected={p.id === current?.id}
              class={`agent-preset-item${
                p.id === current?.id ? " is-active" : ""
              }`}
              data-testid="agent-preset-item"
              data-id={p.id}
              key={p.id}
              onClick={() => {
                setSelected(p.id);
                setDraft({});
              }}
            >
              {p.name}
            </button>
          ))}
          <button
            type="button"
            class="btn-quiet"
            data-testid="agent-preset-add"
            disabled={presets.length >= MAX_PRESETS}
            onClick={add}
          >
            + Add
          </button>
        </div>
        <span class="field-hint">
          Roles for agent tiles: each shows in the <code>+</code>{" "}
          menu under its agent's "(chat)" item. An open tile keeps what it
          started with.
        </span>
      </div>
      {current && (
        <div class="agent-preset-editor" data-testid="agent-preset-editor">
          <label class="field">
            <span class="field-label">Name</span>
            <input
              type="text"
              class="font-custom"
              data-testid="agent-preset-name"
              maxLength={MAX_PRESET_NAME}
              spellcheck={false}
              value={draft.name ?? current.name}
              onInput={(e) =>
                setDraft({
                  ...draft,
                  name: (e.target as HTMLInputElement).value,
                })}
              onBlur={(e) =>
                commit("name", (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
          <label class="field">
            <span class="field-label">Agent</span>
            <select
              class="field-select"
              data-testid="agent-preset-agent"
              value={current.agent ?? "claude"}
              onChange={(e) => {
                const agent = (e.target as HTMLSelectElement)
                  .value as AgentKind;
                // Another backend's models are not this one's.
                update({
                  agent: agent === "claude" ? undefined : agent,
                  model: undefined,
                });
              }}
            >
              {AGENT_KINDS.map((k) => (
                <option value={k} key={k}>{agentLabel(k)}</option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Model</span>
            {listsModels
              ? (
                <select
                  class="field-select"
                  data-testid="agent-preset-model"
                  value={current.model ?? ""}
                  onChange={(e) =>
                    update({ model: (e.target as HTMLSelectElement).value })}
                >
                  {models.map((m) => (
                    <option value={m.id} key={m.id || "default"}>
                      {m.label}
                    </option>
                  ))}
                  {current.model &&
                    !models.some((m) => m.id === current.model) && (
                    <option value={current.model}>{current.model}</option>
                  )}
                </select>
              )
              : (
                <input
                  type="text"
                  class="font-custom"
                  data-testid="agent-preset-model"
                  spellcheck={false}
                  autocomplete="off"
                  placeholder="default"
                  value={draft.model ?? current.model ?? ""}
                  onInput={(e) =>
                    setDraft({
                      ...draft,
                      model: (e.target as HTMLInputElement).value,
                    })}
                  onBlur={(e) =>
                    commit("model", (e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                />
              )}
          </label>
          <label class="field">
            <span class="field-label">Permission mode</span>
            <select
              class="field-select"
              data-testid="agent-preset-mode"
              value={current.mode ?? "default"}
              onChange={(e) =>
                update({
                  mode: (e.target as HTMLSelectElement).value as PermissionMode,
                })}
            >
              {PERMISSION_MODES.map((m) => (
                <option value={m} key={m}>
                  {MODE_LABELS[m]} — {modeHint(m, current.agent)}
                </option>
              ))}
            </select>
          </label>
          {current.agent === "codex"
            ? (
              <span class="field-hint" data-testid="agent-preset-codex-note">
                Codex runs with its own instructions and approvals: a preset
                picks its model and permission mode.
              </span>
            )
            : (
              <>
                <label class="field">
                  <span class="field-label">Allowed tools</span>
                  <input
                    type="text"
                    class="font-custom"
                    data-testid="agent-preset-tools"
                    spellcheck={false}
                    autocomplete="off"
                    placeholder="Read, Grep, Bash(git diff:*)"
                    value={draft.tools ??
                      (current.allowedTools ?? []).join(", ")}
                    onInput={(e) =>
                      setDraft({
                        ...draft,
                        tools: (e.target as HTMLInputElement).value,
                      })}
                    onBlur={(e) =>
                      commit("tools", (e.target as HTMLInputElement).value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <span class="field-hint">
                    Run without asking (Claude Code's{" "}
                    <code>--allowedTools</code>{" "}
                    patterns; Ollama and the API take plain tool names). Empty:
                    ask as the mode says.
                  </span>
                </label>
                <label class="field">
                  <span class="field-label">System prompt</span>
                  <textarea
                    class="agent-preset-prompt"
                    data-testid="agent-preset-prompt"
                    rows={5}
                    maxLength={MAX_SYSTEM_PROMPT}
                    placeholder="You review code: read, comment, never edit."
                    value={draft.systemPrompt ?? current.systemPrompt ?? ""}
                    onInput={(e) =>
                      setDraft({
                        ...draft,
                        systemPrompt: (e.target as HTMLTextAreaElement).value,
                      })}
                    onBlur={(e) =>
                      commit(
                        "systemPrompt",
                        (e.target as HTMLTextAreaElement).value,
                      )}
                  />
                  <span class="field-hint">
                    Added to the agent's own system prompt.
                  </span>
                </label>
              </>
            )}
          <div class="agent-preset-actions">
            <button
              type="button"
              class="btn-quiet is-danger"
              data-testid="agent-preset-delete"
              onClick={remove}
            >
              Delete preset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
