// The `+` picker's pure rules (lib/launcher.ts): /etc/shells parsing, shell dedupe and order,
// agent detection results, the menu sections, keyboard movement and what plain `+` opens.

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  AGENT_TOOLS,
  buildAgents,
  buildShells,
  flatEntries,
  isEntryId,
  type Launchables,
  launchSections,
  moveIndex,
  parseEtcShells,
  plusEntry,
  plusLabel,
  sanitizePlusOpens,
  userBinDirs,
} from "../lib/launcher.ts";

Deno.test("parseEtcShells: absolute paths in order, comments and repeats dropped", () => {
  const text = [
    "# List of acceptable shells for chpass(1).",
    "",
    "/bin/bash",
    "/bin/csh  # the C shell",
    "  /bin/zsh  ",
    "bin/relative",
    "/bin/bash",
    "/opt/my shell/x",
    "/usr/local/bin/fish\r",
  ].join("\n");
  assertEquals(parseEtcShells(text), [
    "/bin/bash",
    "/bin/csh",
    "/bin/zsh",
    "/usr/local/bin/fish",
  ]);
  assertEquals(parseEtcShells(""), []);
});

Deno.test("buildShells: unusable paths are dropped, the default comes first", () => {
  const shells = buildShells(
    [
      { path: "/bin/sh", real: "/bin/sh" },
      { path: "/bin/zsh", real: "/bin/zsh" },
      { path: "/bin/tcsh" }, // missing or not executable
      { path: "/bin/bash", real: "/bin/bash" },
    ],
    { path: "/bin/zsh", real: "/bin/zsh" },
  );
  assertEquals(shells, [
    { path: "/bin/zsh", label: "zsh", isDefault: true },
    { path: "/bin/bash", label: "bash", isDefault: false },
    { path: "/bin/sh", label: "sh", isDefault: false },
  ]);
});

Deno.test("buildShells: merged-/usr duplicates collapse to one per real file", () => {
  // Debian-style: /bin -> usr/bin, /usr/bin/sh -> dash.
  const shells = buildShells(
    [
      { path: "/bin/sh", real: "/usr/bin/dash" },
      { path: "/usr/bin/sh", real: "/usr/bin/dash" },
      { path: "/bin/bash", real: "/usr/bin/bash" },
      { path: "/usr/bin/bash", real: "/usr/bin/bash" },
      { path: "/bin/dash", real: "/usr/bin/dash" },
    ],
    { path: "/usr/bin/bash", real: "/usr/bin/bash" },
  );
  // The default's own path is kept for its group; the first listed for the others.
  assertEquals(shells, [
    { path: "/usr/bin/bash", label: "bash", isDefault: true },
    { path: "/bin/sh", label: "sh", isDefault: false },
  ]);
});

Deno.test("buildShells: a default missing from /etc/shells is still offered", () => {
  const shells = buildShells(
    [{ path: "/bin/zsh", real: "/bin/zsh" }],
    {
      path: "/opt/homebrew/bin/fish",
      real: "/opt/homebrew/Cellar/fish/4/bin/fish",
    },
  );
  assertEquals(shells.map((s) => [s.path, s.isDefault]), [
    ["/opt/homebrew/bin/fish", true],
    ["/bin/zsh", false],
  ]);
  // No usable default: nothing is marked.
  assertEquals(
    buildShells([{ path: "/bin/zsh", real: "/bin/zsh" }], { path: "/nope" })
      .map((s) => s.isDefault),
    [false],
  );
  assertEquals(buildShells([], undefined), []);
});

Deno.test("buildShells: same name, different programs are both kept (sorted by path)", () => {
  const shells = buildShells(
    [
      {
        path: "/opt/homebrew/bin/bash",
        real: "/opt/homebrew/Cellar/bash/5/bin/bash",
      },
      { path: "/bin/bash", real: "/bin/bash" },
    ],
    undefined,
  );
  assertEquals(shells.map((s) => s.path), [
    "/bin/bash",
    "/opt/homebrew/bin/bash",
  ]);
});

Deno.test("buildAgents: found tools in table order, with their resolved path", () => {
  const found = new Map([
    ["codex", "/opt/homebrew/bin/codex"],
    ["claude", "/Users/me/.local/bin/claude"],
    ["unknown-tool", "/x"],
  ]);
  assertEquals(buildAgents(found), [
    {
      name: "claude",
      label: "Claude Code",
      path: "/Users/me/.local/bin/claude",
    },
    { name: "codex", label: "Codex", path: "/opt/homebrew/bin/codex" },
  ]);
  assertEquals(buildAgents(new Map()), []);
  // The table is data: claude and codex first, more can follow.
  assertEquals(AGENT_TOOLS.slice(0, 2).map((t) => t.name), ["claude", "codex"]);
});

Deno.test("userBinDirs: under the home folder, none without one", () => {
  const dirs = userBinDirs("/Users/me/");
  assertEquals(dirs[0], "/Users/me/.local/bin");
  assertEquals(dirs.includes("/Users/me/.claude/local"), true);
  assertEquals(userBinDirs(undefined), []);
  assertEquals(userBinDirs("relative"), []);
});

const FOUND: Launchables = {
  shells: [
    { path: "/bin/zsh", label: "zsh", isDefault: true },
    { path: "/bin/bash", label: "bash", isDefault: false },
  ],
  agents: [{
    name: "claude",
    label: "Claude Code",
    path: "/u/.local/bin/claude",
  }],
};

Deno.test("launchSections: shells, agents, ssh; empty sections left out", () => {
  const sections = launchSections(FOUND, [{ alias: "web-1" }, {
    alias: "db",
    tint: "red",
  }]);
  assertEquals(sections.map((s) => s.id), ["shells", "agents", "ssh"]);
  assertEquals(flatEntries(sections).map((e) => e.id), [
    "shell:/bin/zsh",
    "shell:/bin/bash",
    "agent:claude",
    "ssh:web-1",
    "ssh:db",
  ]);
  assertEquals(flatEntries(sections)[0].detail, "/bin/zsh · default");
  assertEquals(
    launchSections({ shells: FOUND.shells, agents: [] }, []).map((s) => s.id),
    ["shells"],
  );
});

Deno.test("moveIndex: wraps, enters from either end, empty list", () => {
  assertEquals(moveIndex(3, 0, 1), 1);
  assertEquals(moveIndex(3, 2, 1), 0);
  assertEquals(moveIndex(3, 0, -1), 2);
  assertEquals(moveIndex(3, -1, 1), 0);
  assertEquals(moveIndex(3, -1, -1), 2);
  assertEquals(moveIndex(3, 7, 1), 0);
  assertEquals(moveIndex(0, 0, 1), -1);
});

Deno.test("plusEntry: default, last used, a specific entry, and fallbacks", () => {
  const entries = flatEntries(launchSections(FOUND, [{ alias: "web-1" }]));
  assertStrictEquals(plusEntry("default", "agent:claude", entries), undefined);
  assertEquals(plusEntry("last", "agent:claude", entries)?.id, "agent:claude");
  assertStrictEquals(plusEntry("last", null, entries), undefined);
  assertEquals(plusEntry("ssh:web-1", null, entries)?.id, "ssh:web-1");
  assertEquals(
    plusEntry("shell:/bin/bash", null, entries)?.id,
    "shell:/bin/bash",
  );
  // Gone (uninstalled, deleted, not loaded yet): the default shell.
  assertStrictEquals(plusEntry("agent:codex", null, entries), undefined);
  assertStrictEquals(plusEntry("last", "ssh:gone", entries), undefined);
  assertStrictEquals(plusEntry("agent:claude", null, []), undefined);
  // The default shell's own entry is plain `+`.
  assertStrictEquals(plusEntry("shell:/bin/zsh", null, entries), undefined);
});

Deno.test("plusLabel: the + tooltip", () => {
  const entries = flatEntries(launchSections(FOUND, [{ alias: "web-1" }]));
  assertEquals(plusLabel(undefined), "New terminal");
  assertEquals(plusLabel(entries[2]), "New: Claude Code");
  assertEquals(plusLabel(entries[3]), "New: ssh web-1");
});

Deno.test("sanitizePlusOpens and isEntryId", () => {
  assertEquals(sanitizePlusOpens("default"), "default");
  assertEquals(sanitizePlusOpens("last"), "last");
  assertEquals(sanitizePlusOpens("agent:claude"), "agent:claude");
  assertEquals(sanitizePlusOpens("shell:/bin/zsh"), "shell:/bin/zsh");
  for (
    const bad of [
      "",
      "agent:",
      "nope:x",
      3,
      null,
      {},
      "ssh:a\0b",
      `ssh:${"x".repeat(1100)}`,
    ]
  ) {
    assertEquals(sanitizePlusOpens(bad), "default", String(bad));
  }
  assertEquals(isEntryId("ssh:web-1"), true);
  assertEquals(isEntryId("ssh"), false);
});
