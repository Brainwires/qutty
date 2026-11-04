// OSC 7: a shell's "current working directory" report (`ESC ] 7 ; file://host/path BEL`), which
// zsh, bash (with the right prompt hooks) and fish emit on every prompt. Over SSH the host is
// the remote machine's, so it tells an SSH tile where a dropped file should go. The tile wires
// `parseOsc7` to xterm's `registerOscHandler(7, ...)`, which hands it the text after `7;`.

/** A parsed OSC 7 payload. `host` is `""` for `file:///path`. */
export interface Osc7Cwd {
  host: string;
  path: string;
}

/**
 * Parse the payload of an OSC 7 sequence. `undefined` for anything that is not a `file:` URL
 * with an absolute path (some terminals also send `kitty-shell-cwd://`, which is ignored).
 * Percent-escapes in the path are decoded; a malformed escape leaves the path undecoded.
 */
export function parseOsc7(data: string): Osc7Cwd | undefined {
  const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(data.trim());
  if (!m) return undefined;
  let path = m[2];
  try {
    path = decodeURIComponent(path);
  } catch { /* keep it as sent */ }
  if (path.includes("\0")) return undefined;
  return { host: m[1], path };
}
