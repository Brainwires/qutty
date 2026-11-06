// What the `ollama` CLI prints, parsed (lib/ollama/cli.ts), against output captured from the
// real CLI (Ollama 0.40.13, tests/fixtures/ollama/), plus the changes between two readings.

import { assertEquals } from "@std/assert";
import {
  diffModels,
  hasChanges,
  hasTools,
  isModelName,
  lastLine,
  type OllamaModel,
  parseList,
  parsePs,
  parseShow,
  parseVersion,
  withTag,
} from "../lib/ollama/cli.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/ollama/${name}`, import.meta.url));

Deno.test("ollama cli: --version, also when the server is down", () => {
  assertEquals(parseVersion(fixture("version.txt")), "0.40.13");
  assertEquals(
    parseVersion(
      "Warning: could not connect to a running Ollama instance\nWarning: client version is 0.40.13\n",
    ),
    "0.40.13",
  );
  assertEquals(parseVersion("command not found"), undefined);
});

Deno.test("ollama cli: list (the real table, and several rows)", () => {
  assertEquals(parseList(fixture("list.txt")), [{
    name: "qwen3.8:27b-mlx",
    id: "5642e97495e1",
    size: "18 GB",
    modified: "7 days ago",
  }]);
  const two =
    "NAME                 ID              SIZE      MODIFIED       \n" +
    "mimo-v2.6:latest     8b2b3c0ae11a    6.6 GB    2 minutes ago    \n" +
    "library/x:1b         01234567890a    800 MB    3 weeks ago      \n";
  assertEquals(parseList(two).map((m) => [m.name, m.size, m.modified]), [
    ["mimo-v2.6:latest", "6.6 GB", "2 minutes ago"],
    ["library/x:1b", "800 MB", "3 weeks ago"],
  ]);
  // A spinner left before the header (escapes already stripped) does not hide it.
  assertEquals(
    parseList("⠙ NAME    ID    SIZE    MODIFIED\nm:1    abc    1 GB    now\n")
      .map((m) => m.name),
    ["m:1"],
  );
  assertEquals(parseList("Error: could not connect\n"), []);
  assertEquals(parseList(""), []);
});

Deno.test("ollama cli: ps (loaded, and none)", () => {
  assertEquals(parsePs(fixture("ps.txt")), [{
    name: "qwen3.8:27b-mlx",
    size: "18 GB",
    processor: "100% GPU",
    until: "2 minutes from now",
  }]);
  assertEquals(parsePs(fixture("ps-empty.txt")), []);
});

Deno.test("ollama cli: show: model facts and capabilities (nested lines skipped)", () => {
  assertEquals(parseShow(fixture("show.txt")), {
    architecture: "qwen3_5",
    parameters: "27.8B",
    contextLength: 262144,
    quantization: "nvfp4",
    capabilities: ["completion", "vision", "tools", "thinking"],
  });
  assertEquals(parseShow("  Model\n    architecture    llama\n"), {
    architecture: "llama",
    capabilities: [],
  });
});

Deno.test("ollama cli: tools, last line, names, tags", () => {
  const m: OllamaModel = { name: "a", id: "1", size: "", modified: "" };
  assertEquals(hasTools(m), undefined, "unknown until shown");
  assertEquals(hasTools({ ...m, details: { capabilities: ["tools"] } }), true);
  assertEquals(
    hasTools({ ...m, details: { capabilities: ["completion"] } }),
    false,
  );
  assertEquals(lastLine("a\n\nError: x\n  \n"), "Error: x");
  for (
    const ok of ["mimo-v2.6", "qwen3.8:27b-mlx", "user/model:tag", "a.b_c"]
  ) {
    assertEquals(isModelName(ok), true, ok);
  }
  for (
    const bad of ["", "-x", "a b", "a;rm", "../x", "a//b", "a:b:c", 3, null]
  ) {
    assertEquals(isModelName(bad), false, String(bad));
  }
  assertEquals(withTag("mimo-v2.6"), "mimo-v2.6:latest");
  assertEquals(withTag("qwen3.8:4b"), "qwen3.8:4b");
});

Deno.test("ollama cli: added, removed and pulled-again models between readings", () => {
  const m = (name: string, id: string): OllamaModel => ({
    name,
    id,
    size: "",
    modified: "",
  });
  const c = diffModels([m("a", "1"), m("b", "2")], [m("b", "3"), m("c", "4")]);
  assertEquals(c, { added: ["c"], removed: ["a"], updated: ["b"] });
  assertEquals(hasChanges(c), true);
  assertEquals(hasChanges(diffModels([m("a", "1")], [m("a", "1")])), false);
});
