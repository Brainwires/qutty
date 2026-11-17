/**
 * What typing into a tile means: `write_tile`'s text (and the harness overlay's prompt box, which
 * types into the terminal the same way) with a trailing line break taken as the Enter key.
 *
 * Pure and client-safe.
 *
 * @module
 */

/**
 * What `write_tile` types for `text` (and `enter`). Models often spell Enter as the two characters
 * backslash and r (a JSON escape written one level too deep), which a shell reads as `r`: `ls\r`
 * runs `lsr`. So a trailing backslash-r / backslash-n (not itself escaped) is taken as Enter, a
 * trailing real newline becomes a carriage return (what the Enter key sends; a TUI in raw mode
 * ignores a bare LF), and `enter` presses Enter once at the end.
 */
export function tileInput(text: string, enter = false): string {
  let body = text;
  let pressEnter = enter;
  for (;;) {
    const m = /(?<!\\)(?:\\r\\n|\\r|\\n|\r\n|\r|\n)$/.exec(body);
    if (!m) break;
    body = body.slice(0, m.index);
    pressEnter = true;
  }
  return pressEnter ? `${body}\r` : body;
}
