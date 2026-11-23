/**
 * Source Control: a hunk's lines as the diff view draws them, unified (one column, both line
 * numbers) or side by side (old on the left, new on the right, a run of removed lines paired
 * with the added lines that replace them). Pure.
 *
 * @module
 */

import type { DiffHunk } from "./types.ts";

/** One line's kind: context, added, removed, or git's "No newline at end of file" note. */
export type LineKind = "ctx" | "add" | "del" | "note";

/** One line of the unified view. */
export interface UnifiedLine {
  kind: LineKind;
  /** Its number on the old side (context and removed lines). */
  oldNo?: number;
  /** Its number on the new side (context and added lines). */
  newNo?: number;
  text: string;
}

/** One side of a side-by-side row. */
export interface SideCell {
  kind: LineKind;
  no?: number;
  text: string;
}

/** One side-by-side row: either side may be empty. */
export interface SideRow {
  left?: SideCell;
  right?: SideCell;
}

/** The hunk's lines with their numbers. */
export function unifiedLines(hunk: DiffHunk): UnifiedLine[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line): UnifiedLine => {
    const text = line.slice(1);
    switch (line[0]) {
      case "+":
        return { kind: "add", newNo: newNo++, text };
      case "-":
        return { kind: "del", oldNo: oldNo++, text };
      case "\\":
        return { kind: "note", text: line.slice(2) };
      default:
        return { kind: "ctx", oldNo: oldNo++, newNo: newNo++, text };
    }
  });
}

/** The hunk side by side: context on both sides, each removed run beside the added run after it. */
export function sideBySide(hunk: DiffHunk): SideRow[] {
  const rows: SideRow[] = [];
  let dels: SideCell[] = [];
  let adds: SideCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({
        ...(dels[i] ? { left: dels[i] } : {}),
        ...(adds[i] ? { right: adds[i] } : {}),
      });
    }
    dels = [];
    adds = [];
  };
  for (const l of unifiedLines(hunk)) {
    if (l.kind === "del") dels.push({ kind: "del", no: l.oldNo, text: l.text });
    else if (l.kind === "add") {
      adds.push({ kind: "add", no: l.newNo, text: l.text });
    } else {
      flush();
      const cell = (no?: number): SideCell => ({
        kind: l.kind,
        no,
        text: l.text,
      });
      rows.push({ left: cell(l.oldNo), right: cell(l.newNo) });
    }
  }
  flush();
  return rows;
}
