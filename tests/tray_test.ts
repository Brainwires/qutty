// Tray mode (desktop/tray.ts) without a window: the tray menu built from a workspace list, the
// last-window decision by OS and tray, and TrayMode over a fake runtime (its tray, windows and
// activation policy) and a real workspace registry. followWindows (desktop/session.ts) over the
// fake extension host (tests/session_helpers.ts).
//
// Run: deno test -A tests/

import { assertEquals } from "@std/assert";
import {
  anyRunning,
  lastWindowAction,
  TRAY_NEW_WINDOW,
  TRAY_QUIT,
  trayIcons,
  trayMenu,
  trayMenuAction,
  TrayMode,
} from "../desktop/tray.ts";
import { followWindows } from "../desktop/session.ts";
import {
  type WorkspaceInfo,
  WorkspaceRegistry,
} from "../desktop/workspace-host.ts";
import { fakeExtensionHost } from "./session_helpers.ts";

/** A workspace with `running` terminals still running, and `exited` more whose shell ended. */
const ws = (
  id: string,
  running: number,
  state: WorkspaceInfo["state"] = "detached",
  exited = 0,
): WorkspaceInfo => ({
  id,
  name: `Workspace ${id}`,
  state,
  terminals: running + exited,
  running,
  busy: 0,
});

/** The labels of a menu, separators as "-" and disabled lines in brackets. */
function labels(menu: ReturnType<typeof trayMenu>): string[] {
  return menu.map((m) =>
    m === "separator"
      ? "-"
      : m.disabled
      ? `[${m.label}]`
      : m.checked
      ? `✓ ${m.label}`
      : m.label
  );
}

Deno.test("tray menu: New Window, the workspaces with terminals (open ones checked), Quit", () => {
  const menu = trayMenu(
    [ws("1", 2, "attached"), ws("2", 1), ws("3", 0, "attached"), ws("4", 3)],
    "darwin",
  );
  assertEquals(labels(menu), [
    "New Window",
    "-",
    "✓ Workspace 1 — 2 terminals",
    "Workspace 2 — 1 terminal",
    "Workspace 4 — 3 terminals",
    "-",
    "Quit Qutty",
  ]);
  assertEquals(trayMenuAction((menu[0] as { id: string }).id), { kind: "new" });
  assertEquals(trayMenuAction((menu[3] as { id: string }).id), {
    kind: "workspace",
    id: "2",
  });
  assertEquals(trayMenuAction((menu[6] as { id: string }).id), {
    kind: "quit",
  });
});

Deno.test("tray menu: only running terminals count; exited ones (tile still shown) do not", () => {
  const menu = trayMenu(
    [ws("1", 1, "attached", 2), ws("2", 0, "detached", 3)],
    "darwin",
  );
  assertEquals(labels(menu).slice(2, -2), ["✓ Workspace 1 — 1 terminal"]);
  assertEquals(anyRunning([ws("2", 0, "detached", 3)]), false);
  assertEquals(anyRunning([ws("2", 0), ws("3", 1, "detached", 1)]), true);
});

Deno.test("tray menu: Linux marks the open ones in the label", () => {
  assertEquals(
    labels(trayMenu([ws("1", 1, "attached")], "linux"))[2],
    "Workspace 1 — 1 terminal (open)",
  );
});

Deno.test("tray menu: nothing running shows a disabled line", () => {
  const menu = trayMenu([ws("1", 0, "attached")], "darwin");
  assertEquals(labels(menu), [
    "New Window",
    "-",
    "[No running terminals]",
    "-",
    "Quit Qutty",
  ]);
  assertEquals(trayMenuAction("qutty:tray:none"), undefined);
});

Deno.test("tray menu: at most 15 workspaces, the rest counted", () => {
  const list = Array.from({ length: 20 }, (_, i) => ws(String(i + 1), 1));
  const menu = labels(trayMenu(list, "windows"));
  assertEquals(menu.length, 2 + 15 + 1 + 2);
  assertEquals(menu[16], "Workspace 15 — 1 terminal");
  assertEquals(menu[17], "[5 more…]");
});

Deno.test("tray menu: item ids", () => {
  assertEquals(trayMenuAction(TRAY_NEW_WINDOW), { kind: "new" });
  assertEquals(trayMenuAction(TRAY_QUIT), { kind: "quit" });
  assertEquals(trayMenuAction("qutty:tray:ws:"), undefined);
  assertEquals(trayMenuAction("something-else"), undefined);
});

Deno.test("last window closed: tray while terminals run, else quit; no tray keeps the old way", () => {
  for (const os of ["darwin", "linux", "windows"]) {
    assertEquals(lastWindowAction({ os, tray: true, running: true }), "tray");
    assertEquals(lastWindowAction({ os, tray: true, running: false }), "quit");
  }
  assertEquals(
    lastWindowAction({ os: "darwin", tray: false, running: true }),
    "stay",
  );
  assertEquals(
    lastWindowAction({ os: "darwin", tray: false, running: false }),
    "stay",
  );
  assertEquals(
    lastWindowAction({ os: "linux", tray: false, running: true }),
    "quit",
  );
  assertEquals(
    lastWindowAction({ os: "windows", tray: false, running: false }),
    "quit",
  );
});

Deno.test("tray icons: a template glyph on macOS, the app icon and a dark variant elsewhere", () => {
  assertEquals(trayIcons("darwin"), { icon: "/tray-template.png" });
  assertEquals(trayIcons("linux"), {
    icon: "/tray.png",
    iconDark: "/tray-dark.png",
  });
});

/** One turn of the event loop (followWindows decides after every close hook ran). */
const turn = () => new Promise((r) => setTimeout(r, 0));

/** A fake of the runtime slice TrayMode drives, recording what it was asked. */
function fakeRuntime(opts: { tray?: boolean } = {}) {
  const calls: string[] = [];
  const open = new Set<string>();
  const menus: unknown[][] = [];
  let menuItem: ((id: string) => void) | undefined;
  const ref = (key: string) => ({
    key,
    kind: "window" as const,
    show: () => void calls.push(`show ${key}`),
    focus: () => void calls.push(`focus ${key}`),
  });
  const rt = {
    ...(opts.tray === false ? {} : {
      tray: {
        update: (u: { menu?: readonly unknown[] | null }) =>
          void menus.push([...(u.menu ?? [])]),
        onMenuItem: (fn: (id: string) => void) => {
          menuItem = fn;
          return () => menuItem = undefined;
        },
      },
    }),
    windows: {
      open: (o: { key?: string }) => {
        calls.push(`open ${o.key}`);
        open.add(o.key!);
        return ref(o.key!) as never;
      },
      byKey: (key: string) => (open.has(key) ? ref(key) as never : undefined),
      list: () => [...open].map(ref) as never[],
    },
    setActivationPolicy: (p: string) => {
      calls.push(`policy ${p}`);
      return true;
    },
    // `DesktopRuntime.quit()`: the whole quit, every extension's guard included.
    quit: () => {
      calls.push("quit");
      return Promise.resolve(true);
    },
  };
  return {
    rt,
    calls,
    open,
    menus,
    click: (id: string) => menuItem?.(id),
  };
}

/** A registry with workspace `id` shown in window `win`, with `n` terminals. */
function withWorkspace(
  reg: WorkspaceRegistry,
  win: string,
  id: string,
  n: number,
) {
  reg.join(win, id);
  for (let i = 0; i < n; i++) reg.addPty(id, `${id}-pty-${i}`);
}

Deno.test("TrayMode macOS: the last window closed with terminals running hides the Dock icon; a window brings it back", () => {
  const reg = new WorkspaceRegistry();
  const fake = fakeRuntime();
  const mode = new TrayMode();
  let quits = 0;
  mode.install(fake.rt, reg, { os: "darwin", quit: () => quits++ });
  try {
    withWorkspace(reg, "main", "main", 2);
    reg.windowClosed("main");
    assertEquals(mode.lastWindowClosed(), "tray");
    assertEquals(fake.calls, ["policy accessory"]);
    assertEquals(mode.background, true);
    mode.windowOpened();
    assertEquals(fake.calls, ["policy accessory", "policy regular"]);
    assertEquals(mode.background, false);
    mode.windowOpened(); // already regular: nothing more
    assertEquals(fake.calls.length, 2);
    assertEquals(quits, 0);
  } finally {
    mode.uninstall();
  }
});

Deno.test("TrayMode Linux: stays in the tray without touching the policy; quits with nothing running", () => {
  const reg = new WorkspaceRegistry();
  const fake = fakeRuntime();
  const mode = new TrayMode();
  let quits = 0;
  mode.install(fake.rt, reg, { os: "linux", quit: () => quits++ });
  try {
    withWorkspace(reg, "main", "main", 2);
    reg.windowClosed("main");
    assertEquals(mode.lastWindowClosed(), "tray");
    assertEquals(fake.calls, []);
    reg.ptyExited("main-pty-0"); // one shell exits: the other still runs
    assertEquals(quits, 0);
    // The last detached shell exits while in the tray: nothing is left, so it quits.
    reg.ptyExited("main-pty-1");
    assertEquals(quits, 1);
    assertEquals(mode.background, false);
  } finally {
    mode.uninstall();
  }
});

Deno.test("TrayMode: End Shells on the last window (nothing left) quits on every platform", () => {
  for (const os of ["darwin", "linux", "windows"] as const) {
    const reg = new WorkspaceRegistry();
    const fake = fakeRuntime();
    const mode = new TrayMode();
    let quits = 0;
    mode.install(fake.rt, reg, { os, quit: () => quits++ });
    try {
      withWorkspace(reg, "main", "main", 2);
      reg.endOnClose("main");
      reg.windowClosed("main");
      assertEquals(mode.lastWindowClosed(), "quit");
      assertEquals(quits, 1);
      assertEquals(fake.calls, []);
    } finally {
      mode.uninstall();
    }
  }
});

Deno.test("TrayMode without a tray: the old way (quit off macOS, a Dock app on macOS)", () => {
  for (const [os, want] of [["darwin", "stay"], ["linux", "quit"]] as const) {
    const reg = new WorkspaceRegistry();
    const fake = fakeRuntime({ tray: false });
    const mode = new TrayMode();
    let quits = 0;
    mode.install(fake.rt, reg, { os, quit: () => quits++ });
    try {
      withWorkspace(reg, "main", "main", 1);
      reg.windowClosed("main");
      assertEquals(mode.available, false);
      assertEquals(mode.lastWindowClosed(), want);
      assertEquals(quits, want === "quit" ? 1 : 0);
      assertEquals(fake.calls, []);
    } finally {
      mode.uninstall();
    }
  }
});

Deno.test("TrayMode: the menu follows the workspaces; its items open, focus, reopen and quit", async () => {
  const reg = new WorkspaceRegistry();
  const fake = fakeRuntime();
  const mode = new TrayMode();
  let quits = 0;
  mode.install(fake.rt, reg, { os: "darwin", quit: () => quits++ });
  try {
    assertEquals(labels(fake.menus[0] as never), [
      "New Window",
      "-",
      "[No running terminals]",
      "-",
      "Quit Qutty",
    ]);
    fake.open.add("main");
    withWorkspace(reg, "main", "main", 1);
    withWorkspace(reg, "w2", "ws-2", 2);
    reg.windowClosed("w2");
    await new Promise((r) => setTimeout(r, 150)); // the debounced update
    assertEquals(fake.menus.length, 2);
    assertEquals(labels(fake.menus[1] as never).slice(2, 4), [
      "✓ Workspace 1 — 1 terminal",
      "Workspace 2 — 2 terminals",
    ]);

    fake.click("qutty:tray:ws:main"); // open: focus it
    fake.click("qutty:tray:ws:ws-2"); // detached: reopen its window
    fake.click(TRAY_NEW_WINDOW);
    fake.click(TRAY_QUIT);
    assertEquals(fake.calls.slice(0, 6), [
      "policy regular",
      "show main",
      "focus main",
      "policy regular",
      "open ws-2",
      "policy regular",
    ]);
    assertEquals(fake.calls[6].startsWith("open ws-"), true);
    assertEquals(quits, 1);
  } finally {
    mode.uninstall();
  }
});

Deno.test("TrayMode: Quit Qutty and the quit with nothing running go through the runtime's quit (the guards run)", async () => {
  const reg = new WorkspaceRegistry();
  const fake = fakeRuntime();
  const mode = new TrayMode();
  mode.install(fake.rt, reg, { os: "linux" });
  try {
    fake.click(TRAY_QUIT);
    assertEquals(fake.calls, ["quit"]);
    // The last window closed with nothing running: quit, the same way.
    withWorkspace(reg, "main", "main", 0);
    reg.windowClosed("main");
    assertEquals(mode.lastWindowClosed(), "quit");
    assertEquals(fake.calls, ["quit", "quit"]);
    await turn();
  } finally {
    mode.uninstall();
  }
});

Deno.test("followWindows: the last window's close (not a quit) is decided after the PTY host's hook; opens are reported", async () => {
  const fake = fakeExtensionHost([
    { id: "main", kind: "main", key: "main" },
    { id: "window-1", kind: "window", key: "ws-1" },
  ]);
  const seen: string[] = [];
  const off = followWindows(fake.host, {
    windowOpened: () => void seen.push("opened"),
    lastWindowClosed: () => {
      seen.push("last");
      return "tray";
    },
  });
  // Another close hook, run after followWindows' own: the decision still comes after it.
  const offHook = fake.host.onWindowClosed((info) => {
    if (!info.appQuitting) seen.push(`closed ${info.id}`);
  });
  try {
    assertEquals(seen, ["opened", "opened"]); // the windows open already
    seen.length = 0;
    await fake.close("window-1");
    await turn();
    assertEquals(seen, ["closed window-1"]);
    await fake.close("main");
    await turn();
    assertEquals(seen, ["closed window-1", "closed main", "last"]);
    fake.open({ id: "window-2", kind: "window", key: "ws-2" });
    assertEquals(seen.at(-1), "opened");
    seen.length = 0;
    await fake.quit();
    await turn();
    assertEquals(seen, []);
  } finally {
    offHook();
    off();
  }
});
