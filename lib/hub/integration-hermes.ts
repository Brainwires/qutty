/**
 * Settings → Agent integration for Hermes Agent: `mcp_servers.qutty` in `~/.hermes/config.yaml`
 * (`$HERMES_HOME/config.yaml`). Hermes has no per-session way to add an MCP server (no flag, and
 * the config path is fixed), so this is the only route; it starts the server in the session's
 * own process and expands `${VAR}` from that process's environment, so one entry serves every
 * tile:
 *
 * ```yaml
 * # >>> qutty …
 * mcp_servers:
 *   qutty:
 *     command: "/Users/me/.qutty/bin/qutty-mcp"
 *     env:
 *       QUTTY_SOCK: ${QUTTY_SOCK}
 *       …
 * # <<< qutty
 * ```
 *
 * The file is edited as text, between marker lines, by the same rules as the Claude Code and
 * Codex files (lib/hub/integration.ts): everything else stays byte for byte, Install is
 * idempotent, Uninstall gives back the original bytes, the first change copies the file to
 * `config.yaml.qutty-backup`, a symlink is followed, and a `qutty` server Qutty did not write is
 * left alone and reported. When the file already has a block-style `mcp_servers:` map, the entry
 * goes inside it (at its children's indentation); a flow-style one (`mcp_servers: {}`) is refused.
 * What Uninstall must undo (a newline added at the end, a file created) is written into the
 * marker line itself.
 *
 * Hermes's shell hooks take a different input than `qutty-hook` reads and ask for consent on
 * first use, so none are added: messages reach a Hermes tile through `read_messages`.
 *
 * @module
 */

import { parse as parseYaml } from "@std/yaml";
import type { IntegrationStatus } from "./protocol.ts";
import type { ConfigFs } from "./integration.ts";
import type { HubPaths } from "./launch.ts";
import { HUB_ENV_NAMES } from "./wiring.ts";

const BEGIN =
  "# >>> qutty agent hub (added by Qutty: Settings → Agent integration)";
const END = "# <<< qutty agent hub";
/** Marker flags: the file was created by Install / a newline was added before the block. */
const CREATED = " [created]";
const NEWLINE = " [newline]";

/** Hermes's config file under a home folder (`HERMES_HOME` when the app has one). */
export function hermesConfigPath(
  home: string,
  hermesHome?: string,
): string {
  const base = hermesHome && hermesHome.startsWith("/")
    ? hermesHome.replace(/\/+$/, "")
    : `${home.replace(/\/+$/, "")}/.hermes`;
  return `${base}/config.yaml`;
}

/** The `qutty` entry's lines at `indent` (the server name's own indentation). */
function entryLines(paths: HubPaths, indent: string): string[] {
  return [
    `${indent}qutty:`,
    `${indent}  command: ${JSON.stringify(paths.mcp)}`,
    `${indent}  env:`,
    ...HUB_ENV_NAMES.map((n) => `${indent}    ${n}: \${${n}}`),
  ];
}

/** Where Qutty's block is: the lines from BEGIN to END (indices into `lines`). */
function findBlock(
  lines: readonly string[],
): { begin: number; end: number; flags: string } | undefined {
  const begin = lines.findIndex((l) => l.trimStart().startsWith(BEGIN));
  if (begin < 0) return undefined;
  const end = lines.findIndex((l, i) => i > begin && l.trim() === END);
  if (end < 0) return undefined;
  return { begin, end, flags: lines[begin].trimStart().slice(BEGIN.length) };
}

/** `text` without Qutty's block (and what it added around it). */
export function removeHermes(text: string): string | undefined {
  const lines = text.split("\n");
  const block = findBlock(lines);
  if (!block) return text;
  const kept = [...lines.slice(0, block.begin), ...lines.slice(block.end + 1)];
  if (block.flags.includes(CREATED) && kept.join("\n").trim() === "") {
    return undefined;
  }
  let out = kept.join("\n");
  if (block.flags.includes(NEWLINE) && out.endsWith("\n")) {
    out = out.slice(0, -1);
  }
  return out;
}

/** The top-level `mcp_servers:` line of a block-style map, if the text has one. */
function serversLine(lines: readonly string[]): number {
  return lines.findIndex((l) => /^mcp_servers[ \t]*:[ \t]*(#.*)?$/.test(l));
}

/** Why Install cannot edit `text` (outside Qutty's block), or `undefined`. */
function problem(text: string): string | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return "~/.hermes/config.yaml is not valid YAML; fix it first";
  }
  const servers = doc && typeof doc === "object"
    ? (doc as Record<string, unknown>).mcp_servers
    : undefined;
  if (servers && typeof servers === "object" && "qutty" in servers) {
    return "~/.hermes/config.yaml already configures an MCP server named qutty.";
  }
  if (
    servers !== undefined && servers !== null &&
    serversLine(text.split("\n")) < 0
  ) {
    return "~/.hermes/config.yaml writes mcp_servers inline; add the qutty server by hand.";
  }
  return undefined;
}

/** `text` (undefined: no file) with Qutty's entry; throws with the reason when it cannot. */
export function addHermes(
  text: string | undefined,
  paths: HubPaths,
): string {
  // Without Qutty's block (`undefined`: no file, or only the one Install created).
  const base = text === undefined ? undefined : removeHermes(text);
  if (base !== undefined) {
    const why = problem(base);
    if (why) throw new Error(why);
  }
  if (base === undefined) {
    return [
      BEGIN + CREATED,
      "mcp_servers:",
      ...entryLines(paths, "  "),
      END,
      "",
    ].join("\n");
  }
  const lines = base.split("\n");
  const at = serversLine(lines);
  if (at >= 0) {
    // Inside the user's map, at the indentation of its first child (two spaces if it has none).
    const child = lines.slice(at + 1).find((l) =>
      l.trim() !== "" && !l.trimStart().startsWith("#")
    );
    const indent = child && /^[ \t]+/.test(child)
      ? child.match(/^[ \t]+/)![0]
      : "  ";
    return [
      ...lines.slice(0, at + 1),
      indent + BEGIN,
      ...entryLines(paths, indent),
      indent + END,
      ...lines.slice(at + 1),
    ].join("\n");
  }
  // An empty file needs no newline before the block (and gets none back).
  const newline = base !== "" && !base.endsWith("\n");
  return base + (newline ? "\n" : "") + [
    BEGIN + (newline ? NEWLINE : ""),
    "mcp_servers:",
    ...entryLines(paths, "  "),
    END,
    "",
  ].join("\n");
}

/** Whether `text` holds Qutty's entry, current for `paths`. */
export function hermesInstalled(
  text: string | undefined,
  paths: HubPaths,
): "current" | "stale" | "absent" {
  if (text === undefined) return "absent";
  const lines = text.split("\n");
  const block = findBlock(lines);
  if (!block) return "absent";
  const body = lines.slice(block.begin + 1, block.end);
  const indent = lines[block.begin].match(/^[ \t]*/)![0];
  const want = indent === ""
    ? ["mcp_servers:", ...entryLines(paths, "  ")]
    : entryLines(paths, indent);
  return body.join("\n") === want.join("\n") ? "current" : "stale";
}

/** The integration panel's row for Hermes. */
export async function hermesStatus(
  fs: ConfigFs,
  configPath: string,
  shown: string,
  paths: HubPaths,
): Promise<IntegrationStatus> {
  const text = await fs.read(await fs.realPath(configPath));
  const state = hermesInstalled(text, paths);
  let note: string | undefined;
  if (state === "stale") {
    note = "Out of date (from an older Qutty): Install refreshes it.";
  } else if (state === "absent" && text !== undefined) {
    note = problem(text);
  }
  return {
    target: "hermes",
    label: "Hermes Agent",
    installed: state === "current",
    ...(note ? { note } : {}),
    changes: [{
      path: shown,
      adds: ["mcp_servers:", ...entryLines(paths, "  ")].join("\n"),
    }],
  };
}
