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
import { type AgentKind, agentLabel } from "./agent/adapter.ts";

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

// ---------------------------------------------------------------------------------------------
// The menu's submenus
// ---------------------------------------------------------------------------------------------

/** The `+` menu's submenus, in menu order. */
export type LaunchGroupId = "web" | "shell" | "ssh" | "terminal" | "coding";

/** What a submenu row that is not a launch entry does. */
export type LaunchCommand =
  /** Web Browser → Open: a new web tile. */
  | { kind: "webPage" }
  /** Web Browser → History: the pages web tiles visited (app/history-dialog.tsx). */
  | { kind: "webHistory" }
  /** Web Browser → Bookmark Manager (app/bookmark-manager.tsx). */
  | { kind: "webBookmarks" }
  /** SSH → Connections Manager (app/connections-dialog.tsx). */
  | { kind: "connections" }
  /** Coding → an agent chat tile (app/agent-tile.tsx) on `agent`, with a preset's id or none. */
  | { kind: "agentChat"; agent: AgentKind; presetId?: string }
  /** Coding → "Ollama models…" (app/ollama-dialog.tsx). */
  | { kind: "ollamaModels" };

/** A submenu row that is not a launch entry. */
export interface LaunchCommandNode {
  type: "command";
  /** Stable within the menu (the page's test id is made from it). */
  id: string;
  label: string;
  /** Its tooltip: what it opens. */
  detail: string;
  command: LaunchCommand;
  /** A preset, listed under its backend's row. */
  preset?: boolean;
}

/** One row of a submenu. */
export type LaunchNode =
  /** A launch entry (a shell, an agent tool in a terminal, an SSH host, an Ollama pair). */
  | { type: "entry"; entry: LaunchEntry; detail: string }
  | LaunchCommandNode
  | { type: "separator" };

/** One submenu of the `+` menu. */
export interface LaunchGroup {
  id: LaunchGroupId;
  title: string;
  /** Its tooltip: what it holds. */
  detail: string;
  items: LaunchNode[];
}

/** What the submenus offer besides the backend's entries. */
export interface LaunchTreeOptions {
  /** Web Browser's rows: Open (the native web engine), History and Bookmark Manager (any engine). */
  web?: { open?: boolean; history?: boolean; bookmarks?: boolean };
  /** Agent chat tiles can open: Coding lists the installed backends. */
  chat?: boolean;
  /** Ollama is installed: Coding → Ollama and "Ollama models…". */
  ollama?: boolean;
  /** An Anthropic API key is saved: Coding → Anthropic API. */
  anthropic?: boolean;
  /** Settings → Agents → Presets, each under its backend's row (`agent` absent: Claude Code's). */
  presets?: readonly { id: string; name: string; agent?: AgentKind }[];
}

/** A Coding row's tooltip. */
function chatDetail(agent: AgentKind): string {
  switch (agent) {
    case "claude":
      return "Qutty's chat view; Claude Code runs headless";
    case "codex":
      return "Qutty's chat view; Codex runs headless (app-server)";
    case "ollama":
      return "Qutty's chat view on a local Ollama model";
    case "anthropic":
      return "Qutty's chat view on the Anthropic API, with your saved key";
  }
}

/** A launch entry's row, with the tooltip saying what it opens. */
function entryNode(entry: LaunchEntry): LaunchNode {
  const detail = entry.kind === "shell"
    ? entry.shell.isDefault
      ? `A terminal running ${entry.shell.path}, your default shell`
      : `A terminal running ${entry.shell.path}`
    : entry.kind === "agent"
    ? `${entry.label} in a terminal, with Qutty's overlay`
    : entry.kind === "ssh"
    ? `ssh ${entry.label} in a new terminal`
    : `${entry.detail}, in a terminal with Qutty's overlay`;
  return { type: "entry", entry, detail };
}

/** The runs of rows, a separator between the non-empty ones. */
function joinRuns(runs: readonly LaunchNode[][]): LaunchNode[] {
  const out: LaunchNode[] = [];
  for (const run of runs) {
    if (run.length === 0) continue;
    if (out.length > 0) out.push({ type: "separator" });
    out.push(...run);
  }
  return out;
}

/** A command row. */
const commandNode = (
  id: string,
  label: string,
  detail: string,
  command: LaunchCommand,
  preset = false,
): LaunchCommandNode => ({
  type: "command",
  id,
  label,
  detail,
  command,
  ...(preset ? { preset } : {}),
});

/** Coding's row for `agent`, then its presets. */
function chatRows(
  agent: AgentKind,
  presets: LaunchTreeOptions["presets"],
): LaunchNode[] {
  return [
    commandNode(
      agent === "claude" ? "agent-chat" : `agent-chat-${agent}`,
      agentLabel(agent),
      chatDetail(agent),
      { kind: "agentChat", agent },
    ),
    ...(presets ?? []).filter((p) => (p.agent ?? "claude") === agent).map((
      p,
    ) =>
      commandNode(
        `agent-preset:${p.id}`,
        p.name,
        `Qutty's chat view with the "${p.name}" preset (Settings → Agents)`,
        { kind: "agentChat", agent, presetId: p.id },
        true,
      )
    ),
  ];
}

/** Web Browser's rows. */
function webRows(web: LaunchTreeOptions["web"] = {}): LaunchNode[] {
  return [
    ...(web.open
      ? [commandNode("web", "Open", "A web page in a new tile", {
        kind: "webPage",
      })]
      : []),
    ...(web.history
      ? [commandNode("history", "History", "The pages web tiles visited", {
        kind: "webHistory",
      })]
      : []),
    ...(web.bookmarks
      ? [commandNode(
        "bookmarks",
        "Bookmark Manager",
        "Manage, import and export the web tiles' bookmarks",
        { kind: "webBookmarks" },
      )]
      : []),
  ];
}

/**
 * The `+` menu as submenus, empty ones left out: Web Browser (Open, History, Bookmark Manager),
 * Shell (the default shell first, then the rest), SSH (Connections Manager, then the saved
 * hosts), Terminal (the agent tools, run in a terminal tile with Qutty's overlay, then the Ollama
 * pairs) and Coding (an agent chat tile on each installed backend, each with its presets, then
 * "Ollama models…"). The page's menu (app/launch-menu.tsx) and the native Shell → New Tile With
 * (lib/workspace/menus.ts) both draw it.
 */
export function launchTree(
  sections: readonly LaunchSection[],
  opts: LaunchTreeOptions = {},
): LaunchGroup[] {
  const of = (id: LaunchSection["id"]) =>
    sections.find((s) => s.id === id)?.entries ?? [];
  const agents = of("agents");
  const installed = (name: string) =>
    agents.some((e) => e.kind === "agent" && e.agent.name === name);
  const chats: AgentKind[] = opts.chat
    ? (["claude", "codex", "ollama", "anthropic"] as const).filter((a) =>
      a === "ollama"
        ? opts.ollama === true
        : a === "anthropic"
        ? opts.anthropic === true
        : installed(a)
    )
    : [];
  const groups: LaunchGroup[] = [
    {
      id: "web",
      title: "Web Browser",
      detail: "Web tiles: a new page, the pages they visited, their bookmarks",
      items: webRows(opts.web),
    },
    {
      id: "shell",
      title: "Shell",
      detail: "A new terminal running a shell",
      items: of("shells").map(entryNode),
    },
    {
      id: "ssh",
      title: "SSH",
      detail: "The SSH Connections Manager and your saved hosts",
      items: joinRuns([
        [commandNode(
          "connections",
          "Connections Manager",
          "Saved hosts, quick connect, port forwards",
          { kind: "connections" },
        )],
        of("ssh").map(entryNode),
      ]),
    },
    {
      id: "terminal",
      title: "Terminal",
      detail: "Coding agents' own terminal apps, with Qutty's overlay",
      items: joinRuns([agents.map(entryNode), of("ollama").map(entryNode)]),
    },
    {
      id: "coding",
      title: "Coding",
      detail: "Qutty's chat view, with the agent running headless",
      items: joinRuns([
        chats.flatMap((a) => chatRows(a, opts.presets)),
        opts.ollama
          ? [commandNode(
            "ollama",
            "Ollama models…",
            "Pick a harness and a local model, browse the Ollama library, pull a model",
            { kind: "ollamaModels" },
          )]
          : [],
      ]),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** How long the pointer rests on a submenu's row before the submenu opens (hover intent). */
export const SUBMENU_OPEN_MS = 120;
/**
 * How long the pointer rests on another row before an open submenu gives way: long enough that
 * a diagonal move from the row into the submenu, across its neighbours, keeps it open.
 */
export const SUBMENU_SWITCH_MS = 300;

/** A box in viewport pixels. */
export interface FlyoutBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where a submenu of `size` goes beside row `row` of a menu whose box is `menu`, in a viewport of
 * `view` with `margin` to spare: beside the menu on the `prefer` side (the right by default),
 * flipped to the other side when it does not fit there, its top level with the row's and moved
 * up when it would run off the bottom. When neither side fits it goes against the viewport's
 * edge on the side with more room, over the menu.
 */
export function flyoutPosition(
  row: FlyoutBox,
  menu: FlyoutBox,
  size: { width: number; height: number },
  view: { width: number; height: number },
  opts: { prefer?: "left" | "right"; margin?: number; gap?: number } = {},
): { left: number; top: number; side: "left" | "right" } {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 2;
  const right = menu.right + gap;
  const left = menu.left - gap - size.width;
  const fitsRight = right + size.width <= view.width - margin;
  const fitsLeft = left >= margin;
  let side = opts.prefer ?? "right";
  if (side === "right" && !fitsRight && fitsLeft) side = "left";
  if (side === "left" && !fitsLeft && fitsRight) side = "right";
  let x = side === "right" ? right : left;
  if (!fitsRight && !fitsLeft) {
    side = menu.left > view.width - menu.right ? "left" : "right";
    x = side === "left"
      ? margin
      : Math.max(margin, view.width - margin - size.width);
  }
  // The row's top, less the menu's padding, so the first item lines up with the row.
  const top = Math.max(
    margin,
    Math.min(row.top - 5, view.height - margin - size.height),
  );
  return { left: Math.round(x), top: Math.round(top), side };
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
