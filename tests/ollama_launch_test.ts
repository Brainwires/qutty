// Launching through Ollama (lib/ollama/harnesses.ts, lib/ollama/settings.ts and their place in
// the `+` picker, lib/launcher.ts): the command lines (pull-then-launch run for real through
// /bin/sh against a fake `ollama`), the harnesses offered per model, the recent pairs, the
// settings sanitizing, the picker entries and ids, and the store remembering a launched pair.

import { assert, assertEquals } from "@std/assert";
import {
  harnessChoices,
  isHarnessName,
  launchArgs,
  OLLAMA_HARNESSES,
  ollamaCommand,
  ollamaProfile,
  pullCommand,
  pullProfile,
} from "../lib/ollama/harnesses.ts";
import {
  DEFAULT_OLLAMA,
  MAX_RECENTS,
  pairEntryId,
  pairOfEntryId,
  pairTitle,
  rememberPair,
  sanitizeOllama,
} from "../lib/ollama/settings.ts";
import {
  AGENT_TOOLS,
  isEntryId,
  launchSections,
  ollamaEntries,
  plusEntry,
  plusLabel,
  sanitizePlusOpens,
} from "../lib/launcher.ts";
import {
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";

Deno.test("ollama launch: argv for a harness on a model, and for a pull", () => {
  assertEquals(launchArgs("claude", "qwen3.8:27b-mlx"), [
    "launch",
    "claude",
    "--model",
    "qwen3.8:27b-mlx",
  ]);
  assertEquals(ollamaCommand("/usr/local/bin/ollama", "codex", "m:1"), {
    program: "/usr/local/bin/ollama",
    args: ["launch", "codex", "--model", "m:1"],
  });
  assertEquals(pullCommand("/o", "mimo-v2.6"), {
    program: "/o",
    args: ["pull", "mimo-v2.6"],
  });
  // Desktop and GUI integrations are not offered.
  for (const gui of ["chatgpt", "hermes-desktop", "vscode", "claude-desktop"]) {
    assertEquals(isHarnessName(gui), false, gui);
  }
  assertEquals(OLLAMA_HARNESSES.slice(0, 5).map((h) => h.name), [
    "claude",
    "codex",
    "opencode",
    "hermes",
    "openclaw",
  ]);
  // Hermes and OpenClaw are standalone picker tools too.
  assert(AGENT_TOOLS.some((t) => t.name === "hermes"));
  assert(AGENT_TOOLS.some((t) => t.name === "openclaw"));
});

Deno.test("ollama launch: pull-then-launch runs pull, then launch with every argument after it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "qutty-ollama-sh" });
  try {
    const log = `${dir}/calls`;
    const fake = `${dir}/ollama`;
    // A fake ollama: records each call's argv, one line per call; `pull` of "bad" fails.
    Deno.writeTextFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n[ "$2" = bad ] && exit 1\nexit 0\n`,
    );
    Deno.chmodSync(fake, 0o755);
    const run = async (model: string, extra: string[]) => {
      const cmd = ollamaCommand(fake, "claude", model, true);
      // The hub's arguments are appended after a `--` (desktop/pty.ts).
      const out = await new Deno.Command(cmd.program, {
        args: [...cmd.args, ...extra],
      }).output();
      return out.code;
    };
    assertEquals(
      await run("mimo-v2.6", ["--", "--mcp-config", "/x y.json"]),
      0,
    );
    assertEquals(Deno.readTextFileSync(log).trim().split("\n"), [
      "pull mimo-v2.6",
      "launch claude --model mimo-v2.6 -- --mcp-config /x y.json",
    ]);
    Deno.removeSync(log);
    assertEquals(await run("bad", []), 1);
    assertEquals(
      Deno.readTextFileSync(log).trim().split("\n"),
      ["pull bad"],
      "a failed pull launches nothing",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ollama launch: tile profiles", () => {
  assertEquals(
    ollamaProfile("/o", { harness: "opencode", model: "m:1" }),
    {
      kind: "agent",
      program: "/o",
      args: ["launch", "opencode", "--model", "m:1"],
      name: "opencode",
      label: "OpenCode",
      ollamaModel: "m:1",
    },
  );
  assertEquals(
    ollamaProfile("/o", { harness: "claude", model: "m" }, true).program,
    "/bin/sh",
  );
  const pull = pullProfile("/o", "x:1");
  assertEquals(pull.plain, true);
  assertEquals(pull.args, ["pull", "x:1"]);
  assertEquals(pull.ollamaModel, undefined, "not an agent tile");
});

Deno.test("ollama launch: harnesses offered for a model", () => {
  const installed = new Set(["claude", "codex"]);
  // No page: every harness, uninstalled ones marked (installed first).
  const all = harnessChoices(installed, undefined);
  assertEquals(all.length, OLLAMA_HARNESSES.length);
  assertEquals(all.slice(0, 2).map((h) => [h.name, h.installed]), [
    ["claude", true],
    ["codex", true],
  ]);
  // A page with Applications: those (listed first) plus the installed ones.
  const listed = harnessChoices(installed, [
    "claude",
    "opencode",
    "hermes",
    "openclaw",
  ]);
  assertEquals(
    listed.map((h) => [h.name, h.installed, h.listed]),
    [
      ["claude", true, true],
      ["opencode", false, true],
      ["hermes", false, true],
      ["openclaw", false, true],
      ["codex", true, false],
    ],
  );
  // An empty Applications list is no information.
  assertEquals(harnessChoices(installed, []).length, OLLAMA_HARNESSES.length);
});

Deno.test("ollama settings: recent pairs, entry ids, sanitizing", () => {
  const a = { harness: "claude", model: "qwen3.8:27b-mlx" };
  const b = { harness: "codex", model: "m:1" };
  assertEquals(rememberPair([a, b], b), [b, a], "moved to the top");
  let r: typeof a[] = [];
  for (let i = 0; i < MAX_RECENTS + 3; i++) {
    r = rememberPair(r, { harness: "claude", model: `m${i}` });
  }
  assertEquals(r.length, MAX_RECENTS);
  assertEquals(r[0].model, `m${MAX_RECENTS + 2}`);

  // Ids: the model may hold a `:`.
  assertEquals(pairEntryId(a), "ollama:claude:qwen3.8:27b-mlx");
  assertEquals(pairOfEntryId("ollama:claude:qwen3.8:27b-mlx"), a);
  assertEquals(pairOfEntryId("ollama:vscode:x"), undefined, "not a harness");
  assertEquals(pairOfEntryId("ollama:claude:a b"), undefined);
  assertEquals(pairOfEntryId("agent:claude"), undefined);
  assertEquals(pairTitle(a), "claude · qwen3.8:27b-mlx");
  assertEquals(isEntryId("ollama:claude:qwen3.8:27b-mlx"), true);
  assertEquals(isEntryId("ollama:nope:x"), false);
  assertEquals(sanitizePlusOpens("ollama:codex:m:1"), "ollama:codex:m:1");
  assertEquals(sanitizePlusOpens("ollama:codex:;rm"), "default");

  assertEquals(sanitizeOllama(undefined), DEFAULT_OLLAMA);
  assertEquals(
    sanitizeOllama({
      harness: "vscode",
      model: "a b",
      recents: [a, a, { harness: "x", model: "y" }, b, "junk"],
      libraryLookedAt: -5,
    }),
    { ...DEFAULT_OLLAMA, recents: [a, b] },
  );
  assertEquals(
    sanitizeOllama({ harness: "opencode", model: "m:1", libraryLookedAt: 7 }),
    { harness: "opencode", model: "m:1", recents: [], libraryLookedAt: 7 },
  );
  assertEquals(
    sanitizeOllama({ harness: null, model: null }, {
      ...DEFAULT_OLLAMA,
      harness: "claude",
      model: "m",
    }).harness,
    null,
  );
});

Deno.test("ollama picker: pairs as entries, only when harness and model are here", () => {
  const found = { shells: [], agents: [] };
  const ollama = {
    pairs: [
      { harness: "claude", model: "m:1" },
      { harness: "claude", model: "m:1" },
      { harness: "opencode", model: "m:1" },
      { harness: "claude", model: "gone:1" },
    ],
    harnesses: new Set(["claude", "codex"]),
    models: new Set(["m:1"]),
  };
  assertEquals(ollamaEntries(ollama).map((e) => e.id), ["ollama:claude:m:1"]);
  const sections = launchSections(found, [], ollama);
  assertEquals(sections.map((s) => s.id), ["ollama"]);
  const entry = sections[0].entries[0];
  assertEquals(entry.label, "claude · m:1");
  assertEquals(plusLabel(entry), "New: claude · m:1 (Ollama)");
  assertEquals(
    plusEntry("ollama:claude:m:1", null, sections[0].entries),
    entry,
  );
  // Ollama installed with nothing to list yet: the section stays (for "Ollama models…").
  assertEquals(
    launchSections(found, [], { ...ollama, pairs: [] }).map((s) => s.id),
    ["ollama"],
  );
  // Without Ollama: no section.
  assertEquals(launchSections(found, []).map((s) => s.id), []);
});

Deno.test("ollama store: a launched pair is remembered first; settings persist", () => {
  let s = initialState();
  s = reduce(s, { type: "launched", entryId: "ollama:claude:m:1" });
  s = reduce(s, { type: "launched", entryId: "ollama:codex:m:2" });
  s = reduce(s, { type: "launched", entryId: "ollama:claude:m:1" });
  assertEquals(s.settings.lastLaunch, "ollama:claude:m:1");
  assertEquals(s.settings.ollama.recents, [
    { harness: "claude", model: "m:1" },
    { harness: "codex", model: "m:2" },
  ]);
  const same = reduce(s, { type: "launched", entryId: "ollama:claude:m:1" });
  assertEquals(same, s, "no change, same state");
  // Another kind of entry leaves the pairs alone.
  const shell = reduce(s, { type: "launched", entryId: "shell:/bin/bash" });
  assertEquals(shell.settings.ollama.recents, s.settings.ollama.recents);
  // setOllama sanitizes.
  const d = reduce(s, {
    type: "setOllama",
    patch: { harness: "opencode", model: "bad name" },
  });
  assertEquals(d.settings.ollama.harness, "opencode");
  assertEquals(d.settings.ollama.model, null);
  // Through storage.
  const back = sanitizeSettings(JSON.parse(JSON.stringify(d.settings)));
  assertEquals(back.ollama, d.settings.ollama);
  assertEquals(back.lastLaunch, "ollama:claude:m:1");
});
