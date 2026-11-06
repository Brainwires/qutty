// The ollama.com library pages, parsed (lib/ollama/library.ts), against pages captured from
// ollama.com (tests/fixtures/ollama/*.html.txt): the search results and a model page with its
// Applications list and variants.

import { assert, assertEquals } from "@std/assert";
import {
  htmlText,
  isLibraryName,
  type LibraryModel,
  modelUrl,
  newSince,
  parseModelPage,
  parseSearch,
  searchUrl,
} from "../lib/ollama/library.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/ollama/${name}`, import.meta.url));

Deno.test("library: the search page's models", () => {
  const models = parseSearch(fixture("search-mimo.html.txt"));
  assertEquals(models.length, 20);
  assertEquals(models[0], {
    name: "mimo-v2.6",
    description:
      "MiMo-V2.6-Distill-Qwen-9B is Xiaomi MiMo’s 9B model for code and agent workflows",
    capabilities: ["vision", "tools", "thinking"],
    cloud: false,
    sizes: ["9b"],
    downloads: 20887,
    tags: 8,
    updated: "November 3, 2026",
    updatedAt: Date.parse("November 3, 2026"),
  });
  // A cloud model: its chip, entities decoded, no size chips or downloads.
  const flash = models.find((m) => m.name === "mimo-v2.6-flash")!;
  assertEquals(flash.cloud, true);
  assert(flash.description.startsWith("Xiaomi's efficiency-balanced"));
  assertEquals(flash.sizes, []);
  assertEquals(flash.downloads, undefined);
  // Every entry has a usable name.
  assert(models.every((m) => isLibraryName(m.name)));
});

Deno.test("library: a model page's applications, variants and summary", () => {
  const page = parseModelPage("mimo-v2.6", fixture("model-mimo.html.txt"));
  assertEquals(page.applications, ["claude", "opencode", "hermes", "openclaw"]);
  assertEquals(page.variants, [
    {
      tag: "mimo-v2.6:latest",
      size: "6.6GB - 8.7GB",
      context: "256K",
      input: "Text, Image",
    },
    {
      tag: "mimo-v2.6:9b",
      size: "6.6GB - 8.7GB",
      context: "256K",
      input: "Text, Image",
    },
  ]);
  assertEquals(
    page.description,
    "MiMo-V2.6-Distill-Qwen-9B is Xiaomi MiMo’s 9B model for code and agent workflows",
  );
});

Deno.test("library: junk and empty pages parse to nothing", () => {
  assertEquals(parseSearch(""), []);
  assertEquals(parseSearch("<li><a href='/x'>no</a></li>"), []);
  assertEquals(
    parseSearch('<li><a href="/library/../etc">x</a></li>'),
    [],
    "an unusable name is skipped",
  );
  const empty = parseModelPage("x", "<html></html>");
  assertEquals(empty, {
    name: "x",
    description: "",
    capabilities: [],
    applications: [],
    variants: [],
  });
});

Deno.test("library: URLs, names, text", () => {
  assertEquals(searchUrl(""), "https://ollama.com/search");
  assertEquals(
    searchUrl(" mimo ", { order: "newest", toolsOnly: true }),
    "https://ollama.com/search?q=mimo&c=tools&o=newest",
  );
  assertEquals(searchUrl("a&b"), "https://ollama.com/search?q=a%26b");
  assertEquals(modelUrl("mimo-v2.6"), "https://ollama.com/library/mimo-v2.6");
  assertEquals(isLibraryName("user/model"), true);
  assertEquals(isLibraryName("a/b/c"), false);
  assertEquals(isLibraryName("x?y"), false);
  assertEquals(
    htmlText("<b>a &amp; b</b>&#39;c&#x27; &nbsp;d"),
    "a & b 'c' d",
  );
});

Deno.test("library: new since the last look (nothing before a first look)", () => {
  const m = (name: string, updatedAt?: number): LibraryModel => ({
    name,
    description: "",
    capabilities: [],
    cloud: false,
    sizes: [],
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  });
  const list = [m("a", 100), m("b", 300), m("c")];
  assertEquals(newSince(list, null), []);
  assertEquals(newSince(list, 200).map((x) => x.name), ["b"]);
});
