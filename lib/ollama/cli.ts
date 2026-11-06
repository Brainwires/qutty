/**
 * What the `ollama` CLI prints, parsed: `ollama --version`, `ollama list`, `ollama ps` and
 * `ollama show <model>` (its Model and Capabilities sections), plus the status shape the
 * Ollama helper's backend method returns and how two of them differ.
 *
 * Pure and client-safe: desktop/ollama.ts runs the CLI in hidden PTYs and parses here; the page
 * imports the types; the demo backend (lib/ollama/demo.ts) builds the same shapes.
 *
 * @module
 */

/** A model in `ollama list`, with what `ollama show` said about it once it was asked. */
export interface OllamaModel {
  /** `qwen3.8:27b-mlx` */
  name: string;
  /** The short digest `ollama list` prints (it changes when the model is pulled again). */
  id: string;
  /** `18 GB` */
  size: string;
  /** `7 days ago` */
  modified: string;
  /** From `ollama show`, when it has been read. */
  details?: OllamaModelDetails;
}

/** The cheap facts `ollama show <model>` prints. */
export interface OllamaModelDetails {
  architecture?: string;
  /** `27.8B` */
  parameters?: string;
  /** `nvfp4`, `Q4_K_M` */
  quantization?: string;
  /** Tokens. */
  contextLength?: number;
  /** `completion`, `tools`, `vision`, `thinking`, `embedding`, … */
  capabilities: string[];
}

/** A model loaded right now (`ollama ps`). */
export interface OllamaRunning {
  name: string;
  size: string;
  /** `100% GPU` */
  processor: string;
  /** When it unloads: `4 minutes from now`, `Forever`. */
  until: string;
}

/** A terminal harness `ollama launch` can start, and whether its program is installed here. */
export interface OllamaHarnessFound {
  /** The `ollama launch` integration name (also the program's name). */
  name: string;
  label: string;
  installed: boolean;
}

/** What the Ollama helper knows about this machine (the backend's `ollamaStatus`). */
export interface OllamaStatus {
  /** The `ollama` program was found. */
  installed: boolean;
  /** Its resolved path. */
  path?: string;
  /** `0.40.13` */
  version?: string;
  /** `ollama list` answered (the server runs). */
  serverUp: boolean;
  /** Why the server could not be asked (its last line of output). */
  error?: string;
  /** The macOS app is installed (Settings can offer to open it). */
  app: boolean;
  models: OllamaModel[];
  running: OllamaRunning[];
  /** Every terminal harness, installed or not (lib/ollama/harnesses.ts order). */
  harnesses: OllamaHarnessFound[];
  /** Epoch ms of this reading. */
  checkedAt: number;
}

/** A status for a machine without Ollama (also the page's value before the first answer). */
export function emptyStatus(checkedAt = 0): OllamaStatus {
  return {
    installed: false,
    serverUp: false,
    app: false,
    models: [],
    running: [],
    harnesses: [],
    checkedAt,
  };
}

/** `ollama version is 0.40.13` → `0.40.13` (the client's own version, also when the server is down). */
export function parseVersion(text: string): string | undefined {
  const m = /(?:client )?version is (\d+(?:\.\d+)+\S*)/.exec(text);
  return m?.[1];
}

/** The rows of a CLI table: each line split at runs of two or more spaces, under its header. */
function tableRows(text: string, first: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  // A spinner the CLI drew while it waited may still sit before the header (escapes stripped).
  const at = lines.findIndex((l) => l.includes(`${first} `));
  if (at < 0) return [];
  const header = lines[at].slice(lines[at].indexOf(`${first} `)).trim()
    .split(/\s{2,}/);
  return lines.slice(at + 1).filter((l) => l.trim() !== "").map((l) => {
    const cells = l.trim().split(/\s{2,}/);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

/** `ollama list`: the pulled models, in the CLI's order (newest first). */
export function parseList(text: string): OllamaModel[] {
  return tableRows(text, "NAME").filter((r) => r.NAME).map((r) => ({
    name: r.NAME,
    id: r.ID ?? "",
    size: r.SIZE ?? "",
    modified: r.MODIFIED ?? "",
  }));
}

/** `ollama ps`: the loaded models. */
export function parsePs(text: string): OllamaRunning[] {
  return tableRows(text, "NAME").filter((r) => r.NAME).map((r) => ({
    name: r.NAME,
    size: r.SIZE ?? "",
    processor: r.PROCESSOR ?? "",
    until: r.UNTIL ?? "",
  }));
}

/**
 * `ollama show <model>`: the Model section's architecture, parameters, quantization and context
 * length, and the Capabilities section's names (its nested lines, such as thinking levels, are
 * skipped).
 */
export function parseShow(text: string): OllamaModelDetails {
  const out: OllamaModelDetails = { capabilities: [] };
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 2) {
      section = line.trim().toLowerCase();
      continue;
    }
    if (indent > 4) continue;
    const [key, ...rest] = line.trim().split(/\s{2,}/);
    const value = rest.join(" ").trim();
    if (section === "capabilities") {
      if (/^[a-z][a-z_-]*$/.test(key)) out.capabilities.push(key);
    } else if (section === "model") {
      if (key === "architecture") out.architecture = value;
      else if (key === "parameters") out.parameters = value;
      else if (key === "quantization") out.quantization = value;
      else if (key === "context length") {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) out.contextLength = n;
      }
    }
  }
  return out;
}

/** Whether a model can call tools, which agent harnesses need (unknown until `show` was read). */
export function hasTools(model: OllamaModel | undefined): boolean | undefined {
  return model?.details
    ? model.details.capabilities.includes("tools")
    : undefined;
}

/** The last meaningful line of a failed command's output (`Error: …`). */
export function lastLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "")
    .at(-1) ?? "";
}

/** What changed between two readings of the pulled models. */
export interface ModelChanges {
  added: string[];
  removed: string[];
  /** Pulled again (a new digest under the same name). */
  updated: string[];
}

export function diffModels(
  before: readonly OllamaModel[],
  after: readonly OllamaModel[],
): ModelChanges {
  const was = new Map(before.map((m) => [m.name, m.id]));
  const now = new Map(after.map((m) => [m.name, m.id]));
  return {
    added: after.filter((m) => !was.has(m.name)).map((m) => m.name),
    removed: before.filter((m) => !now.has(m.name)).map((m) => m.name),
    updated: after.filter((m) => was.has(m.name) && was.get(m.name) !== m.id)
      .map((m) => m.name),
  };
}

/** Whether a diff has anything in it. */
export function hasChanges(c: ModelChanges): boolean {
  return c.added.length + c.removed.length + c.updated.length > 0;
}

/** A model name as `ollama list` shows it once pulled: `:latest` when no tag was given. */
export function withTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/** A model or library name `ollama pull` / `--model` accepts (`name[:tag]`, an optional namespace). */
export function isModelName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._\-/]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(v) &&
    !v.includes("..") && !v.includes("//");
}
