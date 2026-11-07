// Codex's hook trust self-check (lib/hub/codex-trust.ts, desktop/hub.ts): `hooks/list` parsed
// out of `codex app-server`'s output, the verdict on Qutty's hooks (trusted, untrusted or
// missing, and whether Codex now hashes them differently), the warning, and the hub asking once
// per start and again after an Install / Re-trust, only while the Codex integration is
// installed. Codex itself is faked here (tests/hub_codex_cli_test.ts runs the real one); the
// home folder is a temporary one.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  codexHooksListRequest,
  codexTrustCheck,
  codexTrustWarning,
  type ListedCodexHook,
  parseHooksListAnswer,
} from "../lib/hub/codex-trust.ts";
import { codexHookHash, hookCommand, hubPaths } from "../lib/hub/launch.ts";
import { CODEX_HOOK_EVENTS } from "../lib/hub/hooks.ts";
import { codexHooksListArgv } from "../desktop/codex-trust.ts";
import { fixture } from "./socket_helpers.ts";
import type { IntegrationStatus } from "../lib/hub/protocol.ts";

const paths = hubPaths("/Users/me");

/** Qutty's hooks as Codex lists them, all trusted. */
function quttyHooks(): ListedCodexHook[] {
  return CODEX_HOOK_EVENTS.map((e, i) => ({
    key: `/Users/me/.codex/config.toml:${e.toLowerCase()}:${i}:0`,
    eventName: e[0].toLowerCase() + e.slice(1),
    command: hookCommand(paths, "codex"),
    trustStatus: "trusted",
    currentHash: codexHookHash(paths, e),
  }));
}

Deno.test("codexHooksListRequest: initialize, initialized, then hooks/list for the folder", () => {
  const lines = codexHooksListRequest("/Users/me").trimEnd().split("\n").map(
    (l) => JSON.parse(l),
  );
  assertEquals(lines.map((l) => l.method), [
    "initialize",
    "initialized",
    "hooks/list",
  ]);
  assertEquals(lines[2].params, { cwds: ["/Users/me"] });
  assertEquals(lines[2].id, 2);
});

Deno.test("parseHooksListAnswer: the hooks/list result among other lines; undefined until it arrives", () => {
  const answer = JSON.stringify({
    id: 2,
    result: {
      data: [{
        cwd: "/Users/me",
        hooks: [
          {
            key: "/Users/me/.codex/config.toml:stop:0:0",
            eventName: "stop",
            command: "true",
            trustStatus: "untrusted",
            currentHash: "sha256:ab",
            async: false,
          },
          { eventName: "stop" }, // incomplete: skipped
          "junk",
        ],
        warnings: [],
        errors: [],
      }],
    },
  });
  const output = [
    '{"id":1,"result":{"userAgent":"qutty/0.167.0"}}',
    '{"method":"remoteControl/status/changed","params":{}}',
    // An echoed request (a PTY may echo input): no result, not the answer.
    '{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":["/"]}}',
    "not json",
    answer,
  ].join("\r\n");
  assertEquals(parseHooksListAnswer(output), [{
    key: "/Users/me/.codex/config.toml:stop:0:0",
    eventName: "stop",
    command: "true",
    trustStatus: "untrusted",
    currentHash: "sha256:ab",
  }]);
  assertEquals(parseHooksListAnswer(output.slice(0, -10)), undefined);
  assertEquals(parseHooksListAnswer(""), undefined);
  assertEquals(
    parseHooksListAnswer('{"id":2,"error":{"code":-32601}}'),
    undefined,
    "an error answer is no answer",
  );
  assertEquals(parseHooksListAnswer('{"id":2,"result":{"data":[]}}'), []);
});

Deno.test("codexTrustCheck: every event's Qutty hook trusted; others' hooks ignored", () => {
  const hooks = [
    ...quttyHooks(),
    {
      key: "k",
      eventName: "stop",
      command: "true",
      trustStatus: "untrusted",
    },
  ];
  assertEquals(codexTrustCheck(hooks, paths), {
    trusted: true,
    untrusted: [],
    hashChanged: false,
  });
  assertEquals(codexTrustWarning(codexTrustCheck(hooks, paths)), undefined);
});

Deno.test("codexTrustCheck: an untrusted or missing hook; a changed hash", () => {
  const hooks = quttyHooks();
  hooks[0].trustStatus = "untrusted";
  const missing = hooks.filter((h) => h.eventName !== "stop");
  const check = codexTrustCheck(missing, paths);
  assertEquals(check, {
    trusted: false,
    untrusted: ["SessionStart", "Stop"],
    hashChanged: false,
  });
  const warning = codexTrustWarning(check)!;
  assertStringIncludes(warning, "Qutty's SessionStart, Stop hooks");
  assertStringIncludes(warning, "Re-trust writes the trust entries again");

  // Codex's own hash differs from Qutty's: its algorithm changed.
  const changed = quttyHooks().map((h) => ({
    ...h,
    trustStatus: "modified",
    currentHash: "sha256:00",
  }));
  const c2 = codexTrustCheck(changed, paths);
  assertEquals([c2.trusted, c2.untrusted.length, c2.hashChanged], [
    false,
    CODEX_HOOK_EVENTS.length,
    true,
  ]);
  const w2 = codexTrustWarning(c2)!;
  assertStringIncludes(w2, "none of Qutty's hooks");
  assertStringIncludes(w2, "Re-trust cannot fix it");

  // A Codex that lists none of them (another Qutty's paths, say).
  const other = codexTrustCheck(
    quttyHooks().map((h) => ({ ...h, command: "/elsewhere/qutty-hook codex" })),
    paths,
  );
  assertEquals(other.untrusted.length, CODEX_HOOK_EVENTS.length);
});

Deno.test("codexHooksListArgv: the request on a held-open stdin, CODEX_HOME and HOME set", () => {
  const { program, args } = codexHooksListArgv(
    "/opt/codex",
    "/Users/me/.codex",
    "/Users/me",
  );
  assertEquals(program, "/bin/bash");
  assertEquals(args[2], "/opt/codex");
  assertEquals(args[3], codexHooksListRequest("/Users/me"));
  assertEquals(args.slice(4), ["/Users/me/.codex", "/Users/me"]);
  assertStringIncludes(args[1], "sleep");
  assertStringIncludes(args[1], '"$0" app-server');
});

Deno.test({
  name:
    "hub: asks Codex only while installed, once per start, again after Install / Re-trust",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let calls = 0;
    let answer: ListedCodexHook[] | undefined;
    const f = await fixture({
      codexHooks: () => {
        calls++;
        return Promise.resolve(answer);
      },
    });
    try {
      const codexRow = (rows: IntegrationStatus[]) =>
        rows.find((r) => r.target === "codex")!;
      const p = hubPaths(f.home);
      const ours = (trustStatus: string): ListedCodexHook[] =>
        CODEX_HOOK_EVENTS.map((e) => ({
          key: "k",
          eventName: e[0].toLowerCase() + e.slice(1),
          command: hookCommand(p, "codex"),
          trustStatus,
          currentHash: codexHookHash(p, e),
        }));

      let row = codexRow(await f.hub.integration());
      assertEquals([row.installed, row.trust, calls], [false, undefined, 0]);

      answer = ours("untrusted");
      row = codexRow(await f.hub.install("codex"));
      assertEquals([row.installed, row.trust, calls], [true, "untrusted", 1]);
      assertStringIncludes(row.warning!, "trusts none of");
      // Cached for this start.
      row = codexRow(await f.hub.integration());
      assertEquals([row.trust, calls], ["untrusted", 1]);

      // Re-trust is Install again: Codex is asked again.
      answer = ours("trusted");
      row = codexRow(await f.hub.install("codex"));
      assertEquals([row.trust, row.warning, calls], ["trusted", undefined, 2]);

      // No codex (or no answer): nothing said.
      answer = undefined;
      row = codexRow(await f.hub.uninstall("codex"));
      assertEquals([row.installed, calls], [false, 2]);
      row = codexRow(await f.hub.install("codex"));
      assertEquals([row.installed, row.trust, calls], [true, undefined, 3]);
      assert(!("warning" in row));
    } finally {
      await f.dispose();
    }
  },
});
