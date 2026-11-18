// Agent presets (lib/agent/presets.ts) and what goes with them: typed tool lists, stored presets
// checked, Settings keeping them (lib/workspace/store.ts), a tile's entry carrying a preset's
// prompt and tools, Claude Code's flags for them; the permission mode's names; and the agents'
// avatars (lib/agent/avatar.ts): the same name, the same picture, in the harness's colour.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  isToolPattern,
  MAX_PRESETS,
  nextPresetId,
  parseToolList,
  sanitizePresets,
} from "../lib/agent/presets.ts";
import {
  agentAvatar,
  AVATAR_CELLS,
  HARNESS_COLORS,
} from "../lib/agent/avatar.ts";
import { MODE_LABELS, sanitizeChat } from "../lib/agent/tile.ts";
import { PERMISSION_MODES } from "../lib/agent/adapter.ts";
import { claudeAgentFlags } from "../lib/agent/claude-stream.ts";
import { agentStartInput } from "../desktop/agent-host.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";

Deno.test("tool lists: commas, spaces or lines between; a pattern keeps its spaces", () => {
  assertEquals(
    parseToolList("Read, Grep\nBash(git diff:*)  mcp__qutty__read_screen,Read"),
    ["Read", "Grep", "Bash(git diff:*)", "mcp__qutty__read_screen"],
  );
  assertEquals(parseToolList("bad(name, $x, (y)"), []);
  assert(isToolPattern("Bash(npm run test:*)"));
  assert(!isToolPattern("Bash(a)(b)"));
  assert(!isToolPattern("--dangerously-skip-permissions"));
});

Deno.test("stored presets: the well-formed ones, unique, defaults dropped", () => {
  const presets = sanitizePresets([
    {
      id: "p1",
      name: "  Reviewer ",
      model: "opus",
      mode: "plan",
      systemPrompt: " Review only. ",
      allowedTools: ["Read", "rm -rf", "Grep"],
    },
    { id: "p1", name: "dup" },
    { id: "p2", name: "", model: "opus" },
    { id: "bad id!", name: "x" },
    { id: "p3", name: "Plain", mode: "default", model: "no spaces allowed" },
    "junk",
  ]);
  assertEquals(presets, [
    {
      id: "p1",
      name: "Reviewer",
      model: "opus",
      mode: "plan",
      systemPrompt: "Review only.",
      allowedTools: ["Read", "Grep"],
    },
    { id: "p3", name: "Plain" },
  ]);
  assertEquals(
    sanitizePresets(
      Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: `n${i}` })),
    ).length,
    MAX_PRESETS,
  );
  assertEquals(nextPresetId([{ id: "p2", name: "a" }]), "p3");
  assertEquals(
    nextPresetId([{ id: "p1", name: "a" }, { id: "p3", name: "b" }]),
    "p4",
  );
});

Deno.test("Settings keep the presets; the reducer replaces the list", () => {
  assertEquals(DEFAULT_SETTINGS.agentPresets, []);
  const s = sanitizeSettings({
    agentPresets: [{ id: "p1", name: "Docs", allowedTools: ["Read"] }],
  });
  assertEquals(s.agentPresets, [{
    id: "p1",
    name: "Docs",
    allowedTools: ["Read"],
  }]);
  const state = initialState();
  const next = reduce(state, {
    type: "setAgentPresets",
    presets: [{ id: "p9", name: "Tester", mode: "acceptEdits" }],
  });
  assertEquals(next.settings.agentPresets, [{
    id: "p9",
    name: "Tester",
    mode: "acceptEdits",
  }]);
  assertEquals(
    reduce(next, {
      type: "setAgentPresets",
      presets: next.settings.agentPresets,
    }),
    next,
  );
});

Deno.test("a tile's entry carries its preset; Claude Code gets its prompt and tools", () => {
  const chat = sanitizeChat({
    cwd: "/w",
    preset: "Reviewer",
    mode: "plan",
    systemPrompt: "Review only.",
    allowedTools: ["Read", "Bash(git diff:*)", "nope nope"],
  });
  assertEquals(chat, {
    cwd: "/w",
    mode: "plan",
    preset: "Reviewer",
    systemPrompt: "Review only.",
    allowedTools: ["Read", "Bash(git diff:*)"],
  });
  const flags = claudeAgentFlags({
    claude: "claude",
    hubArgs: [],
    env: {},
    spec: {
      cwd: "/w",
      permissionMode: "plan",
      systemPrompt: "Review only.",
      allowedTools: ["Read", "Bash(git diff:*)"],
    },
  });
  const after = (flag: string) => flags[flags.indexOf(flag) + 1];
  assertEquals(after("--permission-mode"), "plan");
  assertEquals(after("--append-system-prompt"), "Review only.");
  assertEquals(after("--allowedTools"), "Read,Bash(git diff:*)");
  // No preset: no such flags.
  const plain = claudeAgentFlags({
    claude: "c",
    hubArgs: [],
    env: {},
    spec: { cwd: "/w" },
  });
  assert(
    !plain.includes("--append-system-prompt") &&
      !plain.includes("--allowedTools"),
  );
  // The page's start request is checked the same way.
  const parsed = agentStartInput["~standard"].validate({
    cwd: "/w",
    systemPrompt: "  x  ",
    allowedTools: ["Read", 3, "$(evil)"],
  }) as { value: { systemPrompt?: string; allowedTools?: string[] } };
  assertEquals(parsed.value.systemPrompt, "x");
  assertEquals(parsed.value.allowedTools, ["Read"]);
});

Deno.test("every permission mode has a header name", () => {
  for (const m of PERMISSION_MODES) assert(MODE_LABELS[m]);
  assertEquals(MODE_LABELS.bypassPermissions, "bypass");
});

Deno.test("avatars: one name, one picture, mirrored, in the harness's colour", () => {
  const a = agentAvatar("builder");
  assertEquals(agentAvatar("builder"), a);
  assertEquals(agentAvatar("  Builder "), a);
  assertNotEquals(agentAvatar("reviewer").cells, a.cells);
  assertEquals(a.color, HARNESS_COLORS.claude);
  assertEquals(agentAvatar("builder", "codex").color, "#10a37f");
  assertEquals(agentAvatar("builder", "gemini").color, "#4c8df6");
  assertEquals(agentAvatar("builder", "unknown").color, "#d97757");
  assertEquals(a.cells.length, AVATAR_CELLS * AVATAR_CELLS);
  for (let y = 0; y < AVATAR_CELLS; y++) {
    for (let x = 0; x < AVATAR_CELLS; x++) {
      assertEquals(
        a.cells[y * AVATAR_CELLS + x],
        a.cells[y * AVATAR_CELLS + AVATAR_CELLS - 1 - x],
      );
    }
  }
  // Never blank, whatever the name.
  for (const n of ["", "a", "claude", "x".repeat(100)]) {
    assert(agentAvatar(n).cells.some(Boolean), n);
  }
  assert(a.shade >= 0.55 && a.shade <= 1);
});
