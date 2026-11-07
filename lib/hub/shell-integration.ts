/**
 * Settings → Agent integration, the shell rows: the one-line opt-in that loads the shell agent's
 * plugin (`~/.qutty/shell/qutty.zsh` / `qutty.bash`, installed by Qutty at every start) from the
 * user's `~/.zshrc` / `~/.bashrc`, between marker comments, only inside a Qutty tile.
 *
 * The same rules as the agent configs (lib/hub/integration.ts): everything else in the file is
 * kept byte for byte; Install is idempotent; Uninstall removes exactly the block (and the newline
 * or file Qutty added: recorded in `~/.qutty/shell-integration.json`), so install + uninstall
 * gives back the original bytes; the first change copies the file to `<file>.qutty-backup`; a
 * symlinked file (a dotfiles repo) is edited at its target.
 *
 * Bash: Qutty starts shells as login shells, and a login bash reads `~/.bash_profile` instead of
 * `~/.bashrc`, so the block also goes into `~/.bash_profile` when that file exists (the plugin
 * loads once even when both run).
 *
 * @module
 */

import type { ConfigFs } from "./integration.ts";
import { type HubPaths, shellQuote } from "./launch.ts";
import type { IntegrationStatus, ShellTarget } from "./protocol.ts";

/** The shell agent's files under `~/.qutty`. */
export interface ShellAgentPaths {
  /** `~/.qutty/bin/qutty-agent` */
  agent: string;
  /** `~/.qutty/shell` */
  dir: string;
  zsh: string;
  bash: string;
  /** What Install created (`~/.qutty/shell-integration.json`). */
  state: string;
}

export function shellAgentPaths(paths: HubPaths): ShellAgentPaths {
  const dir = `${paths.dir}/shell`;
  return {
    agent: `${paths.bin}/qutty-agent`,
    dir,
    zsh: `${dir}/qutty.zsh`,
    bash: `${dir}/qutty.bash`,
    state: `${paths.dir}/shell-integration.json`,
  };
}

export const isShellTarget = (t: string): t is ShellTarget =>
  t === "zsh" || t === "bash";

const BEGIN =
  "# >>> qutty shell agent (Settings → Agent integration; Uninstall removes this block) >>>";
const END = "# <<< qutty shell agent <<<";

/** The block's body: source the plugin, only inside a Qutty tile. */
export function shellRcLine(plugin: string): string {
  const p = shellQuote(plugin);
  return `if [ -n "\${QUTTY_SOCK-}\${QUTTY_HUB-}" ] && [ -r ${p} ]; then . ${p}; fi`;
}

const blockFor = (plugin: string) =>
  `${BEGIN}\n${shellRcLine(plugin)}\n${END}\n`;

/** Where the block is: from its BEGIN line to after END's newline. */
function findBlock(text: string): { start: number; end: number } | undefined {
  let start = 0;
  if (!text.startsWith(`${BEGIN}\n`)) {
    const i = text.indexOf(`\n${BEGIN}\n`);
    if (i < 0) return undefined;
    start = i + 1;
  }
  const e = text.indexOf(`\n${END}`, start);
  if (e < 0) return undefined;
  const after = e + 1 + END.length;
  return { start, end: text[after] === "\n" ? after + 1 : after };
}

/** What Install did to one rc file. */
interface RcState {
  /** The file did not exist. */
  created?: boolean;
  /** A newline was added before the block (the file did not end with one). */
  newline?: boolean;
  /** A blank line was added before the block. */
  blank?: boolean;
}

type ShellState = Record<string, RcState>;

/** `text` with the block added (or refreshed in place). */
function withBlock(
  text: string | undefined,
  plugin: string,
  st: RcState,
): string {
  const block = blockFor(plugin);
  if (text === undefined) {
    st.created = true;
    return block;
  }
  const found = findBlock(text);
  if (found) return text.slice(0, found.start) + block + text.slice(found.end);
  st.newline = text.length > 0 && !text.endsWith("\n");
  st.blank = text.length > 0;
  return text + (st.newline ? "\n" : "") + (st.blank ? "\n" : "") + block;
}

/** `text` without the block (`undefined`: remove the file Qutty created). */
function withoutBlock(text: string, st: RcState): string | undefined {
  const found = findBlock(text);
  if (!found) return text;
  let start = found.start;
  if (found.end === text.length) {
    if (st.blank && text.slice(start - 1, start) === "\n") start--;
    if (st.newline && text.slice(start - 1, start) === "\n") start--;
  }
  const out = text.slice(0, start) + text.slice(found.end);
  return out === "" && st.created ? undefined : out;
}

/** The rc files of a target: `~/.zshrc`; `~/.bashrc` (+ `~/.bash_profile` when it exists). */
async function rcFiles(
  fs: ConfigFs,
  home: string,
  target: ShellTarget,
): Promise<string[]> {
  if (target === "zsh") return [`${home}/.zshrc`];
  const profile = `${home}/.bash_profile`;
  const hasProfile = await fs.read(await fs.realPath(profile)) !== undefined;
  return [`${home}/.bashrc`, ...(hasProfile ? [profile] : [])];
}

async function readState(fs: ConfigFs, path: string): Promise<ShellState> {
  try {
    const v = JSON.parse(await fs.read(path) ?? "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Change one file: backup first, keep its mode, follow a symlink, remove on `undefined`. */
async function change(
  fs: ConfigFs,
  path: string,
  fn: (text: string | undefined) => string | undefined,
): Promise<void> {
  const real = await fs.realPath(path);
  const text = await fs.read(real);
  const next = fn(text);
  if (next === text) return;
  const mode = await fs.mode(real) ?? 0o644;
  const backup = `${real}.qutty-backup`;
  if (text !== undefined && await fs.read(backup) === undefined) {
    await fs.write(backup, text, mode);
  }
  if (next === undefined) await fs.remove(real);
  else await fs.write(real, next, mode);
}

const pluginOf = (sp: ShellAgentPaths, target: ShellTarget) =>
  target === "zsh" ? sp.zsh : sp.bash;

/** Apply `edit` to each of the target's rc files, keeping what it records in the state file. */
async function editRcFiles(
  fs: ConfigFs,
  home: string,
  paths: HubPaths,
  target: ShellTarget,
  edit: (
    text: string | undefined,
    plugin: string,
    st: RcState,
  ) => string | undefined,
  keep: boolean,
): Promise<void> {
  const sp = shellAgentPaths(paths);
  const state = await readState(fs, sp.state);
  for (const file of await rcFiles(fs, home, target)) {
    const st: RcState = state[file] ?? {};
    await change(fs, file, (t) => edit(t, pluginOf(sp, target), st));
    if (keep) state[file] = st;
    else delete state[file];
  }
  await fs.write(sp.state, JSON.stringify(state, null, 2) + "\n", 0o644);
}

/** Add the opt-in to the target's rc file(s) (idempotent). */
export function installShellRc(
  fs: ConfigFs,
  home: string,
  paths: HubPaths,
  target: ShellTarget,
): Promise<void> {
  return editRcFiles(fs, home, paths, target, withBlock, true);
}

/** Remove exactly the opt-in from the target's rc file(s). */
export function uninstallShellRc(
  fs: ConfigFs,
  home: string,
  paths: HubPaths,
  target: ShellTarget,
): Promise<void> {
  return editRcFiles(
    fs,
    home,
    paths,
    target,
    (t, _plugin, st) => t === undefined ? t : withoutBlock(t, st),
    false,
  );
}

/** The panel's rows for zsh and bash: installed or not, and exactly what Install adds. */
export async function shellRcStatus(
  fs: ConfigFs,
  home: string,
  paths: HubPaths,
): Promise<IntegrationStatus[]> {
  const sp = shellAgentPaths(paths);
  const tilde = (p: string) =>
    p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  const rows: IntegrationStatus[] = [];
  for (const target of ["zsh", "bash"] as const) {
    const files = await rcFiles(fs, home, target);
    const present = await Promise.all(
      files.map(async (f) => {
        const text = await fs.read(await fs.realPath(f));
        return text !== undefined && findBlock(text) !== undefined;
      }),
    );
    const installed = present.every(Boolean);
    const block = blockFor(pluginOf(sp, target));
    rows.push({
      target,
      label: target === "zsh" ? "Shell agent (zsh)" : "Shell agent (bash)",
      installed,
      note: !installed && present.some(Boolean)
        ? "Partly installed: Install completes it."
        : "In a Qutty tile, a line starting with “, ” goes to the model; the " +
          "proposed command lands in your prompt, never run for you. Open a " +
          "new tile after installing.",
      changes: files.map((f) => ({ path: tilde(f), adds: block })),
    });
  }
  return rows;
}
