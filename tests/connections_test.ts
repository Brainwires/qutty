import { assert, assertEquals } from "@std/assert";
import {
  connectionGroups,
  EMPTY_FORM,
  flattenGroups,
  formForDuplicate,
  formFromHost,
  formFromQuickTarget,
  hostDetail,
  hostInputFromForm,
  hostMatches,
  keepSelection,
  moveSelection,
  quickConnectTarget,
} from "../lib/connections.ts";
import type { SshHost } from "../lib/ssh-config.ts";
import type { SshRecent } from "../lib/ssh-command.ts";

const host = (p: Partial<SshHost> & { alias: string }): SshHost => ({
  aliases: [p.alias],
  directives: [],
  source: p.editable ? "/h/.ssh/qutty.conf" : "/h/.ssh/config",
  editable: false,
  ...p,
});

const HOSTS: SshHost[] = [
  host({ alias: "web-1", hostName: "web-1.example.com", user: "deploy" }),
  host({
    alias: "db",
    aliases: ["db", "db-primary"],
    hostName: "10.0.0.5",
    user: "postgres",
    port: 2222,
  }),
  host({
    alias: "prod-api",
    hostName: "api.example.com",
    user: "ops",
    tags: ["prod"],
    favorite: true,
    editable: true,
  }),
  host({ alias: "lab", hostName: "lab.local", editable: true }),
];

const RECENTS: SshRecent[] = [
  { label: "db", target: { alias: "db" }, at: 10 },
  {
    label: "me@box:2200",
    target: { user: "me", host: "box", port: 2200 },
    at: 20,
  },
];

Deno.test("connections: groups in order, favorites pulled out of their file's group", () => {
  const groups = connectionGroups(HOSTS, RECENTS, "");
  assertEquals(groups.map((g) => [g.label, g.items.map((i) => i.label)]), [
    ["Favorites", ["prod-api"]],
    ["Qutty hosts", ["lab"]],
    ["~/.ssh/config", ["web-1", "db"]],
    ["Recent", ["me@box:2200", "db"]],
  ]);
  const keys = flattenGroups(groups).map((i) => i.key);
  assertEquals(new Set(keys).size, keys.length, "keys are unique");
  // A recent of a known alias carries the host (detail, read-only state).
  const recentDb = groups[3].items[1];
  assertEquals(recentDb.host?.alias, "db");
  assertEquals(recentDb.detail, "postgres@10.0.0.5:2222");
  assertEquals(groups[3].items[0].detail, "me@box:2200");
});

Deno.test("connections: the filter matches alias, other aliases, HostName, User and tags", () => {
  const labels = (q: string) =>
    flattenGroups(connectionGroups(HOSTS, [], q)).map((i) => i.label);
  assertEquals(labels("prod"), ["prod-api"]); // alias and tag
  assertEquals(labels("PRIMARY"), ["db"]); // another alias, any case
  assertEquals(labels("example.com"), ["prod-api", "web-1"]);
  assertEquals(labels("postgres"), ["db"]);
  assertEquals(labels("ops example"), ["prod-api"]); // every word must match
  assertEquals(labels("nothing-here"), []);
  assert(hostMatches(HOSTS[0], "  "));
  // Recents filter by their label too.
  assertEquals(
    flattenGroups(connectionGroups([], RECENTS, "box")).map((i) => i.label),
    ["me@box:2200"],
  );
});

Deno.test("connections: ↑/↓ selection clamps and survives a list change", () => {
  const items = flattenGroups(connectionGroups(HOSTS, [], ""));
  const first = items[0].key;
  assertEquals(moveSelection(items, null, 1), first);
  assertEquals(moveSelection(items, first, -1), first);
  assertEquals(moveSelection(items, first, 1), items[1].key);
  const last = items.at(-1)!.key;
  assertEquals(moveSelection(items, last, 1), last);
  assertEquals(moveSelection([], null, 1), null);
  assertEquals(keepSelection(items, items[2].key), items[2].key);
  assertEquals(keepSelection(items, "gone"), first);
  assertEquals(keepSelection([], "gone"), null);
});

Deno.test("connections: quick connect is offered only when nothing matches", () => {
  const none = connectionGroups(HOSTS, RECENTS, "root@1.2.3.4:2022");
  assertEquals(quickConnectTarget("root@1.2.3.4:2022", none), {
    user: "root",
    host: "1.2.3.4",
    port: 2022,
  });
  const some = connectionGroups(HOSTS, RECENTS, "web");
  assertEquals(quickConnectTarget("web", some), undefined);
  assertEquals(quickConnectTarget("-oProxy", []), undefined);
  assertEquals(quickConnectTarget("", []), undefined);
});

Deno.test("connections: hostDetail", () => {
  assertEquals(hostDetail(HOSTS[1]), "postgres@10.0.0.5:2222");
  assertEquals(hostDetail(host({ alias: "bare" })), "bare");
});

Deno.test("connections: form round trip, rename and validation", () => {
  const form = formFromHost(HOSTS[2]);
  assertEquals(form.tags, "prod");
  assertEquals(form.favorite, true);
  const same = hostInputFromForm(form, "prod-api");
  assertEquals(same.input, {
    alias: "prod-api",
    hostName: "api.example.com",
    user: "ops",
    tags: ["prod"],
    favorite: true,
  });
  const renamed = hostInputFromForm(
    { ...form, alias: "api", tint: "red", tags: "prod, eu-west", tmux: true },
    "prod-api",
  );
  assertEquals(renamed.input?.previousAlias, "prod-api");
  assertEquals(renamed.input?.tags, ["prod", "eu-west"]);
  assertEquals(renamed.input?.tint, "red");
  assertEquals(renamed.input?.tmux, true);
  const bad = hostInputFromForm({
    ...EMPTY_FORM,
    alias: "-oops",
    hostName: "a b",
    user: "x y",
    port: "70000",
    proxyJump: "bad jump",
    identityFile: 'has"quote',
    tags: "ok, no/slash",
    tint: "pink",
  });
  assertEquals(Object.keys(bad.errors ?? {}).sort(), [
    "alias",
    "hostName",
    "identityFile",
    "port",
    "proxyJump",
    "tags",
    "tint",
    "user",
  ]);
  const minimal = hostInputFromForm({
    ...EMPTY_FORM,
    alias: "box",
    port: "22",
  });
  assertEquals(minimal.input, { alias: "box", port: 22 });
});

Deno.test("connections: duplicate a config host under a free alias; save a quick target", () => {
  const dup = formForDuplicate(HOSTS[0], HOSTS);
  assertEquals(dup.alias, "web-1-copy");
  assertEquals(dup.hostName, "web-1.example.com");
  const taken = [...HOSTS, host({ alias: "web-1-copy", editable: true })];
  assertEquals(formForDuplicate(HOSTS[0], taken).alias, "web-1-copy2");
  const quick = formFromQuickTarget({ user: "root", host: "::1", port: 2222 });
  assertEquals(quick.alias, "1");
  assertEquals(quick.hostName, "::1");
  assertEquals(quick.port, "2222");
  assertEquals(formFromQuickTarget({ host: "box.lan" }).alias, "box.lan");
});
