// The macOS Dock menu (desktop/dock-menu.ts) without a window: the menu built from a workspace
// list, the item ids back to actions, Denext's `setDockMenu` shape, the command queue, DockMenu
// over a fake `setDockMenu` / `onDockMenuItem` host and a real workspace registry, the `session` extension's relay of the
// commands to a window's page (tests/session_helpers.ts), and the page's dispatch
// (app/use-dock-commands.ts).
//
// Run: deno test -A tests/

import { assertEquals } from "@std/assert";
import type {
  DesktopDockMenuItem,
  DesktopDockMenuItemHandler,
} from "denext/desktop";
import {
  commandTarget,
  DOCK_AGENT_CHAT,
  DOCK_CLAUDE_TERMINAL,
  DOCK_CODEX_CHAT,
  DOCK_CODEX_TERMINAL,
  DOCK_COMMAND_TTL_MS,
  DOCK_MAX_REOPEN,
  DOCK_NEW_TERMINAL,
  DOCK_NEW_WINDOW,
  type DockCommand,
  DockCommandQueue,
  DockMenu,
  dockMenu,
  dockMenuAction,
  type DockMenuEntry,
  type DockMenuHost,
  nativeDockMenu,
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
    codexChat: true,
  });
  assertEquals(labels(menu), [
    "Workspace 2",
    "✓ Workspace 10",
    "-",
    "New Window",
    "New Terminal",
    { "Terminal ▸": ["Claude Code", "Codex"] },
    { "Coding ▸": ["Claude Code", "Codex"] },
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
  const children = (i: number) =>
    (menu[i] as { children: { id: string }[] }).children.map((c) => c.id);
  assertEquals(children(5), [DOCK_CLAUDE_TERMINAL, DOCK_CODEX_TERMINAL]);
  assertEquals(children(6), [DOCK_AGENT_CHAT, DOCK_CODEX_CHAT]);
  const reopen = menu[8] as { children: { id: string }[] };
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

Deno.test("dock menu: Codex without Claude Code", () => {
  assertEquals(
    labels(dockMenu({ workspaces: [], agentChat: false, codexChat: true })),
    ["New Window", "New Terminal", { "Terminal ▸": ["Codex"] }, {
      "Coding ▸": ["Codex"],
    }],
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
  assertEquals(dockMenuAction(DOCK_CODEX_CHAT), {
    kind: "command",
    command: "codexChat",
  });
  assertEquals(dockMenuAction(DOCK_CLAUDE_TERMINAL), {
    kind: "command",
    command: "claudeTerminal",
  });
  assertEquals(dockMenuAction(DOCK_CODEX_TERMINAL), {
    kind: "command",
    command: "codexTerminal",
  });
  assertEquals(dockMenuAction("qutty:dock:window:"), undefined);
  assertEquals(dockMenuAction("qutty:dock:reopen:"), undefined);
  assertEquals(dockMenuAction("qutty:tray:new-window"), undefined);
});

Deno.test("dock menu: Denext's shape (setDockMenu's DesktopDockMenuItem)", () => {
  assertEquals(
    nativeDockMenu([
      { id: "a", label: "A", checked: true },
      "separator",
      { label: "Sub", children: [{ id: "b", label: "B" }] },
    ]),
    [
      { id: "a", label: "A", checked: true },
      { type: "separator" },
      { label: "Sub", submenu: [{ id: "b", label: "B" }] },
    ],
  );
});

Deno.test("dock menu: Reopen Closed Window in windows.closed() order, then the rest by detach time", () => {
  const menu = dockMenu({
    workspaces: [
      ws("3", "detached", 2, 100),
      ws("5", "detached", 1, 200),
      ws("6", "detached", 1, 300),
      ws("7", "detached", 0, 400), // nothing running: not offered even when listed
    ],
    agentChat: false,
    // Most recent first, as Denext keeps them; "gone" is no workspace, "7" runs nothing.
    closed: [{ key: "7" }, { key: "3" }, { key: "gone" }, { key: "5" }],
  });
  assertEquals(labels(menu).at(-1), {
    "Reopen Closed Window ▸": [
      "Workspace 3 — 2 terminals",
      "Workspace 5 — 1 terminal",
      "Workspace 6 — 1 terminal",
    ],
  });
});

Deno.test("dock menu: a command goes to Denext's key window when it shows a workspace", () => {
  const reg = new WorkspaceRegistry();
  reg.join("main", "a");
  reg.join("window-2", "b");
  reg.focused("main");
  assertEquals(commandTarget(reg, { id: "window-2", key: "b" }), {
    window: "window-2",
    workspace: "b",
  });
  // The floating companion's window (no workspace): the workspace window focused last.
  assertEquals(commandTarget(reg, { id: "companion" }), {
    window: "main",
    workspace: "a",
  });
  assertEquals(commandTarget(reg, null), { window: "main", workspace: "a" });
  reg.windowClosed("main");
  reg.windowClosed("window-2");
  assertEquals(commandTarget(reg, null), {});
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

/**
 * A fake of `runDesktop`'s Dock menu calls: the menus `setDockMenu` was given, and a click on one
 * of its items with the key window, as Denext hands it to each `onDockMenuItem` handler.
 */
function fakeDock() {
  const menus: (readonly DesktopDockMenuItem[] | null)[] = [];
  const listeners = new Set<DesktopDockMenuItemHandler>();
  const dock: DockMenuHost = {
    setDockMenu: (m) => void menus.push(m),
    onDockMenuItem: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
  return {
    dock,
    menus,
    listeners,
    click: (
      id: string,
      keyWindow: { id: string; key?: string } | null = null,
    ) => {
      for (const fn of [...listeners]) fn(id, { keyWindow });
    },
  };
}

/** The labels of a menu in Denext's shape. */
function nativeLabels(
  menu: readonly DesktopDockMenuItem[] | null | undefined,
): string[] {
  return (menu ?? []).map((m) =>
    "type" in m
      ? "-"
      : "submenu" in m
      ? `${m.label} ▸`
      : `${m.checked ? "✓ " : ""}${m.label}`
  );
}

/** One turn past the menu's debounce. */
const settle = () => new Promise((r) => setTimeout(r, 150));

/** DockMenu over a fake dock and a real registry, recording what it asked for. */
function setUp(
  opts: {
    agentChat?: boolean;
    codexChat?: boolean;
    closed?: { key: string }[];
  } = {},
) {
  const reg = new WorkspaceRegistry();
  const fake = fakeDock();
  const calls: string[] = [];
  const pushed: [string, DockCommand][] = [];
  let next = 0;
  const menu = new DockMenu();
  menu.install({
    dock: fake.dock,
    ...(opts.closed ? { windows: { closed: () => opts.closed! } } : {}),
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
    ...(opts.codexChat !== undefined
      ? { codexChat: () => Promise.resolve(opts.codexChat!) }
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
      "Terminal ▸",
      "Coding ▸",
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

Deno.test("DockMenu: Terminal → Codex and Coding → Codex once the Codex probe finds it", async () => {
  const { fake, menu } = setUp({ agentChat: false, codexChat: true });
  try {
    assertEquals(nativeLabels(fake.menus[0]), ["New Window", "New Terminal"]);
    await settle(); // the probes answered
    const last = fake.menus.at(-1)!;
    assertEquals(nativeLabels(last), [
      "New Window",
      "New Terminal",
      "Terminal ▸",
      "Coding ▸",
    ]);
    const sub = (i: number) =>
      (last[i] as { submenu: readonly DesktopDockMenuItem[] }).submenu;
    assertEquals(nativeLabels(sub(2)), ["Codex"]);
    assertEquals(nativeLabels(sub(3)), ["Codex"]);
  } finally {
    menu.uninstall();
  }
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
    fake.click(DOCK_CODEX_CHAT);
    fake.click(DOCK_CLAUDE_TERMINAL);
    fake.click(DOCK_CODEX_TERMINAL);
    assertEquals(calls, ["show a", "show a", "show a", "show a", "show a"]);
    assertEquals(pushed, [
      ["main", "newTerminal"],
      ["main", "agentChat"],
      ["main", "codexChat"],
      ["main", "claudeTerminal"],
      ["main", "codexTerminal"],
    ]);
  } finally {
    menu.uninstall();
  }
});

Deno.test("DockMenu: a command goes to the key window Denext names with the click", () => {
  const { reg, fake, calls, pushed, menu } = setUp();
  try {
    reg.join("main", "a");
    reg.join("window-2", "b");
    reg.focused("main");
    fake.click(DOCK_NEW_TERMINAL, { id: "window-2", key: "b" });
    assertEquals(calls, ["show b"]);
    assertEquals(pushed, [["window-2", "newTerminal"]]);
  } finally {
    menu.uninstall();
  }
});

Deno.test("DockMenu: Reopen Closed Window follows windows.closed()", async () => {
  const { reg, fake, menu } = setUp({ closed: [{ key: "b" }, { key: "a" }] });
  try {
    reg.join("main", "a");
    reg.addPty("a", "pty-1");
    reg.join("window-2", "b");
    reg.addPty("b", "pty-2");
    reg.windowClosed("window-2");
    reg.windowClosed("main"); // detached last, but Denext lists "b" first
    menu.refresh();
    await settle();
    const reopen = fake.menus.at(-1)!.at(-1) as {
      readonly submenu: readonly { readonly id: string }[];
    };
    assertEquals(reopen.submenu.map((i) => i.id), [
      "qutty:dock:reopen:b",
      "qutty:dock:reopen:a",
    ]);
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
    codexChat: () => void ran.push("codex"),
    agentTerminal: (name: string) => void ran.push(`terminal ${name}`),
  };
  runDockCommands(
    [
      "newTerminal",
      "agentChat",
      "codexChat",
      "claudeTerminal",
      "codexTerminal",
    ],
    handlers,
    false,
  );
  const all = [
    "terminal",
    "chat",
    "codex",
    "terminal claude",
    "terminal codex",
  ];
  assertEquals(ran, all);
  runDockCommands(["newTerminal"], handlers, true);
  assertEquals(ran, all);
});
