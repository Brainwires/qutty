// desktop/ssh.ts's SshService against a temporary home: what it writes, with which modes, and
// what it leaves alone. The user's real ~/.ssh is never touched (the home is a temp folder and
// ssh itself is never started here). Run: deno test -A tests/
//
// The sanitizers are off: the libc FFI library is opened once per process and lives on.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { SshService, type SshTransferEvent } from "../desktop/ssh.ts";
import { controlPathFor } from "../lib/ssh-command.ts";

const opts = { sanitizeOps: false, sanitizeResources: false };
const POSIX = Deno.build.os !== "windows";

const USER_CONFIG = `# my hosts
Host web
    HostName web.example.com
    User deploy

Host *
    ServerAliveInterval 30
`;

async function withHome(
  fn: (
    home: string,
    service: SshService,
    events: SshTransferEvent[],
  ) => Promise<void>,
  setup?: (home: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "qutty-ssh-" });
  const home = `${root}/home`;
  const appSupportDir = `${root}/support`;
  await Deno.mkdir(home);
  await setup?.(home);
  const events: SshTransferEvent[] = [];
  const service = new SshService({
    home,
    appSupportDir,
    emit: (_e, d) => events.push(d),
  });
  try {
    await fn(home, service, events);
  } finally {
    await service.dispose();
    await Deno.remove(root, { recursive: true });
  }
}

const mode = async (path: string) =>
  ((await Deno.stat(path)).mode ?? 0) & 0o777;
const read = (path: string) => Deno.readTextFile(path);
const exists = async (path: string) => {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
};

Deno.test(
  "save: a fresh home gets ~/.ssh 0700, qutty.conf 0600 and a config with the Include",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      const saved = await service.saveHost({
        alias: "prod",
        hostName: "p.example.com",
        user: "ops",
        port: 2222,
        tint: "red",
        tags: ["prod"],
        tmux: true,
      });
      assertEquals(await mode(`${home}/.ssh`), 0o700);
      assertEquals(await mode(`${home}/.ssh/qutty.conf`), 0o600);
      assertEquals(
        await read(`${home}/.ssh/qutty.conf`),
        `Host prod\n  HostName p.example.com\n  User ops\n  Port 2222\n  # qutty: {"tint":"red","tags":["prod"],"tmux":true}\n`,
      );
      assertEquals(
        await read(`${home}/.ssh/config`),
        "Include ~/.ssh/qutty.conf\n",
      );
      assertEquals(await mode(`${home}/.ssh/config`), 0o600);
      // No original, so nothing to back up.
      assert(!(await exists(`${home}/.ssh/config.qutty-backup`)));
      assertEquals(saved.alias, "prod");
      assertEquals(saved.editable, true);
      assertEquals(saved.source, `${home}/.ssh/qutty.conf`);
      assertEquals(saved.tmux, true);
      const { hosts } = await service.hosts();
      assertEquals(hosts.map((h) => h.alias), ["prod"]);
    });
  },
);

Deno.test(
  "save: an existing config gets the Include at the top, once, is otherwise byte-identical, keeps its mode; the backup is made once",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      const config = `${home}/.ssh/config`;
      const backup = `${config}.qutty-backup`;
      await service.saveHost({ alias: "a", user: "u" });
      assertStrictEquals(
        await read(config),
        `Include ~/.ssh/qutty.conf\n\n${USER_CONFIG}`,
      );
      assertEquals(await mode(config), 0o644, "the user's mode is preserved");
      assertStrictEquals(await read(backup), USER_CONFIG);
      assertEquals(await mode(backup), 0o644);

      // A second save changes neither the config nor the backup.
      await Deno.writeTextFile(backup, "ORIGINAL BACKUP");
      const before = await read(config);
      await service.saveHost({ alias: "b", user: "u", favorite: true });
      assertStrictEquals(await read(config), before);
      assertStrictEquals(await read(backup), "ORIGINAL BACKUP");

      // Both hosts are in qutty.conf; the config's own host is listed too, read-only.
      const { hosts } = await service.hosts();
      assertEquals(hosts.map((h) => [h.alias, h.editable]), [["web", false], [
        "a",
        true,
      ], ["b", true]]);
      assertEquals(hosts[2].favorite, true);
      // No temp files left behind.
      const names = [];
      for await (const e of Deno.readDir(`${home}/.ssh`)) names.push(e.name);
      assertEquals(names.sort(), [
        "config",
        "config.qutty-backup",
        "qutty.conf",
      ]);
    }, async (home) => {
      await Deno.mkdir(`${home}/.ssh`, { mode: 0o700 });
      await Deno.writeTextFile(`${home}/.ssh/config`, USER_CONFIG, {
        mode: 0o644,
      });
    });
  },
);

Deno.test(
  "save: a config that already includes qutty.conf is not touched at all",
  opts,
  async () => {
    if (!POSIX) return;
    const text = `Include ~/.ssh/*.conf\n${USER_CONFIG}`;
    await withHome(async (home, service) => {
      const config = `${home}/.ssh/config`;
      const before = await Deno.stat(config);
      await service.saveHost({ alias: "a", user: "u" });
      assertStrictEquals(await read(config), text);
      assertEquals(
        (await Deno.stat(config)).mtime?.getTime(),
        before.mtime?.getTime(),
      );
      assert(!(await exists(`${config}.qutty-backup`)));
    }, async (home) => {
      await Deno.mkdir(`${home}/.ssh`, { mode: 0o700 });
      await Deno.writeTextFile(`${home}/.ssh/config`, text);
    });
  },
);

Deno.test(
  "save: a symlinked config stays a symlink; its target is rewritten",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      await service.saveHost({ alias: "a", user: "u" });
      const config = `${home}/.ssh/config`;
      assert((await Deno.lstat(config)).isSymlink);
      assertStrictEquals(
        await read(`${home}/dotfiles/ssh_config`),
        `Include ~/.ssh/qutty.conf\n\n${USER_CONFIG}`,
      );
      assertStrictEquals(await read(`${config}.qutty-backup`), USER_CONFIG);
    }, async (home) => {
      await Deno.mkdir(`${home}/.ssh`, { mode: 0o700 });
      await Deno.mkdir(`${home}/dotfiles`);
      await Deno.writeTextFile(`${home}/dotfiles/ssh_config`, USER_CONFIG);
      await Deno.symlink(`${home}/dotfiles/ssh_config`, `${home}/.ssh/config`);
    });
  },
);

Deno.test(
  "save: updating keeps the block's other directives; rename keeps them too",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      const path = `${home}/.ssh/qutty.conf`;
      await Deno.mkdir(`${home}/.ssh`, { mode: 0o700 });
      await Deno.writeTextFile(
        path,
        "Host a\n  User old\n  ForwardAgent yes\n",
      );
      await service.saveHost({ alias: "a", user: "new", port: 22 });
      assertEquals(
        await read(path),
        "Host a\n  Port 22\n  User new\n  ForwardAgent yes\n",
      );
      const renamed = await service.saveHost({
        alias: "b",
        previousAlias: "a",
        user: "new",
      });
      assertEquals(
        await read(path),
        "Host b\n  User new\n  ForwardAgent yes\n",
      );
      assertEquals(renamed.alias, "b");
      assertEquals(renamed.directives, [{ key: "ForwardAgent", value: "yes" }]);
    });
  },
);

Deno.test(
  "delete: only qutty.conf hosts; the user's config is never written",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      await service.saveHost({ alias: "a", user: "u" });
      await service.saveHost({ alias: "b", user: "u" });
      const config = `${home}/.ssh/config`;
      const configText = await read(config);
      const stat = await Deno.stat(config);
      await service.deleteHost("a");
      assertEquals(await read(`${home}/.ssh/qutty.conf`), "Host b\n  User u\n");
      assertEquals(await mode(`${home}/.ssh/qutty.conf`), 0o600);
      // `web` lives in the user's config: not Qutty's to delete.
      await assertRejects(
        () => service.deleteHost("web"),
        Error,
        "no such host",
      );
      await assertRejects(
        () => service.deleteHost("nope"),
        Error,
        "no such host",
      );
      assertStrictEquals(await read(config), configText);
      assertEquals(
        (await Deno.stat(config)).mtime?.getTime(),
        stat.mtime?.getTime(),
      );
    }, async (home) => {
      await Deno.mkdir(`${home}/.ssh`, { mode: 0o700 });
      await Deno.writeTextFile(`${home}/.ssh/config`, USER_CONFIG);
    });
  },
);

Deno.test(
  "command: argv for a saved host and a quick target; recents are kept in the app-support folder",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      await service.saveHost({
        alias: "prod",
        user: "ops",
        tmux: true,
        remoteCommand: "htop",
      });
      const cmd = await service.command({ alias: "prod" });
      assertEquals(cmd.program, "ssh");
      assertEquals(cmd.label, "prod");
      assertEquals(cmd.host?.alias, "prod");
      assertEquals(cmd.args, [
        "-o",
        "ControlMaster=auto",
        "-o",
        // `~/.ssh/qutty-%C`, or `/tmp/qutty-%C` when the home is long (a temp one is).
        `ControlPath=${controlPathFor(home)}`,
        "-o",
        "ControlPersist=10m",
        "-t",
        "--",
        "prod",
        "tmux",
        "new",
        "-A",
        "-s",
        "qutty",
        "'htop'",
      ]);
      // A host from the user's config carries no Qutty metadata; a quick target carries no host.
      const web = await service.command({ alias: "web" });
      assertEquals(web.host?.editable, false);
      assertEquals(web.args.slice(-2), ["--", "web"]);
      const quick = await service.command({
        host: "10.0.0.9",
        user: "root",
        port: 2200,
      });
      assertEquals(quick.host, undefined);
      assertEquals(quick.label, "root@10.0.0.9:2200");
      assertEquals(quick.args.slice(-4), ["-p", "2200", "--", "root@10.0.0.9"]);
      assertEquals(
        await mode(`${home}/.ssh`),
        0o700,
        "the socket folder exists for ssh",
      );

      const { recents } = await service.hosts();
      assertEquals(recents.map((r) => r.label), [
        "root@10.0.0.9:2200",
        "web",
        "prod",
      ]);
      assertEquals(recents[0].target, {
        host: "10.0.0.9",
        user: "root",
        port: 2200,
      });
      assert(recents.every((r) => typeof r.at === "number"));
      // Injection is refused before anything is recorded.
      await assertRejects(
        () => service.command({ alias: "-oProxyCommand=x" }),
        Error,
        "bad alias",
      );
      assertEquals((await service.hosts()).recents.length, 3);
    }, async (home) => {
      await Deno.mkdir(`${home}/.ssh`, { mode: 0o700 });
      await Deno.writeTextFile(`${home}/.ssh/config`, USER_CONFIG);
    });
  },
);

Deno.test(
  "download: a missing folder is refused before anything starts",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      await assertRejects(
        () =>
          service.download({
            target: { alias: "a" },
            remotePath: "/x",
            localDir: `${home}/nope`,
          }),
        Error,
        "no such download folder",
      );
      // The default folder is ~/Downloads.
      await assertRejects(
        () => service.download({ target: { alias: "a" }, remotePath: "/x" }),
        Error,
        "no such download folder",
      );
      assertEquals(service.size, 0);
    });
  },
);

Deno.test(
  "upload: a missing local file is refused before anything starts",
  opts,
  async () => {
    if (!POSIX) return;
    await withHome(async (home, service) => {
      await assertRejects(
        () =>
          service.upload({
            target: { alias: "a" },
            localPaths: [`${home}/nope`],
            remoteDir: "~",
          }),
        Error,
        "no such local file",
      );
      assertEquals(service.size, 0);
    });
  },
);
