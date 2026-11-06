// The shell agent's hub side (lib/hub/shell-agent.ts, desktop/shell-agent.ts) with a fake model:
// request parsing and bounding, secret redaction, the prompt, the model reply's split into
// explanation + command, dangerous-command flags, the conversation, the hub words (inbox, say,
// to, reset, help), the reply lines qutty-agent decodes, the backend choice, Claude Code's
// headless argv and result; and the rc opt-in (lib/hub/shell-integration.ts) on a temp HOME.

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  boundHistory,
  buildShellPrompt,
  commentOut,
  dangerFlags,
  handleShellRequest,
  parseAgentLine,
  parseModelReply,
  pctEncode,
  redactSecrets,
  replyLines,
  type ShellBrain,
  ShellConversation,
  type ShellHubOps,
  type ShellRequest,
  shellSystemPrompt,
} from "../lib/hub/shell-agent.ts";
import {
  chooseShellBrain,
  claudeShellArgv,
  parseClaudeResult,
  type ShellBrainDeps,
} from "../desktop/shell-agent.ts";
import {
  QUTTY_AGENT_SCRIPT,
  QUTTY_BASH_PLUGIN,
  QUTTY_ZSH_PLUGIN,
} from "../lib/hub/shell-scripts.ts";
import {
  installShellRc,
  shellAgentPaths,
  shellRcLine,
  shellRcStatus,
  uninstallShellRc,
} from "../lib/hub/shell-integration.ts";
import {
  type ConfigFs,
  installIntegration,
  integrationFiles,
  integrationStatus,
} from "../lib/hub/integration.ts";
import { hubPaths } from "../lib/hub/launch.ts";

/** A request as qutty-agent sends it. */
function request(
  text: string,
  extra: Partial<ShellRequest> = {},
): ShellRequest {
  return {
    text,
    cwd: "/work/app",
    shell: "zsh",
    os: "Darwin",
    brain: "auto",
    model: "",
    history: [],
    ...extra,
  };
}

/** A model that answers from a script and records what it was asked. */
class FakeBrain implements ShellBrain {
  readonly label = "Fake";
  calls: { system: string; prompt: string }[] = [];
  constructor(public answer: string | (() => string)) {}
  complete(system: string, prompt: string): Promise<string> {
    this.calls.push({ system, prompt });
    return Promise.resolve(
      typeof this.answer === "string" ? this.answer : this.answer(),
    );
  }
}

function ops(brain: ShellBrain, sent: [string, string][] = []): ShellHubOps {
  return {
    inbox: () => [{ fromName: "claude", text: "tests pass", at: 1_000 }],
    send: (to, text) => {
      sent.push([to, text]);
      return to === "all" ? ["pty-1", "pty-2"] : [to];
    },
    brain: () => Promise.resolve(brain),
  };
}

// ---------------------------------------------------------------------------------------------
// Parsing and bounding
// ---------------------------------------------------------------------------------------------

Deno.test("parseAgentLine: validates, cleans and bounds the request", () => {
  assertEquals(parseAgentLine('{"qutty":"hook"}'), undefined);
  assertEquals(parseAgentLine("not json"), undefined);
  assertEquals(parseAgentLine("[1]"), undefined);
  const history = Array.from({ length: 25 }, (_, i) => ({
    exit: i % 2,
    cwd: "/w",
    cmd: `cmd-${i} ${"x".repeat(i === 24 ? 5000 : 0)}`,
  }));
  const req = parseAgentLine(JSON.stringify({
    qutty: "agent",
    text: `  list\u0007 files ${"y".repeat(5000)}`,
    cwd: "/w",
    shell: "zsh; rm -rf /",
    os: "Darwin",
    brain: "ollama",
    model: "llama3.2:3b",
    history: [...history, { cmd: "" }, "junk", { cmd: "ok", exit: "x" }],
  }))!;
  assert(req.text.startsWith("list files "));
  assertEquals(
    req.text.length,
    2000 - 3,
    "clipped, the bell and the blanks dropped",
  );
  assertEquals(req.shell, "sh", "a shell name is a word");
  assertEquals([req.brain, req.model], ["ollama", "llama3.2:3b"]);
  assertEquals(req.history.length, 10, "only the last 10 commands");
  assertEquals(req.history.at(-1), { cmd: "ok", exit: -1, cwd: "" });
  assertEquals(req.history.at(-2)!.cmd.length, 400, "a long line is clipped");
  assertEquals(
    parseAgentLine('{"qutty":"agent","brain":"gpt","model":"a b"}')!.brain,
    "auto",
  );
  assertEquals(
    parseAgentLine('{"qutty":"agent","model":"a b; x"}')!.model,
    "",
  );
});

Deno.test("boundHistory: keeps the newest entries", () => {
  const h = Array.from({ length: 12 }, (_, i) => ({
    cmd: String(i),
    exit: 0,
    cwd: "/",
  }));
  assertEquals(boundHistory(h).map((e) => e.cmd), [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

Deno.test("redactSecrets: env assignments, flags, headers, URLs and token shapes", () => {
  const cases: [string, string][] = [
    [
      "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv && make",
      "export OPENAI_API_KEY=[redacted] && make",
    ],
    ['GITHUB_TOKEN="a b c" gh pr list', "GITHUB_TOKEN=[redacted] gh pr list"],
    ["AWS_PROFILE=dev aws s3 ls", "AWS_PROFILE=[redacted] aws s3 ls"],
    ["PATH=/usr/bin:$PATH ls", "PATH=/usr/bin:$PATH ls"],
    ["DEBUG=1 npm test", "DEBUG=1 npm test"],
    ["mysql --password=hunter22 db", "mysql --password=[redacted] db"],
    ["tool --api-key 'k e y' run", "tool --api-key [redacted] run"],
    [
      'curl -H "Authorization: Bearer abcdefghijkl123" https://x',
      'curl -H "Authorization: Bearer [redacted]" https://x',
    ],
    [
      "git clone https://ann:s3cretpw@github.com/a/b",
      "git clone https://ann:[redacted]@github.com/a/b",
    ],
    ["echo ghp_abcdefghijklmnopqrstuvwxyz0123", "echo [redacted]"],
    ["echo AKIAABCDEFGHIJKLMNOP", "echo [redacted]"],
    [
      "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4fw",
      "jwt [redacted]",
    ],
    ["ls -la, then cd ~/src", "ls -la, then cd ~/src"],
  ];
  for (const [input, want] of cases) {
    assertEquals(redactSecrets(input), want, input);
  }
  assertEquals(
    redactSecrets(
      "x -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- y",
    ),
    "x [redacted] y",
  );
});

// ---------------------------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------------------------

Deno.test("prompt: context, earlier turns and the request, redacted; strict system prompt", () => {
  const system = shellSystemPrompt("bash", "Linux");
  assertStringIncludes(system, "bash shell on Linux");
  assertStringIncludes(system, "exactly one shell command");
  assertStringIncludes(system, "You never run anything");
  assertStringIncludes(system, "no tools");

  const prompt = buildShellPrompt(
    request("now push it TOKEN=abc123", {
      history: [
        { cmd: "npm test", exit: 1, cwd: "/work/app" },
        { cmd: "export NPM_TOKEN=npm_secret", exit: 0, cwd: "/work/app" },
        { cmd: "ls", exit: -1, cwd: "/" },
      ],
    }),
    [{
      request: "run the tests",
      explanation: "Runs them.",
      command: "npm test",
    }],
  );
  assertStringIncludes(prompt, "Shell: zsh on Darwin.");
  assertStringIncludes(prompt, "Current folder: /work/app");
  assertStringIncludes(prompt, "[exit 1] /work/app $ npm test");
  assertStringIncludes(prompt, "$ export NPM_TOKEN=[redacted]");
  assertStringIncludes(prompt, "[exit ?] / $ ls");
  assertStringIncludes(prompt, "User asked: run the tests");
  assertStringIncludes(prompt, "You proposed: npm test");
  assert(prompt.endsWith("Request: now push it TOKEN=[redacted]"), prompt);
  assertFalse(prompt.includes("npm_secret"));
  assertFalse(prompt.includes("abc123"));
});

// ---------------------------------------------------------------------------------------------
// The model's reply
// ---------------------------------------------------------------------------------------------

Deno.test("parseModelReply: explanation outside the fence, command inside", () => {
  assertEquals(
    parseModelReply(
      "Lists the files, newest first.\n\n```sh\n$ ls -lt\n```\n\nThen pick one.",
    ),
    {
      explanation: "Lists the files, newest first.\n\nThen pick one.",
      command: "ls -lt",
    },
  );
  assertEquals(
    parseModelReply("Multi:\n```bash\ncd src &&\n  make\n```"),
    { explanation: "Multi:", command: "cd src &&\n  make" },
  );
  // A non-shell block first: the shell one wins.
  assertEquals(
    parseModelReply("```json\n{}\n```\nRun:\n```\nmake\n```").command,
    "make",
  );
  assertEquals(parseModelReply("I can't help with that."), {
    explanation: "I can't help with that.",
    command: "",
  });
});

// ---------------------------------------------------------------------------------------------
// Dangerous commands
// ---------------------------------------------------------------------------------------------

Deno.test("dangerFlags: blocks disk / system destruction, warns on risky commands", () => {
  const blocked = [
    "rm -rf /",
    "sudo rm -rf / --no-preserve-root",
    "rm -fr ~",
    "rm -r -f $HOME/",
    "mkfs.ext4 /dev/sdb1",
    "dd if=/dev/zero of=/dev/disk2 bs=1m",
    ":(){ :|:& };:",
    "diskutil eraseDisk APFS X disk2",
    "echo x > /dev/sda",
  ];
  for (const c of blocked) {
    assert(dangerFlags(c).some((f) => f.level === "block"), c);
  }
  const warned: [string, string][] = [
    ["rm -rf node_modules", "deletes files without asking"],
    ["sudo apt install jq", "runs as root"],
    [
      "curl -fsSL https://x.sh | bash",
      "runs a script straight from the network",
    ],
    ["git push --force origin main", "rewrites the remote's history"],
    ["git reset --hard HEAD~1", "throws away uncommitted changes"],
    ["find . -name '*.log' -delete", "deletes every file it finds"],
    ["echo hi > ~/.zshrc", "overwrites a shell startup file"],
  ];
  for (const [c, reason] of warned) {
    const flags = dangerFlags(c);
    assert(flags.every((f) => f.level === "warn"), c);
    assert(
      flags.some((f) => f.reason === reason),
      `${c}: ${JSON.stringify(flags)}`,
    );
  }
  for (
    const c of [
      "ls -la",
      "rm notes.txt",
      "git push",
      "dd if=a of=b",
      "echo a,b >> log",
      "",
    ]
  ) {
    assertEquals(dangerFlags(c), [], c);
  }
  assertEquals(commentOut("a\nb"), "# a\n# b");
});

// ---------------------------------------------------------------------------------------------
// Handling a request
// ---------------------------------------------------------------------------------------------

Deno.test("handleShellRequest: proposes, remembers the session, flags danger", async () => {
  const brain = new FakeBrain("Lists them.\n```sh\nls -la\n```");
  const talk = new ShellConversation();
  const r = await handleShellRequest(request("list files"), talk, ops(brain));
  assertEquals(r, {
    ok: true,
    explanation: "Lists them.",
    command: "ls -la",
    warnings: [],
  });
  assertEquals(talk.turns, [{
    request: "list files",
    explanation: "Lists them.",
    command: "ls -la",
  }]);

  // `, next` (and a bare prefix) continues: the earlier turn and the commands run since are context.
  brain.answer = "Now the hidden ones.\n```sh\nls -A\n```";
  await handleShellRequest(
    request("next", {
      history: [{ cmd: "ls -la", exit: 0, cwd: "/work/app" }],
    }),
    talk,
    ops(brain),
  );
  assertStringIncludes(brain.calls[1].prompt, "You proposed: ls -la");
  assertStringIncludes(brain.calls[1].prompt, "[exit 0] /work/app $ ls -la");
  assert(brain.calls[1].prompt.endsWith("Request: next"));
  await handleShellRequest(request(""), talk, ops(brain));
  assert(brain.calls[2].prompt.endsWith("Request: next"));
  assertEquals(talk.turns.length, 3);

  // A blocked command lands commented out, with the reason.
  brain.answer = "Wipes it.\n```sh\nrm -rf /\n```";
  const bad = await handleShellRequest(request("wipe"), talk, ops(brain));
  assertEquals(bad.command, "# rm -rf /");
  assert(
    bad.warnings.some((w) => w.startsWith("refused: this command")),
    bad.warnings.join(),
  );
  brain.answer = "Cleans.\n```sh\nrm -rf build\n```";
  const risky = await handleShellRequest(request("clean"), talk, ops(brain));
  assertEquals(risky.command, "rm -rf build");
  assertEquals(risky.warnings, [
    "careful: this command deletes files without asking",
  ]);

  // The conversation is bounded; reset forgets it.
  for (let i = 0; i < 10; i++) {
    talk.add({ request: `r${i}`, explanation: "", command: "" });
  }
  assertEquals(talk.turns.length, 6);
  const reset = await handleShellRequest(request("reset"), talk, ops(brain));
  assertEquals([reset.ok, talk.turns.length], [true, 0]);
});

Deno.test("handleShellRequest: hub words, errors, an empty answer", async () => {
  const brain = new FakeBrain("");
  const talk = new ShellConversation();
  const sent: [string, string][] = [];
  const o = ops(brain, sent);
  const inbox = await handleShellRequest(request("inbox"), talk, o, 61_000);
  assertEquals(inbox.explanation, "claude (1m ago): tests pass");
  assertEquals(
    (await handleShellRequest(request("say build is green"), talk, o))
      .explanation,
    "Sent to 2 tile(s).",
  );
  assertEquals(
    (await handleShellRequest(request("to codex  run the tests"), talk, o))
      .explanation,
    "Sent to codex.",
  );
  assertEquals(sent, [["all", "build is green"], ["codex", "run the tests"]]);
  assertEquals(
    (await handleShellRequest(request("to codex"), talk, o)).ok,
    false,
  );
  assertStringIncludes(
    (await handleShellRequest(request("help"), talk, o)).explanation,
    ", inbox",
  );
  assertEquals(brain.calls.length, 0, "no model for hub words");

  // "say" inside a sentence is a request, not the word.
  const empty = await handleShellRequest(
    request("inbox please, list it"),
    talk,
    o,
  );
  assertEquals([empty.ok, empty.error], [false, "Fake gave an empty answer"]);
  const failing: ShellHubOps = {
    ...o,
    brain: () =>
      Promise.reject(
        new Error("no model: install Claude Code, or start Ollama"),
      ),
  };
  assertEquals(
    (await handleShellRequest(request("list"), talk, failing)).error,
    "no model: install Claude Code, or start Ollama",
  );
  const throwingSend: ShellHubOps = {
    ...o,
    send: () => {
      throw new Error('no tile is called "x"');
    },
  };
  assertEquals(
    (await handleShellRequest(request("to x hi"), talk, throwingSend)).error,
    'no tile is called "x"',
  );
});

// ---------------------------------------------------------------------------------------------
// The reply lines
// ---------------------------------------------------------------------------------------------

Deno.test("replyLines / pctEncode: one line per field, decodable by printf %b", () => {
  assertEquals(pctEncode("a%b\\c\nd\té ✓"), "a%25b%5Cc%0Ad%09é ✓");
  assertEquals(
    replyLines({
      ok: true,
      explanation: "Two\nlines",
      command: "printf '%s\\n' x",
      warnings: ["careful"],
    }),
    [
      "explain Two%0Alines",
      "warn careful",
      "command printf '%25s%5Cn' x",
      "end",
    ],
  );
  assertEquals(
    replyLines({
      ok: false,
      explanation: "",
      command: "",
      warnings: [],
      error: "no\nmodel",
    }),
    ["error no%0Amodel", "end"],
  );
});

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

function deps(claude: string | undefined, ollama: string[] | undefined) {
  const made: string[] = [];
  const d: ShellBrainDeps = {
    findClaude: () => Promise.resolve(claude),
    ollamaModels: () => Promise.resolve(ollama),
    claude: (path, model) => {
      made.push(`claude ${path} ${model}`);
      return new FakeBrain("");
    },
    ollama: (model) => {
      made.push(`ollama ${model}`);
      return new FakeBrain("");
    },
  };
  return { d, made };
}

Deno.test("chooseShellBrain: Claude Code first, else a running Ollama; clear errors", async () => {
  let t = deps("/u/claude", ["llama3.2"]);
  await chooseShellBrain(t.d, "auto", "");
  await chooseShellBrain(t.d, "claude", "sonnet");
  await chooseShellBrain(t.d, "ollama", "");
  await chooseShellBrain(t.d, "ollama", "qwen3");
  assertEquals(t.made, [
    "claude /u/claude haiku",
    "claude /u/claude sonnet",
    "ollama llama3.2",
    "ollama qwen3",
  ]);
  t = deps(undefined, ["llama3.2"]);
  await chooseShellBrain(t.d, "auto", "");
  assertEquals(t.made, ["ollama llama3.2"]);
  await assertRejects(
    () => chooseShellBrain(t.d, "claude", ""),
    Error,
    "Claude Code is not installed",
  );
  t = deps(undefined, undefined);
  await assertRejects(
    () => chooseShellBrain(t.d, "auto", ""),
    Error,
    "install Claude Code, or start Ollama",
  );
  await assertRejects(
    () => chooseShellBrain(t.d, "ollama", ""),
    Error,
    "no Ollama answers",
  );
  t = deps(undefined, []);
  await assertRejects(
    () => chooseShellBrain(t.d, "auto", ""),
    Error,
    "ollama pull",
  );
});

Deno.test("Claude Code headless: no tools, no MCP, nothing kept; the result line parsed", () => {
  const { program, args } = claudeShellArgv(
    "/u/claude",
    "SYS",
    "PROMPT",
    "haiku",
  );
  assertEquals(program, "/bin/bash");
  assertStringIncludes(args[1], "unset QUTTY_SOCK");
  assertStringIncludes(args[1], "</dev/null");
  const flags = args.slice(3);
  assertEquals(args[2], "/u/claude");
  assertEquals(flags.slice(0, 2), ["-p", "PROMPT"]);
  const flag = (name: string) => flags[flags.indexOf(name) + 1];
  assertEquals(flag("--tools"), "");
  assertEquals(flag("--output-format"), "json");
  assertEquals(flag("--system-prompt"), "SYS");
  assertEquals(flag("--model"), "haiku");
  for (
    const f of [
      "--strict-mcp-config",
      "--no-session-persistence",
      "--disable-slash-commands",
    ]
  ) {
    assert(flags.includes(f), f);
  }
  assertFalse(flags.includes("--mcp-config"));
  assertFalse(flags.includes("--allowedTools"));

  assertEquals(
    parseClaudeResult(
      'noise\r\n{"type":"result","subtype":"success","is_error":false,"result":"Hi\\n```sh\\nls\\n```"}\r\n',
    ),
    "Hi\n```sh\nls\n```",
  );
  assertThrows(
    () =>
      parseClaudeResult(
        '{"type":"result","is_error":true,"result":"Not logged in"}',
      ),
    Error,
    "Claude Code: Not logged in",
  );
  assertThrows(
    () => parseClaudeResult("command not found"),
    Error,
    "no answer (command not found)",
  );
});

// ---------------------------------------------------------------------------------------------
// The shipped scripts
// ---------------------------------------------------------------------------------------------

Deno.test("scripts: lib/hub/shell-scripts.ts matches resources (run scripts/gen-hub-scripts.ts)", () => {
  const root = new URL("../resources/", import.meta.url);
  assertEquals(
    QUTTY_AGENT_SCRIPT,
    Deno.readTextFileSync(new URL("bin/qutty-agent", root)),
  );
  assertEquals(
    QUTTY_ZSH_PLUGIN,
    Deno.readTextFileSync(new URL("shell/qutty.zsh", root)),
  );
  assertEquals(
    QUTTY_BASH_PLUGIN,
    Deno.readTextFileSync(new URL("shell/qutty.bash", root)),
  );
  assert(QUTTY_AGENT_SCRIPT.startsWith("#!/usr/bin/env bash\n"));
  assert(
    (Deno.statSync(new URL("bin/qutty-agent", root)).mode ?? 0o755) & 0o100,
    "qutty-agent is executable",
  );
});

// ---------------------------------------------------------------------------------------------
// The rc opt-in, on a temp HOME
// ---------------------------------------------------------------------------------------------

/** ConfigFs over Deno's sync file APIs, confined to a temp HOME. */
function tempFs(): ConfigFs {
  const tryOr = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  return {
    read: (p) => Promise.resolve(tryOr(() => Deno.readTextFileSync(p))),
    write: (p, text, mode) => {
      Deno.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      Deno.writeTextFileSync(p, text, { mode });
      Deno.chmodSync(p, mode);
      return Promise.resolve();
    },
    remove: (p) => Promise.resolve(Deno.removeSync(p)),
    mode: (p) =>
      Promise.resolve(tryOr(() => (Deno.statSync(p).mode ?? 0) & 0o777)),
    realPath: (p) => Promise.resolve(tryOr(() => Deno.realPathSync(p)) ?? p),
  };
}

async function withTempHome(fn: (home: string) => Promise<void>) {
  const home = await Deno.makeTempDir({ prefix: "qutty-shell-home-" });
  try {
    await fn(home);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("rc opt-in: zsh install / uninstall restores the bytes, keeps a backup, is idempotent", async () => {
  await withTempHome(async (home) => {
    const fs = tempFs();
    const paths = hubPaths(home);
    const zshrc = `${home}/.zshrc`;
    const original = "export EDITOR=vim\nalias ll='ls -l'"; // no trailing newline
    Deno.writeTextFileSync(zshrc, original, { mode: 0o600 });
    Deno.chmodSync(zshrc, 0o600);

    await installShellRc(fs, home, paths, "zsh");
    await installShellRc(fs, home, paths, "zsh");
    const text = Deno.readTextFileSync(zshrc);
    assert(text.startsWith(`${original}\n\n# >>> qutty shell agent`), text);
    assertEquals(
      text.split(shellRcLine(shellAgentPaths(paths).zsh)).length,
      2,
      "once",
    );
    assertStringIncludes(text, `${home}/.qutty/shell/qutty.zsh`);
    assertEquals((Deno.statSync(zshrc).mode ?? 0) & 0o777, 0o600, "mode kept");
    assertEquals(Deno.readTextFileSync(`${zshrc}.qutty-backup`), original);
    const [zsh] = await shellRcStatus(fs, home, paths);
    assertEquals([zsh.target, zsh.installed], ["zsh", true]);

    await uninstallShellRc(fs, home, paths, "zsh");
    assertEquals(Deno.readTextFileSync(zshrc), original, "byte-identical");
    assertEquals((await shellRcStatus(fs, home, paths))[0].installed, false);
  });
});

Deno.test("rc opt-in: bash writes ~/.bashrc (created, then removed) and an existing ~/.bash_profile", async () => {
  await withTempHome(async (home) => {
    const fs = tempFs();
    const paths = hubPaths(home);
    const profile = "# login\n[ -f ~/.bashrc ] && . ~/.bashrc\n";
    Deno.writeTextFileSync(`${home}/.bash_profile`, profile);
    // Through the panel's entry point (lib/hub/integration.ts dispatches the shell targets).
    const files = integrationFiles(home, paths);
    await installIntegration(fs, files, paths, "bash");
    const bashrc = Deno.readTextFileSync(`${home}/.bashrc`);
    assert(bashrc.startsWith("# >>> qutty shell agent"), bashrc);
    assertStringIncludes(bashrc, `${home}/.qutty/shell/qutty.bash`);
    assertStringIncludes(
      Deno.readTextFileSync(`${home}/.bash_profile`),
      "qutty shell agent",
    );
    const status = await integrationStatus(fs, files, paths);
    assertEquals(status.map((s) => [s.target, s.installed]), [
      ["claude", false],
      ["codex", false],
      ["hermes", false],
      ["zsh", false],
      ["bash", true],
    ]);
    assertEquals(status[4].changes.map((c) => c.path), [
      "~/.bashrc",
      "~/.bash_profile",
    ]);

    await uninstallShellRc(fs, home, paths, "bash");
    assertFalse(
      await Deno.stat(`${home}/.bashrc`).then(() => true, () => false),
      "created file removed",
    );
    assertEquals(Deno.readTextFileSync(`${home}/.bash_profile`), profile);
  });
});

Deno.test("rc opt-in: a symlinked rc file is edited at its target", async () => {
  await withTempHome(async (home) => {
    const fs = tempFs();
    const paths = hubPaths(home);
    Deno.mkdirSync(`${home}/dotfiles`);
    Deno.writeTextFileSync(`${home}/dotfiles/zshrc`, "setopt autocd\n");
    Deno.symlinkSync(`${home}/dotfiles/zshrc`, `${home}/.zshrc`);
    await installShellRc(fs, home, paths, "zsh");
    assert(Deno.lstatSync(`${home}/.zshrc`).isSymlink, "still a link");
    assertStringIncludes(
      Deno.readTextFileSync(`${home}/dotfiles/zshrc`),
      "qutty shell agent",
    );
    await uninstallShellRc(fs, home, paths, "zsh");
    assertEquals(
      Deno.readTextFileSync(`${home}/dotfiles/zshrc`),
      "setopt autocd\n",
    );
  });
});
