// User skins, the desktop side (desktop/skins.ts): the skins folder listed and each skin checked,
// one skin read with its assets inlined, nothing read from outside a skin's folder, and the
// template copy written. Every folder here is a temp folder (the fixtures are copied into one):
// nothing is read from or written to the user's own skins folder.

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { copy } from "@std/fs";
import { join } from "@std/path";
import { skinsDir, SkinStore } from "../desktop/skins.ts";
import { checkSkin, MAX_ASSET_BYTES } from "../lib/skins/skin.ts";
import type { CommandRunner } from "../desktop/ollama.ts";

const FIXTURES = join(import.meta.dirname!, "fixtures/skins");

/** A temp skins folder holding the fixtures, removed afterwards. */
async function withStore(
  fn: (store: SkinStore, dir: string, root: string) => Promise<void> | void,
  runner?: CommandRunner,
): Promise<void> {
  // The real path: macOS's temp folder is behind a symlink, and a skin's files are checked to
  // be inside its folder by their real paths.
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "qutty-skins-" }),
  );
  const dir = join(root, "skins");
  try {
    await copy(FIXTURES, dir);
    await fn(
      new SkinStore({ dir, os: "darwin", ...(runner ? { runner } : {}) }),
      dir,
      root,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function addSkin(
  dir: string,
  folder: string,
  manifest: unknown,
  css?: string,
): Promise<string> {
  const path = join(dir, folder);
  await Deno.mkdir(path, { recursive: true });
  await Deno.writeTextFile(
    join(path, "skin.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  if (css !== undefined) await Deno.writeTextFile(join(path, "skin.css"), css);
  return path;
}

Deno.test("skins folder: where it is", () => {
  assertEquals(
    skinsDir(
      "/Users/x/Library/Application Support/org.qutty.Qutty",
      "/Users/x",
    ),
    "/Users/x/Library/Application Support/org.qutty.Qutty/skins",
  );
  assertEquals(skinsDir(undefined, "/home/x"), "/home/x/.qutty/skins");
  assertEquals(skinsDir("", "/home/x"), "/home/x/.qutty/skins");
  assertEquals(skinsDir(undefined, undefined), undefined);
  assertEquals(skinsDir(undefined, "relative"), undefined);
});

Deno.test("skins folder: the fixtures list as one skin and one problem", async () => {
  await withStore((store, dir) => {
    const list = store.list();
    assertEquals(list.dir, dir);
    assertEquals(list.skins.map((m) => m.id), ["neon"]);
    assertEquals(list.skins[0].frame, {
      buttons: "left",
      title: "center",
      buttonOrder: ["close", "maximize", "minimize"],
    });
    assertEquals(list.problems.length, 1);
    assertEquals(list.problems[0].folder, "remote-url");
    assertStringIncludes(list.problems[0].error, "skin.css line 3");
    assertStringIncludes(list.problems[0].error, "is not allowed");
  });
});

Deno.test("skins folder: a skin is read with its assets inlined, and passes the page's check", async () => {
  await withStore((store) => {
    const skin = store.get("neon");
    assertEquals(skin.source, "user");
    assertEquals(skin.manifest.name, "Neon");
    assertEquals(skin.manifest.theme?.tokens["--accent"], "#39ff14");
    // The relative url() is a data: URL now; no path is left for the page to fetch.
    assertStringIncludes(skin.css, 'url("data:image/png;base64,iVBORw0KGgo');
    assertFalse(skin.css.includes("assets/dot.png"));
    assertStringIncludes(skin.css, "@keyframes neon-pulse");
    const checked = checkSkin(skin);
    assert(checked.ok, checked.ok ? "" : checked.error);
    assertEquals(checked.value.css, skin.css);
    // A skin that is refused, and one that is not there.
    assertThrows(() => store.get("remote-url"), Error, "is not allowed");
    assertThrows(() => store.get("nope"), Error, "no skin");
    assertThrows(() => store.get("../neon"), Error, "no skin");
  });
});

Deno.test("skins folder: every way a folder is not a skin", async () => {
  await withStore(async (store, dir, root) => {
    await Deno.remove(join(dir, "neon"), { recursive: true });
    await Deno.remove(join(dir, "remote-url"), { recursive: true });
    await Deno.mkdir(join(dir, "empty"));
    await Deno.mkdir(join(dir, ".hidden"));
    await Deno.writeTextFile(join(dir, "a-file"), "not a folder");
    await addSkin(dir, "Bad Name", { id: "bad", name: "x" });
    await addSkin(dir, "classic", { id: "classic", name: "Mine" });
    await addSkin(dir, "qutty", { id: "qutty", name: "Mine" });
    await addSkin(dir, "bad-json", "{nope");
    await addSkin(dir, "wrong-id", { id: "other", name: "x" });
    await addSkin(dir, "imports", { id: "imports", name: "x" }, "@import 'a';");
    await addSkin(
      dir,
      "escapes",
      { id: "escapes", name: "x" },
      "a { background: url(../colours/a.png); }",
    );
    await addSkin(
      dir,
      "missing",
      { id: "missing", name: "x" },
      "a { background: url(gone.png); }",
    );
    await addSkin(
      dir,
      "big-json",
      JSON.stringify({ id: "big-json", name: "x", pad: "x".repeat(40_000) }),
    );
    await addSkin(
      dir,
      "big-css",
      { id: "big-css", name: "x" },
      "a { color: red; }\n".repeat(20_000),
    );
    // An asset over the cap.
    const big = await addSkin(
      dir,
      "big-asset",
      { id: "big-asset", name: "x" },
      "a { background: url(huge.png); }",
    );
    await Deno.writeFile(
      join(big, "huge.png"),
      new Uint8Array(MAX_ASSET_BYTES + 1),
    );
    // A symlink that leads out of the skin's folder: a file elsewhere must never be inlined.
    await Deno.writeTextFile(join(root, "secret.png"), "secret");
    const link = await addSkin(
      dir,
      "symlink",
      { id: "symlink", name: "x" },
      "a { background: url(leak.png); }",
    );
    await Deno.symlink(join(root, "secret.png"), join(link, "leak.png"));
    // Colours and frame options only: no stylesheet at all is fine.
    await addSkin(dir, "colours", {
      id: "colours",
      name: "Colours",
      theme: "ember",
      frame: { title: "right" },
    });

    const list = store.list();
    assertEquals(list.skins.map((m) => m.id), ["colours"]);
    assertEquals(store.get("colours").css, "");
    const why = Object.fromEntries(
      list.problems.map((p) => [p.folder, p.error]),
    );
    assertEquals(Object.keys(why).sort(), [
      "Bad Name",
      "bad-json",
      "big-asset",
      "big-css",
      "big-json",
      "classic",
      "empty",
      "escapes",
      "imports",
      "missing",
      "qutty",
      "symlink",
      "wrong-id",
    ]);
    assertStringIncludes(why["Bad Name"], "folder's name must be");
    assertStringIncludes(why["classic"], "built-in");
    assertStringIncludes(why["qutty"], "built-in");
    assertStringIncludes(why["empty"], "no skin.json");
    assertStringIncludes(why["bad-json"], "not valid JSON");
    assertStringIncludes(why["wrong-id"], "folder's name");
    assertStringIncludes(why["imports"], "@import is not allowed");
    assertStringIncludes(why["escapes"], "is not allowed");
    assertStringIncludes(why["missing"], "was not found");
    assertStringIncludes(why["big-json"], "skin.json is larger than");
    assertStringIncludes(why["big-css"], "skin.css is larger than");
    assertStringIncludes(why["big-asset"], "larger than");
    assertStringIncludes(why["symlink"], "outside the skin folder");
  });
});

Deno.test("skins folder: missing altogether lists nothing", () => {
  const store = new SkinStore({ dir: "/nonexistent/qutty-skins", os: "linux" });
  assertEquals(store.list(), {
    dir: "/nonexistent/qutty-skins",
    skins: [],
    problems: [],
  });
  assertThrows(() => store.get("neon"), Error, "no skin");
});

Deno.test("skins folder: Start from Classic writes a checked copy under a free id", async () => {
  await withStore(async (store, dir, root) => {
    const req = {
      id: "my-classic",
      name: "My Classic",
      from: "classic",
      manifest: await Deno.readTextFile(
        join(import.meta.dirname!, "../public/skins/classic/skin.json"),
      ),
      css: await Deno.readTextFile(
        join(import.meta.dirname!, "../public/skins/classic/skin.css"),
      ),
    };
    const first = store.template(req);
    assertEquals(first, { id: "my-classic", dir: join(dir, "my-classic") });
    assertEquals(
      [...Deno.readDirSync(first.dir)].map((e) => e.name).sort(),
      ["skin.css", "skin.json"],
    );
    // The copy is a usable skin, its selectors pointed at its own id, comments kept for editing.
    const skin = store.get("my-classic");
    assertEquals(skin.manifest.name, "My Classic");
    assertStringIncludes(skin.css, ':root[data-skin="my-classic"]');
    assertFalse(skin.css.includes('data-skin="classic"'));
    assertStringIncludes(
      await Deno.readTextFile(join(first.dir, "skin.css")),
      "/* Classic:",
    );
    // Again: the next free id.
    assertEquals(store.template(req).id, "my-classic-2");
    assertEquals(
      store.list().skins.map((m) => m.id),
      ["my-classic", "my-classic-2", "neon"],
    );
    // Nothing is written for a package that is not a skin.
    assertThrows(
      () =>
        store.template({ ...req, id: "evil", css: "@import url(//x/a.css);" }),
      Error,
      "@import",
    );
    assertThrows(() => store.template({ ...req, id: "../up" }), Error);
    assertFalse([...Deno.readDirSync(dir)].some((e) => e.name === "evil"));
    assertEquals(
      [...Deno.readDirSync(root)].map((e) => e.name).sort(),
      ["skins"],
    );
  });
});

Deno.test("skins folder: made on demand, and opened through the runner", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "qutty-skins-" }),
  );
  try {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: (program, args) => {
        calls.push([program, ...args]);
        return Promise.resolve({ code: 0, out: "" });
      },
    };
    const dir = join(root, "support", "skins");
    const store = new SkinStore({ dir, os: "darwin", runner });
    await store.openFolder();
    assert((await Deno.stat(dir)).isDirectory);
    assertEquals(calls, [["/usr/bin/open", dir]]);
    // No runner (nothing to open folders with): it says so.
    let failed = "";
    await new SkinStore({ dir, os: "darwin" }).openFolder().catch((e) =>
      failed = e.message
    );
    assertStringIncludes(failed, "cannot open");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
