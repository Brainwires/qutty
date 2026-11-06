// The Ollama helper against the real `ollama` CLI on this machine (skipped where it is not
// installed, as on CI):
//
// - `ollamaStatus()` through hidden PTYs: version, server, pulled and loaded models with their
//   capabilities, installed harnesses. Cheap (no model is loaded); prints what it found.
// - One real tile: `ollama launch claude --model <model>` in a tapped PTY with the hub, exactly
//   as the `+` menu starts it, until Claude Code's UI is on screen; then it is stopped (nothing
//   is typed, no prompt is sent). It may load the model, so it only runs when asked:
//
//     QUTTY_LIVE_OLLAMA=1 deno test -A tests/ollama_live_test.ts
//
//   QUTTY_OLLAMA_MODEL picks the model (default: the first pulled one with tool calling).
//
// Nothing is pulled.

import { assert, assertEquals } from "@std/assert";
import { OllamaService, PtyRunner } from "../desktop/ollama.ts";
import { installHubFiles } from "../desktop/hub.ts";
import { PtyHost, resolveProgram, setPtyTaps } from "../desktop/pty.ts";
import { ollamaProfile } from "../lib/ollama/harnesses.ts";
import { Recorder } from "./pty_helpers.ts";
import { fixture, HAS_NC } from "./socket_helpers.ts";

const OLLAMA = await resolveProgram("ollama");
const LIVE = Deno.env.get("QUTTY_LIVE_OLLAMA") === "1";

Deno.test({
  name: "live ollama: status from the real CLI",
  ignore: !OLLAMA,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const service = new OllamaService({ runner: new PtyRunner(undefined) });
    const t = Date.now();
    const s = await service.status();
    console.log(`--- ollamaStatus() in ${Date.now() - t} ms:`);
    console.log(JSON.stringify(
      { ...s, harnesses: s.harnesses.filter((h) => h.installed) },
      null,
      2,
    ));
    assertEquals(s.installed, true);
    assertEquals(s.path, OLLAMA);
    assert(s.version && /^\d+\.\d+/.test(s.version), s.version);
    if (s.serverUp) {
      for (const m of s.models) {
        assert(m.name && m.id && m.size, JSON.stringify(m));
        assert(m.details, `ollama show ${m.name} was read`);
      }
    }
  },
});

Deno.test({
  name:
    "live ollama: `ollama launch claude --model …` starts Claude Code in a hub tile",
  ignore: !OLLAMA || !LIVE || !HAS_NC || !(await resolveProgram("claude")),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const status = await new OllamaService({
      runner: new PtyRunner(undefined),
    }).status();
    assert(status.serverUp, "the Ollama server must be running");
    const model = Deno.env.get("QUTTY_OLLAMA_MODEL") ??
      status.models.find((m) => m.details?.capabilities.includes("tools"))
        ?.name;
    assert(model, "no pulled model with tool calling");

    const f = await fixture();
    await installHubFiles(f.hub.paths);
    const work = await Deno.makeTempDir({ prefix: "qutty-ollama-work" });
    const rec = new Recorder();
    const host = new PtyHost(rec.emit, { tapped: true });
    let argv: string[] = [];
    setPtyTaps({
      spawning: (id, info) => {
        const r = f.hub.spawning(id, info);
        argv = r.args;
        return r;
      },
      data: (id, text) => f.hub.data(id, text),
      resized: (id, c, r) => f.hub.resized(id, c, r),
      ended: (id) => f.hub.ended(id),
    });
    try {
      const profile = ollamaProfile(status.path!, { harness: "claude", model });
      const { id } = await host.spawn({
        cols: 160,
        rows: 45,
        cwd: work,
        program: profile.program,
        args: profile.args!,
        agent: profile.name,
        ollamaModel: model,
      });
      console.log(
        `--- ${profile.program} ${profile.args!.join(" ")} -- ${
          JSON.stringify(argv)
        }`,
      );
      // Claude Code's first screen: the folder-trust question in a new folder, or its prompt.
      const seen = await rec.until(
        "Claude Code's UI",
        () => /trust|Claude Code|for shortcuts|Welcome/i.test(rec.text(id)),
        120_000,
      ).then(() => true, () => false);
      const tile = f.hub.core.registry.get(id);
      console.log(`--- the hub's tile: ${JSON.stringify(tile)}`);
      console.log("--- the screen (tail):");
      console.log(
        rec.text(id).replace(
          // deno-lint-ignore no-control-regex
          /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\r/g,
          "",
        ).slice(-1500),
      );
      host.kill(id);
      await rec.waitExit(id, 15_000);
      assert(seen, "Claude Code's UI did not appear");
      assertEquals(tile?.harness, "claude");
      assertEquals(tile?.model, model);
    } finally {
      await host.dispose();
      setPtyTaps(undefined);
      await f.dispose();
      await Deno.remove(work, { recursive: true }).catch(() => {});
    }
  },
});
