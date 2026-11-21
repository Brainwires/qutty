/**
 * The bundled agent detection manifests (resources/agent-detection/, shipped as
 * lib/agent/detect/bundled.ts), compiled once. Pure and client-safe: the page reads their process
 * names and labels (lib/workspace/harness.ts), the hub their screen matchers
 * (lib/hub/screen-detect.ts).
 *
 * @module
 */

import { BUNDLED_MANIFESTS } from "./bundled.ts";
import { type AgentManifest, compileManifest } from "./manifest.ts";

let compiled: AgentManifest[] | undefined;

/** Every bundled manifest (one that does not compile is a bug the tests catch: it is skipped). */
export function builtinManifests(): readonly AgentManifest[] {
  if (compiled) return compiled;
  compiled = [];
  for (const [name, text] of Object.entries(BUNDLED_MANIFESTS)) {
    try {
      compiled.push(
        compileManifest(JSON.parse(text), name.replace(/\.json$/, "")),
      );
    } catch (e) {
      console.error(`agent detection: bundled ${name} is broken`, e);
    }
  }
  return compiled;
}
