// A terminal's `info` from the runtime's `Deno.Pty.foreground()` (runtime 3.0.0-denext.28, the
// call Denext 4.22's `ptyInfo` is built on), with a fake PTY: the mapping (name reduced, refused
// fields left out, the shell while nothing is in the foreground), a throwing or missing call, and
// `PtyHost.info` preferring the runtime's answer over the OS readers.
//
// Run: deno task test

import { assertEquals } from "@std/assert";
import {
  type DenoPty,
  type DenoPtyForeground,
  type DenoPtyOptions,
  PtyHost,
  ptyInfoFromForeground,
  runtimeForeground,
} from "../desktop/pty.ts";
import { fakeOpenPty } from "./ptyd_helpers.ts";

const vim: DenoPtyForeground = {
  pgid: 4242,
  pid: 4242,
  name: "vim",
  argv: ["vim", "notes.md"],
  cwd: "/Users/me/src",
};

Deno.test("ptyInfo mapping: name, folder, arguments and device from foreground()", () => {
  assertEquals(
    ptyInfoFromForeground("pty-1", 100, "/bin/zsh", vim, "/dev/ttys004"),
    {
      id: "pty-1",
      pid: 100,
      process: "vim",
      cwd: "/Users/me/src",
      argv: ["vim", "notes.md"],
      tty: "/dev/ttys004",
    },
  );
});

Deno.test("ptyInfo mapping: a refused argv / cwd and Windows' null device are left out", () => {
  assertEquals(
    ptyInfoFromForeground("pty-2", 7, "/bin/zsh", {
      pgid: null,
      pid: 9,
      name: "/usr/bin/top",
      argv: null,
      cwd: null,
    }, null),
    { id: "pty-2", pid: 7, process: "top" },
  );
});

Deno.test("ptyInfo mapping: nothing in the foreground yet is the shell (a login shell's '-' dropped)", () => {
  assertEquals(
    ptyInfoFromForeground("pty-3", 7, "/bin/zsh", null),
    { id: "pty-3", pid: 7, process: "zsh" },
  );
  assertEquals(
    ptyInfoFromForeground("pty-3", 7, "/bin/zsh", { ...vim, name: "-zsh" }),
    {
      id: "pty-3",
      pid: 7,
      process: "zsh",
      cwd: "/Users/me/src",
      argv: ["vim", "notes.md"],
    },
  );
});

Deno.test("runtimeForeground: undefined without the call, null when it throws or says nothing", () => {
  assertEquals(runtimeForeground({}), undefined);
  assertEquals(runtimeForeground({ foreground: () => null }), null);
  assertEquals(
    runtimeForeground({
      foreground: () => {
        throw new Error("gone");
      },
    }),
    null,
  );
  assertEquals(runtimeForeground({ foreground: () => vim }), vim);
});

Deno.test("PtyHost.info: the runtime's foreground() answers when the PTY has it", async () => {
  const fake = fakeOpenPty();
  const open = (options: DenoPtyOptions): DenoPty =>
    Object.assign(fake.open(options), {
      ttyName: "/dev/ttys009",
      foreground: () => vim,
    });
  const host = new PtyHost(() => {}, { openPty: open });
  const t = await host.spawn({ cols: 80, rows: 24, shell: "/bin/sh" });
  try {
    assertEquals(await host.info(t.id), {
      id: t.id,
      pid: t.pid,
      process: "vim",
      cwd: "/Users/me/src",
      argv: ["vim", "notes.md"],
      tty: "/dev/ttys009",
    });
  } finally {
    host.kill(t.id);
    for (const p of fake.opened) p.exit();
  }
});
