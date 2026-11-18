/**
 * An agent tile's transcript: a pure reducer from {@linkcode AgentEvent}s to the rows the tile
 * draws (app/agent-tile.tsx), the same in the backend (which keeps a copy for a page that comes
 * back, and for `read_screen`) and in the page. Plus what the rows say in a few words: a tool
 * call's `Tool(arg)` title and `⎿` result summary, a turn's footer, the transcript as plain text,
 * and a copy small enough for the workspace snapshot.
 *
 * Pure.
 *
 * @module
 */

import type { AgentEvent, PermissionDecision, ToolDetail } from "./adapter.ts";

/** One row of the transcript. `at` is epoch ms. */
export type Row =
  | {
    type: "user";
    id: string;
    text: string;
    attachments?: { name: string; kind: "image" | "text" }[];
    at: number;
  }
  /** The assistant's text (markdown), one row per text block. */
  | { type: "text"; id: string; text: string; at: number }
  | { type: "thinking"; id: string; text: string; tokens?: number; at: number }
  | {
    type: "tool";
    id: string;
    name: string;
    input?: Record<string, unknown>;
    status: "running" | "done" | "error" | "denied" | "cancelled";
    result?: string;
    detail?: ToolDetail;
    at: number;
  }
  | {
    type: "permission";
    id: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string;
    decision?: PermissionDecision;
    at: number;
  }
  | { type: "error"; id: string; text: string; at: number }
  | { type: "notice"; id: string; text: string; at: number }
  /** The end of a turn: how it went, how long, how fast, what it cost. */
  | {
    type: "footer";
    id: string;
    outcome: "done" | "failed" | "interrupted";
    durationMs?: number;
    outputTokens?: number;
    /** This turn's cost (USD). */
    costUsd?: number;
    at: number;
  };

/** The transcript and what the tile shows around it. */
export interface Transcript {
  rows: Row[];
  /** A turn is under way. */
  running: boolean;
  /** When the turn under way started. */
  turnStartedAt?: number;
  sessionId?: string;
  model?: string;
  cwd?: string;
  /** Messages waiting for the turn under way to end. */
  queue: string[];
  /** Open permission questions (their request ids). */
  asking: string[];
  /** The last turn failed (or the agent could not start): why. Cleared by the next message. */
  error?: string;
  /** The agent's process ended: why. */
  exited?: string;
  /** The turn under way was interrupted. */
  interrupted: boolean;
  /** What the session had cost when the last turn ended (Claude Code reports it cumulative). */
  costUsd?: number;
  /** The models the backend offers, when it lists its own (Codex, Ollama). */
  models?: { id: string; label: string }[];
  /** For row ids. */
  next: number;
}

/** The most rows a live transcript keeps (the oldest go first). */
export const MAX_ROWS = 3000;

/** An empty transcript, or one rebuilt from saved rows. */
export function emptyTranscript(rows: readonly Row[] = []): Transcript {
  return {
    rows: [...rows],
    running: false,
    queue: [],
    asking: [],
    interrupted: false,
    next: rows.length,
  };
}

/** Replace the row `id` (the last one with that id) with `fn(row)`; `undefined` when absent. */
function patchRow<T extends Row>(
  rows: readonly Row[],
  id: string,
  type: T["type"],
  fn: (row: T) => T,
): Row[] | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.id === id && r.type === type) {
      const copy = rows.slice();
      copy[i] = fn(r as T);
      return copy;
    }
  }
  return undefined;
}

function push(t: Transcript, row: Row): Transcript {
  const rows = [...t.rows, row];
  return {
    ...t,
    rows: rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows,
  };
}

function rowId(t: Transcript, prefix: string): [string, Transcript] {
  return [`${prefix}${t.next}`, { ...t, next: t.next + 1 }];
}

/** The transcript after `e`. */
export function reduceTranscript(t: Transcript, e: AgentEvent): Transcript {
  switch (e.kind) {
    case "session":
      if (
        t.sessionId === e.sessionId && t.model === (e.model ?? t.model) &&
        t.cwd === (e.cwd ?? t.cwd)
      ) return t;
      return {
        ...t,
        sessionId: e.sessionId,
        ...(e.model ? { model: e.model } : {}),
        ...(e.cwd ? { cwd: e.cwd } : {}),
      };
    case "user": {
      const [id, n] = rowId(t, "u");
      const { error: _e, ...rest } = n;
      return push({
        ...rest,
        running: true,
        turnStartedAt: e.at,
        interrupted: false,
      }, {
        type: "user",
        id,
        text: e.text,
        ...(e.attachments?.length ? { attachments: e.attachments } : {}),
        at: e.at,
      });
    }
    case "queue":
      return { ...t, queue: [...e.items] };
    case "text": {
      const rows = patchRow<Extract<Row, { type: "text" }>>(
        t.rows,
        e.id,
        "text",
        (r) => ({ ...r, text: r.text + e.delta }),
      );
      return rows
        ? { ...t, rows }
        : push(t, { type: "text", id: e.id, text: e.delta, at: e.at });
    }
    case "thinking": {
      const rows = patchRow<Extract<Row, { type: "thinking" }>>(
        t.rows,
        e.id,
        "thinking",
        (r) => ({
          ...r,
          text: r.text + e.delta,
          ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
        }),
      );
      return rows ? { ...t, rows } : push(t, {
        type: "thinking",
        id: e.id,
        text: e.delta,
        ...(e.tokens !== undefined ? { tokens: e.tokens } : {}),
        at: e.at,
      });
    }
    case "toolStart":
      if (t.rows.some((r) => r.type === "tool" && r.id === e.id)) return t;
      return push(t, {
        type: "tool",
        id: e.id,
        name: e.name,
        status: "running",
        at: e.at,
      });
    case "toolInput": {
      const rows = patchRow<Extract<Row, { type: "tool" }>>(
        t.rows,
        e.id,
        "tool",
        (r) => ({ ...r, name: e.name, input: e.input }),
      );
      return rows ? { ...t, rows } : push(t, {
        type: "tool",
        id: e.id,
        name: e.name,
        input: e.input,
        status: "running",
        at: e.at,
      });
    }
    case "toolResult": {
      const denied = t.rows.some((r) =>
        r.type === "permission" && r.toolUseId === e.id &&
        r.decision === "deny"
      );
      const status = denied ? "denied" : e.isError ? "error" : "done";
      const rows = patchRow<Extract<Row, { type: "tool" }>>(
        t.rows,
        e.id,
        "tool",
        (r) => ({
          ...r,
          status,
          result: e.text,
          ...(e.detail ? { detail: e.detail } : {}),
        }),
      );
      return rows ? { ...t, rows } : push(t, {
        type: "tool",
        id: e.id,
        name: "tool",
        status,
        result: e.text,
        ...(e.detail ? { detail: e.detail } : {}),
        at: e.at,
      });
    }
    case "permission":
      if (
        t.rows.some((r) => r.type === "permission" && r.id === e.requestId)
      ) return t;
      return push({ ...t, asking: [...t.asking, e.requestId] }, {
        type: "permission",
        id: e.requestId,
        toolName: e.toolName,
        input: e.input,
        ...(e.toolUseId ? { toolUseId: e.toolUseId } : {}),
        at: e.at,
      });
    case "permissionDone": {
      const rows = patchRow<Extract<Row, { type: "permission" }>>(
        t.rows,
        e.requestId,
        "permission",
        (r) => r.decision ? r : { ...r, decision: e.decision },
      );
      return {
        ...t,
        ...(rows ? { rows } : {}),
        asking: t.asking.filter((id) => id !== e.requestId),
      };
    }
    case "interrupted": {
      if (t.interrupted) return t;
      const [id, n] = rowId(t, "n");
      return push({ ...n, interrupted: true }, {
        type: "notice",
        id,
        text: "Interrupted",
        at: e.at,
      });
    }
    case "turnEnd": {
      const interrupted = t.interrupted ||
        e.subtype === "error_during_execution" && !e.result;
      const outcome = interrupted
        ? "interrupted"
        : e.isError
        ? "failed"
        : "done";
      const costUsd = e.costUsd !== undefined && t.costUsd !== undefined
        ? Math.max(0, e.costUsd - t.costUsd)
        : e.costUsd;
      // Tool calls the turn left unanswered (an interrupt) end with it.
      let rows = t.rows.map((r) =>
        r.type === "tool" && r.status === "running"
          ? { ...r, status: "cancelled" as const }
          : r
      );
      let next = t.next;
      let error = t.error;
      if (outcome === "failed") {
        error = e.result || `The turn failed (${e.subtype ?? "error"}).`;
        rows = [...rows, {
          type: "error",
          id: `e${next++}`,
          text: error,
          at: e.at,
        }];
      }
      rows = [...rows, {
        type: "footer",
        id: `f${next++}`,
        outcome,
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
        ...(e.outputTokens !== undefined
          ? { outputTokens: e.outputTokens }
          : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        at: e.at,
      }];
      const { turnStartedAt: _s, error: _e, ...rest } = t;
      return {
        ...rest,
        rows: rows.length > MAX_ROWS
          ? rows.slice(rows.length - MAX_ROWS)
          : rows,
        next,
        running: false,
        interrupted: false,
        asking: [],
        ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
        ...(error !== undefined && outcome === "failed" ? { error } : {}),
      };
    }
    case "error": {
      const [id, n] = rowId(t, "e");
      const { turnStartedAt: _s, ...rest } = n;
      return push({ ...rest, error: e.message, running: false }, {
        type: "error",
        id,
        text: e.message,
        at: e.at,
      });
    }
    case "exit": {
      const [id, n] = rowId(t, "n");
      const { turnStartedAt: _s, ...rest } = n;
      return push({
        ...rest,
        exited: e.reason,
        running: false,
        asking: [],
      }, { type: "notice", id, text: e.reason, at: e.at });
    }
    case "models":
      return { ...t, models: e.models.slice(0, 100) };
    case "log":
      return t;
  }
}

/** A notice row (the session layer's own lines: "Resumed session …", "New session"). */
export function withNotice(
  t: Transcript,
  text: string,
  at: number,
): Transcript {
  const [id, n] = rowId(t, "n");
  return push(n, { type: "notice", id, text, at });
}

// ---------------------------------------------------------------------------------------------
// What the rows say
// ---------------------------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

/** `path` relative to `cwd` when it is inside it. */
function relPath(path: string, cwd?: string): string {
  if (!cwd) return path;
  const base = cwd.replace(/\/+$/, "");
  if (path === base) return ".";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** The first line of `s`, at most `max` characters. */
function firstLine(s: string, max = 100): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A tool's display name (`mcp__qutty__read_screen` → `read_screen (qutty)`). */
export function toolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return m ? `${m[2]} (${m[1]})` : name;
}

/** The `Tool(arg)` a tool call's row shows: its name and what it acts on. */
export function toolTitle(
  name: string,
  input: Record<string, unknown> | undefined,
  cwd?: string,
): { name: string; arg: string } {
  const i = input ?? {};
  const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
  let arg: string | undefined;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      arg = path ? relPath(path, cwd) : undefined;
      break;
    case "Bash":
      arg = str(i.command);
      break;
    case "Glob":
    case "Grep":
      arg = str(i.pattern) &&
        `${i.pattern}${path ? ` in ${relPath(path, cwd)}` : ""}`;
      break;
    case "WebFetch":
      arg = str(i.url);
      break;
    case "WebSearch":
      arg = str(i.query);
      break;
    case "Task":
    case "Agent":
      arg = str(i.description);
      break;
    case "TodoWrite":
      arg = Array.isArray(i.todos) ? `${i.todos.length} todos` : undefined;
      break;
    default:
      arg = Object.values(i).find((v): v is string =>
        typeof v === "string" && v.length > 0
      );
  }
  return { name: toolName(name), arg: arg ? firstLine(arg, 120) : "" };
}

/** Lines added and removed by a patch. */
function patchCounts(
  patch: ToolDetail["patch"],
): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const h of patch ?? []) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The `⎿` line under a tool call: how it went, in a few words. */
export function toolSummary(row: Extract<Row, { type: "tool" }>): string {
  switch (row.status) {
    case "running":
      return "Running…";
    case "denied":
      return "Denied";
    case "cancelled":
      return "Cancelled";
    case "error":
      return firstLine(row.result ?? "Failed") || "Failed";
  }
  const d = row.detail;
  if (d?.patch) {
    const { added, removed } = patchCounts(d.patch);
    const n = Math.max(added, removed);
    return `Applied ${n}-line change (+${added} −${removed})`;
  }
  if (d?.wroteLines !== undefined) {
    return `Wrote ${plural(d.wroteLines, "line")}`;
  }
  if (d?.readLines !== undefined) return `Read ${plural(d.readLines, "line")}`;
  if (d?.stdout !== undefined || d?.stderr !== undefined) {
    const out = `${d.stdout ?? ""}${d.stderr ? `\n${d.stderr}` : ""}`.trim();
    if (!out) return d.interrupted ? "Interrupted" : "(no output)";
    const lines = out.split("\n");
    return lines.length === 1
      ? firstLine(out)
      : `${plural(lines.length, "line")} of output`;
  }
  const text = (row.result ?? "").trim();
  if (!text) return "Done";
  const lines = text.split("\n");
  return lines.length > 1 ? plural(lines.length, "line") : firstLine(text);
}

/** The diff an edit's row expands to: `{ sign, text }` per line, hunks separated by `@@`. */
export function diffLines(
  patch: ToolDetail["patch"],
): { sign: "+" | "-" | " " | "@"; text: string }[] {
  const out: { sign: "+" | "-" | " " | "@"; text: string }[] = [];
  for (const h of patch ?? []) {
    out.push({ sign: "@", text: `@@ -${h.oldStart} +${h.newStart} @@` });
    for (const l of h.lines) {
      const s = l[0];
      out.push({
        sign: s === "+" || s === "-" ? s : " ",
        text: s === "+" || s === "-" || s === " " ? l.slice(1) : l,
      });
    }
  }
  return out;
}

/** Tools that only look (consecutive calls are shown as one row: "Read 2 files"). */
const LOOKS = new Set(["Read", "Glob", "Grep", "LS"]);

/** What the transcript view draws: a row, or a run of look-only tool calls. */
export type DisplayItem =
  | {
    kind: "row";
    row: Row;
    /** A tool call's permission question, drawn under its row (not after it). */
    permission?: Extract<Row, { type: "permission" }>;
  }
  | {
    kind: "group";
    id: string;
    label: string;
    rows: Extract<Row, { type: "tool" }>[];
  };

/** "Read 2 files, searched 1 pattern". */
function groupLabel(
  rows: readonly Extract<Row, { type: "tool" }>[],
): string {
  const read = rows.filter((r) => r.name === "Read" || r.name === "LS").length;
  const search = rows.length - read;
  const parts: string[] = [];
  if (read) parts.push(`Read ${plural(read, "file")}`);
  if (search) {
    parts.push(
      `${read ? "searched" : "Searched"} ${plural(search, "pattern")}`,
    );
  }
  return parts.join(", ");
}

/**
 * Each permission question that is about a tool call in `rows` (its `toolUseId`), by the call's
 * id: the view draws it with its tool row instead of where it arrived.
 */
function questionsByTool(
  rows: readonly Row[],
): Map<string, Extract<Row, { type: "permission" }>> {
  const tools = new Set<string>();
  const out = new Map<string, Extract<Row, { type: "permission" }>>();
  for (const r of rows) {
    if (r.type === "tool") tools.add(r.id);
    else if (r.type === "permission" && r.toolUseId && tools.has(r.toolUseId)) {
      out.set(r.toolUseId, r);
    }
  }
  return out;
}

/**
 * The rows as the view draws them: two or more finished look-only calls in a row are one item; a
 * permission question goes with the tool call it is about.
 */
export function displayItems(rows: readonly Row[]): DisplayItem[] {
  const questions = questionsByTool(rows);
  const attached = new Set([...questions.values()].map((q) => q.id));
  const rowItem = (r: Row): DisplayItem => {
    const q = r.type === "tool" ? questions.get(r.id) : undefined;
    return q ? { kind: "row", row: r, permission: q } : { kind: "row", row: r };
  };
  const out: DisplayItem[] = [];
  let run: Extract<Row, { type: "tool" }>[] = [];
  const flush = () => {
    if (run.length >= 2) {
      out.push({
        kind: "group",
        id: `g-${run[0].id}`,
        label: groupLabel(run),
        rows: run,
      });
    } else for (const r of run) out.push(rowItem(r));
    run = [];
  };
  for (const r of rows) {
    if (r.type === "permission" && attached.has(r.id)) continue;
    if (
      r.type === "tool" && LOOKS.has(r.name) && r.status === "done" &&
      !questions.has(r.id)
    ) {
      run.push(r);
      continue;
    }
    // Thinking between two reads does not break the run.
    if (r.type === "thinking" && run.length > 0 && !r.text) continue;
    flush();
    out.push(rowItem(r));
  }
  flush();
  return out;
}

/** `1,284`. */
const grouped = (n: number) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `5.1s`, `1m 05s`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A turn's footer: "done · 1,284 tok/s · 5.1s · $0.0035". */
export function footerText(row: Extract<Row, { type: "footer" }>): string {
  const parts: string[] = [row.outcome];
  if (row.outputTokens && row.durationMs) {
    parts.push(`${grouped(row.outputTokens / (row.durationMs / 1000))} tok/s`);
  }
  if (row.outputTokens) parts.push(`${grouped(row.outputTokens)} tok`);
  if (row.durationMs !== undefined) parts.push(formatDuration(row.durationMs));
  if (row.costUsd !== undefined && row.costUsd > 0) {
    parts.push(
      `$${
        row.costUsd < 0.01 ? row.costUsd.toFixed(4) : row.costUsd.toFixed(2)
      }`,
    );
  }
  return parts.join(" · ");
}

/** What a permission row asks: "Edit src/x.ts", "Bash: rm -rf build". */
function permissionText(
  row: Extract<Row, { type: "permission" }>,
  cwd?: string,
): string {
  const t = toolTitle(row.toolName, row.input, cwd);
  return t.arg ? `${t.name}(${t.arg})` : t.name;
}

/**
 * The transcript as plain text, the way Claude Code's terminal UI would show it (`read_screen` on
 * an agent tile): the last `maxLines` lines.
 */
export function transcriptText(
  t: Pick<Transcript, "rows" | "cwd" | "running" | "queue" | "asking">,
  maxLines = 200,
): string[] {
  const lines: string[] = [];
  const questions = questionsByTool(t.rows);
  const attached = new Set([...questions.values()].map((q) => q.id));
  const question = (r: Extract<Row, { type: "permission" }>) =>
    `? Allow ${permissionText(r, t.cwd)}? ${
      r.decision ? `(${r.decision})` : "[Allow / Allow always / Deny]"
    }`;
  for (const r of t.rows) {
    switch (r.type) {
      case "user":
        lines.push(
          "",
          ...r.text.split("\n").map((l, i) => `${i ? "  " : "> "}${l}`),
        );
        for (const a of r.attachments ?? []) {
          lines.push(`  [attached ${a.name}]`);
        }
        break;
      case "text":
        lines.push(
          "",
          ...r.text.split("\n").map((l, i) => `${i ? "  " : "● "}${l}`),
        );
        break;
      case "thinking":
        lines.push("", "✻ Thinking…");
        break;
      case "tool": {
        const title = toolTitle(r.name, r.input, t.cwd);
        const q = questions.get(r.id);
        lines.push(
          "",
          `● ${title.name}${title.arg ? `(${title.arg})` : ""}`,
          ...(q ? [`  ${question(q)}`] : []),
          `  ⎿  ${toolSummary(r)}`,
        );
        break;
      }
      case "permission":
        if (!attached.has(r.id)) lines.push("", question(r));
        break;
      case "error":
        lines.push("", `! ${r.text}`);
        break;
      case "notice":
        lines.push("", `· ${r.text}`);
        break;
      case "footer":
        lines.push(`  ${footerText(r)}`);
        break;
    }
  }
  if (t.running) lines.push("", "✻ Working…");
  for (const q of t.queue) lines.push(`  (queued) ${firstLine(q)}`);
  return lines.slice(-maxLines);
}

/** The most text a saved transcript keeps (characters, all rows). */
const SAVED_CHARS = 120_000;
/** The most text of one saved row. */
const SAVED_ROW_CHARS = 8_000;

const clipText = (s: string, max = SAVED_ROW_CHARS) =>
  s.length > max ? `${s.slice(0, max)}\n… (cut)` : s;

/** A tool detail without the file it had before (`original`). */
function withoutOriginal(d: ToolDetail): ToolDetail {
  const { original: _o, ...rest } = d;
  return rest;
}

/** A row's size in characters, roughly (what the saved copy budgets on). */
function rowChars(r: Row): number {
  return JSON.stringify(r).length;
}

/**
 * The rows the workspace snapshot keeps: the newest that fit in `maxChars`, each row's long text
 * cut, permission questions that were never answered dropped (they cannot be answered after a
 * restart).
 */
export function savedRows(rows: readonly Row[], maxChars = SAVED_CHARS): Row[] {
  const out: Row[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    let r = rows[i];
    if (r.type === "permission" && !r.decision) continue;
    if (r.type === "text" || r.type === "user" || r.type === "error") {
      r = { ...r, text: clipText(r.text) };
    } else if (r.type === "thinking") {
      r = { ...r, text: clipText(r.text, 2000) };
    } else if (r.type === "tool") {
      r = {
        ...r,
        ...(r.status === "running" ? { status: "cancelled" as const } : {}),
        ...(r.result !== undefined ? { result: clipText(r.result, 2000) } : {}),
        ...(r.detail
          ? {
            detail: {
              // A whole file is too big for the saved copy (a resume reads Claude Code's own).
              ...withoutOriginal(r.detail),
              ...(r.detail.stdout !== undefined
                ? { stdout: clipText(r.detail.stdout, 2000) }
                : {}),
              ...(r.detail.stderr !== undefined
                ? { stderr: clipText(r.detail.stderr, 2000) }
                : {}),
              ...(r.detail.patch
                ? {
                  patch: r.detail.patch.slice(0, 20).map((h) => ({
                    ...h,
                    lines: h.lines.slice(0, 200),
                  })),
                }
                : {}),
              ...(r.detail.files
                ? {
                  files: r.detail.files.slice(0, 20).map((f) => ({
                    path: f.path,
                    patch: f.patch.slice(0, 20).map((h) => ({
                      ...h,
                      lines: h.lines.slice(0, 200),
                    })),
                  })),
                }
                : {}),
            },
          }
          : {}),
      };
    }
    const size = rowChars(r);
    if (used + size > maxChars) break;
    used += size;
    out.push(r);
  }
  return out.reverse();
}

const ROW_TYPES = new Set([
  "user",
  "text",
  "thinking",
  "tool",
  "permission",
  "error",
  "notice",
  "footer",
]);

/** Rows from storage: the well-formed ones (the rest are dropped). */
export function sanitizeRows(raw: unknown): Row[] {
  if (!Array.isArray(raw)) return [];
  const out: Row[] = [];
  for (const r of raw) {
    if (
      typeof r !== "object" || r === null || typeof r.id !== "string" ||
      !ROW_TYPES.has(r.type) || typeof r.at !== "number"
    ) continue;
    if (
      (r.type === "user" || r.type === "text" || r.type === "thinking" ||
        r.type === "error" || r.type === "notice") &&
      typeof r.text !== "string"
    ) continue;
    if (r.type === "tool" && typeof r.name !== "string") continue;
    if (
      r.type === "permission" &&
      (typeof r.toolName !== "string" || typeof r.input !== "object")
    ) continue;
    out.push(r as Row);
  }
  return savedRows(out);
}
