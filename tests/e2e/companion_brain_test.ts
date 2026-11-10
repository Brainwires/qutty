// Settings → Companion's brain choice against the demo backend: Claude Code (its model aliases)
// or a local Ollama model, listed from the Ollama helper's tracked models (only those that can
// call tools: the demo has qwen3.8 with tools and gemma3 without), the choice persisted and sent
// to the hub (the demo brain's label names it), and back to Claude Code. The API key brain: its
// key row (where the key is kept, Save, Remove), the key never shown again, the model's API ids.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

const STATUS = "[data-testid=companion-brain-status]";
const KEY = "[data-testid=companion-key-anthropic]";
const part = (name: string) => `[data-testid=companion-key-anthropic-${name}]`;
const OLLAMA_MODEL = "[data-testid=setting-companion-ollama-model]";
const engine = (value: string) =>
  `[data-testid=setting-companion-engine][data-value="${value}"]`;

/** The `<option>` values of `sel`. */
function options(app: App, sel: string): Promise<string[]> {
  return app.eval(
    (s: string) =>
      [...document.querySelectorAll<HTMLOptionElement>(`${s} option`)].map((
        o,
      ) => o.value),
    sel,
  );
}

async function statusText(app: App): Promise<string> {
  return await app.eval(
    (s: string) => document.querySelector(s)?.textContent ?? "",
    STATUS,
  );
}

suite("companion brain", (test) => {
  test("brain: Ollama lists only models that can call tools; the choice reaches the hub and persists", async (app) => {
    await app.openSettings();
    await waitFor(
      () => app.exists("[data-testid=companion-settings]"),
      2000,
      "the section",
    );
    // Claude Code by default, with its model aliases; the API key brain is offered.
    assertEquals(await app.attr(engine("claude"), "aria-checked"), "true");
    assert(await app.exists("[data-testid=setting-companion-model]"));
    assertEquals(await app.attr(engine("anthropic"), "disabled"), null);
    assert(!await app.exists(KEY), "no key row for Claude Code");

    // The Ollama helper's status arrives on its own poll; wait for the model to be listed.
    await app.click(engine("ollama"));
    await waitFor(
      async () =>
        (await options(app, OLLAMA_MODEL)).includes("qwen3.8:27b-mlx"),
      8000,
      "the tools-capable model",
    );
    const listed = await options(app, OLLAMA_MODEL);
    assert(!listed.includes("gemma3:4b"), "a model without tools is left out");
    await app.eval((s: string) => {
      const el = document.querySelector<HTMLSelectElement>(s)!;
      el.value = "qwen3.8:27b-mlx";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, OLLAMA_MODEL);
    await waitFor(
      async () =>
        (await statusText(app)).includes("Demo brain (Ollama qwen3.8:27b-mlx)"),
      3000,
      "the hub configured with the Ollama model",
    );
    const saved = (await app.settings()).companion;
    assertEquals(saved.engine, "ollama");
    assertEquals(saved.ollamaModel, "qwen3.8:27b-mlx");

    // Back to Claude Code: its model select returns, and the hub hears it.
    await app.click(engine("claude"));
    await waitFor(
      async () => (await statusText(app)).startsWith("Demo brain:"),
      3000,
      "the hub back on Claude Code",
    );
    assertEquals((await app.settings()).companion.engine, "claude");
  });

  test("brain: the API key brain keeps its key out of the page; Save, Replace and Remove", async (app) => {
    await app.openSettings();
    await waitFor(
      () => app.exists("[data-testid=companion-settings]"),
      2000,
      "the section",
    );
    await app.click(engine("anthropic"));
    await waitFor(() => app.exists(KEY), 2000, "the key row");
    await waitFor(
      async () => (await app.attr(KEY, "data-saved")) === "false",
      2000,
      "no key saved yet",
    );
    const where = async () =>
      await app.eval(
        (s: string) => document.querySelector(s)?.textContent ?? "",
        part("where"),
      );
    assert((await where()).includes("No key saved."));
    assert((await where()).includes("OS keychain"), await where());
    assert(!await app.exists(part("remove")), "nothing to remove yet");
    // The model select names the API's models.
    assertEquals(
      await app.eval(
        (s: string) =>
          [...document.querySelectorAll<HTMLOptionElement>(`${s} option`)].map(
            (o) => o.textContent,
          ),
        "[data-testid=setting-companion-model]",
      ),
      [
        "claude-opus-5-5 (default)",
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
        "claude-opus-5-5",
      ],
    );
    await waitFor(
      async () =>
        (await statusText(app)).includes("Demo brain (Anthropic API default)"),
      3000,
      "the hub configured with the API key brain",
    );
    assertEquals((await app.settings()).companion.engine, "anthropic");

    // Save: the field empties, the row says a key is saved, and the key is nowhere in the page.
    const secret = "sk-ant-e2e-0123456789";
    await app.click(part("input"));
    await app.page.keyboard.type(secret);
    await app.click(part("save"));
    await waitFor(
      async () => (await app.attr(KEY, "data-saved")) === "true",
      2000,
      "the key saved",
    );
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector<HTMLInputElement>(s)!.value,
        part("input"),
      ),
      "",
    );
    assert((await where()).startsWith("A key is saved."));
    assertEquals(
      await app.eval(
        (k: string) => document.documentElement.outerHTML.includes(k),
        secret,
      ),
      false,
    );
    assertEquals(
      JSON.stringify(await app.settings()).includes(secret),
      false,
      "the key is not in the saved settings",
    );
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector(s)?.textContent ?? "",
        part("save"),
      ),
      "Replace",
    );

    // A malformed key is refused with a reason; the saved one stays.
    await app.click(part("input"));
    await app.page.keyboard.type("two words");
    await app.click(part("save"));
    await waitFor(
      () => app.exists(`${KEY} .voice-error`),
      2000,
      "the refusal",
    );
    assertEquals(await app.attr(KEY, "data-saved"), "true");

    // Remove.
    await app.click(part("remove"));
    await waitFor(
      async () => (await app.attr(KEY, "data-saved")) === "false",
      2000,
      "the key removed",
    );
    assert(!await app.exists(part("remove")));
  });
});
