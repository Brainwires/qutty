// A tile moving between windows through the real `pty` and `session` extensions (desktop/pty.ts,
// desktop/session.ts, desktop/tile-move.ts), with a real shell and a fake extension host
// (tests/session_helpers.ts): the shell keeps running and only changes owner, its output follows
// the tile, the window it left can no longer touch it, and the two workspaces' snapshots stay
// right through a reload of either page.
//
// Run: deno test -A tests/

import { assert, assertEquals, assertRejects } from "@std/assert";
import { DesktopCapError } from "denext/desktop";
import ptyExt, { terminalSessions } from "../desktop/pty.ts";
import sessionExt, {
  type MoveResult,
  type SessionJoin,
  type TileArrival,
} from "../desktop/session.ts";
import { workspaces } from "../desktop/workspace-host.ts";
import { snapshotHasTile } from "../lib/workspace/session.ts";
import { HAS_SH, marker, POSIX, warmUp } from "./pty_helpers.ts";
import { ctxOf, fakeExtensionHost, until } from "./session_helpers.ts";

await warmUp();

const ignore = !POSIX || !HAS_SH;
const SH = { cols: 80, rows: 24, shell: "/bin/sh", cwd: "/tmp" };
const pty = ptyExt.methods;
const session = sessionExt.methods;

function app() {
  workspaces.clear();
  const fake = fakeExtensionHost([
    { id: "main", kind: "main", key: "ws-a" },
    { id: "w2", kind: "window", key: "ws-b" },
  ]);
  ptyExt.setup(fake.host);
  sessionExt.setup(fake.host);
  return fake;
}

const join = (window: string) =>
  session.join.handler({}, ctxOf(window)) as SessionJoin;
const save = (window: string, snapshot: unknown, arrived?: string[]) =>
  session.save.handler(
    arrived ? { snapshot, arrived } : { snapshot },
    ctxOf(window),
  );
const entry = (id: string) => ({
  id,
  title: "sh",
  createdAt: 1,
  lastUsedAt: 1,
  exited: false,
  exitCode: null,
  activity: false,
});
const snap = (tiles: Record<string, unknown>) => ({
  v: 1,
  seq: Object.keys(tiles).length,
  terminals: Object.keys(tiles).map(entry),
  mru: Object.keys(tiles),
  order: Object.keys(tiles),
  tiles,
});

Deno.test({
  name:
    "tile move: a shell moved to another window keeps running there; the window it left loses it",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const fake = app();
    join("main");
    join("w2");
    const a = await pty.spawn.handler(SH, ctxOf("main"));
    const b = await pty.spawn.handler(SH, ctxOf("w2"));
    try {
      const before = marker("before");
      await pty.write.handler(
        { id: a.id, data: `cd /tmp; ${before.cmd}\r` },
        ctxOf("main"),
      );
      await until(
        "output before",
        () => fake.text(a.id, "main").includes(before.text),
      );
      const shTile = { ptyId: a.id, profile: { kind: "shell" } };
      save(
        "main",
        snap({ t1: shTile, t2: { web: { url: "https://a.example/" } } }),
      );
      save("w2", snap({ t1: { ptyId: b.id, profile: { kind: "shell" } } }));

      // The header menu lists the other window; the tile moves there.
      assertEquals(
        (session.moveTargets.handler({}, ctxOf("main")) as { window: string }[])
          .map((t) => t.window),
        ["w2"],
      );
      const moved = session.moveTile.handler({
        tileId: "t1",
        tile: { entry: entry("t1"), tile: shTile },
        to: { window: "w2" },
        last: false,
      }, ctxOf("main")) as MoveResult;
      assert(moved.moved);
      assertEquals(terminalSessions().ownerOf(a.id), "w2");
      assert(terminalSessions().host.isRunning(a.id), "no restart");
      assert(
        fake.events.some((e) =>
          e.event === "tileArrived" && e.window === "w2" && e.retain === false
        ),
      );

      // The target page pulls it, with the output from before the move.
      const [arrival] = session.arrivals.handler(
        {},
        ctxOf("w2"),
      ) as TileArrival[];
      assertEquals(arrival.pty?.id, a.id);
      assert(arrival.pty?.data.includes(before.text));
      // The shell answers there, in the folder it was left in; the source window cannot reach it.
      await pty.write.handler(
        { id: a.id, data: "echo MOVED_$((6*7)) $(pwd)\r" },
        ctxOf("w2"),
      );
      await until(
        "output after the move",
        () => /MOVED_42 \S*\/tmp/.test(fake.text(a.id, "w2")),
      );
      assert(!fake.text(a.id, "main").includes("MOVED_42"));
      await assertRejects(
        () => pty.write.handler({ id: a.id, data: "x" }, ctxOf("main")),
        DesktopCapError,
        "no such terminal",
      );

      // A save the source page sent before it heard still has the tile: it is dropped.
      save(
        "main",
        snap({ t1: shTile, t2: { web: { url: "https://a.example/" } } }),
      );
      assert(!snapshotHasTile(workspaces.snapshotOf("ws-a"), "t1"));
      assert(snapshotHasTile(workspaces.snapshotOf("ws-a"), "t2"));

      // The target page reloads before it saved the tile: the join brings it, once.
      const reloaded = join("w2");
      const tiles =
        (reloaded.snapshot as { tiles: Record<string, { ptyId?: string }> })
          .tiles;
      assertEquals(
        Object.values(tiles).map((t) => t.ptyId).sort(),
        [a.id, b.id].sort(),
      );
      assertEquals(session.arrivals.handler({}, ctxOf("w2")), []);
      assertEquals(reloaded.ptys.map((p) => p.id).sort(), [a.id, b.id].sort());

      // The last tile (the web one) leaving closes the source window; its workspace ends after.
      const last = session.moveTile.handler({
        tileId: "t2",
        tile: {
          entry: entry("t2"),
          tile: { web: { url: "https://a.example/" } },
        },
        to: { window: "w2" },
        last: true,
      }, ctxOf("main")) as MoveResult;
      assert(last.moved);
      // (The fake host's runtime windows were not shared: the close is the page's job here.)
      await fake.close("main");
      assert(!workspaces.has("ws-a"));
      assert(
        terminalSessions().host.isRunning(a.id),
        "the moved shell lives on",
      );
      // The target page shows it and saves it: no longer pending.
      const [web] = session.arrivals.handler({}, ctxOf("w2")) as TileArrival[];
      assertEquals(web.tile.tile, { web: { url: "https://a.example/" } });
      save(
        "w2",
        snap({
          t1: { ptyId: b.id, profile: { kind: "shell" } },
          t2: shTile,
          t3: { web: { url: "https://a.example/" } },
        }),
        [web.move],
      );
      assertEquals(session.arrivals.handler({}, ctxOf("w2")), []);
    } finally {
      await fake.quit();
    }
    assertEquals(terminalSessions().size, 0);
  },
});
