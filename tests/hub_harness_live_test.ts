// Real harnesses against a real hub, without a model prompt: each installed harness's own MCP
// listing command, run in a tile (a tapped PTY with the hub's socket and environment) with
// exactly the per-session wiring lib/hub/wiring.ts gives it, must reach Qutty's MCP server and
// see its tools.
//
//   QUTTY_LIVE_HARNESSES=1 deno test -A tests/hub_harness_live_test.ts
//
// A harness that is not installed is skipped (and reported unverified). Nothing of the user's is
// changed: OpenClaw gets a temporary state folder and a temporary user config to include;
// Hermes a temporary HERMES_HOME whose config.yaml is what Install would write.

import { assert, assertStringIncludes } from "@std/assert";
import { installHubFiles } from "../desktop/hub.ts";
import { PtyHost, resolveProgram, setPtyTaps } from "../desktop/pty.ts";
import { addHermes } from "../lib/hub/integration-hermes.ts";
import { Recorder } from "./pty_helpers.ts";
import { fixture, HAS_NC } from "./socket_helpers.ts";

const LIVE = Deno.env.get("QUTTY_LIVE_HARNESSES") === "1";

/** One harness check: its program, the listing arguments, extra env, what success prints. */
interface Check {
  agent: string;
  args: string[];
  /** Extra environment for the tile (temporary state folders). */
  env?: (home: string) => Record<string, string>;
  /** Prepare files in the hub's temporary home. */
  prepare?: (home: string) => void;
  expect: RegExp;
  /**
   * Run the harness's own UI with the wiring's arguments instead of a listing command, and pass
   * once its MCP client has initialized with the hub (then it is stopped; nothing is typed).
   */
  ui?: boolean;
}

const CHECKS: Check[] = [
  {
    // `opencode mcp list` asks the shared background service, which never sees a tile's
    // environment; the TUI with the wiring's `--standalone` runs its own server, which does.
    agent: "opencode",
    args: [],
    ui: true,
    expect: /./,
  },
  {
    agent: "openclaw",
    args: ["mcp", "probe", "qutty"],
    prepare: (home) => {
      Deno.mkdirSync(`${home}/.openclaw`, { recursive: true });
      Deno.writeTextFileSync(`${home}/.openclaw/openclaw.json`, "{}\n");
    },
    env: (home) => ({ OPENCLAW_STATE_DIR: `${home}/.openclaw-state` }),
    expect: /qutty: [1-9]\d* tools/,
  },
  {
    agent: "hermes",
    args: ["mcp", "test", "qutty"],
    env: (home) => ({ HERMES_HOME: `${home}/.hermes` }),
    expect: /list_peers/,
  },
];

for (const check of CHECKS) {
  const installed = await resolveProgram(check.agent);
  Deno.test({
    name:
      `live ${check.agent}: its MCP listing reaches the hub through Qutty's wiring`,
    ignore: !LIVE || !HAS_NC || !installed,
    sanitizeResources: false,
    sanitizeOps: false,
    async fn() {
      const f = await fixture();
      await installHubFiles(f.hub.paths);
      const home = f.home;
      check.prepare?.(home);
      if (check.agent === "hermes") {
        Deno.mkdirSync(`${home}/.hermes`, { recursive: true });
        Deno.writeTextFileSync(
          `${home}/.hermes/config.yaml`,
          addHermes(undefined, f.hub.paths),
        );
      }
      const rec = new Recorder();
      const host = new PtyHost(rec.emit, { tapped: true });
      let wiring: { env?: Record<string, string>; args?: string[] } = {};
      // The MCP handshake from the tile: its client names the harness.
      const handshakes: string[] = [];
      const setHarness = f.hub.core.registry.setHarness.bind(
        f.hub.core.registry,
      );
      f.hub.core.registry.setHarness = (tileId, harness) => {
        handshakes.push(`${tileId}:${harness}`);
        setHarness(tileId, harness);
      };
      setPtyTaps({
        spawning: (id, info) => {
          const r = f.hub.spawning(id, info);
          wiring = { env: r.env, args: r.args };
          // Listing commands take no TUI flags: keep the environment, drop the arguments.
          return {
            ...r,
            env: { ...r.env, ...check.env?.(home) },
            args: check.ui ? r.args : [],
          };
        },
        data: (id, text) => f.hub.data(id, text),
        resized: (id, c, r) => f.hub.resized(id, c, r),
        ended: (id) => f.hub.ended(id),
      });
      try {
        const { id } = await host.spawn({
          cols: 200,
          rows: 50,
          cwd: home,
          program: check.agent,
          agent: check.agent,
          args: check.args,
        });
        if (check.ui) {
          const deadline = Date.now() + 60_000;
          while (
            !handshakes.includes(`${id}:${check.agent}`) &&
            Date.now() < deadline
          ) {
            await new Promise((r) => setTimeout(r, 200));
          }
          console.log(`--- handshakes: ${JSON.stringify(handshakes)}`);
          host.kill(id);
          await rec.waitExit(id, 15_000);
          assert(
            handshakes.includes(`${id}:${check.agent}`),
            `${check.agent}'s MCP client never reached the hub`,
          );
          return;
        }
        const plain = () =>
          rec.text(id).replace(
            // deno-lint-ignore no-control-regex
            /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g,
            "",
          );
        // Some listings keep running after they printed (OpenClaw's probe holds the server).
        await rec.until(
          `${check.agent}'s listing`,
          () => rec.exits.has(id) || check.expect.test(plain()),
          240_000,
        ).catch(() => {});
        if (!rec.exits.has(id)) host.kill(id);
        const exit = await rec.waitExit(id, 15_000);
        const out = plain();
        console.log(
          `--- ${check.agent} ${check.args.join(" ")}: exit ${exit.exitCode}`,
        );
        console.log(`--- wiring: ${JSON.stringify(wiring)}`);
        console.log(out.slice(-3000));
        assert(check.expect.test(out), `${check.expect} not in the output`);
        if (check.agent === "openclaw") {
          assertStringIncludes(JSON.stringify(wiring), "OPENCLAW_CONFIG_PATH");
        }
      } finally {
        await host.dispose();
        setPtyTaps(undefined);
        await f.dispose();
      }
    },
  });
}
