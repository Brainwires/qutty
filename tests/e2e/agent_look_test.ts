// The agent tile's look against the demo backend (app/agent-tile.tsx): the header card, the empty
// state, a turn mid-way (its tool cards), a permission question, and the finished answer with its
// code, in the dark and the light theme. The pictures go to tests/e2e/__screenshots__ (and
// `AGENT_SHOT_DIR` when set); the checks are the parts a skin targets and the fonts (prose in the
// UI font, code in the terminal's).

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { pickInSub } from "./launch_helpers.ts";

const SHOT_DIRS = [
  join(ROOT, "tests/e2e/__screenshots__"),
  ...(Deno.env.get("AGENT_SHOT_DIR") ? [Deno.env.get("AGENT_SHOT_DIR")!] : []),
];

async function shot(app: App, name: string): Promise<void> {
  // The pointer off the tile (no hover outlines in the picture).
  await app.page.mouse.move(1100, 300);
  for (const dir of SHOT_DIRS) {
    await Deno.mkdir(dir, { recursive: true });
    await app.screenshot(join(dir, name));
  }
}

/** A chat tile from the `+` menu, its session open; its id. */
async function openChat(app: App): Promise<string> {
  await pickInSub(app, "coding", "[data-testid=launch-agent-chat]");
  await waitFor(
    () => app.exists("[data-testid=agent-launch-cwd]"),
    3000,
    "the folder question",
  );
  await app.eval(() => {
    const el = document.querySelector<HTMLInputElement>(
      "[data-testid=agent-launch-cwd]",
    )!;
    el.value = "~/project";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await app.click("[data-testid=agent-launch-open]");
  const id = await waitFor(
    () =>
      app.eval(() =>
        document.querySelector<HTMLElement>(
          "[data-testid=tile][data-agent-tile=true][data-focused=true]",
        )?.dataset.id ?? null
      ),
    5000,
    "a focused agent tile",
  );
  await waitFor(
    () =>
      app.eval((s: string) => {
        const el = document.querySelector<HTMLTextAreaElement>(s);
        return !!el && !el.disabled;
      }, `${tileSel(id)} [data-testid=agent-input]`),
    5000,
    "the session open",
  );
  return id;
}

async function ask(app: App, id: string, text: string): Promise<void> {
  await app.eval((s: string) => {
    document.querySelector<HTMLTextAreaElement>(s)!.focus();
  }, `${tileSel(id)} [data-testid=agent-input]`);
  await app.page.keyboard.type(text);
  await app.press("Enter");
}

/** Every picture of one theme: empty, mid-turn, the question, the answer. */
async function pictures(app: App, theme: "dark" | "light"): Promise<void> {
  const id = await openChat(app);
  await shot(app, `agent-look-${theme}-empty.png`);
  await ask(app, id, "change the greeting in notes.md");
  // Mid-turn: the first tool call is in, the question not yet.
  await waitFor(
    () =>
      app.exists(
        `${tileSel(id)} [data-testid=agent-group], ${
          tileSel(id)
        } [data-testid=agent-tool]`,
      ),
    5000,
    "a tool call",
  );
  await shot(app, `agent-look-${theme}-working.png`);
  await waitFor(
    () => app.exists(`${tileSel(id)} [data-testid=agent-allow]`),
    5000,
    "the question",
  );
  await shot(app, `agent-look-${theme}-permission.png`);
  await app.click(`${tileSel(id)} [data-testid=agent-allow]`);
  await waitFor(
    () => app.exists(`${tileSel(id)} [data-testid=agent-footer]`),
    8000,
    "the turn's end",
  );
  // The edit's diff open, the answer's code block in view.
  await app.click(
    `${
      tileSel(id)
    } [data-testid=agent-tool][data-tool=Edit] [data-testid=agent-tool-head]`,
  );
  await waitFor(
    () => app.exists(`${tileSel(id)} [data-testid=agent-diff]`),
    3000,
    "the diff",
  );
  await shot(app, `agent-look-${theme}-answer.png`);
}

suite("agent tile look", (test) => {
  test("dark: the header card, the empty state, a turn, a question, the answer", async (app) => {
    const id = await openChat(app);
    // Prose in the UI font, code in the terminal's.
    const fonts = await app.eval((s: string) => {
      const welcome = document.querySelector(
        `${s} [data-testid=agent-welcome]`,
      );
      return {
        welcome: welcome ? getComputedStyle(welcome).fontFamily : "",
        mono: getComputedStyle(document.documentElement).getPropertyValue(
          "--mono",
        ),
      };
    }, tileSel(id));
    assert(!fonts.welcome.includes("Mono"), fonts.welcome);
    await ask(app, id, "change the greeting in notes.md");
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=agent-allow]`),
      5000,
      "the question",
    );
    const look = await app.eval((s: string) => {
      const text = document.querySelector(`${s} .agent-text`);
      const user = document.querySelector(`${s} [data-type=user]`);
      return {
        text: text ? getComputedStyle(text).fontFamily : "",
        userPart: user?.getAttribute("data-part") ?? "",
        toolPart: document.querySelector(`${s} [data-testid=agent-tool]`)
          ?.getAttribute("data-part") ?? "",
        permPart: document.querySelector(`${s} [data-testid=agent-permission]`)
          ?.getAttribute("data-part") ?? "",
      };
    }, tileSel(id));
    assert(!look.text.includes("Mono"), look.text);
    assertEquals(
      [look.userPart, look.toolPart, look.permPart],
      ["agent-message", "agent-tool", "agent-permission"],
    );
    await app.click(`${tileSel(id)} [data-testid=agent-allow]`);
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=agent-footer]`),
      8000,
      "the turn's end",
    );
    const code = await app.eval(
      (s: string) =>
        getComputedStyle(document.querySelector(`${s} .md-pre`)!).fontFamily,
      tileSel(id),
    );
    assert(!code.includes("system-ui"), code);
  });

  test("dark: pictures", async (app) => {
    await pictures(app, "dark");
  });

  test("light: pictures", async (app) => {
    await app.openSettings("appearance");
    await app.click('[data-testid=setting-theme][data-value="cloud"]');
    await app.closeSettings();
    await pictures(app, "light");
  });

  test("classic: the same parts, squared up", async (app) => {
    await app.openSettings("appearance");
    await app.click('[data-testid=setting-skin][data-value="classic"]');
    await app.closeSettings();
    const id = await openChat(app);
    await ask(app, id, "change the greeting in notes.md");
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=agent-allow]`),
      5000,
      "the question",
    );
    assertEquals(
      await app.eval(
        (s: string) =>
          getComputedStyle(
            document.querySelector(`${s} [data-part=agent-tool]`)!,
          )
            .borderTopLeftRadius,
        tileSel(id),
      ),
      "0px",
    );
    await shot(app, "agent-look-classic.png");
  });
});
