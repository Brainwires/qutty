/**
 * A resumed session's history from Claude Code's own transcript file
 * (`~/.claude/projects/<slug>/<session>.jsonl`; `$CLAUDE_CONFIG_DIR` instead of `~/.claude` when
 * set), as agent tile rows: what a tile that comes back on a Claude Code session shows instead of
 * only its saved copy (which falls back when the file is missing or says nothing).
 *
 * The file has one JSON object per line. The lines that matter look like the stream-json output
 * (lib/agent/claude-stream.ts): `assistant` lines with one content block each, `user` lines with
 * the prompt (a string or text and image blocks) or with `tool_result` blocks and the tool's
 * `toolUseResult` (stream-json's `tool_use_result`). Subagent lines (`isSidechain`), injected ones
 * (`isMeta`), slash-command echoes and everything else (`summary`, `system`, snapshots) are left
 * out. Each prompt starts a turn; a turn ends (a plain "done" footer) at the next prompt or the end.
 *
 * The file is only ever read.
 *
 * Pure.
 *
 * @module
 */

import { ClaudeStreamParser } from "./claude-stream.ts";
import { emptyTranscript, reduceTranscript, type Row } from "./transcript.ts";
import type { AgentEvent } from "./adapter.ts";

/** The most lines read from the end of a transcript file. */
const MAX_LINES = 20_000;

/** Claude Code's folder name for project `cwd` (every character but a letter or digit is `-`). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where Claude Code keeps session `sessionId` of folder `cwd`, under its config folder. */
export function claudeTranscriptPath(
  configDir: string,
  cwd: string,
  sessionId: string,
): string {
  return `${configDir.replace(/\/+$/, "")}/projects/${
    claudeProjectSlug(cwd)
  }/${sessionId}.jsonl`;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A prompt line's text and attachments (`undefined`: not a prompt). */
function promptOf(
  content: unknown,
): { text: string; images: number } | undefined {
  if (typeof content === "string") return { text: content, images: 0 };
  if (!Array.isArray(content)) return undefined;
  let text = "";
  let images = 0;
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === "tool_result") return undefined;
    if (b.type === "text" && typeof b.text === "string") {
      text += (text ? "\n" : "") + b.text;
    } else if (b.type === "image") images++;
  }
  return text || images ? { text, images } : undefined;
}

/** Text Claude Code writes as a user line that the user did not type (slash commands, caveats). */
const NOT_TYPED =
  /^\s*<(command-name|command-message|local-command-stdout|local-command-stderr|system-reminder)>/;

/** The rows of a Claude Code transcript file's text (`[]` when it has none). */
export function historyRows(jsonl: string): Row[] {
  let at = 0;
  const parser = new ClaudeStreamParser(() => at);
  let t = emptyTranscript();
  let open = false;
  const apply = (events: AgentEvent[]) => {
    for (const e of events) {
      if (e.kind === "log" || e.kind === "session") continue;
      t = reduceTranscript(t, e);
    }
  };
  const endTurn = () => {
    if (!open) return;
    open = false;
    t = reduceTranscript(t, {
      kind: "turnEnd",
      isError: false,
      subtype: "success",
      at,
    });
  };
  const lines = jsonl.split("\n");
  for (const raw of lines.slice(-MAX_LINES)) {
    if (!raw.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      // A line cut short (the file being written as we read it) is skipped, not fatal.
      continue;
    }
    if (!isObj(v) || v.isSidechain === true || v.isMeta === true) continue;
    if (v.isCompactSummary === true) continue;
    const ts = typeof v.timestamp === "string" ? Date.parse(v.timestamp) : NaN;
    if (Number.isFinite(ts)) at = ts;
    const message = v.message;
    if (!isObj(message)) continue;
    if (v.type === "assistant") {
      if (!open) continue;
      apply(parser.line(JSON.stringify({ type: "assistant", message })));
      continue;
    }
    if (v.type !== "user") continue;
    const prompt = promptOf(message.content);
    if (prompt) {
      if (prompt.text.startsWith("[Request interrupted")) {
        if (open) apply([{ kind: "interrupted", at }]);
        continue;
      }
      if (NOT_TYPED.test(prompt.text)) continue;
      endTurn();
      open = true;
      t = reduceTranscript(t, {
        kind: "user",
        text: prompt.text,
        ...(prompt.images
          ? {
            attachments: Array.from({ length: prompt.images }, (_, i) => ({
              name: `image ${i + 1}`,
              kind: "image" as const,
            })),
          }
          : {}),
        at,
      });
      continue;
    }
    if (!open) continue;
    apply(parser.line(JSON.stringify({
      type: "user",
      message,
      ...(v.toolUseResult !== undefined
        ? { tool_use_result: v.toolUseResult }
        : {}),
    })));
  }
  endTurn();
  return t.rows;
}
