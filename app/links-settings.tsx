// Settings → Links: what opens a file printed with a line number (`src/x.ts:42:7`), when it is
// ⌘-clicked (Ctrl-clicked elsewhere). The editors whose command is installed are found by the
// backend (desktop/links.ts `editors`) and listed first; a custom command is a template with
// `{file}`, `{line}` and `{col}` (lib/links.ts `editorArgv`: run as an argv, never a shell).

import { useEffect, useState } from "denext";
import type { PtyBackend } from "../lib/pty-client.ts";
import {
  EDITOR_PRESETS,
  editorChoice,
  editorPreset,
  type LinkSettings,
} from "../lib/links.ts";

export interface LinksSettingsProps {
  settings: LinkSettings;
  backend: PtyBackend | null;
  platform: "mac" | "other";
  onChange(patch: Partial<LinkSettings>): void;
}

export function LinksSettingsSection(props: LinksSettingsProps) {
  const { settings, onChange } = props;
  const [installed, setInstalled] = useState<string[] | null>(null);
  // The custom command as typed (the store keeps the sanitised form).
  const [draft, setDraft] = useState(settings.command);

  useEffect(() => {
    let live = true;
    props.backend?.linkEditors().then(
      (ids) => live && setInstalled(ids),
      () => live && setInstalled([]),
    );
    return () => {
      live = false;
    };
  }, [props.backend]);

  const auto = editorChoice({ editor: "auto", command: "" }, installed ?? []);
  const autoLabel = auto.kind === "command"
    ? `Auto (${EDITOR_PRESETS.find((p) => p.template === auto.command)?.label})`
    : "Auto (the file's default app)";
  const ordered = [...EDITOR_PRESETS].sort((a, b) =>
    Number(installed?.includes(b.id)) - Number(installed?.includes(a.id))
  );
  const mod = props.platform === "mac" ? "⌘" : "Ctrl";

  return (
    <div class="links-settings" data-testid="links-settings">
      <label class="field">
        <span class="field-label">Open files with a line in</span>
        <select
          class="field-select"
          data-testid="setting-links-editor"
          value={settings.editor}
          onChange={(e) =>
            onChange({ editor: (e.target as HTMLSelectElement).value })}
        >
          <option value="auto">{autoLabel}</option>
          {ordered.map((p) => (
            <option value={p.id} key={p.id}>
              {p.label}
              {installed && !installed.includes(p.id) ? " (not found)" : ""}
            </option>
          ))}
          <option value="tile">$EDITOR in a new tile</option>
          <option value="default">The file's default app</option>
          <option value="custom">Custom command…</option>
        </select>
        <span class="field-hint">
          {mod}-click a path printed as <code>file:line:col</code>{" "}
          (compilers, test runners, stack traces). Other files open in their
          default app, folders in{" "}
          {props.platform === "mac" ? "Finder" : "the file manager"}, URLs in
          the browser.
        </span>
      </label>
      {settings.editor === "custom" && (
        <label class="field">
          <span class="field-label">Command</span>
          <input
            type="text"
            class="font-custom"
            data-testid="setting-links-command"
            spellcheck={false}
            placeholder="hx {file}:{line}:{col}"
            value={draft}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value;
              setDraft(v);
              onChange({ command: v });
            }}
          />
          <span class="field-hint">
            <code>{"{file}"}</code>, <code>{"{line}"}</code> and{" "}
            <code>{"{col}"}</code>{" "}
            are filled in; the command runs directly, not through a shell.
          </span>
        </label>
      )}
      {editorPreset(settings.editor) && installed &&
        !installed.includes(settings.editor) && (
        <span class="field-hint" data-testid="links-editor-missing">
          {editorPreset(settings.editor)!.program}{" "}
          was not found on PATH or in the usual bin folders.
        </span>
      )}
    </div>
  );
}
