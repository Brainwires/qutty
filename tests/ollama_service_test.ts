// The Ollama helper's backend (desktop/ollama.ts `OllamaService`) over a fake command runner:
// not installed, server down (and then `ollama list`, which would start a server, is not run),
// the `ollama show` cache by digest, harness detection, and the library cache (a failed fetch
// keeps the last good copy). The real CLI is in tests/ollama_live_test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  type CommandRunner,
  OllamaService,
  serverOrigin,
} from "../desktop/ollama.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/ollama/${name}`, import.meta.url));

/** A runner answering from a table; it records every call. */
function fakeRunner(
  answer: (program: string, args: string[]) => { code: number; out: string },
): CommandRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run(program, args) {
      calls.push([program.replace(/^.*\//, ""), ...args].join(" "));
      return Promise.resolve(answer(program, args));
    },
  };
}

const FOUND: Record<string, string> = {
  ollama: "/usr/local/bin/ollama",
  curl: "/usr/bin/curl",
  claude: "/Users/me/.local/bin/claude",
  opencode: "/opt/homebrew/bin/opencode",
};
const find = (name: string) => Promise.resolve(FOUND[name]);

function realOllama(serverUp = true) {
  return fakeRunner((program, args) => {
    const name = program.replace(/^.*\//, "");
    if (name === "curl") {
      if (args.at(-1)!.endsWith("/api/version")) {
        return serverUp
          ? { code: 0, out: '{"version":"0.40.13"}' }
          : { code: 7, out: "curl: (7) Failed to connect" };
      }
      return { code: 0, out: fixture("search-mimo.html.txt") };
    }
    switch (args[0]) {
      case "--version":
        return { code: 0, out: fixture("version.txt") };
      case "list":
        return { code: 0, out: fixture("list.txt") };
      case "ps":
        return { code: 0, out: fixture("ps.txt") };
      case "show":
        return { code: 0, out: fixture("show.txt") };
    }
    return { code: 1, out: "?" };
  });
}

Deno.test("ollama service: a full reading; `show` once per model digest", async () => {
  const runner = realOllama();
  const s = new OllamaService({ runner, find, appPath: "/nonexistent.app" });
  const st = await s.status();
  assertEquals(st.installed, true);
  assertEquals(st.path, "/usr/local/bin/ollama");
  assertEquals(st.version, "0.40.13");
  assertEquals(st.serverUp, true);
  assertEquals(st.models.map((m) => m.name), ["qwen3.8:27b-mlx"]);
  assertEquals(st.models[0].details?.capabilities, [
    "completion",
    "vision",
    "tools",
    "thinking",
  ]);
  assertEquals(st.running.map((r) => r.until), ["2 minutes from now"]);
  assertEquals(
    st.harnesses.filter((h) => h.installed).map((h) => h.name),
    ["claude", "opencode"],
  );
  assertEquals(st.app, false);
  await s.status();
  assertEquals(
    runner.calls.filter((c) => c.startsWith("ollama show")).length,
    1,
    "show is cached",
  );
  // Concurrent readings share one.
  const before = runner.calls.length;
  await Promise.all([s.status(), s.status()]);
  assertEquals(runner.calls.filter((c) => c === "ollama list").length, 3);
  assert(runner.calls.length - before < 10);
});

Deno.test("ollama service: not installed; server down never runs `ollama list`", async () => {
  const none = new OllamaService({
    runner: realOllama(),
    find: () => Promise.resolve(undefined),
  });
  const st = await none.status();
  assertEquals([st.installed, st.serverUp, st.models], [false, false, []]);
  assertEquals(st.harnesses.every((h) => !h.installed), true);

  const runner = realOllama(false);
  const down = new OllamaService({ runner, find });
  const d = await down.status();
  assertEquals([d.installed, d.serverUp, d.version], [true, false, "0.40.13"]);
  assertEquals(d.error, "the Ollama server is not running");
  assert(!runner.calls.some((c) => c.startsWith("ollama list")), "no list");
});

Deno.test("ollama service: the library is cached; a failed refetch keeps the copy", async () => {
  let fail = false;
  const runner = fakeRunner((_p, args) =>
    fail
      ? { code: 6, out: "curl: (6) Could not resolve host: ollama.com" }
      : args.at(-1)!.includes("/library/")
      ? { code: 0, out: fixture("model-mimo.html.txt") }
      : { code: 0, out: fixture("search-mimo.html.txt") }
  );
  const s = new OllamaService({ runner, find });
  const a = await s.library("mimo", "popular", false);
  assertEquals(a.models.length, 20);
  assertEquals(a.error, undefined);
  await s.library("mimo", "popular", false);
  assertEquals(runner.calls.length, 1, "served from the cache");
  // Another query is another page.
  fail = true;
  const b = await s.library("qwen", "newest", true);
  assertEquals(b.models, []);
  assert(b.error?.includes("Could not resolve host"), b.error);
  assert(runner.calls[1].includes("q=qwen&c=tools&o=newest"), runner.calls[1]);
  fail = false;
  const page = await s.libraryModel("mimo-v2.6:9b");
  assertEquals(page.page?.applications, [
    "claude",
    "opencode",
    "hermes",
    "openclaw",
  ]);
  assertEquals((await s.libraryModel("../x")).error, "not a model name");
});

Deno.test("ollama service: the server's address from OLLAMA_HOST", () => {
  assertEquals(serverOrigin(undefined), "http://127.0.0.1:11434");
  assertEquals(serverOrigin(""), "http://127.0.0.1:11434");
  assertEquals(serverOrigin("0.0.0.0"), "http://127.0.0.1:11434");
  assertEquals(serverOrigin("0.0.0.0:8080"), "http://127.0.0.1:8080");
  assertEquals(serverOrigin("gpu-box:11434"), "http://gpu-box:11434");
  assertEquals(serverOrigin("https://ollama.lan"), "https://ollama.lan:443");
  assertEquals(serverOrigin("bad host/x"), "http://127.0.0.1:11434");
});
