// Where a transcript goes (lib/voice/routing.ts): the companion, the window summary, or — in dictate
// mode — typed into the focused tile with no model; plus the alert rules (lib/voice/alerts.ts).

import { assertEquals } from "@std/assert";
import {
  cleanTranscript,
  dictationText,
  isSummaryRequest,
  routeTranscript,
} from "../lib/voice/routing.ts";
import {
  anyAlertOn,
  isFailureNote,
  spokenName,
  tileAlerts,
} from "../lib/voice/alerts.ts";
import type { TileInfo } from "../lib/hub/protocol.ts";

Deno.test("routing: the companion gets what was said, dictate mode types it", () => {
  assertEquals(
    routeTranscript(" Restart the dev server. ", { dictate: false }),
    {
      kind: "companion",
      text: "Restart the dev server.",
    },
  );
  assertEquals(
    routeTranscript("Tell the Codex tile to run the tests.", {
      dictate: false,
    }),
    { kind: "companion", text: "Tell the Codex tile to run the tests." },
  );
  assertEquals(routeTranscript("git status.", { dictate: true }), {
    kind: "dictate",
    text: "git status",
  });
  // Dictate mode never asks the model, not even for the summary phrase.
  assertEquals(routeTranscript("What's going on?", { dictate: true }), {
    kind: "dictate",
    text: "What's going on?",
  });
});

Deno.test("routing: nothing heard, and Whisper's non-speech markers", () => {
  for (const raw of ["", "   ", "[BLANK_AUDIO]", "(silence)", " [Music] "]) {
    assertEquals(routeTranscript(raw, { dictate: false }), { kind: "empty" });
    assertEquals(routeTranscript(raw, { dictate: true }), { kind: "empty" });
  }
  assertEquals(cleanTranscript("[BLANK_AUDIO] ls   -la "), "ls -la");
});

Deno.test("routing: the summary phrases", () => {
  for (
    const yes of [
      "What's going on?",
      "what is going on here",
      "Summarize the window.",
      "summarise the tiles",
      "Loopy, what's happening?",
      "Hey Loopy summarize this window please",
      "Status report",
      "Give me a summary.",
    ]
  ) {
    assertEquals(isSummaryRequest(yes), true, yes);
    assertEquals(routeTranscript(yes, { dictate: false }), {
      kind: "summarize",
    });
  }
  for (
    const no of [
      "What's going on with the build in tile two?",
      "summarize the README",
      "tell codex what is going on",
    ]
  ) {
    assertEquals(isSummaryRequest(no), false, no);
  }
});

Deno.test("routing: dictation is one line, its last full stop dropped", () => {
  assertEquals(dictationText("npm test."), "npm test");
  assertEquals(dictationText("wait..."), "wait...");
  assertEquals(dictationText("echo one\ntwo"), "echo one two");
});

const tile = (
  id: string,
  status: TileInfo["status"],
  extra: Partial<TileInfo> = {},
): TileInfo => ({ id, name: id, status, unread: 0, ...extra });

const ALL = {
  alertFinished: true,
  alertPermission: true,
  alertBuildFailed: true,
};

Deno.test("alerts: finished, needs you, build failed — each behind its toggle", () => {
  const before = [
    tile("claude", "busy"),
    tile("codex-2", "busy"),
    tile("shell-3", "busy"),
  ];
  const after = [
    tile("claude", "idle"),
    tile("codex-2", "waiting"),
    tile("shell-3", "idle", { note: "build failed" }),
  ];
  assertEquals(tileAlerts(before, after, ALL).map((a) => [a.kind, a.text]), [
    ["finished", "claude finished."],
    ["permission", "codex 2 needs you."],
    ["buildFailed", "shell 3: build failed."],
  ]);
  assertEquals(
    tileAlerts(before, after, { ...ALL, alertFinished: false }).map((a) =>
      a.kind
    ),
    ["permission", "buildFailed"],
  );
  // With failures off, the failed build's tile still finished.
  assertEquals(
    tileAlerts(before, after, { ...ALL, alertBuildFailed: false }).map((a) =>
      a.kind
    ),
    ["finished", "permission", "finished"],
  );
  assertEquals(
    tileAlerts(before, after, {
      alertFinished: false,
      alertPermission: false,
      alertBuildFailed: false,
    }),
    [],
  );
});

Deno.test("alerts: no news is no alert", () => {
  // A tile seen for the first time, an unchanged one, and the same failure note again.
  assertEquals(tileAlerts([], [tile("a", "waiting")], ALL), []);
  assertEquals(tileAlerts([tile("a", "idle")], [tile("a", "idle")], ALL), []);
  assertEquals(
    tileAlerts(
      [tile("a", "idle", { note: "build failed" })],
      [tile("a", "idle", { note: "build failed" })],
      ALL,
    ),
    [],
  );
  // A note that is not a failure.
  assertEquals(
    tileAlerts(
      [tile("a", "idle")],
      [tile("a", "idle", { note: "tests pass" })],
      ALL,
    ),
    [],
  );
  assertEquals(isFailureNote("3 tests failing"), true);
  assertEquals(isFailureNote("compile error"), true);
  assertEquals(isFailureNote("all good"), false);
  assertEquals(isFailureNote(undefined), false);
  assertEquals(spokenName({ name: "codex_2" }), "codex 2");
  assertEquals(anyAlertOn({ ...ALL, alertFinished: false }), true);
});
