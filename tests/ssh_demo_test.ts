// The demo backend's SSH half (lib/ssh-demo.ts through lib/pty-client.ts): the fake hosts,
// the remote-looking shell a `program: "ssh"` spawn gets, in-memory save/delete, the listing
// tree and the timer-driven transfers (fake time). Run: deno test -A tests/

import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
// deno.json is not ours to edit (no "@std/testing" import), so the specifier is inline.
// deno-lint-ignore no-import-prefix
import { FakeTime } from "jsr:@std/testing@^1.0.0/time";
import { createDemoBackend, type SshTransferEvent } from "../lib/pty-client.ts";

Deno.test("demo ssh: hosts from config and qutty.conf, recents after connecting", async () => {
  const b = createDemoBackend();
  const { hosts, recents } = await b.sshHosts();
  assertEquals(hosts.map((h) => [h.alias, h.editable]), [["web-1", false], [
    "db",
    false,
  ], ["prod-api", true]]);
  assertEquals(hosts[1].aliases, ["db", "db-primary"]);
  assertEquals(hosts[2].tint, "red");
  assertEquals(hosts[2].tags, ["prod"]);
  assertEquals(recents, []);
  const cmd = await b.sshCommand({ alias: "prod-api" });
  assertEquals(cmd.program, "ssh");
  assertEquals(cmd.label, "prod-api");
  assertEquals(cmd.host?.alias, "prod-api");
  assertEquals(cmd.args.slice(-7), [
    "--",
    "prod-api",
    "tmux",
    "new",
    "-A",
    "-s",
    "qutty",
  ]);
  const quick = await b.sshCommand({ host: "10.0.0.1", user: "root" });
  assertEquals(quick.label, "root@10.0.0.1");
  assertEquals(quick.host, undefined);
  assertEquals((await b.sshHosts()).recents.map((r) => r.label), [
    "root@10.0.0.1",
    "prod-api",
  ]);
  await assertRejects(() => b.sshCommand({ alias: "-oX" }), Error, "bad alias");
});

Deno.test("demo ssh: a program: ssh spawn is a remote-looking shell", async () => {
  const b = createDemoBackend();
  const cmd = await b.sshCommand({ alias: "web-1" });
  const t = await b.spawn({
    cols: 80,
    rows: 24,
    program: cmd.program,
    args: cmd.args,
  });
  assertEquals(t.shell, "ssh");
  const chunks: string[] = [];
  b.onData(t.id, (d) => chunks.push(d));
  const text = () => chunks.join("");
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert(cond(), text());
  };
  await until(() => text().includes("deploy@web-1.example.com"));
  assert(text().includes("Welcome to"));
  // The fake remote shell reports its directory with OSC 7 on every prompt.
  assert(text().includes("\x1b]7;file://web-1.example.com/home/demo\x07"));
  assertEquals((await b.info(t.id)).process, "ssh");
  await b.write(t.id, "hostname\r");
  await until(() => text().includes("\r\nweb-1.example.com\r\n"));
  const exited = new Promise((r) => b.onExit(t.id, r));
  await b.write(t.id, "exit\r");
  await exited;
  assertMatch(text(), /Connection to web-1\.example\.com closed\./);
  // A quick target without a saved host, and a non-ssh program, still work.
  const q = await b.spawn({
    cols: 80,
    rows: 24,
    program: "ssh",
    args: ["--", "me@box"],
  });
  const qc: string[] = [];
  b.onData(q.id, (d) => qc.push(d));
  // The prompt colors its parts: match on the plain text.
  // deno-lint-ignore no-control-regex
  const plainText = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  await until(() => plainText(qc.join("")).includes("me@box:~$"));
  const plain = await b.spawn({ cols: 80, rows: 24, program: "/bin/bash" });
  assertEquals(plain.shell, "/bin/bash");
  assertEquals((await b.info(plain.id)).process, "demo-sh");
  await b.kill(q.id);
  await b.kill(plain.id);
});

Deno.test("demo ssh: save and delete only touch Qutty's own hosts", async () => {
  const b = createDemoBackend();
  const saved = await b.sshSaveHost({
    alias: "new-box",
    hostName: "n.example.com",
    user: "me",
    favorite: true,
  });
  assertEquals(saved.editable, true);
  assertEquals(saved.source, "/Users/demo/.ssh/qutty.conf");
  assertEquals((await b.sshHosts()).hosts.map((h) => h.alias), [
    "web-1",
    "db",
    "prod-api",
    "new-box",
  ]);
  const renamed = await b.sshSaveHost({
    alias: "box",
    previousAlias: "new-box",
    user: "you",
  });
  assertEquals(renamed.user, "you");
  assertEquals((await b.sshHosts()).hosts.map((h) => h.alias), [
    "web-1",
    "db",
    "prod-api",
    "box",
  ]);
  await assertRejects(
    () => b.sshSaveHost({ alias: "web-1", user: "x" }),
    Error,
    "~/.ssh/config",
  );
  await assertRejects(() => b.sshDeleteHost("web-1"), Error, "no such host");
  await b.sshDeleteHost("box");
  assertEquals((await b.sshHosts()).hosts.length, 3);
});

Deno.test("demo ssh: listing the fake remote tree", async () => {
  const b = createDemoBackend();
  const home = await b.sshList({ target: { alias: "web-1" } });
  assertEquals(home.path, "/home/demo");
  assertEquals(home.entries.map((e) => `${e.kind}:${e.name}`), [
    "dir:src",
    "file:notes.md",
    "file:backup.tar.gz",
    "file:report final.pdf",
    "link:latest",
  ]);
  assertEquals(
    (await b.sshList({ target: { alias: "web-1" }, path: "~/src" })).entries
      .length,
    2,
  );
  assertEquals(
    (await b.sshList({ target: { alias: "web-1" }, path: "/home/demo/src/" }))
      .path,
    "/home/demo/src",
  );
  await assertRejects(
    () => b.sshList({ target: { alias: "web-1" }, path: "~/nope" }),
    Error,
    "No such file",
  );
});

Deno.test("demo ssh: transfers tick to done; cancel ends one with an error", async () => {
  const time = new FakeTime();
  try {
    const b = createDemoBackend();
    const got: SshTransferEvent[] = [];
    b.onTransfer((e) => got.push(e));
    const { transferId } = await b.sshUpload({
      target: { alias: "web-1" },
      localPaths: ["/Users/demo/a.txt", "/Users/demo/photos"],
      remoteDir: "~",
    });
    time.tick(150 * 5);
    assertEquals(got.at(-1), {
      transferId,
      seq: 5,
      kind: "upload",
      file: "a.txt",
      percent: 100,
      filesDone: 1,
      fileCount: 2,
      done: false,
    });
    time.tick(150 * 5);
    assertEquals(got.length, 10);
    assertEquals(got.at(-1)?.file, "photos");
    assertEquals(got.at(-1)?.done, true);
    assertEquals(got.at(-1)?.filesDone, 2);
    got.forEach((e, i) => assertEquals(e.seq, i + 1));
    time.tick(1000);
    assertEquals(got.length, 10, "nothing after done");

    const dl = await b.sshDownload({
      target: { host: "h" },
      remotePath: "/var/log/app.log",
    });
    assertEquals(dl.localPath, "/Users/demo/Downloads/app.log");
    time.tick(150);
    assertEquals(got.at(-1)?.kind, "download");
    assertEquals(got.at(-1)?.percent, 20);
    await b.sshCancel(dl.transferId);
    assertEquals(got.at(-1), {
      transferId: dl.transferId,
      seq: 2,
      kind: "download",
      percent: 0,
      filesDone: 0,
      done: true,
      error: "cancelled",
    });
    time.tick(5000);
    assertEquals(got.length, 12);
    await b.sshCancel("unknown"); // a no-op
    assertEquals(got.length, 12);
  } finally {
    time.restore();
  }
});
