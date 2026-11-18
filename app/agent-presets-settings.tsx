// Settings → Agents → Presets: the agent tile roles the `+` menu offers under "Claude Code (chat)"
// (lib/agent/presets.ts). A list (pick one to edit it, Add, Delete) and a small editor: the name,
// the model, the permission mode, the tools allowed without asking, and a system prompt added to
// the harness's own. Text is saved when its field is left; choices right away. A tile copies its
// preset when it opens, so editing one changes the next tiles, not the open ones.

import { useRef, useState } from "denext";
import { PERMISSION_MODES, type PermissionMode } from "../lib/agent/adapter.ts";
import {
  type AgentPreset,
  MAX_PRESET_NAME,
  MAX_PRESETS,
  MAX_SYSTEM_PROMPT,
  nextPresetId,
  parseToolList,
} from "../lib/agent/presets.ts";
import { AGENT_MODELS, MODE_HINTS, MODE_LABELS } from "../lib/agent/tile.ts";

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
  const commit = (field: "name" | "systemPrompt" | "tools", value: string) => {
    setDraft(({ [field]: _gone, ...rest }) => rest);
    if (field === "name") {
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
          menu under "Claude Code (chat)". An open tile keeps what it started
          with.
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
            <span class="field-label">Model</span>
            <select
              class="field-select"
              data-testid="agent-preset-model"
              value={current.model ?? ""}
              onChange={(e) =>
                update({ model: (e.target as HTMLSelectElement).value })}
            >
              {AGENT_MODELS.map((m) => (
                <option value={m.id} key={m.id || "default"}>{m.label}</option>
              ))}
              {current.model &&
                !AGENT_MODELS.some((m) =>
                  m.id === current.model
                ) && <option value={current.model}>{current.model}</option>}
            </select>
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
                  {MODE_LABELS[m]} — {MODE_HINTS[m]}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            <span class="field-label">Allowed tools</span>
            <input
              type="text"
              class="font-custom"
              data-testid="agent-preset-tools"
              spellcheck={false}
              autocomplete="off"
              placeholder="Read, Grep, Bash(git diff:*)"
              value={draft.tools ?? (current.allowedTools ?? []).join(", ")}
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
              Run without asking (Claude Code's <code>--allowedTools</code>{" "}
              patterns). Empty: ask as the mode says.
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
                commit("systemPrompt", (e.target as HTMLTextAreaElement).value)}
            />
            <span class="field-hint">
              Added to the agent's own system prompt.
            </span>
          </label>
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
