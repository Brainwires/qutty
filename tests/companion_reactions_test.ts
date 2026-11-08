// Loopy's reactions (Settings → Companion → Reactions): which finished jobs earn a hop of joy or a
// sad face (lib/companion/reactions.ts), sleepy at night (lib/companion/sleepy.ts), the order of
// the faces (lib/companion/loopy-priority.ts) and the settings that drive them.

import { assert, assertEquals } from "@std/assert";
import {
  commandReaction,
  commandReactionKind,
  formatDuration,
  isBuildLike,
  isInteractive,
  isSuccessNote,
  mayReact,
  maySpeakReaction,
  NEVER_REACTED,
  programOf,
  REACT_EVERY_MS,
  type ReactionRules,
  stoppedByUser,
  tileReactions,
} from "../lib/companion/reactions.ts";
import {
  dayMinute,
  formatMinute,
  inWindow,
  nearEnoughToWake,
  parseMinute,
  shouldSleep,
  shouldWake,
  SLEEP_AFTER_MS,
} from "../lib/companion/sleepy.ts";
import {
  chooseFace,
  FACE_LAYERS,
  type FaceInputs,
  mayStartReaction,
  topLayer,
  wakesLoopy,
} from "../lib/companion/loopy-priority.ts";
import {
  DEFAULT_COMPANION,
  sanitizeCompanion,
} from "../lib/companion/settings.ts";
import type { TileInfo } from "../lib/hub/protocol.ts";
import type { CommandDone } from "../lib/shell-marks.ts";

const RULES: ReactionRules = {
  celebrate: true,
  sad: true,
  minDurationS: 20,
  anyLongCommand: false,
};

const done = (
  command: string,
  exitCode: number | null,
  seconds: number | null,
): CommandDone => ({
  command,
  exitCode,
  durationMs: seconds === null ? null : seconds * 1000,
  at: 0,
});

// --- shell commands ---------------------------------------------------------------------------

Deno.test("programOf: past wrappers, env assignments and paths", () => {
  assertEquals(programOf("sudo make install").program, "make");
  assertEquals(programOf("time -p cargo test").program, "cargo");
  assertEquals(programOf("env CI=1 RUST_LOG=x cargo build").program, "cargo");
  assertEquals(programOf("FOO=1 npm test").program, "npm");
  assertEquals(programOf("./gradlew assemble").program, "gradlew");
  assertEquals(programOf("/usr/bin/make").program, "make");
  assertEquals(programOf("   ").program, "");
});

Deno.test("isBuildLike: builds, tests, checks and installs", () => {
  for (
    const cmd of [
      "make",
      "make -j8 all",
      "cargo test --release",
      "npm run build",
      "pnpm test",
      "deno task test",
      "go test ./...",
      "pytest -x",
      "python -m pytest",
      "./gradlew assemble",
      "xcodebuild -scheme Qutty",
      "docker build .",
      "./run-tests.sh",
      "just build",
      "brew install ffmpeg",
    ]
  ) assert(isBuildLike(cmd), cmd);
  for (
    const cmd of [
      "ls -la",
      "cd src",
      "git status",
      "node",
      "python3",
      "vim build.rs",
    ]
  ) {
    // vim build.rs mentions "build" but is an editor: interactive, below.
    if (cmd.startsWith("vim")) continue;
    assert(!isBuildLike(cmd), cmd);
  }
});

Deno.test("isInteractive: editors, pagers, remote shells, agents and bare REPLs", () => {
  for (
    const cmd of [
      "vim build.rs",
      "nvim",
      "less log.txt",
      "ssh prod",
      "top",
      "claude",
      "node",
      "python3",
      "tail -f app.log",
      "sudo vim /etc/hosts",
    ]
  ) assert(isInteractive(cmd), cmd);
  for (
    const cmd of ["node build.js", "python -m pytest", "deno task test", "make"]
  ) assert(!isInteractive(cmd), cmd);
});

Deno.test("stoppedByUser: Ctrl-C and signals are not failures", () => {
  for (const c of [130, 143, 137, 129, 131]) {
    assert(stoppedByUser(c), String(c));
  }
  for (const c of [1, 2, 101, 127]) assert(!stoppedByUser(c), String(c));
});

Deno.test("commandReactionKind: long build/test commands, by exit status", () => {
  assertEquals(
    commandReactionKind(done("cargo test", 0, 25), RULES),
    "celebrate",
  );
  assertEquals(commandReactionKind(done("make", 2, 40), RULES), "sad");
  // Exactly the minimum counts; a second less does not.
  assertEquals(commandReactionKind(done("make", 0, 20), RULES), "celebrate");
  assertEquals(commandReactionKind(done("make", 0, 19), RULES), null);
  // Not build-like: only with "any long command".
  assertEquals(
    commandReactionKind(done("sleep-ish-script", 0, 60), RULES),
    null,
  );
  assertEquals(
    commandReactionKind(done("./crunch-numbers", 0, 60), {
      ...RULES,
      anyLongCommand: true,
    }),
    "celebrate",
  );
  // Interactive programs never count, even with "any long command".
  assertEquals(
    commandReactionKind(done("vim notes.md", 0, 600), {
      ...RULES,
      anyLongCommand: true,
    }),
    null,
  );
  // Ctrl-C is not a failure.
  assertEquals(commandReactionKind(done("cargo build", 130, 60), RULES), null);
  // Unknown exit, duration or line: nothing.
  assertEquals(commandReactionKind(done("make", null, 60), RULES), null);
  assertEquals(commandReactionKind(done("make", 0, null), RULES), null);
  assertEquals(
    commandReactionKind({ exitCode: 0, durationMs: 60_000, at: 0 }, RULES),
    null,
  );
  // The toggles.
  assertEquals(
    commandReactionKind(done("make", 0, 60), { ...RULES, celebrate: false }),
    null,
  );
  assertEquals(
    commandReactionKind(done("make", 1, 60), { ...RULES, sad: false }),
    null,
  );
  // The minimum is a setting.
  assertEquals(
    commandReactionKind(done("make", 0, 3), { ...RULES, minDurationS: 2 }),
    "celebrate",
  );
});

Deno.test("commandReaction: the bubble's and the spoken lines", () => {
  const ok = commandReaction(
    done("cargo test --release", 0, 64),
    "shell-2",
    RULES,
    "r1",
  );
  assertEquals(ok, {
    id: "r1",
    kind: "celebrate",
    tile: "shell-2",
    source: "shell",
    text: "✓ shell-2: cargo test --release (1m 4s)",
    spoken: "shell 2: cargo test finished.",
  });
  const bad = commandReaction(done("make all", 2, 30), "shell-2", RULES, "r2");
  assertEquals(bad?.text, "✗ shell-2: make all failed (exit 2)");
  assertEquals(bad?.spoken, "shell 2: make all failed.");
  const long = commandReaction(
    done(`make ${"x".repeat(80)}`, 1, 30),
    "t",
    RULES,
    "r3",
  );
  assert(long!.text.includes("…"), long!.text);
  assertEquals(commandReaction(done("ls", 0, 30), "t", RULES, "r4"), null);
});

Deno.test("formatDuration", () => {
  assertEquals(formatDuration(45_000), "45 s");
  assertEquals(formatDuration(64_000), "1m 4s");
  assertEquals(formatDuration(2 * 3_600_000 + 3 * 60_000), "2h 3m");
});

// --- agent tiles ------------------------------------------------------------------------------

const tile = (
  id: string,
  note?: string,
  status: TileInfo["status"] = "idle",
): TileInfo => ({
  id,
  name: id === "pty-1" ? "claude" : "codex-2",
  status,
  unread: 0,
  ...(note === undefined ? {} : { note }),
});

Deno.test("isSuccessNote: success words, never a failure", () => {
  for (
    const n of [
      "tests passed",
      "build ok",
      "All green",
      "deployed",
      "✓ lint",
      "build succeeded",
    ]
  ) assert(isSuccessNote(n), n);
  for (
    const n of [
      "2 passed, 1 failed",
      "build failed",
      "thinking about it",
      undefined,
    ]
  ) assert(!isSuccessNote(n), String(n));
});

Deno.test("tileReactions: a status note that changes to success or failure", () => {
  const ids = (t: TileInfo) => `${t.id}:${t.note}`;
  const before = [tile("pty-1", undefined, "busy"), tile("pty-2")];
  const after = [tile("pty-1", "tests passed"), tile("pty-2", "build failed")];
  assertEquals(tileReactions(before, after, RULES, ids), [
    {
      id: "pty-1:tests passed",
      kind: "celebrate",
      tile: "claude",
      source: "agent",
      text: "✓ claude: tests passed",
      spoken: "claude: tests passed.",
    },
    {
      id: "pty-2:build failed",
      kind: "sad",
      tile: "codex-2",
      source: "agent",
      text: "✗ codex-2: build failed",
      spoken: "codex 2: build failed.",
    },
  ]);
  // The same note again, a neutral note, a new tile, a plain busy → idle: nothing.
  assertEquals(tileReactions(after, after, RULES, ids), []);
  assertEquals(
    tileReactions(
      [tile("pty-1")],
      [tile("pty-1", "reading the code")],
      RULES,
      ids,
    ),
    [],
  );
  assertEquals(tileReactions([], after, RULES, ids), []);
  assertEquals(
    tileReactions(
      [tile("pty-1", undefined, "busy")],
      [tile("pty-1")],
      RULES,
      ids,
    ),
    [],
  );
  // The toggles.
  assertEquals(
    tileReactions(before, after, { celebrate: false, sad: false }, ids),
    [],
  );
});

// --- rate limits and voice --------------------------------------------------------------------

Deno.test("mayReact: one of a kind per interval, kinds apart", () => {
  let clock = NEVER_REACTED;
  let r = mayReact(clock, "sad", 1_000);
  assert(r.ok);
  clock = r.clock;
  assert(!mayReact(clock, "sad", 1_000 + REACT_EVERY_MS.sad - 1).ok);
  assert(mayReact(clock, "sad", 1_000 + REACT_EVERY_MS.sad).ok);
  // A refused one does not restart the interval.
  assertEquals(mayReact(clock, "sad", 2_000).clock, clock);
  // Celebrating is its own clock.
  r = mayReact(clock, "celebrate", 1_500);
  assert(r.ok);
  assert(
    !mayReact(r.clock, "celebrate", 1_500 + REACT_EVERY_MS.celebrate - 1).ok,
  );
});

Deno.test("maySpeakReaction: shell reactions only, with their alert, when quiet", () => {
  const alerts = { alertFinished: true, alertBuildFailed: false };
  assert(
    maySpeakReaction({ kind: "celebrate", source: "shell" }, alerts, false),
  );
  assert(!maySpeakReaction({ kind: "sad", source: "shell" }, alerts, false));
  assert(
    !maySpeakReaction({ kind: "celebrate", source: "shell" }, alerts, true),
  );
  // Agents' notes have their own alerts.
  assert(
    !maySpeakReaction({ kind: "celebrate", source: "agent" }, alerts, false),
  );
});

// --- sleepy at night --------------------------------------------------------------------------

const at = (h: number, m = 0) => new Date(2026, 10, 7, h, m).getTime();

Deno.test("inWindow: a plain window, one across midnight, an empty one", () => {
  // 09:00–17:00
  assert(inWindow(9 * 60, 540, 1020));
  assert(inWindow(1019, 540, 1020));
  assert(!inWindow(1020, 540, 1020));
  assert(!inWindow(8 * 60, 540, 1020));
  // 22:00–06:00 crosses midnight.
  for (const m of [22 * 60, 23 * 60 + 59, 0, 3 * 60, 5 * 60 + 59]) {
    assert(inWindow(m, 22 * 60, 6 * 60), formatMinute(m));
  }
  for (const m of [6 * 60, 12 * 60, 21 * 60 + 59]) {
    assert(!inWindow(m, 22 * 60, 6 * 60), formatMinute(m));
  }
  // The default 00:00–06:00.
  assert(inWindow(0, 0, 360));
  assert(!inWindow(360, 0, 360));
  assert(!inWindow(23 * 60, 0, 360));
  // From = to: never.
  assert(!inWindow(0, 300, 300));
  assert(!inWindow(300, 300, 300));
});

Deno.test("dayMinute / parseMinute / formatMinute", () => {
  assertEquals(dayMinute(at(2, 30)), 150);
  assertEquals(parseMinute("06:30"), 390);
  assertEquals(parseMinute("6:05"), 365);
  assertEquals(parseMinute("23:59:00"), 1439);
  assertEquals(parseMinute("24:00"), null);
  assertEquals(parseMinute("7"), null);
  assertEquals(formatMinute(390), "06:30");
  assertEquals(formatMinute(0), "00:00");
});

Deno.test("shouldSleep / shouldWake: at night, idle, nothing else on", () => {
  const night = {
    enabled: true,
    now: at(2),
    from: 0,
    to: 360,
    lastActivity: at(2) - SLEEP_AFTER_MS,
    busy: false,
  };
  assert(shouldSleep(night));
  assert(!shouldSleep({ ...night, lastActivity: at(2) - SLEEP_AFTER_MS + 1 }));
  assert(!shouldSleep({ ...night, enabled: false }));
  assert(!shouldSleep({ ...night, busy: true }));
  assert(!shouldSleep({ ...night, now: at(14), lastActivity: at(13) }));
  assert(!shouldWake(night));
  assert(shouldWake({ ...night, busy: true }));
  assert(shouldWake({ ...night, now: at(6) }));
  assert(shouldWake({ ...night, enabled: false }));
});

Deno.test("nearEnoughToWake: within twice Loopy's size", () => {
  const loopy = { cx: 100, cy: 100, size: 50 };
  assert(nearEnoughToWake({ x: 100, y: 100 }, loopy));
  assert(nearEnoughToWake({ x: 199, y: 100 }, loopy));
  assert(!nearEnoughToWake({ x: 201, y: 100 }, loopy));
});

// --- the faces' order -------------------------------------------------------------------------

const NONE: FaceInputs = {
  message: null,
  thinking: false,
  voice: false,
  reaction: null,
  hot: false,
  excited: false,
  sleepy: false,
};

Deno.test("topLayer: attention > message > thinking/voice > reaction > hot > excited > sleepy > life", () => {
  assertEquals(FACE_LAYERS, [
    "attention",
    "message",
    "thinking",
    "voice",
    "reaction",
    "hot",
    "excited",
    "sleepy",
    "life",
  ]);
  const all: FaceInputs = {
    message: "attention",
    thinking: true,
    voice: true,
    reaction: "sad",
    hot: true,
    excited: true,
    sleepy: true,
  };
  // Peel the top one off each time: the next in the order shows.
  const order: string[] = [];
  let i = all;
  const peel: Record<string, Partial<FaceInputs>> = {
    attention: { message: "other" },
    message: { message: null },
    thinking: { thinking: false },
    voice: { voice: false },
    reaction: { reaction: null },
    hot: { hot: false },
    excited: { excited: false },
    sleepy: { sleepy: false },
  };
  for (;;) {
    const top = topLayer(i);
    order.push(top);
    if (top === "life") break;
    i = { ...i, ...peel[top] };
  }
  assertEquals(order, [...FACE_LAYERS]);
});

Deno.test("chooseFace: each layer's mood, the hot face and the idle life", () => {
  assertEquals(chooseFace(NONE), {
    layer: "life",
    mood: undefined,
    hot: false,
    life: true,
  });
  assertEquals(
    chooseFace({ ...NONE, reaction: "celebrate", hot: true }).mood,
    "success",
  );
  assertEquals(
    chooseFace({ ...NONE, reaction: "sad", sleepy: true }).mood,
    "sad",
  );
  assertEquals(chooseFace({ ...NONE, hot: true, excited: true }), {
    layer: "hot",
    mood: undefined,
    hot: true,
    life: false,
  });
  assertEquals(
    chooseFace({ ...NONE, excited: true, sleepy: true }).mood,
    "excited",
  );
  assertEquals(chooseFace({ ...NONE, sleepy: true }).mood, "sleepy");
  // A message brings its own mood: none from here.
  assertEquals(
    chooseFace({ ...NONE, message: "attention", reaction: "sad" }).mood,
    undefined,
  );
});

Deno.test("mayStartReaction: never over a question, a message, thinking or voice", () => {
  assert(mayStartReaction(NONE));
  assert(mayStartReaction({ ...NONE, hot: true, sleepy: true, excited: true }));
  // Another reaction playing is replaced (rate limits keep that rare).
  assert(mayStartReaction({ ...NONE, reaction: "celebrate" }));
  for (
    const over of [
      { message: "attention" as const },
      { message: "other" as const },
      { thinking: true },
      { voice: true },
    ]
  ) assert(!mayStartReaction({ ...NONE, ...over }), JSON.stringify(over));
});

Deno.test("wakesLoopy: anything above sleepy", () => {
  assert(!wakesLoopy({ ...NONE, sleepy: true }));
  for (
    const over of [
      { message: "attention" as const },
      { thinking: true },
      { voice: true },
      { reaction: "celebrate" as const },
      { hot: true },
      { excited: true },
    ]
  ) {
    assert(
      wakesLoopy({ ...NONE, sleepy: true, ...over }),
      JSON.stringify(over),
    );
  }
});

// --- settings ---------------------------------------------------------------------------------

Deno.test("sanitizeCompanion: the reactions' fields, checked and clamped", () => {
  assertEquals(
    {
      nightSleepy: DEFAULT_COMPANION.nightSleepy,
      nightFrom: DEFAULT_COMPANION.nightFrom,
      nightTo: DEFAULT_COMPANION.nightTo,
      celebrate: DEFAULT_COMPANION.celebrate,
      sad: DEFAULT_COMPANION.sad,
      reactMinS: DEFAULT_COMPANION.reactMinS,
      reactAnyCommand: DEFAULT_COMPANION.reactAnyCommand,
      reactBubble: DEFAULT_COMPANION.reactBubble,
    },
    {
      nightSleepy: true,
      nightFrom: 0,
      nightTo: 360,
      celebrate: true,
      sad: true,
      reactMinS: 20,
      reactAnyCommand: false,
      reactBubble: true,
    },
  );
  const s = sanitizeCompanion({
    nightSleepy: false,
    nightFrom: 22 * 60 + 0.4,
    nightTo: 99_999,
    celebrate: "yes",
    sad: false,
    reactMinS: 0,
    reactAnyCommand: true,
    reactBubble: false,
  });
  assertEquals(s.nightSleepy, false);
  assertEquals(s.nightFrom, 1320);
  assertEquals(s.nightTo, 1439);
  assertEquals(s.celebrate, true);
  assertEquals(s.sad, false);
  assertEquals(s.reactMinS, 1);
  assertEquals(s.reactAnyCommand, true);
  assertEquals(s.reactBubble, false);
  assertEquals(sanitizeCompanion({ reactMinS: Number.NaN }).reactMinS, 20);
});
