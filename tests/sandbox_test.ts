// The shared Docker sandbox's pure parts: settings sanitizing and the new-tile default
// (lib/sandbox/settings.ts), the docker command lines (lib/sandbox/docker.ts), and the lifecycle
// state machine against a fake docker (lib/sandbox/lifecycle.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  DEFAULT_SANDBOX,
  isImageRef,
  isProjectPath,
  opensInSandbox,
  type SandboxSettings,
  sanitizeSandbox,
} from "../lib/sandbox/settings.ts";
import {
  containerName,
  DETACH_KEYS,
  execArgs,
  execUser,
  HUB_NETWORK,
  inspectArgs,
  keepaliveArgs,
  parseGateways,
  parseInspect,
  runArgs,
  sandboxCommand,
  sandboxHome,
  sandboxSpec,
  sandboxWorkdir,
  specHash,
  userSetupArgs,
} from "../lib/sandbox/docker.ts";
import { SandboxController } from "../lib/sandbox/lifecycle.ts";
import { DemoDocker } from "../lib/sandbox/demo.ts";
import {
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";
import { createDemoBackend } from "../lib/pty-client.ts";

// --- settings --------------------------------------------------------------------------------

Deno.test("sandbox settings: defaults, field checks, junk ignored", () => {
  assertEquals(sanitizeSandbox(undefined), DEFAULT_SANDBOX);
  assertEquals(DEFAULT_SANDBOX.mode, "off");
  const s = sanitizeSandbox({
    mode: "shared",
    image: "  ghcr.io/acme/dev:1.2@sha256:abc ",
    project: "/Users/me/src/app/",
    projectWritable: false,
    network: false,
    keepRunning: true,
    newTilesInSandbox: false,
    hostAgentConfigs: true,
  });
  assertEquals(s, {
    mode: "shared",
    image: "ghcr.io/acme/dev:1.2@sha256:abc",
    project: "/Users/me/src/app",
    projectWritable: false,
    network: false,
    keepRunning: true,
    newTilesInSandbox: false,
    hostAgentConfigs: true,
  });
  // Bad values keep the base's.
  const bad = sanitizeSandbox(
    { mode: "vm", image: "bad image", project: "rel/path", network: "yes" },
    s,
  );
  assertEquals(bad, s);
  assertEquals(sanitizeSandbox({ project: "" }, s).project, "");
});

Deno.test("sandbox settings: image refs and project paths", () => {
  for (const ok of ["node:22-bookworm", "ubuntu", "a/b/c:tag", "x@sha256:00"]) {
    assert(isImageRef(ok), ok);
  }
  for (const bad of ["", "-rm", "a b", "a//b", "x;rm", 3]) {
    assert(!isImageRef(bad), String(bad));
  }
  for (const ok of ["/Users/me/app", "/srv/x y"]) assert(isProjectPath(ok), ok);
  for (const bad of ["/", "rel", "/a,b", '/a"b', "/a/../b", "/a\nb"]) {
    assert(!isProjectPath(bad), bad);
  }
});

Deno.test("sandbox settings: where a new tile opens", () => {
  const on: SandboxSettings = { ...DEFAULT_SANDBOX, mode: "shared" };
  assertEquals(opensInSandbox(DEFAULT_SANDBOX), false);
  assertEquals(opensInSandbox(DEFAULT_SANDBOX, true), false); // off wins
  assertEquals(opensInSandbox(on), true);
  assertEquals(opensInSandbox(on, false), false); // "Run on host"
  assertEquals(opensInSandbox({ ...on, newTilesInSandbox: false }), false);
  assertEquals(opensInSandbox({ ...on, newTilesInSandbox: false }, true), true);
});

// --- command lines ---------------------------------------------------------------------------

const FACTS = {
  name: "qutty-sandbox-main",
  quttyDir: "/Users/me/.qutty",
  hostConfigs: ["/Users/me/.claude", "/Users/me/.codex"],
  linux: false,
};

Deno.test("docker argv: container name per window", () => {
  assertEquals(containerName("main"), "qutty-sandbox-main");
  assertEquals(containerName("window 2/x"), "qutty-sandbox-window-2-x");
  assertEquals(containerName(""), "qutty-sandbox-main");
});

Deno.test("docker argv: run with project, volume, shims, labels; network and Linux variants", () => {
  const settings: SandboxSettings = {
    ...DEFAULT_SANDBOX,
    mode: "shared",
    image: "node:22-bookworm",
    project: "/Users/me/app",
    projectWritable: false,
  };
  const spec = sandboxSpec(settings, FACTS);
  const args = runArgs(spec);
  assertEquals(args.slice(0, 4), ["run", "-d", "--init", "--name"]);
  const joined = args.join(" ");
  for (
    const part of [
      "--label org.qutty.sandbox=1",
      `--label org.qutty.config=${specHash(spec)}`,
      "--user 0:0",
      "-e HOME=/root",
      "-e IS_SANDBOX=1",
      "type=volume,source=qutty-sandbox-home,target=/root",
      "type=bind,source=/Users/me/.qutty,target=/Users/me/.qutty,readonly",
      "type=bind,source=/Users/me/app,target=/Users/me/app,readonly",
      "-w /Users/me/app node:22-bookworm sh -c",
    ]
  ) assert(joined.includes(part), part);
  assertEquals(args.at(-1), "/Users/me/.qutty/bin");
  // Host configs only when opted in; no network flags by default; not on macOS.
  assert(!joined.includes("/mnt/host"));
  assert(!joined.includes("--network"));
  assert(!joined.includes("host-gateway"));
  const opted = runArgs(
    sandboxSpec(
      {
        ...settings,
        hostAgentConfigs: true,
        network: false,
        projectWritable: true,
      },
      { ...FACTS, linux: true },
    ),
  ).join(" ");
  assert(
    opted.includes(
      "source=/Users/me/.claude,target=/mnt/host/.claude,readonly",
    ),
  );
  assert(
    opted.includes("source=/Users/me/.codex,target=/mnt/host/.codex,readonly"),
  );
  assert(opted.includes("source=/Users/me/app,target=/Users/me/app "));
  assert(opted.includes("--network none"));
  assert(!opted.includes("host-gateway"), "no host-gateway without a network");
  const linux = runArgs(sandboxSpec(settings, { ...FACTS, linux: true })).join(
    " ",
  );
  assert(linux.includes("--add-host host.docker.internal:host-gateway"));
  // No project: the home is the working folder.
  const bare = runArgs(sandboxSpec({ ...settings, project: "" }, FACTS));
  assertEquals(bare[bare.indexOf("-w") + 1], "/root");
});

Deno.test("docker argv: native Linux runs the tiles as the host user, with its own home", () => {
  const settings: SandboxSettings = { ...DEFAULT_SANDBOX, mode: "shared" };
  const user = { uid: 1000, gid: 1001 };
  const spec = sandboxSpec(settings, { ...FACTS, linux: true, user });
  assertEquals(spec.user, user);
  assertEquals(sandboxHome("1000:1001"), "/home/qutty");
  assertEquals(sandboxHome(undefined), "/root");
  assertEquals(execUser(spec), "1000:1001");
  const run = runArgs(spec);
  const joined = run.join(" ");
  // The main process stays root (it sets the user up, and the keepalive stops it).
  assert(joined.includes("--user 0:0"));
  assert(joined.includes("-e HOME=/home/qutty"));
  assert(
    joined.includes("type=volume,source=qutty-sandbox-home,target=/home/qutty"),
  );
  assertEquals(run[run.indexOf("-w") + 1], "/home/qutty");
  assert(joined.includes("--label org.qutty.user=1000:1001"));
  const setup = userSetupArgs(spec.name, "1000:1001");
  assertEquals(setup.slice(0, 6), ["exec", "-u", "0:0", spec.name, "sh", "-c"]);
  assert(setup[6].includes("/etc/passwd") && setup[6].includes("chown -R"));
  assertEquals(setup.slice(7), ["qutty-setup", "1000", "1001", "/home/qutty"]);
  // A tile: -u before the command; no -u for root.
  const exec = execArgs("ctr", {
    workdir: "/home/qutty",
    envNames: [],
    command: ["bash", "-l"],
    user: "1000:1001",
  });
  assertEquals(exec.slice(4, 8), ["-u", "1000:1001", "-w", "/home/qutty"]);
  assert(
    !execArgs("ctr", { workdir: "/", envNames: [], command: [] }).includes(
      "-u",
    ),
  );
  assertEquals(sandboxWorkdir("", undefined, "/home/qutty"), "/home/qutty");
  // macOS, and an app run as root: root, as before.
  for (
    const facts of [
      { ...FACTS, user: { uid: 501, gid: 20 } },
      { ...FACTS, linux: true, user: { uid: 0, gid: 0 } },
    ]
  ) {
    const s = sandboxSpec(settings, facts);
    assertEquals(s.user, undefined);
    assertEquals(execUser(s), undefined);
    assert(runArgs(s).join(" ").includes("-e HOME=/root"));
    assert(!runArgs(s).join(" ").includes("org.qutty.user"));
  }
  // The user is part of what the container is made of.
  assert(
    specHash(spec) !== specHash({ ...spec, user: { uid: 1002, gid: 1001 } }),
  );
});

Deno.test("docker argv: network off on native Linux joins the internal hub network", () => {
  const settings: SandboxSettings = {
    ...DEFAULT_SANDBOX,
    mode: "shared",
    network: false,
  };
  const linux = sandboxSpec(settings, { ...FACTS, linux: true });
  const off = runArgs(linux, { hubGateway: "172.18.0.1" }).join(" ");
  assert(off.includes(`--network ${HUB_NETWORK}`));
  assert(off.includes("--add-host host.docker.internal:172.18.0.1"));
  assert(!off.includes("host-gateway") && !off.includes("--network none"));
  // No gateway known: no network at all.
  assert(runArgs(linux).join(" ").includes("--network none"));
  // macOS ignores a gateway: none.
  const mac = runArgs(sandboxSpec(settings, FACTS), { hubGateway: "x" }).join(
    " ",
  );
  assert(mac.includes("--network none") && !mac.includes(HUB_NETWORK));
});

Deno.test("docker argv: the config hash follows what the container is made of", () => {
  const base = sandboxSpec({ ...DEFAULT_SANDBOX, mode: "shared" }, FACTS);
  assertEquals(specHash(base), specHash({ ...base }));
  assertEquals(specHash(base), specHash({ ...base, name: "other" }));
  for (
    const change of [
      { image: "ubuntu" },
      { project: "/x" },
      { network: false },
      { hostConfigs: ["/a"] },
      { linux: true },
    ]
  ) {
    assert(
      specHash(base) !== specHash({ ...base, ...change }),
      JSON.stringify(change),
    );
  }
  // keepRunning / newTilesInSandbox do not recreate the container.
  assertEquals(
    specHash(base),
    specHash(
      sandboxSpec(
        {
          ...DEFAULT_SANDBOX,
          mode: "shared",
          keepRunning: true,
          newTilesInSandbox: false,
        },
        FACTS,
      ),
    ),
  );
});

Deno.test("docker argv: exec passes the hub env by name, never its values", () => {
  const args = execArgs("ctr", {
    workdir: "/Users/me/app",
    envNames: ["QUTTY_HUB", "QUTTY_TILE_TOKEN", "QUTTY_TILE_ID", "TERM"],
    command: ["bash", "-l"],
  });
  assertEquals(args.slice(0, 6), [
    "exec",
    "-it",
    "--detach-keys",
    DETACH_KEYS,
    "-w",
    "/Users/me/app",
  ]);
  const envs = args.flatMap((a, i) => args[i - 1] === "-e" ? [a] : []);
  assertEquals(envs, [
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "QUTTY_HUB",
    "QUTTY_TILE_TOKEN",
    "QUTTY_TILE_ID",
    "LANG=C.UTF-8",
    "QUTTY_SANDBOX=1",
  ]);
  assertEquals(args.slice(-3), ["ctr", "bash", "-l"]);
});

Deno.test("docker argv: what a tile runs inside, and where it starts", () => {
  assertEquals(sandboxCommand({}).slice(0, 2), ["sh", "-c"]);
  assert(sandboxCommand({})[2].includes("exec bash -l"));
  assertEquals(sandboxCommand({ shell: "/opt/homebrew/bin/zsh" }), [
    "zsh",
    "-l",
  ]);
  assertEquals(
    sandboxCommand({
      agent: { name: "claude", args: ["--mcp-config", "/c.json"] },
    }),
    ["claude", "--mcp-config", "/c.json"],
  );
  assertEquals(sandboxWorkdir("", "/Users/me/app"), "/root");
  assertEquals(sandboxWorkdir("/Users/me/app", undefined), "/Users/me/app");
  assertEquals(
    sandboxWorkdir("/Users/me/app", "/Users/me/app/src"),
    "/Users/me/app/src",
  );
  assertEquals(
    sandboxWorkdir("/Users/me/app", "/Users/me/application"),
    "/Users/me/app",
  );
  assertEquals(sandboxWorkdir("/Users/me/app", "/etc"), "/Users/me/app");
});

Deno.test("docker argv: keepalive, inspect and bridge parsing", () => {
  assertEquals(keepaliveArgs("c").slice(0, 3), ["exec", "-i", "c"]);
  assert(keepaliveArgs("c").at(-1)!.includes("kill -TERM 1"));
  assertEquals(inspectArgs("c").at(-1), "c");
  assertEquals(parseInspect("noise\ntrue|abc|2026-11-06T10:00:00Z|node:22\n"), {
    running: true,
    config: "abc",
    startedAt: "2026-11-06T10:00:00Z",
    image: "node:22",
    user: "",
  });
  assertEquals(
    parseInspect("true|abc|2026-11-06T10:00:00Z|node:22|1000:1001")?.user,
    "1000:1001",
  );
  assertEquals(
    parseInspect("true|abc|2026-11-06T10:00:00Z|node:22|<no value>")?.user,
    "",
  );
  assertEquals(parseInspect("Error: No such container: c"), undefined);
  assertEquals(parseGateways("172.17.0.1 fd00::1 \n"), ["172.17.0.1"]);
});

// --- lifecycle, with a fake docker -----------------------------------------------------------

const FakeDocker = DemoDocker;
type FakeDocker = DemoDocker;

const SHARED: SandboxSettings = {
  ...DEFAULT_SANDBOX,
  mode: "shared",
  image: "img",
};

function controller(docker: FakeDocker, linux = false) {
  const changes: string[] = [];
  const ctl = new SandboxController({
    docker,
    name: "ctr",
    facts: { quttyDir: "/q", hostConfigs: [], linux },
    onChange: (s) => changes.push(s.phase),
  });
  return { ctl, changes };
}

Deno.test("lifecycle: off until configured; ensure refuses while off", async () => {
  const d = new FakeDocker();
  const { ctl } = controller(d);
  assertEquals(ctl.status().phase, "off");
  await assertRejects(() => ctl.ensure(), Error, "off");
  assertEquals(d.calls, []);
});

Deno.test("lifecycle: first ensure pulls, creates, starts the keepalive; callers share it", async () => {
  const d = new FakeDocker();
  const { ctl, changes } = controller(d);
  ctl.configure(SHARED);
  const [a, b] = await Promise.all([ctl.ensure(), ctl.ensure()]);
  assertEquals(a, b);
  assertEquals(a, {
    container: "ctr",
    project: "",
    bridge: [],
    home: "/root",
  });
  assertEquals(d.calls.filter((c) => c === "run -d").length, 1);
  assert(d.calls.includes("pull img"));
  assert(changes.includes("starting"));
  const s = ctl.status();
  assertEquals(s.phase, "running");
  assertEquals(s.startedAt, d.container?.startedAt);
  assertEquals(s.stale, false);
  assertEquals(s.docker, "29.9.2");
  assertEquals(d.keepalives.length, 1);
  assertEquals(d.keepalives[0].args.slice(0, 3), ["exec", "-i", "ctr"]);
  // Running already: nothing new is created.
  d.calls = [];
  await ctl.ensure();
  assertEquals(d.calls.includes("run -d"), false);
});

Deno.test("lifecycle: a stopped container is started again, a changed one recreated", async () => {
  const d = new FakeDocker();
  const { ctl } = controller(d);
  ctl.configure(SHARED);
  await ctl.ensure();
  await ctl.stop();
  assertEquals(ctl.status().phase, "stopped");
  d.calls = [];
  await ctl.ensure();
  assert(d.calls.includes("start ctr"));
  assert(!d.calls.includes("run -d"));
  await ctl.stop();
  ctl.configure({ ...SHARED, network: false });
  d.calls = [];
  await ctl.ensure();
  assert(d.calls.includes("rm -f"));
  assert(d.calls.includes("run -d"));
});

Deno.test("lifecycle: changed settings mark a running sandbox stale; restart recreates it", async () => {
  const d = new FakeDocker();
  const { ctl } = controller(d);
  ctl.configure(SHARED);
  await ctl.ensure();
  assertEquals(ctl.configure({ ...SHARED, image: "other" }).stale, true);
  assertEquals(ctl.status().phase, "running");
  d.calls = [];
  const after = await ctl.restart();
  assert(d.calls.includes("stop -t"));
  assert(d.calls.includes("rm -f"));
  assertEquals(after.phase, "running");
  assertEquals(after.stale, false);
  assertEquals(after.image, "other");
});

Deno.test("lifecycle: keep running releases the keepalive; turning it off starts one", async () => {
  const d = new FakeDocker();
  const { ctl } = controller(d);
  ctl.configure(SHARED);
  await ctl.ensure();
  ctl.configure({ ...SHARED, keepRunning: true });
  assertEquals(d.keepalives[0].released, true);
  assertEquals(
    ctl.status().stale,
    false,
    "keep running is not a container change",
  );
  ctl.configure(SHARED);
  assertEquals(d.keepalives.length, 2);
  // Kept from the start: no keepalive at all.
  const d2 = new FakeDocker();
  const { ctl: kept } = controller(d2);
  kept.configure({ ...SHARED, keepRunning: true });
  await kept.ensure();
  assertEquals(d2.keepalives.length, 0);
});

Deno.test("lifecycle: no docker, or a stopped daemon, is unavailable with a clear message", async () => {
  const d = new FakeDocker();
  d.installed = false;
  const { ctl } = controller(d);
  ctl.configure(SHARED);
  await assertRejects(() => ctl.ensure(), Error, "not installed");
  assertEquals(ctl.status().phase, "unavailable");
  d.installed = true;
  d.daemon = false;
  assertEquals(await ctl.check(), false);
  assert(ctl.status().message!.includes("not running"));
  d.daemon = true;
  assertEquals(await ctl.check(), true);
  assertEquals(ctl.status().phase, "stopped");
});

Deno.test("lifecycle: a failed create is an error with docker's reason; the next try runs again", async () => {
  const d = new FakeDocker();
  d.image = true;
  d.failRun = true;
  const { ctl } = controller(d);
  ctl.configure(SHARED);
  await assertRejects(() => ctl.ensure(), Error, "invalid mount config");
  assertEquals(ctl.status().phase, "error");
  d.failRun = false;
  await ctl.ensure();
  assertEquals(ctl.status().phase, "running");
});

Deno.test("lifecycle: reset removes the container and the volume", async () => {
  const d = new FakeDocker();
  const { ctl } = controller(d);
  ctl.configure(SHARED);
  await ctl.ensure();
  d.calls = [];
  const s = await ctl.resetVolume();
  assertEquals(d.calls, ["stop -t", "rm -f", "volume rm"]);
  assertEquals(s.phase, "stopped");
  assertEquals(d.container, undefined);
});

Deno.test("lifecycle: native Linux asks for the bridge gateway (only with a network)", async () => {
  const d = new FakeDocker();
  d.run =
    ((orig) => (args: string[]) =>
      args[0] === "network" && args[2] === "bridge"
        ? Promise.resolve({ code: 0, out: "172.17.0.1 " })
        : orig(args))(d.run.bind(d));
  const { ctl } = controller(d, true);
  ctl.configure(SHARED);
  assertEquals((await ctl.ensure()).bridge, ["172.17.0.1"]);
  // macOS: none.
  const mac = controller(new FakeDocker()).ctl;
  mac.configure({ ...SHARED, network: false });
  assertEquals((await mac.ensure()).bridge, []);
});

/** A fake docker that records every full argv and answers `network` commands itself. */
function linuxDocker(opts: { network?: boolean } = {}) {
  const d = new FakeDocker();
  const argv: string[][] = [];
  let hubNetwork = opts.network ?? false;
  d.run = ((orig) => (args: string[]) => {
    argv.push(args);
    if (args[0] === "network" && args[1] === "inspect") {
      return Promise.resolve(
        args[2] === HUB_NETWORK
          ? hubNetwork
            ? { code: 0, out: "172.18.0.1 " }
            : { code: 1, out: "Error: network qutty-sandbox-hub not found" }
          : { code: 0, out: "172.17.0.1 " },
      );
    }
    if (args[0] === "network" && args[1] === "create") hubNetwork = true;
    return orig(args);
  })(d.run.bind(d));
  return { d, argv };
}

Deno.test("lifecycle: native Linux with the network off keeps the hub on an internal network", async () => {
  const { d, argv } = linuxDocker();
  const { ctl } = controller(d, true);
  ctl.configure({ ...SHARED, network: false });
  const ready = await ctl.ensure();
  // The network was missing: created internal, then its gateway read.
  const create = argv.find((a) => a[0] === "network" && a[1] === "create");
  assertEquals(create, [
    "network",
    "create",
    "--internal",
    "--label",
    "org.qutty.sandbox=1",
    HUB_NETWORK,
  ]);
  const run = argv.find((a) => a[0] === "run")!.join(" ");
  assert(run.includes(`--network ${HUB_NETWORK}`), run);
  assert(run.includes("--add-host host.docker.internal:172.18.0.1"), run);
  assert(!run.includes("--network none"));
  // The hub listens on that gateway.
  assertEquals(ready.bridge, ["172.18.0.1"]);

  // Stopped and started again: the network is checked (not created twice), the container reused.
  await ctl.stop();
  argv.length = 0;
  await ctl.ensure();
  assertEquals(
    argv.filter((a) => a[0] === "network").map((a) => a[1]),
    ["inspect"],
  );
  assert(argv.some((a) => a[0] === "start"));
  assert(!argv.some((a) => a[0] === "run"));
});

Deno.test("lifecycle: a stopped container that cannot start is made anew", async () => {
  const { d } = linuxDocker({ network: true });
  const { ctl } = controller(d, true);
  ctl.configure({ ...SHARED, network: false });
  await ctl.ensure();
  await ctl.stop();
  const inner = d.run.bind(d);
  const calls: string[] = [];
  d.run = (args: string[]) => {
    calls.push(args[0]);
    return args[0] === "start"
      ? Promise.resolve({ code: 1, out: "network abc not found" })
      : inner(args);
  };
  await ctl.ensure();
  assertEquals(ctl.status().phase, "running");
  assert(calls.indexOf("rm") > calls.indexOf("start"), calls.join(" "));
  assert(calls.includes("run"));
  assert(d.container?.running);
});

Deno.test("lifecycle: on native Linux the tiles run as the host user, set up once per start", async () => {
  const { d, argv } = linuxDocker();
  const ctl = new SandboxController({
    docker: d,
    name: "ctr",
    facts: {
      quttyDir: "/q",
      hostConfigs: [],
      linux: true,
      user: { uid: 1000, gid: 1001 },
    },
  });
  ctl.configure(SHARED);
  const ready = await ctl.ensure();
  assertEquals(ready.user, "1000:1001");
  assertEquals(ready.home, "/home/qutty");
  const setups = () =>
    argv.filter((a) => a[0] === "exec" && a.includes("qutty-setup"));
  assertEquals(setups().length, 1);
  assertEquals(setups()[0].slice(0, 4), ["exec", "-u", "0:0", "ctr"]);
  assertEquals(setups()[0].slice(-3), ["1000", "1001", "/home/qutty"]);
  // Again while running: no second setup. After a restart: once more.
  await ctl.ensure();
  assertEquals(setups().length, 1);
  await ctl.stop();
  await new Promise((r) => setTimeout(r, 2)); // a new startedAt
  await ctl.ensure();
  assertEquals(setups().length, 2);
  // A failed setup fails the start with docker's reason.
  await ctl.stop();
  const inner = d.run.bind(d);
  d.run = (args: string[]) =>
    args.includes("qutty-setup")
      ? Promise.resolve({ code: 1, out: "chown: Operation not permitted" })
      : inner(args);
  await new Promise((r) => setTimeout(r, 2));
  await assertRejects(() => ctl.ensure(), Error, "Operation not permitted");
  assertEquals(ctl.status().phase, "error");

  // macOS (Docker Desktop maps ownership itself) and root keep root.
  for (
    const facts of [
      { linux: false, user: { uid: 501, gid: 20 } },
      { linux: true, user: { uid: 0, gid: 0 } },
    ]
  ) {
    const other = new FakeDocker();
    const c = new SandboxController({
      docker: other,
      name: "ctr",
      facts: { quttyDir: "/q", hostConfigs: [], ...facts },
    });
    c.configure(SHARED);
    const r = await c.ensure();
    assertEquals(r.user, undefined);
    assertEquals(r.home, "/root");
    assert(!other.calls.some((x) => x.startsWith("exec")));
  }
});

// --- the workspace store and the demo backend ------------------------------------------------

Deno.test("store: setSandbox sanitizes, persists, and is a no-op when unchanged", () => {
  let s = initialState();
  assertEquals(s.settings.sandbox, DEFAULT_SANDBOX);
  s = reduce(s, {
    type: "setSandbox",
    patch: { mode: "shared", image: "bad image" },
  });
  assertEquals(s.settings.sandbox.mode, "shared");
  assertEquals(s.settings.sandbox.image, DEFAULT_SANDBOX.image);
  assertEquals(reduce(s, { type: "setSandbox", patch: { mode: "shared" } }), s);
  assertEquals(
    sanitizeSettings(JSON.parse(JSON.stringify(s.settings))).sandbox,
    s.settings.sandbox,
  );
  s = reduce(s, { type: "add", id: "t1", now: 1, sandbox: true });
  s = reduce(s, { type: "add", id: "t2", now: 2 });
  assertEquals(s.terminals.map((t) => t.sandbox), [true, undefined]);
});

Deno.test("demo backend: the sandbox starts on ensure; a sandboxed spawn is marked in the hub", async () => {
  const backend = createDemoBackend();
  const settings: SandboxSettings = { ...DEFAULT_SANDBOX, mode: "shared" };
  assertEquals((await backend.sandboxConfigure(settings)).phase, "stopped");
  const running = await backend.sandboxEnsure(settings);
  assertEquals(running.phase, "running");
  assert(running.startedAt);
  const t = await backend.spawn({ cols: 80, rows: 24, sandbox: true });
  const snap = await backend.hubSnapshot();
  assertEquals(snap.tiles.find((x) => x.id === t.id)?.sandbox, true);
  assertEquals((await backend.sandboxAction("stop")).phase, "stopped");
  await backend.kill(t.id);
});

Deno.test("lifecycle: a running container keeps the user it was made with until Restart", async () => {
  // Made as root (an older Qutty): stale now that the tiles would run as the user.
  const d = new FakeDocker();
  d.container = { running: true, config: "old", startedAt: "t0" };
  const ctl = new SandboxController({
    docker: d,
    name: "ctr",
    facts: {
      quttyDir: "/q",
      hostConfigs: [],
      linux: true,
      user: { uid: 1000, gid: 1000 },
    },
  });
  ctl.configure(SHARED);
  const ready = await ctl.ensure();
  assertEquals([ready.user, ready.home], [undefined, "/root"]);
  assertEquals(ctl.status().stale, true);
  assert(!d.calls.includes("exec -u"));
  // Restart makes it anew, as the user.
  await ctl.restart();
  assertEquals(d.container?.user, "1000:1000");
  assert(d.calls.includes("exec -u"));
});
