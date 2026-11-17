// An agent tile in the workspace: its entry (`chat`) in the store, what the snapshot saves and a
// restore rebuilds, the Agents panel's groups, the model labels, and the markdown and code
// highlighting its transcript draws.

import { assert, assertEquals } from "@std/assert";
import {
  initialState,
  reduce,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import { planRestore, snapshotOf } from "../lib/workspace/session.ts";
import { agentGroup, modelLabel, sanitizeChat } from "../lib/agent/tile.ts";
import { emptyTranscript, type Row } from "../lib/agent/transcript.ts";
import {
  highlight,
  parseInline,
  parseMarkdown,
  safeHref,
} from "../lib/agent/markdown.ts";

function withAgent(): WorkspaceState {
  let s = initialState();
  s = reduce(s, { type: "add", id: "t1", now: 1 });
  s = reduce(s, {
    type: "add",
    id: "t2",
    now: 2,
    chat: { cwd: "/w/proj" },
    title: "claude",
  });
  return s;
}

Deno.test("store: an agent tile's entry, its session saved by chatMeta", () => {
  let s = withAgent();
  const entry = s.terminals.find((t) => t.id === "t2")!;
  assertEquals(entry.chat, { cwd: "/w/proj" });
  assertEquals(entry.title, "claude");
  assertEquals(s.focusedId, "t2");
  s = reduce(s, {
    type: "chatMeta",
    id: "t2",
    patch: {
      agentId: "agent-4",
      session: "665799d1-8fd9-4a23-9b59-3ee348bd92e9",
      model: "opus",
      turns: 1,
    },
  });
  assertEquals(s.terminals[1].chat, {
    cwd: "/w/proj",
    model: "opus",
    session: "665799d1-8fd9-4a23-9b59-3ee348bd92e9",
    agentId: "agent-4",
    turns: 1,
  });
  // The same patch again changes nothing; `undefined` clears a field; a terminal has no chat.
  assertEquals(
    reduce(s, { type: "chatMeta", id: "t2", patch: { model: "opus" } }),
    s,
  );
  const cleared = reduce(s, {
    type: "chatMeta",
    id: "t2",
    patch: { model: undefined, session: undefined },
  });
  assertEquals(cleared.terminals[1].chat?.model, undefined);
  assertEquals(cleared.terminals[1].chat?.session, undefined);
  assertEquals(
    reduce(s, { type: "chatMeta", id: "t1", patch: { model: "x" } }),
    s,
  );
  // Its name is its title (a rename).
  s = reduce(s, { type: "title", id: "t2", title: "builder" });
  assertEquals(s.terminals[1].title, "builder");
  // A turn ending while another tile is focused: done (or failed).
  s = reduce(s, { type: "focus", id: "t1", now: 3 });
  s = reduce(s, { type: "commandDone", id: "t2", exitCode: 0, now: 4 });
  assertEquals(s.terminals[1].doneAt, 4);
});

Deno.test("session: the snapshot keeps an agent tile's session and capped rows; a restore rebuilds it", () => {
  let s = withAgent();
  s = reduce(s, {
    type: "chatMeta",
    id: "t2",
    patch: {
      agentId: "agent-4",
      session: "665799d1-8fd9-4a23-9b59-3ee348bd92e9",
    },
  });
  const rows: Row[] = [
    { type: "user", id: "u0", text: "hi", at: 1 },
    { type: "text", id: "m:0", text: "hello", at: 2 },
    { type: "permission", id: "p", toolName: "Bash", input: {}, at: 3 },
  ];
  const snap = snapshotOf(
    s,
    2,
    (id) => ({ ptyId: `pty-${id}`, profile: { kind: "shell" } }),
    (id) => id === "t2" ? rows : [],
  );
  const tile = snap.tiles.t2;
  assert("chat" in tile);
  assertEquals(tile.chat.agentId, "agent-4");
  // The unanswered question is not saved (it cannot be answered after a restore).
  assertEquals(tile.rows.map((r) => r.id), ["u0", "m:0"]);
  const plan = planRestore(JSON.parse(JSON.stringify(snap)), [])!;
  const restored = plan.terminals.find((t) => t.id === "t2")!;
  assertEquals(restored.chat, tile.chat);
  assertEquals(restored.exited, false);
  const rt = plan.tiles.find((t) => t.id === "t2")!;
  assert("chat" in rt);
  assertEquals(rt.rows.map((r) => r.id), ["u0", "m:0"]);
  // The terminal beside it is still a terminal (its PTY is gone: ended).
  const term = plan.tiles.find((t) => t.id === "t1")!;
  assert("profile" in term);
  // A broken chat in storage is not an agent tile.
  const bad = JSON.parse(JSON.stringify(snap));
  bad.tiles.t2.chat = { cwd: 7 };
  assertEquals(planRestore(bad, [])!.terminals.some((t) => t.chat), false);
});

Deno.test("sanitizeChat: the fields it keeps", () => {
  assertEquals(sanitizeChat({ cwd: "" }), undefined);
  assertEquals(sanitizeChat("x"), undefined);
  assertEquals(
    sanitizeChat({
      cwd: "/w",
      model: "rm -rf",
      session: "../x",
      agentId: "pty-3",
      mode: "plan",
      turns: 2,
    }),
    { cwd: "/w", mode: "plan", turns: 2 },
  );
});

Deno.test("groups: needs you, working, to review, idle", () => {
  const t = emptyTranscript();
  assertEquals(agentGroup(undefined, false), "idle");
  assertEquals(agentGroup(t, false), "idle");
  assertEquals(agentGroup({ ...t, running: true }, false), "working");
  assertEquals(
    agentGroup({ ...t, running: true, asking: ["q"] }, false),
    "needs",
  );
  assertEquals(agentGroup({ ...t, error: "boom" }, true), "needs");
  assertEquals(agentGroup(t, true), "review");
  assertEquals(modelLabel(undefined), "default");
  assertEquals(modelLabel("opus[1m]"), "opus 1M");
  assertEquals(modelLabel("claude-haiku-5-5"), "haiku-5-5");
});

Deno.test("markdown: headings, lists, quotes, rules, fences (an unclosed one too)", () => {
  assertEquals(
    parseMarkdown(
      "# Title\ntext line\nmore\n\n- a\n- b\n  wrapped\n1. one\n2. two\n> quote\n---\n```ts\nconst x = 1;\n```\n```py\nopen",
    ),
    [
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "text line\nmore" },
      { kind: "list", ordered: false, start: 1, items: ["a", "b\nwrapped"] },
      { kind: "list", ordered: true, start: 1, items: ["one", "two"] },
      { kind: "quote", text: "quote" },
      { kind: "rule" },
      { kind: "code", lang: "ts", text: "const x = 1;" },
      { kind: "code", lang: "py", text: "open" },
    ],
  );
});

Deno.test("inline markdown: code, bold, italics, links (only http(s) and mailto)", () => {
  assertEquals(
    parseInline(
      "Run `npm test`, **now**, *please* — see [docs](https://x.dev/a) or https://y.dev.",
    ),
    [
      { kind: "text", text: "Run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: ", " },
      { kind: "strong", text: "now" },
      { kind: "text", text: ", " },
      { kind: "em", text: "please" },
      { kind: "text", text: " — see " },
      { kind: "link", text: "docs", href: "https://x.dev/a" },
      { kind: "text", text: " or " },
      { kind: "link", text: "https://y.dev", href: "https://y.dev" },
      { kind: "text", text: "." },
    ],
  );
  assertEquals(parseInline("[x](javascript:alert(1))")[0].kind, "text");
  assert(safeHref("mailto:a@b.c") && !safeHref("file:///etc/passwd"));
  // snake_case words are not italics.
  assertEquals(parseInline("a_b_c"), [{ kind: "text", text: "a_b_c" }]);
});

Deno.test("highlight: keywords, strings, comments, numbers; # comments for shells", () => {
  assertEquals(highlight('const a = "x"; // hi', "ts"), [
    { t: "kw", s: "const" },
    { t: "plain", s: " a = " },
    { t: "str", s: '"x"' },
    { t: "plain", s: "; " },
    { t: "com", s: "// hi" },
  ]);
  assertEquals(highlight("echo 42 # note", "sh"), [
    { t: "plain", s: "echo " },
    { t: "num", s: "42" },
    { t: "plain", s: " " },
    { t: "com", s: "# note" },
  ]);
  assertEquals(
    highlight("x = 1", "").map((t) => t.s).join(""),
    "x = 1",
  );
});
