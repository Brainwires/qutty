// Settings → Agent integration for Hermes Agent (lib/hub/integration-hermes.ts) on a temporary
// HOME: Install adds `mcp_servers.qutty` to ~/.hermes/config.yaml (a new file, the end of one
// without `mcp_servers`, or inside an existing block map at its indentation), Uninstall gives
// back the original bytes, it is idempotent, backs up once, refuses a foreign `qutty` server
// and a flow-style map. Never touches the real HOME.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import {
  installIntegration,
  integrationFiles,
  integrationStatus,
  uninstallIntegration,
} from "../lib/hub/integration.ts";
import { hubPaths } from "../lib/hub/launch.ts";
import {
  addHermes,
  hermesInstalled,
  removeHermes,
} from "../lib/hub/integration-hermes.ts";
import { denoConfigFs } from "./hub_helpers.ts";

const paths = hubPaths("/Users/me");

/** The `mcp_servers` map of a YAML text. */
const servers = (text: string) =>
  (parseYaml(text) as { mcp_servers: Record<string, Record<string, unknown>> })
    .mcp_servers;

Deno.test("hermes: add and remove round-trip the bytes", () => {
  const cases: (string | undefined)[] = [
    undefined,
    "",
    "\n",
    "model:\n  provider: ollama\n",
    "model:\n  provider: ollama", // no final newline
    "model: x\nmcp_servers:\n  github:\n    command: gh-mcp\nterminal:\n  backend: local\n",
    "mcp_servers:\n    deep:\n        command: x\n", // four-space indentation
    "mcp_servers: # mine\n\n  # a comment first\n  a:\n    url: http://x\n",
    "mcp_servers:\n", // an empty block map (null)
  ];
  for (const before of cases) {
    const after = addHermes(before, paths);
    const qutty = servers(after).qutty as {
      command: string;
      env: Record<string, string>;
    };
    assertEquals(
      qutty.command,
      "/Users/me/.qutty/bin/qutty-mcp",
      String(before),
    );
    assertEquals(qutty.env.QUTTY_SOCK, "${QUTTY_SOCK}");
    assertEquals(hermesInstalled(after, paths), "current", String(before));
    // The user's own servers are still there.
    if (before?.includes("github:")) assert(servers(after).github);
    if (before?.includes("deep:")) assert(servers(after).deep);
    // Idempotent.
    assertEquals(addHermes(after, paths), after);
    assertEquals(
      removeHermes(after),
      before,
      JSON.stringify(before),
    );
  }
});

Deno.test("hermes: a foreign qutty server, a flow-style map, invalid YAML are refused", () => {
  for (
    const [text, why] of [
      ["mcp_servers:\n  qutty:\n    command: mine\n", "already configures"],
      ["mcp_servers: {github: {command: gh}}\n", "inline"],
      ["mcp_servers: [\n", "not valid YAML"],
    ]
  ) {
    let message = "";
    try {
      addHermes(text, paths);
    } catch (e) {
      message = (e as Error).message;
    }
    assert(message.includes(why), `${text}: ${message}`);
  }
  // An entry written for other paths is stale.
  const other = addHermes(undefined, hubPaths("/Users/other"));
  assertEquals(hermesInstalled(other, paths), "stale");
  assertEquals(hermesInstalled("a: 1\n", paths), "absent");
});

Deno.test("hermes: through the installer on a temporary HOME (backup, status, uninstall)", async () => {
  const home = await Deno.makeTempDir({ prefix: "qutty-hermes-" });
  try {
    const p = hubPaths(home);
    const files = integrationFiles(home, p);
    const cfg = `${home}/.hermes/config.yaml`;
    assertEquals(files.hermesConfig, cfg);
    const original = "model:\n  default: qwen3.8:27b-mlx\n";
    Deno.mkdirSync(`${home}/.hermes`);
    Deno.writeTextFileSync(cfg, original);
    Deno.chmodSync(cfg, 0o600);

    let status = await integrationStatus(denoConfigFs, files, p);
    const row = status.find((s) => s.target === "hermes")!;
    assertEquals([row.label, row.installed], ["Hermes Agent", false]);
    assertEquals(row.changes[0].path, "~/.hermes/config.yaml");

    await installIntegration(denoConfigFs, files, p, "hermes");
    await installIntegration(denoConfigFs, files, p, "hermes");
    status = await integrationStatus(denoConfigFs, files, p);
    assertEquals(status.find((s) => s.target === "hermes")!.installed, true);
    assertEquals(Deno.readTextFileSync(`${cfg}.qutty-backup`), original);
    assertEquals((Deno.statSync(cfg).mode ?? 0) & 0o777, 0o600, "mode kept");
    // Claude Code and Codex are untouched.
    assert(!status.find((s) => s.target === "claude")!.installed);

    await uninstallIntegration(denoConfigFs, files, p, "hermes");
    assertEquals(Deno.readTextFileSync(cfg), original);

    // No config yet: Install creates it, Uninstall removes it again.
    Deno.removeSync(cfg);
    Deno.removeSync(`${cfg}.qutty-backup`);
    await installIntegration(denoConfigFs, files, p, "hermes");
    assert(servers(Deno.readTextFileSync(cfg)).qutty);
    await uninstallIntegration(denoConfigFs, files, p, "hermes");
    assertEquals(
      await Deno.stat(cfg).then(() => true, () => false),
      false,
      "the created file is gone",
    );

    // A foreign entry: Install refuses, the file stays as it was.
    const foreign = "mcp_servers:\n  qutty:\n    command: mine\n";
    Deno.writeTextFileSync(cfg, foreign);
    await assertRejects(
      () => installIntegration(denoConfigFs, files, p, "hermes"),
      Error,
      "already configures",
    );
    assertEquals(Deno.readTextFileSync(cfg), foreign);
    status = await integrationStatus(denoConfigFs, files, p);
    assert(
      status.find((s) => s.target === "hermes")!.note?.includes("qutty"),
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
