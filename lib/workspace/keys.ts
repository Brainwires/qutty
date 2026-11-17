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

/**
 * A browser command, for the focused web tile (app/web-tile.tsx `runWebCommand`): the keys of
 * Safari and Chrome, with Ctrl in place of ⌘ off macOS.
 */
export type WebKeyCommand =
  | { kind: "focusAddress" }
  | { kind: "reload"; ignoreCache: boolean }
  | { kind: "stop" }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "bookmark" }
  | { kind: "find" }
  | { kind: "findNext"; dir: 1 | -1 }
  | { kind: "zoom"; dir: 1 | -1 }
  | { kind: "zoomReset" }
  | { kind: "print" }
  | { kind: "devTools" };

/**
 * The browser command for a keydown, or `null`:
 *
 * - Mod+L the address field; Mod+R reload, Mod+Shift+R reload past the cache; ⌘. stop (macOS)
 * - Mod+[ / Mod+] back / forward (Safari's keys; over a web tile they win over the tile cycle)
 * - Mod+D bookmark the page; Mod+F find, Mod+G / Mod+Shift+G the next / previous match
 * - Mod+= / Mod++ zoom in, Mod+- zoom out, Mod+0 actual size (numpad keys too)
 * - Mod+P print; Mod+Alt+I the developer tools
 */
export function webCommandForKey(
  e: KeyLike,
  platform: KeyPlatform,
): WebKeyCommand | null {
  const mod = platform === "mac"
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  const code = e.code;
  if (e.altKey) {
    return code === "KeyI" && !e.shiftKey ? { kind: "devTools" } : null;
  }
  if (code === "Equal" || code === "NumpadAdd") return { kind: "zoom", dir: 1 };
  if (e.shiftKey) {
    if (code === "KeyR") return { kind: "reload", ignoreCache: true };
    if (code === "KeyG") return { kind: "findNext", dir: -1 };
    return null;
  }
  switch (code) {
    case "Minus":
    case "NumpadSubtract":
      return { kind: "zoom", dir: -1 };
    case "Digit0":
    case "Numpad0":
      return { kind: "zoomReset" };
    case "KeyL":
      return { kind: "focusAddress" };
    case "KeyR":
      return { kind: "reload", ignoreCache: false };
    case "Period":
      return platform === "mac" ? { kind: "stop" } : null;
    case "BracketLeft":
      return { kind: "back" };
    case "BracketRight":
      return { kind: "forward" };
    case "KeyD":
      return { kind: "bookmark" };
    case "KeyF":
      return { kind: "find" };
    case "KeyG":
      return { kind: "findNext", dir: 1 };
    case "KeyP":
      return { kind: "print" };
  }
  return null;
}

/** A keydown routed: to the focused web tile, or to the workspace. */
export type RoutedKey =
  | { scope: "web"; cmd: WebKeyCommand }
  | { scope: "workspace"; cmd: KeyCommand };

/**
 * Where a keydown goes, by the focused tile's type: over a web tile its browser keys come first
 * (so Mod+[ / Mod+] go back and forward there, and Mod+= zooms the page, not the terminals'
 * font), and every other workspace shortcut works as everywhere (Mod+T, Mod+W, Mod+1..9…).
 * `null`: not a shortcut (the terminal or the page has it).
 */
export function routeKey(
  e: KeyLike,
  platform: KeyPlatform,
  webFocused: boolean,
): RoutedKey | null {
  if (webFocused) {
    const cmd = webCommandForKey(e, platform);
    if (cmd) return { scope: "web", cmd };
  }
  const cmd = commandForKey(e, platform);
  return cmd ? { scope: "workspace", cmd } : null;
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

/**
 * Whether the hold-to-dictate key `dictateKey` can be used on `platform` beside push-to-talk key
 * `pttKey`: one of the push-to-talk choices ({@linkcode pttAvailable}), and never the same key.
 */
export function dictateKeyAvailable(
  dictateKey: PttKey,
  pttKey: PttKey,
  platform: KeyPlatform,
): boolean {
  return pttAvailable(dictateKey, platform) && dictateKey !== pttKey;
}

/**
 * Whether a keydown is the push-to-talk shortcut `key` (held: a repeat is still it). The
 * hold-to-dictate key is one of the same choices and is matched by this too.
 */
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
 * Whether a keyup ends a push-to-talk (or hold-to-dictate) hold of `key`: its own key, Shift or
 * the primary modifier let go.
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

/**
 * Whether a keydown is either talk key: push-to-talk `voice.pttKey` or hold-to-dictate
 * `voice.dictateKey` (what xterm must decline, like the workspace shortcuts).
 */
export function isTalkKey(
  e: KeyLike,
  voice: { pttKey: PttKey; dictateKey: PttKey },
  platform: KeyPlatform,
): boolean {
  return isPushToTalk(e, voice.pttKey, platform) ||
    (dictateKeyAvailable(voice.dictateKey, voice.pttKey, platform) &&
      isPushToTalk(e, voice.dictateKey, platform));
}

/** The physical keys a shortcut may use: `[KeyboardEvent.code, the accelerator's key]`. */
const ACCELERATOR_KEYS: readonly (readonly [string, string])[] = [
  ...[..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => [`Key${c}`, c] as const),
  ...[..."0123456789"].flatMap((d) =>
    [[`Digit${d}`, d], [`Numpad${d}`, `Num${d}`]] as const
  ),
  ["Minus", "-"],
  ["Equal", "="],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Backquote", "`"],
  ["Period", "."],
  // The accelerator `Enter` is the numpad's Enter too.
  ["Enter", "Enter"],
  ["Space", "Space"],
  ["NumpadAdd", "NumAdd"],
  ["NumpadSubtract", "NumSubtract"],
];

/**
 * The workspace's shortcuts, the talk keys and the browser keys (only a web tile's page has the
 * keyboard there) as accelerators (`"CmdOrCtrl+Shift+L"`, matched by
 * physical key): what a native web view hands back to the app while its page has the keyboard
 * (lib/web/native-engine.ts). Derived from {@linkcode commandForKey}, {@linkcode isTalkKey} and
 * {@linkcode webCommandForKey},
 * so it names exactly the keys the window's listeners take and no other.
 */
export function forwardAccelerators(
  voice: { pttKey: PttKey; dictateKey: PttKey },
  platform: KeyPlatform,
): string[] {
  const out: string[] = [];
  for (const [code, key] of ACCELERATOR_KEYS) {
    for (const altKey of [false, true]) {
      for (const shiftKey of [false, true]) {
        const e: KeyLike = {
          key: "",
          code,
          altKey,
          shiftKey,
          metaKey: platform === "mac",
          ctrlKey: platform !== "mac",
        };
        if (
          commandForKey(e, platform) || isTalkKey(e, voice, platform) ||
          webCommandForKey(e, platform)
        ) {
          out.push(
            `CmdOrCtrl+${altKey ? "Alt+" : ""}${
              shiftKey ? "Shift+" : ""
            }${key}`,
          );
        }
      }
    }
  }
  return out;
}
