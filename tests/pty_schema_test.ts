// The pty extension's input schemas (what the desktop bridge runs before a handler), the declared
// events, and the handlers' behaviour before any terminal exists. No shell is started.
// Run: deno test -A tests/

import { assertEquals } from "@std/assert";
import ext from "../desktop/pty.ts";
import {
  assertExtensionShape,
  type Result,
  schemaTesters,
} from "./schema_helpers.ts";

const { v, ok, bad, rejectsNonObjects } = schemaTesters(ext);

const BAD_DIMS = [
  0,
  -1,
  10_001,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  "80",
  null,
  true,
  [80],
  {},
  2 ** 53,
];
const BAD_IDS = ["", 1, null, true, {}, [], "x".repeat(65)];

Deno.test("schema: declared events and methods", () => {
  assertExtensionShape(ext, {
    name: "pty",
    events: ["data", "exit"],
    methods: ["info", "keyBindings", "kill", "resize", "spawn", "write"],
  });
});

Deno.test("schema: every method rejects non-objects", rejectsNonObjects);

Deno.test("schema: spawn", () => {
  assertEquals(ok("spawn", { cols: 80, rows: 24 }), {
    cols: 80,
    rows: 24,
    cwd: undefined,
    shell: undefined,
    program: undefined,
  });
  assertEquals(
    ok("spawn", { cols: 1, rows: 10_000, cwd: "/tmp", shell: "/bin/zsh" }),
    {
      cols: 1,
      rows: 10_000,
      cwd: "/tmp",
      shell: "/bin/zsh",
      program: undefined,
    },
  );
  // Unknown keys are stripped, not passed to the handler.
  const stripped = ok("spawn", {
    cols: 80,
    rows: 24,
    env: { LD_PRELOAD: "x" },
    uid: 0,
  });
  assertEquals(Object.keys(stripped as object).sort(), [
    "cols",
    "cwd",
    "program",
    "rows",
    "shell",
  ]);
  for (const d of BAD_DIMS) {
    bad("spawn", { cols: d, rows: 24 }, ["cols"]);
    bad("spawn", { cols: 80, rows: d }, ["rows"]);
  }
  bad("spawn", {}, ["cols", "rows"]);
  bad("spawn", { cols: 0, rows: "x" }, ["cols", "rows"]);
  for (const s of ["", 1, null, true, {}, [], "x".repeat(4097)]) {
    bad("spawn", { cols: 80, rows: 24, cwd: s }, ["cwd"]);
    bad("spawn", { cols: 80, rows: 24, shell: s }, ["shell"]);
  }
  ok("spawn", { cols: 80, rows: 24, cwd: "x".repeat(4096) });
  bad("spawn", { cols: 0, rows: 0, cwd: "", shell: "" }, [
    "cols",
    "rows",
    "cwd",
    "shell",
  ]);
});

Deno.test("schema: spawn program and args", () => {
  assertEquals(
    ok("spawn", { cols: 80, rows: 24, program: "ssh", args: ["-V"] }),
    {
      cols: 80,
      rows: 24,
      cwd: undefined,
      shell: undefined,
      program: "ssh",
      args: ["-V"],
    },
  );
  // A program without args, and an empty args list, are both fine.
  ok("spawn", { cols: 80, rows: 24, program: "/bin/sh" });
  ok("spawn", { cols: 80, rows: 24, program: "/bin/sh", args: [] });
  ok("spawn", {
    cols: 80,
    rows: 24,
    program: "sh",
    args: Array(256).fill("x"),
  });
  for (const p of ["", 1, null, {}, [], "x".repeat(4097)]) {
    bad("spawn", { cols: 80, rows: 24, program: p }, ["program"]);
  }
  // A NUL would end the C string early: the exec'd path or argument would not be the one given.
  bad("spawn", { cols: 80, rows: 24, program: "sh\0-c" }, ["program"]);
  bad("spawn", { cols: 80, rows: 24, program: "sh", args: ["a\0b"] }, ["args"]);
  for (const a of ["x", 1, null, {}, Array(257).fill("x"), [1], [""], [null]]) {
    bad("spawn", { cols: 80, rows: 24, program: "sh", args: a }, ["args"]);
  }
  // args alone (no program) is accepted by the schema; spawn ignores it with a shell.
  ok("spawn", { cols: 80, rows: 24, args: ["-x"] });
});

Deno.test("schema: write", () => {
  assertEquals(ok("write", { id: "pty-1", data: "ls\r" }), {
    id: "pty-1",
    data: "ls\r",
  });
  ok("write", { id: "pty-1", data: "" });
  ok("write", { id: "x".repeat(64), data: "a" });
  // Exactly 1 MiB (in UTF-16 code units) is the limit.
  ok("write", { id: "pty-1", data: "a".repeat(1 << 20) });
  bad("write", { id: "pty-1", data: "a".repeat((1 << 20) + 1) }, ["data"]);
  for (const d of [undefined, null, 1, true, {}, [], new Uint8Array(3)]) {
    bad("write", { id: "pty-1", data: d }, ["data"]);
  }
  for (const id of BAD_IDS) bad("write", { id, data: "x" }, ["id"]);
  bad("write", {}, ["data", "id"]);
  assertEquals(
    Object.keys(ok("write", { id: "a", data: "b", extra: 1 }) as object).sort(),
    ["data", "id"],
  );
  // binary: xterm onBinary data, one byte per char.
  assertEquals(
    ok("write", { id: "a", data: "\x1b[M \xff\xa0", binary: true }),
    {
      id: "a",
      data: "\x1b[M \xff\xa0",
      binary: true,
    },
  );
  assertEquals(ok("write", { id: "a", data: "x", binary: false }), {
    id: "a",
    data: "x",
  });
  bad("write", { id: "a", data: "\u0100", binary: true }, ["data"]);
  bad("write", { id: "a", data: "😀", binary: true }, ["data"]);
  for (const b of [1, "yes", null, {}]) {
    bad("write", { id: "a", data: "x", binary: b }, ["binary"]);
  }
});

Deno.test("schema: resize", () => {
  assertEquals(ok("resize", { id: "pty-1", cols: 100, rows: 30 }), {
    id: "pty-1",
    cols: 100,
    rows: 30,
  });
  for (const d of BAD_DIMS) {
    bad("resize", { id: "pty-1", cols: d, rows: 30 }, ["cols"]);
    bad("resize", { id: "pty-1", cols: 100, rows: d }, ["rows"]);
  }
  for (const id of BAD_IDS) bad("resize", { id, cols: 1, rows: 1 }, ["id"]);
  bad("resize", {}, ["id", "cols", "rows"]);
});

Deno.test("schema: kill and info", () => {
  for (const name of ["kill", "info"] as const) {
    assertEquals(ok(name, { id: "pty-7" }), { id: "pty-7" });
    assertEquals(ok(name, { id: "pty-7", force: true }), { id: "pty-7" });
    for (const id of BAD_IDS) bad(name, { id }, ["id"]);
    bad(name, {}, ["id"]);
  }
});

Deno.test("schema: issue messages name the limits", () => {
  const r = v("spawn")({ cols: 0, rows: 24 }) as Result;
  assertEquals(r.issues, [{
    message: "cols must be an integer in 1..10000",
    path: ["cols"],
  }]);
  const w = v("write")({ id: "a", data: 5 }) as Result;
  assertEquals(w.issues, [{
    message: "data must be a string (at most 1 MiB)",
    path: ["data"],
  }]);
  const k = v("kill")({ id: "" }) as Result;
  assertEquals(k.issues, [{
    message: "id must be a non-empty string",
    path: ["id"],
  }]);
});
