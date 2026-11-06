// The workspace store's half of the `+` picker: agent tiles, what plain `+` opens, the last
// pick, and their persistence; plus agent tile titles.

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  DEFAULT_SETTINGS,
  initialState,
  loadSettings,
  reduce,
  sanitizeSettings,
  saveSettings,
} from "../lib/workspace/store.ts";
import { makeTitle } from "../lib/workspace/format.ts";

const CLAUDE = { name: "claude", label: "Claude Code" };

Deno.test("add: an agent tile is titled by the tool and keeps it", () => {
  const s = reduce(initialState(), {
    type: "add",
    id: "a",
    now: 1,
    agent: CLAUDE,
  });
  assertEquals(s.terminals[0].title, "claude");
  assertEquals(s.terminals[0].agent, CLAUDE);
  const plain = reduce(initialState(), { type: "add", id: "b", now: 1 });
  assertEquals(plain.terminals[0].title, "shell");
  assertEquals("agent" in plain.terminals[0], false);
});

Deno.test("setPlusOpens and launched", () => {
  const s0 = initialState();
  assertEquals(s0.settings.plusOpens, "default");
  assertEquals(s0.settings.lastLaunch, null);
  const s1 = reduce(s0, { type: "setPlusOpens", plusOpens: "last" });
  assertEquals(s1.settings.plusOpens, "last");
  assertStrictEquals(
    reduce(s1, { type: "setPlusOpens", plusOpens: "last" }),
    s1,
  );
  const s2 = reduce(s1, { type: "setPlusOpens", plusOpens: "agent:claude" });
  assertEquals(s2.settings.plusOpens, "agent:claude");
  // Junk is the default.
  assertEquals(
    reduce(s2, { type: "setPlusOpens", plusOpens: "bogus" }).settings.plusOpens,
    "default",
  );
  const s3 = reduce(s2, { type: "launched", entryId: "ssh:web-1" });
  assertEquals(s3.settings.lastLaunch, "ssh:web-1");
  assertStrictEquals(
    reduce(s3, { type: "launched", entryId: "ssh:web-1" }),
    s3,
  );
  assertStrictEquals(reduce(s3, { type: "launched", entryId: "nope" }), s3);
});

Deno.test("plusOpens and lastLaunch persist and are sanitized", () => {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  saveSettings(
    { ...DEFAULT_SETTINGS, plusOpens: "last", lastLaunch: "agent:codex" },
    storage,
  );
  const back = sanitizeSettings(loadSettings(storage));
  assertEquals(back.plusOpens, "last");
  assertEquals(back.lastLaunch, "agent:codex");
  const junk = sanitizeSettings({ plusOpens: 7, lastLaunch: "rm -rf" });
  assertEquals(junk.plusOpens, "default");
  assertEquals(junk.lastLaunch, null);
  // Absent: the base's values stay.
  assertEquals(
    sanitizeSettings({}, { ...DEFAULT_SETTINGS, lastLaunch: "ssh:db" })
      .lastLaunch,
    "ssh:db",
  );
});

Deno.test("makeTitle: an agent tile names the tool, not its process", () => {
  assertEquals(
    makeTitle(
      { process: "2.1.319", cwd: "/Users/me/proj" },
      "/Users/me",
      "claude",
    ),
    "claude — ~/proj",
  );
  assertEquals(makeTitle({ process: "node" }, undefined, "codex"), "codex");
  assertEquals(makeTitle({ process: "zsh" }, undefined, ""), "zsh");
});
