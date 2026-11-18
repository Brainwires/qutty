// The macOS Dock menu (desktop/dock-menu.ts) without a window: the menu built from a workspace
// list, the item ids back to actions, the runtime's menu shape, the command queue, DockMenu over
// a fake `Deno.dock` and a real workspace registry, the `session` extension's relay of the
// commands to a window's page (tests/session_helpers.ts), and the page's dispatch
// (app/use-dock-commands.ts).
//
// Run: deno test -A tests/

import { assertEquals } from "@std/assert";
import {
  DOCK_AGENT_CHAT,
  DOCK_COMMAND_TTL_MS,
  DOCK_MAX_REOPEN,
  DOCK_NEW_TERMINAL,
  DOCK_NEW_WINDOW,
  type DockCommand,
  DockCommandQueue,
  type DockLike,
  DockMenu,
  dockMenu,
  dockMenuAction,
  type DockMenuEntry,
  type DockNativeItem,
  nativeDockMenu,
  runtimeDock,
} from "../desktop/dock-menu.ts";
import { relayDockCommands, windowFocused } from "../desktop/session.ts";
import {
  type WorkspaceInfo,
  WorkspaceRegistry,
} from "../desktop/workspace-host.ts";
import { runDockCommands } from "../app/use-dock-commands.ts";
import { fakeExtensionHost } from "./session_helpers.ts";

const ws = (
  id: string,
  state: WorkspaceInfo["state"],
  running = 1,
  detachedAt?: number,
): WorkspaceInfo => ({
  id,
  name: `Workspace ${id}`,
  state,
  terminals: running,
  running,
  busy: 0,
  ...(detachedAt !== undefined ? { detachedAt } : {}),
});

/** The labels of a menu: separators "-", checked "✓ ", a submenu "Label ▸ [children]". */
function labels(menu: readonly DockMenuEntry[]): unknown[] {
  return menu.map((m) =>
    m === "separator"
      ? "-"
      : "children" in m
      ? { [`${m.label} ▸`]: labels(m.children) }
      : m.checked
      ? `✓ ${m.label}`
      : m.label
  );
}

Deno.test("dock menu: the open windows by name (the active one checked), the new items, Reopen ▸", () => {
  const menu = dockMenu({
    workspaces: [
      ws("10", "attached"),
      ws("2", "attached"),
      ws("3", "detached", 2, 100),
      ws("4", "detached", 0, 300), // nothing running: not offered
      ws("5", "detached", 1, 200),
    ],
    active: "10",
    agentChat: true,
  });
  assertEquals(labels(menu), [
    "Workspace 2",
    "✓ Workspace 10",
    "-",
    "New Window",
    "New Terminal",
    "Claude Code (chat)",
    "-",
    {
      "Reopen Closed Window ▸": [
        "Workspace 5 — 1 terminal",
        "Workspace 3 — 2 terminals",
      ],
    },
  ]);
  const id = (i: number) => (menu[i] as { id: string }).id;
  assertEquals(dockMenuAction(id(0)), { kind: "workspace", id: "2" });
  const reopen = menu[7] as { children: { id: string }[] };
  assertEquals(dockMenuAction(reopen.children[1].id), {
    kind: "workspace",
    id: "3",
  });
});

Deno.test("dock menu: no window, no Claude Code, nothing to reopen: only the new items", () => {
  assertEquals(
    labels(
      dockMenu({ workspaces: [ws("1", "detached", 0)], agentChat: false }),
    ),
    ["New Window", "New Terminal"],
  );
});

Deno.test("dock menu: Reopen Closed Window lists at most DOCK_MAX_REOPEN", () => {
  const list = Array.from(
    { length: 20 },
    (_, i) => ws(String(i + 1), "detached", 1, i),
  );
  const menu = dockMenu({ workspaces: list, agentChat: false });
  const reopen = menu.at(-1) as { children: unknown[] };
  assertEquals(reopen.children.length, DOCK_MAX_REOPEN);
});

Deno.test("dock menu: item ids back to actions", () => {
  assertEquals(dockMenuAction(DOCK_NEW_WINDOW), { kind: "newWindow" });
  assertEquals(dockMenuAction(DOCK_NEW_TERMINAL), {
    kind: "command",
    command: "newTerminal",
  });
  assertEquals(dockMenuAction(DOCK_AGENT_CHAT), {
    kind: "command",
    command: "agentChat",
  });
  assertEquals(dockMenuAction("qutty:dock:window:"), undefined);
  assertEquals(dockMenuAction("qutty:dock:reopen:"), undefined);
  assertEquals(dockMenuAction("qutty:tray:new-window"), undefined);
});

Deno.test("dock menu: the runtime's shape (Deno.MenuItem)", () => {
  assertEquals(
    nativeDockMenu([
      { id: "a", label: "A", checked: true },
      "separator",
      { label: "Sub", children: [{ id: "b", label: "B" }] },
    ]),
    [
      { item: { label: "A", id: "a", enabled: true, checked: true } },
      "separator",
      {
        submenu: {
          label: "Sub",
          items: [{ item: { label: "B", id: "b", enabled: true } }],
        },
      },
    ],
  );
});

Deno.test("dock menu: only a macOS Deno.dock with setMenu takes it", () => {
  assertEquals(runtimeDock("linux"), undefined);
  assertEquals(runtimeDock("windows"), undefined);
  // `deno test` has no Deno.dock.
  assertEquals(runtimeDock("darwin"), undefined);
});

Deno.test("dock commands: queued per window, signalled, taken once, too old ones dropped", () => {
  let now = 1000;
  const q = new DockCommandQueue({ now: () => now });
  const signals: string[] = [];
  q.setSignal((w) => signals.push(w));
  q.push("main", "newTerminal");
  q.push("main", "agentChat");
  q.push("window-2", "newTerminal");
  assertEquals(signals, ["main", "main", "window-2"]);
  assertEquals(q.take("main"), ["newTerminal", "agentChat"]);
  assertEquals(q.take("main"), []);
  now += DOCK_COMMAND_TTL_MS + 1;
  assertEquals(q.take("window-2"), []);
  q.push("window-3", "agentChat");
  q.drop("window-3");
  assertEquals(q.take("window-3"), []);
});

/** A fake `Deno.dock`: the menus it was given, and a click on one of its items. */
function fakeDock() {
  const menus: (DockNativeItem[] | null)[] = [];
  const listeners = new Set<(e: Event) => void>();
  const dock: DockLike = {
    setMenu: (m) => void menus.push(m),
    addEventListener: (_t, fn) => void listeners.add(fn),
    removeEventListener: (_t, fn) => void listeners.delete(fn),
  };
  return {
    dock,
    menus,
    listeners,
    click: (id: string) => {
      for (const fn of [...listeners]) {
        fn(new CustomEvent("menuclick", { detail: { id } }));
      }
    },
  };
}

/** The labels of a native menu. */
function nativeLabels(menu: DockNativeItem[] | null | undefined): string[] {
  return (menu ?? []).map((m) =>
    m === "separator"
      ? "-"
      : "submenu" in m
      ? `${m.submenu.label} ▸`
      : `${m.item.checked ? "✓ " : ""}${m.item.label}`
  );
}

/** One turn past the menu's debounce. */
const settle = () => new Promise((r) => setTimeout(r, 150));

/** DockMenu over a fake dock and a real registry, recording what it asked for. */
function setUp(opts: { agentChat?: boolean } = {}) {
  const reg = new WorkspaceRegistry();
  const fake = fakeDock();
  const calls: string[] = [];
  const pushed: [string, DockCommand][] = [];
  let next = 0;
  const menu = new DockMenu();
  menu.install({
    dock: fake.dock,
    registry: reg,
    showWorkspace: (id) => void calls.push(`show ${id}`),
    newWindow: () => {
      const id = `window-new-${++next}`;
      calls.push(`new ${id}`);
      return id;
    },
    commands: { push: (w, c) => void pushed.push([w, c]) },
    ...(opts.agentChat !== undefined
      ? { agentChat: () => Promise.resolve(opts.agentChat!) }
      : {}),
  });
  return { reg, fake, calls, pushed, menu };
}

Deno.test("DockMenu: set at install, follows the windows and the focus, cleared at uninstall", async () => {
  const { reg, fake, menu } = setUp({ agentChat: true });
  try {
    assertEquals(nativeLabels(fake.menus[0]), ["New Window", "New Terminal"]);
    await settle(); // the Claude Code probe answered
    assertEquals(nativeLabels(fake.menus.at(-1)), [
      "New Window",
      "New Terminal",
      "Claude Code (chat)",
    ]);
    reg.join("main", "a");
    reg.join("window-2", "b");
    await settle();
    assertEquals(nativeLabels(fake.menus.at(-1)).slice(0, 2), [
      "Workspace 1",
      "✓ Workspace 2",
    ]);
    // The focus moves without a registry change: the session's `focus` refreshes the menu.
    reg.focused("main");
    menu.refresh();
    await settle();
    assertEquals(nativeLabels(fake.menus.at(-1)).slice(0, 2), [
      "✓ Workspace 1",
      "Workspace 2",
    ]);
    // Nothing changed: nothing set again.
    const count = fake.menus.length;
    menu.refresh();
    await settle();
    assertEquals(fake.menus.length, count);
  } finally {
    menu.uninstall();
  }
  assertEquals(fake.menus.at(-1), null);
  assertEquals(fake.listeners.size, 0);
});

Deno.test("DockMenu: a window's line brings it forward; New Window opens one", () => {
  const { reg, fake, calls, menu } = setUp();
  try {
    reg.join("main", "a");
    fake.click("qutty:dock:window:a");
    fake.click(DOCK_NEW_WINDOW);
    fake.click("qutty:dock:reopen:z");
    fake.click("not-ours");
    assertEquals(calls, ["show a", "new window-new-1", "show z"]);
  } finally {
    menu.uninstall();
  }
});

Deno.test("DockMenu: New Terminal and the chat go to the frontmost window's page, brought forward", () => {
  const { reg, fake, calls, pushed, menu } = setUp();
  try {
    reg.join("main", "a");
    reg.join("window-2", "b");
    reg.focused("main");
    fake.click(DOCK_NEW_TERMINAL);
    fake.click(DOCK_AGENT_CHAT);
    assertEquals(calls, ["show a", "show a"]);
    assertEquals(pushed, [["main", "newTerminal"], ["main", "agentChat"]]);
  } finally {
    menu.uninstall();
  }
});

Deno.test("DockMenu: with no window, New Terminal opens one; the chat opens one and waits there", () => {
  const { reg, fake, calls, pushed, menu } = setUp();
  try {
    reg.join("main", "a");
    reg.addPty("a", "pty-1");
    reg.windowClosed("main"); // detached: no window open
    fake.click(DOCK_NEW_TERMINAL);
    fake.click(DOCK_AGENT_CHAT);
    assertEquals(calls, ["new window-new-1", "new window-new-2"]);
    assertEquals(pushed, [["window-new-2", "agentChat"]]);
  } finally {
    menu.uninstall();
  }
});

Deno.test("session: the Dock menu's commands signal their window one-shot; a closed window's go", async () => {
  const fake = fakeExtensionHost([{ id: "main", kind: "main" }, {
    id: "window-2",
    kind: "window",
  }]);
  const q = new DockCommandQueue();
  const off = relayDockCommands(fake.host, q);
  try {
    q.push("window-2", "newTerminal");
    assertEquals(fake.events.map((e) => [e.event, e.window, e.retain]), [
      ["dockCommand", "window-2", false],
    ]);
    q.push("main", "agentChat");
    await fake.close("main");
    assertEquals(q.take("main"), []);
    assertEquals(q.take("window-2"), ["newTerminal"]);
  } finally {
    off();
  }
});

Deno.test("session: a window taking the focus refreshes the Dock menu", () => {
  let refreshed = 0;
  windowFocused("main", { refresh: () => refreshed++ });
  assertEquals(refreshed, 1);
});

Deno.test("page: the Dock menu's commands run in order, none while a dialog is up", () => {
  const ran: string[] = [];
  const handlers = {
    newTerminal: () => void ran.push("terminal"),
    agentChat: () => void ran.push("chat"),
  };
  runDockCommands(["newTerminal", "agentChat"], handlers, false);
  assertEquals(ran, ["terminal", "chat"]);
  runDockCommands(["newTerminal"], handlers, true);
  assertEquals(ran, ["terminal", "chat"]);
});
