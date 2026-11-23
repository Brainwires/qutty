// The app icon's badge of waiting agents: what counts (lib/hub/badge.ts), the hub's
// `attention` flag (a finished turn the user has not seen) and `ask_user`'s `waiting`, the setting
// (lib/workspace/store.ts `dockBadge`), the desktop backend's `setAppBadge` over Denext's
// `setBadge` (skipped where the runtime has no badge), and the e2e spy's record of it.

import { assertEquals } from "@std/assert";
import { badgeCount, waitingCount } from "../lib/hub/badge.ts";
import type { TileInfo, TileStatus } from "../lib/hub/protocol.ts";
import {
  type AppBadgeDeps,
  createDemoBackend,
  createDesktopBackend,
  type DesktopBridgeDeps,
} from "../lib/pty-client.ts";
import {
  DEFAULT_SETTINGS,
  initialState,
  reduce,
  sanitizeSettings,
} from "../lib/workspace/store.ts";
import { newBackendSpy, withBackendSpy } from "../lib/test-hooks.ts";
import { Registry } from "../lib/hub/registry.ts";
import { hubWithTiles, tile as tileId } from "./hub_helpers.ts";

function tile(
  id: string,
  status: TileStatus,
  extra: Partial<TileInfo> = {},
): TileInfo {
  return { id, name: id, status, unread: 0, ...extra };
}

Deno.test("waitingCount: only tiles whose agent waits for the user", () => {
  assertEquals(waitingCount([]), 0);
  assertEquals(
    waitingCount([
      tile("pty-1", "waiting", { harness: "claude" }),
      tile("pty-2", "idle", { harness: "claude" }), // at its prompt, seen
      tile("pty-6", "idle", { harness: "claude", attention: true }), // not seen
      tile("pty-3", "busy", { harness: "codex" }),
      tile("pty-4", "idle"), // a plain shell
      tile("pty-5", "waiting", { harness: "codex" }),
      tile("agent-1", "waiting", { harness: "claude" }), // an agent tile's session
    ]),
    4,
  );
  // Waiting and unseen at once counts once.
  assertEquals(
    waitingCount([tile("pty-1", "waiting", { attention: true })]),
    1,
  );
  // A web tile has no agent, whatever its status says.
  assertEquals(
    waitingCount([tile("web-1", "waiting", { kind: "web", attention: true })]),
    0,
  );
});

Deno.test("badgeCount: 0 (no badge) while the setting is off", () => {
  const tiles = [tile("pty-1", "waiting"), tile("pty-2", "waiting")];
  assertEquals(badgeCount(tiles, true), 2);
  assertEquals(badgeCount(tiles, false), 0);
});

Deno.test("dockBadge setting: on by default, persisted, toggled", () => {
  assertEquals(DEFAULT_SETTINGS.dockBadge, true);
  assertEquals(sanitizeSettings({ dockBadge: false }).dockBadge, false);
  assertEquals(sanitizeSettings({ dockBadge: "no" }).dockBadge, true);
  assertEquals(sanitizeSettings({}).dockBadge, true);
  let s = initialState();
  const same = reduce(s, { type: "setDockBadge", on: true });
  assertEquals(same, s);
  s = reduce(s, { type: "setDockBadge", on: false });
  assertEquals(s.settings.dockBadge, false);
  s = reduce(s, { type: "setDockBadge", on: true });
  assertEquals(s.settings.dockBadge, true);
});

/** A desktop backend whose only live calls are the badge's. */
function desktopWith(badge: AppBadgeDeps) {
  const deps: DesktopBridgeDeps = {
    desktopExtension: (() =>
      new Proxy({}, {
        get: () => () => Promise.resolve(undefined),
      })) as unknown as DesktopBridgeDeps["desktopExtension"],
    onDesktopEvent: (() => () => {}) as unknown as DesktopBridgeDeps[
      "onDesktopEvent"
    ],
    badge,
  };
  return createDesktopBackend(deps);
}

Deno.test("setAppBadge: the count, none for 0; capabilities asked once", async () => {
  const set: (number | null)[] = [];
  let asked = 0;
  const backend = desktopWith({
    setBadge: (b) => {
      set.push(b);
      return Promise.resolve();
    },
    appCapabilities: () => {
      asked++;
      return Promise.resolve({ badge: true });
    },
  });
  await backend.setAppBadge(2);
  await backend.setAppBadge(0);
  await backend.setAppBadge(1);
  assertEquals(set, [2, null, 1]);
  assertEquals(asked, 1);
});

Deno.test("setAppBadge: skipped where the runtime has no badge", async () => {
  for (
    const caps of [
      () => Promise.resolve({ badge: false }),
      () => Promise.reject(new Error("older runtime")),
    ]
  ) {
    const set: (number | null)[] = [];
    const backend = desktopWith({
      setBadge: (b) => {
        set.push(b);
        return Promise.resolve();
      },
      appCapabilities: caps,
    });
    await backend.setAppBadge(3);
    assertEquals(set, []);
  }
});

Deno.test("setAppBadge: a failing setBadge does not reject", async () => {
  const backend = desktopWith({
    setBadge: () => Promise.reject(new Error("unsupported")),
    appCapabilities: () => Promise.resolve({ badge: true }),
  });
  await backend.setAppBadge(1);
});

Deno.test("setAppBadge: the demo has no icon; the e2e spy records each count", async () => {
  const spy = newBackendSpy();
  const backend = withBackendSpy(createDemoBackend(), spy);
  await backend.setAppBadge(2);
  await backend.setAppBadge(0);
  assertEquals(spy.badges, [2, 0]);
});

Deno.test("attention: an agent's finished turn, until seen or busy again", () => {
  const r = new Registry();
  r.add({ id: "pty-1", harness: "claude" });
  r.add({ id: "pty-2" }); // a shell
  r.setStatus("pty-1", "busy");
  r.setStatus("pty-1", "idle");
  assertEquals(r.get("pty-1")?.attention, true);
  // The user looked.
  r.setAttention("pty-1", false);
  assertEquals(r.get("pty-1")?.attention, undefined);
  // Another turn; busy again clears what was not seen.
  r.setStatus("pty-1", "busy");
  r.setStatus("pty-1", "idle");
  assertEquals(r.get("pty-1")?.attention, true);
  r.setStatus("pty-1", "busy");
  assertEquals(r.get("pty-1")?.attention, undefined);
  // waiting → idle (a prompt answered or dismissed) is not a finished turn.
  r.setStatus("pty-1", "waiting");
  r.setStatus("pty-1", "idle");
  assertEquals(r.get("pty-1")?.attention, undefined);
  // A shell with no agent never asks for attention.
  r.setStatus("pty-2", "busy");
  r.setStatus("pty-2", "idle");
  assertEquals(r.get("pty-2")?.attention, undefined);
  // A closed tile is gone, flag and all.
  r.setStatus("pty-1", "busy");
  r.setStatus("pty-1", "idle");
  r.remove("pty-1");
  assertEquals(waitingCount(r.list()), 0);
});

Deno.test("attention: Claude Code's idle_prompt notification sets it; Stop after a turn too", () => {
  const { core } = hubWithTiles();
  const id = "pty-1";
  core.hook(id, "SessionStart", {}, "claude");
  core.hook(id, "Notification", { notification_type: "idle_prompt" });
  assertEquals(core.registry.get(id)?.status, "idle");
  assertEquals(core.registry.get(id)?.attention, true);
  core.registry.setAttention(id, false);
  core.hook(id, "UserPromptSubmit", {});
  core.hook(id, "Stop", {});
  assertEquals(core.registry.get(id)?.attention, true);
  assertEquals(waitingCount(core.snapshot().tiles), 1);
});

Deno.test("ask_user: the asking tile waits while its questions are open, then gets its status back", () => {
  const { core } = hubWithTiles();
  const id = "pty-1";
  core.registry.setStatus(id, "busy");
  const a = core.ask(tileId(id), "First?", [], { wait: false });
  assertEquals(core.registry.get(id)?.status, "waiting");
  const b = core.ask(tileId(id), "Second?", [], { wait: false });
  assertEquals(waitingCount(core.snapshot().tiles), 1);
  core.answer(a.id, "OK");
  assertEquals(core.registry.get(id)?.status, "waiting", "one still open");
  core.answer(b.id, null);
  assertEquals(core.registry.get(id)?.status, "busy");
  assertEquals(waitingCount(core.snapshot().tiles), 0);

  // A hook that moved the tile on while the question was open keeps its say.
  const c = core.ask(tileId(id), "Third?", [], { wait: false });
  core.registry.setStatus(id, "idle");
  core.answer(c.id, "OK");
  assertEquals(core.registry.get(id)?.status, "idle");
});
