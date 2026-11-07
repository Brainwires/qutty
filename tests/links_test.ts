// lib/links.ts: URL and path detection in terminal lines (trimming, false positives, the
// line/column forms), path resolution, file: URLs and the editor argv templating.

import { assertEquals } from "@std/assert";
import {
  DEFAULT_LINKS,
  EDITOR_PRESETS,
  editorArgv,
  editorChoice,
  editorTileArgs,
  fileUrlPath,
  findLinks,
  findPaths,
  findUrls,
  isOpenableUrl,
  resolvePath,
  sanitizeLinks,
  splitCommand,
  trimLinkEnd,
} from "../lib/links.ts";

Deno.test("findUrls: the schemes, trimmed, with their offsets", () => {
  const cases: [string, string[]][] = [
    ["see https://deno.com.", ["https://deno.com"]],
    ["(https://example.com/a)", ["https://example.com/a"]],
    ["[docs](https://example.com/x?y=1#z).", ["https://example.com/x?y=1#z"]],
    [
      "https://en.wikipedia.org/wiki/Foo_(bar), ok",
      ["https://en.wikipedia.org/wiki/Foo_(bar)"],
    ],
    ['"http://localhost:8000/"', ["http://localhost:8000/"]],
    ["<https://a.example/b>", ["https://a.example/b"]],
    ["mail mailto:joe@example.com!", ["mailto:joe@example.com"]],
    ["file:///etc/hosts and http://x.y/z", [
      "file:///etc/hosts",
      "http://x.y/z",
    ]],
    ["**https://bold.example**", ["https://bold.example"]],
    ["nothing here, 1.2.3 12:30", []],
    ["https:// alone", []],
    ["mailto:nobody", []],
    ["ftp://not.ours/x", []],
    ["javascript:alert(1)", []],
  ];
  for (const [line, want] of cases) {
    assertEquals(findUrls(line).map((u) => u.text), want, line);
  }
  const [u] = findUrls("go to https://x.y/z.");
  assertEquals([u.start, u.end], [6, 19]);
});

Deno.test("trimLinkEnd: punctuation and unbalanced closers, repeatedly", () => {
  assertEquals(trimLinkEnd("https://x.y/a)."), "https://x.y/a");
  assertEquals(trimLinkEnd("https://x.y/(a)"), "https://x.y/(a)");
  assertEquals(trimLinkEnd("https://x.y/a]}"), "https://x.y/a");
  assertEquals(trimLinkEnd("x?!;:,"), "x");
});

Deno.test("isOpenableUrl", () => {
  assertEquals(isOpenableUrl("https://deno.com"), true);
  assertEquals(isOpenableUrl("http://127.0.0.1:3000/x"), true);
  assertEquals(isOpenableUrl("file:///Users/x/a.txt"), true);
  assertEquals(isOpenableUrl("file:///"), false);
  assertEquals(isOpenableUrl("mailto:a@b.c?subject=hi"), true);
  assertEquals(isOpenableUrl("mailto:nope"), false);
  assertEquals(isOpenableUrl("vscode://file/x"), false);
  assertEquals(isOpenableUrl("javascript:alert(1)"), false);
  assertEquals(isOpenableUrl("not a url"), false);
});

type P = { path: string; line?: number; col?: number; text?: string };
const paths = (line: string): P[] =>
  findPaths(line).map((p) => ({
    path: p.path,
    ...(p.line !== undefined ? { line: p.line } : {}),
    ...(p.col !== undefined ? { col: p.col } : {}),
    ...(p.text !== p.path ? { text: p.text } : {}),
  }));

Deno.test("findPaths: the path shapes", () => {
  const cases: [string, P[]][] = [
    ["cat /etc/hosts", [{ path: "/etc/hosts" }]],
    ["ls ~/Source/qutty/", [{ path: "~/Source/qutty/" }]],
    ["open ./src/x.ts now", [{ path: "./src/x.ts" }]],
    ["../up/a.md", [{ path: "../up/a.md" }]],
    ["edit src/x.ts", [{ path: "src/x.ts" }]],
    ["README.md and main.rs", [{ path: "README.md" }, { path: "main.rs" }]],
    ["see lib/links.ts.", [{ path: "lib/links.ts" }]],
    ["cd ..", []],
    ["'/tmp/a b'", [{ path: "/tmp/a" }]],
    ["in (src/a.ts)", [{ path: "src/a.ts" }]],
    ["drwxr-xr-x  5 me staff", []],
  ];
  for (const [line, want] of cases) assertEquals(paths(line), want, line);
});

Deno.test("findPaths: false positives are not candidates", () => {
  for (
    const line of [
      "version 1.2.3",
      "at 12:30 today",
      "a 3/4 ratio, 16:9",
      "/",
      "~/",
      "./",
      "// comment",
      "and so on...",
      "words without paths",
      "v1.2.3",
      "--force",
      "0x1f.2",
    ]
  ) {
    assertEquals(paths(line), [], line);
  }
});

Deno.test("findPaths: line and column forms", () => {
  const cases: [string, P[]][] = [
    ["src/x.ts:42", [{ path: "src/x.ts", line: 42, text: "src/x.ts:42" }]],
    ["src/x.ts:42:7: error: nope", [{
      path: "src/x.ts",
      line: 42,
      col: 7,
      text: "src/x.ts:42:7",
    }]],
    ["file.ts(42,7): error TS2304", [{
      path: "file.ts",
      line: 42,
      col: 7,
      text: "file.ts(42,7)",
    }]],
    ["file.ts(42)", [{ path: "file.ts", line: 42, text: "file.ts(42)" }]],
    ["    at run (/Users/me/app/main.js:10:3)", [{
      path: "/Users/me/app/main.js",
      line: 10,
      col: 3,
      text: "/Users/me/app/main.js:10:3",
    }]],
    ['  File "/usr/lib/py/my mod.py", line 12, in f', [{
      path: "/usr/lib/py/my mod.py",
      line: 12,
    }]],
    ["/abs/a.c:5: warning", [{
      path: "/abs/a.c",
      line: 5,
      text: "/abs/a.c:5",
    }]],
  ];
  for (const [line, want] of cases) assertEquals(paths(line), want, line);
});

Deno.test("findLinks: a path inside a URL is not a separate link", () => {
  const links = findLinks("https://x.y/src/a.ts and src/b.ts");
  assertEquals(links.map((l) => [l.kind, l.text]), [
    ["url", "https://x.y/src/a.ts"],
    ["path", "src/b.ts"],
  ]);
  assertEquals(findLinks("file:///etc/hosts").length, 1);
});

Deno.test("resolvePath: home, absolute, relative to cwd, normalized", () => {
  const cases: [string, string | undefined, string | undefined][] = [
    ["~/a/b", "/x", "/Users/me/a/b"],
    ["~", "/x", "/Users/me"],
    ["/etc//hosts/", "/x", "/etc/hosts"],
    ["./src/../lib/a.ts", "/proj", "/proj/lib/a.ts"],
    ["src/a.ts", "/proj", "/proj/src/a.ts"],
    ["../a", "/proj/sub", "/proj/a"],
    ["src/a.ts", undefined, undefined],
    ["~bob/x", "/x", undefined],
    ["a\nb", "/x", undefined],
    ["", "/x", undefined],
    ["rel", "not-absolute", undefined],
  ];
  for (const [path, cwd, want] of cases) {
    assertEquals(resolvePath(path, cwd, "/Users/me"), want, path);
  }
  assertEquals(resolvePath("~/a", "/x", undefined), undefined);
});

Deno.test("fileUrlPath: decoded local paths only", () => {
  assertEquals(fileUrlPath("file:///Users/x/a%20b.txt"), "/Users/x/a b.txt");
  assertEquals(fileUrlPath("file://host.local/etc/hosts"), "/etc/hosts");
  assertEquals(fileUrlPath("https://x.y/a"), undefined);
  assertEquals(fileUrlPath("file:///a%00b"), undefined);
  assertEquals(fileUrlPath("::"), undefined);
});

Deno.test("splitCommand: words and quotes, no expansion", () => {
  assertEquals(splitCommand("code -g {file}"), ["code", "-g", "{file}"]);
  assertEquals(splitCommand(`"/Apps/My Ed" '$HOME' x`), [
    "/Apps/My Ed",
    "$HOME",
    "x",
  ]);
  assertEquals(splitCommand('a "" b'), ["a", "", "b"]);
  assertEquals(splitCommand('code "unbalanced'), undefined);
  assertEquals(splitCommand("   "), undefined);
});

Deno.test("editorArgv: the presets' forms", () => {
  const t = { file: "/p/src/x.ts", line: 42, col: 7 };
  const cases: [
    string,
    typeof t | { file: string; line?: number },
    string[],
  ][] = [
    ["code -g {file}:{line}:{col}", t, ["code", "-g", "/p/src/x.ts:42:7"]],
    ["code -g {file}:{line}:{col}", { file: "/p/a.ts", line: 3 }, [
      "code",
      "-g",
      "/p/a.ts:3",
    ]],
    ["code -g {file}:{line}:{col}", { file: "/p/a.ts" }, [
      "code",
      "-g",
      "/p/a.ts",
    ]],
    ["zed {file}:{line}", t, ["zed", "/p/src/x.ts:42"]],
    ["idea --line {line} --column {col} {file}", { file: "/p/a" }, [
      "idea",
      "--line",
      "1",
      "--column",
      "1",
      "/p/a",
    ]],
    ["subl", t, ["subl", "/p/src/x.ts"]],
    ['"/Applications/My Editor/bin/ed" +{line} {file}', t, [
      "/Applications/My Editor/bin/ed",
      "+42",
      "/p/src/x.ts",
    ]],
  ];
  for (const [template, target, want] of cases) {
    assertEquals(editorArgv(template, target), want, template);
  }
  for (const p of EDITOR_PRESETS) {
    const argv = editorArgv(p.template, t);
    assertEquals(argv?.[0], p.program, p.id);
    assertEquals(argv!.some((a) => a.includes("/p/src/x.ts")), true, p.id);
  }
});

Deno.test("editorArgv: a hostile file name stays one argument; bad input is refused", () => {
  const file = `/tmp/a b; rm -rf ~ $(touch x) \`id\` "q" 'q' {line}`;
  const argv = editorArgv("code -g {file}:{line}", { file, line: 2 });
  assertEquals(argv, ["code", "-g", `${file}:2`]);
  // Not absolute: could look like an option.
  assertEquals(editorArgv("code {file}", { file: "-rf" }), undefined);
  assertEquals(editorArgv("code {file}", { file: "rel/x" }), undefined);
  assertEquals(editorArgv("code {file}", { file: "/a\nb" }), undefined);
  // A placeholder in the program word, an empty or unbalanced template, a newline, too long.
  assertEquals(editorArgv("{file} x", { file: "/a" }), undefined);
  assertEquals(editorArgv("", { file: "/a" }), undefined);
  assertEquals(editorArgv('code "x', { file: "/a" }), undefined);
  assertEquals(editorArgv("code\nrm", { file: "/a" }), undefined);
  assertEquals(
    editorArgv(`code ${"x".repeat(400)}`, { file: "/a" }),
    undefined,
  );
  // Junk line numbers are dropped, not passed through.
  assertEquals(
    editorArgv("zed {file}:{line}:{col}", { file: "/a", line: -1, col: 3 }),
    ["zed", "/a"],
  );
});

Deno.test("editorTileArgs: a fixed script, the file only as an argument", () => {
  const file = "/tmp/$(id) `x`.txt";
  const args = editorTileArgs(file, 9);
  assertEquals(args[0], "-c");
  assertEquals(args.slice(2), ["qutty-edit", "+9", file]);
  assertEquals(args[1].includes(file), false);
  assertEquals(editorTileArgs("/a").slice(2), ["qutty-edit", "/a"]);
});

Deno.test("sanitizeLinks and editorChoice", () => {
  assertEquals(sanitizeLinks({ editor: "zed", command: "x\ny" }), {
    editor: "zed",
    command: "xy",
  });
  assertEquals(sanitizeLinks({ editor: "rm -rf", command: 3 }), DEFAULT_LINKS);
  assertEquals(sanitizeLinks(null), DEFAULT_LINKS);
  const s = (editor: string, command = "") => ({ editor, command });
  assertEquals(editorChoice(s("auto"), ["zed", "code"]), {
    kind: "command",
    command: "code -g {file}:{line}:{col}",
  });
  assertEquals(editorChoice(s("auto"), []), { kind: "default" });
  assertEquals(editorChoice(s("zed"), []), {
    kind: "command",
    command: "zed {file}:{line}:{col}",
  });
  assertEquals(editorChoice(s("tile"), []), { kind: "tile" });
  assertEquals(editorChoice(s("custom", "  hx {file}:{line} "), []), {
    kind: "command",
    command: "hx {file}:{line}",
  });
  assertEquals(editorChoice(s("custom"), []), { kind: "default" });
  assertEquals(editorChoice(s("default"), ["code"]), { kind: "default" });
});
