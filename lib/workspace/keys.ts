/**
 * Keyboard shortcuts → workspace commands. Pure: takes the few fields of a `KeyboardEvent` it
 * needs, so it is testable without a DOM and shareable between the window listener (which
 * dispatches) and xterm's custom key handler (which must only *decline* these keys).
 *
 * macOS uses ⌘ (`metaKey`); other platforms use Ctrl. Everything not matched here goes to the
 * PTY.
 *
 * @module
 */

import type { PttKey } from "../voice/settings.ts";

/** A command a shortcut maps to. */
export type KeyCommand =
  | { kind: "newTerminal" }
  | { kind: "closeFocused" }
  | { kind: "focusOrdinal"; ordinal: number }
  | { kind: "cycle"; dir: 1 | -1 }
  | { kind: "focusPrevious" }
  | { kind: "cyclePattern" }
  | { kind: "cycleBarPosition" }
  | { kind: "toggleMonocle" }
  | { kind: "fontSize"; dir: 1 | -1 }
  | { kind: "fontSizeReset" }
  | { kind: "openConnections" }
  | { kind: "toggleBroadcast" };

/** The subset of `KeyboardEvent` the mapping reads. */
export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Which modifier scheme to use. */
export type KeyPlatform = "mac" | "other";

/** Detect the platform from `navigator` (defaults to `other` outside a browser). */
export function detectPlatform(
  nav: { platform?: string; userAgent?: string } | undefined =
    globalThis.navigator,
): KeyPlatform {
  const p = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(p) ? "mac" : "other";
}

/** Whether the platform's primary shortcut modifier (and no other confusing one) is held. */
function hasMod(e: KeyLike, platform: KeyPlatform): boolean {
  if (e.altKey) return false;
  return platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

const DIGIT = /^Digit([1-9])$/;

/**
 * The command for a keydown, or `null` when the key is not a workspace shortcut.
 *
 * - Mod+T new terminal, Mod+W close focused
 * - Mod+1..9 focus by switcher-bar ordinal
 * - Mod+] / Mod+[ cycle MRU forward / back (alt-tab style); Mod+` jumps to the previous terminal
 * - Mod+Shift+L cycle pattern, Mod+Shift+B cycle bar position
 * - Mod+Shift+O the SSH connection manager
 * - Mod+Shift+I broadcast input to the selected tiles (on / off)
 * - Mod+Enter toggle monocle
 * - Mod+= / Mod++ bigger font, Mod+- smaller, Mod+0 default size (numpad keys too)
 */
export function commandForKey(
  e: KeyLike,
  platform: KeyPlatform,
): KeyCommand | null {
  if (!hasMod(e, platform)) return null;
  const code = e.code;
  // Mod++ is Shift+Equal on most layouts, so the font keys come before the Shift branch.
  if (code === "Equal" || code === "NumpadAdd") {
    return { kind: "fontSize", dir: 1 };
  }
  if (!e.shiftKey) {
    if (code === "Minus" || code === "NumpadSubtract") {
      return { kind: "fontSize", dir: -1 };
    }
    if (code === "Digit0" || code === "Numpad0") {
      return { kind: "fontSizeReset" };
    }
  }
  if (e.shiftKey) {
    if (code === "KeyL") return { kind: "cyclePattern" };
    if (code === "KeyB") return { kind: "cycleBarPosition" };
    if (code === "KeyO") return { kind: "openConnections" };
    if (code === "KeyI") return { kind: "toggleBroadcast" };
    return null;
  }
  switch (code) {
    case "KeyT":
      return { kind: "newTerminal" };
    case "KeyW":
      return { kind: "closeFocused" };
    case "BracketRight":
      return { kind: "cycle", dir: 1 };
    case "BracketLeft":
      return { kind: "cycle", dir: -1 };
    case "Backquote":
      return { kind: "focusPrevious" };
    case "Enter":
    case "NumpadEnter":
      return { kind: "toggleMonocle" };
  }
  const m = DIGIT.exec(code);
  if (m) return { kind: "focusOrdinal", ordinal: Number(m[1]) };
  return null;
}

/** Whether a keyup releases the primary modifier (which ends an alt-tab style cycle). */
export function isModifierRelease(
  e: { key: string },
  platform: KeyPlatform,
): boolean {
  return platform === "mac" ? e.key === "Meta" : e.key === "Control";
}

/** The shortcut's human label, e.g. `⌘T` or `Ctrl+Shift+L`. */
export function shortcutLabel(keys: string, platform: KeyPlatform): string {
  const parts = keys.split("+");
  if (platform === "mac") {
    return parts.map((p) => p === "Mod" ? "⌘" : p === "Shift" ? "⇧" : p).join(
      "",
    );
  }
  return parts.map((p) => p === "Mod" ? "Ctrl" : p).join("+");
}

/** The `KeyboardEvent.code` of each push-to-talk choice's key. */
const PTT_CODES: Record<Exclude<PttKey, "off">, string> = {
  "Mod+Shift+M": "KeyM",
  "Mod+Shift+K": "KeyK",
  "Mod+Shift+Space": "Space",
};

/**
 * Whether push-to-talk `key` can be used on `platform`: never a key the terminal receives. Every
 * choice is Mod+Shift+<key>, the app's shortcut space (like Mod+Shift+L), and none collides with
 * {@linkcode commandForKey}. Ctrl+Shift+Space reaches a terminal as NUL off macOS, so Space is
 * macOS only (⌘ never reaches the terminal there).
 */
export function pttAvailable(key: PttKey, platform: KeyPlatform): boolean {
  if (key === "off") return false;
  return key !== "Mod+Shift+Space" || platform === "mac";
}

/** Whether a keydown is the push-to-talk shortcut `key` (held: a repeat is still it). */
export function isPushToTalk(
  e: KeyLike,
  key: PttKey,
  platform: KeyPlatform,
): boolean {
  if (!pttAvailable(key, platform)) return false;
  return hasMod(e, platform) && e.shiftKey &&
    e.code === PTT_CODES[key as Exclude<PttKey, "off">];
}

/**
 * Whether a keyup ends a push-to-talk hold of `key`: its own key, Shift or the primary modifier
 * let go.
 */
export function isPushToTalkRelease(
  e: { key: string; code: string },
  key: PttKey,
  platform: KeyPlatform,
): boolean {
  if (!pttAvailable(key, platform)) return false;
  return e.code === PTT_CODES[key as Exclude<PttKey, "off">] ||
    e.key === "Shift" || isModifierRelease(e, platform);
}
