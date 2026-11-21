/**
 * The user's own agent detection manifests: `<appSupportDir>/agent-detection/<agent>.json` or
 * `<agent>.toml` (macOS: `~/Library/Application Support/org.qutty.Qutty/agent-detection/`). A
 * user manifest always wins: it replaces the bundled one with the same `id` (the file's name when
 * it has none) entirely, and a new id adds an agent. A file that does not parse or check is
 * reported and left out; the bundled manifest stays in force then. docs/agent-detection.md has the
 * format.
 *
 * Pure (the hub reads the folder, desktop/hub.ts).
 *
 * @module
 */

import { parse as parseToml } from "@std/toml";
import { type AgentManifest, compileManifest } from "./manifest.ts";

/** One user file, as read. */
export interface OverrideFile {
  /** Its name (`gemini.toml`). */
  name: string;
  /** Its full path, for the debug command and the messages. */
  path: string;
  text: string;
}

/** The manifests in force, where each came from, and the files that were refused. */
export interface ManifestSet {
  manifests: AgentManifest[];
  /** `bundled`, or the user file's path, by agent id. */
  sources: Map<string, string>;
  errors: { path: string; error: string }[];
}

/** A user file's manifest; throws with the reason. */
export function parseOverride(file: OverrideFile): AgentManifest {
  const m = /^(.+)\.(json|toml)$/i.exec(file.name);
  if (!m) throw new Error("not a .json or .toml file");
  const raw: unknown = m[2].toLowerCase() === "toml"
    ? parseToml(file.text)
    : JSON.parse(file.text);
  return compileManifest(raw, m[1].toLowerCase());
}

/** The bundled manifests under the user's own (which win, by id). */
export function mergeManifests(
  bundled: readonly AgentManifest[],
  files: readonly OverrideFile[],
): ManifestSet {
  const byId = new Map(bundled.map((m) => [m.id, m]));
  const sources = new Map(bundled.map((m) => [m.id, "bundled"]));
  const errors: ManifestSet["errors"] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const m = parseOverride(f);
      byId.set(m.id, m);
      sources.set(m.id, f.path);
    } catch (e) {
      errors.push({
        path: f.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { manifests: [...byId.values()], sources, errors };
}
