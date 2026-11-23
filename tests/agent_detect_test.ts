// Agent detection manifests (lib/agent/detect/), the hub's screen detector
// (lib/hub/screen-detect.ts) and the harness detection's use of the manifests: parsing, every
// bundled manifest against recorded screens (tests/fixtures/agent-screens/<agent>/<state>.txt),
// strict `blocked`, user overrides winning, process / argv matching, hooks staying authoritative.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  agentForProcess,
  type AgentManifest,
  compileManifest,
  ManifestError,
  readScreen,
  type ScreenState,
} from "../lib/agent/detect/manifest.ts";
import { builtinManifests } from "../lib/agent/detect/builtin.ts";
import { BUNDLED_MANIFESTS } from "../lib/agent/detect/bundled.ts";
import {
  mergeManifests,
  parseOverride,
} from "../lib/agent/detect/overrides.ts";
import { readManifestFiles } from "../scripts/gen-agent-manifests.ts";
import { ScreenDetector } from "../lib/hub/screen-detect.ts";
import type { TileStatus } from "../lib/hub/protocol.ts";
import { detectHarness, harnessSpec } from "../lib/workspace/harness.ts";

const AGENTS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "aider",
  "copilot",
  "cursor",
  "amp",
  "qwen",
  "kimi",
  "droid",
];
const STATES: ScreenState[] = ["working", "blocked", "idle"];

/** A recorded screen as the mirror reads it: rows right-trimmed, trailing blank rows dropped. */
function screen(agent: string, state: ScreenState): string[] {
  const text = Deno.readTextFileSync(
    new URL(`./fixtures/agent-screens/${agent}/${state}.txt`, import.meta.url),
  );
  const rows = text.split("\n").map((l) => l.trimEnd());
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

function manifest(id: string): AgentManifest {
  const m = builtinManifests().find((x) => x.id === id);
  if (!m) throw new Error(`no bundled manifest ${id}`);
  return m;
}

Deno.test("agent detection: the bundled manifests are the resources' files, and all compile", () => {
  const files = Object.fromEntries(readManifestFiles());
  assertEquals(
    BUNDLED_MANIFESTS,
    files,
    "run scripts/gen-agent-manifests.ts after editing resources/agent-detection/",
  );
  assertEquals(builtinManifests().map((m) => m.id).sort(), [...AGENTS].sort());
  for (const m of builtinManifests()) {
    assert(m.matchers.blocked.length > 0, `${m.id} has blocked matchers`);
    assert(m.matchers.working.length > 0, `${m.id} has working matchers`);
    assert(m.processNames.length > 0, `${m.id} has process names`);
  }
  // The ones written without the agent's own source to hand say so.
  assertEquals(
    builtinManifests().filter((m) => m.confidence === "low").map((m) => m.id)
      .sort(),
    ["amp", "copilot", "cursor", "droid"],
  );
});

for (const agent of AGENTS) {
  Deno.test(`agent detection: ${agent} reads its recorded screens right`, () => {
    for (const state of STATES) {
      const v = readScreen(manifest(agent), screen(agent, state));
      assertEquals(v.state, state, `${agent} ${state}: ${JSON.stringify(v)}`);
    }
  });
}

Deno.test("agent detection: blocked is strict, an unmatched screen is idle", () => {
  // Every agent reads every other agent's working and idle screens as anything but blocked
  // (a question in the transcript is not an approval UI), unless the matchers are shared.
  for (const agent of AGENTS) {
    for (const other of AGENTS) {
      for (const state of ["working", "idle"] as const) {
        const v = readScreen(manifest(agent), screen(other, state));
        assert(
          v.state !== "blocked",
          `${agent} on ${other}'s ${state} screen: ${JSON.stringify(v)}`,
        );
      }
    }
  }
  const claude = manifest("claude");
  // A transcript line that only mentions a question is not the menu.
  assertEquals(
    readScreen(claude, ["● Should I proceed? Tell me and I will.", "> "]),
    { state: "idle", matcher: "prompt", line: "> " },
  );
  assertEquals(readScreen(claude, ["nothing here"]), {
    state: "idle",
    matcher: null,
  });
  // Only the bottom `lines` rows are read: an approval far above is old.
  const old = [
    "Do you want to proceed?",
    ...Array.from({ length: 20 }, (_, i) => `line ${i}`),
  ];
  assertEquals(readScreen(claude, old).state, "idle");
});

Deno.test("agent detection: manifests are checked", () => {
  const ok = compileManifest({
    id: "mine",
    process: { names: ["Mine"], argv: ["(^|/)mine\\.js$"] },
    interrupt: "ctrl-c",
    working: ["busy busy", { regex: "^\\s*⠋", id: "spin" }],
    blocked: [{ all: ["Allow?", "[y/n]"] }],
  });
  assertEquals(ok.processNames, ["mine"]);
  assertEquals(ok.interrupt, "\x03");
  assertEquals(ok.lines, 15);
  assertEquals(ok.matchers.working.map((m) => m.id), ["working-0", "spin"]);
  assertEquals(ok.confidence, "high");
  assertEquals(readScreen(ok, ["Allow? ", "  [y/n]"]).matcher, "blocked-0");
  assertEquals(readScreen(ok, ["Allow? only"]).state, "idle");
  for (
    const bad of [
      null,
      { id: "Has Space" },
      { id: "x", interrupt: "f1" },
      { id: "x", lines: 0 },
      { id: "x", working: [{}] },
      { id: "x", working: [{ regex: "(" }] },
      { id: "x", working: [{ regex: "a", flags: "g" }] },
      { id: "x", blocked: "Allow?" },
      { id: "x", process: { names: [1] } },
    ]
  ) {
    assertThrows(() => compileManifest(bad), ManifestError);
  }
  // A user file without an id takes its file name.
  assertEquals(compileManifest({}, "named").id, "named");
});

Deno.test("agent detection: process names and arguments name the agent", () => {
  const all = builtinManifests();
  const id = (name: string, argv?: string[]) =>
    agentForProcess(all, { name, ...(argv ? { argv } : {}) })?.id;
  assertEquals(id("claude"), "claude");
  assertEquals(id("/opt/homebrew/bin/codex"), "codex");
  assertEquals(id("cursor-agent"), "cursor");
  // Node and Python CLIs are their interpreter to the OS.
  assertEquals(id("node", ["node", "/opt/homebrew/bin/gemini"]), "gemini");
  assertEquals(id("node", ["node", "/usr/local/bin/qwen", "-y"]), "qwen");
  assertEquals(
    id("Python", ["/usr/bin/python3", "/Users/me/.local/bin/aider"]),
    "aider",
  );
  assertEquals(id("node", ["node", "server.js"]), undefined);
  assertEquals(id("vim"), undefined);
});

Deno.test("agent detection: a user manifest wins over the bundled one, JSON or TOML", () => {
  const files = [
    {
      name: "claude.toml",
      path: "/app/agent-detection/claude.toml",
      text: `
id = "claude"
label = "My Claude"
[process]
names = ["claude", "claude-dev"]
[[blocked]]
id = "mine"
text = "MY APPROVAL"
`,
    },
    {
      name: "newagent.json",
      path: "/app/agent-detection/newagent.json",
      text: JSON.stringify({
        process: { names: ["newagent"] },
        working: ["thinking hard"],
        blocked: ["Approve? (y/n)"],
      }),
    },
    {
      name: "broken.json",
      path: "/app/agent-detection/broken.json",
      text: "{",
    },
    {
      name: "bad.json",
      path: "/app/agent-detection/bad.json",
      text: JSON.stringify({ working: [{ regex: "(" }] }),
    },
  ];
  const set = mergeManifests(builtinManifests(), files);
  const claude = set.manifests.find((m) => m.id === "claude")!;
  assertEquals(claude.label, "My Claude");
  assertEquals(set.sources.get("claude"), "/app/agent-detection/claude.toml");
  assertEquals(set.sources.get("codex"), "bundled");
  // The override replaces the bundled manifest entirely: its own matchers only.
  assertEquals(readScreen(claude, ["Do you want to proceed?"]).state, "idle");
  assertEquals(readScreen(claude, ["MY APPROVAL"]).matcher, "mine");
  assertEquals(
    agentForProcess(set.manifests, { name: "claude-dev" })?.id,
    "claude",
  );
  assertEquals(
    agentForProcess(set.manifests, { name: "newagent" })?.id,
    "newagent",
  );
  assertEquals(set.errors.map((e) => e.path), [
    "/app/agent-detection/bad.json",
    "/app/agent-detection/broken.json",
  ]);
  assertEquals(set.manifests.length, AGENTS.length + 1);
  assertThrows(() => parseOverride({ name: "x.yaml", path: "x", text: "" }));
});

Deno.test("harness detection: the manifests' process names and labels turn the overlay on", () => {
  assertEquals(detectHarness({ process: "cursor-agent" })?.id, "cursor");
  assertEquals(detectHarness({ process: "droid" })?.label, "Droid");
  assertEquals(harnessSpec("cursor").interrupt, "\x03");
  assertEquals(harnessSpec("amp").label, "Amp");
  assertEquals(detectHarness({ process: "zsh", hubHarness: "gemini" }), null);
});

// ---------------------------------------------------------------------------------------------
// The hub's detector
// ---------------------------------------------------------------------------------------------

/** A detector over a fake registry and screens; timers run when `flush` is called. */
function fakeHub() {
  const tiles = new Map<string, { harness?: string; status: TileStatus }>();
  const screens = new Map<string, string[]>();
  const timers: (() => void)[] = [];
  const log: string[] = [];
  const detector = new ScreenDetector({
    manifests: () => builtinManifests(),
    screen: (id) => Promise.resolve(screens.get(id) ?? []),
    tile: (id) => tiles.get(id),
    setStatus: (id, status) => {
      tiles.get(id)!.status = status;
      log.push(`${id} ${status}`);
    },
    setHarness: (id, harness) => {
      tiles.get(id)!.harness = harness;
      log.push(`${id} harness ${harness}`);
    },
    clearHarness: (id) => {
      delete tiles.get(id)!.harness;
      log.push(`${id} harness -`);
    },
    later: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const flush = async () => {
    while (timers.length > 0) timers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { tiles, screens, detector, flush, log, timers };
}

Deno.test("screen detector: an agent without hooks gets its status from the screen", async () => {
  const h = fakeHub();
  h.tiles.set("pty-1", { status: "idle" });
  h.detector.foreground("pty-1", {
    name: "node",
    argv: ["node", "/opt/homebrew/bin/gemini"],
  });
  assertEquals(h.tiles.get("pty-1")!.harness, "gemini");
  h.screens.set("pty-1", screen("gemini", "working"));
  h.detector.data("pty-1");
  h.detector.data("pty-1");
  assertEquals(h.timers.length, 1, "one read per throttle window");
  await h.flush();
  assertEquals(h.tiles.get("pty-1")!.status, "busy");
  h.screens.set("pty-1", screen("gemini", "blocked"));
  h.detector.data("pty-1");
  await h.flush();
  assertEquals(h.tiles.get("pty-1")!.status, "waiting");
  assertEquals(h.detector.info("pty-1").verdict?.matcher, "allow-execution");
  h.screens.set("pty-1", screen("gemini", "idle"));
  h.detector.data("pty-1");
  await h.flush();
  assertEquals(h.tiles.get("pty-1")!.status, "idle");
  // Back to the shell: the harness it named goes, nothing is read any more.
  h.screens.set("pty-1", screen("gemini", "working"));
  h.detector.foreground("pty-1", { name: "zsh" });
  assertEquals(h.tiles.get("pty-1")!.harness, undefined);
  h.detector.data("pty-1");
  assertEquals(h.timers.length, 0);
});

Deno.test("screen detector: hooks stay authoritative; the screen only adds an unreported approval", async () => {
  const h = fakeHub();
  h.tiles.set("pty-2", { harness: "claude", status: "idle" });
  h.detector.foreground("pty-2", { name: "claude" });
  h.detector.hookSeen("pty-2", "claude");
  // The hooks said busy; a working or idle screen changes nothing.
  h.tiles.get("pty-2")!.status = "busy";
  h.screens.set("pty-2", screen("claude", "idle"));
  h.detector.data("pty-2");
  await h.flush();
  assertEquals(h.tiles.get("pty-2")!.status, "busy");
  // An approval prompt the hooks did not report: waiting, then handed back once it is gone.
  h.screens.set("pty-2", screen("claude", "blocked"));
  h.detector.data("pty-2");
  await h.flush();
  assertEquals(h.tiles.get("pty-2")!.status, "waiting");
  h.screens.set("pty-2", screen("claude", "working"));
  h.detector.data("pty-2");
  await h.flush();
  assertEquals(h.tiles.get("pty-2")!.status, "busy");
  // The hooks' own status is left alone after that.
  h.tiles.get("pty-2")!.status = "idle";
  h.detector.data("pty-2");
  await h.flush();
  assertEquals(h.tiles.get("pty-2")!.status, "idle");
  assertEquals(h.detector.info("pty-2").hooked, true);
  // A harness from the hooks is not cleared when the agent quits.
  h.detector.foreground("pty-2", { name: "zsh" });
  assertEquals(h.tiles.get("pty-2")!.harness, "claude");
});

Deno.test("screen detector: the hub's harness names the agent when the process does not", async () => {
  const h = fakeHub();
  // `ollama launch codex` is `ollama` to the OS.
  h.tiles.set("pty-3", { harness: "codex", status: "idle" });
  h.detector.foreground("pty-3", { name: "ollama" });
  assertEquals(h.detector.info("pty-3").via, "harness");
  h.screens.set("pty-3", screen("codex", "working"));
  await h.flush();
  assertEquals(h.tiles.get("pty-3")!.status, "busy");
  // A plain program: nothing is read, nothing named.
  h.tiles.set("pty-4", { status: "idle" });
  h.detector.foreground("pty-4", { name: "vim" });
  assertEquals(h.detector.info("pty-4").agent, undefined);
  assertEquals(h.timers.length, 0);
  h.detector.forget("pty-3");
  assertEquals(h.detector.info("pty-3").hooked, false);
});
