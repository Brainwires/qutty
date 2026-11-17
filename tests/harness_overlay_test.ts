// The harness overlay's logic (lib/workspace/harness.ts): which harness a tile runs, what the
// prompt box types for a prompt (bracketed or plain, trailing line breaks as Enter), the
// interrupt key, attached files, and the screen as text to read aloud.

import { assertEquals } from "@std/assert";
import {
  detectHarness,
  harnessSpec,
  isShellProcess,
  promptChunks,
  speakableScreen,
  withFiles,
} from "../lib/workspace/harness.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";

const id = (s: ReturnType<typeof detectHarness>) => s?.id ?? null;

Deno.test("detectHarness: the hub's registration names the harness", () => {
  assertEquals(id(detectHarness({ hubHarness: "codex" })), "codex");
  // The hub wins over the process name.
  assertEquals(
    id(detectHarness({ hubHarness: "claude", process: "node" })),
    "claude",
  );
  // A harness Qutty has no look for still gets a plain one, named as the + menu names it.
  assertEquals(detectHarness({ hubHarness: "hermes" }), {
    id: "hermes",
    label: "Hermes Agent",
    glyph: "◆",
    interrupt: "\x1b",
  });
});

Deno.test("detectHarness: the agent tool a tile was launched as", () => {
  assertEquals(id(detectHarness({ agent: "claude" })), "claude");
  // An Ollama pair's tile: "claude · qwen3:8b".
  assertEquals(id(detectHarness({ agent: "codex · qwen3:8b" })), "codex");
});

Deno.test("detectHarness: the foreground process and the program's title", () => {
  assertEquals(id(detectHarness({ process: "claude" })), "claude");
  assertEquals(id(detectHarness({ process: "/opt/bin/gemini" })), "gemini");
  assertEquals(id(detectHarness({ process: "aider" })), "aider");
  assertEquals(id(detectHarness({ process: "opencode" })), "opencode");
  // Claude Code installed with npm runs as node; its title gives it away.
  assertEquals(
    id(detectHarness({ process: "node", programTitle: "✳ Claude Code" })),
    "claude",
  );
  assertEquals(detectHarness({ process: "node" }), null);
  assertEquals(
    detectHarness({ process: "vim", programTitle: "notes.md" }),
    null,
  );
  assertEquals(detectHarness({}), null);
});

Deno.test("detectHarness: a shell in the foreground or an exited tile means it has exited", () => {
  // The hub keeps a tile's harness after the harness quit back to the shell.
  assertEquals(detectHarness({ hubHarness: "claude", process: "zsh" }), null);
  assertEquals(detectHarness({ hubHarness: "claude", process: "-zsh" }), null);
  assertEquals(
    detectHarness({ process: "bash", programTitle: "Claude Code" }),
    null,
  );
  assertEquals(detectHarness({ agent: "claude", exited: true }), null);
  assertEquals(isShellProcess("/bin/fish"), true);
  assertEquals(isShellProcess("claude"), false);
});

Deno.test("detectHarness: an SSH tile goes by the hub alone (its process is always ssh)", () => {
  assertEquals(
    detectHarness({ ssh: true, process: "ssh", programTitle: "Claude Code" }),
    null,
  );
  assertEquals(
    id(detectHarness({ ssh: true, process: "ssh", hubHarness: "claude" })),
    "claude",
  );
});

Deno.test("harnessSpec: the interrupt key per harness", () => {
  assertEquals(harnessSpec("claude").interrupt, "\x1b");
  assertEquals(harnessSpec("codex").interrupt, "\x1b");
  assertEquals(harnessSpec("aider").interrupt, "\x03");
  assertEquals(harnessSpec("Claude").label, "Claude Code");
});

Deno.test("promptChunks: bracketed paste wraps the text; Enter goes on its own", () => {
  assertEquals(promptChunks("fix the build", true), [
    "\x1b[200~fix the build\x1b[201~",
    "\r",
  ]);
  // Line breaks inside are pasted as xterm pastes them (carriage returns), not sent as Enter.
  assertEquals(promptChunks("one\ntwo\r\nthree", true), [
    "\x1b[200~one\rtwo\rthree\x1b[201~",
    "\r",
  ]);
});

Deno.test("promptChunks: plain mode types the text as is", () => {
  assertEquals(promptChunks("fix the build", false), ["fix the build", "\r"]);
  assertEquals(promptChunks("a\nb", false), ["a\rb", "\r"]);
});

Deno.test("promptChunks: a trailing line break is the Enter, never text", () => {
  for (const text of ["ls\n", "ls\r\n", "ls\r", "ls\\r", "ls\\n", "ls\n\n"]) {
    assertEquals(
      promptChunks(text, true),
      ["\x1b[200~ls\x1b[201~", "\r"],
      text,
    );
    assertEquals(promptChunks(text, false), ["ls", "\r"], text);
  }
  // An escaped backslash before the r is text.
  assertEquals(promptChunks("a\\\\r", false), ["a\\\\r", "\r"]);
  assertEquals(promptChunks("", true), ["\r"]);
  assertEquals(promptChunks("\n", false), ["\r"]);
});

Deno.test("promptChunks: paste markers inside the text cannot end the paste", () => {
  assertEquals(promptChunks("a\x1b[201~b", true), [
    "\x1b[200~ab\x1b[201~",
    "\r",
  ]);
});

Deno.test("withFiles: text files after the prompt, fenced", () => {
  assertEquals(withFiles("look at this", []), "look at this");
  assertEquals(
    withFiles("review", [{ name: "a.ts", text: "let x = 1;\n" }]),
    "review\n\na.ts:\n```\nlet x = 1;\n```",
  );
  assertEquals(
    withFiles("", [{ name: "r.md", text: "```js\n```" }]),
    "r.md:\n````\n```js\n```\n````",
  );
});

Deno.test("speakableScreen: frames and blank lines go", () => {
  assertEquals(
    speakableScreen(
      "╭──────────╮\n│ > hello  │\n╰──────────╯\n\n● Done.   Tests pass.\n  ⎿ 3 files\n─────",
    ),
    "> hello\n● Done. Tests pass.\n⎿ 3 files",
  );
});

Deno.test("store: the overlay setting (on by default), a tile's own choice, the process", () => {
  assertEquals(DEFAULT_SETTINGS.harnessOverlay, true);
  assertEquals(
    sanitizeSettings({ harnessOverlay: false }).harnessOverlay,
    false,
  );
  assertEquals(sanitizeSettings({ harnessOverlay: "no" }).harnessOverlay, true);
  let s = reduce(initialState(), { type: "add", id: "t1", now: 1 });
  s = reduce(s, { type: "setHarnessOverlay", on: false });
  assertEquals(s.settings.harnessOverlay, false);
  s = reduce(s, { type: "setGuiOverlay", id: "t1", on: true });
  assertEquals(s.terminals[0].guiOverlay, true);
  s = reduce(s, { type: "setGuiOverlay", id: "t1", on: undefined });
  assertEquals(s.terminals[0].guiOverlay, undefined);
  s = reduce(s, {
    type: "title",
    id: "t1",
    title: "claude — ~/src",
    process: "claude",
  });
  assertEquals(s.terminals[0].process, "claude");
  assertEquals(s.terminals[0].title, "claude — ~/src");
  // A title without a process keeps the last one.
  s = reduce(s, { type: "title", id: "t1", title: "x" });
  assertEquals(s.terminals[0].process, "claude");
});
