// The agent hub's launch wiring (lib/hub/launch.ts), the shims' sync with lib/hub/scripts.ts,
// and the screen mirror (lib/hub/mirror.ts).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  claudeHooksSettings,
  claudeMcpConfig,
  codexHubArgs,
  hookCommand,
  hubArgsFor,
  hubPaths,
  shellQuote,
  tomlString,
} from "../lib/hub/launch.ts";
import { HOOK_EVENTS } from "../lib/hub/hooks.ts";
import { QUTTY_HOOK_SCRIPT, QUTTY_MCP_SCRIPT } from "../lib/hub/scripts.ts";
import { grepMatcher, ScreenMirror } from "../lib/hub/mirror.ts";
import { AGENT_TOOLS } from "../lib/launcher.ts";

const paths = hubPaths("/Users/ann");

Deno.test("hubPaths: everything under ~/.qutty", () => {
  assertEquals(paths, {
    dir: "/Users/ann/.qutty",
    bin: "/Users/ann/.qutty/bin",
    mcp: "/Users/ann/.qutty/bin/qutty-mcp",
    hook: "/Users/ann/.qutty/bin/qutty-hook",
    claudeMcpConfig: "/Users/ann/.qutty/claude-mcp.json",
    claudeHooks: "/Users/ann/.qutty/claude-hooks.json",
  });
  assertEquals(hubPaths("/home/bo/").dir, "/home/bo/.qutty");
});

Deno.test("argv: Claude Code gets --mcp-config and --settings; Codex -c overrides; others nothing", () => {
  assertEquals(hubArgsFor("claude", paths), [
    "--mcp-config",
    "/Users/ann/.qutty/claude-mcp.json",
    "--settings",
    "/Users/ann/.qutty/claude-hooks.json",
  ]);
  // (the Codex overrides in detail: tests/hub_codex_test.ts)
  assertEquals(hubArgsFor("codex", paths), codexHubArgs(paths));
  for (
    const tool of AGENT_TOOLS.filter((t) =>
      t.name !== "claude" && t.name !== "codex"
    )
  ) {
    assertEquals(hubArgsFor(tool.name, paths), [], tool.name);
  }
  assertEquals(hubArgsFor(undefined, paths), []);
});

Deno.test("argv: skipped when the user-scope integration is installed (no double registration)", () => {
  assertEquals(hubArgsFor("claude", paths, { claude: true }), []);
  assertEquals(hubArgsFor("codex", paths, { codex: true }), []);
  assertEquals(
    hubArgsFor("codex", paths, { claude: true }),
    codexHubArgs(paths),
  );
});

Deno.test("argv: paths with spaces and quotes stay one argument / valid TOML", () => {
  const odd = hubPaths(`/Users/a "b" c`);
  const [, value] = codexHubArgs(odd);
  assertEquals(
    value,
    `mcp_servers.qutty.command="/Users/a \\"b\\" c/.qutty/bin/qutty-mcp"`,
  );
  assertEquals(JSON.parse(tomlString("x\\y")), "x\\y");
  assertEquals(shellQuote("/plain/path"), "/plain/path");
  assertEquals(shellQuote("/it's here"), `'/it'\\''s here'`);
  assertEquals(
    hookCommand(hubPaths("/Users/my name")),
    "'/Users/my name/.qutty/bin/qutty-hook' claude",
  );
});

Deno.test("generated files: the MCP config and the hooks settings", () => {
  const mcp = JSON.parse(claudeMcpConfig(paths));
  assertEquals(mcp, {
    mcpServers: {
      qutty: { type: "stdio", command: paths.mcp, args: [], env: {} },
    },
  });
  const hooks = JSON.parse(claudeHooksSettings(paths)).hooks;
  assertEquals(Object.keys(hooks), [...HOOK_EVENTS]);
  for (const e of HOOK_EVENTS) {
    assertEquals(hooks[e], [{
      hooks: [{
        type: "command",
        command: `${paths.hook} claude`,
        timeout: 15,
      }],
    }]);
  }
});

Deno.test("shims: lib/hub/scripts.ts matches resources/bin (run scripts/gen-hub-scripts.ts)", () => {
  const root = new URL("../resources/bin/", import.meta.url);
  assertEquals(
    QUTTY_MCP_SCRIPT,
    Deno.readTextFileSync(new URL("qutty-mcp", root)),
  );
  assertEquals(
    QUTTY_HOOK_SCRIPT,
    Deno.readTextFileSync(new URL("qutty-hook", root)),
  );
  assert(QUTTY_MCP_SCRIPT.startsWith("#!/usr/bin/env bash\n"));
  assertStringIncludes(QUTTY_MCP_SCRIPT, 'exec nc -U "$QUTTY_SOCK"');
  assertStringIncludes(QUTTY_HOOK_SCRIPT, "exit 0");
});

Deno.test("mirror: screen, scrollback paging, offset, grep, resize, alternate screen", async () => {
  const m = new ScreenMirror(30, 4);
  for (let i = 0; i < 10; i++) m.write(`row ${i}\r\n`);
  m.write("\x1b[32mprompt\x1b[0m $ ");
  assertEquals(await m.screen(), ["row 7", "row 8", "row 9", "prompt $"]);
  const last = await m.scrollback({ lines: 3 });
  assertEquals([last.total, last.start], [11, 8]);
  assertEquals(last.lines.map((l) => l.text), ["row 8", "row 9", "prompt $"]);
  const fromTop = await m.scrollback({ offset: 2, lines: 2 });
  assertEquals(fromTop.lines, [{ n: 2, text: "row 2" }, {
    n: 3,
    text: "row 3",
  }]);
  const grep = await m.scrollback({ grep: "row [13]$" });
  assertEquals(grep.lines.map((l) => l.n), [1, 3]);
  // A full-screen program's alternate screen shows on read_screen; the shell's history stays.
  m.write("\x1b[?1049h\x1b[H\x1b[2Jvim buffer");
  assertEquals(await m.screen(), ["vim buffer"]);
  m.write("\x1b[?1049l");
  assertEquals((await m.screen()).at(-1), "prompt $");
  m.resize(10, 4);
  assertEquals((await m.screen()).length <= 4, true);
  m.dispose();
});

Deno.test("grepMatcher: case-insensitive regex, literal fallback for a bad pattern", () => {
  assert(grepMatcher("err(or)?")("An ERROR here"));
  assert(grepMatcher("([")("weird ([ text"));
  assertEquals(grepMatcher("([")("nothing"), false);
});
