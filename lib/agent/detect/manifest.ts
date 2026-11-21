/**
 * Agent detection manifests: per coding agent, data (not code) that says how to recognise it in a
 * terminal and read its state off the screen. The bundled ones are JSON files in
 * resources/agent-detection/ (shipped as lib/agent/detect/bundled.ts); a user's own, in
 * `<appSupportDir>/agent-detection/<agent>.json|toml`, replace a bundled one of the same `id`
 * (lib/agent/detect/overrides.ts). docs/agent-detection.md describes the format.
 *
 * A manifest:
 *
 * ```json
 * {
 *   "id": "claude",
 *   "label": "Claude Code",
 *   "confidence": "high",
 *   "process": { "names": ["claude"], "argv": ["(^|/)claude$"] },
 *   "lines": 15,
 *   "interrupt": "esc",
 *   "working": [{ "id": "esc-to-interrupt", "text": "esc to interrupt" }],
 *   "blocked": [{ "id": "proceed", "regex": "Do you want to (proceed|make this edit)" }],
 *   "idle": [{ "id": "prompt", "regex": "^\\s*>\\s" }]
 * }
 * ```
 *
 * - `process.names`: foreground process names (the basename, case-insensitive); `process.argv`:
 *   regular expressions tested against each of the foreground process's first three arguments (a
 *   CLI that runs as `node /usr/local/bin/gemini` is `node` to the OS).
 * - `working` / `blocked` / `idle`: matchers over the bottom `lines` lines of the screen (default
 *   15). A matcher has `text` (a case-insensitive substring of one line), `regex` (with optional
 *   `flags`, tested per line) or `all` (case-insensitive substrings that must all appear in the
 *   window), and may look at fewer lines (`lines`: the last N of the window).
 * - `interrupt`: `esc` (the default) or `ctrl-c`.
 *
 * Pure and client-safe (no TOML here: the page imports this for the process matchers).
 *
 * @module
 */

/** What a screen says an agent is doing. */
export type ScreenState = "working" | "blocked" | "idle";

/** The screen states, in the order a screen is checked (a strict approval UI first). */
const SCREEN_STATES: readonly ScreenState[] = [
  "blocked",
  "working",
  "idle",
];

/** One matcher, compiled. */
export interface Matcher {
  /** Its name (shown by the debug command); `<state>-<n>` when the manifest gave none. */
  id: string;
  test(line: string): boolean;
  /**
   * An `all` matcher: every one of these (lower-case) texts appears somewhere in the window, not
   * necessarily on one line (an approval menu's question and its footer).
   */
  all?: string[];
  /** Only the last `lines` lines of the window. */
  lines?: number;
}

/** A manifest, checked and compiled. */
export interface AgentManifest {
  id: string;
  label: string;
  /** `low`: written without the agent's real UI strings to hand. */
  confidence: "high" | "low";
  processNames: string[];
  processArgv: RegExp[];
  /** How many lines at the bottom of the screen are read. */
  lines: number;
  /** What the overlay's Interrupt sends. */
  interrupt: string;
  matchers: Record<ScreenState, Matcher[]>;
}

/** The default window: the bottom 15 lines. */
const DEFAULT_LINES = 15;
/** The most lines a manifest may ask for (the cost stays low). */
const MAX_LINES = 60;

const INTERRUPTS: Record<string, string> = {
  esc: "\x1b",
  "ctrl-c": "\x03",
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A manifest problem, with where it is. */
export class ManifestError extends Error {
  override name = "ManifestError";
}

function regex(source: unknown, flags: unknown, where: string): RegExp {
  if (typeof source !== "string" || source === "") {
    throw new ManifestError(`${where}: a regex is a non-empty string`);
  }
  const f = typeof flags === "string" ? flags : "";
  if (!/^[imsu]*$/.test(f)) {
    throw new ManifestError(`${where}: flags may only be i, m, s and u`);
  }
  try {
    return new RegExp(source, f);
  } catch (e) {
    throw new ManifestError(
      `${where}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function matcherOf(v: unknown, state: ScreenState, n: number): Matcher {
  const where = `${state}[${n}]`;
  const m = typeof v === "string" ? { text: v } : v;
  if (!isObject(m)) {
    throw new ManifestError(`${where}: a matcher is an object or a string`);
  }
  const id = typeof m.id === "string" && m.id !== "" ? m.id : `${state}-${n}`;
  const lines = Number.isInteger(m.lines) && (m.lines as number) > 0
    ? { lines: m.lines as number }
    : {};
  if (typeof m.text === "string" && m.text !== "") {
    const lower = m.text.toLowerCase();
    return {
      id,
      test: (line) => line.toLowerCase().includes(lower),
      ...lines,
    };
  }
  if (m.regex !== undefined) {
    const re = regex(m.regex, m.flags, where);
    return { id, test: (line) => re.test(line), ...lines };
  }
  if (m.all !== undefined) {
    const all = strings(m.all, `${where}.all`).map((s) => s.toLowerCase());
    if (all.length === 0) throw new ManifestError(`${where}.all: empty`);
    return { id, test: () => false, all, ...lines };
  }
  throw new ManifestError(
    `${where}: a matcher needs "text", "regex" or "all"`,
  );
}

function matchersOf(v: unknown, state: ScreenState): Matcher[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ManifestError(`${state}: a list`);
  return v.map((m, i) => matcherOf(m, state, i));
}

function strings(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
    throw new ManifestError(`${where}: a list of strings`);
  }
  return v as string[];
}

/**
 * A manifest from its parsed JSON or TOML; throws a {@linkcode ManifestError} saying what is
 * wrong. `fallbackId` names one without an `id` (a user file's name).
 */
export function compileManifest(
  raw: unknown,
  fallbackId?: string,
): AgentManifest {
  if (!isObject(raw)) throw new ManifestError("a manifest is an object");
  const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : fallbackId;
  if (!id || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(id)) {
    throw new ManifestError(
      "id: lower-case letters, digits, '.', '_' and '-' (at most 40)",
    );
  }
  const proc = raw.process === undefined ? {} : raw.process;
  if (!isObject(proc)) throw new ManifestError("process: an object");
  const lines = raw.lines ?? DEFAULT_LINES;
  if (
    !Number.isInteger(lines) || (lines as number) < 1 ||
    (lines as number) > MAX_LINES
  ) {
    throw new ManifestError(`lines: 1 to ${MAX_LINES}`);
  }
  const interruptName = raw.interrupt === undefined ? "esc" : raw.interrupt;
  const interrupt = typeof interruptName === "string"
    ? INTERRUPTS[interruptName]
    : undefined;
  if (interrupt === undefined) {
    throw new ManifestError(`interrupt: "esc" or "ctrl-c"`);
  }
  const matchers = {
    working: matchersOf(raw.working, "working"),
    blocked: matchersOf(raw.blocked, "blocked"),
    idle: matchersOf(raw.idle, "idle"),
  };
  return {
    id,
    label: typeof raw.label === "string" && raw.label !== "" ? raw.label : id,
    confidence: raw.confidence === "low" ? "low" : "high",
    processNames: strings(proc.names, "process.names").map((s) =>
      s.toLowerCase()
    ),
    processArgv: strings(proc.argv, "process.argv").map((s, i) =>
      regex(s, undefined, `process.argv[${i}]`)
    ),
    lines: lines as number,
    interrupt,
    matchers,
  };
}

/** What is known about a terminal's foreground process. */
export interface ForegroundProcess {
  /** Its name (`claude`, `node`, `/usr/bin/aider`). */
  name: string;
  /** Its arguments, when the OS said (`["node", "/opt/homebrew/bin/gemini"]`). */
  argv?: readonly string[];
}

/** The base name of a process (`-zsh` → `zsh`, `/usr/bin/aider` → `aider`), lower-case. */
function processBase(name: string): string {
  return (name.trim().split("/").pop() ?? "").replace(/^-/, "").toLowerCase();
}

/** The manifest whose process matchers match `fg`, or `undefined`. Names win over argv. */
export function agentForProcess(
  manifests: readonly AgentManifest[],
  fg: ForegroundProcess,
): AgentManifest | undefined {
  const base = processBase(fg.name);
  const byName = manifests.find((m) => m.processNames.includes(base));
  if (byName) return byName;
  const args = (fg.argv ?? []).slice(0, 3);
  if (args.length === 0) return undefined;
  return manifests.find((m) =>
    m.processArgv.some((re) => args.some((a) => re.test(a)))
  );
}

/** Which matcher said what. */
export interface ScreenVerdict {
  state: ScreenState;
  /** The matcher that fired; `null`: none did, so the screen counts as idle. */
  matcher: string | null;
  /** The line it fired on. */
  line?: string;
}

/**
 * What `screen` (the visible rows, top to bottom) says the agent is doing. Only the bottom
 * `manifest.lines` rows are read. `blocked` needs one of its matchers to fire (an approval UI is
 * never guessed); then `working`, then `idle`; a screen nothing matches is idle.
 */
export function readScreen(
  manifest: AgentManifest,
  screen: readonly string[],
): ScreenVerdict {
  const window = screen.slice(-manifest.lines);
  for (const state of SCREEN_STATES) {
    for (const m of manifest.matchers[state]) {
      const lines = m.lines ? window.slice(-m.lines) : window;
      if (m.all) {
        const text = lines.join("\n").toLowerCase();
        if (m.all.every((t) => text.includes(t))) {
          return { state, matcher: m.id };
        }
        continue;
      }
      const line = lines.find((l) => m.test(l));
      if (line !== undefined) return { state, matcher: m.id, line };
    }
  }
  return { state: "idle", matcher: null };
}
