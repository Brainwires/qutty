/**
 * Source Control: the patch that stages, unstages or discards one hunk (VS Code's "Stage Change"),
 * for `git apply --cached` (stage), `git apply --cached --reverse` (unstage) and
 * `git apply --reverse` (discard). Pure.
 *
 * A hunk comes from a diff whose other hunks are not applied with it, so its line numbers are
 * made consistent for a patch of one hunk: the side git applies against (the old side to stage,
 * the new side to reverse) keeps its start, and the other side's start is derived from it.
 *
 * @module
 */

import type { DiffFile, DiffHunk } from "./types.ts";

/**
 * Whether a file's hunks can be staged one by one: a text change to a file that exists on both
 * sides under the same name (a created, deleted or renamed file is staged whole).
 */
export function hunksApply(file: DiffFile): boolean {
  return !file.binary && file.oldPath !== null &&
    file.oldPath === file.newPath && file.hunks.length > 0;
}

/** A hunk range: `start` alone for a count of one, `start,count` otherwise. */
const range = (start: number, count: number) =>
  count === 1 ? `${start}` : `${start},${count}`;

/**
 * The other side's start for a hunk patched on its own: a side with lines starts at the anchor's
 * start; an empty side (count 0) names the line before (unified diff's rule), so it is one less,
 * and a side with lines against an empty anchor starts one after it.
 */
function derivedStart(
  anchorStart: number,
  anchorCount: number,
  count: number,
): number {
  if (count === 0) return anchorCount === 0 ? anchorStart : anchorStart - 1;
  return anchorCount === 0 ? anchorStart + 1 : anchorStart;
}

/** The hunk's `@@` line for a patch of this hunk alone (`reverse`: anchored on its new side). */
function soloHeader(h: DiffHunk, reverse: boolean): string {
  const tail = h.header.replace(/^@@ [^@]* @@/, "");
  const oldStart = reverse
    ? derivedStart(h.newStart, h.newLines, h.oldLines)
    : h.oldStart;
  const newStart = reverse
    ? h.newStart
    : derivedStart(h.oldStart, h.oldLines, h.newLines);
  return `@@ -${range(oldStart, h.oldLines)} +${
    range(newStart, h.newLines)
  } @@${tail}`;
}

/**
 * The patch of hunk `index` of `file` alone: the file's `diff --git`, `---` and `+++` lines and
 * the hunk. `reverse`: it will be applied with `--reverse` (unstage a staged hunk, discard a
 * worktree one). `null` when the file's hunks cannot be applied one by one.
 */
export function hunkPatch(
  file: DiffFile,
  index: number,
  reverse = false,
): string | null {
  const hunk = file.hunks[index];
  if (!hunk || !hunksApply(file)) return null;
  const head = file.header.filter((l) =>
    l.startsWith("diff --git ") || l.startsWith("--- ") || l.startsWith("+++ ")
  );
  if (head.length !== 3) return null;
  return [...head, soloHeader(hunk, reverse), ...hunk.lines, ""].join("\n");
}
