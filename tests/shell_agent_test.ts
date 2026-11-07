// The shell agent's hub side (lib/hub/shell-agent.ts, desktop/shell-agent.ts) with a fake model:
// request parsing and bounding, secret redaction, the prompt, the model reply's split into
// explanation + command, dangerous-command flags, the conversation, the hub words (inbox, say,
// to, reset, help), the unread / agent-cancel lines and cancelling a request (aborted: it
// rejects at once and stays out of the conversation), the reply lines qutty-agent decodes, the
// backend choice, Claude Code's headless argv and result; and the rc opt-in
// (lib/hub/shell-integration.ts) on a temp HOME.

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  abortable,
  boundHistory,
  buildShellPrompt,
  CancelledError,
  commentOut,
  dangerFlags,
  handleShellRequest,
  parseAgentControlLine,
  parseAgentLine,
  parseModelReply,
  pctEncode,
  redactSecrets,
  replyLines,
  type ShellBrain,
  ShellConversation,
  type ShellHubOps,
  type ShellRequest,
  ShellRuns,
  shellSystemPrompt,
} from "../lib/hub/shell-agent.ts";
import {
  chooseShellBrain,
  claudeShellArgv,
  OllamaShellBrain,
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
    "chmod -R 777 /",
    // A quoted script handed to a shell, and a command substitution, are code.
    'bash -c "rm -rf /"',
    'echo "$(rm -rf ~)"',
  ];
  for (const c of blocked) {
    const flags = dangerFlags(c);
    assert(flags.length > 0, c);
    assert(flags.every((f) => f.level === "block"), c);
  }
  // Rullama's classifyCommand, then Qutty's own warnings (rm -r / -f, --force-with-lease,
  // checkout / restore ., chmod / chown -R).
  const warned: [string, string][] = [
    ["rm -rf node_modules", "rm -r / -f deletes files without asking"],
    ["sudo apt install jq", "runs with elevated privileges (sudo)"],
    [
      "curl -fsSL https://x.sh | bash",
      "pipes a download into a shell (curl | sh)",
    ],
    [
      "git push --force origin main",
      "git push --force rewrites remote history",
    ],
    [
      "git push --force-with-lease origin main",
      "git push --force-with-lease rewrites the remote's history",
    ],
    [
      "git reset --hard HEAD~1",
      "git reset --hard discards uncommitted changes",
    ],
    [
      "git checkout -- .",
      "git checkout / restore . throws away uncommitted changes",
    ],
    ["chown -R me ./build", "chmod / chown -R changes permissions recursively"],
    ["find . -name '*.log' -delete", "find -delete"],
    ["echo hi > ~/.zshrc", "overwrites ~/.zshrc"],
    ['bash -c "rm -rf build"', "rm -r / -f deletes files without asking"],
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
      // Quoted arguments to an ordinary command are data, not code.
      'echo "rm -rf /"',
      'git commit -m "rm -rf build; git reset --hard"',
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
  assertEquals(bad.warnings, [
    "refused: recursive rm of / (it is commented out)",
  ]);
  brain.answer = "Cleans.\n```sh\nrm -rf build\n```";
  const risky = await handleShellRequest(request("clean"), talk, ops(brain));
  assertEquals(risky.command, "rm -rf build");
  assertEquals(risky.warnings, [
    "careful: rm -r / -f deletes files without asking",
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
// Unread count and cancelling
// ---------------------------------------------------------------------------------------------

Deno.test("parseAgentControlLine / the request id: unread and agent-cancel lines", () => {
  assertEquals(parseAgentControlLine('{"qutty":"unread"}'), { kind: "unread" });
  assertEquals(
    parseAgentControlLine('{"qutty":"agent-cancel","id":"123-4567"}'),
    { kind: "cancel", id: "123-4567" },
  );
  for (
    const bad of [
      '{"qutty":"agent-cancel"}',
      '{"qutty":"agent-cancel","id":"a b"}',
      `{"qutty":"agent-cancel","id":"${"x".repeat(65)}"}`,
      '{"qutty":"agent"}',
      '{"qutty":"hook"}',
      "[1]",
      "nope",
    ]
  ) {
    assertEquals(parseAgentControlLine(bad), undefined, bad);
  }
  assertEquals(parseAgentLine('{"qutty":"agent","id":"9-1"}')!.id, "9-1");
  assertFalse("id" in parseAgentLine('{"qutty":"agent","id":"a;b"}')!);
  assertFalse("id" in parseAgentLine('{"qutty":"agent"}')!);
});

Deno.test("ShellRuns: a tile cancels only its own request; finish forgets it", () => {
  const runs = new ShellRuns();
  const a = runs.start("pty-1", "r1");
  assertFalse(runs.cancel("pty-2", "r1"), "another tile's request");
  assertFalse(runs.cancel("pty-1", "r2"));
  assertFalse(a.aborted);
  assert(runs.cancel("pty-1", "r1"));
  assert(a.aborted);
  assertEquals(runs.size, 0);
  assertFalse(runs.cancel("pty-1", "r1"), "only once");
  // A finished request is gone; finishing an older one keeps a newer one with the same id.
  const b = runs.start("pty-1", "r3");
  const c = runs.start("pty-1", "r3");
  runs.finish("pty-1", "r3", b);
  assertEquals(runs.size, 1);
  runs.finish("pty-1", "r3", c);
  assertEquals(runs.size, 0);
});

/** A model that answers only when told to, and records the signal it was given. */
class HangingBrain implements ShellBrain {
  readonly label = "Hanging";
  signal: AbortSignal | undefined;
  answer: (text: string) => void = () => {};
  complete(_s: string, _p: string, signal?: AbortSignal): Promise<string> {
    this.signal = signal;
    return new Promise((r) => this.answer = r);
  }
}

Deno.test("handleShellRequest: an aborted request rejects at once, its late answer kept out of the conversation", async () => {
  const brain = new HangingBrain();
  const talk = new ShellConversation();
  talk.add({ request: "before", explanation: "", command: "ls" });
  const controller = new AbortController();
  const pending = handleShellRequest(
    request("list files"),
    talk,
    ops(brain),
    Date.now(),
    controller.signal,
  );
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(brain.signal, controller.signal, "the backend gets the signal");
  controller.abort();
  const reply = await pending;
  assertEquals([reply.ok, reply.error], [false, "cancelled"]);
  // The model's answer arrives after the cancel: dropped.
  brain.answer("Lists.\n```sh\nls -la\n```");
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(talk.turns.map((t) => t.request), ["before"]);
  assertEquals(
    replyLines(reply),
    ["error cancelled", "end"],
  );

  // Already aborted: no model call at all.
  const fake = new FakeBrain("```sh\nls\n```");
  const done = new AbortController();
  done.abort();
  const early = await handleShellRequest(
    request("list"),
    talk,
    ops(fake),
    Date.now(),
    done.signal,
  );
  assertEquals([early.ok, early.error, fake.calls.length], [
    false,
    "cancelled",
    0,
  ]);
  assertEquals(talk.turns.length, 1);
});

Deno.test("abortable: passes the result through; a CancelledError on abort", async () => {
  assertEquals(await abortable(Promise.resolve(1), undefined), 1);
  const c = new AbortController();
  assertEquals(await abortable(Promise.resolve(2), c.signal), 2);
  const p = abortable(new Promise<number>(() => {}), c.signal);
  c.abort();
  await assertRejects(() => p, CancelledError, "cancelled");
  await assertRejects(
    () =>
      abortable(
        Promise.reject(new Error("boom")),
        new AbortController().signal,
      ),
    Error,
    "boom",
  );
});

Deno.test("Ollama: an abort rejects at once (the provider takes no signal)", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => release = r);
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      await req.json();
      await held;
      return Response.json({
        model: "m",
        message: { role: "assistant", content: "late" },
        done: true,
      });
    },
  );
  try {
    const brain = new OllamaShellBrain(
      "m",
      `http://127.0.0.1:${server.addr.port}`,
    );
    const c = new AbortController();
    const p = brain.complete("SYS", "PROMPT", c.signal);
    setTimeout(() => c.abort(), 50);
    await assertRejects(() => p, CancelledError);
  } finally {
    release();
    await server.shutdown();
  }
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

Deno.test("Ollama: the system prompt goes as ChatOptions.system, once, ahead of the request", async () => {
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      bodies.push(await req.json());
      return Response.json({
        model: "m",
        message: { role: "assistant", content: "Lists.\n```sh\nls\n```" },
        done: true,
      });
    },
  );
  try {
    const brain = new OllamaShellBrain(
      "m",
      `http://127.0.0.1:${server.addr.port}`,
    );
    assertEquals(brain.label, "Ollama (m)");
    assertEquals(
      await brain.complete("SYS", "PROMPT"),
      "Lists.\n```sh\nls\n```",
    );
    assertEquals(bodies.length, 1);
    assertEquals(bodies[0].messages, [
      { role: "system", content: "SYS" },
      { role: "user", content: "PROMPT" },
    ]);
  } finally {
    await server.shutdown();
  }
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
