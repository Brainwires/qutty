/**
 * The demo backend's Ollama (lib/pty-client.ts `createDemoBackend`): canned status, models and
 * library pages, so the Ollama helper's UI and the e2e suite run in a plain browser. A demo
 * `ollama pull <model>` tile adds the model (the library's, or a small fake), and `ollama launch
 * <harness> --model <model>` runs as a demo agent named after the harness.
 *
 * @module
 */

import {
  type OllamaModel,
  type OllamaRunning,
  type OllamaStatus,
  withTag,
} from "./cli.ts";
import { OLLAMA_HARNESSES, PULL_THEN_LAUNCH } from "./harnesses.ts";
import type {
  LibraryModel,
  LibraryModelPage,
  LibraryOrder,
  LibraryPageResult,
  LibraryResult,
} from "./library.ts";

/** Where the demo pretends `ollama` is. */
const DEMO_OLLAMA_PATH = "/usr/local/bin/ollama";

/** The harnesses the demo pretends are installed. */
const DEMO_INSTALLED = new Set(["claude", "codex", "opencode"]);

const DAY = 24 * 60 * 60 * 1000;

function demoModels(): OllamaModel[] {
  return [
    {
      name: "qwen3.8:27b-mlx",
      id: "5642e97495e1",
      size: "18 GB",
      modified: "7 days ago",
      details: {
        architecture: "qwen3_5",
        parameters: "27.8B",
        quantization: "nvfp4",
        contextLength: 262144,
        capabilities: ["completion", "vision", "tools", "thinking"],
      },
    },
    {
      name: "gemma3:4b",
      id: "a2af6cc3eb7f",
      size: "3.3 GB",
      modified: "3 weeks ago",
      details: {
        architecture: "gemma3",
        parameters: "4.3B",
        quantization: "Q4_K_M",
        contextLength: 131072,
        capabilities: ["completion", "vision"],
      },
    },
  ];
}

function demoLibrary(now: number): (LibraryModel & LibraryModelPage)[] {
  return [
    {
      name: "mimo-v2.6",
      description:
        "MiMo-V2.6-Distill-Qwen-9B is Xiaomi MiMo's 9B model for code and agent workflows",
      capabilities: ["vision", "tools", "thinking"],
      cloud: false,
      sizes: ["9b"],
      downloads: 20887,
      tags: 8,
      updated: "3 days ago",
      updatedAt: now - 3 * DAY,
      applications: ["claude", "opencode", "hermes", "openclaw"],
      variants: [
        { tag: "mimo-v2.6:latest", size: "6.6GB", context: "256K" },
        { tag: "mimo-v2.6:9b", size: "6.6GB", context: "256K" },
      ],
    },
    {
      name: "qwen3.8",
      description: "Qwen 3.8: dense and MoE models for coding agents.",
      capabilities: ["vision", "tools", "thinking"],
      cloud: false,
      sizes: ["4b", "27b"],
      downloads: 1_204_331,
      tags: 14,
      updated: "2 weeks ago",
      updatedAt: now - 14 * DAY,
      applications: ["claude", "codex", "opencode", "qwen"],
      variants: [{ tag: "qwen3.8:27b-mlx", size: "18GB", context: "256K" }],
    },
    {
      name: "nomic-embed-text",
      description: "A high-performing open embedding model.",
      capabilities: ["embedding"],
      cloud: false,
      sizes: [],
      downloads: 48_000_000,
      tags: 3,
      updated: "1 year ago",
      updatedAt: now - 400 * DAY,
      applications: [],
      variants: [{ tag: "nomic-embed-text:latest", size: "274MB" }],
    },
  ];
}

/** A demo `ollama` command line, understood. */
export interface DemoOllamaCommand {
  /** `ollama pull <model>` (also the first half of pull-then-launch). */
  pull?: string;
  /** `ollama launch <harness> --model <model>`. */
  launch?: { harness: string; model: string };
}

export interface DemoOllama {
  status(): Promise<OllamaStatus>;
  library(
    query: string,
    opts?: { order?: LibraryOrder; toolsOnly?: boolean },
  ): Promise<LibraryResult>;
  libraryModel(name: string): Promise<LibraryPageResult>;
  openApp(): Promise<boolean>;
  /** What a spawned program is, when it is a demo `ollama` command. */
  command(
    program: string | undefined,
    args: readonly string[] | undefined,
  ): DemoOllamaCommand | undefined;
  /** A demo pull finished: the model is "here" now. */
  pulled(model: string): void;
}

/** The model after `--model` in a `launch` argv. */
function launchOf(args: readonly string[]): DemoOllamaCommand["launch"] {
  const at = args.indexOf("launch");
  const harness = at >= 0 ? args[at + 1] : undefined;
  const m = args.indexOf("--model");
  const model = m >= 0 ? args[m + 1] : undefined;
  return harness && model ? { harness, model } : undefined;
}

export function createDemoOllama(): DemoOllama {
  const models = demoModels();
  const running: OllamaRunning[] = [];
  const now = Date.now();
  const library = demoLibrary(now);
  return {
    status: () =>
      Promise.resolve({
        installed: true,
        path: DEMO_OLLAMA_PATH,
        version: "0.40.13",
        serverUp: true,
        app: true,
        models: structuredClone(models),
        running: structuredClone(running),
        harnesses: OLLAMA_HARNESSES.map((h) => ({
          name: h.name,
          label: h.label,
          installed: DEMO_INSTALLED.has(h.name),
        })),
        checkedAt: Date.now(),
      }),
    library(query, opts = {}) {
      const q = query.trim().toLowerCase();
      let found = library.filter((m) =>
        !q || m.name.includes(q) || m.description.toLowerCase().includes(q)
      );
      if (opts.toolsOnly) {
        found = found.filter((m) => m.capabilities.includes("tools"));
      }
      if (opts.order === "newest") {
        found = [...found].sort((a, b) =>
          (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
        );
      }
      return Promise.resolve({
        models: found.map(({ applications: _a, variants: _v, ...m }) =>
          structuredClone(m)
        ),
        fetchedAt: now,
      });
    },
    libraryModel(name) {
      const base = name.replace(/:.*$/, "");
      const m = library.find((x) => x.name === base);
      return Promise.resolve(
        m
          ? {
            page: structuredClone({
              name: m.name,
              description: m.description,
              capabilities: m.capabilities,
              applications: m.applications,
              variants: m.variants,
            }),
            fetchedAt: now,
          }
          : { fetchedAt: 0, error: "not in the demo library" },
      );
    },
    openApp: () => Promise.resolve(true),
    command(program, args = []) {
      if (program === "/bin/sh" && args[1] === PULL_THEN_LAUNCH) {
        return { pull: args[4], launch: launchOf(args.slice(5)) };
      }
      if (program !== DEMO_OLLAMA_PATH && program !== "ollama") {
        return undefined;
      }
      if (args[0] === "pull" && args[1]) return { pull: args[1] };
      const launch = launchOf(args);
      return launch ? { launch } : undefined;
    },
    pulled(model) {
      if (models.some((m) => m.name === withTag(model))) return;
      const base = model.replace(/:.*$/, "");
      const lib = library.find((m) => m.name === base);
      models.unshift({
        name: withTag(model),
        id: Math.random().toString(16).slice(2, 14).padEnd(12, "0"),
        size: lib?.variants[0]?.size.replace(/GB$/, " GB") ?? "1.0 GB",
        modified: "Less than a second ago",
        details: {
          capabilities: [
            "completion",
            ...(lib?.capabilities.filter((c) => c !== "cloud") ?? []),
          ],
        },
      });
    },
  };
}
