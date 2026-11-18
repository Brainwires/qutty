// An agent tile's Changes tab: the session's file edits (lib/agent/changes.ts, from its Edit,
// MultiEdit and Write rows) as one diff to review, file by file: Open in editor (Settings →
// Links' editor, at the first changed line), Accept (dismiss: the file leaves the list until the
// agent changes it again) and Revert, per file or all. Reverting asks first, in the tab itself,
// and only takes back this session's changes (the backend refuses a file that changed since in
// a way it cannot undo, and says why under the file).

import { useState } from "denext";
import {
  type ChangedFile,
  type FileChange,
  firstLine,
  type RevertResult,
  shortPath,
} from "../lib/agent/changes.ts";
import { diffLines } from "../lib/agent/transcript.ts";

export interface ChangesHooks {
  /** Accept: mark these files' changes (path → last row id) reviewed. */
  accept(marks: Record<string, string>): void;
  revert(paths: string[]): Promise<RevertResult[]>;
  /** Open a file in the editor (absent: no editor to open with). */
  openInEditor?: (path: string, line?: number) => void;
}

/** The diff lines of one change: its patch, else what its input says it changed. */
function changeLines(
  c: FileChange,
): { sign: "+" | "-" | " " | "@"; text: string }[] {
  if (c.patch?.length) return diffLines(c.patch);
  if (c.tool === "Write") {
    return (c.content ?? "").replace(/\n$/, "").split("\n").map((text) => ({
      sign: "+" as const,
      text,
    }));
  }
  return c.edits.flatMap((e) => [
    ...e.oldText.split("\n").map((text) => ({ sign: "-" as const, text })),
    ...e.newText.split("\n").map((text) => ({ sign: "+" as const, text })),
  ]);
}

/** A diff line's class (`diff-add`, …) for its sign. */
export const diffClass = (sign: string) =>
  sign === "+" ? "add" : sign === "-" ? "del" : sign === "@" ? "hunk" : "ctx";

export function ChangesView(
  props: {
    files: ChangedFile[];
    cwd?: string;
    hooks: ChangesHooks;
  },
) {
  const { files, hooks } = props;
  /** The files a Revert asks about (`null`: not asking). */
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why a file was not reverted. */
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const label = (f: ChangedFile) => shortPath(f.path, props.cwd);
  const lastOf = (f: ChangedFile) => f.changes.at(-1)!.rowId;

  const revert = async (paths: string[]) => {
    setConfirm(null);
    setBusy(true);
    try {
      const results = await hooks.revert(paths);
      const next: Record<string, string> = {};
      for (const r of results) if (!r.ok) next[r.path] = r.reason ?? "failed";
      setErrors(next);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setErrors(Object.fromEntries(paths.map((p) => [p, reason])));
    } finally {
      setBusy(false);
    }
  };

  if (files.length === 0) {
    return (
      <div class="agent-changes" data-testid="agent-changes">
        <div class="agent-welcome" data-testid="agent-changes-empty">
          <div>No changes to review.</div>
          <div class="agent-dim">
            Files the agent edits or writes show here as one diff.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="agent-changes" data-testid="agent-changes">
      <div class="agent-changes-bar">
        <span data-testid="agent-changes-count">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span class="agent-change-add">+{added}</span>
        <span class="agent-change-del">−{removed}</span>
        <span class="agent-changes-spacer" />
        <button
          type="button"
          class="btn-quiet agent-btn"
          data-testid="agent-accept-all"
          title="Dismiss every change from this list (the files stay as they are)"
          disabled={busy}
          onClick={() =>
            hooks.accept(
              Object.fromEntries(files.map((f) => [f.path, lastOf(f)])),
            )}
        >
          Accept all
        </button>
        <button
          type="button"
          class="btn-quiet agent-btn is-danger"
          data-testid="agent-revert-all"
          title="Put every file back as it was before this session's changes"
          disabled={busy}
          onClick={() => setConfirm(files.map((f) => f.path))}
        >
          Revert all…
        </button>
      </div>
      {confirm && (
        <div
          class="agent-changes-confirm"
          role="alertdialog"
          aria-label="Revert"
          data-testid="agent-revert-confirm"
        >
          <span>
            Revert{" "}
            <b>
              {confirm.length === 1
                ? shortPath(confirm[0], props.cwd)
                : `${confirm.length} files`}
            </b>{" "}
            to before this session's changes? Only the agent's changes are
            undone; a file that changed since is left alone.
          </span>
          <button
            type="button"
            class="btn-primary agent-btn is-danger"
            data-testid="agent-revert-yes"
            onClick={() => void revert(confirm)}
          >
            Revert
          </button>
          <button
            type="button"
            class="btn-quiet agent-btn"
            data-testid="agent-revert-no"
            onClick={() => setConfirm(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {files.map((f) => (
        <div
          class="agent-change-file"
          data-testid="agent-change-file"
          data-path={f.path}
          key={f.path}
        >
          <div class="agent-change-head">
            <button
              type="button"
              class="agent-tool-head agent-change-name"
              aria-expanded={!closed[f.path]}
              onClick={() =>
                setClosed({ ...closed, [f.path]: !closed[f.path] })}
            >
              <span class="agent-dim">{closed[f.path] ? "▸" : "▾"}</span>{" "}
              {label(f)}
            </button>
            {f.created && <span class="agent-change-new">new</span>}
            <span class="agent-change-add">+{f.added}</span>
            <span class="agent-change-del">−{f.removed}</span>
            <span class="agent-changes-spacer" />
            {hooks.openInEditor && (
              <button
                type="button"
                class="agent-link-btn"
                data-testid="agent-change-open"
                title="Open in the editor (Settings → Links)"
                onClick={() => hooks.openInEditor!(f.path, firstLine(f))}
              >
                Open
              </button>
            )}
            <button
              type="button"
              class="agent-link-btn"
              data-testid="agent-change-accept"
              title="Dismiss this file's changes from the list"
              disabled={busy}
              onClick={() => hooks.accept({ [f.path]: lastOf(f) })}
            >
              Accept
            </button>
            <button
              type="button"
              class="agent-link-btn is-danger"
              data-testid="agent-change-revert"
              title="Put this file back as it was before this session's changes"
              disabled={busy}
              onClick={() => setConfirm([f.path])}
            >
              Revert
            </button>
          </div>
          {errors[f.path] && (
            <div class="agent-change-error" data-testid="agent-change-error">
              ! Not reverted: {errors[f.path]}
            </div>
          )}
          {!closed[f.path] && (
            <pre class="agent-detail agent-diff" data-testid="agent-diff">
              {f.changes.flatMap((c) =>
                changeLines(c).map((l, i) => (
                  <div
                    class={`diff-line diff-${diffClass(l.sign)}`}
                    key={`${c.rowId}-${i}`}
                  >
                    <span class="diff-sign">{l.sign === "@" ? "" : l.sign}</span>
                    {l.text}
                  </div>
                ))
              )}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}
