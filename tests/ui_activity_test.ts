// Tile activity (lib/workspace/activity.ts and its store actions): the one state a tile shows and
// its precedence, what latches until focus, the done decay on an injected clock, the settings,
// program titles (sanitized, shown, cleared) and the demo shell's helpers that drive them.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type ActivityInput,
  clearSignals,
  DEFAULT_ACTIVITY,
  displayTitle,
  DONE_MS,
  MAX_PROGRAM_TITLE,
  nextDecay,
  sanitizeActivity,
  sanitizeProgramTitle,
  sanitizeTileTitle,
  tileActivity,
} from "../lib/workspace/activity.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  loadSettings,
  reduce,
  sanitizeSettings,
  saveSettings,
  type TerminalEntry,
  type WorkspaceAction,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import { snapshotOf } from "../lib/workspace/session.ts";
import {
  demoBellDelay,
  demoLater,
  demoTitle,
} from "../lib/shell-marks-demo.ts";

const NOW = 100_000;

/** An unfocused, running terminal with no signals, plus `patch`. */
const tile = (patch: Partial<ActivityInput> = {}): ActivityInput => ({
  focused: false,
  exited: false,
  activity: false,
  ...patch,
});

const state = (patch: Partial<ActivityInput>, settings = DEFAULT_ACTIVITY) =>
  tileActivity(tile(patch), settings, NOW);

Deno.test("activity: each signal alone gives its state", () => {
  assertEquals(state({}), "none");
  assertEquals(state({ activity: true }), "output");
  assertEquals(state({ running: true }), "busy");
  assertEquals(state({ agentStatus: "busy" }), "busy");
  assertEquals(state({ agentStatus: "idle" }), "none");
  assertEquals(state({ doneAt: NOW }), "done");
  assertEquals(state({ failed: true }), "failed");
  assertEquals(state({ bell: true }), "attention");
  assertEquals(state({ agentStatus: "waiting" }), "attention");
});

Deno.test("activity: precedence is attention > failed > busy > done > output", () => {
  const all = {
    bell: true,
    failed: true,
    running: true,
    doneAt: NOW,
    activity: true,
  };
  assertEquals(state(all), "attention");
  assertEquals(state({ ...all, bell: false }), "failed");
  assertEquals(state({ ...all, bell: false, failed: false }), "busy");
  assertEquals(
    state({ ...all, bell: false, failed: false, running: false }),
    "done",
  );
  assertEquals(
    state({ activity: true, doneAt: NOW - DONE_MS }),
    "output",
    "a decayed done falls back to output",
  );
});

Deno.test("activity: the focused, an exited and a web tile show nothing", () => {
  const loud = { bell: true, running: true, activity: true };
  assertEquals(state({ ...loud, focused: true }), "none");
  assertEquals(state({ ...loud, exited: true }), "none");
  assertEquals(state({ ...loud, web: { url: "https://deno.com/" } }), "none");
});

Deno.test("activity: done shows for DONE_MS on the clock it is given", () => {
  const t = tile({ doneAt: 1000 });
  assertEquals(tileActivity(t, DEFAULT_ACTIVITY, 900), "done", "stale clock");
  assertEquals(tileActivity(t, DEFAULT_ACTIVITY, 1000), "done");
  assertEquals(tileActivity(t, DEFAULT_ACTIVITY, 1000 + DONE_MS - 1), "done");
  assertEquals(tileActivity(t, DEFAULT_ACTIVITY, 1000 + DONE_MS), "none");
  // The next decay to wake up for: the earliest one still ahead.
  assertEquals(
    nextDecay([{ doneAt: 1000 }, { doneAt: 500 }, {}], 0),
    500 + DONE_MS,
  );
  assertEquals(nextDecay([{ doneAt: 1000 }, { doneAt: 500 }], 4600), 5000);
  assertEquals(nextDecay([{ doneAt: 1000 }], 5000), null);
  assertEquals(nextDecay([], 0), null);
});

Deno.test("activity: Off shows nothing; each toggle drops its state, busy follows the switch", () => {
  const off = { ...DEFAULT_ACTIVITY, indicators: "off" as const };
  for (
    const s of [
      { bell: true },
      { failed: true },
      { running: true },
      { doneAt: NOW },
      { activity: true },
    ]
  ) {
    assertEquals(state(s, off), "none");
  }
  const subtle = { ...DEFAULT_ACTIVITY, indicators: "subtle" as const };
  assertEquals(state({ running: true }, subtle), "busy");
  const all = { bell: true, failed: true, doneAt: NOW, activity: true };
  assertEquals(state(all, { ...DEFAULT_ACTIVITY, bell: false }), "failed");
  assertEquals(
    state(all, { ...DEFAULT_ACTIVITY, bell: false, failed: false }),
    "done",
  );
  assertEquals(
    state(all, {
      ...DEFAULT_ACTIVITY,
      bell: false,
      failed: false,
      done: false,
    }),
    "output",
  );
  assertEquals(
    state(all, {
      indicators: "full",
      bell: false,
      failed: false,
      done: false,
      output: false,
    }),
    "none",
  );
  assertEquals(
    state({ agentStatus: "waiting" }, { ...DEFAULT_ACTIVITY, bell: false }),
    "none",
    "an agent waiting is attention too",
  );
});

Deno.test("activity settings: sanitize onto the defaults (Full, all on)", () => {
  assertEquals(DEFAULT_ACTIVITY, {
    indicators: "full",
    bell: true,
    failed: true,
    done: true,
    output: true,
  });
  assertEquals(DEFAULT_SETTINGS.activity, DEFAULT_ACTIVITY);
  assertEquals(DEFAULT_SETTINGS.tileTitle, "program");
  for (const junk of [null, 3, "full", []]) {
    assertEquals(sanitizeActivity(junk), DEFAULT_ACTIVITY);
  }
  assertEquals(
    sanitizeActivity({ indicators: "subtle", done: false, output: "no" }),
    { ...DEFAULT_ACTIVITY, indicators: "subtle", done: false },
  );
  assertEquals(sanitizeActivity({ indicators: "loud" }).indicators, "full");
  // A partial patch keeps the base.
  const base = { ...DEFAULT_ACTIVITY, indicators: "off" as const, bell: false };
  assertEquals(sanitizeActivity({ failed: false }, base), {
    ...base,
    failed: false,
  });
  assertEquals(sanitizeTileTitle("process"), "process");
  for (const junk of ["program", "Process", 1, null, undefined]) {
    assertEquals(sanitizeTileTitle(junk), "program");
  }
  // Through the settings path: sanitized, reduced and persisted.
  const s = sanitizeSettings({
    activity: { indicators: "subtle", bell: false, bogus: 1 },
    tileTitle: "process",
  });
  assertEquals(s.activity, {
    ...DEFAULT_ACTIVITY,
    indicators: "subtle",
    bell: false,
  });
  assertEquals(s.tileTitle, "process");
  assertEquals(sanitizeSettings({ tileTitle: 7 }).tileTitle, "program");
  let w = initialState();
  w = reduce(w, { type: "setActivity", patch: { indicators: "off" } });
  w = reduce(w, { type: "setActivity", patch: { output: false } });
  assertStrictEquals(
    reduce(w, { type: "setActivity", patch: { output: false } }),
    w,
  );
  w = reduce(w, { type: "setTileTitle", tileTitle: "process" });
  assertStrictEquals(
    reduce(w, { type: "setTileTitle", tileTitle: "process" }),
    w,
  );
  // A one-slot storage: the settings are the only thing saved here.
  let saved: string | null = null;
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => void (saved = value),
  };
  assert(saveSettings(w.settings, storage));
  const back = reduce(initialState(), {
    type: "hydrateSettings",
    settings: loadSettings(storage)!,
  });
  assertEquals(back.settings.activity, {
    ...DEFAULT_ACTIVITY,
    indicators: "off",
    output: false,
  });
  assertEquals(back.settings.tileTitle, "process");
});

// ---- The store's signals ------------------------------------------------------------------

/** Terminals a, b, c; c is focused. */
const three = (): WorkspaceState =>
  [
    { type: "add", id: "a", now: 1 },
    { type: "add", id: "b", now: 2 },
    { type: "add", id: "c", now: 3 },
  ].reduce((s, a) => reduce(s, a as WorkspaceAction), initialState());

const entry = (s: WorkspaceState, id: string): TerminalEntry =>
  s.terminals.find((t) => t.id === id)!;

Deno.test("store: a bell, a failed command and a done command latch on unfocused tiles only", () => {
  let s = three();
  s = reduce(s, { type: "bell", id: "a" });
  s = reduce(s, { type: "commandDone", id: "b", exitCode: 2, now: 50 });
  assertEquals(entry(s, "a").bell, true);
  assertEquals(entry(s, "b").failed, true);
  // The focused tile latches nothing (its user sees it happen).
  assertStrictEquals(reduce(s, { type: "bell", id: "c" }), s);
  const done = reduce(s, { type: "commandDone", id: "c", exitCode: 1, now: 9 });
  assertEquals(entry(done, "c").failed, undefined);
  // Exit 0 (or none sent) is done, with when it ended.
  s = reduce(s, { type: "commandDone", id: "a", exitCode: 0, now: 60 });
  assertEquals(entry(s, "a").doneAt, 60);
  s = reduce(s, { type: "commandDone", id: "a", exitCode: null, now: 70 });
  assertEquals(entry(s, "a").doneAt, 70);
  assertEquals(entry(s, "a").failed, undefined);
});

Deno.test("store: running follows the marks, live; a command's end or exit stops it", () => {
  let s = three();
  s = reduce(s, { type: "commandRunning", id: "a", running: true });
  assertEquals(entry(s, "a").running, true);
  // Focus leaves a running command running (it is not latched).
  s = reduce(s, { type: "focus", id: "a", now: 10 });
  assertEquals(entry(s, "a").running, true);
  s = reduce(s, { type: "commandDone", id: "a", exitCode: 0, now: 11 });
  assertEquals(entry(s, "a").running, undefined);
  assertEquals(entry(s, "a").doneAt, undefined, "focused: no done");
  s = reduce(s, { type: "commandRunning", id: "b", running: true });
  s = reduce(s, { type: "commandRunning", id: "b", running: false });
  assertEquals(entry(s, "b").running, undefined);
  assertStrictEquals(
    reduce(s, { type: "commandRunning", id: "b", running: false }),
    s,
    "already stopped: no change",
  );
  s = reduce(s, { type: "commandRunning", id: "b", running: true });
  s = reduce(s, { type: "exited", id: "b", exitCode: 0 });
  assertEquals(entry(s, "b").running, undefined);
});

Deno.test("store: focusing a tile clears what latched (bell, failed, done, output)", () => {
  let s = three();
  for (
    const a of [
      { type: "bell", id: "a" },
      { type: "activity", id: "a" },
      { type: "commandDone", id: "a", exitCode: 1, now: 5 },
      { type: "commandDone", id: "a", exitCode: 0, now: 6 },
      { type: "commandRunning", id: "a", running: true },
    ] as WorkspaceAction[]
  ) s = reduce(s, a);
  const before = entry(s, "a");
  assert(before.bell && before.failed && before.activity);
  assertEquals(before.doneAt, 6);
  s = reduce(s, { type: "focus", id: "a", now: 7 });
  const after = entry(s, "a");
  assertEquals(after.bell, undefined);
  assertEquals(after.failed, undefined);
  assertEquals(after.doneAt, undefined);
  assertEquals(after.activity, false);
  assertEquals(after.running, true);
  // Focusing it again at the same instant leaves its entry alone.
  assertStrictEquals(
    entry(reduce(s, { type: "focus", id: "a", now: 7 }), "a"),
    after,
  );
});

Deno.test("store: program titles are sanitized, cleared by an empty one and by a restart", () => {
  let s = three();
  s = reduce(s, { type: "programTitle", id: "a", title: "vim\x1b notes.md\n" });
  assertEquals(entry(s, "a").programTitle, "vim notes.md");
  s = reduce(s, { type: "programTitle", id: "a", title: "  \x07 " });
  assertEquals(entry(s, "a").programTitle, undefined);
  s = reduce(s, { type: "programTitle", id: "a", title: "htop" });
  s = reduce(s, { type: "exited", id: "a", exitCode: 0 });
  s = reduce(s, { type: "restarted", id: "a", now: 9 });
  assertEquals(entry(s, "a").programTitle, undefined);
  // A web tile has no terminal: no signals.
  s = reduce(s, {
    type: "add",
    id: "w",
    now: 10,
    web: { url: "https://x.io/" },
  });
  s = reduce(s, { type: "focus", id: "a", now: 11 });
  for (
    const a of [
      { type: "programTitle", id: "w", title: "hi" },
      { type: "bell", id: "w" },
      { type: "commandRunning", id: "w", running: true },
      { type: "commandDone", id: "w", exitCode: 1, now: 12 },
    ] as WorkspaceAction[]
  ) assertStrictEquals(reduce(s, a), s, a.type);
});

Deno.test("store: signals and the program title do not outlive the page (snapshot, clearSignals)", () => {
  let s = three();
  s = reduce(s, { type: "bell", id: "a" });
  s = reduce(s, { type: "commandRunning", id: "b", running: true });
  s = reduce(s, { type: "programTitle", id: "b", title: "make" });
  s = reduce(s, { type: "commandDone", id: "a", exitCode: 3, now: 4 });
  const snap = snapshotOf(s, 3, () => undefined);
  for (const t of snap.terminals) {
    assertEquals(t, clearSignals(t));
    assertEquals(
      Object.keys(t).filter((k) =>
        ["bell", "running", "failed", "doneAt", "programTitle"].includes(k)
      ),
      [],
    );
  }
});

// ---- Program titles ---------------------------------------------------------------------

Deno.test("sanitizeProgramTitle: no control characters, bounded, empty is cleared", () => {
  assertEquals(sanitizeProgramTitle("user@host: ~/src"), "user@host: ~/src");
  assertEquals(sanitizeProgramTitle("a\x00b\x1b[31mc\x7f\x9bd"), "a b [31mc d");
  assertEquals(sanitizeProgramTitle("  two   spaces\t\r\n "), "two spaces");
  for (const empty of ["", "   ", "\x07\x1b", 3, null, undefined]) {
    assertEquals(sanitizeProgramTitle(empty), undefined, String(empty));
  }
  const long = sanitizeProgramTitle("x".repeat(500))!;
  assertEquals(long.length, MAX_PROGRAM_TITLE);
  // Cut by characters, never through a surrogate pair.
  const emoji = sanitizeProgramTitle("🦕".repeat(300))!;
  assertEquals([...emoji].length, MAX_PROGRAM_TITLE);
  assertEquals(emoji, "🦕".repeat(MAX_PROGRAM_TITLE));
});

Deno.test("displayTitle: the program's title when set and allowed, a name kept in front", () => {
  const shell = { title: "zsh — ~/src", programTitle: "vim notes.md" };
  assertEquals(displayTitle(shell, "program"), "vim notes.md");
  assertEquals(displayTitle(shell, "process"), "zsh — ~/src");
  assertEquals(displayTitle({ title: "zsh — ~" }, "program"), "zsh — ~");
  // An agent tool keeps its name unless the program's title says it.
  const agent = {
    title: "claude — ~/proj",
    agent: { name: "claude" },
    programTitle: "Fixing the build",
  };
  assertEquals(displayTitle(agent, "program"), "claude · Fixing the build");
  assertEquals(
    displayTitle({ ...agent, programTitle: "✳ Claude Code" }, "program"),
    "✳ Claude Code",
  );
  assertEquals(displayTitle(agent, "process"), "claude — ~/proj");
  // An SSH tile keeps its host label in front.
  assertEquals(
    displayTitle(
      { title: "web-1", ssh: { label: "web-1" }, programTitle: "htop" },
      "program",
    ),
    "web-1 · htop",
  );
  // A web tile shows its page's title.
  assertEquals(
    displayTitle(
      { title: "Deno", web: { url: "https://deno.com/" }, programTitle: "x" },
      "program",
    ),
    "Deno",
  );
});

// ---- The demo shell's helpers --------------------------------------------------------------

Deno.test("demo helpers: bell, later and title parse their arguments", () => {
  assertEquals(demoBellDelay([]), 0);
  assertEquals(demoBellDelay(["1.5"]), 1500);
  assertEquals(demoBellDelay(["999"]), 60_000, "capped");
  for (const bad of [["soon"], ["-1"], ["1", "2"], [""]]) {
    assertEquals(demoBellDelay(bad), null, bad.join(" "));
  }
  assertEquals(demoLater(["2", "build", "done"]), {
    ms: 2000,
    text: "build done",
  });
  for (const bad of [[], ["2"], ["x", "hi"]]) {
    assertEquals(demoLater(bad), null, bad.join(" "));
  }
  assertEquals(demoTitle(["vim", "a.md"]), "\x1b]2;vim a.md\x07");
  assertEquals(demoTitle(["-0", "htop"]), "\x1b]0;htop\x07");
  assertEquals(demoTitle([]), "\x1b]2;\x07");
});
