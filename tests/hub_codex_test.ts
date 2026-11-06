// Codex and the hub: the launch flags (MCP server with env_vars, hooks, their trust hashes), the
// hub's answers to Codex's hooks (fixtures recorded from a real `codex exec` 0.167 run, see
// tests/hub_codex_live_test.ts), the same inputs through the real `qutty-hook codex` shim and a
// tile socket, and the tools' MCP hints Codex decides approval by.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CODEX_MCP_ENV_VARS,
  CODEX_SESSION_FLAGS_SOURCE,
  codexHookHash,
  codexHookKey,
  codexHubArgs,
  hubArgsFor,
  hubPaths,
  tomlInline,
} from "../lib/hub/launch.ts";
import { CODEX_HOOK_EVENTS } from "../lib/hub/hooks.ts";
import { sha256Hex } from "../lib/hub/sha256.ts";
import { buildToolRegistry, TOOL_HINTS } from "../lib/hub/tools.ts";
import { COMPANION_TOOLS } from "../lib/hub/protocol.ts";
import { hubWithTiles } from "./hub_helpers.ts";
import { fixture, HAS_NC, runHook } from "./socket_helpers.ts";

const paths = hubPaths("/Users/ann");

/** Hook inputs from a real Codex 0.167 run (its temp folder replaced with /Users/ann/proj). */
const INPUTS: Record<string, unknown>[] = JSON.parse(
  Deno.readTextFileSync(
    new URL("./fixtures/codex/hook-inputs.json", import.meta.url),
  ),
);
const input = (event: string, nth = 0) =>
  INPUTS.filter((i) => i.hook_event_name === event)[nth];

/** `additionalContext` of a hook answer ("" when there is none). */
const contextOf = (out: unknown) =>
  (out as { hookSpecificOutput?: { additionalContext?: string } })
    .hookSpecificOutput?.additionalContext ?? "";

Deno.test("sha256Hex: standard vectors, and Web Crypto's digest for odd input", async () => {
  assertEquals(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  for (const s of ["a".repeat(55), "b".repeat(56), "c".repeat(1000), "é✓ 🎉"]) {
    const d = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
    const hex = [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
    assertEquals(sha256Hex(s), hex, s.slice(0, 8));
  }
});

Deno.test("codex hook hashes: equal to what Codex 0.167 computes (hooks/list currentHash)", () => {
  // `codex app-server` hooks/list with Qutty's -c flags for /Users/ann: all "trusted".
  const fromCodex: Record<string, string> = {
    SessionStart:
      "sha256:c1a0d9f81273c9aee6c720031d26d1b35864ca626cb12c5263b0c17563d50c60",
    UserPromptSubmit:
      "sha256:a19b5acb15df56737d795127ff1f4f40fc35a7840844bd5e24347e686d053af8",
    PostToolUse:
      "sha256:d419842a4c6e989a5bc8eacefdefc5d21d0e2edf04d8390ad8036be1bc916ab1",
    PermissionRequest:
      "sha256:27f08fd4f5189cb5f0ef53f5be37c291f8db7facf3e839323b66781f9f88fce7",
    Stop:
      "sha256:eb4d0fb0aa885976e1544a5827719f39511b98f3a72881ab29b6b404965ab64b",
    Interrupt:
      "sha256:d091727aef3a7d24a4bee20044f0424119f8a5096b7ec78f451eba5033a7ed49",
  };
  for (const e of CODEX_HOOK_EVENTS) {
    assertEquals(codexHookHash(paths, e), fromCodex[e], e);
  }
  assertEquals(
    codexHookKey(CODEX_SESSION_FLAGS_SOURCE, "PostToolUse", 0),
    "/<session-flags>/config.toml:post_tool_use:0:0",
  );
  assertEquals(
    codexHookKey("/Users/ann/.codex/config.toml", "UserPromptSubmit", 2),
    "/Users/ann/.codex/config.toml:user_prompt_submit:2:0",
  );
});

Deno.test("codex argv: the MCP server with env_vars, one hook group per event, their trust", () => {
  const args = codexHubArgs(paths);
  assertEquals(hubArgsFor("codex", paths), args);
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    assertEquals(args[i], "-c");
    values.push(args[i + 1]);
  }
  assertEquals(
    values[0],
    'mcp_servers.qutty.command="/Users/ann/.qutty/bin/qutty-mcp"',
  );
  assertEquals(
    values[1],
    `mcp_servers.qutty.env_vars=[${
      CODEX_MCP_ENV_VARS.map((v) => `"${v}"`).join(", ")
    }]`,
  );
  assertEquals(
    values.slice(2, -1),
    CODEX_HOOK_EVENTS.map((e) =>
      `hooks.${e}=[{ hooks = [{ type = "command", command = "/Users/ann/.qutty/bin/qutty-hook codex", timeout = ${
        e === "Interrupt" ? 3 : 15
      } }] }]`
    ),
  );
  const state = values.at(-1)!;
  assert(state.startsWith("hooks.state={ "));
  for (const e of CODEX_HOOK_EVENTS) {
    assertStringIncludes(
      state,
      `"${
        codexHookKey(CODEX_SESSION_FLAGS_SOURCE, e, 0)
      }" = { trusted_hash = "${codexHookHash(paths, e)}" }`,
    );
  }
  // A home with spaces and quotes: valid TOML, and one shell word for the hook's path.
  const odd = codexHubArgs(hubPaths(`/Users/a "b" c`));
  assertStringIncludes(
    odd[5],
    `command = "'/Users/a \\"b\\" c/.qutty/bin/qutty-hook' codex"`,
  );
  assertEquals(
    tomlInline({ "a.b": [1, true], c: {} }),
    '{ "a.b" = [1, true], c = {} }',
  );
});

Deno.test("codex hooks: the hub's answers to recorded Codex inputs", () => {
  const { core } = hubWithTiles(); // pty-1 claude, pty-2 codex, pty-3 shell
  const peer = { role: "tile" as const, tileId: "pty-1" };
  core.send(peer, "pty-2", "left before it started");

  // SessionStart: the intro plus the pending message, as SessionStart context.
  const start = core.hook(
    "pty-2",
    "SessionStart",
    input("SessionStart"),
    "codex",
  );
  assertEquals(
    (start as { hookSpecificOutput: { hookEventName: string } })
      .hookSpecificOutput.hookEventName,
    "SessionStart",
  );
  assertStringIncludes(contextOf(start), 'tile "codex" (pty-2)');
  assertStringIncludes(contextOf(start), "left before it started");
  assertEquals(core.registry.get("pty-2")?.harness, "codex");
  assertEquals(core.registry.get("pty-2")?.cwd, "/Users/ann/proj");

  // UserPromptSubmit: busy, nothing more to add.
  assertEquals(
    core.hook("pty-2", "UserPromptSubmit", input("UserPromptSubmit"), "codex"),
    {},
  );
  assertEquals(core.registry.get("pty-2")?.status, "busy");

  // PermissionRequest: waiting for the user; {} leaves the decision to them.
  assertEquals(
    core.hook(
      "pty-2",
      "PermissionRequest",
      input("PermissionRequest"),
      "codex",
    ),
    {},
  );
  assertEquals(core.registry.get("pty-2")?.status, "waiting");

  // PostToolUse: busy again; a message that arrived mid-turn comes as PostToolUse context.
  core.send(peer, "pty-2", "arrived mid-turn");
  const post = core.hook("pty-2", "PostToolUse", input("PostToolUse"), "codex");
  assertEquals(
    (post as { hookSpecificOutput: { hookEventName: string } })
      .hookSpecificOutput.hookEventName,
    "PostToolUse",
  );
  assertStringIncludes(contextOf(post), "arrived mid-turn");
  assertEquals(core.registry.get("pty-2")?.status, "busy");
  assertEquals(
    core.hook("pty-2", "PostToolUse", input("PostToolUse", 1), "codex"),
    {},
  );

  // Stop: blocks with the messages as the continuation prompt only while some are pending.
  core.send(peer, "pty-2", "one more thing");
  const blocked = core.hook("pty-2", "Stop", input("Stop"), "codex") as {
    decision: string;
    reason: string;
  };
  assertEquals(blocked.decision, "block");
  assertStringIncludes(blocked.reason, "one more thing");
  assertEquals(core.registry.get("pty-2")?.status, "busy");
  assertEquals(core.hook("pty-2", "Stop", input("Stop"), "codex"), {});
  assertEquals(core.registry.get("pty-2")?.status, "idle");

  // Interrupt (the input shape from Codex's schema): idle, since no Stop follows.
  core.hook("pty-2", "UserPromptSubmit", input("UserPromptSubmit"), "codex");
  const interrupt = {
    ...input("Stop"),
    hook_event_name: "Interrupt",
  } as Record<string, unknown>;
  delete interrupt.stop_hook_active;
  delete interrupt.last_assistant_message;
  assertEquals(core.hook("pty-2", "Interrupt", interrupt, "codex"), {});
  assertEquals(core.registry.get("pty-2")?.status, "idle");
});

Deno.test({
  name:
    "qutty-hook codex: recorded Codex inputs through the real shim and a tile socket",
  ignore: !HAS_NC,
  async fn() {
    const f = await fixture();
    try {
      const sock = f.hub.spawning("pty-1", { cwd: "/", cols: 80, rows: 24 })
        .env.QUTTY_SOCK;
      f.hub.spawning("pty-2", { cwd: "/", cols: 80, rows: 24 });
      f.hub.core.send({ role: "tile", tileId: "pty-2" }, "pty-1", "hello");
      const env = { QUTTY_SOCK: sock };
      const start = await runHook(input("SessionStart"), env, "codex");
      assertEquals(start.code, 0);
      assertStringIncludes(contextOf(JSON.parse(start.out)), "hello");
      assertEquals(f.hub.core.registry.get("pty-1")?.harness, "codex");
      for (const event of ["UserPromptSubmit", "PermissionRequest"]) {
        const r = await runHook(input(event), env, "codex");
        assertEquals([r.code, JSON.parse(r.out)], [0, {}], event);
      }
      assertEquals(f.hub.core.registry.get("pty-1")?.status, "waiting");
      // The PostToolUse input carries a tool response with newlines and quotes.
      const post = await runHook(input("PostToolUse"), env, "codex");
      assertEquals(JSON.parse(post.out), {});
      assertEquals(f.hub.core.registry.get("pty-1")?.status, "busy");
      const stop = await runHook(input("Stop"), env, "codex");
      assertEquals(JSON.parse(stop.out), {});
      assertEquals(f.hub.core.registry.get("pty-1")?.status, "idle");
    } finally {
      await f.dispose();
    }
  },
});

Deno.test("tool hints: every tool has them; Codex's Auto mode runs the tile tools unasked", () => {
  const { core } = hubWithTiles();
  const listed = buildToolRegistry(core).listTools();
  for (const t of listed) {
    assertEquals(t.annotations, { ...TOOL_HINTS[t.name] }, t.name);
    const h = TOOL_HINTS[t.name];
    // Codex's requires_mcp_tool_approval (codex-rs/core/src/mcp_tool_call.rs).
    const asks = h.destructiveHint === true ||
      (!h.readOnlyHint &&
        ((h.destructiveHint ?? true) || (h.openWorldHint ?? true)));
    const companionOnly = (COMPANION_TOOLS as readonly string[]).includes(
      t.name,
    );
    if (!companionOnly) assertEquals(asks, false, t.name);
  }
  for (const name of ["write_tile", "spawn_tile", "close_tile"]) {
    assertEquals(TOOL_HINTS[name].destructiveHint, true, name);
  }
});
