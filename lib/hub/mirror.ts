/**
 * The screen mirror: a headless xterm per PTY, fed the same output the page's terminal gets, so
 * the hub can answer `read_screen` / `read_scrollback` for any tile without asking the page (a
 * parked or scaled tile reads the same as a visible one). Runs in the app's Deno process.
 *
 * @module
 */

import headless from "@xterm/headless";

/** Lines of scrollback a mirror keeps (the page's terminals keep the same). */
const MIRROR_SCROLLBACK = 5000;
/** The most lines one `read_scrollback` returns. */
export const MAX_READ_LINES = 2000;
/** The default `read_scrollback` page. */
const DEFAULT_READ_LINES = 200;

interface HeadlessTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly length: number;
      readonly baseY: number;
      readonly viewportY: number;
      getLine(
        i: number,
      ): { translateToString(trim?: boolean): string } | undefined;
    };
  };
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

type HeadlessCtor = new (options: Record<string, unknown>) => HeadlessTerminal;
const Terminal: HeadlessCtor =
  (headless as unknown as { Terminal?: HeadlessCtor }).Terminal ??
    (headless as unknown as { default: { Terminal: HeadlessCtor } }).default
      .Terminal;

/** A `read_scrollback` page. */
export interface ScrollbackPage {
  /** Lines in the buffer (scrollback + screen). */
  total: number;
  /** The first returned line's index (0 = the oldest line kept). */
  start: number;
  /** The lines, right-trimmed; with `grep`, only the matching ones. */
  lines: { n: number; text: string }[];
}

/** One PTY's mirror. */
export class ScreenMirror {
  #term: HeadlessTerminal;
  /** Resolves once everything written so far has been parsed. */
  #written: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number) {
    this.#term = new Terminal({
      cols,
      rows,
      scrollback: MIRROR_SCROLLBACK,
      allowProposedApi: true,
    });
  }

  write(data: string): void {
    this.#written = new Promise((resolve) => this.#term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    if (cols === this.#term.cols && rows === this.#term.rows) return;
    this.#term.resize(cols, rows);
  }

  /** Wait until all output written so far is on the mirror's screen. */
  flushed(): Promise<void> {
    return this.#written;
  }

  /** The visible screen, one string per row, right-trimmed (trailing blank rows dropped). */
  async screen(): Promise<string[]> {
    await this.flushed();
    const buf = this.#term.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < this.#term.rows; i++) {
      rows.push(lineText(buf, buf.baseY + i));
    }
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows;
  }

  /**
   * A page of the whole buffer. Without `offset`, the last `lines` lines. With `grep` (a regular
   * expression, case-insensitive; a pattern that does not compile is matched literally), only the
   * matching lines of the range, which then defaults to the whole buffer.
   */
  async scrollback(
    opts: { offset?: number; lines?: number; grep?: string } = {},
  ): Promise<ScrollbackPage> {
    await this.flushed();
    const buf = this.#term.buffer.active;
    let total = buf.length;
    // Trailing empty rows below the cursor are not content.
    while (total > 0 && !lineText(buf, total - 1)) {
      total--;
    }
    const want = Math.max(
      1,
      Math.min(opts.lines ?? DEFAULT_READ_LINES, MAX_READ_LINES),
    );
    const match = opts.grep ? grepMatcher(opts.grep) : undefined;
    const start = opts.offset !== undefined
      ? Math.max(0, Math.min(opts.offset, total))
      : match
      ? 0
      : Math.max(0, total - want);
    const lines: { n: number; text: string }[] = [];
    for (let i = start; i < total && lines.length < want; i++) {
      const text = lineText(buf, i);
      if (!match || match(text)) lines.push({ n: i, text });
    }
    return { total, start, lines };
  }

  dispose(): void {
    this.#term.dispose();
  }
}

/** Line `i` of a buffer as text, trailing whitespace dropped. */
function lineText(
  buf: HeadlessTerminal["buffer"]["active"],
  i: number,
): string {
  return (buf.getLine(i)?.translateToString(true) ?? "").trimEnd();
}

/** A line matcher for `grep`: a case-insensitive regular expression, else a literal substring. */
export function grepMatcher(pattern: string): (line: string) => boolean {
  try {
    const re = new RegExp(pattern, "i");
    return (line) => re.test(line);
  } catch {
    const lower = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(lower);
  }
}
