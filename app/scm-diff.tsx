// The Source Control tile's diff view: one file's diff, unified or side by side, with per-hunk
// actions where git can take a hunk on its own (lib/scm/patch.ts): Stage Hunk on a change,
// Unstage Hunk on a staged one, Discard Hunk (asks first) on a change. A commit's diff is
// read-only. Drawn with the agent tile's diff classes (`diff-line diff-add`…, styles.css).

import type { ReactNode } from "denext";
import { hunksApply } from "../lib/scm/patch.ts";
import {
  type LineKind,
  sideBySide,
  type SideCell,
  unifiedLines,
} from "../lib/scm/rows.ts";
import type { DiffFile, DiffHunk } from "../lib/scm/types.ts";

/** What the view shows and what its hunks can do. */
export interface DiffTarget {
  path: string;
  /** Whose diff: a change, a staged change, an untracked file, or a commit's file. */
  kind: "changes" | "staged" | "untracked" | "commit";
  /** The commit, for a commit's file. */
  oid?: string;
}

/** The hunk actions offered for a diff of `kind`. */
export type HunkAction = "stage" | "unstage" | "discard";

function hunkActions(kind: DiffTarget["kind"]): HunkAction[] {
  if (kind === "changes") return ["stage", "discard"];
  if (kind === "staged") return ["unstage"];
  return [];
}

const ACTION_LABEL: Record<HunkAction, string> = {
  stage: "Stage Hunk",
  unstage: "Unstage Hunk",
  discard: "Discard Hunk",
};

const cls = (kind: LineKind) =>
  `diff-line diff-${kind === "note" ? "hunk" : kind}`;
const SIGN: Record<LineKind, string> = {
  add: "+",
  del: "-",
  ctx: " ",
  note: "",
};

function UnifiedHunk(props: { hunk: DiffHunk }) {
  return (
    <>
      {unifiedLines(props.hunk).map((l, i) => (
        <div class={cls(l.kind)} key={i}>
          <span class="scm-ln">{l.oldNo ?? ""}</span>
          <span class="scm-ln">{l.newNo ?? ""}</span>
          <span class="diff-sign">{SIGN[l.kind]}</span>
          {l.text}
        </div>
      ))}
    </>
  );
}

function Cell(props: { cell?: SideCell }) {
  const c = props.cell;
  if (!c) return <div class="scm-side-cell is-empty" />;
  return (
    <div class={`scm-side-cell ${cls(c.kind)}`}>
      <span class="scm-ln">{c.no ?? ""}</span>
      {c.text}
    </div>
  );
}

function SideHunk(props: { hunk: DiffHunk }) {
  return (
    <>
      {sideBySide(props.hunk).map((r, i) => (
        <div class="scm-side-row" key={i}>
          <Cell cell={r.left} />
          <Cell cell={r.right} />
        </div>
      ))}
    </>
  );
}

export function DiffView(props: {
  target: DiffTarget;
  /** The diff (`null` while loading or when there is none: `message` says which). */
  file: DiffFile | null;
  message?: string;
  sideBySide: boolean;
  onSideBySide(on: boolean): void;
  busy: boolean;
  /** Apply a hunk action (discard asks first, in the tile). */
  onHunk(action: HunkAction, index: number): void;
  /** The file's own actions in the view's bar. */
  actions?: ReactNode;
  onClose(): void;
}) {
  const { file, target } = props;
  const perHunk = file && hunksApply(file) ? hunkActions(target.kind) : [];
  return (
    <div
      class="scm-diff"
      data-testid="scm-diff"
      data-path={target.path}
      data-kind={target.kind}
    >
      <div class="scm-diff-bar">
        <span class="scm-diff-path" title={target.path}>{target.path}</span>
        <span class="scm-diff-kind">
          {target.kind === "commit"
            ? target.oid?.slice(0, 7)
            : target.kind === "staged"
            ? "Staged"
            : target.kind === "untracked"
            ? "Untracked"
            : "Working Tree"}
        </span>
        <span class="scm-spacer" />
        {props.actions}
        <div class="scm-seg" role="group" aria-label="Diff layout">
          <button
            type="button"
            class={`scm-seg-btn${props.sideBySide ? "" : " is-on"}`}
            aria-pressed={!props.sideBySide}
            data-testid="scm-diff-unified"
            onClick={() => props.onSideBySide(false)}
          >
            Unified
          </button>
          <button
            type="button"
            class={`scm-seg-btn${props.sideBySide ? " is-on" : ""}`}
            aria-pressed={props.sideBySide}
            data-testid="scm-diff-split"
            onClick={() => props.onSideBySide(true)}
          >
            Side by Side
          </button>
        </div>
        <button
          type="button"
          class="scm-icon-btn"
          data-testid="scm-diff-close"
          aria-label="Close the diff"
          title="Close the diff"
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <div class={`scm-diff-body${props.sideBySide ? " is-split" : ""}`}>
        {!file && (
          <div class="scm-dim scm-pad">{props.message ?? "Loading…"}</div>
        )}
        {file?.binary && (
          <div class="scm-dim scm-pad">Binary file: no text diff.</div>
        )}
        {file && !file.binary && file.hunks.length === 0 && (
          <div class="scm-dim scm-pad">
            No changes to show (a mode or rename change only).
          </div>
        )}
        {file?.hunks.map((h, i) => (
          <div class="scm-hunk" data-testid="scm-hunk" key={`${i}:${h.header}`}>
            <div class="scm-hunk-head">
              <span class="scm-hunk-range">{h.header}</span>
              <span class="scm-spacer" />
              {perHunk.map((a) => (
                <button
                  type="button"
                  key={a}
                  class={`scm-link-btn${a === "discard" ? " is-danger" : ""}`}
                  data-testid={`scm-hunk-${a}`}
                  disabled={props.busy}
                  onClick={() => props.onHunk(a, i)}
                >
                  {ACTION_LABEL[a]}
                </button>
              ))}
            </div>
            <pre class="scm-hunk-lines">
              {props.sideBySide ? <SideHunk hunk={h} /> : <UnifiedHunk hunk={h} />}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
