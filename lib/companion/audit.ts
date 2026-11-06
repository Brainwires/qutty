/**
 * The audit log of the companion's privileged actions: every call of a companion-only hub tool
 * (`write_tile`, `spawn_tile`, `close_tile`, `focus_tile`, `deliver`), and every refused attempt
 * by a tile. Entries are appended, never changed: one JSON line each to `companion-audit.jsonl`
 * in the app-support folder (desktop/companion.ts writes it), and the most recent ones are kept
 * in memory for Settings → Companion activity.
 *
 * Client-safe and pure: the writer is injected.
 *
 * @module
 */

import type { PrivilegedCall } from "../hub/protocol.ts";

/** One audit entry. */
export interface AuditEntry extends PrivilegedCall {
  /** Epoch ms. */
  at: number;
}

/** How many entries are kept in memory. */
const AUDIT_MEMORY = 200;
/** The longest string argument kept in an entry (the rest is cut, with its length noted). */
const MAX_ARG = 300;

/** `args` with long strings cut (a pasted script is logged by its start). */
export function summarizeArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" && v.length > MAX_ARG
      ? `${v.slice(0, MAX_ARG)}… (${v.length} chars)`
      : v;
  }
  return out;
}

/** An entry as one JSONL line. */
export function auditLine(entry: AuditEntry): string {
  return JSON.stringify(entry) + "\n";
}

/** The entries of a JSONL text (bad lines skipped), oldest first. */
export function parseAuditLines(text: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (
        typeof v === "object" && v !== null && typeof v.tool === "string" &&
        typeof v.at === "number"
      ) out.push(v as AuditEntry);
    } catch { /* a torn line */ }
  }
  return out;
}

/** The log. */
export class AuditLog {
  #recent: AuditEntry[] = [];
  #append: (line: string) => Promise<void>;
  #chain: Promise<void> = Promise.resolve();
  #onEntry: (entry: AuditEntry) => void;

  /**
   * @param append Appends one line to the file (errors are logged, never thrown).
   * @param onEntry Told about every new entry (the page's activity list).
   */
  constructor(
    append: (line: string) => Promise<void> = () => Promise.resolve(),
    onEntry: (entry: AuditEntry) => void = () => {},
  ) {
    this.#append = append;
    this.#onEntry = onEntry;
  }

  /** Seed the in-memory list (the file's tail, read at start). */
  seed(entries: readonly AuditEntry[]): void {
    this.#recent = [...entries, ...this.#recent].slice(-AUDIT_MEMORY);
  }

  /** Record one call; returns the entry. Appends are written in order. */
  record(call: PrivilegedCall, now = Date.now()): AuditEntry {
    const entry: AuditEntry = {
      at: now,
      ...call,
      args: summarizeArgs(call.args),
    };
    this.#recent.push(entry);
    if (this.#recent.length > AUDIT_MEMORY) this.#recent.shift();
    const line = auditLine(entry);
    this.#chain = this.#chain.then(() => this.#append(line)).catch((e) => {
      console.error("companion: audit log write failed", e);
    });
    try {
      this.#onEntry(entry);
    } catch { /* a listener never fails the log */ }
    return entry;
  }

  /** The last `n` entries, newest first. */
  recent(n = 50): AuditEntry[] {
    return this.#recent.slice(-n).reverse().map((e) => ({ ...e }));
  }

  /** Wait for the pending writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.#chain;
  }
}
