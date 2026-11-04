// lib/ssh-config.ts: OpenSSH config parsing, host entries, Qutty's metadata comment, editing
// qutty.conf without losing a byte of anything else, Include resolution, quick-connect parsing
// and the one-line Include edit of the user's config. Pure: no files. Run: deno test -A tests/

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  deleteHost,
  ensureInclude,
  hasQuttyInclude,
  hostsOf,
  includeValues,
  isSafeAlias,
  isSafeHost,
  isSafeUser,
  loadSshHosts,
  parseDirective,
  parseQuickTarget,
  parseSshConfig,
  quoteValue,
  resolveIncludePath,
  serializeMeta,
  serializeSshConfig,
  splitWords,
  type SshConfigFs,
  targetLabel,
  targetProblem,
  upsertHost,
} from "../lib/ssh-config.ts";

const HOME = "/home/u";

const SAMPLE = `# My hosts
Include config.d/*
Include ~/.ssh/work.conf

Host web web.example.com
    HostName web.example.com
    User deploy
    Port 2222
    IdentityFile "~/My Keys/id_ed25519"
    ForwardAgent yes
    # the forward
    LocalForward 8080 localhost:80

host=db
  hostname = 10.0.0.5
  USER postgres
  ProxyJump bastion
  IdentityFile ~/.ssh/a
  IdentityFile ~/.ssh/b

Host *.internal
    User root

Match host bastion exec "test -f /tmp/x"
    ProxyCommand nc %h %p

Host *
    ServerAliveInterval 30
`;

Deno.test("directives: key/value forms, case, quotes, comments", () => {
  assertEquals(parseDirective("  HostName  x.y  "), {
    key: "HostName",
    lkey: "hostname",
    value: "x.y",
  });
  assertEquals(parseDirective("user=bob"), {
    key: "user",
    lkey: "user",
    value: "bob",
  });
  assertEquals(parseDirective("Port = 22\r")?.value, "22");
  assertEquals(parseDirective("# comment"), undefined);
  assertEquals(parseDirective("   "), undefined);
  assertEquals(splitWords(`a "b c" d`), ["a", "b c", "d"]);
  assertEquals(quoteValue("plain"), "plain");
  assertEquals(quoteValue("with space"), `"with space"`);
});

Deno.test("hosts: entries, aliases, modelled fields, verbatim directives, patterns skipped", () => {
  const hosts = hostsOf(parseSshConfig(SAMPLE), "/home/u/.ssh/config", false);
  assertEquals(hosts.map((h) => h.alias), ["web", "db"]);
  const [web, db] = hosts;
  assertEquals(web.aliases, ["web", "web.example.com"]);
  assertEquals(web.hostName, "web.example.com");
  assertEquals(web.user, "deploy");
  assertEquals(web.port, 2222);
  assertEquals(web.identityFile, "~/My Keys/id_ed25519");
  assertEquals(web.directives, [
    { key: "ForwardAgent", value: "yes" },
    { key: "LocalForward", value: "8080 localhost:80" },
  ]);
  assertEquals(web.source, "/home/u/.ssh/config");
  assertEquals(web.editable, false);
  assertEquals(web.tags, undefined);
  // `host=db`, `hostname = `, `USER`: keywords are case-insensitive and `=` is a separator.
  assertEquals(db.hostName, "10.0.0.5");
  assertEquals(db.user, "postgres");
  assertEquals(db.proxyJump, "bastion");
  assertEquals(db.port, undefined);
  // The first IdentityFile is the field (ssh's first-wins rule); the second stays a directive.
  assertEquals(db.identityFile, "~/.ssh/a");
  assertEquals(db.directives, [{ key: "IdentityFile", value: "~/.ssh/b" }]);
});

Deno.test("hosts: a bad Port is ignored, not taken", () => {
  const hosts = hostsOf(parseSshConfig("Host a\n Port 99999\n"), "f", true);
  assertEquals(hosts[0].port, undefined);
  assertEquals(hosts[0].directives, []);
});

Deno.test("round trip: parse + serialize is the identity, whatever the file holds", () => {
  for (
    const text of [
      SAMPLE,
      "",
      "\n",
      "Host a",
      "Host a\n",
      "# only\n\n\n",
      "\r\nHost a\r\n  User x\r\n",
    ]
  ) {
    assertStrictEquals(serializeSshConfig(parseSshConfig(text)), text);
  }
});

Deno.test("metadata: the qutty comment is read, normalized and written back", () => {
  const text = `Host prod
  HostName p.example.com
  # qutty: {"tint":"red","tags":["prod",""],"favorite":true,"tmux":true,"remoteCommand":"htop","junk":1}
`;
  const [h] = hostsOf(parseSshConfig(text), "f", true);
  assertEquals(h.tint, "red");
  assertEquals(h.tags, ["prod"]);
  assertEquals(h.favorite, true);
  assertEquals(h.tmux, true);
  assertEquals(h.remoteCommand, "htop");
  assert(!("junk" in h));
  // A broken comment is ignored.
  const [b] = hostsOf(parseSshConfig("Host x\n # qutty: {nope\n"), "f", true);
  assertEquals(b.tint, undefined);
  assertEquals(serializeMeta({}), undefined);
  assertEquals(serializeMeta({ favorite: false, tags: [] }), undefined);
  assertEquals(
    serializeMeta({ tint: "blue", tags: ["a"] }),
    `# qutty: {"tint":"blue","tags":["a"]}`,
  );
});

Deno.test("upsert: a new host is appended with a blank separator and a final newline", () => {
  const out = upsertHost("Host a\n  User x\n", {
    alias: "b",
    hostName: "b.example.com",
    user: "me",
    port: 2200,
    identityFile: "~/k ey",
    tint: "red",
    tags: ["prod"],
  });
  assertEquals(
    out,
    `Host a\n  User x\n\nHost b\n  HostName b.example.com\n  User me\n  Port 2200\n  IdentityFile "~/k ey"\n  # qutty: {"tint":"red","tags":["prod"]}\n`,
  );
  // Into an empty file, and the file's own indentation is followed.
  assertEquals(upsertHost("", { alias: "a", user: "u" }), "Host a\n  User u\n");
  assertEquals(
    upsertHost("Host z\n\tUser q\n", { alias: "a", user: "u" }),
    "Host z\n\tUser q\n\nHost a\n\tUser u\n",
  );
});

Deno.test("upsert: an existing block keeps everything it does not model, in place", () => {
  const text = `# top comment
Host a other-alias
    # keep me
    HostName old.example.com
    ForwardAgent yes
    Port 22
    Port 23
    LocalForward 1 2

Host b
    User bb
`;
  const out = upsertHost(text, {
    alias: "a",
    hostName: "new.example.com",
    user: "me",
    favorite: true,
  });
  assertEquals(
    out,
    `# top comment
Host a other-alias
    User me
    # qutty: {"favorite":true}
    # keep me
    HostName new.example.com
    ForwardAgent yes
    LocalForward 1 2

Host b
    User bb
`,
  );
  const [a] = hostsOf(parseSshConfig(out), "f", true);
  assertEquals(a.aliases, ["a", "other-alias"]);
  assertEquals(
    a.port,
    undefined,
    "a cleared field and its duplicate are both gone",
  );
  assertEquals(a.favorite, true);
});

Deno.test("upsert: renaming keeps the block and its other aliases", () => {
  const out = upsertHost("Host old alt\n  ForwardAgent yes\n", {
    alias: "new",
    previousAlias: "old",
    user: "u",
  });
  assertEquals(out, "Host new alt\n  User u\n  ForwardAgent yes\n");
});

Deno.test("upsert: the metadata comment is replaced, or removed when nothing is left", () => {
  const text = `Host a\n  # qutty: {"tint":"red"}\n  User u\n`;
  assertEquals(
    upsertHost(text, { alias: "a", user: "u", tint: "blue" }),
    `Host a\n  # qutty: {"tint":"blue"}\n  User u\n`,
  );
  assertEquals(
    upsertHost(text, { alias: "a", user: "u" }),
    `Host a\n  User u\n`,
  );
});

Deno.test("delete: removes the block (and its trailing blank lines) and nothing else", () => {
  const text =
    "# c\nHost a\n  User a\n\nHost b\n  User b\n\nHost c\n  User c\n";
  assertEquals(
    deleteHost(text, "b"),
    "# c\nHost a\n  User a\n\nHost c\n  User c\n",
  );
  assertEquals(
    deleteHost(text, "c"),
    "# c\nHost a\n  User a\n\nHost b\n  User b\n",
  );
  assertEquals(
    deleteHost(text, "a"),
    "# c\nHost b\n  User b\n\nHost c\n  User c\n",
  );
  assertStrictEquals(deleteHost(text, "nope"), text);
  assertEquals(deleteHost("Host a\n  User a\n", "a"), "");
  // Only a literal alias matches: a pattern block is never deleted by a name it would match.
  assertStrictEquals(
    deleteHost("Host *.x\n  User a\n", "a.x"),
    "Host *.x\n  User a\n",
  );
});

Deno.test("include: values and path resolution", () => {
  assertEquals(includeValues(parseSshConfig(SAMPLE)), [
    { value: "config.d/*", line: 1 },
    { value: "~/.ssh/work.conf", line: 2 },
  ]);
  assertEquals(
    resolveIncludePath("config.d/*", HOME),
    "/home/u/.ssh/config.d/*",
  );
  assertEquals(
    resolveIncludePath("~/.ssh/work.conf", HOME),
    "/home/u/.ssh/work.conf",
  );
  assertEquals(resolveIncludePath("/etc/ssh/x", HOME), "/etc/ssh/x");
});

function fakeFs(
  files: Record<string, string>,
): SshConfigFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readText: (path) => {
      reads.push(path);
      return Promise.resolve(files[path]);
    },
    glob: (pattern) => {
      const re = new RegExp(
        `^${
          pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")
        }$`,
      );
      return Promise.resolve(
        Object.keys(files).filter((f) => re.test(f)).sort(),
      );
    },
  };
}

Deno.test("loadSshHosts: config, globbed and nested includes, cycles, depth, then qutty.conf", async () => {
  const fs = fakeFs({
    "/home/u/.ssh/config":
      "Host first\nInclude config.d/* ~/.ssh/loop.conf\nHost main\n User m\n",
    "/home/u/.ssh/config.d/10-a.conf": "Host a\n User a\n",
    "/home/u/.ssh/config.d/20-b.conf": "Host b\n User b\nInclude nested.conf\n",
    "/home/u/.ssh/nested.conf": "Host n\n User n\n",
    "/home/u/.ssh/loop.conf": "Include ~/.ssh/config\nHost loop\n User l\n",
    "/home/u/.ssh/qutty.conf":
      'Host saved\n User s\n # qutty: {"favorite":true}\n',
  });
  const hosts = await loadSshHosts(HOME, fs);
  // Included files are expanded where their Include line stands, as ssh reads them.
  assertEquals(hosts.map((h) => `${h.alias}:${h.editable}`), [
    "first:false",
    "a:false",
    "b:false",
    "n:false",
    "loop:false",
    "main:false",
    "saved:true",
  ]);
  assertEquals(
    hosts.find((h) => h.alias === "n")?.source,
    "/home/u/.ssh/nested.conf",
  );
  assertEquals(hosts.at(-1)?.favorite, true);
  assertEquals(
    fs.reads.filter((r) => r.endsWith("/config")).length,
    1,
    "the cycle is cut",
  );
});

Deno.test("loadSshHosts: qutty.conf reached through Include is listed once, editable", async () => {
  const fs = fakeFs({
    "/home/u/.ssh/config": "Include ~/.ssh/qutty.conf\nHost main\n",
    "/home/u/.ssh/qutty.conf": "Host saved\n",
  });
  const hosts = await loadSshHosts(HOME, fs);
  assertEquals(hosts.map((h) => [h.alias, h.editable]), [["main", false], [
    "saved",
    true,
  ]]);
});

Deno.test("loadSshHosts: no files at all is an empty list", async () => {
  assertEquals(await loadSshHosts(HOME, fakeFs({})), []);
});

Deno.test("loadSshHosts: the include depth is bounded", async () => {
  const files: Record<string, string> = {
    "/home/u/.ssh/config": "Include d1\n",
  };
  for (let i = 1; i <= 12; i++) {
    files[`/home/u/.ssh/d${i}`] = `Include d${i + 1}\nHost h${i}\n`;
  }
  const hosts = await loadSshHosts(HOME, fakeFs(files));
  assert(hosts.length >= 8 && hosts.length < 12, `${hosts.length} hosts`);
});

Deno.test("quick connect: user, host, port, IPv6 forms, rejects", () => {
  assertEquals(parseQuickTarget("host"), { host: "host" });
  assertEquals(parseQuickTarget(" me@host.example.com:2222 "), {
    user: "me",
    host: "host.example.com",
    port: 2222,
  });
  assertEquals(parseQuickTarget("host:22"), { host: "host", port: 22 });
  assertEquals(parseQuickTarget("[::1]:22"), { host: "::1", port: 22 });
  assertEquals(parseQuickTarget("root@[fe80::1%en0]"), {
    user: "root",
    host: "fe80::1%en0",
  });
  assertEquals(parseQuickTarget("2001:db8::1"), { host: "2001:db8::1" });
  assertEquals(parseQuickTarget("a.b@c@host"), { user: "a.b@c", host: "host" });
  for (
    const bad of [
      "",
      "-oProxyCommand=x",
      "me@-host",
      "host:0",
      "host:65536",
      "host:abc",
      "host:",
      "@host",
      "me@",
      "ho st",
      "host;rm",
      "$(x)",
      "[::1",
    ]
  ) {
    assertEquals(parseQuickTarget(bad), undefined, JSON.stringify(bad));
  }
});

Deno.test("targets: validation and labels", () => {
  assertEquals(targetProblem({ alias: "web" }), undefined);
  assertEquals(targetProblem({ alias: "-oX" }), "bad alias");
  assertEquals(targetProblem({ host: "h", user: "-u" }), "bad user");
  assertEquals(targetProblem({ host: "h", port: 70000 }), "bad port");
  assertEquals(targetLabel({ alias: "web" }), "web");
  assertEquals(targetLabel({ host: "h", user: "u", port: 22 }), "u@h:22");
  assertEquals(targetLabel({ host: "::1", port: 22 }), "[::1]:22");
  assert(
    isSafeAlias("a.b-c_1") && !isSafeAlias("-a") && !isSafeAlias("a b") &&
      !isSafeAlias("a*"),
  );
  assert(
    isSafeHost("::1") && isSafeHost("1.2.3.4") && !isSafeHost("a:b") &&
      !isSafeHost("::1;x"),
  );
  assert(
    isSafeUser("deploy") && isSafeUser("a.b@c") && !isSafeUser("-x") &&
      !isSafeUser("a b"),
  );
});

Deno.test("ensureInclude: inserted once at the very top, recognised in every spelling", () => {
  const first = ensureInclude("Host a\n  User a\n", HOME);
  assertEquals(first, {
    text: "Include ~/.ssh/qutty.conf\n\nHost a\n  User a\n",
    changed: true,
  });
  assertEquals(ensureInclude(first.text, HOME), {
    text: first.text,
    changed: false,
  });
  assertEquals(ensureInclude("", HOME), {
    text: "Include ~/.ssh/qutty.conf\n",
    changed: true,
  });
  for (
    const spelling of [
      "Include qutty.conf",
      "Include ~/.ssh/qutty.conf",
      "include /home/u/.ssh/qutty.conf",
      "Include ~/.ssh/*.conf",
      "Include other.conf qutty.conf",
      "Include=qutty.conf",
    ]
  ) {
    assert(hasQuttyInclude(`# c\n${spelling}\nHost a\n`, HOME), spelling);
  }
  // After a Host it applies to that block only, so it does not count; neither does another file.
  assert(!hasQuttyInclude("Host a\nInclude qutty.conf\n", HOME));
  assert(!hasQuttyInclude("Include qutty.conf.bak\n", HOME));
  assert(!hasQuttyInclude("Include ~/.ssh/config.d/*\n", HOME));
  assert(!hasQuttyInclude("# Include qutty.conf\n", HOME));
});
