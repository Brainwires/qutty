// The demo backend's SSH half (plain-browser development and the e2e suite): a few hosts as if
// read from `~/.ssh/config` and one saved in qutty.conf, an in-memory save/delete, the real argv
// builder, a fake remote directory tree for the picker, and transfers that tick to 100% on a
// timer. The ssh "session" itself is the demo shell with a remote-looking prompt (see
// `remoteOf` and lib/pty-client.ts).

import type {
  SshCommand,
  SshDownloadArgs,
  SshHostsResult,
  SshListArgs,
  SshTransferEvent,
  SshTransferStarted,
  SshUploadArgs,
} from "../desktop/ssh.ts";
import {
  type SshHost,
  type SshHostInput,
  type SshTarget,
  targetLabel,
} from "./ssh-config.ts";
import {
  remoteBaseName,
  remoteOperandPath,
  sshArgv,
  type SshDirEntry,
  type SshListing,
  type SshRecent,
} from "./ssh-command.ts";

const USER_CONFIG = "/Users/demo/.ssh/config";
const QUTTY_CONF = "/Users/demo/.ssh/qutty.conf";

function demoHosts(): SshHost[] {
  return [
    {
      alias: "web-1",
      aliases: ["web-1"],
      hostName: "web-1.example.com",
      user: "deploy",
      identityFile: "~/.ssh/id_ed25519",
      directives: [{ key: "ForwardAgent", value: "yes" }],
      source: USER_CONFIG,
      editable: false,
    },
    {
      alias: "db",
      aliases: ["db", "db-primary"],
      hostName: "10.0.0.5",
      user: "postgres",
      port: 2222,
      proxyJump: "bastion",
      directives: [{ key: "LocalForward", value: "5432 localhost:5432" }],
      source: USER_CONFIG,
      editable: false,
    },
    {
      alias: "prod-api",
      aliases: ["prod-api"],
      hostName: "api.example.com",
      user: "ops",
      directives: [],
      tint: "red",
      tags: ["prod"],
      favorite: true,
      tmux: true,
      source: QUTTY_CONF,
      editable: true,
    },
  ];
}

const DEMO_TREE: Record<string, SshDirEntry[]> = {
  "/home/demo": [
    { name: "src", kind: "dir", size: 4096 },
    { name: "notes.md", kind: "file", size: 1480 },
    { name: "backup.tar.gz", kind: "file", size: 52_428_800 },
    { name: "report final.pdf", kind: "file", size: 220_144 },
    { name: "latest", kind: "link", size: 8, target: "notes.md" },
  ],
  "/home/demo/src": [
    { name: "main.rs", kind: "file", size: 3021 },
    { name: "lib.rs", kind: "file", size: 998 },
  ],
};

/** What a `spawn` with `program: "ssh"` stands for: the destination after `--`. */
export function remoteOf(
  args: string[],
): { user: string; host: string } | undefined {
  const dest = args[args.indexOf("--") + 1];
  if (dest === undefined || args.indexOf("--") < 0) return undefined;
  const host = demoHosts().find((h) => h.aliases.includes(dest));
  if (host) return { user: host.user ?? "demo", host: host.hostName ?? dest };
  const at = dest.indexOf("@");
  return at < 0
    ? { user: "demo", host: dest }
    : { user: dest.slice(0, at), host: dest.slice(at + 1) };
}

/** The SSH methods of the demo backend. `emit` delivers transfer events to the page. */
export function createDemoSsh(emit: (event: SshTransferEvent) => void) {
  let hosts = demoHosts();
  let recents: SshRecent[] = [];
  let nextTransfer = 0;
  const running = new Map<
    string,
    {
      timer: ReturnType<typeof setInterval>;
      seq: number;
      kind: SshTransferEvent["kind"];
    }
  >();

  const find = (alias: string) => hosts.find((h) => h.aliases.includes(alias));

  /** A transfer that advances 20% every 150 ms per file, then reports done. */
  const start = (
    kind: SshTransferEvent["kind"],
    files: string[],
  ): SshTransferStarted => {
    const transferId = `demo-transfer-${++nextTransfer}`;
    let index = 0;
    let percent = 0;
    const tick = () => {
      const r = running.get(transferId)!;
      percent = Math.min(100, percent + 20);
      const filesDone = index + (percent === 100 ? 1 : 0);
      const done = filesDone === files.length;
      emit({
        transferId,
        seq: ++r.seq,
        kind,
        file: files[index],
        percent,
        filesDone,
        ...(kind === "upload" ? { fileCount: files.length } : {}),
        done,
      });
      if (percent === 100) {
        index++;
        percent = 0;
      }
      if (done) stop(transferId);
    };
    running.set(transferId, { timer: setInterval(tick, 150), seq: 0, kind });
    return { transferId };
  };
  const stop = (transferId: string) => {
    const r = running.get(transferId);
    if (r) clearInterval(r.timer);
    running.delete(transferId);
    return r;
  };

  return {
    sshHosts(): Promise<SshHostsResult> {
      return Promise.resolve({ hosts: [...hosts], recents: [...recents] });
    },
    sshSaveHost(input: SshHostInput): Promise<SshHost> {
      const previous = find(input.previousAlias ?? input.alias);
      if (previous && !previous.editable) {
        return Promise.reject(new Error("that host is in ~/.ssh/config"));
      }
      const { previousAlias: _, ...fields } = input;
      const saved: SshHost = {
        aliases: [input.alias],
        directives: previous?.directives ?? [],
        ...fields,
        source: QUTTY_CONF,
        editable: true,
      };
      hosts = previous
        ? hosts.map((h) => (h === previous ? saved : h))
        : [...hosts, saved];
      return Promise.resolve(saved);
    },
    sshDeleteHost(alias: string): Promise<void> {
      const host = find(alias);
      if (!host?.editable) return Promise.reject(new Error("no such host"));
      hosts = hosts.filter((h) => h !== host);
      return Promise.resolve();
    },
    sshCommand(target: SshTarget): Promise<SshCommand> {
      const host = "alias" in target ? find(target.alias) : undefined;
      let args: string[];
      try {
        args = sshArgv(
          target,
          { controlPath: "/Users/demo/.ssh/qutty-%C" },
          host ?? {},
        );
      } catch (err) {
        return Promise.reject(err);
      }
      const label = targetLabel(target);
      recents = [
        { label, target, at: Date.now() },
        ...recents.filter((r) => r.label !== label),
      ];
      return Promise.resolve({
        program: "ssh",
        args,
        label,
        ...(host ? { host } : {}),
      });
    },
    sshUpload(args: SshUploadArgs): Promise<SshTransferStarted> {
      return Promise.resolve(
        start("upload", args.localPaths.map((p) => remoteBaseName(p))),
      );
    },
    sshDownload(args: SshDownloadArgs): Promise<SshTransferStarted> {
      const name = remoteBaseName(args.remotePath);
      return Promise.resolve({
        ...start("download", [name]),
        localPath: `${args.localDir ?? "/Users/demo/Downloads"}/${name}`,
      });
    },
    sshList(args: SshListArgs): Promise<SshListing> {
      const rel = remoteOperandPath(args.path ?? "~");
      const path =
        (rel === ""
          ? "/home/demo"
          : rel.startsWith("/")
          ? rel
          : `/home/demo/${rel}`)
          .replace(/\/+$/, "") || "/";
      const entries = DEMO_TREE[path];
      return entries
        ? Promise.resolve({ path, entries: [...entries] })
        : Promise.reject(new Error("No such file or directory"));
    },
    sshCancel(transferId: string): Promise<void> {
      const r = stop(transferId);
      if (r) {
        emit({
          transferId,
          seq: ++r.seq,
          kind: r.kind,
          percent: 0,
          filesDone: 0,
          done: true,
          error: "cancelled",
        });
      }
      return Promise.resolve();
    },
    /** Stop every timer (tests). */
    dispose(): void {
      for (const id of [...running.keys()]) stop(id);
    },
  };
}
