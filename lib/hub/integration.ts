/**
 * Settings → Agent integration: the user-scope registration that connects an agent started by
 * hand in any tile (not just one launched from the `+` picker) to the hub.
 *
 * - Claude Code: `mcpServers.qutty` in `~/.claude.json` (what `claude mcp add --scope user`
 *   writes) and a `qutty-hook` group per event under `hooks` in `~/.claude/settings.json`;
 * - Codex: an `[mcp_servers.qutty]` table in `~/.codex/config.toml`, between marker comments.
 *
 * These are the user's own files, so the rules are strict: everything else in them is kept as
 * it was (JSON is re-serialised with the file's own indentation, which is byte-identical for the
 * files those tools write; TOML is edited as text); Install is idempotent; Uninstall removes
 * exactly Qutty's entries, and the containers it created (recorded in `~/.qutty/integration.json`),
 * so install + uninstall gives back the original bytes; the first change to a file copies it to
 * `<file>.qutty-backup` (an existing backup is kept); a symlinked file is edited at its target.
 * An entry named `qutty` that Qutty did not write is left alone and reported.
 *
 * File access goes through {@linkcode ConfigFs} (libc writes in the app, Deno APIs in tests).
 *
 * @module
 */

import type { IntegrationStatus, IntegrationTarget } from "./protocol.ts";
import {
  claudeHooks,
  claudeMcpEntry,
  hookCommand,
  type HubPaths,
  tomlString,
} from "./launch.ts";

/** The file operations the installer needs. */
export interface ConfigFs {
  /** The file's text, or `undefined` when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Write atomically with `mode`, creating the parent folder if needed. */
  write(path: string, text: string, mode: number): Promise<void>;
  /** Remove a file (only a file Qutty created). */
  remove(path: string): Promise<void>;
  /** The file's permission bits, or `undefined` when it does not exist. */
  mode(path: string): Promise<number | undefined>;
  /** Where a symlink points (the path itself when it is not one or does not exist). */
  realPath(path: string): Promise<string>;
}

/** What Install created, so Uninstall can remove exactly that (`~/.qutty/integration.json`). */
interface IntegrationState {
  claudeJsonCreated?: boolean;
  mcpServersCreated?: boolean;
  settingsCreated?: boolean;
  hooksCreated?: boolean;
  /** Hook events whose arrays Qutty created. */
  eventsCreated?: string[];
  codexCreated?: boolean;
  /** A newline Qutty added before its block (the file did not end with one). */
  codexNewlineAdded?: boolean;
}

/** The files, for a home folder. */
export interface IntegrationFiles {
  home: string;
  claudeJson: string;
  claudeSettings: string;
  codexConfig: string;
  state: string;
}

export function integrationFiles(
  home: string,
  paths: HubPaths,
): IntegrationFiles {
  const h = home.replace(/\/+$/, "");
  return {
    home: h,
    claudeJson: `${h}/.claude.json`,
    claudeSettings: `${h}/.claude/settings.json`,
    codexConfig: `${h}/.codex/config.toml`,
    state: `${paths.dir}/integration.json`,
  };
}

// ---------------------------------------------------------------------------------------------
// JSON, keeping the file's format
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface JsonFormat {
  indent: string;
  newline: boolean;
}

function jsonFormat(text: string): JsonFormat {
  const m = text.match(/^\{\r?\n([ \t]+)\S/);
  return { indent: m ? m[1] : "  ", newline: text.endsWith("\n") };
}

function parseObject(text: string, path: string): Json {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; fix it first`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${path} does not hold a JSON object`);
  }
  return v as Json;
}

function serialize(v: Json, fmt: JsonFormat): string {
  return JSON.stringify(v, null, fmt.indent) + (fmt.newline ? "\n" : "");
}

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Claude Code: ~/.claude.json mcpServers.qutty
// ---------------------------------------------------------------------------------------------

/** Whether a `mcpServers.qutty` entry is Qutty's (it runs our qutty-mcp). */
function isOurMcp(entry: unknown, paths: HubPaths): boolean {
  return isObject(entry) && entry.command === paths.mcp;
}

/** `~/.claude.json` with Qutty's server added (`text` undefined: the file does not exist). */
function addClaudeMcp(
  text: string | undefined,
  paths: HubPaths,
  state: IntegrationState,
): string {
  const fmt = text === undefined
    ? { indent: "  ", newline: true }
    : jsonFormat(text);
  const doc = text === undefined ? {} : parseObject(text, "~/.claude.json");
  if (text === undefined) state.claudeJsonCreated = true;
  if (!isObject(doc.mcpServers)) {
    if (doc.mcpServers !== undefined) {
      throw new Error("~/.claude.json has an mcpServers that is not an object");
    }
    doc.mcpServers = {};
    state.mcpServersCreated = true;
  }
  const servers = doc.mcpServers as Json;
  if (servers.qutty !== undefined && !isOurMcp(servers.qutty, paths)) {
    throw new Error(
      "~/.claude.json already has an MCP server named qutty that Qutty did not add",
    );
  }
  servers.qutty = claudeMcpEntry(paths.mcp);
  return serialize(doc, fmt);
}

/** `~/.claude.json` without Qutty's server (`undefined`: remove the file Qutty created). */
function removeClaudeMcp(
  text: string,
  paths: HubPaths,
  state: IntegrationState,
): string | undefined {
  const doc = parseObject(text, "~/.claude.json");
  const servers = doc.mcpServers;
  if (!isObject(servers) || !isOurMcp(servers.qutty, paths)) return text;
  delete servers.qutty;
  if (Object.keys(servers).length === 0 && state.mcpServersCreated) {
    delete doc.mcpServers;
  }
  if (Object.keys(doc).length === 0 && state.claudeJsonCreated) {
    return undefined;
  }
  return serialize(doc, jsonFormat(text));
}

// ---------------------------------------------------------------------------------------------
// Claude Code: ~/.claude/settings.json hooks
// ---------------------------------------------------------------------------------------------

function isOurHandler(h: unknown, paths: HubPaths): boolean {
  return isObject(h) && h.type === "command" &&
    typeof h.command === "string" && h.command === hookCommand(paths);
}

function hasOurGroup(groups: unknown, paths: HubPaths): boolean {
  return Array.isArray(groups) &&
    groups.some((g) =>
      isObject(g) && Array.isArray(g.hooks) &&
      g.hooks.some((h) => isOurHandler(h, paths))
    );
}

/** The hook events that have Qutty's group. */
function installedHookEvents(
  text: string | undefined,
  paths: HubPaths,
): string[] {
  if (text === undefined) return [];
  let doc: Json;
  try {
    doc = parseObject(text, "settings.json");
  } catch {
    return [];
  }
  const hooks = isObject(doc.hooks) ? doc.hooks : {};
  return Object.keys(claudeHooks(paths)).filter((e) =>
    hasOurGroup(hooks[e], paths)
  );
}

/** `settings.json` with a `qutty-hook` group appended to each event (one per event, at most). */
function addClaudeHooks(
  text: string | undefined,
  paths: HubPaths,
  state: IntegrationState,
): string {
  const fmt = text === undefined
    ? { indent: "  ", newline: true }
    : jsonFormat(text);
  const doc = text === undefined
    ? {}
    : parseObject(text, "~/.claude/settings.json");
  if (text === undefined) state.settingsCreated = true;
  if (!isObject(doc.hooks)) {
    if (doc.hooks !== undefined) {
      throw new Error(
        "~/.claude/settings.json has a hooks value that is not an object",
      );
    }
    doc.hooks = {};
    state.hooksCreated = true;
  }
  const hooks = doc.hooks as Json;
  const created = new Set(state.eventsCreated ?? []);
  for (const [event, groups] of Object.entries(claudeHooks(paths))) {
    if (hooks[event] === undefined) {
      hooks[event] = [];
      created.add(event);
    }
    const list = hooks[event];
    if (!Array.isArray(list)) {
      throw new Error(`~/.claude/settings.json: hooks.${event} is not a list`);
    }
    if (!hasOurGroup(list, paths)) list.push(...groups);
  }
  state.eventsCreated = [...created];
  return serialize(doc, fmt);
}

/** `settings.json` without Qutty's hook handlers (`undefined`: remove the file Qutty created). */
function removeClaudeHooks(
  text: string,
  paths: HubPaths,
  state: IntegrationState,
): string | undefined {
  const doc = parseObject(text, "~/.claude/settings.json");
  if (!isObject(doc.hooks)) return text;
  const hooks = doc.hooks;
  const created = new Set(state.eventsCreated ?? []);
  let changed = false;
  for (const event of Object.keys(claudeHooks(paths))) {
    const list = hooks[event];
    if (!Array.isArray(list) || !hasOurGroup(list, paths)) continue;
    changed = true;
    const kept = list.flatMap((g) => {
      if (!isObject(g) || !Array.isArray(g.hooks)) return [g];
      const handlers = g.hooks.filter((h) => !isOurHandler(h, paths));
      if (handlers.length === g.hooks.length) return [g];
      return handlers.length === 0 ? [] : [{ ...g, hooks: handlers }];
    });
    if (kept.length === 0 && created.has(event)) delete hooks[event];
    else hooks[event] = kept;
  }
  if (!changed) return text;
  if (Object.keys(hooks).length === 0 && state.hooksCreated) delete doc.hooks;
  if (Object.keys(doc).length === 0 && state.settingsCreated) return undefined;
  return serialize(doc, jsonFormat(text));
}

// ---------------------------------------------------------------------------------------------
// Codex: ~/.codex/config.toml [mcp_servers.qutty]
// ---------------------------------------------------------------------------------------------

const BEGIN =
  "# >>> qutty (Settings → Agent integration; Uninstall removes this block) >>>";
const END = "# <<< qutty <<<";

/** The block Qutty appends to config.toml (with its leading blank line). */
function codexBlock(paths: HubPaths): string {
  return `\n${BEGIN}\n[mcp_servers.qutty]\ncommand = ${
    tomlString(paths.mcp)
  }\nargs = []\n${END}\n`;
}

/** Where Qutty's block is in `text` (start of its leading newline, end after END's newline). */
function findCodexBlock(
  text: string,
): { start: number; end: number } | undefined {
  const b = text.indexOf(`\n${BEGIN}\n`);
  if (b < 0) return undefined;
  const e = text.indexOf(`\n${END}`, b + 1);
  if (e < 0) return undefined;
  let end = e + END.length + 1;
  if (text[end] === "\n") end++;
  return { start: b, end };
}

/** A `[mcp_servers.qutty]` table outside Qutty's block: the user's own. */
function hasForeignCodexTable(text: string): boolean {
  const block = findCodexBlock(text);
  const outside = block
    ? text.slice(0, block.start) + text.slice(block.end)
    : text;
  return /^\s*\[\s*mcp_servers\s*\.\s*(qutty|"qutty")\s*\]/m.test(outside) ||
    /^\s*mcp_servers\s*\.\s*qutty\s*[.=]/m.test(outside);
}

function addCodex(
  text: string | undefined,
  paths: HubPaths,
  state: IntegrationState,
): string {
  if (text === undefined) {
    state.codexCreated = true;
    return codexBlock(paths).slice(1);
  }
  if (hasForeignCodexTable(text)) {
    throw new Error(
      "~/.codex/config.toml already configures an MCP server named qutty",
    );
  }
  const block = findCodexBlock(text);
  if (block) {
    // Refresh it in place (the path may have changed).
    return text.slice(0, block.start) + codexBlock(paths) +
      text.slice(block.end);
  }
  const needsNewline = text.length > 0 && !text.endsWith("\n");
  state.codexNewlineAdded = needsNewline;
  return text + (needsNewline ? "\n" : "") + codexBlock(paths);
}

/** config.toml without Qutty's block (`undefined`: remove the file Qutty created). */
function removeCodex(
  text: string,
  state: IntegrationState,
): string | undefined {
  const block = findCodexBlock(text);
  if (!block) {
    // A file Qutty created holds only the block, without its leading newline.
    if (state.codexCreated && text.startsWith(`${BEGIN}\n`)) {
      const rest = removeCodex(`\n${text}`, {});
      return rest === "" ? undefined : rest;
    }
    return text;
  }
  let start = block.start;
  if (
    state.codexNewlineAdded && block.end === text.length &&
    text[start - 1] === "\n"
  ) {
    start--;
  }
  const out = text.slice(0, start) + text.slice(block.end);
  return out === "" && state.codexCreated ? undefined : out;
}

function hasCodexBlock(text: string | undefined): boolean {
  return text !== undefined &&
    (findCodexBlock(text) !== undefined || text.startsWith(`${BEGIN}\n`));
}

// ---------------------------------------------------------------------------------------------
// Status, Install, Uninstall
// ---------------------------------------------------------------------------------------------

const tilde = (files: IntegrationFiles, p: string) =>
  p.startsWith(`${files.home}/`) ? `~${p.slice(files.home.length)}` : p;

const TARGET_LABELS: Record<IntegrationTarget, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** What the panel shows for each agent: installed or not, and exactly what Install writes. */
export async function integrationStatus(
  fs: ConfigFs,
  files: IntegrationFiles,
  paths: HubPaths,
): Promise<IntegrationStatus[]> {
  const claudeJson = await fs.read(await fs.realPath(files.claudeJson));
  const settings = await fs.read(await fs.realPath(files.claudeSettings));
  const codex = await fs.read(await fs.realPath(files.codexConfig));

  let mcp: "ours" | "foreign" | "none" = "none";
  try {
    const servers = claudeJson === undefined
      ? undefined
      : parseObject(claudeJson, "~/.claude.json").mcpServers;
    if (isObject(servers) && servers.qutty !== undefined) {
      mcp = isOurMcp(servers.qutty, paths) ? "ours" : "foreign";
    }
  } catch { /* unreadable: reported on Install */ }
  const events = installedHookEvents(settings, paths);
  const allEvents = Object.keys(claudeHooks(paths));
  const claudeInstalled = mcp === "ours" && events.length === allEvents.length;
  const claudeNote = mcp === "foreign"
    ? "~/.claude.json already has an MCP server named qutty that Qutty did not add."
    : !claudeInstalled && (mcp === "ours" || events.length > 0)
    ? "Partly installed: Install completes it."
    : undefined;

  const codexInstalled = hasCodexBlock(codex);
  const codexForeign = codex !== undefined && hasForeignCodexTable(codex);

  return [
    {
      target: "claude",
      label: TARGET_LABELS.claude,
      installed: claudeInstalled,
      ...(claudeNote ? { note: claudeNote } : {}),
      changes: [
        {
          path: tilde(files, files.claudeJson),
          adds: `"mcpServers": ${
            JSON.stringify({ qutty: claudeMcpEntry(paths.mcp) }, null, 2)
          }`,
        },
        {
          path: tilde(files, files.claudeSettings),
          adds: `"hooks": ${JSON.stringify(claudeHooks(paths), null, 2)}\n` +
            "(each group is appended to that event's list; your own hooks stay)",
        },
      ],
    },
    {
      target: "codex",
      label: TARGET_LABELS.codex,
      installed: codexInstalled,
      ...(codexForeign
        ? {
          note:
            "~/.codex/config.toml already configures an MCP server named qutty.",
        }
        : {}),
      changes: [{
        path: tilde(files, files.codexConfig),
        adds: codexBlock(paths).slice(1),
      }],
    },
  ];
}

async function readState(
  fs: ConfigFs,
  files: IntegrationFiles,
): Promise<IntegrationState> {
  const text = await fs.read(files.state);
  if (text === undefined) return {};
  try {
    const v = JSON.parse(text);
    return isObject(v) ? v as IntegrationState : {};
  } catch {
    return {};
  }
}

/** Apply `edit` to one file: backup first, keep its mode, follow a symlink, remove on `undefined`. */
async function editFile(
  fs: ConfigFs,
  path: string,
  edit: (text: string | undefined) => string | undefined,
): Promise<void> {
  const real = await fs.realPath(path);
  const before = await fs.read(real);
  const after = edit(before);
  if (after === before) return;
  const mode = await fs.mode(real) ?? 0o600;
  if (before !== undefined) {
    const backup = `${real}.qutty-backup`;
    if (await fs.read(backup) === undefined) {
      await fs.write(backup, before, mode);
    }
  }
  if (after === undefined) await fs.remove(real);
  else await fs.write(real, after, mode);
}

/** Install the user-scope registration for `target` (idempotent). */
export async function installIntegration(
  fs: ConfigFs,
  files: IntegrationFiles,
  paths: HubPaths,
  target: IntegrationTarget,
): Promise<void> {
  const state = await readState(fs, files);
  if (target === "claude") {
    await editFile(fs, files.claudeJson, (t) => addClaudeMcp(t, paths, state));
    await editFile(
      fs,
      files.claudeSettings,
      (t) => addClaudeHooks(t, paths, state),
    );
  } else {
    await editFile(fs, files.codexConfig, (t) => addCodex(t, paths, state));
  }
  await fs.write(files.state, JSON.stringify(state, null, 2) + "\n", 0o644);
}

/** Remove exactly Qutty's entries for `target`. */
export async function uninstallIntegration(
  fs: ConfigFs,
  files: IntegrationFiles,
  paths: HubPaths,
  target: IntegrationTarget,
): Promise<void> {
  const state = await readState(fs, files);
  if (target === "claude") {
    await editFile(
      fs,
      files.claudeJson,
      (t) => t === undefined ? t : removeClaudeMcp(t, paths, state),
    );
    await editFile(
      fs,
      files.claudeSettings,
      (t) => t === undefined ? t : removeClaudeHooks(t, paths, state),
    );
    delete state.claudeJsonCreated;
    delete state.mcpServersCreated;
    delete state.settingsCreated;
    delete state.hooksCreated;
    delete state.eventsCreated;
  } else {
    await editFile(
      fs,
      files.codexConfig,
      (t) => t === undefined ? t : removeCodex(t, state),
    );
    delete state.codexCreated;
    delete state.codexNewlineAdded;
  }
  await fs.write(files.state, JSON.stringify(state, null, 2) + "\n", 0o644);
}
