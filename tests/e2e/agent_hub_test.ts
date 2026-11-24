// The agent hub's page side against the demo backend's fake hub (lib/hub-demo.ts): the agent
// badge on a tile launched from the `+` picker (name, busy → idle, unread messages from `/msg`),
// `ask_user` questions answered from the card while the companion is Off (the demo agent prints
// the answer it got) and queued, and Settings → Agent integration showing what Install changes
// and toggling it; the app icon's badge of waiting agents (`window.__e2e.badges`).

import { assert, assertEquals, assertMatch } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";
import { tileSel } from "./ssh_helpers.ts";
import { launchAgent } from "./agent_helpers.ts";

const ASK = "[data-testid=ask-dialog]";
const badgeSel = (id: string) =>
  `${tileSel(id)} [data-testid=tile-agent-badge]`;
const rowSel = (target: string) =>
  `[data-testid=integration-row][data-target="${target}"]`;

/** Tile `id`'s agent badge: name, status and unread count (`null`: no badge). */
function badge(app: App, id: string) {
  return app.eval((s: string) => {
    const el = document.querySelector<HTMLElement>(s);
    return el && {
      name: el.querySelector(".tile-agent-name")?.textContent ?? "",
      status: el.dataset.status ?? "",
      unread: el.dataset.unread ?? "",
      count: el.querySelector("[data-testid=tile-agent-unread]")
        ?.textContent ?? null,
    };
  }, badgeSel(id));
}

/** Wait until tile `id`'s badge has `attr` = `value`. */
function waitBadge(app: App, id: string, attr: string, value: string) {
  return waitFor(
    async () => (await app.attr(badgeSel(id), attr)) === value,
    5000,
    `${id}'s badge ${attr}=${value}`,
  );
}

/** The last app icon badge count the page set (`window.__e2e.badges`; `null`: none yet). */
function lastAppBadge(app: App) {
  return app.eval(() => {
    const badges = (globalThis as { __e2e?: { badges?: number[] } }).__e2e
      ?.badges;
    return badges && badges.length > 0 ? badges[badges.length - 1] : null;
  });
}

/** The question on the card (`null`: no card). */
function askShown(app: App) {
  return app.eval((s: string) => {
    const el = document.querySelector(s);
    return el && {
      from: el.querySelector("[data-testid=ask-from]")?.textContent ?? "",
      text: el.querySelector("[data-testid=ask-text]")?.textContent ?? "",
      actions: [...el.querySelectorAll<HTMLElement>("[data-testid=ask-action]")]
        .map((b) => b.dataset.action),
      more: el.querySelector("[data-testid=ask-more]")?.textContent ?? null,
    };
  }, ASK);
}

suite("agent hub", (test) => {
  test("badges: an agent from the + picker shows its name, busy → idle and unread messages", async (app) => {
    const shell = (await app.focusedId())!;
    const claude = await launchAgent(app, "claude");
    await waitBadge(app, claude, "data-status", "idle");
    assertEquals(await badge(app, claude), {
      name: "claude",
      status: "idle",
      unread: "0",
      count: null,
    });
    assertEquals(await badge(app, shell), null, "a shell has no badge");
    // The session id its SessionStart hook sent, in the badge's tooltip.
    assertMatch(
      (await app.attr(badgeSel(claude), "data-session")) ?? "",
      /^demo-session-demo-\d+$/,
    );
    assert(
      (await app.attr(badgeSel(claude), "title"))?.includes("session demo-ses"),
    );

    await app.typeInTerminal(claude, "hello\n");
    await waitBadge(app, claude, "data-status", "busy");
    await waitBadge(app, claude, "data-status", "idle");

    // A second agent; a message for it counts until it takes its next turn.
    const codex = await launchAgent(app, "codex");
    await waitBadge(app, codex, "data-status", "idle");
    assertEquals((await badge(app, codex))?.name, "codex");
    await app.typeInTerminal(claude, "/msg codex please review\n");
    await app.waitForText(claude, "queued for codex");
    await waitBadge(app, codex, "data-unread", "1");
    assertEquals((await badge(app, codex))?.count, "1");
    await app.typeInTerminal(codex, "on it\n");
    await app.waitForText(codex, "✉ claude: please review");
    await waitBadge(app, codex, "data-unread", "0");
    assertEquals((await badge(app, codex))?.count, null);

    // Another Claude Code gets the next free name.
    const claude2 = await launchAgent(app, "claude");
    await waitBadge(app, claude2, "data-status", "idle");
    assertEquals((await badge(app, claude2))?.name, "claude-2");
  });

  test("ask_user (companion Off): the card's buttons answer the waiting agent; questions queue; dismiss", async (app) => {
    // With the companion shown, questions go to the companion's bubble (companion_test.ts); Off,
    // the card.
    await app.openSettings("companion");
    await app.click('[data-testid=setting-companion-mode][data-value="off"]');
    await app.closeSettings();
    const claude = await launchAgent(app, "claude");
    assertEquals(await app.exists(ASK), false);
    await app.typeInTerminal(claude, "/ask Deploy now?\n");
    await waitFor(() => app.exists(ASK), 3000, "the question");
    assertEquals(await askShown(app), {
      from: "claude",
      text: "Deploy now?",
      actions: ["Yes", "No"],
      more: null,
    });
    await waitBadge(app, claude, "data-status", "waiting");
    // The card does not take the keyboard from the terminal.
    assert(await app.xtermHasFocus(claude), "the terminal keeps focus");

    await app.click('[data-testid=ask-action][data-action="Yes"]');
    await waitFor(async () => !(await app.exists(ASK)), 2000, "card closed");
    await app.waitForText(claude, "(demo) the user answered: Yes");
    await waitBadge(app, claude, "data-status", "idle");
    await waitFor(() => app.xtermHasFocus(claude), 2000, "keyboard back");

    // Two questions from two agents: the oldest first, with a count of the rest.
    const codex = await launchAgent(app, "codex");
    await app.typeInTerminal(claude, "/ask First?\n");
    await waitFor(() => app.exists(ASK), 3000, "the first question");
    await app.typeInTerminal(codex, "/ask Second?\n");
    await waitFor(
      async () => (await askShown(app))?.more === "+1 more",
      3000,
      "the second queued",
    );
    assertEquals((await askShown(app))?.text, "First?");
    await app.click("[data-testid=ask-dismiss]");
    await app.waitForText(claude, "the user answered: nothing (dismissed)");
    await waitFor(
      async () => (await askShown(app))?.text === "Second?",
      2000,
      "the next question",
    );
    assertEquals((await askShown(app))?.from, "codex");
    assertEquals((await askShown(app))?.more, null);
    await app.click('[data-testid=ask-action][data-action="No"]');
    await app.waitForText(codex, "the user answered: No");
    await waitFor(async () => !(await app.exists(ASK)), 2000, "all answered");

    // A question whose agent quits closes by itself.
    await app.typeInTerminal(codex, "/ask Still there?\n");
    await waitFor(() => app.exists(ASK), 3000, "the question");
    await app.typeInTerminal(codex, "/exit\n");
    await waitFor(async () => !(await app.exists(ASK)), 3000, "closed");
  });

  test("app badge: counts the agents waiting for the user and unseen finished turns; Settings → Agents turns it off", async (app) => {
    await app.openSettings("companion");
    await app.click('[data-testid=setting-companion-mode][data-value="off"]');
    await app.closeSettings();
    const badgeIs = (n: number) =>
      waitFor(
        async () => (await lastAppBadge(app)) === n,
        3000,
        `app badge ${n}`,
      );
    const claude = await launchAgent(app, "claude");
    const codex = await launchAgent(app, "codex");
    await badgeIs(0);
    // Two agents wait (their badges say `waiting`): the app icon counts both.
    await app.typeInTerminal(claude, "/ask First?\n");
    await waitBadge(app, claude, "data-status", "waiting");
    await badgeIs(1);
    await app.typeInTerminal(codex, "/ask Second?\n");
    await waitBadge(app, codex, "data-status", "waiting");
    await badgeIs(2);
    await app.click('[data-testid=ask-action][data-action="Yes"]');
    await waitBadge(app, claude, "data-status", "idle");
    await badgeIs(1);

    // Off: no badge, though codex still waits; on again: back.
    await app.openSettings("agents");
    assertEquals(
      await app.eval(
        (s: string) => document.querySelector<HTMLInputElement>(s)?.checked,
        "[data-testid=setting-dock-badge]",
      ),
      true,
    );
    await app.click("[data-testid=setting-dock-badge]");
    await badgeIs(0);
    await app.click("[data-testid=setting-dock-badge]");
    await badgeIs(1);
    await app.closeSettings();

    await app.click('[data-testid=ask-action][data-action="No"]');
    await waitBadge(app, codex, "data-status", "idle");
    await badgeIs(0);

    // A finished turn in a tile the user is not looking at counts until it gets the focus.
    await app.typeInTerminal(claude, "hello\n");
    await waitBadge(app, claude, "data-status", "busy");
    await app.focusChip(codex);
    await waitBadge(app, claude, "data-status", "idle");
    await badgeIs(1);
    await app.focusChip(claude);
    await badgeIs(0);
    // One that finishes in the focused tile is seen at once.
    await app.typeInTerminal(claude, "again\n");
    await waitBadge(app, claude, "data-status", "busy");
    await waitBadge(app, claude, "data-status", "idle");
    await badgeIs(0);
  });

  test("integration: under Settings → Agents; shows what Install changes; Install / Uninstall toggle", async (app) => {
    await app.openSettings("agents");
    assert(
      await app.exists(
        "[data-testid=integration-section] [data-testid=integration-panel]",
      ),
    );
    await waitFor(() => app.exists(rowSel("codex")), 3000, "the rows");
    const rows = await app.eval(() =>
      [...document.querySelectorAll<HTMLElement>(
        "[data-testid=integration-row]",
      )].map((r) => ({
        target: r.dataset.target,
        installed: r.dataset.installed,
        paths: [...r.querySelectorAll(".integration-path")].map((p) =>
          p.textContent
        ),
        adds: [...r.querySelectorAll("pre")].map((p) => p.textContent ?? ""),
      }))
    );
    assertEquals(rows.map((r) => [r.target, r.installed, r.paths]), [
      ["claude", "false", ["~/.claude.json", "~/.claude/settings.json"]],
      ["codex", "false", ["~/.codex/config.toml"]],
      ["hermes", "false", ["~/.hermes/config.yaml"]],
      ["zsh", "false", ["~/.zshrc"]],
      ["bash", "false", ["~/.bashrc"]],
    ]);
    assert(rows[3].adds[0].includes("qutty.zsh"), rows[3].adds[0]);
    assert(rows[0].adds[0].includes('"qutty"'), rows[0].adds[0]);
    assert(rows[1].adds[0].includes("[mcp_servers.qutty]"), rows[1].adds[0]);
    const hint = await app.eval(() =>
      document.querySelector("[data-testid=integration-panel]")?.textContent ??
        ""
    );
    assert(hint.includes(".qutty-backup"), hint);

    await app.click(`${rowSel("codex")} [data-testid=integration-install]`);
    await waitFor(
      async () =>
        (await app.attr(rowSel("codex"), "data-installed")) === "true",
      3000,
      "codex installed",
    );
    assertEquals(await app.attr(rowSel("claude"), "data-installed"), "false");
    assert(
      await app.exists(
        `${rowSel("codex")} [data-testid=integration-uninstall]`,
      ),
    );
    await app.click(`${rowSel("codex")} [data-testid=integration-uninstall]`);
    await waitFor(
      async () =>
        (await app.attr(rowSel("codex"), "data-installed")) === "false",
      3000,
      "codex uninstalled",
    );
    assert(
      await app.exists(`${rowSel("codex")} [data-testid=integration-install]`),
    );
    assertEquals(await app.exists("[data-testid=integration-error]"), false);

    // The shell agent's rc opt-in toggles the same way.
    await app.click(`${rowSel("zsh")} [data-testid=integration-install]`);
    await waitFor(
      async () => (await app.attr(rowSel("zsh"), "data-installed")) === "true",
      3000,
      "zsh installed",
    );
    await app.click(`${rowSel("zsh")} [data-testid=integration-uninstall]`);
    await waitFor(
      async () => (await app.attr(rowSel("zsh"), "data-installed")) === "false",
      3000,
      "zsh uninstalled",
    );
    assertEquals(await app.exists("[data-testid=integration-error]"), false);
  });
});
