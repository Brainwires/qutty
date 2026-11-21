// Resuming coding agents after a restart (lib/agent/resume.ts, lib/ptyd/kept.ts): the resume
// command per agent, what the quit records, which tiles come back, and the restore decision
// (a surviving kept shell is never resumed into; at most eight without asking).

import { assertEquals } from "@std/assert";
import {
  type AgentIdentity,
  identityAtQuit,
  identityOf,
  planResumes,
  RESUME_CAP,
  resumeArgs,
  resumeDelay,
  resumeLine,
} from "../lib/agent/resume.ts";
import { parseKept, respawnPlan } from "../lib/ptyd/kept.ts";
import { hubArgsFor, hubPaths } from "../lib/hub/launch.ts";
import { Registry } from "../lib/hub/registry.ts";

const SID = "0b8f5a9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

Deno.test("resume: the command per agent, with the hub's arguments", () => {
  assertEquals(resumeArgs("claude", SID), ["--resume", SID]);
  assertEquals(resumeArgs("codex", SID), ["resume", SID]);
  const paths = hubPaths("/Users/me");
  const claude: AgentIdentity = {
    harness: "claude",
    session: SID,
    cwd: "/Users/me/my project",
  };
  assertEquals(
    resumeLine(claude, hubArgsFor("claude", paths)),
    `cd -- '/Users/me/my project' && claude --mcp-config /Users/me/.qutty/claude-mcp.json --settings /Users/me/.qutty/claude-hooks.json --resume ${SID}\r`,
  );
  // The user-scope integration is installed: no extra arguments.
  assertEquals(
    resumeLine(claude, hubArgsFor("claude", paths, { claude: true })),
    `cd -- '/Users/me/my project' && claude --resume ${SID}\r`,
  );
  // Codex: its -c overrides before the subcommand, each one quoted for the shell.
  const codex = resumeLine(
    { harness: "codex", session: SID },
    hubArgsFor("codex", paths),
  );
  assertEquals(codex.startsWith("codex -c 'mcp_servers.qutty.command="), true);
  assertEquals(codex.endsWith(` resume ${SID}\r`), true);
  // An agent tile from the + picker: its own program and arguments, exec'd.
  assertEquals(
    resumeLine({ harness: "claude", session: SID, cwd: "/w" }, [], {
      path: "/opt/bin/claude",
      args: ["--model", "opus"],
    }),
    `cd -- /w && exec /opt/bin/claude --model opus --resume ${SID}\r`,
  );
});

Deno.test("resume: what the quit records", () => {
  const tile = { harness: "claude", session: SID, cwd: "/repo" };
  assertEquals(identityAtQuit(tile, "claude", "/elsewhere"), {
    harness: "claude",
    session: SID,
    cwd: "/repo",
  });
  // The agent had quit back to its shell: nothing to resume.
  assertEquals(identityAtQuit(tile, "zsh"), undefined);
  assertEquals(identityAtQuit(tile, "-zsh"), undefined);
  assertEquals(identityAtQuit(tile, undefined), undefined);
  // No session id, or an agent Qutty cannot resume.
  assertEquals(identityAtQuit({ harness: "claude" }, "claude"), undefined);
  assertEquals(
    identityAtQuit({ harness: "gemini", session: SID }, "node"),
    undefined,
  );
  // The hook's folder, else the terminal's; "Don't resume" goes with it.
  assertEquals(
    identityAtQuit(
      { harness: "codex", session: SID, noResume: true },
      "codex",
      "/t",
    ),
    { harness: "codex", session: SID, cwd: "/t", noResume: true },
  );
  // A record from disk is checked.
  assertEquals(identityOf({ harness: "claude", session: "a b" }), undefined);
  assertEquals(
    identityOf({ harness: "claude", session: SID, cwd: "relative" }),
    { harness: "claude", session: SID },
  );
});

Deno.test("resume: the restore decision", () => {
  const c = (
    n: number,
    extra: Partial<AgentIdentity> = {},
    survived = false,
  ) => ({
    ptyId: `pty-${n}`,
    agent: { harness: "claude" as const, session: `s${n}`, ...extra },
    survived,
  });
  // A kept shell that survived: its agent still runs, never resumed into.
  assertEquals(planResumes([c(1, {}, true)], true), { resume: [], ask: [] });
  // A fresh shell: resumed.
  assertEquals(planResumes([c(2)], true).resume.map((x) => x.ptyId), [
    "pty-2",
  ]);
  // The setting off, or "Don't resume this agent".
  assertEquals(planResumes([c(3)], false), { resume: [], ask: [] });
  assertEquals(planResumes([c(4, { noResume: true })], true).resume, []);
  // At most eight without asking.
  const many = Array.from({ length: 11 }, (_, i) => c(i));
  const plan = planResumes(many, true);
  assertEquals(plan.resume.length, RESUME_CAP);
  assertEquals(plan.ask.map((x) => x.ptyId), ["pty-8", "pty-9", "pty-10"]);
  // Staggered.
  assertEquals(resumeDelay(1) - resumeDelay(0) > 0, true);
});

Deno.test("resume: a restart brings back shell tiles with their agent, and agent tiles only to resume", () => {
  const snapshot = {
    v: 1,
    tiles: {
      t1: { ptyId: "pty-1", profile: { kind: "shell" } },
      t2: {
        ptyId: "pty-2",
        profile: {
          kind: "agent",
          program: "/opt/bin/codex",
          name: "codex",
          label: "Codex",
        },
      },
      t3: {
        ptyId: "pty-3",
        profile: {
          kind: "agent",
          program: "/opt/bin/claude",
          name: "claude",
          label: "Claude Code",
        },
      },
      t4: {
        ptyId: "pty-4",
        profile: {
          kind: "agent",
          program: "/usr/bin/ollama",
          name: "claude",
          label: "Claude Code",
          ollamaModel: "qwen3:8b",
        },
      },
    },
  };
  const agent = { harness: "claude", session: SID, cwd: "/repo" };
  const rec = parseKept({
    v: 1,
    workspaces: [{
      id: "ws",
      name: "W",
      snapshot,
      terms: [
        { ptyId: "pty-1", shell: "/bin/zsh", cols: 80, rows: 24, agent },
        {
          ptyId: "pty-2",
          shell: "/opt/bin/codex",
          cols: 80,
          rows: 24,
          agent: { harness: "codex", session: SID },
        },
        { ptyId: "pty-3", shell: "/opt/bin/claude", cols: 80, rows: 24 },
        { ptyId: "pty-4", shell: "/usr/bin/ollama", cols: 80, rows: 24, agent },
        // A record with a broken identity keeps the terminal, not the identity.
        {
          ptyId: "pty-5",
          shell: "/bin/sh",
          cols: 80,
          rows: 24,
          agent: { harness: "claude" },
        },
      ],
    }],
  })!;
  assertEquals(rec.workspaces[0].terms[4].agent, undefined);
  assertEquals(respawnPlan(rec.workspaces[0]), [
    {
      ptyId: "pty-1",
      shell: "/bin/zsh",
      cols: 80,
      rows: 24,
      history: "",
      agent: { harness: "claude", session: SID, cwd: "/repo" },
    },
    // The agent tile restarts as a login shell that exec's the agent; the one without a session
    // and the ollama one come back ended as before.
    {
      ptyId: "pty-2",
      cols: 80,
      rows: 24,
      history: "",
      agent: { harness: "codex", session: SID },
      program: { path: "/opt/bin/codex" },
    },
  ]);
});

Deno.test("resume: the registry's resumed and don't-resume marks", () => {
  const r = new Registry();
  r.add({ id: "pty-1" });
  r.setHarness("pty-1", "claude");
  r.setResumed("pty-1", true);
  r.setNoResume("pty-1", true);
  assertEquals(r.get("pty-1")!.resumed, true);
  assertEquals(r.get("pty-1")!.noResume, true);
  // The agent's first turn: no longer "resumed".
  r.setStatus("pty-1", "busy");
  assertEquals(r.get("pty-1")!.resumed, undefined);
  r.setNoResume("pty-1", false);
  assertEquals(r.get("pty-1")!.noResume, undefined);
  // A harness the screen detection named goes when its program quits, with the default name.
  assertEquals(r.get("pty-1")!.name, "claude");
  r.clearHarness("pty-1");
  assertEquals(r.get("pty-1")!.harness, undefined);
  assertEquals(r.get("pty-1")!.name, "shell-1");
});
