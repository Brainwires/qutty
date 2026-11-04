// lib/ssh-command.ts: the ssh/scp/sftp argv Qutty runs (shared-connection options, destination
// ordering, option-injection refusal, tmux and remote commands), the ControlPath length rule,
// the parsers for scp's progress meter and sftp's listing, and download naming. Pure.
// Run: deno test -A tests/

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  controlPathFits,
  controlPathFor,
  escapeRemoteGlob,
  lastErrorLine,
  parseScpProgress,
  parseSftpListing,
  pushRecent,
  remoteBaseName,
  remoteOperandPath,
  scpArgv,
  sftpArgv,
  sftpListBatch,
  sftpQuote,
  shellQuote,
  sshArgv,
  uniqueName,
} from "../lib/ssh-command.ts";

const CP = "/home/u/.ssh/qutty-%C";
const conn = { controlPath: CP };
const SHARED = [
  "-o",
  "ControlMaster=auto",
  "-o",
  `ControlPath=${CP}`,
  "-o",
  "ControlPersist=10m",
];
const BATCH = [
  "-o",
  "ControlMaster=no",
  "-o",
  `ControlPath=${CP}`,
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
];

Deno.test("ControlPath: under ~/.ssh when it fits the socket limit, else /tmp", () => {
  assertEquals(
    controlPathFor("/Users/nightness"),
    "/Users/nightness/.ssh/qutty-%C",
  );
  assert(controlPathFits(controlPathFor("/Users/nightness")));
  // 40 hex chars for %C plus the folder: the limit is 103 bytes.
  const longHome = `/home/${"x".repeat(60)}`;
  assertEquals(controlPathFor(longHome), "/tmp/qutty-%C");
  assert(!controlPathFits(`${longHome}/.ssh/qutty-%C`));
  const edge = `/${"a".repeat(103 - 40 - 1 - "/.ssh/qutty-".length)}`;
  assert(controlPathFits(`${edge}/.ssh/qutty-%C`));
  assert(!controlPathFits(`${edge}a/.ssh/qutty-%C`));
  // Bytes, not chars: a non-ASCII home counts for more.
  assert(!controlPathFits(`/home/${"é".repeat(40)}/.ssh/qutty-%C`));
  assertThrows(
    () => sshArgv({ alias: "a" }, { controlPath: `${longHome}/.ssh/qutty-%C` }),
    Error,
    "too long",
  );
});

Deno.test("ssh argv: alias, quick target, port, config file, destination after --", () => {
  assertEquals(sshArgv({ alias: "web" }, conn), [...SHARED, "--", "web"]);
  assertEquals(
    sshArgv({ host: "h.example.com", user: "me", port: 2222 }, conn),
    [
      ...SHARED,
      "-p",
      "2222",
      "--",
      "me@h.example.com",
    ],
  );
  assertEquals(sshArgv({ host: "::1" }, conn), [...SHARED, "--", "::1"]);
  assertEquals(
    sshArgv({ alias: "web" }, { controlPath: CP, configFile: "/t/cfg" }),
    [
      ...SHARED,
      "-F",
      "/t/cfg",
      "--",
      "web",
    ],
  );
});

Deno.test("ssh argv: tmux on connect and remote command", () => {
  assertEquals(sshArgv({ alias: "a" }, conn, { tmux: true }), [
    ...SHARED,
    "-t",
    "--",
    "a",
    "tmux",
    "new",
    "-A",
    "-s",
    "qutty",
  ]);
  assertEquals(sshArgv({ alias: "a" }, conn, { remoteCommand: "htop -d 5" }), [
    ...SHARED,
    "-t",
    "--",
    "a",
    "htop -d 5",
  ]);
  // Both: the remote command runs inside the tmux session, quoted for the remote shell.
  assertEquals(
    sshArgv({ alias: "a" }, conn, { tmux: true, remoteCommand: "echo it's" })
      .slice(-6),
    [
      "tmux",
      "new",
      "-A",
      "-s",
      "qutty",
      `'echo it'\\''s'`,
    ],
  );
  assertEquals(shellQuote("a b"), "'a b'");
});

Deno.test("argv: option injection is refused for every program", () => {
  const bad = [
    { alias: "-oProxyCommand=evil" },
    { host: "-h" },
    { host: "h", user: "-l" },
    { host: "h;x" },
    { alias: "a b" },
    { host: "h", port: 0 },
  ];
  for (const t of bad) {
    assertThrows(() => sshArgv(t, conn), Error, undefined, JSON.stringify(t));
    assertThrows(() => sftpArgv(t, conn), Error, undefined, JSON.stringify(t));
    assertThrows(
      () =>
        scpArgv(t, conn, {
          kind: "upload",
          localPaths: ["/a"],
          remoteDir: "~",
        }),
      Error,
      undefined,
      JSON.stringify(t),
    );
  }
});

Deno.test("scp argv: upload and download over the socket, SFTP mode, no prompts, `--`", () => {
  assertEquals(
    scpArgv({ alias: "web" }, conn, {
      kind: "upload",
      localPaths: ["/Users/me/a.txt", "/Users/me/dir with space"],
      remoteDir: "~/incoming",
    }),
    [
      ...BATCH,
      "-s",
      "-r",
      "--",
      "/Users/me/a.txt",
      "/Users/me/dir with space",
      "web:incoming",
    ],
  );
  assertEquals(
    scpArgv({ host: "::1", user: "u", port: 2022 }, conn, {
      kind: "download",
      remotePath: "/var/log/app [1].log",
      localPath: "/Users/me/Downloads/app [1].log",
    }),
    [
      ...BATCH,
      "-P",
      "2022",
      "-s",
      "-r",
      "--",
      "u@[::1]:/var/log/app \\[1\\].log",
      "/Users/me/Downloads/app [1].log",
    ],
  );
  // The home is the empty path for scp; `~/x` is relative to it.
  assertEquals(remoteOperandPath("~"), "");
  assertEquals(remoteOperandPath("~/"), "");
  assertEquals(remoteOperandPath("~/x/y"), "x/y");
  assertEquals(remoteOperandPath("/abs"), "/abs");
  assertEquals(escapeRemoteGlob("a*b?c[d]\\e"), "a\\*b\\?c\\[d\\]\\\\e");
  // A relative local path could be read as host:path by scp.
  assertThrows(
    () =>
      scpArgv({ alias: "a" }, conn, {
        kind: "upload",
        localPaths: ["evil:x"],
        remoteDir: "~",
      }),
    Error,
    "absolute",
  );
  assertThrows(
    () =>
      scpArgv({ alias: "a" }, conn, {
        kind: "download",
        remotePath: "/x",
        localPath: "rel",
      }),
    Error,
    "absolute",
  );
});

Deno.test("sftp argv and batch", () => {
  assertEquals(sftpArgv({ alias: "web" }, conn), [
    ...BATCH,
    "-b",
    "-",
    "--",
    "web",
  ]);
  assertEquals(sftpArgv({ host: "fe80::1", user: "u", port: 22 }, conn), [
    ...BATCH,
    "-P",
    "22",
    "-b",
    "-",
    "--",
    "u@[fe80::1]",
  ]);
  assertEquals(sftpListBatch("~"), "pwd\nls -la\nbye\n");
  assertEquals(sftpListBatch("~/My Docs"), `cd "My Docs"\npwd\nls -la\nbye\n`);
  assertEquals(
    sftpListBatch('/a"b\\c'),
    `cd "/a\\"b\\\\c"\npwd\nls -la\nbye\n`,
  );
  assertEquals(sftpQuote("x"), `"x"`);
});

Deno.test("scp progress: meter lines, split chunks, units, done and stalled", () => {
  const out = parseScpProgress(
    "\rfile.txt                                 0%    0     0.0KB/s   --:-- ETA" +
      "\rfile.txt                                42%   12MB  10.0MB/s   00:12 ETA" +
      "\rfile.txt                               100%   28MB  10.0MB/s   00:02    \n" +
      "\rmy photo.jpg                             7% 1024KB 512.0KB/s 01:02:03 ETA",
  );
  assertEquals(out, [
    { file: "file.txt", percent: 0 },
    { file: "file.txt", percent: 42 },
    { file: "file.txt", percent: 100 },
    { file: "my photo.jpg", percent: 7 },
  ]);
  assertEquals(parseScpProgress("file   50%   12MB  10.0MB/s - stalled -"), []);
  assertEquals(parseScpProgress("scp: /x: No such file or directory\n"), []);
  assertEquals(parseScpProgress("a.bin 100% 4096 4.0MB/s 00:00"), [{
    file: "a.bin",
    percent: 100,
  }]);
});

Deno.test("lastErrorLine: skips meter and echo lines, strips control sequences", () => {
  const text =
    '\x1b[?2004hsftp> cd "nope"\r\nCouldn\'t canonicalize: No such file or directory\r\n' +
    "file 50% 1MB 1.0MB/s 00:01 ETA\r\n\r\n";
  assertEquals(
    lastErrorLine(text),
    "Couldn't canonicalize: No such file or directory",
  );
  assertEquals(lastErrorLine(""), "");
});

Deno.test("sftp listing: pwd, kinds, sizes, names with spaces, links, dot entries", () => {
  const text = [
    'cd "src"',
    'sftp> cd "src"',
    "sftp> pwd",
    "Remote working directory: /home/qutty/src",
    "sftp> ls -la",
    "drwxr-xr-x    2 qutty    qutty        4096 Nov  4 10:00 .",
    "drwxr-xr-x    5 qutty    qutty        4096 Nov  4 09:00 ..",
    "-rw-r--r--    ? qutty    qutty          12 Nov  4 10:00 hello world.txt",
    "-rwxr-xr-x    1 1000     1000      5242880 Jan  1  2024 build.sh",
    "drwx------    3 qutty    wheel        4096 Nov  4 10:00 My Dir",
    "lrwxrwxrwx    1 qutty    qutty           5 Nov  4 10:00 link -> hello world.txt",
    "srwxrwxrwx    1 qutty    qutty           0 Nov  4 10:00 sock",
    "sftp> bye",
  ].join("\r\n");
  assertEquals(parseSftpListing(text), {
    path: "/home/qutty/src",
    entries: [
      { name: "hello world.txt", kind: "file", size: 12 },
      { name: "build.sh", kind: "file", size: 5242880 },
      { name: "My Dir", kind: "dir", size: 4096 },
      { name: "link", kind: "link", size: 5, target: "hello world.txt" },
      { name: "sock", kind: "other", size: 0 },
    ],
  });
  assertEquals(
    parseSftpListing('sftp> cd "x"\nCouldn\'t canonicalize: No such file\n'),
    undefined,
  );
});

Deno.test("download naming", () => {
  assertEquals(remoteBaseName("/var/log/app.log"), "app.log");
  assertEquals(remoteBaseName("dir/sub/"), "sub");
  assertEquals(remoteBaseName("/"), "download");
  assertEquals(remoteBaseName("~"), "download");
  const taken = new Set(["a.txt", "a (1).txt", "b", ".hidden", "arch.tar.gz"]);
  const exists = (n: string) => taken.has(n);
  assertEquals(uniqueName("new.txt", exists), "new.txt");
  assertEquals(uniqueName("a.txt", exists), "a (2).txt");
  assertEquals(uniqueName("b", exists), "b (1)");
  assertEquals(uniqueName(".hidden", exists), ".hidden (1)");
  assertEquals(uniqueName("arch.tar.gz", exists), "arch.tar (1).gz");
});

Deno.test("recents: most recent first, one per label, capped at 20", () => {
  let r = pushRecent([], { alias: "a" }, 1);
  r = pushRecent(r, { host: "h", user: "u" }, 2);
  r = pushRecent(r, { alias: "a" }, 3);
  assertEquals(r.map((x) => [x.label, x.at]), [["a", 3], ["u@h", 2]]);
  for (let i = 0; i < 30; i++) r = pushRecent(r, { alias: `h${i}` }, 10 + i);
  assertEquals(r.length, 20);
  assertEquals(r[0].label, "h29");
});
