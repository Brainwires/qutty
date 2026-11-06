/**
 * Settings → Agent integration: the user-scope registration that connects an agent started by
 * hand in any tile (not just one launched from the `+` picker) to the hub.
 *
 * - Claude Code: `mcpServers.qutty` in `~/.claude.json` (what `claude mcp add --scope user`
 *   writes) and a `qutty-hook` group per event under `hooks` in `~/.claude/settings.json`;
 * - Codex: in `~/.codex/config.toml`, between marker comments, an `[mcp_servers.qutty]` table
 *   (with the `env_vars` that let `QUTTY_SOCK` through), a `[[hooks.<Event>]]` group per event
 *   running `qutty-hook codex`, and `[hooks.state."<config.toml>:<event>:<n>:0"]` trust entries
 *   for exactly those groups (what Codex's own `/hooks` review writes when you trust a hook).
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

import { parse as parseToml } from "@std/toml";
import {
  addHermes,
  hermesConfigPath,
  hermesStatus,
  removeHermes,
} from "./integration-hermes.ts";
import type { IntegrationStatus, IntegrationTarget } from "./protocol.ts";
import { CODEX_HOOK_EVENTS } from "./hooks.ts";
import {
  claudeHooks,
  claudeMcpEntry,
  type CodexHookEvent,
  codexHookHandler,
  codexHookHash,
  codexHookKey,
  codexMcpEntry,
  hookCommand,
  type HubPaths,
  tomlInline,
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
  /** `~/.hermes/config.yaml` (lib/hub/integration-hermes.ts) */
  hermesConfig: string;
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
    hermesConfig: hermesConfigPath(h),
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
// Codex: ~/.codex/config.toml [mcp_servers.qutty], [[hooks.<Event>]] and their trust
// ---------------------------------------------------------------------------------------------

const BEGIN =
  "# >>> qutty (Settings → Agent integration; Uninstall removes this block) >>>";
const END = "# <<< qutty <<<";

/** How many hook groups the user's own config.toml has per event (Qutty's go after them). */
type CodexGroups = Record<CodexHookEvent, number>;

const NO_GROUPS = Object.fromEntries(
  CODEX_HOOK_EVENTS.map((e) => [e, 0]),
) as CodexGroups;

/**
 * The block Qutty appends to config.toml (with its leading newline): the MCP server, one hook
 * group per event, and the trust Codex needs to run them, keyed by the config file's path and
 * each group's index (`groups`: the user's groups before ours).
 */
function codexBlock(
  paths: HubPaths,
  keySource: string,
  groups: CodexGroups,
): string {
  const mcp = codexMcpEntry(paths.mcp);
  const lines = [
    BEGIN,
    "[mcp_servers.qutty]",
    `command = ${tomlString(mcp.command)}`,
    "args = []",
    `env_vars = ${tomlInline(mcp.env_vars)}`,
  ];
  for (const event of CODEX_HOOK_EVENTS) {
    lines.push(
      "",
      `[[hooks.${event}]]`,
      `hooks = [${tomlInline(codexHookHandler(paths, event))}]`,
    );
  }
  for (const event of CODEX_HOOK_EVENTS) {
    const key = codexHookKey(keySource, event, groups[event]);
    lines.push(
      "",
      `[hooks.state.${tomlString(key)}]`,
      `trusted_hash = ${tomlString(codexHookHash(paths, event))}`,
    );
  }
  lines.push(END);
  return `\n${lines.join("\n")}\n`;
}

/**
 * Where Qutty's block is in `text`: from its leading newline (or the file's start, in a file
 * Qutty created) to after END's line and one blank line.
 */
function findCodexBlock(
  text: string,
): { start: number; end: number; atStart: boolean } | undefined {
  const atStart = text.startsWith(`${BEGIN}\n`);
  const b = atStart ? 0 : text.indexOf(`\n${BEGIN}\n`);
  if (b < 0) return undefined;
  const e = text.indexOf(`\n${END}`, b + 1);
  if (e < 0) return undefined;
  let end = e + END.length + 1;
  if (text[end] === "\n") end++;
  return { start: b, end, atStart };
}

/** `text` without Qutty's block. */
function outsideCodexBlock(text: string): string {
  const block = findCodexBlock(text);
  return block ? text.slice(0, block.start) + text.slice(block.end) : text;
}

/**
 * The config file name Codex keys the trust of its hooks by: config.toml in the real path of
 * Codex's home (Codex resolves `~/.codex`; on macOS a temp folder's `/var` is `/private/var`).
 */
async function codexKeySource(
  fs: ConfigFs,
  files: IntegrationFiles,
): Promise<string> {
  const dir = files.codexConfig.slice(0, files.codexConfig.lastIndexOf("/"));
  const real = await fs.realPath(dir);
  if (real !== dir) return `${real}/config.toml`;
  // Not there yet (Install creates it): resolve the home folder it will be made in.
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  return `${await fs.realPath(parent)}${dir.slice(parent.length)}/config.toml`;
}

/** A `[mcp_servers.qutty]` table outside Qutty's block: the user's own. */
function hasForeignCodexTable(text: string): boolean {
  const outside = outsideCodexBlock(text);
  return /^\s*\[\s*mcp_servers\s*\.\s*(qutty|"qutty")\s*\]/m.test(outside) ||
    /^\s*mcp_servers\s*\.\s*qutty\s*[.=]/m.test(outside);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The user's own hook groups per event in `outside` (config.toml without Qutty's block). Qutty
 * appends `[[hooks.<Event>]]` tables, which TOML only allows after tables of that same form, so
 * hooks or trust written inline (`hooks.Stop = [...]`, `state = { ... }`) are refused, as is a
 * trust entry already under one of Qutty's keys.
 */
function codexGroups(outside: string, keySource: string): CodexGroups {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(outside);
  } catch {
    throw new Error("~/.codex/config.toml is not valid TOML; fix it first");
  }
  const inline = (what: string) =>
    new Error(
      `~/.codex/config.toml writes ${what} inline; Qutty can only add its hooks next to [[hooks.<Event>]] tables`,
    );
  // A top-level `hooks = { … }` (before the first table header).
  const top = outside.split(/^[ \t]*\[/m)[0];
  if (/^[ \t]*hooks[ \t]*=/m.test(top)) throw inline("hooks");
  const hooks = isObject(doc.hooks) ? doc.hooks : {};
  const groups = { ...NO_GROUPS };
  for (const event of CODEX_HOOK_EVENTS) {
    const list = hooks[event];
    const count = Array.isArray(list) ? list.length : 0;
    const header = new RegExp(
      `^[ \\t]*\\[\\[[ \\t]*hooks[ \\t]*\\.[ \\t]*("?)${
        escapeRe(event)
      }\\1[ \\t]*\\]\\]`,
      "gm",
    );
    if (list !== undefined && (outside.match(header)?.length ?? 0) !== count) {
      throw inline(`hooks.${event}`);
    }
    groups[event] = count;
  }
  if (hooks.state !== undefined) {
    if (
      !/^[ \t]*\[[ \t]*hooks[ \t]*\.[ \t]*"?state"?[ \t]*[.\]]/m.test(outside)
    ) {
      throw inline("hooks.state");
    }
    const state = isObject(hooks.state) ? hooks.state : {};
    for (const event of CODEX_HOOK_EVENTS) {
      if (codexHookKey(keySource, event, groups[event]) in state) {
        throw new Error(
          `~/.codex/config.toml already has hook trust for the slot Qutty's ${event} hook takes`,
        );
      }
    }
  }
  return groups;
}

function addCodex(
  text: string | undefined,
  keySource: string,
  paths: HubPaths,
  state: IntegrationState,
): string {
  if (text === undefined) {
    state.codexCreated = true;
    return codexBlock(paths, keySource, NO_GROUPS).slice(1);
  }
  if (hasForeignCodexTable(text)) {
    throw new Error(
      "~/.codex/config.toml already configures an MCP server named qutty",
    );
  }
  const block = findCodexBlock(text);
  const fresh = codexBlock(
    paths,
    keySource,
    codexGroups(outsideCodexBlock(text), keySource),
  );
  if (block) {
    // Refresh it in place (the path, or the user's hooks before it, may have changed).
    return text.slice(0, block.start) +
      (block.atStart ? fresh.slice(1) : fresh) + text.slice(block.end);
  }
  const needsNewline = text.length > 0 && !text.endsWith("\n");
  state.codexNewlineAdded = needsNewline;
  return text + (needsNewline ? "\n" : "") + fresh;
}

/** config.toml without Qutty's block (`undefined`: remove the file Qutty created). */
function removeCodex(
  text: string,
  state: IntegrationState,
): string | undefined {
  const block = findCodexBlock(text);
  if (!block) return text;
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

/**
 * Qutty's block in config.toml: absent, current, or out of date (an older Qutty's, or the
 * user's own hook groups before it changed, which moves the trust keys).
 */
function codexBlockState(
  text: string | undefined,
  keySource: string,
  paths: HubPaths,
): "none" | "current" | "stale" {
  const block = text === undefined ? undefined : findCodexBlock(text);
  if (!text || !block) return "none";
  let groups = NO_GROUPS;
  try {
    groups = codexGroups(outsideCodexBlock(text), keySource);
  } catch {
    return "stale";
  }
  const want = codexBlock(paths, keySource, groups);
  const have = (block.atStart ? "\n" : "") +
    text.slice(block.start, block.end);
  return have === want || have === `${want}\n` ? "current" : "stale";
}

// ---------------------------------------------------------------------------------------------
// Status, Install, Uninstall
// ---------------------------------------------------------------------------------------------

const tilde = (files: IntegrationFiles, p: string) =>
  p.startsWith(`${files.home}/`) ? `~${p.slice(files.home.length)}` : p;

const TARGET_LABELS: Record<"claude" | "codex", string> = {
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

  const codexKeys = await codexKeySource(fs, files);
  const codexState = codexBlockState(codex, codexKeys, paths);
  let codexGroupsNow = NO_GROUPS;
  let codexProblem: string | undefined;
  try {
    if (codex !== undefined) {
      codexGroupsNow = codexGroups(outsideCodexBlock(codex), codexKeys);
    }
  } catch (e) {
    codexProblem = `${(e as Error).message}.`;
  }
  const codexNote = codex !== undefined && hasForeignCodexTable(codex)
    ? "~/.codex/config.toml already configures an MCP server named qutty."
    : codexProblem ??
      (codexState === "stale"
        ? "Out of date (from an older Qutty, or your own hooks before it changed): Install refreshes it."
        : undefined);

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
      installed: codexState === "current",
      ...(codexNote ? { note: codexNote } : {}),
      changes: [{
        path: tilde(files, files.codexConfig),
        adds: codexBlock(paths, codexKeys, codexGroupsNow).slice(1),
      }],
    },
    await hermesStatus(
      fs,
      files.hermesConfig,
      tilde(files, files.hermesConfig),
      paths,
    ),
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
  if (target === "hermes") {
    // Its marker line records what Uninstall must undo: no state file entry.
    return await editFile(
      fs,
      files.hermesConfig,
      (t) => addHermes(t, paths),
    );
  }
  const state = await readState(fs, files);
  if (target === "claude") {
    await editFile(fs, files.claudeJson, (t) => addClaudeMcp(t, paths, state));
    await editFile(
      fs,
      files.claudeSettings,
      (t) => addClaudeHooks(t, paths, state),
    );
  } else {
    const codexKeys = await codexKeySource(fs, files);
    await editFile(
      fs,
      files.codexConfig,
      (t) => addCodex(t, codexKeys, paths, state),
    );
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
  if (target === "hermes") {
    return await editFile(
      fs,
      files.hermesConfig,
      (t) => t === undefined ? t : removeHermes(t),
    );
  }
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
