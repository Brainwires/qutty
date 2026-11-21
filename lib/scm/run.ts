/**
 * Source Control: how git runs in a hidden PTY and how its output comes back. Pure; the desktop
 * extension (desktop/scm.ts) spawns the argv and feeds the PTY's text here.
 *
 * Qutty starts every program through the runtime's `Deno.openPty` (desktop/pty.ts), as the links,
 * Ollama and the sandbox do. A PTY is a terminal, though: it turns `\n` into `\r\n` and mixes
 * stderr into stdout, which porcelain output (NUL separators, file contents with their own line
 * ends) cannot survive. So git runs under a small `/bin/sh` wrapper:
 *
 * - git's stdout goes to a file in a private temporary folder, and once git exits the wrapper
 *   prints a marker line and the file in base64, which a terminal passes through untouched;
 * - git's stderr stays on the terminal, so git shows its progress there (it does on a TTY) and
 *   its messages come back as they are;
 * - stdin is `/dev/null`, or the text given (a patch for `git apply`), through `printf`;
 * - no prompt ever waits: `GIT_TERMINAL_PROMPT=0` makes git fail instead of asking for a user
 *   name or password, the editor is `true`, the pager `cat`. ssh can still ask on the terminal (a
 *   key's passphrase, an unknown host): {@linkcode authPrompt} spots that, and the run is ended
 *   and reported as an authentication problem. Credential helpers and ssh-agent work as they do in
 *   a shell; Qutty never sees a password.
 *
 * @module
 */

/** The line the wrapper prints between git's stderr and its stdout (base64). */
export const OUT_MARK = "@@QUTTY-SCM-STDOUT@@";
/** The line after the base64. */
export const END_MARK = "@@QUTTY-SCM-END@@";

/** The wrapper (`sh -c <WRAPPER> sh <git> <stdin> <args…>`). */
const WRAPPER = [
  `d=$(mktemp -d "\${TMPDIR:-/tmp}/qutty-scm.XXXXXX") || exit 125`,
  `trap 'rm -rf "$d"' EXIT`,
  `trap 'exit 129' HUP INT TERM`,
  `export GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true`,
  `export GIT_MERGE_AUTOEDIT=no GIT_PAGER=cat PAGER=cat TERM=dumb GIT_OPTIONAL_LOCKS=0`,
  `g=$1; i=$2; shift 2`,
  `if [ -n "$i" ]; then printf '%s' "$i" | "$g" "$@" >"$d/o"; else "$g" "$@" </dev/null >"$d/o"; fi`,
  `c=$?`,
  `printf '\\n%s\\n' '${OUT_MARK}'`,
  `base64 <"$d/o"`,
  `printf '\\n%s\\n' '${END_MARK}'`,
  `exit $c`,
].join("\n");

/**
 * The arguments for `/bin/sh` that run `git` (its absolute path) with `args` in the wrapper, with
 * `stdin` as its input. Every value is its own argument: nothing is parsed by the shell.
 */
export function wrapperArgs(
  git: string,
  args: readonly string[],
  stdin = "",
): string[] {
  // Options that make output predictable whatever the user's config says.
  const fixed = ["-c", "core.quotePath=false", "-c", "color.ui=false"];
  return ["-c", WRAPPER, "sh", git, stdin, ...fixed, ...args];
}

const ESCAPES =
  // deno-lint-ignore no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][0-9A-B]/g;

/**
 * Terminal text as plain lines: escapes gone, CRLF as LF, and a line git redrew with `\r`
 * (progress) as its last state.
 */
export function terminalText(raw: string): string {
  return raw.replace(ESCAPES, "").split("\n").map((line) => {
    const l = line.replace(/\r+$/, "");
    return l.slice(l.lastIndexOf("\r") + 1);
  }).join("\n");
}

/** What a wrapped run printed: git's stderr, its stdout, and whether the wrapper finished. */
export interface WrappedOutput {
  stderr: string;
  stdout: string;
  /** The marker and the base64 arrived (false: the run was killed or the wrapper failed). */
  complete: boolean;
}

/** Base64 text (any whitespace in it ignored) as UTF-8 text. */
function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The PTY's whole output of a wrapped run, split back into git's stderr and stdout. */
export function parseWrapped(raw: string): WrappedOutput {
  const at = raw.lastIndexOf(OUT_MARK);
  const end = raw.lastIndexOf(END_MARK);
  if (at < 0 || end < at) {
    return { stderr: terminalText(raw).trim(), stdout: "", complete: false };
  }
  let stdout = "";
  try {
    stdout = fromBase64(raw.slice(at + OUT_MARK.length, end));
  } catch {
    return {
      stderr: terminalText(raw.slice(0, at)).trim(),
      stdout: "",
      complete: false,
    };
  }
  return {
    stderr: terminalText(raw.slice(0, at)).trim(),
    stdout,
    complete: true,
  };
}

/**
 * Whether terminal text ends in a question nobody will answer: ssh asking for a passphrase, a
 * password or about an unknown host key, or git asking for a user name.
 */
export function authPrompt(text: string): boolean {
  const tail = terminalText(text).split("\n").filter((l) => l.trim()).at(-1) ??
    "";
  return /passphrase for|password:|password for|username for|\(yes\/no(\/\[fingerprint\])?\)\?|verification code/i
    .test(tail);
}

/** Whether git's message is about credentials (auth failed, or it was not allowed to ask). */
export function authFailure(stderr: string): boolean {
  return /authentication failed|could not read username|could not read password|terminal prompts disabled|permission denied \(publickey|host key verification failed|invalid username or password/i
    .test(stderr);
}

/** What the tile says about an authentication problem. */
export const AUTH_HINT =
  "Git needs credentials Qutty cannot ask for. Set up a credential helper (git config credential.helper) or add your key to ssh-agent (ssh-add), then try again.";

/** The last progress line of terminal text (the line git is redrawing), if any. */
export function progressLine(raw: string): string {
  const lines = terminalText(raw).split("\n").map((l) => l.trim()).filter((l) =>
    l !== "" && !l.includes(OUT_MARK)
  );
  return lines.at(-1) ?? "";
}

/** A failed run's message: git's `fatal:` / `error:` lines, else its last lines. */
export function errorMessage(stderr: string, code: number): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const loud = lines.filter((l) => /^(fatal|error):/i.test(l));
  const pick = (loud.length > 0 ? loud : lines.slice(-3)).join("\n");
  return pick || `git exited with ${code}`;
}
