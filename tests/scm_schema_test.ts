// The `scm` desktop extension's declared shape and its method inputs (desktop/scm.ts), run the
// way the desktop bridge runs them.

import { assertEquals } from "@std/assert";
import ext from "../desktop/scm.ts";
import { assertExtensionShape, schemaTesters } from "./schema_helpers.ts";

const { ok, bad, rejectsNonObjects } = schemaTesters(ext);

Deno.test("scm schema: declared events and methods", () => {
  assertExtensionShape(ext, {
    name: "scm",
    events: ["changed", "progress"],
    methods: [
      "applyPatch",
      "branches",
      "cancel",
      "checkout",
      "commit",
      "commitDiff",
      "commitFiles",
      "diff",
      "discard",
      "discardUntracked",
      "lastMessage",
      "log",
      "remote",
      "repoRoot",
      "stage",
      "stashAction",
      "stashPush",
      "stashes",
      "status",
      "unstage",
      "unwatch",
      "watch",
      "worktreeAdd",
      "worktreeRemove",
      "worktrees",
    ],
  });
});

Deno.test("scm schema: every method rejects non-objects", rejectsNonObjects);

Deno.test("scm schema: roots are absolute, kinds and actions are known, stash refs are refs", () => {
  assertEquals(ok("status", { root: "/r" }), { root: "/r" });
  bad("status", { root: "r" }, ["root"]);
  bad("status", { root: "/r\0" }, ["root"]);
  assertEquals(ok("diff", { root: "/r", path: "a", kind: "staged" }), {
    root: "/r",
    path: "a",
    kind: "staged",
  });
  bad("diff", { root: "/r", path: "a", kind: "nope" }, ["kind"]);
  bad("applyPatch", { root: "/r", patch: "p", action: "rm" }, ["action"]);
  assertEquals(
    ok("commit", { root: "/r", message: "m", mode: "all", amend: true }),
    { root: "/r", message: "m", mode: "all", amend: true },
  );
  bad("commit", { root: "/r", message: "", mode: "all" }, ["message"]);
  bad("remote", { root: "/r", op: "gc", opId: "x" }, ["op"]);
  bad("stashAction", { root: "/r", ref: "HEAD", oid: "a", action: "pop" }, [
    "ref",
  ]);
  assertEquals(
    ok("stashPush", { root: "/r", message: "" }),
    { root: "/r", message: "" },
  );
  assertEquals(ok("log", { root: "/r" }), { root: "/r", limit: 200 });
  bad("log", { root: "/r", limit: 0 }, ["limit"]);
  assertEquals(
    ok("worktreeRemove", { root: "/r", path: "/w", force: true }),
    { root: "/r", path: "/w", force: true },
  );
  bad("stage", { root: "/r", paths: [""] }, ["paths"]);
});
