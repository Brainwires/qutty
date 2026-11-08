// The companion (Loopy) against the demo backend: the real companion runtime over a fake brain
// (lib/companion/demo-brain.ts). Loopy in its corner with clicks passing through the rest of the
// overlay; the chat box and a streamed reply; agents' `ask_user` questions in the bubble, answered
// by its buttons; `qutty-hook say` with a `--wait` answer; an agent's message to the companion; a
// tile the companion spawns, and its activity in Settings; the settings (corner, Off → the ask
// card returns, brain off); reduced motion; Lively (the eyes on the pointer, excitement near it,
// never over a question, still with reduced motion, off in Settings). Also takes the screenshots
// the PRs show.

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

/** Loopy's face for the Lively checks: mood, expression, pupils' offsets (px), centre, gaze. */
function face(app: App) {
  return app.eval((s: string) => {
    const svg = document.querySelector<SVGSVGElement>(`${s} svg.loopy`)!;
    const mid = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    const whites = [...svg.querySelectorAll(".loopy-eye-white")].map(mid);
    const pupils = [...svg.querySelectorAll(".loopy-eyes circle")].map(mid);
    const holder = svg.parentElement!;
    return {
      mood: svg.getAttribute("data-mood"),
      expr: svg.getAttribute("data-expr"),
      lively: svg.hasAttribute("data-lively"),
      /** Each pupil's centre from its eye white's, across (px). */
      pupils: pupils.map((p, i) => p.x - whites[i].x),
      centre: mid(svg.querySelector(".loopy-bead")!),
      /** The gaze offsets the pointer loop set ("0" at rest, "" when none). */
      gaze: ["lx", "ly", "rx", "ry"].map((k) => {
        const v = holder.style.getPropertyValue(`--loopy-gaze-${k}`);
        return v && Math.abs(parseFloat(v)) < 0.05 ? "0" : v;
      }),
    };
  }, OVERLAY);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start recording Loopy's moods and moves (`reset`), or read what was recorded: each mood
 * (`data-mood`) and move (`data-state`) Loopy took since.
 */
function record(app: App, reset = true): Promise<string[]> {
  return app.eval(
    (s: string, fresh: boolean) => {
      const w = globalThis as {
        __loopyLife?: string[];
        __loopyObs?: MutationObserver;
      };
      if (fresh) {
        w.__loopyObs?.disconnect();
        const seen: string[] = [];
        w.__loopyLife = seen;
        const svg = document.querySelector(`${s} svg.loopy`)!;
        w.__loopyObs = new MutationObserver((list) => {
          for (const m of list) {
            const v = (m.target as Element).getAttribute(m.attributeName!);
            if (v) seen.push(v);
          }
        });
        w.__loopyObs.observe(svg, {
          attributes: true,
          attributeFilter: ["data-mood", "data-state"],
        });
      }
      return [...(w.__loopyLife ?? [])];
    },
    OVERLAY,
    reset,
  );
}

/** Bring the pointer slowly from the left to just beside Loopy, and move it about there. */
async function approach(app: App): Promise<void> {
  const c = (await face(app)).centre;
  for (let i = 0; i <= 12; i++) {
    await app.page.mouse.move(c.x - 420 + i * 25, c.y - 10);
    await pause(25);
  }
  for (let i = 0; i < 8; i++) {
    await app.page.mouse.move(c.x - 120 + (i % 2) * 8, c.y - 10 - i * 2);
    await pause(30);
  }
}

/** A close-up of Loopy, as loopy-alive-<name>.png in SHOT_DIR (and `LOOPY_SHOT_DIR` when set). */
async function shot(app: App, name: string): Promise<void> {
  const c = (await face(app)).centre;
  const png = await app.page.screenshot({
    format: "png",
    clip: { x: c.x - 80, y: c.y - 85, width: 160, height: 150, scale: 3 },
  });
  await Deno.mkdir(SHOT_DIR, { recursive: true });
  await Deno.writeFile(join(SHOT_DIR, `loopy-alive-${name}.png`), png);
  const dir = Deno.env.get("LOOPY_SHOT_DIR");
  if (dir) await Deno.writeFile(join(dir, `loopy-alive-${name}.png`), png);
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
      engine: "claude",
      model: "",
      ollamaModel: "",
      lively: true,
      nightSleepy: true,
      nightFrom: 0,
      nightTo: 360,
      celebrate: true,
      sad: true,
      reactMinS: 20,
      reactAnyCommand: false,
      reactBubble: true,
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

  test("look: Loopy's face is the example's, 2 times the clip's head, with its moods, rim and moves", async (app) => {
    await landed(app);
    const snap = JSON.parse(
      await Deno.readTextFile(
        join(ROOT, "tests/fixtures/companion/loopy-shape.json"),
      ),
    ) as {
      head: Record<string, string>;
      tints: Record<string, string[]>;
      avatar: { viewBox: string; width: number; height: number };
    };
    /** Loopy's head as drawn, and the snapshot's for `mood`, as one line per element. */
    const compare = (mood: string) =>
      app.eval(
        (s: string, markup: string) => {
          const lines = (g: Element) =>
            [g, ...g.querySelectorAll("*")].map((el) =>
              [
                el.tagName.toLowerCase(),
                ...[...el.attributes].map((a) => `${a.name}=${a.value}`),
                el.children.length ? "" : (el.textContent ?? ""),
              ].join(" ")
            );
          const live = document.querySelector(`${s} svg.loopy`)!;
          const parsed = new DOMParser().parseFromString(
            `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`,
            "image/svg+xml",
          ).querySelector("g")!;
          return {
            mood: live.getAttribute("data-mood"),
            live: lines(live.querySelector(".loopy-head")!),
            expected: lines(parsed),
            rim: getComputedStyle(live.querySelector(".loopy-bead")!).filter,
          };
        },
        OVERLAY,
        snap.head[mood],
      );
    const rgb = (hex: string) =>
      `rgb(${
        [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")
      })`;

    /** Loopy in `mood`, once the rim has eased into the mood's tint (neutral: no rim). */
    const inMood = (mood: string) =>
      waitFor(
        async () => {
          const look = await compare(mood);
          if (look.mood !== mood) return null;
          const tinted = mood === "neutral"
            ? look.rim === "none"
            : look.rim.includes(rgb(snap.tints[mood][0]));
          return tinted ? look : null;
        },
        3000,
        `Loopy's rim tinted ${mood}`,
      );

    // Neutral (nothing said): the bare steel bead, the example's face, no rim and no wire.
    const neutral = await inMood("neutral");
    assertEquals(neutral.live, neutral.expected);

    const drawn = await app.eval((s: string) => {
      const svg = document.querySelector<SVGSVGElement>(`${s} svg.loopy`)!;
      const face = svg.querySelector(".loopy-face")!;
      const box = svg.getBoundingClientRect();
      const poke = document.querySelector("[data-testid=loopy-poke]")!
        .getBoundingClientRect();
      const bead = svg.querySelector<SVGCircleElement>(".loopy-bead")!;
      const beadBox = bead.getBBox();
      const scale = svg.getScreenCTM()!.a;
      // The bead on screen, without the face's own moves (the SVG's scale only).
      const beadOnScreen = {
        x: box.x + (beadBox.x - svg.viewBox.baseVal.x) * scale,
        y: box.y + (beadBox.y - svg.viewBox.baseVal.y) * scale,
        size: beadBox.width * scale,
      };
      // Each move's animation (or pose), on the head.
      const moves: Record<string, string> = {};
      for (const state of ["appear", "idle", "celebrate", "dismiss"]) {
        svg.setAttribute("data-state", state);
        moves[state] = getComputedStyle(face).animationName;
      }
      for (const state of ["think", "point"]) {
        svg.setAttribute("data-state", state);
        moves[state] = getComputedStyle(face).transform;
      }
      svg.setAttribute("data-state", "idle");
      return {
        size: [box.width, box.height],
        viewBox: svg.getAttribute("viewBox"),
        bead: beadOnScreen,
        poke: { x: poke.x, y: poke.y, w: poke.width, h: poke.height },
        wire: svg.querySelectorAll(".loopy-wire, .loopy-body").length,
        moves,
      };
    }, OVERLAY);
    assertEquals(
      drawn.size,
      [snap.avatar.width, snap.avatar.height],
      "the avatar's size",
    );
    assertEquals(drawn.viewBox, snap.avatar.viewBox);
    assert(
      drawn.size[0] < 120 && drawn.size[1] < 150,
      "smaller than the whole clip was (120 x 150)",
    );
    // The clip's head was 43.5 px across in its 120 x 150 window.
    assertEquals(drawn.bead.size, 43.5 * 2, "the head 2 times the clip's");
    assertEquals(drawn.wire, 0, "no wire body");
    // The poke target is the whole bead.
    const near = (a: number, b: number) => Math.abs(a - b) < 1;
    assert(
      near(drawn.poke.x, drawn.bead.x) && near(drawn.poke.y, drawn.bead.y) &&
        near(drawn.poke.w, drawn.bead.size) &&
        near(drawn.poke.h, drawn.bead.size),
      `the poke target covers the bead: ${JSON.stringify(drawn)}`,
    );
    assertEquals(drawn.moves.appear, "loopy-face-pop-in");
    assertEquals(drawn.moves.idle, "loopy-face-bob");
    assertEquals(drawn.moves.celebrate, "loopy-face-hop");
    assertEquals(drawn.moves.dismiss, "loopy-face-fold");
    assert(drawn.moves.think.startsWith("matrix("), "think: a tilt back");
    assert(drawn.moves.point.startsWith("matrix("), "point: a nudge");

    // A mood said: its face, its extras and its rim (and an alias of Qutty's states).
    const shell = (await app.focusedId())!;
    for (
      const [said, mood] of [["sleepy", "sleepy"], ["error", "sad"]] as const
    ) {
      await app.run(shell, `qutty-hook say Mood ${said} --mood ${said}`);
      await waitBubble(app, (b) => b.mood === mood, `the ${mood} bubble`);
      const look = await inMood(mood);
      assertEquals(look.live, look.expected, mood);
      await app.click("[data-testid=loopy-bubble-close]");
    }

    // The bubble's shape: the example's radius, border, padding and tail (re-aimed at the face).
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
      "62px",
      "-8px",
    ]);
  });

  test("reduced motion: Loopy's moves land at once", async (app) => {
    await waitFor(() => app.exists(OVERLAY), 3000, "the overlay");
    const durations = await app.eval(() => {
      const face = document.querySelector(".loopy-face")!;
      return getComputedStyle(face).animationDuration;
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

  // --- Lively: the eyes on the pointer, excitement near it (app/companion/use-loopy-life.ts)

  test(
    "lively: the eyes follow the pointer left and right, and drift back once it rests",
    async (app) => {
      await landed(app);
      const start = await face(app);
      assertEquals(start.lively, true, "Lively by default");
      // Far from Loopy (no excitement): top left, then top right.
      await app.page.mouse.move(10, 40, { steps: 6 });
      const left = await waitFor(
        async () => {
          const f = await face(app);
          return f.pupils.every((x) => x < -3) ? f : null;
        },
        2000,
        "both pupils to the left",
      );
      assertEquals(left.mood, "neutral");
      await shot(app, "left");
      // Loopy sits at the right edge: up and to its right, still far (no excitement).
      await app.page.mouse.move(1395, left.centre.y - 360, { steps: 6 });
      await waitFor(
        async () => (await face(app)).pupils.every((x) => x > 1.5),
        2000,
        "both pupils to the right",
      );
      await shot(app, "right");
      // The pointer rests: the eyes stay on it a while, then drift back to the face's own place.
      await pause(700);
      assert(
        (await face(app)).pupils.every((x) => x > 1.5),
        "still watching",
      );
      const back = await waitFor(
        async () => {
          const f = await face(app);
          return f.gaze.every((g) => g === "0") ? f : null;
        },
        4000,
        "the eyes back at rest",
      );
      assertEquals(back.mood, "neutral", "far away: no excitement");
    },
    { width: 1400, height: 900 },
  );

  test("lively: the pointer near Loopy excites it once, with a hop; then a cooldown; over the face, delight", async (app) => {
    await landed(app);
    await record(app);
    await approach(app);
    await waitFor(
      async () => (await face(app)).mood === "excited",
      2000,
      "the excited face",
    );
    await shot(app, "excited");
    await waitFor(
      async () => (await record(app, false)).includes("celebrate"),
      2000,
      "the hop",
    );
    await waitFor(
      async () => (await face(app)).mood === "neutral",
      4000,
      "calm again",
    );
    // Away and back within the cooldown: no excitement this time.
    const c = (await face(app)).centre;
    await app.page.mouse.move(c.x - 600, c.y - 500, { steps: 10 });
    await pause(400);
    await record(app);
    await approach(app);
    await pause(1200);
    assertEquals(
      (await record(app, false)).filter((m) => m === "excited"),
      [],
      "not again so soon",
    );
    // Resting over the face: delighted (a variation of the neutral face).
    await app.page.mouse.move(c.x + 3, c.y + 2, { steps: 3 });
    await waitFor(
      async () => {
        const f = await face(app);
        return f.expr === "delighted" && f.mood === "neutral";
      },
      2000,
      "delighted under the pointer",
    );
  });

  test("lively: an ask_user question's attention face is never replaced", async (app) => {
    const claude = await launchAgent(app, "claude");
    await app.typeInTerminal(claude, "/ask Ship it?\n");
    await waitBubble(app, (b) => b.mood === "attention", "the question");
    await waitFor(
      async () =>
        (await face(app)).mood === "attention" &&
        (await app.attr(OVERLAY, "data-loopy-state")) === "point",
      3000,
      "the attention face, pointing at the question",
    );
    await record(app);
    await approach(app);
    const c = (await face(app)).centre;
    // Fast, close by, and over the face.
    await app.page.mouse.move(c.x - 250, c.y - 60, { steps: 2 });
    await app.page.mouse.move(c.x + 5, c.y, { steps: 2 });
    await pause(1200);
    const f = await face(app);
    assertEquals(f.mood, "attention");
    assertEquals(f.expr, null, "no micro-expression over a question");
    assertEquals(await record(app, false), [], "nothing changed Loopy");
    assertEquals(await app.attr(OVERLAY, "data-loopy-state"), "point");
  });

  test(
    "lively, reduced motion: the eyes jump to the pointer; excitement is a still face, no hop",
    async (app) => {
      await landed(app);
      await app.page.mouse.move(10, 40, { steps: 2 });
      await waitFor(
        async () => (await face(app)).pupils.every((x) => x < -3),
        1000,
        "both pupils to the left",
      );
      await record(app);
      await approach(app);
      await waitFor(
        async () => (await face(app)).mood === "excited",
        2000,
        "the excited face",
      );
      assertEquals(
        (await record(app, false)).includes("celebrate"),
        false,
        "no hop",
      );
      await waitFor(
        async () => (await face(app)).mood === "neutral",
        4000,
        "calm again",
      );
    },
    { reducedMotion: true },
  );

  test("lively off (Settings → Companion): today's Loopy, eyes still and no excitement", async (app) => {
    await companionSettings(app);
    await app.click("[data-testid=setting-companion-lively]");
    await app.closeSettings();
    assertEquals((await app.settings()).companion.lively, false);
    await landed(app);
    const before = await face(app);
    assertEquals(before.lively, false);
    await app.page.mouse.move(10, 40, { steps: 4 });
    await pause(400);
    await app.page.mouse.move(1390, 40, { steps: 4 });
    await pause(400);
    const after = await face(app);
    for (const i of [0, 1]) {
      assert(
        Math.abs(after.pupils[i] - before.pupils[i]) < 0.6,
        `pupil ${i} stayed: ${before.pupils} → ${after.pupils}`,
      );
    }
    assertEquals(after.gaze, ["", "", "", ""], "no gaze set");
    await record(app);
    await approach(app);
    await pause(800);
    assertEquals(await record(app, false), [], "no excitement");
    assertEquals(after.expr, null);
  });
});
