import { assert, assertEquals } from "@std/assert";
import {
  applyTransferEvent,
  baseName,
  bindTransfer,
  disconnectMessage,
  dismissTransfer,
  exitBanner,
  exitReason,
  formatSize,
  itemCount,
  joinRemote,
  parentRemote,
  restartsOnEnter,
  SHELL_PROFILE,
  sortEntries,
  sshOf,
  type SshProfile,
  transferCount,
  transferState,
  transferText,
  type TransferView,
  trustedRemoteCwd,
} from "../lib/ssh-ui.ts";
import type { SshTransferEvent } from "../desktop/ssh.ts";

const SSH: SshProfile = {
  kind: "ssh",
  target: { alias: "web-1" },
  label: "web-1",
  tint: "red",
};

Deno.test("ssh-ui: shells restart on Enter, SSH tiles wait for Reconnect", () => {
  assert(restartsOnEnter(SHELL_PROFILE));
  assert(!restartsOnEnter(SSH));
  assertEquals(sshOf(SHELL_PROFILE), undefined);
  assertEquals(sshOf(SSH), SSH);
});

Deno.test("ssh-ui: exit reasons, banners and the Disconnected message", () => {
  assertEquals(exitReason({ exitCode: 0, signal: null }), "code 0");
  assertEquals(exitReason({ exitCode: 0, signal: 9 }), "signal 9");
  assertEquals(exitReason({ exitCode: 3, signal: 0 }), "code 3");
  assertEquals(exitReason({ exitCode: null }), "not started");
  assertEquals(
    exitBanner(SHELL_PROFILE, { exitCode: 1, signal: null }),
    "[process exited (code 1) — press Enter to restart or ⌘W to close]",
  );
  assertEquals(
    exitBanner(SSH, { exitCode: 255, signal: null }),
    "[disconnected (code 255)]",
  );
  assertEquals(disconnectMessage({ exitCode: 0 }), "The session ended.");
  assertEquals(
    disconnectMessage({ exitCode: 255 }),
    "ssh could not connect, or the connection dropped.",
  );
  assertEquals(
    disconnectMessage({ exitCode: 0, signal: 15 }),
    "ssh was ended by signal 15.",
  );
  assertEquals(
    disconnectMessage({ exitCode: 2 }),
    "The remote side exited with code 2.",
  );
  assertEquals(
    disconnectMessage({ exitCode: null, message: "bad alias" }),
    "bad alias",
  );
});

Deno.test("ssh-ui: OSC 7 is trusted for SSH tiles only, whatever host it names", () => {
  assertEquals(
    trustedRemoteCwd(SSH, "file://prod-box.internal/srv/my%20app"),
    "/srv/my app",
  );
  assertEquals(trustedRemoteCwd(SSH, "file:///home/me"), "/home/me");
  assertEquals(trustedRemoteCwd(SHELL_PROFILE, "file:///Users/me"), undefined);
  assertEquals(trustedRemoteCwd(SSH, "kitty-shell-cwd://x/y"), undefined);
  assertEquals(trustedRemoteCwd(SSH, "file://host"), undefined);
});

Deno.test("ssh-ui: small formatters", () => {
  assertEquals(itemCount(1), "1 item");
  assertEquals(itemCount(3), "3 items");
  assertEquals(baseName("/Users/me/Desktop/a b.txt"), "a b.txt");
  assertEquals(baseName("/Users/me/folder/"), "folder");
  assertEquals(baseName("/"), "/");
  assertEquals(formatSize(512), "512 B");
  assertEquals(formatSize(1480), "1.4 KB");
  assertEquals(formatSize(52_428_800), "50 MB");
  assertEquals(formatSize(3 * 1024 ** 4), "3.0 TB");
});

const ev = (p: Partial<SshTransferEvent>): SshTransferEvent => ({
  transferId: "x1",
  seq: 1,
  kind: "upload",
  percent: 0,
  filesDone: 0,
  done: false,
  ...p,
});

Deno.test("ssh-ui: transfers fold events in either order relative to the start call", () => {
  // The event first (it can beat the start call's answer), then the binding.
  let list: TransferView[] = applyTransferEvent(
    [],
    ev({ file: "a.txt", percent: 40, fileCount: 3 }),
  );
  assertEquals(list[0].terminalId, undefined);
  list = bindTransfer(list, "x1", {
    terminalId: "t2",
    kind: "upload",
    remoteDir: "/srv/app",
    fileCount: 3,
  });
  assertEquals(list.length, 1);
  assertEquals(list[0].terminalId, "t2");
  assertEquals(list[0].percent, 40);
  assertEquals(list[0].remoteDir, "/srv/app");
  assertEquals(transferState(list[0]), "running");
  assertEquals(transferText(list[0]), "Uploading a.txt");
  assertEquals(transferCount(list[0]), "1/3");
  list = applyTransferEvent(
    list,
    ev({ percent: 100, filesDone: 3, done: true }),
  );
  assertEquals(transferState(list[0]), "done");
  assertEquals(transferText(list[0]), "Uploaded 3 items to /srv/app");
  assertEquals(transferCount(list[0]), "3/3");
  // The binding first, then events.
  let d = bindTransfer([], "x2", {
    terminalId: "t1",
    kind: "download",
    localPath: "/Users/me/Downloads/notes.md",
  });
  assertEquals(transferText(d[0]), "Starting download…");
  d = applyTransferEvent(
    d,
    ev({ transferId: "x2", kind: "download", file: "notes.md", percent: 60 }),
  );
  assertEquals(transferText(d[0]), "Downloading notes.md");
  assertEquals(transferCount(d[0]), "");
  d = applyTransferEvent(
    d,
    ev({ transferId: "x2", kind: "download", done: true, filesDone: 1 }),
  );
  assertEquals(transferText(d[0]), "Saved to /Users/me/Downloads/notes.md");
  assertEquals(dismissTransfer(d, "x2"), []);
});

Deno.test("ssh-ui: cancelled and failed transfers", () => {
  const cancelled = applyTransferEvent(
    [],
    ev({ done: true, error: "cancelled" }),
  )[0];
  assertEquals(transferState(cancelled), "cancelled");
  assertEquals(transferText(cancelled), "Upload cancelled");
  const failed = applyTransferEvent(
    [],
    ev({ kind: "download", done: true, error: "No such file" }),
  )[0];
  assertEquals(transferState(failed), "failed");
  assertEquals(transferText(failed), "Download failed: No such file");
});

Deno.test("ssh-ui: remote paths and the picker's order", () => {
  assertEquals(joinRemote("/home/demo", "src"), "/home/demo/src");
  assertEquals(joinRemote("/", "etc"), "/etc");
  assertEquals(parentRemote("/home/demo/src"), "/home/demo");
  assertEquals(parentRemote("/home"), "/");
  assertEquals(parentRemote("/"), "/");
  assertEquals(
    sortEntries([
      { name: "b.txt", kind: "file", size: 1 },
      { name: ".cache", kind: "dir", size: 1 },
      { name: "src", kind: "dir", size: 1 },
      { name: ".profile", kind: "file", size: 1 },
      { name: "A.md", kind: "file", size: 1 },
      { name: "latest", kind: "link", size: 1 },
    ]).map((e) => e.name),
    ["src", ".cache", "A.md", "b.txt", "latest", ".profile"],
  );
});
