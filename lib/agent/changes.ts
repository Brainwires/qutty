/**
 * An agent session's file changes, from its transcript's tool rows (`Edit`, `MultiEdit`, `Write`
 * that finished): per file, the changes in order with their diffs, and how to take them back.
 * The agent tile's Changes tab draws them (app/agent-tile.tsx); the backend reverts them
 * (`revertFiles`, with the file system passed in: desktop/hub.ts, the demo's in lib/agent/demo.ts).
 *
 * Reverting only takes back what the session changed:
 *
 * - when the file is still exactly as the session's last change left it and the content before
 *   its first change is known (Claude Code's `originalFile`, or a write that created it), that
 *   content is put back (a created file is removed);
 * - otherwise each edit is undone in reverse order (its `new_string` back to its `old_string`),
 *   which leaves changes made by anyone else elsewhere in the file alone; when an edit's text is
 *   no longer there (or a whole-file write cannot be undone), nothing is written and the reason
 *   is reported.
 *
 * Only files inside the session's folder can be reverted.
 *
 * Pure (the file system comes in through {@linkcode RevertFs}).
 *
 * @module
 */

import type { ToolDetail } from "./adapter.ts";
import type { Row } from "./transcript.ts";

type ToolRow = Extract<Row, { type: "tool" }>;

/** The tools whose rows change a file. */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/** One edit of `old_string` to `new_string` (`replace_all`: every occurrence). */
export interface TextEdit {
  oldText: string;
  newText: string;
  all: boolean;
}

/** One change a tool call made to a file. */
export interface FileChange {
  /** The tool row's id. */
  rowId: string;
  tool: "Edit" | "MultiEdit" | "Write";
  /** The edits (`Edit`, `MultiEdit`). */
  edits: TextEdit[];
  /** The file's whole new content (`Write`). */
  content?: string;
  /** Its diff, when the agent reported one. */
  patch?: ToolDetail["patch"];
  /** The file before this change (`null`: it did not exist), when known. */
  original?: string | null;
}

/** A file the session changed. */
export interface ChangedFile {
  /** The absolute path. */
  path: string;
  changes: FileChange[];
  /** Lines added and removed, over all its changes. */
  added: number;
  removed: number;
  /** The session created it (its first change wrote a new file). */
  created: boolean;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** `path` made absolute against `cwd`, with `.` and `..` resolved. */
export function absPath(path: string, cwd?: string): string {
  const joined = path.startsWith("/") || !cwd ? path : `${cwd}/${path}`;
  const out: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Whether `path` is inside folder `dir` (both absolute). */
export function isInside(path: string, dir: string): boolean {
  const base = absPath(dir);
  const p = absPath(path);
  return base === "/" ? true : p.startsWith(`${base}/`);
}

function editsOf(row: ToolRow): TextEdit[] {
  const i = row.input ?? {};
  if (row.name === "Edit") {
    const oldText = str(i.old_string), newText = str(i.new_string);
    return oldText !== undefined && newText !== undefined
      ? [{ oldText, newText, all: i.replace_all === true }]
      : [];
  }
  if (row.name === "MultiEdit" && Array.isArray(i.edits)) {
    return i.edits.flatMap((e) => {
      if (typeof e !== "object" || e === null) return [];
      const r = e as Record<string, unknown>;
      const oldText = str(r.old_string), newText = str(r.new_string);
      return oldText !== undefined && newText !== undefined
        ? [{ oldText, newText, all: r.replace_all === true }]
        : [];
    });
  }
  return [];
}

function countPatch(patch: ToolDetail["patch"]): [number, number] {
  let added = 0, removed = 0;
  for (const h of patch ?? []) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return [added, removed];
}

const lineCount = (s: string) =>
  s === "" ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);

/** A change's lines added and removed (its patch, else its edits or written lines). */
function changeCounts(c: FileChange): [number, number] {
  if (c.patch?.length) return countPatch(c.patch);
  if (c.tool === "Write") return [lineCount(c.content ?? ""), 0];
  let added = 0, removed = 0;
  for (const e of c.edits) {
    added += lineCount(e.newText) || (e.newText ? 1 : 0);
    removed += lineCount(e.oldText) || (e.oldText ? 1 : 0);
  }
  return [added, removed];
}

/**
 * The files the session changed, in the order of their first change: the finished `Edit`,
 * `MultiEdit` and `Write` rows. `after` leaves out, per path, the changes up to and including a
 * row id (what was accepted or reverted already).
 */
export function sessionChanges(
  rows: readonly Row[],
  cwd?: string,
  after: Readonly<Record<string, string>> = {},
): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const skipping = new Map(Object.entries(after));
  for (const r of rows) {
    if (r.type !== "tool" || !EDIT_TOOLS.has(r.name) || r.status !== "done") {
      continue;
    }
    const raw = str(r.input?.file_path);
    if (!raw) continue;
    const path = absPath(raw, cwd);
    if (skipping.has(path)) {
      if (skipping.get(path) === r.id) skipping.delete(path);
      continue;
    }
    const change: FileChange = {
      rowId: r.id,
      tool: r.name as FileChange["tool"],
      edits: editsOf(r),
      ...(r.name === "Write" && typeof r.input?.content === "string"
        ? { content: r.input.content }
        : {}),
      ...(r.detail?.patch?.length ? { patch: r.detail.patch } : {}),
      ...(r.detail?.original !== undefined
        ? { original: r.detail.original }
        : {}),
    };
    let file = files.get(path);
    if (!file) {
      file = {
        path,
        changes: [],
        added: 0,
        removed: 0,
        created: change.original === null,
      };
      files.set(path, file);
    }
    file.changes.push(change);
    const [a, d] = changeCounts(change);
    file.added += a;
    file.removed += d;
  }
  return [...files.values()];
}

/** `text` with `e` applied (`undefined` when its old text is not there). */
function applyEdit(text: string, e: TextEdit): string | undefined {
  if (e.oldText === "") return undefined;
  if (!text.includes(e.oldText)) return undefined;
  return e.all
    ? text.split(e.oldText).join(e.newText)
    : text.replace(e.oldText, () => e.newText);
}

/** The file after change `c`, from the content before it (`undefined`: unknown). */
function afterChange(
  c: FileChange,
  before: string | null | undefined,
): string | undefined {
  if (c.tool === "Write") return c.content;
  if (before === null || before === undefined) return undefined;
  let text = before;
  for (const e of c.edits) {
    const next = applyEdit(text, e);
    if (next === undefined) return undefined;
    text = next;
  }
  return text;
}

/** What reverting a file comes to: its content to write (`null`: remove it), or why not. */
export type RevertPlan =
  | { ok: true; content: string | null }
  | { ok: false; reason: string };

/**
 * How to take `changes` (one file's, oldest first) back, given the file as it is now (`null`:
 * it does not exist).
 */
export function revertPlan(
  changes: readonly FileChange[],
  current: string | null,
): RevertPlan {
  if (changes.length === 0) return { ok: false, reason: "nothing to revert" };
  // 1. Still as the session left it, and its content before is known: put that back.
  const first = changes[0];
  if (first.original !== undefined) {
    let text: string | null | undefined = first.original;
    for (const c of changes) {
      // A later change's own `original` is the truth for what came before it.
      if (c !== first && c.original !== undefined) text = c.original;
      text = afterChange(c, text);
      if (text === undefined) break;
    }
    if (text !== undefined && text === current) {
      return { ok: true, content: first.original };
    }
  }
  // 2. Undo each edit, newest first, where its text still is.
  if (current === null) {
    return { ok: false, reason: "the file is gone" };
  }
  let text = current;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.tool === "Write") {
      return {
        ok: false,
        reason: "the file changed since the agent wrote it",
      };
    }
    for (let j = c.edits.length - 1; j >= 0; j--) {
      const e = c.edits[j];
      const back = applyEdit(text, {
        oldText: e.newText,
        newText: e.oldText,
        all: e.all,
      });
      if (back === undefined) {
        return {
          ok: false,
          reason: "the file changed since the agent's edit",
        };
      }
      text = back;
    }
  }
  return { ok: true, content: text };
}

/** The file system a revert reads and writes (absolute paths). */
export interface RevertFs {
  /** The file's text, `null` when it does not exist. */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** One file of a revert: which, and how it went. */
export interface RevertResult {
  path: string;
  ok: boolean;
  /** Why it was not reverted. */
  reason?: string;
  /** The last change reverted (its row id), when it was. */
  through?: string;
}

/** What to revert: a file, and the changes already accepted (up to and including a row id). */
export interface RevertTarget {
  path: string;
  after?: string;
}

/**
 * Revert `targets` to before the session's changes (`rows`, in folder `cwd`): only files the
 * session changed, inside `cwd`. Each file on its own (one that cannot be reverted is left as it
 * is and says why).
 */
export async function revertFiles(
  rows: readonly Row[],
  cwd: string,
  targets: readonly RevertTarget[],
  fs: RevertFs,
): Promise<RevertResult[]> {
  const out: RevertResult[] = [];
  for (const target of targets) {
    const path = absPath(target.path, cwd);
    const file = sessionChanges(
      rows,
      cwd,
      target.after ? { [path]: target.after } : {},
    ).find((f) => f.path === path);
    if (!file) {
      out.push({ path, ok: false, reason: "not changed by this session" });
      continue;
    }
    if (!isInside(path, cwd)) {
      out.push({ path, ok: false, reason: "outside the session's folder" });
      continue;
    }
    try {
      const plan = revertPlan(file.changes, await fs.read(path));
      if (!plan.ok) {
        out.push({ path, ok: false, reason: plan.reason });
        continue;
      }
      if (plan.content === null) await fs.remove(path);
      else await fs.write(path, plan.content);
      out.push({ path, ok: true, through: file.changes.at(-1)!.rowId });
    } catch (e) {
      out.push({
        path,
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/** A path relative to `cwd` when inside it (the Changes tab's labels). */
export function shortPath(path: string, cwd?: string): string {
  if (!cwd) return path;
  const base = absPath(cwd);
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** The first new line a file's changes touch (where "Open in editor" goes). */
export function firstLine(file: ChangedFile): number | undefined {
  for (const c of file.changes) {
    const h = c.patch?.[0];
    if (h) return Math.max(1, h.newStart);
  }
  return undefined;
}
