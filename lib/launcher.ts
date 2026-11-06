/**
 * The `+` button's picker, kept pure so it is unit-testable without a DOM or a file system: the
 * agent tools Qutty looks for, how `/etc/shells` becomes a deduplicated shell list, the menu's
 * entries and ids, keyboard movement through it, and what plain `+` opens.
 *
 * The backend (`launchables` in desktop/pty.ts) does the probing (which paths exist, are
 * executable, and where they really point) and hands the facts to {@linkcode buildShells}; the
 * demo backend returns canned facts so the UI and the e2e suite run in a plain browser.
 *
 * @module
 */

import { baseName } from "./ssh-ui.ts";
import {
  type OllamaPair,
  pairEntryId,
  pairOfEntryId,
  pairTitle,
} from "./ollama/settings.ts";
import { harnessLabel } from "./ollama/harnesses.ts";

// ---------------------------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------------------------

/** An agent or CLI tool the picker offers when it is installed. */
export interface AgentToolSpec {
  /** The executable's name, looked up on `PATH` and the user bin folders (also the tile's title). */
  name: string;
  /** What the menu calls it. */
  label: string;
}

/**
 * The tools looked for, in menu order. Add a line to offer another one: it launches directly as
 * the terminal's program (no shell around it), and its tile closes when it exits.
 */
export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  { name: "claude", label: "Claude Code" },
  { name: "codex", label: "Codex" },
  { name: "gemini", label: "Gemini CLI" },
  { name: "aider", label: "Aider" },
  { name: "opencode", label: "opencode" },
  { name: "hermes", label: "Hermes Agent" },
  { name: "openclaw", label: "OpenClaw" },
];

/**
 * Folders under the home directory where tools are commonly installed (the official Claude Code
 * installer, npm/pnpm/bun/deno/cargo globals, `~/bin`). A Finder-launched app's `PATH` has none
 * of them, so they are searched after `PATH` and the system bin folders.
 */
const USER_BIN_DIRS: readonly string[] = [
  ".local/bin",
  ".claude/local",
  ".npm-global/bin",
  ".local/share/pnpm",
  "Library/pnpm",
  ".bun/bin",
  ".deno/bin",
  ".cargo/bin",
  ".volta/bin",
  "bin",
];

/** {@linkcode USER_BIN_DIRS} as absolute paths under `home` (none without a home). */
export function userBinDirs(home: string | undefined): string[] {
  if (!home || !home.startsWith("/")) return [];
  const base = home.replace(/\/+$/, "");
  return USER_BIN_DIRS.map((d) => `${base}/${d}`);
}

// ---------------------------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------------------------

/** The absolute paths listed in an `/etc/shells` text, in order, without repeats or comments. */
export function parseEtcShells(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.startsWith("/") && !/\s/.test(line) && !out.includes(line)) {
      out.push(line);
    }
  }
  return out;
}

/** A shell path as the backend found it: `real` is its resolved path, absent when unusable. */
export interface ShellProbe {
  path: string;
  /** `realpath(path)`, set only when the path exists and is an executable file. */
  real?: string;
}

/** One shell the picker offers. */
export interface ShellInfo {
  /** The path it is started with (as a login shell). */
  path: string;
  /** Its name (`zsh`, `bash`). */
  label: string;
  /** Whether it is the user's default (`$SHELL`), which plain `+` opens. */
  isDefault: boolean;
}

/**
 * The shells to offer from the probed `/etc/shells` entries (plus the default shell, which is
 * offered even when `/etc/shells` lacks it): unusable ones dropped, and one per real file, since
 * a merged-/usr system lists `/bin/sh` and `/usr/bin/sh` for the same program. Of a group, the
 * default shell's own path is kept, else the first listed. The default comes first, then by
 * name, then by path.
 */
export function buildShells(
  probes: readonly ShellProbe[],
  defaultShell: ShellProbe | undefined,
): ShellInfo[] {
  const all = defaultShell ? [...probes, defaultShell] : [...probes];
  const defaultReal = defaultShell?.real;
  const byReal = new Map<string, string>();
  for (const p of all) {
    if (!p.real) continue;
    const kept = byReal.get(p.real);
    const isDefaultPath = p.path === defaultShell?.path;
    if (kept === undefined || isDefaultPath) byReal.set(p.real, p.path);
  }
  const shells = [...byReal].map(([real, path]): ShellInfo => ({
    path,
    label: baseName(path),
    isDefault: defaultReal !== undefined && real === defaultReal,
  }));
  return shells.sort((a, b) =>
    Number(b.isDefault) - Number(a.isDefault) ||
    a.label.localeCompare(b.label) ||
    a.path.localeCompare(b.path)
  );
}

// ---------------------------------------------------------------------------------------------
// What the backend reports
// ---------------------------------------------------------------------------------------------

/** An installed agent tool. */
export interface AgentInfo {
  name: string;
  label: string;
  /** The resolved executable. */
  path: string;
}

/** The `launchables` result: what the picker can start on this machine. */
export interface Launchables {
  shells: ShellInfo[];
  agents: AgentInfo[];
}

/** The agent tools that were found, in {@linkcode AGENT_TOOLS} order. */
export function buildAgents(
  found: ReadonlyMap<string, string>,
  tools: readonly AgentToolSpec[] = AGENT_TOOLS,
): AgentInfo[] {
  return tools.flatMap((t) => {
    const path = found.get(t.name);
    return path ? [{ name: t.name, label: t.label, path }] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------------------------

/** An SSH host as the picker lists it (from the connection data). */
export interface LaunchHost {
  alias: string;
  tint?: string;
}

/** One thing the picker can start. `id` is stable across runs (it is what settings remember). */
export type LaunchEntry =
  | {
    kind: "shell";
    id: string;
    label: string;
    detail: string;
    shell: ShellInfo;
  }
  | {
    kind: "agent";
    id: string;
    label: string;
    detail: string;
    agent: AgentInfo;
  }
  | {
    kind: "ssh";
    id: string;
    label: string;
    detail: string;
    host: LaunchHost;
  }
  | {
    kind: "ollama";
    id: string;
    label: string;
    detail: string;
    pair: OllamaPair;
  };

/** A titled group of the menu. */
export interface LaunchSection {
  id: "shells" | "agents" | "ollama" | "ssh";
  title: string;
  entries: LaunchEntry[];
}

const shellEntryId = (path: string) => `shell:${path}`;
const agentEntryId = (name: string) => `agent:${name}`;
const sshEntryId = (alias: string) => `ssh:${alias}`;

/** What the Ollama helper can launch now: its pairs, the installed harnesses, the pulled models. */
export interface OllamaLaunchables {
  /** Candidate pairs, in menu order (recent first; repeats are dropped). */
  pairs: readonly OllamaPair[];
  harnesses: ReadonlySet<string>;
  models: ReadonlySet<string>;
}

/** The Ollama pairs that can start now (harness installed, model pulled), without repeats. */
export function ollamaEntries(o: OllamaLaunchables): LaunchEntry[] {
  const out: LaunchEntry[] = [];
  for (const pair of o.pairs) {
    const id = pairEntryId(pair);
    if (
      !o.harnesses.has(pair.harness) || !o.models.has(pair.model) ||
      out.some((e) => e.id === id)
    ) continue;
    out.push({
      kind: "ollama",
      id,
      label: pairTitle(pair),
      detail: `ollama launch ${pair.harness} --model ${pair.model} (${
        harnessLabel(pair.harness)
      })`,
      pair: { harness: pair.harness, model: pair.model },
    });
  }
  return out;
}

/**
 * The menu's sections, empty ones left out: shells, agent tools, Ollama pairs, then SSH hosts.
 * The Ollama section is kept, even empty, whenever `ollama` is given (Ollama is installed): the
 * menu adds its "Ollama models…" item to it, which is not an entry.
 */
export function launchSections(
  found: Launchables,
  hosts: readonly LaunchHost[],
  ollama?: OllamaLaunchables,
): LaunchSection[] {
  const sections: LaunchSection[] = [
    {
      id: "shells",
      title: "Shells",
      entries: found.shells.map((shell) => ({
        kind: "shell",
        id: shellEntryId(shell.path),
        label: shell.label,
        detail: shell.isDefault ? `${shell.path} · default` : shell.path,
        shell,
      })),
    },
    {
      id: "agents",
      title: "Agents",
      entries: found.agents.map((agent) => ({
        kind: "agent",
        id: agentEntryId(agent.name),
        label: agent.label,
        detail: agent.name,
        agent,
      })),
    },
    {
      id: "ollama",
      title: "Ollama",
      entries: ollama ? ollamaEntries(ollama) : [],
    },
    {
      id: "ssh",
      title: "SSH",
      entries: hosts.map((host) => ({
        kind: "ssh",
        id: sshEntryId(host.alias),
        label: host.alias,
        detail: "ssh",
        host,
      })),
    },
  ];
  // The Ollama section stays while Ollama is there, for the menu's "Ollama models…" item.
  return sections.filter((s) =>
    s.entries.length > 0 || (s.id === "ollama" && ollama !== undefined)
  );
}

/** Every entry of the sections, top to bottom. */
export function flatEntries(sections: readonly LaunchSection[]): LaunchEntry[] {
  return sections.flatMap((s) => s.entries);
}

/** The next index for ↑ (`-1`) / ↓ (`1`) in a list of `count` rows, wrapping; `-1` when empty. */
export function moveIndex(count: number, index: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return dir === 1 ? 0 : count - 1;
  return (index + dir + count) % count;
}

// ---------------------------------------------------------------------------------------------
// What plain `+` opens
// ---------------------------------------------------------------------------------------------

/** The setting: the default shell, the last thing picked, or one entry (by id). */
export type PlusOpens = "default" | "last" | string;

/** Longest entry id a setting keeps (a path or an alias, with its prefix). */
const MAX_ENTRY_ID = 1024;

/** Whether `v` looks like an entry id (`shell:`, `agent:`, `ssh:` plus something, or an Ollama pair). */
export function isEntryId(v: unknown): v is string {
  if (typeof v !== "string" || v.length > MAX_ENTRY_ID || v.includes("\0")) {
    return false;
  }
  return v.startsWith("ollama:")
    ? pairOfEntryId(v) !== undefined
    : /^(shell|agent|ssh):./.test(v);
}

/** A stored `plusOpens` value, checked (anything unknown is `"default"`). */
export function sanitizePlusOpens(v: unknown): PlusOpens {
  return v === "default" || v === "last" || isEntryId(v) ? v : "default";
}

/**
 * The entry plain `+` starts, or `undefined` for the default login shell: the configured or
 * last-picked entry while it is still available (a tool uninstalled, a host deleted, or a list
 * not loaded yet all fall back to the default shell).
 */
export function plusEntry(
  plusOpens: PlusOpens,
  lastLaunch: string | null,
  entries: readonly LaunchEntry[],
): LaunchEntry | undefined {
  const id = plusOpens === "default"
    ? undefined
    : plusOpens === "last"
    ? lastLaunch ?? undefined
    : plusOpens;
  if (id === undefined) return undefined;
  const entry = entries.find((e) => e.id === id);
  // The default shell's own entry is the same as no entry.
  return entry?.kind === "shell" && entry.shell.isDefault ? undefined : entry;
}

/** The `+` button's tooltip: what plain `+` will open. */
export function plusLabel(entry: LaunchEntry | undefined): string {
  if (!entry) return "New terminal";
  return entry.kind === "ssh"
    ? `New: ssh ${entry.label}`
    : entry.kind === "ollama"
    ? `New: ${entry.label} (Ollama)`
    : `New: ${entry.label}`;
}
