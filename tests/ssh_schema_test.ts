// The ssh extension's input schemas (what the desktop bridge runs before a handler) and its
// declared shape. Nothing is spawned and no file is touched. Run: deno test -A tests/

import { assertEquals } from "@std/assert";
import ext from "../desktop/ssh.ts";
import { assertExtensionShape, schemaTesters } from "./schema_helpers.ts";

const { ok, bad, rejectsNonObjects } = schemaTesters(ext);

const ALIAS = { target: { alias: "web" } };
const QUICK = { target: { host: "h.example.com", user: "me", port: 22 } };

Deno.test("ssh schema: declared events and methods", () => {
  assertExtensionShape(ext, {
    name: "ssh",
    events: ["transfer"],
    methods: [
      "sshCancel",
      "sshCommand",
      "sshDeleteHost",
      "sshDownload",
      "sshHosts",
      "sshList",
      "sshSaveHost",
      "sshUpload",
    ],
  });
});

Deno.test("ssh schema: every method rejects non-objects", rejectsNonObjects);

Deno.test("ssh schema: targets", () => {
  for (const name of ["sshCommand", "sshList"] as const) {
    assertEquals(
      ok(name, ALIAS),
      name === "sshList" ? { ...ALIAS, path: undefined } : ALIAS,
    );
    assertEquals((ok(name, QUICK) as { target: unknown }).target, QUICK.target);
    assertEquals(
      (ok(name, { target: { host: "::1" } }) as { target: unknown }).target,
      {
        host: "::1",
        user: undefined,
        port: undefined,
      },
    );
    bad(name, {}, ["target"]);
    bad(name, { target: "web" }, ["target"]);
    bad(name, { target: {} }, ["target"]);
    bad(name, { target: { host: "" } }, ["host"]);
    // Option injection: a destination or user that ssh would read as a flag.
    bad(name, { target: { alias: "-oProxyCommand=x" } }, ["alias"]);
    bad(name, { target: { host: "-h" } }, ["host"]);
    bad(name, { target: { host: "h", user: "-l" } }, ["user"]);
    bad(name, { target: { host: "h;id" } }, ["host"]);
    bad(name, { target: { host: "h", port: 0 } }, ["port"]);
    bad(name, { target: { host: "h", port: 65536 } }, ["port"]);
    bad(name, { target: { host: "h", port: "22" } }, ["port"]);
    bad(name, { target: { alias: "a\0b" } }, ["alias"]);
  }
});

Deno.test("ssh schema: sshSaveHost", () => {
  assertEquals(
    ok("sshSaveHost", {
      alias: "prod-api",
      hostName: "api.example.com",
      user: "ops",
      port: 2222,
      identityFile: "~/My Keys/id",
      proxyJump: "me@bastion:22,other",
      tint: "red",
      tags: ["prod", "eu-1"],
      favorite: true,
      tmux: true,
      remoteCommand: "htop -d 5",
      previousAlias: "api",
      extra: "dropped",
    }),
    {
      alias: "prod-api",
      previousAlias: "api",
      hostName: "api.example.com",
      user: "ops",
      port: 2222,
      identityFile: "~/My Keys/id",
      proxyJump: "me@bastion:22,other",
      tint: "red",
      tags: ["prod", "eu-1"],
      favorite: true,
      tmux: true,
      remoteCommand: "htop -d 5",
    },
  );
  ok("sshSaveHost", { alias: "a" });
  ok("sshSaveHost", { alias: "a", hostName: "%h.example.com" });
  ok("sshSaveHost", { alias: "a", hostName: "2001:db8::1" });
  bad("sshSaveHost", {}, ["alias"]);
  bad("sshSaveHost", { alias: "-x" }, ["alias"]);
  bad("sshSaveHost", { alias: "a b" }, ["alias"]);
  bad("sshSaveHost", { alias: "a", previousAlias: "*" }, ["previousAlias"]);
  bad("sshSaveHost", { alias: "a", hostName: "-h" }, ["hostName"]);
  bad("sshSaveHost", { alias: "a", hostName: "h x" }, ["hostName"]);
  bad("sshSaveHost", { alias: "a", hostName: "h\nHost evil" }, ["hostName"]);
  bad("sshSaveHost", { alias: "a", user: "-l" }, ["user"]);
  bad("sshSaveHost", { alias: "a", port: 70000 }, ["port"]);
  bad("sshSaveHost", { alias: "a", port: "22" }, ["port"]);
  // A newline or quote cannot be written to a config value; a space can (it is quoted).
  bad("sshSaveHost", { alias: "a", identityFile: "x\ny" }, ["identityFile"]);
  bad("sshSaveHost", { alias: "a", identityFile: 'x"y' }, ["identityFile"]);
  bad("sshSaveHost", { alias: "a", proxyJump: "-J x" }, ["proxyJump"]);
  bad("sshSaveHost", { alias: "a", tint: "Red" }, ["tint"]);
  bad("sshSaveHost", { alias: "a", tags: "prod" }, ["tags"]);
  bad("sshSaveHost", { alias: "a", tags: ["has space"] }, ["tags"]);
  bad("sshSaveHost", { alias: "a", tags: [""] }, ["tags"]);
  bad("sshSaveHost", { alias: "a", favorite: "yes" }, ["favorite"]);
  bad("sshSaveHost", { alias: "a", tmux: 1 }, ["tmux"]);
  bad("sshSaveHost", { alias: "a", remoteCommand: "" }, ["remoteCommand"]);
  bad("sshSaveHost", { alias: "a", remoteCommand: "x\0y" }, ["remoteCommand"]);
});

Deno.test("ssh schema: sshDeleteHost, sshCancel, sshHosts", () => {
  assertEquals(ok("sshDeleteHost", { alias: "a", x: 1 }), { alias: "a" });
  bad("sshDeleteHost", { alias: "a/b" }, ["alias"]);
  bad("sshDeleteHost", {}, ["alias"]);
  assertEquals(ok("sshCancel", { transferId: "transfer-1" }), {
    transferId: "transfer-1",
  });
  bad("sshCancel", { transferId: "" }, ["transferId"]);
  bad("sshCancel", { transferId: "x".repeat(65) }, ["transferId"]);
  assertEquals(ok("sshHosts", { anything: 1 }), {});
});

Deno.test("ssh schema: sshUpload", () => {
  assertEquals(
    ok("sshUpload", {
      ...ALIAS,
      localPaths: ["/Users/me/a.txt", "/Users/me/dir"],
      remoteDir: "~/in",
    }),
    {
      ...ALIAS,
      localPaths: ["/Users/me/a.txt", "/Users/me/dir"],
      remoteDir: "~/in",
    },
  );
  assertEquals(
    (ok("sshUpload", { ...ALIAS, localPaths: ["/a"] }) as { remoteDir: string })
      .remoteDir,
    "~",
  );
  bad("sshUpload", { ...ALIAS }, ["localPaths"]);
  bad("sshUpload", { ...ALIAS, localPaths: [] }, ["localPaths"]);
  bad("sshUpload", { ...ALIAS, localPaths: "/a" }, ["localPaths"]);
  bad("sshUpload", { ...ALIAS, localPaths: ["rel/a"] }, ["localPaths"]);
  bad("sshUpload", { ...ALIAS, localPaths: ["evil:x"] }, ["localPaths"]);
  bad("sshUpload", { ...ALIAS, localPaths: ["/a\0b"] }, ["localPaths"]);
  bad("sshUpload", { ...ALIAS, localPaths: Array(257).fill("/a") }, [
    "localPaths",
  ]);
  bad("sshUpload", { ...ALIAS, localPaths: ["/a"], remoteDir: "x\ny" }, [
    "remoteDir",
  ]);
  bad("sshUpload", { localPaths: ["/a"] }, ["target"]);
});

Deno.test("ssh schema: sshDownload", () => {
  assertEquals(ok("sshDownload", { ...ALIAS, remotePath: "/var/log/x.log" }), {
    ...ALIAS,
    remotePath: "/var/log/x.log",
    localDir: undefined,
  });
  ok("sshDownload", {
    ...QUICK,
    remotePath: "~/a b",
    localDir: "/Users/me/Desktop",
  });
  bad("sshDownload", { ...ALIAS }, ["remotePath"]);
  bad("sshDownload", { ...ALIAS, remotePath: "" }, ["remotePath"]);
  bad("sshDownload", { ...ALIAS, remotePath: "/x", localDir: "Desktop" }, [
    "localDir",
  ]);
  bad("sshDownload", { ...ALIAS, remotePath: "/x", localDir: "" }, [
    "localDir",
  ]);
});

Deno.test("ssh schema: sshList", () => {
  assertEquals(ok("sshList", { ...ALIAS, path: "/etc" }), {
    ...ALIAS,
    path: "/etc",
  });
  bad("sshList", { ...ALIAS, path: "" }, ["path"]);
  bad("sshList", { ...ALIAS, path: "a\nb" }, ["path"]);
});
