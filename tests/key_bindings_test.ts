import { assertEquals, assertThrows } from "@std/assert";
import {
  compileKeyBindings,
  keyBindingData,
  parseOpenStepPlist,
} from "../lib/key-bindings.ts";
import type { KeyLike } from "../lib/workspace/keys.ts";

function key(k: string, mods: Partial<KeyLike> = {}): KeyLike {
  return {
    key: k,
    code: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

// A DefaultKeyBinding.dict like a real user's (comments, \U escapes, modifier prefixes).
const USER_DICT = String.raw`{
    /* Home / End -> start / end of LINE (Windows/Linux style) */
    "\UF729"      = "moveToBeginningOfLine:";                     /* Home */
    "\UF72B"      = "moveToEndOfLine:";                           /* End  */
    "$\UF729"     = "moveToBeginningOfLineAndModifySelection:";   /* Shift + Home */
    "^\UF729"     = "moveToBeginningOfDocument:";                 /* Ctrl + Home */
    // Word / line delete
    "~\U007F"     = "deleteWordBackward:";
    "@\U007F"     = "deleteToBeginningOfLine:";
    "@~\UF702"    = ("moveToBeginningOfLine:", "deleteToEndOfLine:");
    "^w"          = ("selectWord:", "delete:");
    "^x"          = { "^s" = "save:"; };
    "@K"          = deleteToEndOfLine:;
}`;

Deno.test("key bindings: parses OpenStep plists", () => {
  assertEquals(
    parseOpenStepPlist(
      `{ a = b; "c d" = ("x", y); e = { f = "\\U0041\\n"; }; }`,
    ),
    {
      a: "b",
      "c d": ["x", "y"],
      e: { f: "A\n" },
    },
  );
  assertThrows(() => parseOpenStepPlist(`{ a = b `), SyntaxError);
  assertThrows(() => parseOpenStepPlist(`{ a = "unterminated; }`), SyntaxError);
  assertThrows(() => parseOpenStepPlist(`{ /* never closed }`), SyntaxError);
});

Deno.test("key bindings: the user's bound keys send their shell equivalents", () => {
  const kb = compileKeyBindings(USER_DICT);
  assertEquals(keyBindingData(kb, key("Backspace", { metaKey: true })), "\x15");
  assertEquals(
    keyBindingData(kb, key("Backspace", { altKey: true })),
    "\x1b\x7f",
  );
  assertEquals(keyBindingData(kb, key("Home")), "\x01");
  assertEquals(keyBindingData(kb, key("End")), "\x05");
  // A macro whose every step has a terminal meaning.
  assertEquals(
    keyBindingData(kb, key("ArrowLeft", { metaKey: true, altKey: true })),
    "\x01\x0b",
  );
  // An upper-case letter implies Shift.
  assertEquals(
    keyBindingData(kb, key("K", { metaKey: true, shiftKey: true })),
    "\x0b",
  );
  assertEquals(keyBindingData(kb, key("k", { metaKey: true })), null);
});

Deno.test("key bindings: nothing the user did not bind, nothing without a terminal meaning", () => {
  const kb = compileKeyBindings(USER_DICT);
  // Selection and document moves have no shell equivalent: xterm handles the key as usual.
  assertEquals(keyBindingData(kb, key("Home", { shiftKey: true })), null);
  assertEquals(keyBindingData(kb, key("Home", { ctrlKey: true })), null);
  // Macros with an untranslatable step, and multi-key sequences, are skipped.
  assertEquals(keyBindingData(kb, key("w", { ctrlKey: true })), null);
  assertEquals(keyBindingData(kb, key("x", { ctrlKey: true })), null);
  // Unbound keys and modifier combinations pass through.
  assertEquals(keyBindingData(kb, key("Backspace")), null);
  assertEquals(
    keyBindingData(kb, key("Backspace", { metaKey: true, shiftKey: true })),
    null,
  );
  assertEquals(keyBindingData(kb, key("c", { metaKey: true })), null);
  assertEquals(keyBindingData(kb, key("ArrowLeft", { metaKey: true })), null);
});

Deno.test("key bindings: a missing or malformed file binds nothing", () => {
  for (const text of [null, undefined, "", "{ broken", "(a, b)", "plain"]) {
    assertEquals(compileKeyBindings(text).bindings.length, 0);
  }
});
