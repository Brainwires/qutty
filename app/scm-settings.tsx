// Settings → Source Control: where "New Worktree…" puts a new checkout (lib/scm/worktrees.ts).
// Empty: `<repo-parent>/.qutty-worktrees/<repo>/<branch>`; a folder: `<folder>/<repo>/<branch>`.

import { useState } from "denext";
import { checkoutPath, type ScmSettings } from "../lib/scm/worktrees.ts";
import { SettingsGroup } from "./settings-ui.tsx";

export function ScmSettingsSection(props: {
  settings: ScmSettings;
  onChange(patch: Partial<ScmSettings>): void;
}) {
  // The folder as typed; saved when the field is left or Enter is pressed.
  const [draft, setDraft] = useState<string | null>(null);
  const folder = props.settings.worktreeFolder;
  return (
    <SettingsGroup title="Worktrees" testid="scm-section">
      <label class="field">
        <span class="field-label">Worktree folder</span>
        <input
          type="text"
          class="font-custom"
          data-testid="setting-worktree-folder"
          spellcheck={false}
          autocomplete="off"
          placeholder="Beside each repository, in .qutty-worktrees"
          value={draft ?? folder}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={() => {
            if (draft !== null) {
              props.onChange({ worktreeFolder: draft.trim() });
            }
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <span class="field-hint">
          Where New Worktree… puts a checkout, for example{" "}
          <code>{checkoutPath("/src/qutty", "feature/x", folder)}</code>. An
          absolute folder; empty puts it beside the repository. A worktree opens
          as a workspace of its own. Closing that workspace never deletes the
          folder, and Remove Worktree never deletes the branch.
        </span>
      </label>
    </SettingsGroup>
  );
}
