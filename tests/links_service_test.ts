// desktop/links.ts: resolving candidate paths, what `open` runs (URL, file, reveal, a runnable
// file revealed instead), the editor lookup and the editor argv, with a fake runner, `stat` and
// program lookup: nothing is launched.

import { assertEquals, assertRejects } from "@std/assert";
import { LinkService, openCommand, runsOnOpen } from "../desktop/links.ts";

const FILES: Record<string, { dir?: boolean; mode?: number }> = {
  "/Users/me/proj": { dir: true },
  "/Users/me/proj/src/a.ts": {},
  "/Users/me/notes.md": {},
  "/Users/me/bin/tool": { mode: 0o755 },
  "/Users/me/run.command": {},
  "/Applications/X.app": { dir: true },
};

function service(os: "darwin" | "linux" = "darwin", failing = "") {
  const runs: string[][] = [];
  const svc = new LinkService({
    os,
    home: "/Users/me",
    runner: {
      run: (program, args) => {
        runs.push([program, ...args]);
        return Promise.resolve(
          program.endsWith(failing) && failing
            ? {
              code: 1,
              out: "Error org.freedesktop.DBus.Error.ServiceUnknown",
            }
            : { code: 0, out: "" },
        );
      },
    },
    stat: (path) => {
      const f = FILES[path];
      return Promise.resolve(
        f
          ? { isFile: !f.dir, isDirectory: !!f.dir, mode: f.mode ?? 0o644 }
          : null,
      );
    },
    find: (name) =>
      Promise.resolve(
        name.startsWith("/")
          ? name
          : ["code", "zed", "xdg-open", "dbus-send"].includes(name)
          ? `/usr/local/bin/${name}`
          : undefined,
      ),
  });
  return { svc, runs };
}

Deno.test("links service: resolve against cwd and home; missing is null", async () => {
  const { svc } = service();
  assertEquals(
    await svc.resolve("/Users/me/proj", [
      "src/a.ts",
      "./src/../src/a.ts",
      "~/notes.md",
      "/Users/me/proj/",
      "nope.ts",
      "~bob/x",
    ]),
    [
      { path: "/Users/me/proj/src/a.ts", kind: "file" },
      { path: "/Users/me/proj/src/a.ts", kind: "file" },
      { path: "/Users/me/notes.md", kind: "file" },
      { path: "/Users/me/proj", kind: "dir" },
      null,
      null,
    ],
  );
  // No cwd: relative paths cannot be known.
  assertEquals(await svc.resolve(undefined, ["src/a.ts"]), [null]);
});

Deno.test("links service: open runs the platform opener with one argument", async () => {
  const { svc, runs } = service();
  await svc.open({ kind: "url", url: "https://deno.com/a b" });
  await svc.open({ kind: "open", path: "/Users/me/notes.md" });
  await svc.open({ kind: "reveal", path: "/Users/me/notes.md" });
  // A folder, an app bundle, an executable and a .command are revealed, never opened.
  await svc.open({ kind: "open", path: "/Users/me/proj" });
  await svc.open({ kind: "open", path: "/Applications/X.app" });
  await svc.open({ kind: "open", path: "/Users/me/bin/tool" });
  await svc.open({ kind: "open", path: "/Users/me/run.command" });
  assertEquals(runs, [
    ["/usr/bin/open", "https://deno.com/a%20b"],
    ["/usr/bin/open", "/Users/me/notes.md"],
    ["/usr/bin/open", "-R", "/Users/me/notes.md"],
    ["/usr/bin/open", "-R", "/Users/me/proj"],
    ["/usr/bin/open", "-R", "/Applications/X.app"],
    ["/usr/bin/open", "-R", "/Users/me/bin/tool"],
    ["/usr/bin/open", "-R", "/Users/me/run.command"],
  ]);
});

Deno.test("links service: open refuses what it should not touch", async () => {
  const { svc, runs } = service();
  await assertRejects(() => svc.open({ kind: "url", url: "javascript:x" }));
  await assertRejects(() => svc.open({ kind: "url", url: "vscode://x" }));
  await assertRejects(() => svc.open({ kind: "open", path: "notes.md" }));
  await assertRejects(() => svc.open({ kind: "open", path: "-R" }));
  await assertRejects(() => svc.open({ kind: "open", path: "/nope" }));
  assertEquals(runs, []);
});

Deno.test("links service: Linux openers", async () => {
  const { svc, runs } = service("linux");
  await svc.open({ kind: "url", url: "mailto:a@b.c" });
  await svc.open({ kind: "reveal", path: "/Users/me/proj" });
  assertEquals(runs[0], ["/usr/local/bin/xdg-open", "mailto:a@b.c"]);
  assertEquals(runs[1][0], "/usr/local/bin/dbus-send");
  assertEquals(
    runs[1].at(-2),
    "array:string:file:///Users/me/proj",
  );
  assertEquals(
    openCommand("linux", "reveal", "/a,b c").at(-2),
    "array:string:file:///a%2Cb%20c",
  );
});

Deno.test("links service: Linux reveal without a file manager service opens the folder", async () => {
  const { svc, runs } = service("linux", "dbus-send");
  await svc.open({ kind: "reveal", path: "/Users/me/notes.md" });
  assertEquals(runs.map((r) => r[0]), [
    "/usr/local/bin/dbus-send",
    "/usr/local/bin/xdg-open",
  ]);
  assertEquals(runs[1], ["/usr/local/bin/xdg-open", "/Users/me"]);
  // macOS has no fallback: the failure is reported.
  const mac = service("darwin", "open");
  await assertRejects(() =>
    mac.svc.open({ kind: "reveal", path: "/Users/me/notes.md" })
  );
});

Deno.test("links service: editors installed, and the editor argv", async () => {
  const { svc, runs } = service();
  assertEquals(await svc.editors(), ["code", "zed"]);
  assertEquals(
    await svc.editArgv({
      command: "code -g {file}:{line}:{col}",
      file: "/Users/me/proj/src/a.ts",
      line: 4,
      col: 2,
    }),
    ["/usr/local/bin/code", "-g", "/Users/me/proj/src/a.ts:4:2"],
  );
  await svc.edit({ command: "zed {file}:{line}", file: "/Users/me/notes.md" });
  assertEquals(runs, [["/usr/local/bin/zed", "/Users/me/notes.md"]]);
  await assertRejects(() =>
    svc.edit({ command: "subl {file}", file: "/Users/me/notes.md" })
  );
  await assertRejects(() =>
    svc.edit({ command: "code {file}", file: "/Users/me/proj" })
  );
  await assertRejects(() =>
    svc.edit({ command: 'code "', file: "/Users/me/notes.md" })
  );
});

Deno.test("runsOnOpen: exec bits and launcher extensions", () => {
  assertEquals(runsOnOpen("/a/notes.md", 0o644), false);
  assertEquals(runsOnOpen("/a/tool", 0o755), true);
  assertEquals(runsOnOpen("/a/x.COMMAND", 0o644), true);
  assertEquals(runsOnOpen("/a/.sh", 0o644), false);
  assertEquals(runsOnOpen("/a/x.py", null), true);
});
