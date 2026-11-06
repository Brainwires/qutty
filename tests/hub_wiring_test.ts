// How each harness joins the hub per session (lib/hub/wiring.ts), the files those wirings point
// at, and where desktop/pty.ts puts the hub's arguments for a tile started through
// `ollama launch` (after a final `--`, which ollama hands to the harness). What a real harness
// does with them is in tests/hub_harness_live_test.ts.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { hubArgsFor, hubPaths } from "../lib/hub/launch.ts";
import {
  dshPatch,
  HUB_ENV_NAMES,
  hubWiring,
  openclawConfig,
  openclawUserConfig,
  opencodeConfig,
  WIRED_HARNESSES,
  wiringPaths,
} from "../lib/hub/wiring.ts";
import { OLLAMA_HARNESSES } from "../lib/ollama/harnesses.ts";
import { PtyHost, setPtyTaps } from "../desktop/pty.ts";
import { Recorder } from "./pty_helpers.ts";

const paths = hubPaths("/Users/me");
const tile = {
  QUTTY_SOCK: "/tmp/qutty-501/1/pty-3.sock",
  QUTTY_TILE_ID: "pty-3",
};

Deno.test("wiring: Claude Code and Codex keep their flags (and the installed-integration skip)", () => {
  assertEquals(hubWiring("claude", paths, tile), {
    args: hubArgsFor("claude", paths),
    env: {},
  });
  assertEquals(
    hubWiring("codex", paths, tile).args,
    hubArgsFor("codex", paths),
  );
  assertEquals(hubWiring("claude", paths, tile, { claude: true }).args, []);
  assertEquals(hubWiring(undefined, paths, tile), { args: [], env: {} });
  assertEquals(hubWiring("aider", paths, tile), { args: [], env: {} });
});

Deno.test("wiring: OpenCode: a config layer by env, and a private server", () => {
  const w = hubWiring("opencode", paths, tile);
  assertEquals(w, {
    args: ["--standalone"],
    env: { OPENCODE_CONFIG: "/Users/me/.qutty/opencode.json" },
  });
  // A user's own OPENCODE_CONFIG is left alone.
  assertEquals(
    hubWiring("opencode", paths, tile, {}, { OPENCODE_CONFIG: "/mine.json" }),
    { args: [], env: {} },
  );
  const cfg = JSON.parse(opencodeConfig(paths));
  assertEquals(cfg.mcp.qutty, {
    type: "local",
    command: ["/Users/me/.qutty/bin/qutty-mcp"],
    enabled: true,
  });
});

Deno.test("wiring: OpenClaw: its local TUI on a config that includes the user's", () => {
  assertEquals(hubWiring("openclaw", paths, tile), { args: [], env: {} });
  assertEquals(
    hubWiring("openclaw", paths, tile, {}, {}, {
      openclawUserConfig: "/Users/me/.openclaw/openclaw.json",
    }),
    {
      args: ["chat"],
      env: {
        OPENCLAW_CONFIG_PATH: "/Users/me/.qutty/openclaw.json",
        // The include must be under an allowed root (by default only ~/.qutty).
        OPENCLAW_INCLUDE_ROOTS: "/Users/me/.openclaw",
      },
    },
  );
  assertEquals(
    hubWiring("openclaw", paths, tile, {}, {
      OPENCLAW_INCLUDE_ROOTS: "/etc/oc:/Users/me/.openclaw",
    }, { openclawUserConfig: "/Users/me/.openclaw/openclaw.json" }).env
      .OPENCLAW_INCLUDE_ROOTS,
    "/etc/oc:/Users/me/.openclaw",
    "the user's roots are kept",
  );
  const user = openclawUserConfig("/Users/me", paths);
  assertEquals(user, "/Users/me/.openclaw/openclaw.json");
  assertEquals(
    openclawUserConfig("/Users/me", paths, { OPENCLAW_CONFIG_PATH: "/x.json" }),
    "/x.json",
  );
  // Our own file as the user's would include itself.
  assertEquals(
    openclawUserConfig("/Users/me", paths, {
      OPENCLAW_CONFIG_PATH: wiringPaths(paths).openclawConfig,
    }),
    user,
  );
  const cfg = JSON.parse(openclawConfig(paths, user));
  assertEquals(cfg.$include, user);
  assertEquals(cfg.mcp.servers.qutty.command, "/Users/me/.qutty/bin/qutty-mcp");
  assertEquals(
    Object.keys(cfg.mcp.servers.qutty.env),
    [...HUB_ENV_NAMES],
  );
  assertEquals(cfg.mcp.servers.qutty.env.QUTTY_SOCK, "${QUTTY_SOCK}");
});

Deno.test("wiring: Qwen Code, Copilot CLI and Kimi get an inline MCP config", () => {
  const qwen = hubWiring("qwen", paths, tile);
  assertEquals(qwen.args[0], "--mcp-config");
  assertEquals(JSON.parse(qwen.args[1]), {
    mcpServers: {
      qutty: { command: "/Users/me/.qutty/bin/qutty-mcp", args: [] },
    },
  });
  const copilot = hubWiring("copilot", paths, tile);
  assertEquals(copilot.args[0], "--additional-mcp-config");
  assertEquals(JSON.parse(copilot.args[1]).mcpServers.qutty, {
    command: "/Users/me/.qutty/bin/qutty-mcp",
    args: [],
    type: "local",
    env: tile,
    tools: ["*"],
  });
  const sandboxTile = {
    QUTTY_HUB: "host.docker.internal:5000",
    QUTTY_TILE_TOKEN: "t0k",
    QUTTY_TILE_ID: "pty-4",
  };
  const kimi = hubWiring("kimi", paths, sandboxTile);
  assertEquals(kimi.args[0], "--mcp-config");
  assertEquals(JSON.parse(kimi.args[1]).mcpServers.qutty.env, sandboxTile);
});

Deno.test("wiring: dsh gets a launcher patch passing the hub variables by name", () => {
  assertEquals(hubWiring("dsh", paths, tile), {
    args: ["--patch", "/Users/me/.qutty/dsh-qutty.yml"],
    env: {},
  });
  const text = dshPatch(paths);
  for (const n of HUB_ENV_NAMES) {
    assertStringIncludes(text, `${n}: !!js process.env.${n} ?? ""`);
  }
  // Valid YAML apart from dsh's own `!!js` tag.
  const plain = parseYaml(text.replaceAll("!!js ", "")) as {
    id: string;
    config: { command: string; serverName: string };
  }[];
  assertEquals(plain[0].id, "mcp-qutty");
  assertEquals(plain[0].config.serverName, "qutty");
  assertEquals(plain[0].config.command, "/Users/me/.qutty/bin/qutty-mcp");
});

Deno.test("wiring: every wired harness is an ollama launch harness or a picker tool", () => {
  const names = new Set(OLLAMA_HARNESSES.map((h) => h.name));
  for (const h of WIRED_HARNESSES) assert(names.has(h), h);
  // The ones without a per-session mechanism get nothing.
  for (const h of ["hermes", "pi", "droid", "cline", "omp", "muse", "pool"]) {
    assertEquals(hubWiring(h, paths, tile), { args: [], env: {} }, h);
  }
});

Deno.test({
  name:
    "pty: an `ollama launch` tile gets the hub's arguments after `--`; another, before its own",
  ignore: Deno.build.os === "windows",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const rec = new Recorder();
    const host = new PtyHost(rec.emit, { tapped: true });
    setPtyTaps({
      spawning: (_id, info) => ({
        env: { QUTTY_X: info.ollamaModel ?? "none" },
        args: ["--hub", "a b"],
      }),
    });
    try {
      // `/bin/sh -c 'echo "$QUTTY_X|$*"' sh <args>` prints the argv it was given.
      const run = async (ollamaModel?: string) => {
        const { id } = await host.spawn({
          cols: 120,
          rows: 10,
          program: "/bin/sh",
          args: ["-c", 'echo "[$QUTTY_X|$*]"', "sh", "launch", "claude"],
          agent: "claude",
          ...(ollamaModel ? { ollamaModel } : {}),
        });
        await rec.waitExit(id, 10_000);
        return rec.text(id);
      };
      assertStringIncludes(
        await run("m:1"),
        "[m:1|launch claude -- --hub a b]",
      );
      // Not through ollama: before the program's own (here they land in `sh`'s argv instead).
      const plain = await run();
      assert(!plain.includes("-- --hub"), plain);
    } finally {
      setPtyTaps(undefined);
      await host.dispose();
    }
  },
});
