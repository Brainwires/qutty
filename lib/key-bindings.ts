/**
 * Honor the user's macOS key bindings (`~/Library/KeyBindings/DefaultKeyBinding.dict`) inside
 * the terminal.
 *
 * That file remaps keys for every native text field on the system (e.g. ⌘⌫ →
 * `deleteToBeginningOfLine:`), but a terminal in a web view never sees it, and xterm.js drops ⌘
 * combinations entirely. So the app reads the file, and for each key the user bound to a
 * text-system action that has a shell equivalent, sends that equivalent (readline / zle default
 * emacs bindings, which every common shell and line editor understands). Keys the user did not
 * bind, and actions with no terminal meaning (selection, document-level moves), pass through to
 * xterm.js unchanged. Nothing is bound that the user did not bind.
 *
 * @module
 */

import type { KeyLike } from "./workspace/keys.ts";

/** Cocoa text-system action → bytes for the shell. */
const ACTIONS: Record<string, string> = {
  "deleteBackward:": "\x7f",
  "deleteForward:": "\x1b[3~",
  "deleteWordBackward:": "\x1b\x7f",
  "deleteWordForward:": "\x1bd",
  "deleteToBeginningOfLine:": "\x15",
  "deleteToBeginningOfParagraph:": "\x15",
  "deleteToEndOfLine:": "\x0b",
  "deleteToEndOfParagraph:": "\x0b",
  "moveToBeginningOfLine:": "\x01",
  "moveToLeftEndOfLine:": "\x01",
  "moveToBeginningOfParagraph:": "\x01",
  "moveToEndOfLine:": "\x05",
  "moveToRightEndOfLine:": "\x05",
  "moveToEndOfParagraph:": "\x05",
  "moveWordBackward:": "\x1bb",
  "moveWordLeft:": "\x1bb",
  "moveWordForward:": "\x1bf",
  "moveWordRight:": "\x1bf",
  "moveBackward:": "\x1b[D",
  "moveLeft:": "\x1b[D",
  "moveForward:": "\x1b[C",
  "moveRight:": "\x1b[C",
  "moveUp:": "\x1b[A",
  "moveDown:": "\x1b[B",
  "pageUp:": "\x1b[5~",
  "scrollPageUp:": "\x1b[5~",
  "pageDown:": "\x1b[6~",
  "scrollPageDown:": "\x1b[6~",
  "insertNewline:": "\r",
  "insertTab:": "\t",
  "cancelOperation:": "\x1b",
  "transpose:": "\x14",
  "yank:": "\x19",
};

/** Cocoa function-key characters (NSUpArrowFunctionKey…) and control chars → `KeyboardEvent.key`. */
const KEY_NAMES: Record<string, string> = {
  "": "ArrowUp",
  "": "ArrowDown",
  "": "ArrowLeft",
  "": "ArrowRight",
  "": "Delete",
  "": "Home",
  "": "End",
  "": "PageUp",
  "": "PageDown",
  "\x7f": "Backspace",
  "\x08": "Backspace",
  "\r": "Enter",
  "\n": "Enter",
  "\x03": "Enter",
  "\t": "Tab",
  "\x1b": "Escape",
};
for (let i = 1; i <= 12; i++) {
  KEY_NAMES[String.fromCharCode(0xf703 + i)] = `F${i}`;
}

interface Binding {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  data: string;
}

/** The user's bindings that have a terminal meaning. */
export interface KeyBindings {
  readonly bindings: readonly Binding[];
}

export const NO_KEY_BINDINGS: KeyBindings = { bindings: [] };

// ---------------------------------------------------------------------------------------------
// OpenStep (old-style) property list parser: just what DefaultKeyBinding.dict uses.
// ---------------------------------------------------------------------------------------------

type PlistValue = string | PlistValue[] | { [k: string]: PlistValue };

class PlistParser {
  #i = 0;
  constructor(private readonly s: string) {}

  parse(): PlistValue {
    const v = this.#value();
    this.#ws();
    if (this.#i < this.s.length) this.#fail("trailing content");
    return v;
  }

  #fail(what: string): never {
    throw new SyntaxError(`key bindings: ${what} at offset ${this.#i}`);
  }

  #ws(): void {
    const s = this.s;
    while (this.#i < s.length) {
      const c = s[this.#i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.#i++;
      else if (s.startsWith("//", this.#i)) {
        const nl = s.indexOf("\n", this.#i);
        this.#i = nl < 0 ? s.length : nl + 1;
      } else if (s.startsWith("/*", this.#i)) {
        const end = s.indexOf("*/", this.#i + 2);
        if (end < 0) this.#fail("unterminated comment");
        this.#i = end + 2;
      } else break;
    }
  }

  #value(): PlistValue {
    this.#ws();
    const c = this.s[this.#i];
    if (c === "{") return this.#dict();
    if (c === "(") return this.#array();
    if (c === '"') return this.#quoted();
    return this.#bare();
  }

  #expect(ch: string): void {
    this.#ws();
    if (this.s[this.#i] !== ch) this.#fail(`expected '${ch}'`);
    this.#i++;
  }

  #dict(): { [k: string]: PlistValue } {
    this.#expect("{");
    const out: { [k: string]: PlistValue } = {};
    for (;;) {
      this.#ws();
      if (this.s[this.#i] === "}") {
        this.#i++;
        return out;
      }
      const key = this.#value();
      if (typeof key !== "string") {
        this.#fail("dictionary key must be a string");
      }
      this.#expect("=");
      out[key] = this.#value();
      this.#expect(";");
    }
  }

  #array(): PlistValue[] {
    this.#expect("(");
    const out: PlistValue[] = [];
    for (;;) {
      this.#ws();
      if (this.s[this.#i] === ")") {
        this.#i++;
        return out;
      }
      out.push(this.#value());
      this.#ws();
      if (this.s[this.#i] === ",") this.#i++;
    }
  }

  #quoted(): string {
    const s = this.s;
    this.#i++;
    let out = "";
    while (this.#i < s.length) {
      const c = s[this.#i++];
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = s[this.#i++];
      if (e === "U" || e === "u") {
        const hex = s.slice(this.#i, this.#i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.#fail("bad \\U escape");
        out += String.fromCharCode(parseInt(hex, 16));
        this.#i += 4;
      } else if (/[0-7]/.test(e)) {
        let oct = e;
        while (oct.length < 3 && /[0-7]/.test(s[this.#i] ?? "")) {
          oct += s[this.#i++];
        }
        out += String.fromCharCode(parseInt(oct, 8));
      } else {
        out += {
          n: "\n",
          t: "\t",
          r: "\r",
          b: "\b",
          f: "\f",
          a: "\x07",
          v: "\v",
        }[e] ?? e;
      }
    }
    this.#fail("unterminated string");
  }

  #bare(): string {
    const m = /^[A-Za-z0-9_$+\/:.\-]+/.exec(this.s.slice(this.#i));
    if (!m) this.#fail("unexpected character");
    this.#i += m[0].length;
    return m[0];
  }
}

/** Parse an OpenStep-format property list (throws `SyntaxError` on malformed input). */
export function parseOpenStepPlist(text: string): PlistValue {
  return new PlistParser(text).parse();
}

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

/** `"@\U007F"` → ⌘ + Backspace. Modifier prefixes: ^ ctrl, ~ option, $ shift, @ cmd, # keypad. */
function parseKeySpec(spec: string): Omit<Binding, "data"> | null {
  let i = 0;
  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  while (i < spec.length - 1 && "^~$@#".includes(spec[i])) {
    const m = spec[i++];
    if (m === "^") mods.ctrl = true;
    else if (m === "~") mods.alt = true;
    else if (m === "$") mods.shift = true;
    else if (m === "@") mods.meta = true;
  }
  const ch = spec.slice(i);
  if ([...ch].length !== 1) return null;
  const named = KEY_NAMES[ch];
  if (named) return { key: named, ...mods };
  // A letter: an upper-case one implies Shift (Cocoa matches the produced character).
  if (/^[A-Z]$/.test(ch)) {
    return { key: ch.toLowerCase(), ...mods, shift: true };
  }
  if (ch < " " || (ch >= "" && ch <= "")) return null;
  return { key: ch.toLowerCase(), ...mods };
}

function actionData(action: PlistValue): string | null {
  if (typeof action === "string") return ACTIONS[action] ?? null;
  if (Array.isArray(action) && action.length > 0) {
    // A macro of several actions: honored only when every step has a terminal meaning.
    let out = "";
    for (const a of action) {
      const d = typeof a === "string" ? ACTIONS[a] : undefined;
      if (d === undefined) return null;
      out += d;
    }
    return out;
  }
  return null; // a nested dictionary (multi-key sequence): not supported
}

/** Compile the user's DefaultKeyBinding.dict text. Malformed files yield no bindings. */
export function compileKeyBindings(
  text: string | null | undefined,
): KeyBindings {
  if (!text) return NO_KEY_BINDINGS;
  let dict: PlistValue;
  try {
    dict = parseOpenStepPlist(text);
  } catch {
    return NO_KEY_BINDINGS;
  }
  if (typeof dict !== "object" || Array.isArray(dict)) return NO_KEY_BINDINGS;
  const bindings: Binding[] = [];
  for (const [spec, action] of Object.entries(dict)) {
    const key = parseKeySpec(spec);
    const data = actionData(action);
    if (key && data !== null) bindings.push({ ...key, data });
  }
  return { bindings };
}

/** The bytes the user's bindings send for this keydown, or `null` to let xterm.js handle it. */
export function keyBindingData(kb: KeyBindings, e: KeyLike): string | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const b of kb.bindings) {
    if (
      b.key === key && b.ctrl === e.ctrlKey && b.alt === e.altKey &&
      b.shift === e.shiftKey && b.meta === e.metaKey
    ) {
      return b.data;
    }
  }
  return null;
}
