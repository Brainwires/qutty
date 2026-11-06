// The companion (Loopy) against the demo backend: the real companion runtime over a fake brain
// (lib/companion/demo-brain.ts). Loopy in its corner with clicks passing through the rest of the
// overlay; the chat box and a streamed reply; agents' `ask_user` questions in the bubble, answered
// by its buttons; `qutty-hook say` with a `--wait` answer; an agent's message to the companion; a
// tile the companion spawns, and its activity in Settings; the settings (corner, Off → the ask
// card returns, brain off); reduced motion. Also takes the screenshot the PR shows.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type App, ROOT, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { launchAgent } from "./agent_helpers.ts";

const OVERLAY = "[data-testid=companion-overlay]";
const BUBBLE = "[data-testid=loopy-bubble]";
const INPUT = "[data-testid=loopy-chat-input]";
/** Where the screenshot goes (gitignored), and a copy where `COMPANION_SHOT` says. */
const SHOT_DIR = join(ROOT, "tests/e2e/__screenshots__");

/** The bubble on screen (`null`: none). */
function bubble(app: App) {
  return app.eval((s: string) => {
    const el = document.querySelector<HTMLElement>(s);
    return el && {
      kind: el.dataset.kind ?? "",
      mood: el.dataset.mood ?? "",
      from: el.querySelector("[data-testid=loopy-bubble-from]")?.textContent ??
        null,
      text: el.querySelector("[data-testid=loopy-bubble-text]")?.textContent ??
        "",
      actions: [
        ...el.querySelectorAll<HTMLElement>("[data-testid=loopy-action]"),
      ]
        .map((b) => b.dataset.action),
      more: el.querySelector("[data-testid=loopy-bubble-more]")?.textContent ??
        null,
    };
  }, BUBBLE);
}

/** Wait until the bubble satisfies `ok`. */
function waitBubble(
  app: App,
  ok: (b: NonNullable<Awaited<ReturnType<typeof bubble>>>) => boolean,
  what: string,
  ms = 4000,
) {
  return waitFor(
    async () => {
      const b = await bubble(app);
      return b && ok(b) ? b : null;
    },
    ms,
    what,
  );
}

/** Wait until Loopy has sprung up and stands idle. */
function landed(app: App) {
  return waitFor(
    async () =>
      ["idle", "blink"].includes(
        await app.attr(OVERLAY, "data-loopy-state") ?? "",
      ),
    3000,
    "Loopy landed",
  );
}

/** Open the chat box (click Loopy) and send `text`. */
async function chat(app: App, text: string): Promise<void> {
  if (!(await app.exists(INPUT))) await app.click("[data-testid=loopy-poke]");
  await waitFor(
    () =>
      app.eval(
        (s: string) => document.activeElement?.matches(s) ?? false,
        INPUT,
      ),
    2000,
    "the chat input focused",
  );
  await app.page.keyboard.type(text);
  await app.press("Enter");
}

/** Open Settings → Companion (open by default). */
async function companionSettings(app: App): Promise<void> {
  await app.openSettings();
  await waitFor(
    () => app.exists("[data-testid=companion-settings]"),
    2000,
    "the section",
  );
}

suite("companion", (test) => {
  test("Loopy appears in the bottom-right corner; the overlay lets clicks through except Loopy", async (app) => {
    await waitFor(() => app.exists(OVERLAY), 3000, "the overlay");
    assertEquals(await app.attr(OVERLAY, "data-corner"), "bottom-right");
    await landed(app);
    const geo = await app.eval((s: string) => {
      const o = document.querySelector<HTMLElement>(s)!;
      const c = document.querySelector("[data-testid=cluster]")!
        .getBoundingClientRect();
      const r = o.getBoundingClientRect();
      const poke = o.querySelector<HTMLElement>("[data-testid=loopy-poke]")!;
      return {
        right: Math.round(c.right - r.right),
        bottom: Math.round(c.bottom - r.bottom),
        overlay: getComputedStyle(o).pointerEvents,
        poke: getComputedStyle(poke).pointerEvents,
        // Just left of Loopy, inside the overlay's box: the tile underneath gets it.
        under: document.elementFromPoint(r.left + 1, r.top + 1)?.closest(
          "[data-testid=tile]",
        ) !== null,
      };
    }, OVERLAY);
    assert(geo.right >= 0 && geo.right < 30, `right inset ${geo.right}`);
    assert(geo.bottom >= 0 && geo.bottom < 30, `bottom inset ${geo.bottom}`);
    assertEquals(geo.overlay, "none");
    assertEquals(geo.poke, "auto");
    assert(geo.under, "a click beside Loopy reaches the tile");
    // The brain sleeps until it is used.
    await waitFor(
      async () =>
        (await app.attr("[data-testid=loopy-status]", "data-state")) ===
          "stopped",
      3000,
      "the brain's status",
    );
    assertEquals(
      await app.exists(BUBBLE),
      false,
      "no bubble until something is said",
    );
  });

  test(
    "chat: the reply streams into the bubble while Loopy thinks; Escape gives the keyboard back",
    async (app) => {
      const shell = (await app.focusedId())!;
      await landed(app);
      // Record Loopy's moves and the brain's status while it answers.
      await app.eval((s: string) => {
        const seen: string[] = [];
        (globalThis as { __loopySeen?: string[] }).__loopySeen = seen;
        const overlay = document.querySelector<HTMLElement>(s)!;
        new MutationObserver(() =>
          seen.push(`${overlay.dataset.loopyState}/${overlay.dataset.brain}`)
        ).observe(overlay, { attributes: true });
      }, OVERLAY);
      await chat(app, "what's in tile 1?");
      await waitBubble(app, (b) => b.kind === "reply", "the reply bubble");
      const done = await waitBubble(
        app,
        (b) => b.text === "Tile 1 is shell-1, idle." && b.mood === "neutral",
        "the whole reply",
      );
      assertEquals(done.from, null);
      const seen = await app.eval(() =>
        (globalThis as { __loopySeen?: string[] }).__loopySeen ?? []
      );
      assert(seen.some((x) => x.startsWith("think/")), `thinking: ${seen}`);
      for (const state of ["starting", "thinking", "ready"]) {
        assert(seen.some((x) => x.endsWith(`/${state}`)), `${state}: ${seen}`);
      }
      await waitFor(
        async () =>
          (await app.attr("[data-testid=loopy-status]", "data-state")) ===
            "ready",
        3000,
        "the brain ready",
      );
      await app.press("Escape");
      await waitFor(
        async () => !(await app.exists(INPUT)),
        2000,
        "the chat closed",
      );
      await waitFor(
        () => app.xtermHasFocus(shell),
        2000,
        "keyboard back in the tile",
      );
    },
    { width: 1280, height: 800 },
  );

  test("ask_user in the bubble: buttons answer the waiting agent; questions queue; the close dismisses", async (app) => {
    const claude = await launchAgent(app, "claude");
    await app.typeInTerminal(claude, "/ask Deploy now?\n");
    const asked = await waitBubble(
      app,
      (b) => b.kind === "ask",
      "the question",
    );
    assertEquals(asked, {
      kind: "ask",
      mood: "attention",
      from: "claude",
      text: "Deploy now?",
      actions: ["Yes", "No"],
      more: null,
    });
    await waitFor(
      async () => (await app.attr(OVERLAY, "data-loopy-state")) === "point",
      3000,
      "Loopy points at it",
    );
    assert(
      await app.xtermHasFocus(claude),
      "the bubble does not take the keyboard",
    );
    await app.click('[data-testid=loopy-action][data-action="Yes"]');
    await app.waitForText(claude, "(demo) the user answered: Yes");
    await waitFor(
      async () => !(await app.exists(BUBBLE)),
      2000,
      "the bubble closed",
    );
    await waitFor(() => app.xtermHasFocus(claude), 2000, "keyboard back");

    const codex = await launchAgent(app, "codex");
    await app.typeInTerminal(claude, "/ask First?\n");
    await waitBubble(app, (b) => b.text === "First?", "the first question");
    await app.typeInTerminal(codex, "/ask Second?\n");
    await waitBubble(app, (b) => b.more === "+1 more", "the second queued");
    await app.click("[data-testid=loopy-bubble-close]");
    await app.waitForText(claude, "the user answered: nothing (dismissed)");
    const second = await waitBubble(
      app,
      (b) => b.text === "Second?",
      "the next",
    );
    assertEquals(second.from, "codex");
    await app.click('[data-testid=loopy-action][data-action="No"]');
    await app.waitForText(codex, "the user answered: No");
    // The ask card is not used while Loopy is shown.
    assertEquals(await app.exists("[data-testid=ask-dialog]"), false);
  });

  test("qutty-hook say: shown with its buttons; --wait prints the button pressed", async (app) => {
    const shell = (await app.focusedId())!;
    await app.run(shell, "qutty-hook say Tests passed --mood success");
    const said = await waitBubble(
      app,
      (b) => b.text === "Tests passed",
      "the message",
    );
    assertEquals([said.kind, said.mood, said.from], [
      "say",
      "success",
      "shell-1",
    ]);
    await app.click("[data-testid=loopy-bubble-close]");
    await app.typeInTerminal(
      shell,
      "qutty-hook say Deploy? --action yes:Deploy --action no:Later --wait\n",
    );
    const asked = await waitBubble(
      app,
      (b) => b.text === "Deploy?",
      "the question",
    );
    assertEquals(asked.actions, ["Deploy", "Later"]);
    await app.click('[data-testid=loopy-action][data-action="Deploy"]');
    await waitFor(
      async () =>
        (await app.readTerminalText(shell)).split("\n").some((l) =>
          l.trim() === "yes"
        ),
      3000,
      "the pick printed",
    );
    await app.run(shell, "qutty-hook say hi --mood angry");
    assertStringIncludes(
      await app.readTerminalText(shell),
      "mood must be one of",
    );
  });

  test("an agent's message to the companion: Loopy says who wrote, and the agent gets an answer", async (app) => {
    const claude = await launchAgent(app, "claude");
    await app.typeInTerminal(claude, "/msg companion are the tests green?\n");
    await app.waitForText(claude, "queued for companion");
    await waitBubble(
      app,
      (b) => b.text === "claude says: are the tests green?",
      "the companion's note",
      6000,
    );
    await waitFor(
      async () =>
        (await app.attr(
          `${tileSel(claude)} [data-testid=tile-agent-badge]`,
          "data-unread",
        )) ===
          "1",
      4000,
      "the companion's answer queued for claude",
    );
    await app.typeInTerminal(claude, "ok\n");
    await app.waitForText(claude, "✉ companion: Got it: are the tests green?");
  });

  test("the companion spawns a tile when asked; its privileged actions are listed in Settings", async (app) => {
    const before = (await app.chips()).length;
    await chat(app, "open a new tile please");
    await waitBubble(
      app,
      (b) => b.text === "I opened a new tile.",
      "the answer",
      6000,
    );
    await waitFor(
      async () => (await app.chips()).length === before + 1,
      3000,
      "the new tile",
    );
    await app.press("Escape");
    await companionSettings(app);
    const row = await waitFor(
      () =>
        app.eval(() =>
          document.querySelector("[data-testid=companion-activity-row]")
            ?.textContent ?? null
        ),
      3000,
      "an activity row",
    );
    assertStringIncludes(row, "spawn_tile");
    assertStringIncludes(
      await app.eval(() =>
        document.querySelector("[data-testid=companion-brain-status]")
          ?.textContent ?? ""
      ),
      "ready",
    );
  });

  test("settings: the corner moves Loopy; Off hides it (the ask card returns); brain off disables the chat", async (app) => {
    await companionSettings(app);
    await app.eval(() => {
      const s = document.querySelector<HTMLSelectElement>(
        "[data-testid=setting-companion-corner]",
      )!;
      s.value = "top-left";
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(
      async () => (await app.attr(OVERLAY, "data-corner")) === "top-left",
      2000,
      "moved",
    );
    assertEquals((await app.settings()).companion.corner, "top-left");
    // Floating is listed for later, and not available yet.
    assertEquals(
      await app.attr(
        '[data-testid=setting-companion-mode][data-value="floating"]',
        "disabled",
      ),
      "",
    );

    await app.click("[data-testid=setting-companion-brain]");
    await app.closeSettings();
    await app.click("[data-testid=loopy-poke]");
    assertEquals(await app.attr(INPUT, "disabled"), "");
    assertStringIncludes(
      (await app.attr(INPUT, "placeholder")) ?? "",
      "Settings",
    );
    await waitFor(
      async () =>
        (await app.attr("[data-testid=loopy-status]", "data-state")) === "off",
      2000,
      "the brain off",
    );

    await companionSettings(app);
    await app.click('[data-testid=setting-companion-mode][data-value="off"]');
    await app.closeSettings();
    await waitFor(async () => !(await app.exists(OVERLAY)), 2000, "Loopy gone");
    const claude = await launchAgent(app, "claude");
    await app.typeInTerminal(claude, "/ask Still the card?\n");
    await waitFor(
      () => app.exists("[data-testid=ask-dialog]"),
      3000,
      "the ask card",
    );
    await app.click('[data-testid=ask-action][data-action="Yes"]');
    await app.waitForText(claude, "the user answered: Yes");

    // Settings persist across a reload.
    await app.reload();
    assertEquals((await app.settings()).companion, {
      mode: "off",
      corner: "top-left",
      brain: false,
      model: "",
    });
    assertEquals(await app.exists(OVERLAY), false);
  });

  test(
    "screenshot: Loopy answering in the bubble, with the chat box open",
    async (app) => {
      const shell = (await app.focusedId())!;
      await app.run(shell, "ls");
      const claude = await launchAgent(app, "claude");
      await app.typeInTerminal(claude, "/help\n");
      await chat(app, "what's in tile 2?");
      await waitBubble(
        app,
        (b) => b.text === "Tile 2 is claude (claude), idle.",
        "the answer",
      );
      await app.page.keyboard.type("open a new tile");
      await app.settle();
      await Deno.mkdir(SHOT_DIR, { recursive: true });
      const png = await app.screenshot(join(SHOT_DIR, "10-companion.png"));
      assert(png.length > 8_000, "a real screenshot");
      const copy = Deno.env.get("COMPANION_SHOT");
      if (copy) {
        await Deno.writeFile(copy, png);
      }
    },
    { width: 1280, height: 800 },
  );

  test("look: Loopy is drawn with the example's geometry, sizes and moves", async (app) => {
    await landed(app);
    const snap = JSON.parse(
      await Deno.readTextFile(
        join(ROOT, "tests/fixtures/companion/loopy-shape.json"),
      ),
    ) as { svg: string[] };
    const drawn = await app.eval((s: string) => {
      const svg = document.querySelector<SVGSVGElement>(`${s} svg.loopy`)!;
      const attrs: string[] = [];
      const wire = svg.querySelector(".loopy-wire")!.getAttribute("d")!;
      const arm = svg.querySelector(".loopy-arm .loopy-wire")!.getAttribute(
        "d",
      )!;
      attrs.push(`WIRE=${wire}`, `ARM=${arm}`);
      for (const n of ["viewBox", "width", "height"]) {
        attrs.push(`${n}=${svg.getAttribute(n)}`);
      }
      for (
        const el of svg.querySelectorAll(
          "ellipse, circle, .loopy-mouth, .loopy-sparkles path",
        )
      ) {
        for (const n of ["cx", "cy", "rx", "ry", "r", "d"]) {
          const v = el.getAttribute(n);
          if (v !== null) attrs.push(`${n}=${v}`);
        }
      }
      const css = (sel: string, prop: string) =>
        getComputedStyle(svg.querySelector(sel) ?? svg).getPropertyValue(prop);
      const box = svg.getBoundingClientRect();
      // Each move's animation, as the example's stylesheet sets it.
      const moves: Record<string, string> = {};
      for (const state of ["appear", "idle", "celebrate", "dismiss"]) {
        svg.setAttribute("data-state", state);
        moves[state] = css(".loopy-body", "animation-name");
      }
      svg.setAttribute("data-state", "point");
      moves.point = css(".loopy-arm", "transform");
      svg.setAttribute("data-state", "idle");
      return {
        attrs,
        size: [Math.round(box.width), Math.round(box.height)],
        strokes: [".loopy-wire-edge", ".loopy-wire", ".loopy-wire-shine"].map((
          c,
        ) => css(c, "stroke-width")),
        moves,
      };
    }, OVERLAY);
    assertEquals(drawn.attrs, snap.svg);
    assertEquals(
      drawn.size,
      [90, 150],
      "the example's size in its desktop window",
    );
    assertEquals(drawn.strokes, ["10px", "7.5px", "2px"]);
    assertEquals(drawn.moves.appear, "loopy-spring");
    assertEquals(drawn.moves.idle, "loopy-sway");
    assertEquals(drawn.moves.celebrate, "loopy-hop");
    assertEquals(drawn.moves.dismiss, "loopy-fold");
    assert(
      drawn.moves.point.startsWith("matrix("),
      `the arm unbends: ${drawn.moves.point}`,
    );

    // The bubble's shape: the example's radius, border, padding and tail.
    const shell = (await app.focusedId())!;
    await app.run(shell, "qutty-hook say Shape check");
    await waitBubble(app, (b) => b.text === "Shape check", "the bubble");
    const bubbleShape = await app.eval((s: string) => {
      const b = document.querySelector<HTMLElement>(s)!;
      const cs = getComputedStyle(b);
      const tail = getComputedStyle(b, "::after");
      return [
        cs.borderTopLeftRadius,
        cs.padding,
        cs.maxWidth,
        cs.fontSize,
        tail.width,
        tail.left,
        tail.bottom,
      ];
    }, BUBBLE);
    assertEquals(bubbleShape, [
      "14px",
      "10px 26px 10px 12px",
      "240px",
      "13.5px",
      "14px",
      "48px",
      "-8px",
    ]);
  });

  test("reduced motion: Loopy's moves land at once", async (app) => {
    await waitFor(() => app.exists(OVERLAY), 3000, "the overlay");
    const durations = await app.eval(() => {
      const body = document.querySelector(".loopy-body")!;
      return getComputedStyle(body).animationDuration;
    });
    assertEquals(durations, "0.001s");
    await chat(app, "hello");
    await waitBubble(app, (b) => b.text.includes("I heard"), "the reply");
    const bubbleAnim = await app.eval(
      (s: string) =>
        getComputedStyle(document.querySelector(s)!).animationDuration,
      BUBBLE,
    );
    assertEquals(bubbleAnim, "0.001s");
  }, { reducedMotion: true });
});
