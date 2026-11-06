// Settings → Agent integration (lib/hub/integration.ts) on a temporary HOME: Install writes
// exactly Qutty's entries, keeps everything else (byte-identical after Uninstall), is idempotent,
// backs files up once, follows symlinks, refuses foreign `qutty` entries, and Uninstall removes
// exactly what it added. Never touches the real HOME.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  installIntegration,
  type IntegrationFiles,
  integrationFiles,
  integrationStatus,
  uninstallIntegration,
} from "../lib/hub/integration.ts";
import {
  codexHookHash,
  codexHookKey,
  hookCommand,
  type HubPaths,
  hubPaths,
} from "../lib/hub/launch.ts";
import { CODEX_HOOK_EVENTS, HOOK_EVENTS } from "../lib/hub/hooks.ts";
import { denoConfigFs } from "./hub_helpers.ts";

interface Home {
  home: string;
  files: IntegrationFiles;
  paths: HubPaths;
  read(rel: string): string | undefined;
  write(rel: string, text: string): void;
  install(t: "claude" | "codex"): Promise<void>;
  uninstall(t: "claude" | "codex"): Promise<void>;
}

async function withHome(fn: (h: Home) => Promise<void>): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "qutty-int-" });
  const paths = hubPaths(home);
  const files = integrationFiles(home, paths);
  const h: Home = {
    home,
    files,
    paths,
    read(rel) {
      try {
        return Deno.readTextFileSync(`${home}/${rel}`);
      } catch {
        return undefined;
      }
    },
    write(rel, text) {
      Deno.mkdirSync(`${home}/${rel}`.replace(/\/[^/]+$/, ""), {
        recursive: true,
      });
      Deno.writeTextFileSync(`${home}/${rel}`, text);
    },
    install: (t) => installIntegration(denoConfigFs, files, paths, t),
    uninstall: (t) => uninstallIntegration(denoConfigFs, files, paths, t),
  };
  try {
    await fn(h);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

/** A ~/.claude.json the way Claude Code writes it: 2-space JSON, no trailing newline. */
const CLAUDE_JSON = JSON.stringify(
  {
    numStartups: 42,
    projects: {
      "/repo": { allowedTools: [], history: [{ display: "hi ünïcode ✓" }] },
    },
    mcpServers: {
      other: { type: "stdio", command: "/bin/other", args: ["-x"], env: {} },
    },
    oauthAccount: { emailAddress: "someone@example.com" },
  },
  null,
  2,
);

/** A settings.json with the user's own hooks and other settings, trailing newline. */
const SETTINGS = JSON.stringify(
  {
    permissions: { allow: ["Bash(ls:*)"] },
    model: "opus",
    hooks: {
      Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
      Stop: [{
        matcher: "",
        hooks: [{ type: "command", command: "afplay x.aiff" }],
      }],
    },
    theme: "dark",
  },
  null,
  2,
) + "\n";

const CODEX = `model = "gpt-5"
approval_policy = "on-request"

[mcp_servers.docs]
command = "docs-mcp"
args = ["--stdio"]
`;

Deno.test("claude: install adds mcpServers.qutty and one hook group per event, keeping the rest", async () => {
  await withHome(async (h) => {
    h.write(".claude.json", CLAUDE_JSON);
    h.write(".claude/settings.json", SETTINGS);
    await h.install("claude");

    const cj = JSON.parse(h.read(".claude.json")!);
    assertEquals(cj.mcpServers.qutty, {
      type: "stdio",
      command: h.paths.mcp,
      args: [],
      env: {},
    });
    assertEquals(cj.mcpServers.other.command, "/bin/other");
    assertEquals(cj.numStartups, 42);
    assert(
      !h.read(".claude.json")!.endsWith("\n"),
      "keeps no trailing newline",
    );

    const s = JSON.parse(h.read(".claude/settings.json")!);
    for (const e of HOOK_EVENTS) {
      const ours = s.hooks[e].filter((g: { hooks: { command: string }[] }) =>
        g.hooks.some((x) => x.command === hookCommand(h.paths))
      );
      assertEquals(ours.length, 1, e);
    }
    assertEquals(s.hooks.Notification[0].hooks[0].command, "say done");
    assertEquals(s.hooks.Stop[0].hooks[0].command, "afplay x.aiff");
    assertEquals(s.model, "opus");
    assert(h.read(".claude/settings.json")!.endsWith("\n"));

    // Backups of the originals.
    assertEquals(h.read(".claude.json.qutty-backup"), CLAUDE_JSON);
    assertEquals(h.read(".claude/settings.json.qutty-backup"), SETTINGS);

    const [claude] = await integrationStatus(denoConfigFs, h.files, h.paths);
    assertEquals(claude.installed, true);
  });
});

Deno.test("claude: install is idempotent; uninstall restores the original bytes", async () => {
  await withHome(async (h) => {
    h.write(".claude.json", CLAUDE_JSON);
    h.write(".claude/settings.json", SETTINGS);
    await h.install("claude");
    const once = [h.read(".claude.json"), h.read(".claude/settings.json")];
    await h.install("claude");
    assertEquals(
      [h.read(".claude.json"), h.read(".claude/settings.json")],
      once,
    );
    await h.uninstall("claude");
    assertEquals(h.read(".claude.json"), CLAUDE_JSON);
    assertEquals(h.read(".claude/settings.json"), SETTINGS);
    const [claude] = await integrationStatus(denoConfigFs, h.files, h.paths);
    assertEquals(claude.installed, false);
    // Uninstall again: nothing to do, nothing changes.
    await h.uninstall("claude");
    assertEquals(h.read(".claude.json"), CLAUDE_JSON);
  });
});

Deno.test("claude: containers Qutty created are removed; ones the user had stay (even if empty)", async () => {
  await withHome(async (h) => {
    const noServers = JSON.stringify({ numStartups: 1 }, null, 2);
    const emptyHooks = JSON.stringify({ hooks: {} }, null, 2) + "\n";
    h.write(".claude.json", noServers);
    h.write(".claude/settings.json", emptyHooks);
    await h.install("claude");
    await h.uninstall("claude");
    assertEquals(h.read(".claude.json"), noServers);
    assertEquals(h.read(".claude/settings.json"), emptyHooks);
  });
});

Deno.test("claude: files that did not exist are created, then removed by uninstall", async () => {
  await withHome(async (h) => {
    await h.install("claude");
    assert(h.read(".claude.json"));
    assert(h.read(".claude/settings.json"));
    assertEquals(h.read(".claude.json.qutty-backup"), undefined);
    await h.uninstall("claude");
    assertEquals(h.read(".claude.json"), undefined);
    assertEquals(h.read(".claude/settings.json"), undefined);
  });
});

Deno.test("claude: hooks the user added after install survive uninstall", async () => {
  await withHome(async (h) => {
    h.write(".claude.json", CLAUDE_JSON);
    await h.install("claude");
    const s = JSON.parse(h.read(".claude/settings.json")!);
    s.hooks.PostToolUse.push({
      matcher: "Edit",
      hooks: [{ type: "command", command: "lint" }],
    });
    h.write(".claude/settings.json", JSON.stringify(s, null, 2) + "\n");
    await h.uninstall("claude");
    const after = JSON.parse(h.read(".claude/settings.json")!);
    assertEquals(after.hooks.PostToolUse, [{
      matcher: "Edit",
      hooks: [{ type: "command", command: "lint" }],
    }]);
    assertEquals(Object.keys(after.hooks), ["PostToolUse"]);
  });
});

Deno.test("claude: a qutty server Qutty did not write is refused and reported", async () => {
  await withHome(async (h) => {
    const foreign = JSON.stringify(
      { mcpServers: { qutty: { command: "/elsewhere/qutty" } } },
      null,
      2,
    );
    h.write(".claude.json", foreign);
    await assertRejects(() => h.install("claude"), Error, "did not add");
    assertEquals(h.read(".claude.json"), foreign);
    const [claude] = await integrationStatus(denoConfigFs, h.files, h.paths);
    assertEquals(claude.installed, false);
    assertStringIncludes(claude.note ?? "", "did not add");
  });
});

Deno.test("claude: a symlinked settings.json is edited at its target (the link stays)", async () => {
  await withHome(async (h) => {
    h.write("dotfiles/claude-settings.json", SETTINGS);
    Deno.mkdirSync(`${h.home}/.claude`, { recursive: true });
    Deno.symlinkSync(
      `${h.home}/dotfiles/claude-settings.json`,
      `${h.home}/.claude/settings.json`,
    );
    await h.install("claude");
    assert(Deno.lstatSync(`${h.home}/.claude/settings.json`).isSymlink);
    assertStringIncludes(
      h.read("dotfiles/claude-settings.json")!,
      "qutty-hook",
    );
    await h.uninstall("claude");
    assertEquals(h.read("dotfiles/claude-settings.json"), SETTINGS);
  });
});

Deno.test("claude: invalid JSON is not touched", async () => {
  await withHome(async (h) => {
    h.write(".claude.json", "{ nope");
    await assertRejects(() => h.install("claude"), Error, "not valid JSON");
    assertEquals(h.read(".claude.json"), "{ nope");
  });
});

/** The Codex row of the panel's status. */
async function codexStatus(h: Home) {
  return (await integrationStatus(denoConfigFs, h.files, h.paths))[1];
}

/** Codex shows as installed; Uninstall then gives back exactly `original`. */
async function installedThenRestored(h: Home, original: string) {
  assertEquals((await codexStatus(h)).installed, true);
  await h.uninstall("codex");
  assertEquals(h.read(".codex/config.toml"), original);
}

/** Codex's block is there but out of date. */
async function assertStale(h: Home) {
  const codex = await codexStatus(h);
  assertEquals(codex.installed, false);
  assertStringIncludes(codex.note ?? "", "Out of date");
}

Deno.test("codex: install appends a marked block; idempotent; uninstall restores the bytes", async () => {
  await withHome(async (h) => {
    h.write(".codex/config.toml", CODEX);
    await h.install("codex");
    const text = h.read(".codex/config.toml")!;
    assert(text.startsWith(CODEX));
    assertStringIncludes(
      text,
      `[mcp_servers.qutty]\ncommand = "${h.paths.mcp}"\nargs = []\n` +
        `env_vars = ["QUTTY_SOCK", "QUTTY_TILE_ID", "QUTTY_HUB", "QUTTY_TILE_TOKEN"]\n`,
    );
    // One hook group per event, and its trust keyed by Codex's (resolved) config path.
    const config = `${Deno.realPathSync(`${h.home}/.codex`)}/config.toml`;
    for (const e of CODEX_HOOK_EVENTS) {
      assertStringIncludes(
        text,
        `\n[[hooks.${e}]]\nhooks = [{ type = "command", command = "${h.paths.hook} codex", timeout = ${
          e === "Interrupt" ? 3 : 15
        } }]\n`,
      );
      assertStringIncludes(
        text,
        `\n[hooks.state."${codexHookKey(config, e, 0)}"]\ntrusted_hash = "${
          codexHookHash(h.paths, e)
        }"\n`,
      );
    }
    await h.install("codex");
    assertEquals(h.read(".codex/config.toml"), text);
    assertEquals(h.read(".codex/config.toml.qutty-backup"), CODEX);
    await installedThenRestored(h, CODEX);
  });
});

Deno.test("codex: a file without a final newline, an absent file, and a foreign qutty table", async () => {
  await withHome(async (h) => {
    h.write(".codex/config.toml", 'model = "o3"');
    await h.install("codex");
    await h.uninstall("codex");
    assertEquals(h.read(".codex/config.toml"), 'model = "o3"');
  });
  await withHome(async (h) => {
    await h.install("codex");
    assert(h.read(".codex/config.toml")!.startsWith("# >>> qutty"));
    await h.uninstall("codex");
    assertEquals(h.read(".codex/config.toml"), undefined);
  });
  await withHome(async (h) => {
    const mine = `[mcp_servers.qutty]\ncommand = "mine"\n`;
    h.write(".codex/config.toml", mine);
    await assertRejects(() => h.install("codex"), Error, "already configures");
    assertEquals(h.read(".codex/config.toml"), mine);
    const [, codex] = await integrationStatus(denoConfigFs, h.files, h.paths);
    assertStringIncludes(codex.note ?? "", "already configures");
  });
});

Deno.test("codex: content the user added after Qutty's block survives uninstall", async () => {
  await withHome(async (h) => {
    h.write(".codex/config.toml", CODEX);
    await h.install("codex");
    h.write(
      ".codex/config.toml",
      h.read(".codex/config.toml")! + '\n[profiles.fast]\nmodel = "o4-mini"\n',
    );
    await h.uninstall("codex");
    assertEquals(
      h.read(".codex/config.toml"),
      CODEX + '\n[profiles.fast]\nmodel = "o4-mini"\n',
    );
  });
});

Deno.test("codex: Qutty's hook groups go after the user's own, and their trust keys say so", async () => {
  await withHome(async (h) => {
    const mine = CODEX +
      `\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "say done" }]\n` +
      `\n[[hooks.Stop]]\nmatcher = ""\nhooks = [{ type = "command", command = "true" }]\n` +
      `\n[hooks.state."/elsewhere/config.toml:stop:0:0"]\ntrusted_hash = "sha256:00"\n`;
    h.write(".codex/config.toml", mine);
    await h.install("codex");
    const text = h.read(".codex/config.toml")!;
    assert(text.startsWith(mine));
    const config = `${Deno.realPathSync(`${h.home}/.codex`)}/config.toml`;
    assertStringIncludes(text, `"${codexHookKey(config, "Stop", 2)}"`);
    assertStringIncludes(text, `"${codexHookKey(config, "SessionStart", 0)}"`);
    assertEquals((await codexStatus(h)).note, undefined);
    await installedThenRestored(h, mine);
  });
});

Deno.test("codex: a hook group added before Qutty's block makes it out of date; Install refreshes it", async () => {
  await withHome(async (h) => {
    h.write(".codex/config.toml", CODEX);
    await h.install("codex");
    const config = `${Deno.realPathSync(`${h.home}/.codex`)}/config.toml`;
    const theirs =
      `\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "say done" }]\n`;
    h.write(
      ".codex/config.toml",
      CODEX + theirs + h.read(".codex/config.toml")!.slice(CODEX.length),
    );
    await assertStale(h);
    await h.install("codex");
    const text = h.read(".codex/config.toml")!;
    assertEquals(text.split("# >>> qutty").length, 2);
    assertStringIncludes(text, `"${codexHookKey(config, "Stop", 1)}"`);
    await installedThenRestored(h, CODEX + theirs);
  });
});

Deno.test("codex: an older Qutty's block (server only) is out of date and refreshed in place", async () => {
  await withHome(async (h) => {
    const old = CODEX +
      "\n# >>> qutty (Settings → Agent integration; Uninstall removes this block) >>>\n" +
      `[mcp_servers.qutty]\ncommand = "${h.paths.mcp}"\nargs = []\n# <<< qutty <<<\n`;
    h.write(".codex/config.toml", old);
    await assertStale(h);
    await h.install("codex");
    const text = h.read(".codex/config.toml")!;
    assert(text.startsWith(CODEX));
    assertEquals(text.split("[mcp_servers.qutty]").length, 2);
    assertStringIncludes(text, "[[hooks.Stop]]");
    await installedThenRestored(h, CODEX);
  });
});

Deno.test("codex: inline hooks, inline trust and invalid TOML are refused untouched", async () => {
  for (
    const [mine, why] of [
      [`${CODEX}\n[hooks]\nStop = [{ hooks = [] }]\n`, "hooks.Stop inline"],
      [`hooks = {}\n${CODEX}`, "hooks inline"],
      [`${CODEX}\n[hooks]\nstate = {}\n`, "hooks.state inline"],
      [`${CODEX}\n[broken\n`, "not valid TOML"],
    ]
  ) {
    await withHome(async (h) => {
      h.write(".codex/config.toml", mine);
      await assertRejects(() => h.install("codex"), Error, why);
      assertEquals(h.read(".codex/config.toml"), mine);
      assertEquals(h.read(".codex/config.toml.qutty-backup"), undefined);
      const [, codex] = await integrationStatus(denoConfigFs, h.files, h.paths);
      assertStringIncludes(codex.note ?? "", why);
    });
  }
});

Deno.test("codex: a config.toml Qutty created is refreshed, not duplicated, by a second Install", async () => {
  await withHome(async (h) => {
    await h.install("codex");
    const once = h.read(".codex/config.toml")!;
    await h.install("codex");
    assertEquals(h.read(".codex/config.toml"), once);
    await h.uninstall("codex");
    assertEquals(h.read(".codex/config.toml"), undefined);
  });
});

Deno.test("status: shows exactly what Install writes, with ~ for the home folder", async () => {
  await withHome(async (h) => {
    const [claude, codex] = await integrationStatus(
      denoConfigFs,
      h.files,
      h.paths,
    );
    assertEquals(claude.changes.map((c) => c.path), [
      "~/.claude.json",
      "~/.claude/settings.json",
    ]);
    assertStringIncludes(claude.changes[0].adds, h.paths.mcp);
    assertStringIncludes(claude.changes[1].adds, "SessionStart");
    assertEquals(codex.changes[0].path, "~/.codex/config.toml");
    assertStringIncludes(codex.changes[0].adds, "[mcp_servers.qutty]");
    assertEquals([claude.installed, codex.installed], [false, false]);
  });
});

Deno.test("file modes are kept", async () => {
  await withHome(async (h) => {
    h.write(".claude.json", CLAUDE_JSON);
    Deno.chmodSync(`${h.home}/.claude.json`, 0o600);
    await h.install("claude");
    assertEquals(
      (Deno.statSync(`${h.home}/.claude.json`).mode ?? 0) & 0o777,
      0o600,
    );
  });
});
