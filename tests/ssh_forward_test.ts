// Port forwards: the strict spec parser, field validation (no option injection), the `ssh -O`
// argv, favourites in the `# qutty:` metadata (round trip, and kept across a host-form save) and
// the forwards a host's config starts with. Pure: nothing is spawned. Run: deno test -A tests/

import { assertEquals, assertThrows } from "@std/assert";
import {
  addForward,
  configuredForwards,
  favoritesOf,
  forwardArgs,
  forwardKey,
  forwardProblem,
  forwardSpec,
  forwardText,
  parseFavorite,
  parseForward,
  removeForward,
  type SshForward,
} from "../lib/ssh-forward.ts";
import { controlArgv, masterRunning } from "../lib/ssh-command.ts";
import {
  hostsOf,
  parseSshConfig,
  setHostForwards,
  upsertHost,
} from "../lib/ssh-config.ts";

const L: SshForward = {
  kind: "local",
  port: 8080,
  host: "localhost",
  hostPort: 80,
};

Deno.test("forward: parses ssh's -L / -R / -D syntax", () => {
  assertEquals(parseForward("local", "8080:localhost:80").forward, L);
  assertEquals(
    parseForward("local", " 127.0.0.1:8080:db.internal:5432 ").forward,
    {
      kind: "local",
      bind: "127.0.0.1",
      port: 8080,
      host: "db.internal",
      hostPort: 5432,
    },
  );
  assertEquals(parseForward("remote", "9000:localhost:3000").forward, {
    kind: "remote",
    port: 9000,
    host: "localhost",
    hostPort: 3000,
  });
  assertEquals(parseForward("dynamic", "1080").forward, {
    kind: "dynamic",
    port: 1080,
  });
  assertEquals(parseForward("dynamic", "localhost:1080").forward, {
    kind: "dynamic",
    bind: "localhost",
    port: 1080,
  });
  // IPv6 in brackets, on both sides.
  assertEquals(parseForward("local", "[::1]:8080:[fe80::1%en0]:80").forward, {
    kind: "local",
    bind: "::1",
    port: 8080,
    host: "fe80::1%en0",
    hostPort: 80,
  });
});

Deno.test("forward: refuses anything that is not a plain TCP forward", () => {
  const bad: [Parameters<typeof parseForward>[0], string][] = [
    ["local", ""],
    ["local", "8080"],
    ["local", "8080:localhost"],
    ["local", "a:b:c:d:e"],
    ["local", "0:localhost:80"],
    ["local", "65536:localhost:80"],
    ["local", "8080:localhost:0"],
    ["local", "08080x:localhost:80"],
    ["local", "8080:localhost:80 -oProxyCommand=x"],
    ["local", "-oProxyCommand=x:8080:localhost:80"],
    ["local", "8080:-oProxyCommand=x:80"],
    ["local", "8080:local;host:80"],
    ["local", "8080:$(id):80"],
    ["local", "8080::80"],
    ["local", "8080:[::1:80"],
    ["local", "8080:[::1]x:80"],
    ["local", "/tmp/sock:localhost:80"],
    ["local", "8080:/var/run/docker.sock"],
    ["remote", "0:localhost:80"],
    ["dynamic", "1080:localhost:80"],
    ["dynamic", "-D"],
    ["dynamic", "*:1080"],
    ["local", "8".repeat(400)],
  ];
  for (const [kind, text] of bad) {
    const r = parseForward(kind, text);
    assertEquals(r.forward, undefined, `${kind} ${text}`);
    assertEquals(typeof r.error, "string");
  }
});

Deno.test("forward: field validation of what the page sends", () => {
  assertEquals(forwardProblem(L), undefined);
  assertEquals(forwardProblem({ kind: "dynamic", port: 1080 }), undefined);
  for (
    const f of [
      null,
      [],
      "8080:localhost:80",
      { ...L, kind: "x" },
      { ...L, port: 0 },
      { ...L, port: 8080.5 },
      { ...L, hostPort: "80" },
      { ...L, host: "-x" },
      { ...L, host: "" },
      { ...L, bind: "-g" },
      { ...L, bind: 1 },
      { kind: "dynamic", port: 1080, host: "x" },
      { kind: "remote", port: 1 },
    ]
  ) assertEquals(typeof forwardProblem(f), "string", JSON.stringify(f));
});

Deno.test("forward: spec, text, key, args", () => {
  assertEquals(forwardSpec(L), "8080:localhost:80");
  assertEquals(
    forwardSpec({
      kind: "local",
      bind: "::1",
      port: 1,
      host: "::2",
      hostPort: 2,
    }),
    "[::1]:1:[::2]:2",
  );
  assertEquals(forwardArgs(L), ["-L", "8080:localhost:80"]);
  assertEquals(forwardArgs({ kind: "dynamic", port: 1080 }), ["-D", "1080"]);
  assertEquals(
    forwardArgs({ kind: "remote", port: 9000, host: "h", hostPort: 3000 }),
    ["-R", "9000:h:3000"],
  );
  assertThrows(() => forwardArgs({ ...L, host: "-oProxyCommand=x" }));
  assertEquals(forwardText(L), "local 8080 → localhost:80");
  assertEquals(forwardText({ kind: "dynamic", port: 1080 }), "SOCKS on 1080");
  assertEquals(forwardKey(L), "L 8080:localhost:80");
  assertEquals(addForward([L], { ...L }), [L]);
  assertEquals(removeForward([L, { kind: "dynamic", port: 1 }], L), [{
    kind: "dynamic",
    port: 1,
  }]);
});

Deno.test("forward: ssh -O argv on the tile's control socket", () => {
  const opts = { controlPath: "/h/.ssh/qutty-%C" };
  const shared = [
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=/h/.ssh/qutty-%C",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
  ];
  assertEquals(controlArgv({ alias: "web" }, opts, { op: "check" }), [
    ...shared,
    "-O",
    "check",
    "--",
    "web",
  ]);
  assertEquals(
    controlArgv({ host: "h.example.com", user: "me", port: 2222 }, {
      ...opts,
      configFile: "/t/config",
    }, { op: "forward", forward: L }),
    [
      ...shared,
      "-F",
      "/t/config",
      "-p",
      "2222",
      "-O",
      "forward",
      "-L",
      "8080:localhost:80",
      "--",
      "me@h.example.com",
    ],
  );
  assertEquals(
    controlArgv({ alias: "web" }, opts, {
      op: "cancel",
      forward: { kind: "dynamic", port: 1080 },
    }).slice(-6),
    ["-O", "cancel", "-D", "1080", "--", "web"],
  );
  // A bad target or forward never reaches an argv.
  assertThrows(() => controlArgv({ alias: "-oX" }, opts, { op: "check" }));
  assertThrows(() =>
    controlArgv({ alias: "web" }, opts, {
      op: "forward",
      forward: { ...L, host: "-oProxyCommand=sh" },
    })
  );
  assertEquals(masterRunning(0, "Master running (pid=42)\r\n"), true);
  assertEquals(
    masterRunning(255, "Control socket connect(x): No such file"),
    false,
  );
  assertEquals(masterRunning(0, ""), false);
});

Deno.test("forward: favourites round-trip through the # qutty: metadata", () => {
  const conf = [
    "# Qutty hosts",
    "",
    "Host prod-api",
    "  HostName api.example.com",
    '  # qutty: {"tint":"red","favorite":true}',
    "  LocalForward 5432 localhost:5432",
    "",
    "Host other",
    "  User x",
    "",
  ].join("\n");
  const keys = ["L 8080:localhost:80", "D 1080"];
  const next = setHostForwards(conf, "prod-api", keys);
  // Only the metadata line changed, and no LocalForward directive was written.
  assertEquals(next.split("\n").filter((l, i) => l !== conf.split("\n")[i]), [
    '  # qutty: {"tint":"red","favorite":true,"forwards":["L 8080:localhost:80","D 1080"]}',
  ]);
  const [host] = hostsOf(parseSshConfig(next), "/q", true);
  assertEquals(host.forwards, keys);
  assertEquals(host.tint, "red");
  assertEquals(favoritesOf(host.forwards), [L, {
    kind: "dynamic",
    port: 1080,
  }]);
  assertEquals(configuredForwards(host.directives), [{
    kind: "local",
    port: 5432,
    host: "localhost",
    hostPort: 5432,
  }]);
  // A host with no metadata gets a line after its Host line; clearing removes the field only.
  const other = setHostForwards(next, "other", ["R 9000:localhost:3000"]);
  assertEquals(
    other.split("\n")[8],
    '  # qutty: {"forwards":["R 9000:localhost:3000"]}',
  );
  assertEquals(setHostForwards(other, "other", []), next);
  assertEquals(
    setHostForwards(next, "prod-api", []),
    conf,
    "back to the original metadata",
  );
  assertEquals(setHostForwards(conf, "missing", keys), conf);
});

Deno.test("forward: a host-form save keeps the favourites", () => {
  const conf = setHostForwards(
    "Host prod-api\n  HostName a\n",
    "prod-api",
    ["L 8080:localhost:80"],
  );
  const saved = upsertHost(conf, {
    alias: "prod-api",
    hostName: "b",
    tmux: true,
  });
  const [host] = hostsOf(parseSshConfig(saved), "/q", true);
  assertEquals(host.hostName, "b");
  assertEquals(host.tmux, true);
  assertEquals(host.forwards, ["L 8080:localhost:80"]);
  // Renaming keeps them too.
  const renamed = upsertHost(saved, {
    alias: "api",
    previousAlias: "prod-api",
  });
  assertEquals(hostsOf(parseSshConfig(renamed), "/q", true)[0].forwards, [
    "L 8080:localhost:80",
  ]);
});

Deno.test("forward: hand-edited metadata is filtered, never trusted", () => {
  const conf =
    'Host h\n  # qutty: {"forwards":["L 8080:localhost:80","L 1 -oProxyCommand=x","X 1",5,"L 8080:localhost:80","D 0"]}\n';
  const [host] = hostsOf(parseSshConfig(conf), "/q", true);
  // The shape filter keeps safe-looking strings; parsing keeps real forwards only.
  assertEquals(host.forwards, ["L 8080:localhost:80", "D 0"]);
  assertEquals(favoritesOf(host.forwards), [L]);
  assertEquals(parseFavorite("L 8080:localhost:80 x"), undefined);
  assertEquals(parseFavorite("D 1080"), { kind: "dynamic", port: 1080 });
  assertEquals(
    configuredForwards([
      { key: "localforward", value: "/tmp/s localhost:1" },
      { key: "DynamicForward", value: "1080" },
      { key: "RemoteForward", value: '"9000" localhost:3000' },
      { key: "ForwardAgent", value: "yes" },
    ]),
    [
      { kind: "dynamic", port: 1080 },
      { kind: "remote", port: 9000, host: "localhost", hostPort: 3000 },
    ],
  );
});
