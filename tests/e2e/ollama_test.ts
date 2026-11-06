// The Ollama helper against the demo backend (lib/ollama/demo.ts: Ollama 0.40.13 with
// qwen3.8:27b-mlx (tools) and gemma3:4b (no tools), Claude Code, Codex and OpenCode installed,
// a small library with mimo-v2.6): the `+` menu's Ollama section and dialog, launching a harness
// on a model (title, agent badge, the remembered pair), the no-tools warning, Pull a model…, the
// library's Pull & launch, and Settings → Ollama with "+ opens" naming a pair.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type App,
  chipIdSet,
  newFocusedTile,
  suite,
  waitFor,
} from "./harness.ts";

const ARROW = "[data-testid=bar-new-menu]";
const DIALOG = "[data-testid=ollama-dialog]";
const model = (name: string) =>
  `[data-testid=ollama-model][data-name="${name}"]`;
const harness = (name: string) =>
  `[data-testid=ollama-harness][data-name="${name}"]`;
const tileSel = (id: string) => `[data-testid=tile][data-id="${id}"]`;

/** Open the `+` menu, then its "Ollama models…" item. */
async function openDialog(app: App): Promise<void> {
  await app.click(ARROW);
  await waitFor(
    () => app.exists("[data-testid=launch-ollama]"),
    4000,
    "the Ollama item",
  );
  await app.click("[data-testid=launch-ollama]");
  await waitFor(() => app.exists(model("qwen3.8:27b-mlx")), 4000, "models");
}

const chipIds = chipIdSet;
const newFocused = newFocusedTile;

/** Type into the input `selector` (focused by a click first). */
async function typeInto(app: App, selector: string, text: string) {
  await app.click(selector);
  await app.page.keyboard.type(text);
}

const names = (app: App, sel: string) =>
  app.eval(
    (s: string) =>
      [...document.querySelectorAll<HTMLElement>(s)].map((el) =>
        el.dataset.name ?? ""
      ),
    sel,
  );

suite("ollama", (test) => {
  test("menu: an Ollama section opens the dialog; models, capabilities, harnesses", async (app) => {
    await app.click(ARROW);
    await waitFor(
      () => app.exists('[data-testid=launch-section][data-section="ollama"]'),
      4000,
      "the Ollama section",
    );
    await app.click("[data-testid=launch-ollama]");
    await waitFor(() => app.exists(DIALOG), 3000, "the dialog");
    await waitFor(() => app.exists(model("gemma3:4b")), 3000, "models");
    assertEquals(await names(app, "[data-testid=ollama-model]"), [
      "qwen3.8:27b-mlx",
      "gemma3:4b",
    ]);
    // gemma3 has no tool calling.
    assert(
      await app.exists(`${model("gemma3:4b")} [data-testid=ollama-no-tools]`),
    );
    assert(
      !(await app.exists(
        `${model("qwen3.8:27b-mlx")} [data-testid=ollama-no-tools]`,
      )),
    );
    // qwen3.8's page lists claude, codex, opencode and qwen: listed first, installed ones
    // enabled, Qwen Code greyed (not installed), the rest left out.
    await waitFor(
      async () =>
        (await names(app, "[data-testid=ollama-harness]")).join() ===
          "claude,codex,opencode,qwen",
      3000,
      "the listed harnesses",
    );
    assertEquals(await app.attr(harness("qwen"), "data-installed"), "false");
    assertEquals(await app.attr(harness("claude"), "aria-selected"), "true");
    // ↓ on the model list moves the selection; gemma3's harness list is every harness.
    await app.click(model("qwen3.8:27b-mlx"));
    await app.press("ArrowDown");
    assertEquals(await app.attr(model("gemma3:4b"), "aria-selected"), "true");
    await waitFor(
      async () => (await names(app, "[data-testid=ollama-harness]")).length > 4,
      3000,
      "every harness for an unlisted model",
    );
    // Escape closes it.
    await app.press("Escape");
    await waitFor(async () => !(await app.exists(DIALOG)), 2000, "closed");
  });

  test("launch: claude on qwen3.8 opens an agent tile and remembers the pair", async (app) => {
    const before = await chipIds(app);
    await openDialog(app);
    await app.click(harness("claude"));
    await app.click("[data-testid=ollama-launch]");
    const id = await newFocused(app, before);
    assert(!(await app.exists(DIALOG)), "the dialog closed");
    await app.waitForText(id, "claude · qwen3.8:27b-mlx", 5000);
    await waitFor(
      async () =>
        (await app.eval(
          (i: string) =>
            document.querySelector(
              `[data-testid=chip][data-id="${i}"] .chip-title`,
            )?.textContent ?? "",
          id,
        )).startsWith("claude · qwen3.8:27b-mlx"),
      5000,
      "the tile's title",
    );
    // The hub knows it as a claude agent.
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=tile-agent-badge]`),
      5000,
      "the agent badge",
    );
    const s = await app.settings();
    assertEquals(s.ollama?.recents, [{
      harness: "claude",
      model: "qwen3.8:27b-mlx",
    }]);
    assertEquals(s.lastLaunch, "ollama:claude:qwen3.8:27b-mlx");
    // The pair is now a menu entry.
    await app.click(ARROW);
    const entry =
      '[data-testid=launch-item][data-id="ollama:claude:qwen3.8:27b-mlx"]';
    await waitFor(() => app.exists(entry), 4000, "the pair entry");
    const before2 = await chipIds(app);
    await app.click(entry);
    const id2 = await newFocused(app, before2);
    await app.waitForText(id2, "claude · qwen3.8:27b-mlx", 5000);
    // `/exit` ends the demo agent, and its tile goes with it.
    await app.typeInTerminal(id2, "/exit\r");
    await waitFor(
      async () => !(await chipIds(app)).has(id2),
      5000,
      "the tile closed",
    );
  });

  test("no tools: launching on a model without tool calling asks first", async (app) => {
    const before = await chipIds(app);
    await openDialog(app);
    await app.click(model("gemma3:4b"));
    await app.click(harness("codex"));
    await app.click("[data-testid=ollama-launch]");
    await waitFor(
      () => app.exists("[data-testid=ollama-confirm]"),
      2000,
      "the warning",
    );
    assertEquals((await app.chips()).length, before.size, "nothing launched");
    assertStringIncludes(
      await app.eval(() =>
        document.querySelector("[data-testid=ollama-launch]")?.textContent ?? ""
      ),
      "Launch anyway",
    );
    await app.click("[data-testid=ollama-launch]");
    const id = await newFocused(app, before);
    await app.waitForText(id, "codex · gemma3:4b", 5000);
  });

  test("pull: Pull a model… runs ollama pull in a tile; the list picks the model up", async (app) => {
    const before = await chipIds(app);
    await openDialog(app);
    await typeInto(app, "[data-testid=ollama-pull-name]", "mimo-v2.6");
    await app.click("[data-testid=ollama-pull]");
    // The pull tile prints its progress and closes when it succeeds.
    const id = await newFocused(app, before);
    await waitFor(
      async () => !(await chipIds(app)).has(id),
      6000,
      "the pull tile closed",
    );
    await openDialog(app);
    await waitFor(
      () => app.exists(model("mimo-v2.6:latest")),
      8000,
      "the pulled model",
    );
  });

  test("library: search, a model's applications, Pull & launch", async (app) => {
    await openDialog(app);
    await app.click("[data-testid=ollama-tab-library]");
    const lib = '[data-testid=ollama-lib-model][data-name="mimo-v2.6"]';
    await waitFor(() => app.exists(lib), 4000, "library results");
    // Tools only (the default) hides the embedding model.
    assert(
      !(await app.exists(
        '[data-testid=ollama-lib-model][data-name="nomic-embed-text"]',
      )),
    );
    await app.click("[data-testid=ollama-lib-tools]");
    await waitFor(
      () =>
        app.exists(
          '[data-testid=ollama-lib-model][data-name="nomic-embed-text"]',
        ),
      3000,
      "every model",
    );
    await typeInto(app, "[data-testid=ollama-lib-query]", "mimo");
    await waitFor(
      async () =>
        (await names(app, "[data-testid=ollama-lib-model]")).join() ===
          "mimo-v2.6",
      3000,
      "the search",
    );
    // Its page: listed for Claude Code, OpenCode, Hermes Agent and OpenClaw.
    await app.click(`${lib} .ollama-lib-head`);
    await waitFor(
      () => app.exists("[data-testid=ollama-lib-apps]"),
      3000,
      "applications",
    );
    assertStringIncludes(
      await app.eval(() =>
        document.querySelector("[data-testid=ollama-lib-apps]")?.textContent ??
          ""
      ),
      "Hermes Agent",
    );
    assert((await app.settings()).ollama?.libraryLookedAt, "looked at");
    const before = await chipIds(app);
    await app.click(`${lib} [data-testid=ollama-lib-launch]`);
    const id = await newFocused(app, before);
    // The tile pulls first, then launches the harness.
    await app.waitForText(id, "success", 5000);
    await app.waitForText(id, "claude · mimo-v2.6:latest", 5000);
  });

  test("settings: status, the model table, defaults, and + opens a pair", async (app) => {
    await app.openSettings();
    await waitFor(
      () => app.exists("[data-testid=ollama-table]"),
      4000,
      "the Ollama section",
    );
    assertStringIncludes(
      await app.eval(() =>
        document.querySelector("[data-testid=ollama-summary]")?.textContent ??
          ""
      ),
      "Version 0.40.13 · server running · 2 models",
    );
    assertEquals(await names(app, "[data-testid=ollama-table-row]"), [
      "qwen3.8:27b-mlx",
      "gemma3:4b",
    ]);
    const choose = (sel: string, v: string) =>
      app.eval((a: [string, string]) => {
        const el = document.querySelector<HTMLSelectElement>(a[0])!;
        el.value = a[1];
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, [sel, v] as [string, string]);
    await choose("[data-testid=setting-ollama-harness]", "opencode");
    await choose("[data-testid=setting-ollama-model]", "qwen3.8:27b-mlx");
    await waitFor(
      async () => (await app.settings()).ollama?.model === "qwen3.8:27b-mlx",
      2000,
      "the default model",
    );
    // The default pair is an entry "+ opens" can pick, and plain + then opens it.
    const pair = "ollama:opencode:qwen3.8:27b-mlx";
    await waitFor(
      () =>
        app.eval(
          (v: string) =>
            [...document.querySelectorAll<HTMLOptionElement>(
              "[data-testid=setting-plus-opens] option",
            )].some((o) => o.value === v),
          pair,
        ),
      3000,
      "the pair option",
    );
    await choose("[data-testid=setting-plus-opens]", pair);
    await waitFor(
      async () => (await app.settings()).plusOpens === pair,
      2000,
      "plusOpens",
    );
    await app.closeSettings();
    const before = await chipIds(app);
    await app.click("[data-testid=bar-new]");
    const id = await newFocused(app, before);
    await app.waitForText(id, "opencode · qwen3.8:27b-mlx", 5000);
  });
});
