/**
 * Settings → Sandbox, as persisted with the workspace settings (lib/workspace/store.ts): whether
 * the window has a shared Docker sandbox, the image it runs, the project folder it sees, its
 * network, whether it outlives the window, and whether new tiles open in it.
 *
 * Client-safe and pure: the page sanitizes what it loads, and desktop/sandbox.ts checks what the
 * page sends with the same function.
 *
 * @module
 */

/** Off, or one shared container for every sandboxed tile of the window. */
export type SandboxMode = "off" | "shared";
/** Every mode, as Settings lists them. */
export const SANDBOX_MODES: readonly SandboxMode[] = ["off", "shared"];

export interface SandboxSettings {
  mode: SandboxMode;
  /** The image the container is created from (pulled on first use). */
  image: string;
  /** A host folder bind-mounted at the same path inside the sandbox ("" for none). */
  project: string;
  /** Whether the sandbox may change the project folder. */
  projectWritable: boolean;
  /** Network on (Docker's default bridge) or off (`--network none`: the hub is unreachable too). */
  network: boolean;
  /** Leave the container running when the window closes (reattached next time). */
  keepRunning: boolean;
  /** Plain `+`, ⌘T and the companion's new tiles open in the sandbox. */
  newTilesInSandbox: boolean;
  /** Mount the host's `~/.claude` and `~/.codex` read-only at `/mnt/host` (opt-in). */
  hostAgentConfigs: boolean;
}

/**
 * A general-purpose dev image: Debian with bash, git, curl, python3, a C toolchain, and Node.js
 * + npm (which `npm i -g @openai/codex` and most agent CLIs need).
 */
export const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm";

export const DEFAULT_SANDBOX: SandboxSettings = {
  mode: "off",
  image: DEFAULT_SANDBOX_IMAGE,
  project: "",
  projectWritable: true,
  network: true,
  keepRunning: false,
  newTilesInSandbox: true,
  hostAgentConfigs: false,
};

/** A Docker image reference: `name[:tag][@digest]`, with an optional registry and path. */
export function isImageRef(v: unknown): v is string {
  return typeof v === "string" && v.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/.test(v) && !v.includes("//");
}

/**
 * A project folder the sandbox can mount: absolute, no `..`, and nothing that would break
 * `--mount type=bind,source=…` (`,` separates its fields; `"` quotes them) or a line.
 */
export function isProjectPath(v: unknown): v is string {
  return typeof v === "string" && v.length <= 1024 && v.startsWith("/") &&
    v !== "/" && !/[,"\0\r\n]/.test(v) && !v.split("/").includes("..");
}

/** `raw` (from storage, the page or a patch) onto `base`, each field checked. */
export function sanitizeSandbox(
  raw: unknown,
  base: SandboxSettings = DEFAULT_SANDBOX,
): SandboxSettings {
  const out = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Record<keyof SandboxSettings, unknown>>;
  if (SANDBOX_MODES.includes(r.mode as SandboxMode)) {
    out.mode = r.mode as SandboxMode;
  }
  if (typeof r.image === "string") {
    const image = r.image.trim();
    if (isImageRef(image)) out.image = image;
  }
  if (typeof r.project === "string") {
    const project = r.project.trim().replace(/(.)\/+$/, "$1");
    if (project === "" || isProjectPath(project)) out.project = project;
  }
  for (
    const k of [
      "projectWritable",
      "network",
      "keepRunning",
      "newTilesInSandbox",
      "hostAgentConfigs",
    ] as const
  ) {
    if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  }
  return out;
}

/**
 * Whether a new tile opens in the sandbox: the picker's explicit choice when it made one, else
 * the "new tiles open in the sandbox" default (never while the sandbox is off).
 */
export function opensInSandbox(
  settings: SandboxSettings,
  choice?: boolean,
): boolean {
  if (settings.mode === "off") return false;
  return choice ?? settings.newTilesInSandbox;
}
