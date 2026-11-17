// Agent tiles against the demo backend: its scripted Claude Code (lib/agent/demo.ts) goes through
// the real stream-json parser and the real session layer (lib/agent/sessions.ts). Opening one from
// the + menu (its folder question), a prompt and its streamed rows (text, a run of reads, an edit
// that asks for permission, a command, markdown), Allow / Deny / Allow always, expanding a tool
// row (the diff), interrupting, queueing while it works, the Agents panel's groups (Needs you,
// Working, To review), the model picker, renaming, and the tile coming back on its session when
// the window does.
//
// E2E_SCREENSHOTS=<dir> saves a picture of a finished turn there.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";

/** Open "Claude Code (chat)" from the + menu in `cwd`; the new tile's id, once focused. */
async function openAgent(app: App, cwd = "~/project"): Promise<string> {
  await app.click("[data-testid=bar-new-menu]");
  await app.click("[data-testid=launch-agent-chat]");
  await waitFor(
    () => app.exists("[data-testid=agent-launch-cwd]"),
    3000,
    "the folder question",
  );
  await app.eval((v: string) => {
    const el = document.querySelector<HTMLInputElement>(
      "[data-testid=agent-launch-cwd]",
    )!;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, cwd);
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
  // Its session opened (the prompt box is enabled) and has the keyboard.
  await waitFor(
    () =>
      app.eval((s: string) => {
        const el = document.querySelector<HTMLTextAreaElement>(s);
        return !!el && !el.disabled && document.activeElement === el;
      }, `${tileSel(id)} [data-testid=agent-input]`),
    5000,
    "the prompt box to take the keyboard",
  );
  return id;
}

/** Type `text` into agent tile `id`'s prompt box and press Enter. */
async function prompt(app: App, id: string, text: string): Promise<void> {
  await app.eval((s: string) => {
    document.querySelector<HTMLTextAreaElement>(s)!.focus();
  }, `${tileSel(id)} [data-testid=agent-input]`);
  await app.page.keyboard.type(text);
  await app.press("Enter");
}

/** The tile's row types, top to bottom (tool rows as `tool:<name>`, groups as `group`). */
function rowKinds(app: App, id: string): Promise<string[]> {
  return app.eval((s: string) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        `${s} [data-testid=agent-log] > *`,
      ),
    ].map((el) =>
      el.dataset.testid === "agent-tool"
        ? `tool:${el.dataset.tool}`
        : el.dataset.testid === "agent-row"
        ? el.dataset.type ?? "row"
        : el.dataset.testid?.replace(/^agent-/, "") ?? el.className
    ), tileSel(id));
}

/** Wait for agent tile `id`'s open permission question; its buttons are there. */
function waitForQuestion(app: App, id: string): Promise<unknown> {
  return waitFor(
    () => app.exists(`${tileSel(id)} [data-testid=agent-allow]`),
    5000,
    "a permission question",
  );
}

/** Wait for the `n`-th turn footer in tile `id`; its outcome. */
function waitForFooter(app: App, id: string, n = 1): Promise<string> {
  return waitFor(
    () =>
      app.eval(
        (s: string, k: number) => {
          const all = document.querySelectorAll<HTMLElement>(
            `${s} [data-testid=agent-footer]`,
          );
          return all.length >= k ? all[k - 1].dataset.outcome ?? null : null;
        },
        tileSel(id),
        n,
      ),
    8000,
    `turn ${n} to end`,
  );
}

/** The Agents panel's groups: `{ group: [tile ids] }`. */
async function panelGroups(app: App): Promise<Record<string, string[]>> {
  if (!(await app.exists("[data-testid=agents-menu]"))) {
    await app.click("[data-testid=bar-agents]");
  }
  const groups = await app.eval(() => {
    const out: Record<string, string[]> = {};
    for (
      const g of document.querySelectorAll<HTMLElement>(
        "[data-testid=agents-group]",
      )
    ) {
      out[g.dataset.group!] = [
        ...g.querySelectorAll<HTMLElement>("[data-testid=agents-item]"),
      ].map((i) => i.dataset.id!);
    }
    return out;
  });
  await app.press("Escape");
  return groups;
}

suite("agent tile", (test) => {
  test("+ menu → a chat tile; a prompt streams rows; Allow applies the edit", async (app) => {
    const id = await openAgent(app);
    assertEquals(
      await app.attr(`${tileSel(id)} [data-testid=agent-name]`, "value"),
      "claude",
    );
    await prompt(app, id, "change the greeting in notes.md");
    // The user's row, then the stream up to the question.
    await waitForQuestion(app, id);
    assertEquals(
      await app.attr(`${tileSel(id)} [data-testid=agent-dot]`, "data-group"),
      "needs",
    );
    // The bar's Agents button counts it.
    assertEquals(await app.attr("[data-testid=bar-agents]", "data-needs"), "1");
    const before = await rowKinds(app, id);
    assertEquals(before.slice(0, 3), ["user", "thinking", "text"]);
    assert(before.includes("group"), `reads grouped: ${before}`);
    await app.click(`${tileSel(id)} [data-testid=agent-allow]`);
    assertEquals(await waitForFooter(app, id), "done");
    const kinds = await rowKinds(app, id);
    assert(
      kinds.includes("tool:Edit") && kinds.includes("tool:Bash"),
      `${kinds}`,
    );
    assertEquals(
      await app.attr(
        `${tileSel(id)} [data-testid=agent-permission]`,
        "data-decision",
      ),
      "allow",
    );
    // The edit's ⎿ summary, and its diff once expanded.
    const sum = await app.eval((s: string) =>
      document.querySelector(
        `${s} [data-testid=agent-tool][data-tool=Edit] [data-testid=agent-tool-summary]`,
      )?.textContent ?? "", tileSel(id));
    assert(sum.includes("Applied 1-line change"), sum);
    await app.click(
      `${
        tileSel(id)
      } [data-testid=agent-tool][data-tool=Edit] [data-testid=agent-tool-head]`,
    );
    const diff = await waitFor(
      () =>
        app.eval(
          (s: string) =>
            [...document.querySelectorAll(
              `${s} [data-testid=agent-diff] .diff-line`,
            )]
              .map((l) => l.className.split(" ")[1]).join(" ") || null,
          tileSel(id),
        ),
      3000,
      "the diff",
    );
    assertEquals(diff, "diff-hunk diff-del diff-add diff-ctx");
    // The answer's markdown: a heading, a list, a highlighted code block, a link.
    const md = await app.eval((s: string) => {
      const last = [...document.querySelectorAll(`${s} .agent-text`)].at(-1)!;
      return {
        h: !!last.querySelector(".md-h"),
        li: last.querySelectorAll(".md-li").length,
        kw: !!last.querySelector(".md-pre .hl-kw"),
        link: last.querySelector(".md-link")?.getAttribute("href") ?? null,
      };
    }, tileSel(id));
    assertEquals(md, {
      h: true,
      li: 2,
      kw: true,
      link: "https://example.com/docs",
    });
    // The footer's speed and time.
    const footer = await app.eval(
      (s: string) =>
        document.querySelector(`${s} [data-testid=agent-footer]`)!.textContent!,
      tileSel(id),
    );
    assert(/^done · [\d,]+ tok\/s · [\d,]+ tok · [\d.]+s/.test(footer), footer);
    // Idle and focused: nothing to review.
    assertEquals(
      await app.attr(`${tileSel(id)} [data-testid=agent-dot]`, "data-group"),
      "idle",
    );
    const shots = Deno.env.get("E2E_SCREENSHOTS");
    if (shots) await app.screenshot(`${shots}/agent-tile-turn.png`);
  });

  test("Deny refuses the edit; Allow always is not asked again", async (app) => {
    const id = await openAgent(app);
    await prompt(app, id, "edit the notes");
    await waitForQuestion(app, id);
    await app.click(`${tileSel(id)} [data-testid=agent-deny]`);
    assertEquals(await waitForFooter(app, id), "done");
    assertEquals(
      await app.attr(
        `${tileSel(id)} [data-testid=agent-tool][data-tool=Edit]`,
        "data-status",
      ),
      "denied",
    );
    await prompt(app, id, "try again");
    await waitFor(
      () =>
        app.count(`${tileSel(id)} [data-testid=agent-allow]`).then((n) =>
          n === 1
        ),
      5000,
      "the second question",
    );
    await app.click(`${tileSel(id)} [data-testid=agent-allow-always]`);
    assertEquals(await waitForFooter(app, id, 2), "done");
    await prompt(app, id, "and once more");
    assertEquals(await waitForFooter(app, id, 3), "done");
    // Three turns, two questions: the third edit ran without asking.
    assertEquals(
      await app.count(`${tileSel(id)} [data-testid=agent-permission]`),
      2,
    );
    const edits = await app.eval(
      (s: string) =>
        [...document.querySelectorAll<HTMLElement>(
          `${s} [data-testid=agent-tool][data-tool=Edit]`,
        )].map((e) => e.dataset.status),
      tileSel(id),
    );
    assertEquals(edits, ["denied", "done", "done"]);
  });

  test("Escape interrupts a turn; a message typed meanwhile waits in the queue", async (app) => {
    const id = await openAgent(app);
    await prompt(app, id, "slow job");
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=agent-working]`),
      3000,
      "working",
    );
    assertEquals(
      await app.attr(`${tileSel(id)} [data-testid=agent-dot]`, "data-group"),
      "working",
    );
    // Typed while it works: queued, not sent.
    await prompt(app, id, "hello after");
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=agent-queue]`),
      3000,
      "the queue",
    );
    assert(await app.exists(`${tileSel(id)} [data-testid=agent-stop]`));
    await app.press("Escape");
    assertEquals(await waitForFooter(app, id), "interrupted");
    // The interrupt dropped the queue; nothing else ran.
    assert(!(await app.exists(`${tileSel(id)} [data-testid=agent-queue]`)));
    const kinds = await rowKinds(app, id);
    assert(kinds.includes("notice"), `${kinds}`);
    assertEquals(kinds.filter((k) => k === "user").length, 1);
    // A queued message runs once the turn ends on its own.
    await prompt(app, id, "hello one");
    await prompt(app, id, "hello two");
    assertEquals(await waitForFooter(app, id, 3), "done");
    const users = await app.eval(
      (s: string) =>
        [...document.querySelectorAll(`${s} .agent-user-text`)].map((e) =>
          e.textContent
        ),
      tileSel(id),
    );
    assertEquals(users, ["slow job", "hello one", "hello two"]);
  });

  test("the Agents panel: Needs you, Working, To review; a click focuses", async (app) => {
    const terminal = (await app.focusedId())!;
    const a = await openAgent(app);
    await prompt(app, a, "edit please");
    await waitForQuestion(app, a);
    const b = await openAgent(app);
    await prompt(app, b, "slow plan");
    await waitFor(
      () => app.exists(`${tileSel(b)} [data-testid=agent-working]`),
      3000,
      "b working",
    );
    let groups = await panelGroups(app);
    assertEquals(groups.needs, [a]);
    assertEquals(groups.working, [b]);
    // b finishes while another tile is focused: to review.
    await app.focusChip(terminal);
    await waitForFooter(app, b);
    groups = await panelGroups(app);
    assertEquals(groups.review, [b]);
    // A click in the panel focuses it, which clears "to review".
    await app.click("[data-testid=bar-agents]");
    await app.click(`[data-testid=agents-item][data-id="${b}"]`);
    await waitFor(async () => (await app.focusedId()) === b, 3000, "b focused");
    await waitFor(
      async () =>
        (await app.attr(
          `${tileSel(b)} [data-testid=agent-dot]`,
          "data-group",
        )) ===
          "idle",
      3000,
      "b no longer to review",
    );
    groups = await panelGroups(app);
    assertEquals(groups.needs, [a]);
    assertEquals(groups.review, undefined);
  });

  test("model picker, rename, and the session back after the window comes back", async (app) => {
    const id = await openAgent(app);
    await app.click(`${tileSel(id)} [data-testid=agent-model]`);
    await app.click(`[data-testid=agent-models] [data-model=sonnet]`);
    await waitFor(
      async () =>
        (await app.eval(
          (s: string) => document.querySelector(s)?.textContent ?? "",
          `${tileSel(id)} [data-testid=agent-model]`,
        ))
          .startsWith("sonnet"),
      3000,
      "the model",
    );
    // Rename: its hub name and its chip.
    await app.click(`${tileSel(id)} [data-testid=agent-name]`);
    await app.eval((s: string) => {
      const el = document.querySelector<HTMLInputElement>(s)!;
      el.value = "builder";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, `${tileSel(id)} [data-testid=agent-name]`);
    await app.press("Enter");
    await waitFor(
      () =>
        app.eval((i: string) =>
          document.querySelector(
            `[data-testid=chip][data-id="${i}"] .chip-title`,
          )?.textContent === "builder", id),
      3000,
      "the chip renamed",
    );
    await prompt(app, id, "hello");
    assertEquals(await waitForFooter(app, id), "done");
    // The window closes and opens again: the tile attaches to its session, rows and all.
    await app.eval(() =>
      (globalThis as { __e2eRemount?: () => void }).__e2eRemount!()
    );
    await waitFor(
      () => app.exists(`${tileSel(id)} [data-testid=agent-footer]`),
      5000,
      "the transcript back",
    );
    assertEquals(
      await app.attr(`${tileSel(id)} [data-testid=agent-name]`, "value"),
      "builder",
    );
    await prompt(app, id, "hello again");
    assertEquals(await waitForFooter(app, id, 2), "done");
  });

  test("Open in terminal runs claude --resume in a terminal tile; closing ends the session", async (app) => {
    const id = await openAgent(app);
    await prompt(app, id, "hello");
    await waitForFooter(app, id);
    const before = (await app.tiles()).map((t) => t.id);
    await app.click(`${tileSel(id)} [data-testid=agent-menu]`);
    await app.click("[data-testid=agent-open-terminal]");
    const term = await waitFor(
      async () => {
        const now = (await app.tiles()).map((t) => t.id);
        return now.find((t) => !before.includes(t)) ?? null;
      },
      3000,
      "the terminal tile",
    );
    assert(!(await app.exists(`${tileSel(term)}[data-agent-tile=true]`)));
    // Closing the agent tile takes its hub tile (badge lookups and the panel) with it.
    await app.click(`${tileSel(id)} [data-testid=agent-menu]`);
    await app.click("[data-testid=agent-close]");
    await waitFor(
      async () => !(await app.exists(tileSel(id))),
      3000,
      "the agent tile gone",
    );
    assert(!(await app.exists("[data-testid=bar-agents]")));
  });
});
