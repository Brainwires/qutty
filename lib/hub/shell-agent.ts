/**
 * "The shell is the harness": the hub side of the shell agent. A line typed at the user's own
 * zsh or bash prompt that starts with the prefix (`, list the biggest files here`) is sent by
 * the shell plugin (resources/shell/qutty.{zsh,bash}) through `qutty-agent` to the tile's hub
 * socket as one `{"qutty":"agent",…}` line. The hub asks a model for an explanation and one
 * command, and the command lands in the user's edit buffer: nothing is ever run by the agent.
 *
 * Pure: the request's parsing and bounding, secret redaction, the conversation (the shell
 * session is the conversation: the earlier requests and proposals, and the commands the user
 * ran since, with their exit status and folder), the prompt, the model reply's parsing into
 * explanation + command, the dangerous-command flags, and the reply lines `qutty-agent`
 * decodes. The model runs behind {@linkcode ShellBrain} (desktop/shell-agent.ts: headless
 * Claude Code, or a local Ollama through `@rullama/provider`).
 *
 * What reaches the model: the request text, the recent command lines with their exit status
 * and folder, the current folder, the shell and the OS, and this conversation's earlier turns,
 * all with secrets redacted ({@linkcode redactSecrets}). No environment, no file contents, no
 * command output.
 *
 * @module
 */

import {
  classifyCommand,
  SECRET_ENV_PATTERN,
} from "@rullama/tool-builtins/bash";

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

/** One command the user ran: its line, exit status and the folder it ran in. */
export interface ShellHistoryEntry {
  cmd: string;
  exit: number;
  cwd: string;
}

/** What the plugin sends (the `{"qutty":"agent",…}` line). */
export interface ShellRequest {
  /** What the user typed after the prefix. */
  text: string;
  /** The shell's current folder. */
  cwd: string;
  /** `zsh` or `bash`. */
  shell: string;
  /** `uname -s`. */
  os: string;
  /** Which model backend (`auto`, `claude`, `ollama`). */
  brain: BrainChoice;
  /** A model name for that backend (empty: its default). */
  model: string;
  /** Recent commands, oldest first. */
  history: ShellHistoryEntry[];
}

export type BrainChoice = "auto" | "claude" | "ollama";

/** Bounds on what is sent to the model. */
const SHELL_LIMITS = {
  /** Characters of the request. */
  text: 2000,
  /** Recent commands kept. */
  history: 10,
  /** Characters of one command line. */
  cmd: 400,
  /** Characters of a folder path. */
  cwd: 300,
  /** Earlier turns of the conversation kept. */
  turns: 6,
  /** Characters of an earlier turn's explanation. */
  turnExplanation: 400,
  /** Characters of the proposed command kept. */
  command: 4000,
  /** Characters of the explanation shown. */
  explanation: 2000,
} as const;

const clip = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n - 1)}…`;

const asString = (v: unknown, n: number) =>
  typeof v === "string" ? clip(v, n) : "";

/** A string with control characters other than tab and newline removed. */
function clean(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/**
 * A `qutty-agent` line (`{"qutty":"agent","text":…,"history":[…],…}`), validated and bounded;
 * `undefined` when the line is not one.
 */
export function parseAgentLine(line: string): ShellRequest | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.qutty !== "agent") return undefined;
  const brain = o.brain === "claude" || o.brain === "ollama" ? o.brain : "auto";
  const model = asString(o.model, 64);
  const history = Array.isArray(o.history) ? o.history : [];
  return {
    text: clean(asString(o.text, SHELL_LIMITS.text)).trim(),
    cwd: clean(asString(o.cwd, SHELL_LIMITS.cwd)),
    shell: /^[a-z]{1,16}$/.test(String(o.shell)) ? String(o.shell) : "sh",
    os: /^[A-Za-z0-9_.-]{1,32}$/.test(String(o.os)) ? String(o.os) : "",
    brain,
    model: /^[A-Za-z0-9._:/-]*$/.test(model) ? model : "",
    history: boundHistory(
      history.flatMap((h): ShellHistoryEntry[] => {
        if (typeof h !== "object" || h === null) return [];
        const e = h as Record<string, unknown>;
        const cmd = clean(asString(e.cmd, SHELL_LIMITS.cmd * 4)).trim();
        if (!cmd) return [];
        const exit = Number(e.exit);
        return [{
          cmd,
          exit: Number.isInteger(exit) && exit >= 0 && exit < 1000 ? exit : -1,
          cwd: clean(asString(e.cwd, SHELL_LIMITS.cwd)),
        }];
      }),
    ),
  };
}

/** The last {@linkcode SHELL_LIMITS.history} entries, each command line clipped. */
export function boundHistory(
  entries: readonly ShellHistoryEntry[],
): ShellHistoryEntry[] {
  return entries.slice(-SHELL_LIMITS.history).map((e) => ({
    ...e,
    cmd: clip(e.cmd, SHELL_LIMITS.cmd),
    cwd: clip(e.cwd, SHELL_LIMITS.cwd),
  }));
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

const REDACTED = "[redacted]";

/** Token shapes that are secrets wherever they appear. */
const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

/** A shell word's value: quoted, or up to the next blank / separator. */
const VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|]+)`;

/** `NAME=value` (an assignment, `export`, `env`, a `.env` line). */
const ASSIGNMENT = new RegExp(
  String.raw`(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(${VALUE})`,
  "g",
);

/** `--password x`, `--token=x`, `--api-key x`, … */
const SECRET_FLAG = new RegExp(
  String
    .raw`(--?(?:password|passwd|pass|token|secret|api[-_]?key|access[-_]?key|auth|client[-_]?secret)(?:[=\s]+))(${VALUE})`,
  "gi",
);

/**
 * `text` with anything that looks like a credential replaced by `[redacted]`:
 *
 * - the value of an assignment whose name looks like a secret (Rullama's `SECRET_ENV_PATTERN`,
 *   the variables `BashTool` withholds from its children: `*_KEY`, `*TOKEN*`, `AWS_*`, …);
 * - the value after a `--password` / `--token` / `--api-key`-style flag;
 * - `Authorization:` / `Bearer` / `Basic` credentials and a URL's password (`user:pw@host`);
 * - well-known token shapes (API keys, GitHub / GitLab / Slack / npm tokens, AWS key ids,
 *   JWTs, private key blocks).
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(
    ASSIGNMENT,
    (all, lead: string, name: string) =>
      SECRET_ENV_PATTERN.test(name) ? `${lead}${name}=${REDACTED}` : all,
  );
  out = out.replace(SECRET_FLAG, (_all, flag: string) => `${flag}${REDACTED}`);
  out = out.replace(
    /\b(authorization:\s*|bearer\s+|basic\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    (_all, head: string) => `${head}${REDACTED}`,
  );
  out = out.replace(
    /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi,
    (_all, head: string) => `${head}:${REDACTED}@`,
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------------------------

/** One finished exchange: what was asked and what was proposed. */
export interface ShellTurn {
  request: string;
  explanation: string;
  command: string;
}

/** One tile's conversation: its last {@linkcode SHELL_LIMITS.turns} turns. */
export class ShellConversation {
  #turns: ShellTurn[] = [];

  get turns(): readonly ShellTurn[] {
    return this.#turns;
  }

  add(turn: ShellTurn): void {
    this.#turns.push({
      request: clip(turn.request, SHELL_LIMITS.text),
      explanation: clip(turn.explanation, SHELL_LIMITS.turnExplanation),
      command: clip(turn.command, SHELL_LIMITS.command),
    });
    if (this.#turns.length > SHELL_LIMITS.turns) this.#turns.shift();
  }

  reset(): void {
    this.#turns = [];
  }
}

// ---------------------------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------------------------

/** The system prompt: an explanation and one command in a fenced block; never run anything. */
export function shellSystemPrompt(shell: string, os: string): string {
  return [
    `You are a command-line assistant inside the user's interactive ${shell} shell` +
    `${os ? ` on ${os}` : ""}, in the Qutty terminal.`,
    "The user describes what they want in plain language. Reply with a short explanation " +
    "(one to three sentences, plain text, no headings) followed by exactly one shell command " +
    "in a single fenced code block (```sh … ```).",
    "The command is put into the user's edit buffer for them to review, change and run " +
    "themselves. You never run anything: you have no tools, and must not ask for any.",
    `Write the command for ${shell}${
      os ? ` on ${os}` : ""
    }. Prefer safe, read-only and ` +
    "reversible commands; never suggest destroying data, disks or the system unless the user " +
    "asked for exactly that, and then say what it destroys.",
    "If the task takes several steps, give only the next step as the command and say what comes " +
    "after it: the user runs it and then asks to continue (for example `next`). The recent " +
    "commands show what they ran since, with exit status; use a failure to fix the next step.",
    "If no command fits (a question, or something unsafe), answer with the explanation only and " +
    "no code block. Never include secrets, and do not invent file names you have not seen.",
  ].join("\n");
}

/** The user message for one request: the context, the earlier turns, then the request. */
export function buildShellPrompt(
  req: ShellRequest,
  turns: readonly ShellTurn[],
): string {
  const lines: string[] = [];
  lines.push(
    `Shell: ${req.shell}${req.os ? ` on ${req.os}` : ""}.`,
    `Current folder: ${redactSecrets(req.cwd) || "(unknown)"}`,
  );
  const history = boundHistory(req.history);
  if (history.length > 0) {
    lines.push(
      "",
      "Recent commands, oldest first (exit status, folder, command line):",
    );
    for (const h of history) {
      const status = h.exit < 0 ? "?" : String(h.exit);
      lines.push(
        `  [exit ${status}] ${redactSecrets(h.cwd)} $ ${redactSecrets(h.cmd)}`,
      );
    }
  }
  const recent = turns.slice(-SHELL_LIMITS.turns);
  if (recent.length > 0) {
    lines.push("", "Earlier in this session:");
    for (const t of recent) {
      lines.push(`  User asked: ${redactSecrets(t.request)}`);
      if (t.explanation) {
        lines.push(`  You said: ${redactSecrets(t.explanation)}`);
      }
      lines.push(
        t.command
          ? `  You proposed: ${redactSecrets(t.command)}`
          : "  You proposed no command.",
      );
    }
  }
  lines.push("", `Request: ${redactSecrets(req.text)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The model's reply
// ---------------------------------------------------------------------------------------------

/** The model's reply, split. */
export interface ParsedReply {
  explanation: string;
  /** The proposed command (empty: none). */
  command: string;
}

const FENCE = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
const SHELL_LANGS = new Set(["", "sh", "bash", "zsh", "shell", "console"]);

/**
 * Split the model's text into an explanation and a command: the first shell-like fenced block
 * is the command (a `$ ` prompt in front of a line is dropped), everything outside the fences
 * is the explanation. No fence: all of it is the explanation, and there is no command.
 */
export function parseModelReply(text: string): ParsedReply {
  const blocks = [...text.matchAll(FENCE)];
  const block = blocks.find((m) => SHELL_LANGS.has(m[1].toLowerCase())) ??
    blocks[0];
  let command = "";
  if (block) {
    command = block[2]
      .split("\n")
      .map((l) => l.replace(/^\s*\$\s+/, "").replace(/\s+$/, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
  }
  const explanation = text.replace(FENCE, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    explanation: clip(explanation, SHELL_LIMITS.explanation),
    command: clip(command, SHELL_LIMITS.command),
  };
}

// ---------------------------------------------------------------------------------------------
// Dangerous commands
// ---------------------------------------------------------------------------------------------

/** A flag on a proposed command. `block`: it lands commented out. */
export interface DangerFlag {
  level: "warn" | "block";
  reason: string;
}

/**
 * Qutty's own warnings, for what Rullama's `classifyCommand` leaves `ok` on purpose (it flags
 * only the commands that destroy a disk, the system or history): Qutty also warns on any
 * `rm -r` / `rm -f`, `git push --force-with-lease`, `git checkout .` / `git restore .`, and a
 * recursive `chmod` / `chown` anywhere, since the user runs the command with one key.
 */
const QUTTY_WARN_PATTERNS: [RegExp, string][] = [
  [
    /\brm\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*[rRf]/,
    "rm -r / -f deletes files without asking",
  ],
  [
    /\bgit\s+push\b[^;&|]*\s--force-with-lease\b/,
    "git push --force-with-lease rewrites the remote's history",
  ],
  [
    /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/,
    "git checkout / restore . throws away uncommitted changes",
  ],
  [
    /\b(?:chmod|chown)\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*R\b/,
    "chmod / chown -R changes permissions recursively",
  ],
];

/** A shell (`sh -c`, `bash -lc`, …), `eval`, or a command substitution: quoted text is code. */
const RUNS_QUOTED_CODE = /\b(?:ba|z|da|k)?sh\s+-[A-Za-z]*c\b|\beval\b|\$\(|`/;

/**
 * The text Qutty's own patterns look at: as `classifyCommand` does, quoted text handed to an
 * ordinary command is data (`git commit -m "rm -rf x"` is fine), so quoted spans are dropped,
 * unless the command hands quoted text to a shell, `eval` or a substitution.
 */
function codeText(command: string): string {
  if (RUNS_QUOTED_CODE.test(command)) return command;
  return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/**
 * Flags for a proposed command: Rullama's `classifyCommand` (a shell-aware parse: `block` for
 * what destroys a disk, the system or the home folder, `warn` for what is risky), then
 * {@linkcode QUTTY_WARN_PATTERNS}. A blocked command's reasons are all `block` flags: the
 * classification does not say which of them is only warn-level, and the whole command is refused.
 */
export function dangerFlags(command: string): DangerFlag[] {
  if (!command.trim()) return [];
  const flags: DangerFlag[] = [];
  const seen = new Set<string>();
  const add = (level: DangerFlag["level"], reason: string) => {
    if (seen.has(reason)) return;
    seen.add(reason);
    flags.push({ level, reason });
  };
  const { verdict, reasons } = classifyCommand(command);
  for (const reason of reasons) {
    add(verdict === "block" ? "block" : "warn", reason);
  }
  // A refused command needs no further warnings.
  if (verdict === "block") return flags;
  const text = codeText(command);
  for (const [re, reason] of QUTTY_WARN_PATTERNS) {
    if (re.test(text)) add("warn", reason);
  }
  return flags;
}

/** A blocked command as it lands in the buffer: every line commented out. */
export function commentOut(command: string): string {
  return command.split("\n").map((l) => `# ${l}`).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Handling one request
// ---------------------------------------------------------------------------------------------

/** A model backend: one request in, the model's text out. No tools, nothing run. */
export interface ShellBrain {
  /** What the reply's footer names (`Claude Code (haiku)`, `Ollama (llama3.2)`). */
  readonly label: string;
  complete(system: string, prompt: string): Promise<string>;
}

/** What the plugin shows. */
export interface ShellReply {
  ok: boolean;
  /** Printed above the prompt. */
  explanation: string;
  /** Put into the edit buffer (empty: the buffer is left empty). */
  command: string;
  /** Warning lines, printed in a warning colour. */
  warnings: string[];
  /** The error, when `ok` is false (the request goes back into the buffer). */
  error?: string;
}

/** The hub operations the plugin's words reach (the tile's own identity is bound already). */
export interface ShellHubOps {
  /** `, inbox`: the unread messages (marked read). */
  inbox(): { fromName: string; text: string; at: number }[];
  /** `, to <tile> <text>` / `, say <text>` (`to` = "all"): returns the recipients' ids. */
  send(to: string, text: string): string[];
  /** The brain for a request (throws a user-facing error when none is available). */
  brain(choice: BrainChoice, model: string): Promise<ShellBrain>;
}

const HELP = [
  "Type a request after the prefix and press Enter: the proposed command lands in your",
  "edit buffer, nothing runs until you press Enter again.",
  "  , <request>        ask (the session is the conversation: `, next` continues)",
  "  , inbox            messages other tiles sent you",
  "  , say <text>       message every other tile",
  "  , to <tile> <text> message one tile (or `companion`)",
  "  , reset            forget this conversation",
  "  , help             this help",
  "Settings: QUTTY_AGENT_PREFIX (default ,), QUTTY_AGENT_BRAIN (auto | claude | ollama),",
  "QUTTY_AGENT_MODEL (default: haiku for Claude Code, the first model for Ollama).",
].join("\n");

const ok = (
  explanation: string,
  command = "",
  warnings: string[] = [],
): ShellReply => ({ ok: true, explanation, command, warnings });

const failed = (error: string): ShellReply => ({
  ok: false,
  explanation: "",
  command: "",
  warnings: [],
  error,
});

/** A message's age, in words. */
function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/**
 * Answer one request: a built-in word (`inbox`, `say`, `to`, `reset`, `help`), else the model.
 * The model's command is flagged ({@linkcode dangerFlags}); a blocked one lands commented out.
 * Never throws: failures come back as `{ ok: false, error }`.
 */
export async function handleShellRequest(
  req: ShellRequest,
  conversation: ShellConversation,
  ops: ShellHubOps,
  now = Date.now(),
): Promise<ShellReply> {
  const [word = "", ...rest] = req.text.split(/\s+/);
  const tail = req.text.slice(word.length).trim();
  try {
    switch (word.toLowerCase()) {
      case "help":
      case "?":
        if (rest.length === 0) return ok(HELP);
        break;
      case "reset":
        if (rest.length === 0) {
          conversation.reset();
          return ok("Conversation cleared.");
        }
        break;
      case "inbox": {
        if (rest.length > 0) break;
        const messages = ops.inbox();
        if (messages.length === 0) return ok("No new messages.");
        return ok(
          messages.map((m) => `${m.fromName} (${ago(m.at, now)}): ${m.text}`)
            .join("\n"),
        );
      }
      case "say":
        if (!tail) return failed("say what? (, say <text>)");
        return ok(`Sent to ${ops.send("all", tail).length} tile(s).`);
      case "to": {
        const [to = ""] = rest;
        const text = tail.slice(to.length).trim();
        if (!to || !text) return failed("usage: , to <tile> <text>");
        ops.send(to, text);
        return ok(`Sent to ${to}.`);
      }
    }
    const text = req.text || "next";
    const brain = await ops.brain(req.brain, req.model);
    const raw = await brain.complete(
      shellSystemPrompt(req.shell, req.os),
      buildShellPrompt({ ...req, text }, conversation.turns),
    );
    const parsed = parseModelReply(raw);
    if (!parsed.explanation && !parsed.command) {
      return failed(`${brain.label} gave an empty answer`);
    }
    conversation.add({ request: text, ...parsed });
    const flags = dangerFlags(parsed.command);
    const blocks = flags.filter((f) => f.level === "block").map((f) =>
      f.reason
    );
    const warnings = blocks.length > 0
      ? [`refused: ${blocks.join("; ")} (it is commented out)`]
      : flags.map((f) => `careful: ${f.reason}`);
    return ok(
      parsed.explanation,
      blocks.length > 0 ? commentOut(parsed.command) : parsed.command,
      warnings,
    );
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------------------------
// The reply lines
// ---------------------------------------------------------------------------------------------

/**
 * Percent-encode what `printf %b` would misread or a line cannot hold: `%`, `\`, control
 * characters and DEL. `qutty-agent` decodes with `printf '%b' "${v//%/\\x}"`.
 */
export function pctEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = "";
  for (const b of bytes) {
    out += b < 0x20 || b === 0x7f || b === 0x25 || b === 0x5c
      ? `%${b.toString(16).toUpperCase().padStart(2, "0")}`
      : String.fromCharCode(b);
  }
  // The bytes ≥ 0x80 were appended as Latin-1 chars: re-decode them as the UTF-8 they are.
  return new TextDecoder().decode(
    Uint8Array.from(out, (c) => c.charCodeAt(0)),
  );
}

/**
 * The reply as `qutty-agent` reads it: one `key value` line per field, values percent-encoded
 * ({@linkcode pctEncode}): `explain`, `warn` (any number), `command`, or `error`; then `end`.
 */
export function replyLines(reply: ShellReply): string[] {
  if (!reply.ok) {
    return [`error ${pctEncode(reply.error ?? "failed")}`, "end"];
  }
  return [
    ...(reply.explanation ? [`explain ${pctEncode(reply.explanation)}`] : []),
    ...reply.warnings.map((w) => `warn ${pctEncode(w)}`),
    ...(reply.command ? [`command ${pctEncode(reply.command)}`] : []),
    "end",
  ];
}
