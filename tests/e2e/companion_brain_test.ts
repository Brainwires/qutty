// Settings → Companion's brain choice against the demo backend: Claude Code (its model aliases)
// or a local Ollama model, listed from the Ollama helper's tracked models (only those that can
// call tools: the demo has qwen3.8 with tools and gemma3 without), the API key brain shown but
// unavailable, the choice persisted and sent to the hub (the demo brain's label names it), and
// back to Claude Code.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

const STATUS = "[data-testid=companion-brain-status]";
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
    // Claude Code by default, with its model aliases; the API key brain is listed, unavailable.
    assertEquals(await app.attr(engine("claude"), "aria-checked"), "true");
    assert(await app.exists("[data-testid=setting-companion-model]"));
    assertEquals(await app.attr(engine("api"), "disabled"), "");

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
});
