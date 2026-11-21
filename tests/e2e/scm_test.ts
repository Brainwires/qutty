// The Source Control tile against the demo repository (lib/scm/demo.ts: README.md changed in two
// places, src/app.ts staged, notes.txt untracked): opening it from the `+` menu, staging a file
// and committing it (the history shows the commit), staging one hunk from the diff, ⌘↩ in the
// commit box (which commits and leaves the tile's size alone), and the confirmation before a
// discard.

import { assert, assertEquals } from "@std/assert";
import { type App, suite, waitFor } from "./harness.ts";

const TILE = "[data-testid=tile][data-scm-tile=true]";
const file = (group: string, path: string) =>
  `${TILE} [data-testid=scm-file][data-group="${group}"][data-path="${path}"]`;

/** Open Source Control from the `+` menu and wait for its changes. */
async function openScm(app: App): Promise<void> {
  await app.click("[data-testid=bar-new-menu]");
  await waitFor(
    () => app.exists("[data-testid=launch-source-control]"),
    3000,
    "the + menu's Source Control",
  );
  await app.click("[data-testid=launch-source-control]");
  await waitFor(
    () => app.exists(file("changes", "README.md")),
    5000,
    "the demo repository's changes",
  );
}

/** Click `selector` from the page (a row's hover-only button). */
function clickInPage(app: App, selector: string): Promise<void> {
  return app.eval((s: string) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) throw new Error(`no ${s}`);
    el.click();
  }, selector);
}

/** Type `text` into the commit box (as an input event, which the box listens to). */
function typeMessage(app: App, text: string): Promise<void> {
  return app.eval((t: string) => {
    const box = document.querySelector<HTMLTextAreaElement>(
      "[data-testid=tile][data-scm-tile=true] [data-testid=scm-message]",
    )!;
    box.focus();
    box.value = t;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

/** The history's commit subjects, newest first. */
function subjects(app: App): Promise<string[]> {
  return app.eval(() =>
    [...document.querySelectorAll(
      "[data-testid=tile][data-scm-tile=true] [data-testid=scm-commit] .scm-commit-subject",
    )].map((el) => el.textContent ?? "")
  );
}

suite("source control", (test) => {
  test("the + menu opens it on the repository, with its groups and history", async (app) => {
    await openScm(app);
    assertEquals(
      await app.eval(() =>
        document.querySelector(
          "[data-testid=tile][data-scm-tile=true] [data-testid=scm-repo]",
        )?.textContent
      ),
      "qutty-demo",
    );
    assert(await app.exists(file("staged", "src/app.ts")));
    assert(await app.exists(file("untracked", "notes.txt")));
    assertEquals(
      await app.attr(
        `${file("changes", "README.md")} [data-testid=scm-letter]`,
        "class",
      ),
      "scm-letter is-M",
    );
    assertEquals((await subjects(app))[0], "Merge branch 'feature/greet'");
    assert(
      (await app.attr(`${TILE} [data-testid=scm-branch]`, "aria-expanded")) ===
        "false",
    );
  });

  test("stage a file, commit it, see it in the history", async (app) => {
    await openScm(app);
    await clickInPage(
      app,
      `${file("changes", "README.md")} [data-testid=scm-file-stage]`,
    );
    await waitFor(
      () => app.exists(file("staged", "README.md")),
      3000,
      "README staged",
    );
    assert(!(await app.exists(file("changes", "README.md"))));
    await typeMessage(app, "Polish the README");
    await app.click(`${TILE} [data-testid=scm-commit]`);
    await waitFor(
      async () => (await subjects(app))[0] === "Polish the README",
      4000,
      "the commit in the history",
    );
    assert(!(await app.exists(file("staged", "README.md"))));
    assert(!(await app.exists(file("staged", "src/app.ts"))));
    // The untracked file is still there, and the message box is empty again.
    assert(await app.exists(file("untracked", "notes.txt")));
    assertEquals(
      await app.eval(() =>
        document.querySelector<HTMLTextAreaElement>(
          "[data-testid=tile][data-scm-tile=true] [data-testid=scm-message]",
        )?.value
      ),
      "",
    );
  });

  test("the diff stages one hunk; ⌘↩ in the commit box commits without maximizing", async (app) => {
    await openScm(app);
    await app.click(file("changes", "README.md"));
    await waitFor(
      async () => (await app.count(`${TILE} [data-testid=scm-hunk]`)) === 2,
      4000,
      "two hunks",
    );
    await app.click(
      `${TILE} [data-testid=scm-hunk] [data-testid=scm-hunk-stage]`,
    );
    await waitFor(
      () => app.exists(file("staged", "README.md")),
      3000,
      "a hunk staged",
    );
    assert(await app.exists(file("changes", "README.md")));
    await waitFor(
      async () => (await app.count(`${TILE} [data-testid=scm-hunk]`)) === 1,
      3000,
      "one hunk left",
    );
    // Side by side shows the same hunk in two columns.
    await app.click(`${TILE} [data-testid=scm-diff-split]`);
    assert(await app.exists(`${TILE} .scm-side-row`));

    const maximizedBefore = await app.attr(TILE, "data-maximized");
    await typeMessage(app, "First hunk only");
    await app.shortcut("Enter");
    await waitFor(
      async () => (await subjects(app))[0] === "First hunk only",
      4000,
      "the ⌘↩ commit",
    );
    assertEquals(await app.attr(TILE, "data-maximized"), maximizedBefore);
    // The other hunk is still a change.
    assert(await app.exists(file("changes", "README.md")));
  });

  test("discarding asks first; nothing staged offers to stage all and commit", async (app) => {
    await openScm(app);
    await clickInPage(
      app,
      `${file("untracked", "notes.txt")} [data-testid=scm-file-discard]`,
    );
    await waitFor(
      () => app.exists(`${TILE} [data-testid=scm-confirm]`),
      2000,
      "the question",
    );
    await app.click(`${TILE} [data-testid=scm-confirm-no]`);
    assert(await app.exists(file("untracked", "notes.txt")));
    // Unstage everything, then Commit: it offers to stage all first.
    await clickInPage(app, `${TILE} [data-testid=scm-group-unstage]`);
    await waitFor(
      async () =>
        !(await app.exists(
          `${TILE} [data-group=staged][data-testid=scm-group]`,
        )),
      3000,
      "nothing staged",
    );
    await typeMessage(app, "Everything");
    await app.click(`${TILE} [data-testid=scm-commit]`);
    await waitFor(
      () => app.exists(`${TILE} [data-testid=scm-confirm]`),
      2000,
      "the offer",
    );
    await app.click(`${TILE} [data-testid=scm-confirm-yes]`);
    await waitFor(
      async () => (await subjects(app))[0] === "Everything",
      4000,
      "the commit",
    );
    await waitFor(
      () => app.exists(`${TILE} [data-testid=scm-clean]`),
      3000,
      "a clean tree",
    );
  });
});
