// The `launchables` extension method (desktop/pty.ts): what the `+` picker can start, probed on
// this machine's file system with a stand-in /etc/shells, HOME and PATH; and the PATH a directly
// started agent tool gets. Run: deno test -A tests/

import { assert, assertEquals } from "@std/assert";
import ext, { findLaunchables, PtyHost } from "../desktop/pty.ts";
import { HAS_SH, POSIX, Recorder, withEnv } from "./pty_helpers.ts";

const opts = {
  sanitizeOps: false,
  sanitizeResources: false,
  ignore: !POSIX || !HAS_SH,
};

/** A temp folder with an executable `#!/bin/sh` script `name` holding `body`. */
async function fakeTool(dir: string, name: string, body: string) {
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${body}\n`);
  await Deno.chmod(path, 0o755);
  return path;
}

Deno.test(
  "findLaunchables: /etc/shells probed and deduped, agents in the user bin folders",
  opts,
  async () => {
    const tmp = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "qutty-launch-" }),
    );
    try {
      const home = `${tmp}/home`;
      const claude = await fakeTool(`${home}/.local/bin`, "claude", "exit 0");
      // Not executable: not offered.
      await Deno.mkdir(`${home}/bin`, { recursive: true });
      await Deno.writeTextFile(`${home}/bin/codex`, "#!/bin/sh\n");
      await Deno.chmod(`${home}/bin/codex`, 0o644);
      // A second name for /bin/sh (what merged-/usr Linux has).
      await Deno.symlink("/bin/sh", `${tmp}/sh-alias`);
      const etc = `${tmp}/shells`;
      await Deno.writeTextFile(
        etc,
        [
          "# comment",
          "/bin/sh",
          `${tmp}/sh-alias`,
          `${tmp}/missing-shell`,
          `${home}/bin/codex`,
          "",
        ].join("\n"),
      );
      await withEnv(
        { HOME: home, PATH: "/nonexistent", SHELL: "/bin/sh" },
        async () => {
          const found = await findLaunchables(etc);
          assertEquals(found.shells, [
            { path: "/bin/sh", label: "sh", isDefault: true },
          ]);
          const agent = found.agents.find((a) => a.name === "claude");
          assertEquals(agent, {
            name: "claude",
            label: "Claude Code",
            path: claude,
          });
          assert(!found.agents.some((a) => a.path === `${home}/bin/codex`));
        },
      );
      // No /etc/shells at all: the default shell alone.
      await withEnv({ HOME: home, SHELL: "/bin/sh" }, async () => {
        const found = await findLaunchables(`${tmp}/no-such-file`);
        assertEquals(found.shells.map((s) => s.path), ["/bin/sh"]);
      });
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

Deno.test(
  "launchables handler: the real machine's shells, each executable, one default",
  opts,
  async () => {
    const found = await ext.methods.launchables.handler();
    assert(found.shells.length > 0, "at least the default shell");
    assertEquals(found.shells.filter((s) => s.isDefault).length <= 1, true);
    const reals = new Set<string>();
    for (const s of [...found.shells]) {
      const real = await Deno.realPath(s.path);
      assert(!reals.has(real), `${s.path} is listed twice`);
      reals.add(real);
    }
    for (const a of found.agents) assert(a.path.startsWith("/"), a.path);
  },
);

Deno.test(
  "spawn: a directly started tool gets its own folder and the bin folders on PATH",
  opts,
  async () => {
    const tmp = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "qutty-agent-" }),
    );
    const rec = new Recorder();
    const host = new PtyHost(rec.emit);
    try {
      const tool = await fakeTool(
        `${tmp}/.local/bin`,
        "fake-agent",
        'echo "P=$PATH"; exit 7',
      );
      await withEnv({ HOME: tmp, PATH: "/nonexistent" }, async () => {
        // By bare name: found in ~/.local/bin although PATH has nothing.
        const t = await host.spawn({
          cols: 80,
          rows: 24,
          program: "fake-agent",
        });
        assertEquals(t.shell, tool);
        await rec.until("exit", () => rec.exits.has(t.id));
        const line = rec.text(t.id).split("\n").find((l) =>
          l.startsWith("P=")
        )!;
        const dirs = line.trim().slice(2).split(":");
        assertEquals(dirs[0], "/nonexistent", "the app's PATH first");
        assert(dirs.includes(`${tmp}/.local/bin`), line);
        assert(dirs.includes("/usr/bin"), line);
        assertEquals(rec.exits.get(t.id)!.exitCode, 7);
      });
    } finally {
      await host.dispose();
      await Deno.remove(tmp, { recursive: true });
    }
  },
);
