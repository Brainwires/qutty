import { assertEquals } from "@std/assert";
import {
  commandForKey,
  detectPlatform,
  isModifierRelease,
  type KeyLike,
  shortcutLabel,
} from "../lib/workspace/keys.ts";
import { formatAge, makeTitle, shortenPath } from "../lib/workspace/format.ts";

function key(code: string, mods: Partial<KeyLike> = {}): KeyLike {
  return {
    key: "",
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}
const cmd = (code: string, mods: Partial<KeyLike> = {}) =>
  commandForKey(key(code, { metaKey: true, ...mods }), "mac");
const ctrl = (code: string, mods: Partial<KeyLike> = {}) =>
  commandForKey(key(code, { ctrlKey: true, ...mods }), "other");

Deno.test("macOS shortcuts use ⌘", () => {
  assertEquals(cmd("KeyT"), { kind: "newTerminal" });
  assertEquals(cmd("KeyW"), { kind: "closeFocused" });
  assertEquals(cmd("Digit1"), { kind: "focusOrdinal", ordinal: 1 });
  assertEquals(cmd("Digit9"), { kind: "focusOrdinal", ordinal: 9 });
  assertEquals(
    cmd("Digit0"),
    { kind: "fontSizeReset" },
    "⌘0 is not an ordinal",
  );
  assertEquals(cmd("BracketRight"), { kind: "cycle", dir: 1 });
  assertEquals(cmd("BracketLeft"), { kind: "cycle", dir: -1 });
  assertEquals(cmd("Backquote"), { kind: "focusPrevious" });
  assertEquals(cmd("Enter"), { kind: "toggleMonocle" });
  assertEquals(cmd("KeyL", { shiftKey: true }), { kind: "cyclePattern" });
  assertEquals(cmd("KeyB", { shiftKey: true }), { kind: "cycleBarPosition" });
});

Deno.test("keys that are not shortcuts reach the PTY", () => {
  assertEquals(cmd("KeyT", { shiftKey: true }), null, "⌘⇧T is not ours");
  assertEquals(cmd("KeyC"), null, "⌘C (copy) is left alone");
  assertEquals(cmd("KeyT", { altKey: true }), null);
  assertEquals(
    cmd("KeyT", { ctrlKey: true }),
    null,
    "⌘+Ctrl is not the plain modifier",
  );
  assertEquals(
    commandForKey(key("KeyT", { ctrlKey: true }), "mac"),
    null,
    "Ctrl+T on macOS goes to the shell",
  );
  assertEquals(commandForKey(key("KeyT"), "mac"), null);
  assertEquals(
    commandForKey(key("Enter"), "mac"),
    null,
    "plain Enter is input",
  );
});

Deno.test("other platforms use Ctrl", () => {
  assertEquals(ctrl("KeyT"), { kind: "newTerminal" });
  assertEquals(ctrl("BracketRight"), { kind: "cycle", dir: 1 });
  assertEquals(ctrl("KeyL", { shiftKey: true }), { kind: "cyclePattern" });
  assertEquals(commandForKey(key("KeyT", { metaKey: true }), "other"), null);
  assertEquals(ctrl("KeyT", { metaKey: true }), null);
});

Deno.test("modifier release and platform detection", () => {
  assertEquals(isModifierRelease({ key: "Meta" }, "mac"), true);
  assertEquals(isModifierRelease({ key: "Control" }, "mac"), false);
  assertEquals(isModifierRelease({ key: "Control" }, "other"), true);
  assertEquals(detectPlatform({ platform: "MacIntel" }), "mac");
  assertEquals(
    detectPlatform({ platform: "Win32", userAgent: "Windows NT" }),
    "other",
  );
  assertEquals(
    detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; …)" }),
    "mac",
  );
  assertEquals(detectPlatform({}), "other");
  assertEquals(shortcutLabel("Mod+Shift+L", "mac"), "⌘⇧L");
  assertEquals(shortcutLabel("Mod+Shift+L", "other"), "Ctrl+Shift+L");
});

Deno.test("formatAge / shortenPath / makeTitle", () => {
  const t = 1_000_000;
  assertEquals(formatAge(t + 3_000, t), "just now");
  assertEquals(formatAge(t + 42_000, t), "42s ago");
  assertEquals(formatAge(t + 130_000, t), "2m ago");
  assertEquals(formatAge(t + 3_700_000, t), "1h ago");
  assertEquals(formatAge(t + 200_000_000, t), "2d ago");
  assertEquals(
    formatAge(t - 5, t),
    "just now",
    "clock skew never goes negative",
  );

  assertEquals(shortenPath("/Users/me", "/Users/me"), "~");
  assertEquals(shortenPath("/Users/me/Source", "/Users/me"), "~/Source");
  assertEquals(shortenPath("/Users/me/a/b/c/d", "/Users/me"), "~/…/c/d");
  assertEquals(
    shortenPath("/Users/meow/x", "/Users/me"),
    "…/meow/x",
    "a sibling prefix is not home",
  );
  assertEquals(shortenPath("/etc", undefined), "/etc");
  assertEquals(shortenPath("/", undefined), "/");
  assertEquals(shortenPath("/usr/local/bin", "/"), "…/local/bin");

  assertEquals(
    makeTitle({ process: "zsh", cwd: "/Users/me/Source" }, "/Users/me"),
    "zsh — ~/Source",
  );
  assertEquals(makeTitle({ process: "vim" }), "vim");
  assertEquals(makeTitle({ process: "  " }), "shell");
});

Deno.test("font size shortcuts: Mod+= / Mod++ / Mod+- / Mod+0 on mac and other", () => {
  for (const press of [cmd, ctrl]) {
    assertEquals(press("Equal"), { kind: "fontSize", dir: 1 }, "Mod+=");
    assertEquals(
      press("Equal", { shiftKey: true }),
      { kind: "fontSize", dir: 1 },
      "Mod++ (Shift+=)",
    );
    assertEquals(press("NumpadAdd"), { kind: "fontSize", dir: 1 });
    assertEquals(press("Minus"), { kind: "fontSize", dir: -1 }, "Mod+-");
    assertEquals(press("NumpadSubtract"), { kind: "fontSize", dir: -1 });
    assertEquals(press("Digit0"), { kind: "fontSizeReset" }, "Mod+0");
    assertEquals(press("Numpad0"), { kind: "fontSizeReset" });
    assertEquals(press("Minus", { shiftKey: true }), null, "Mod+_ is not ours");
    assertEquals(
      press("Digit0", { shiftKey: true }),
      null,
      "Mod+) is not ours",
    );
    assertEquals(press("Equal", { altKey: true }), null);
  }
  // The other platform's modifier does not trigger them.
  assertEquals(commandForKey(key("Equal", { ctrlKey: true }), "mac"), null);
  assertEquals(commandForKey(key("Minus", { metaKey: true }), "other"), null);
  assertEquals(commandForKey(key("Digit0"), "other"), null, "bare 0 types 0");
  assertEquals(shortcutLabel("Mod+=", "mac"), "⌘=");
  assertEquals(shortcutLabel("Mod+-", "other"), "Ctrl+-");
  assertEquals(shortcutLabel("Mod+0", "other"), "Ctrl+0");
});
