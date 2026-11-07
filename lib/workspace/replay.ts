/**
 * A terminal's replay, as a window that attaches it redraws it: the output its PTY emitted while
 * no window (or another page) showed it, kept by the backend in a bounded ring buffer
 * (desktop/terminal-sessions.ts, over denext's `createOwnedResources`).
 *
 * Why raw output and not xterm's serialize addon: the ring holds exactly the bytes the shell
 * wrote, so replaying them into a fresh xterm reproduces the screen and the scrollback for every
 * ordinary shell session, at no cost while a window shows the terminal (no headless terminal per
 * PTY to feed). Its one weakness is a ring that dropped its oldest chunks: the replay then starts
 * mid-stream, possibly inside an escape sequence or under a full-screen program that switched
 * screens before the cut. So a cut replay starts at its first line break, and the page nudges a
 * full-screen program (the alternate screen is active after the replay) with a resize, which
 * makes it redraw (lib/terminal-manager.ts `adopt`).
 *
 * Pure, so it is tested without a PTY (tests/workspace_session_test.ts).
 *
 * @module
 */

/** One retained event, as `createOwnedResources().attach()` returns it. */
export interface ReplayEntry {
  readonly event: string;
  readonly data: unknown;
}

/** How a terminal ended. */
export interface ReplayExit {
  exitCode: number;
  signal: number | null;
}

/** A terminal's replay, folded. */
export interface FoldedReplay {
  /** The output to write into xterm, oldest first. */
  data: string;
  /** The last output event's `seq` (0 when none was kept): later events continue after it. */
  seq: number;
  /** The ring dropped its oldest output: `data` starts at a line break, not at the beginning. */
  truncated: boolean;
  /** Its exit, when it ended. */
  exit?: ReplayExit;
}

function isData(d: unknown): d is { seq: number; data: string } {
  return typeof d === "object" && d !== null &&
    typeof (d as { seq?: unknown }).seq === "number" &&
    typeof (d as { data?: unknown }).data === "string";
}

function isExit(d: unknown): d is ReplayExit {
  return typeof d === "object" && d !== null &&
    typeof (d as { exitCode?: unknown }).exitCode === "number";
}

/**
 * Fold the ring's entries (`data` events `{ seq, data }`, an `exit` event `{ exitCode, signal }`)
 * into the text to replay. Output starts at `seq` 1 and goes up by one per event, so a first kept
 * `seq` above 1, or a gap (denext drops an object chunk bigger than the whole ring instead of
 * cutting it), means output is missing: only the unbroken tail after the last gap is replayed,
 * cut at its first line break.
 */
export function foldReplay(entries: readonly ReplayEntry[]): FoldedReplay {
  let parts: string[] = [];
  let seq = 0;
  let truncated = false;
  let exit: ReplayExit | undefined;
  for (const e of entries) {
    if (e.event === "data" && isData(e.data)) {
      if (e.data.seq !== seq + 1) {
        truncated = true;
        parts = [];
      }
      seq = e.data.seq;
      parts.push(e.data.data);
    } else if (e.event === "exit" && isExit(e.data)) {
      exit = { exitCode: e.data.exitCode, signal: e.data.signal ?? null };
    }
  }
  let data = parts.join("");
  if (truncated) {
    const nl = data.indexOf("\n");
    data = nl < 0 ? "" : data.slice(nl + 1);
  }
  return { data, seq, truncated, ...(exit ? { exit } : {}) };
}
