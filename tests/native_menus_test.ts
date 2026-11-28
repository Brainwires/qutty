// The native menu bar's model (lib/workspace/menus.ts), its backend half (desktop/menus.ts) and
// the self-test's rendering (desktop/menus-selftest.ts): pure, no window.

import { assert, assertEquals } from "@std/assert";
import type {
  AppMenuItem,
  DesktopMenuItemSpec,
  DesktopMenuUpdate,
} from "denext/desktop/app";
import {
  appMenu,
  barItemId,
  createShortcutGuard,
  customMenus,
  helpMenu,
  ITEM,
  itemAccelerator,
  keyAccelerator,
  launchItemId,
  type LaunchMenuInput,
  MENU_IDS,
  menuAction,
  menuActionAllowed,
  menuInput,
  menuItemStates,
  moveItemId,
  type NativeMenuInput,
  patternItemId,
  shellMenu,
  SHORTCUT_ECHO_MS,
  stateChanges,
  viewMenuSpec,
  windowMenuItems,
} from "../lib/workspace/menus.ts";
import {
  commandForKey,
  forwardAccelerators,
  type KeyLike,
  type KeyPlatform,
} from "../lib/workspace/keys.ts";
import { MDI_ITEM_IDS, tileItemId } from "../lib/workspace/mdi-menu.ts";
import {
  initialState,
  PATTERNS,
  reduce,
  type WorkspaceAction,
} from "../lib/workspace/store.ts";
import { CLOSE_AND_END_ITEM } from "../lib/workspace/windows.ts";
import { installNativeMenus } from "../desktop/menus.ts";
import { renderMenu } from "../desktop/menus-selftest.ts";
import { type Launchables, launchSections } from "../lib/launcher.ts";

const PLATFORMS: KeyPlatform[] = ["mac", "other"];

/** Every entry of a custom menu's items (all levels). */
function flat(items: readonly DesktopMenuItemSpec[]): DesktopMenuItemSpec[] {
  return items.flatMap((i) => [i, ...flat(i.items ?? [])]);
}

/** Every clickable entry of the page's `setAppMenu` menu (all levels). */
function flatApp(
  items: readonly AppMenuItem[],
): { id: string; label: string; accelerator?: string }[] {
  return items.flatMap((i) =>
    i === "separator" || "role" in i
      ? []
      : "submenu" in i
      ? flatApp(i.submenu)
      : [i]
  );
}

const SHELLS = [
  { path: "/bin/zsh", label: "zsh", isDefault: true },
  { path: "/bin/bash", label: "bash", isDefault: false },
];

const LAUNCH: LaunchMenuInput = {
  sections: launchSections({ shells: SHELLS, agents: [] }, [
    { alias: "web" },
    { alias: "bad\nalias" },
    { alias: "x".repeat(200) },
  ]),
  ollama: false,
  webPage: true,
};

/** A submenu's rows as labels: separators "-", a submenu `{ "Label ▸": [rows] }`. */
function tree(items: readonly DesktopMenuItemSpec[]): unknown[] {
  return items.map((i) =>
    i.type === "separator"
      ? "-"
      : i.items
      ? { [`${i.label} ▸`]: tree(i.items) }
      : i.label
  );
}

/** Every menu the bar has for `platform`, the Shell menu with launch entries. */
function allMenus(platform: KeyPlatform): DesktopMenuUpdate[] {
  return [shellMenu(platform, LAUNCH), viewMenuSpec(platform), helpMenu()];
}

const INPUT: NativeMenuInput = {
  view: "tiled",
  pattern: "cascade",
  barPosition: "top",
  focusedId: "b",
  maximizedId: null,
  broadcast: false,
  tiles: [
    { id: "a", title: "zsh — ~", focused: false, minimized: false },
    { id: "b", title: "claude — ~/x", focused: true, minimized: false },
    { id: "c", title: "htop", focused: false, minimized: true },
  ],
};

Deno.test("native menus: macOS's app menu has Settings… (⌘,) between About and Hide, and Edit has the standard roles", () => {
  const menu = appMenu("mac")!;
  assertEquals(
    menu.map((m) => typeof m === "object" && "label" in m && m.label),
    [
      "Qutty",
      "Edit",
    ],
  );
  const [qutty, edit] = menu as unknown as { submenu: AppMenuItem[] }[];
  const roles = (items: AppMenuItem[]) =>
    items.map((i) =>
      i === "separator" ? "-" : "role" in i ? i.role : "id" in i ? i.id : "?"
    );
  assertEquals(roles(qutty.submenu), [
    "about",
    "-",
    ITEM.settings,
    "-",
    "hide",
    "hideOthers",
    "unhide",
    "-",
    "quit",
  ]);
  assertEquals(flatApp(menu), [{
    id: ITEM.settings,
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
  }]);
  assertEquals(roles(edit.submenu), [
    "undo",
    "redo",
    "-",
    "cut",
    "copy",
    "paste",
    "selectAll",
  ]);
  // Linux / Windows: no page menu (a GTK accelerator would take Ctrl+C from the shell).
  assertEquals(appMenu("other"), null);
});

Deno.test("native menus: the Shell menu, macOS and elsewhere", () => {
  const ids = (m: DesktopMenuUpdate) =>
    m.items.map((i) => i.id ?? i.label ?? i.type);
  const mac = shellMenu("mac", LAUNCH);
  assertEquals(mac.label, "Shell");
  assertEquals(mac.after, "app");
  assertEquals(ids(mac), [
    ITEM.newTile,
    "New Tile With",
    ITEM.newWindow,
    "separator",
    ITEM.closeTile,
    CLOSE_AND_END_ITEM,
    "separator",
    ITEM.broadcast,
  ]);
  // With a web engine the same: History and Bookmark Manager are in New Tile With → Web Browser,
  // as in the `+` menu.
  assertEquals(
    ids(shellMenu("mac", { ...LAUNCH, webDialogs: true })),
    ids(mac),
  );
  const other = shellMenu("other", LAUNCH);
  assertEquals(ids(other).slice(-2), ["separator", ITEM.settings]);
  // ⌘, is the macOS standard only.
  assertEquals(other.items.at(-1), { id: ITEM.settings, label: "Settings…" });
  assertEquals(
    mac.items.find((i) => i.id === ITEM.broadcast)?.type,
    "checkbox",
  );
});

Deno.test("native menus: New Tile With has the + menu's submenus: Web Browser, Shell, SSH", () => {
  const sub = shellMenu("mac", { ...LAUNCH, webDialogs: true }).items[1]
    .items!;
  // Hosts whose id Denext would not take are left out.
  assertEquals(tree(sub), [
    { "Web Browser ▸": ["Open", "History", "Bookmark Manager"] },
    { "Shell ▸": ["zsh (default)", "bash"] },
    { "SSH ▸": ["Connections Manager", "-", "web"] },
  ]);
  assertEquals(sub[0].items!.map((i) => i.id), [
    ITEM.webPage,
    ITEM.history,
    ITEM.bookmarks,
  ]);
  assertEquals(sub[1].items![0].id, launchItemId("shell:/bin/zsh"));
  // Connections Manager keeps its id and ⌘⇧O.
  assertEquals(sub[2].items![0].id, ITEM.connections);
  assertEquals(sub[2].items![0].accelerator, "CmdOrCtrl+Shift+O");
  // Without a web engine: no Web Browser.
  assertEquals(
    tree(shellMenu("mac", { ...LAUNCH, webPage: false }).items[1].items!)
      .length,
    2,
  );
  // Before the page has its entries (the backend's menu at launch): SSH → Connections Manager.
  assertEquals(tree(shellMenu("mac").items[1].items!), [
    { "SSH ▸": ["Connections Manager"] },
  ]);
  // Ollama installed: Coding → "Ollama models…", even with no pair to list; with agent tiles,
  // Ollama's chat above it.
  const ollama = (agentChat: boolean) =>
    tree(
      shellMenu("mac", {
        sections: [],
        ollama: true,
        webPage: false,
        agentChat,
      })
        .items[1].items!,
    );
  assertEquals(ollama(false), [
    { "SSH ▸": ["Connections Manager"] },
    { "Coding ▸": ["Ollama models…"] },
  ]);
  assertEquals(ollama(true), [
    { "SSH ▸": ["Connections Manager"] },
    { "Coding ▸": ["Ollama", "-", "Ollama models…"] },
  ]);
});

Deno.test("native menus: the View menu has the view radios, the Layout and Switcher Bar radio groups, the tile controls and font sizes", () => {
  const view = viewMenuSpec("mac");
  assertEquals(view.label, "View");
  assertEquals(view.after, "edit");
  const all = flat(view.items);
  const group = (g: string) =>
    all.filter((i) => i.type === "radio" && i.group === g).map((i) => i.id);
  assertEquals(group("qutty:view:mode"), [
    MDI_ITEM_IDS.viewTiled,
    MDI_ITEM_IDS.viewFreeform,
  ]);
  assertEquals(group("qutty:layout"), PATTERNS.map(patternItemId));
  assertEquals(group("qutty:bar"), [
    barItemId("top"),
    barItemId("bottom"),
    barItemId("left"),
    barItemId("right"),
  ]);
  for (
    const id of [
      ITEM.minimizeTile,
      ITEM.maximizeTile,
      ITEM.restoreTile,
      ITEM.zoomIn,
      ITEM.zoomOut,
      ITEM.zoomTogether,
      ITEM.actualSize,
      MDI_ITEM_IDS.cascade,
    ]
  ) assert(all.some((i) => i.id === id), id);
  assertEquals(
    all.filter((i) => i.role).map((i) => i.role),
    ["toggleFullScreen"],
  );
  // Roles are macOS's: Linux's menus draw them as plain items.
  assertEquals(flat(viewMenuSpec("other").items).filter((i) => i.role), []);
  assertEquals(helpMenu().items, [{ id: ITEM.repo, label: "Qutty on GitHub" }]);
});

Deno.test("native menus: item ids are unique, plain and short enough for Denext", () => {
  for (const platform of PLATFORMS) {
    const ids = allMenus(platform).flatMap((m) =>
      flat(m.items).filter((i) => i.id !== undefined).map((i) => i.id!)
    );
    assertEquals(new Set(ids).size, ids.length, platform);
    for (const id of ids) {
      assert(id.length <= 128 && ![...id].some((c) => c < " "), id);
    }
    assertEquals(
      customMenus(platform).map((m) => m.id),
      [MENU_IDS.shell, MENU_IDS.view, MENU_IDS.help],
    );
  }
});

/** The `KeyboardEvent.code` of an accelerator's key. */
const CODES: Record<string, string> = {
  "=": "Equal",
  "-": "Minus",
  "[": "BracketLeft",
  "]": "BracketRight",
  "`": "Backquote",
  Enter: "Enter",
};

/** The keydown an accelerator stands for on `platform`. */
function keyOf(accelerator: string, platform: KeyPlatform): KeyLike {
  const parts = accelerator.split("+");
  const key = parts.at(-1)!;
  const code = CODES[key] ??
    (/^\d$/.test(key) ? `Digit${key}` : `Key${key}`);
  return {
    key: "",
    code,
    altKey: false,
    shiftKey: parts.includes("Shift"),
    metaKey: platform === "mac",
    ctrlKey: platform !== "mac",
  };
}

Deno.test("native menus: every shortcut is one the workspace already has (or ⌘N / macOS's ⌘,)", () => {
  for (const platform of PLATFORMS) {
    const taken = new Set(
      forwardAccelerators({ pttKey: "off", dictateKey: "off" }, platform),
    );
    const accelerators = [
      ...allMenus(platform).flatMap((m) =>
        flat(m.items).flatMap((i) => i.accelerator ? [i.accelerator] : [])
      ),
      ...flatApp(appMenu(platform) ?? []).flatMap((i) =>
        i.accelerator ? [i.accelerator] : []
      ),
      ...windowMenuItems({
        ...INPUT,
        tiles: Array.from({ length: 12 }, (_, i) => ({
          id: `t${i}`,
          title: `t${i}`,
          focused: i === 0,
          minimized: false,
        })),
      }).flatMap((i) => i.accelerator ? [i.accelerator] : []),
    ];
    for (const a of accelerators) {
      if (a === "CmdOrCtrl+N" || (a === "CmdOrCtrl+," && platform === "mac")) {
        continue;
      }
      assert(taken.has(a), `${platform}: ${a} is not a workspace shortcut`);
      // The item does what the key does.
      const cmd = commandForKey(keyOf(a, platform), platform)!;
      assertEquals(keyAccelerator(cmd), a, `${platform}: ${a}`);
    }
    assert(accelerators.includes("CmdOrCtrl+9"));
    assert(!accelerators.includes("CmdOrCtrl+10"));
  }
});

Deno.test("native menus: a shortcut item's click is the key's command", () => {
  const items = flat(viewMenuSpec("mac").items).concat(
    shellMenu("mac", LAUNCH).items,
  );
  for (const i of items) {
    const action = i.id ? menuAction(i.id) : null;
    if (action?.kind !== "key") continue;
    assertEquals(keyAccelerator(action.command), i.accelerator, i.id);
  }
  for (const i of windowMenuItems(INPUT)) {
    const action = i.id ? menuAction(i.id) : null;
    if (action?.kind === "key") {
      assertEquals(keyAccelerator(action.command), i.accelerator, i.id);
    }
  }
});

Deno.test("native menus: clicks map to what the page does", () => {
  assertEquals(menuAction(ITEM.newTile), {
    kind: "key",
    command: { kind: "newTerminal" },
  });
  assertEquals(menuAction(ITEM.closeTile), {
    kind: "key",
    command: { kind: "closeFocused" },
  });
  assertEquals(menuAction(ITEM.maximizeTile), {
    kind: "key",
    command: { kind: "toggleMonocle" },
  });
  assertEquals(menuAction(ITEM.previousTile), {
    kind: "key",
    command: { kind: "cycle", dir: -1 },
  });
  assertEquals(menuAction(ITEM.settings), { kind: "settings" });
  assertEquals(menuAction(MDI_ITEM_IDS.viewFreeform), {
    kind: "view",
    id: MDI_ITEM_IDS.viewFreeform,
  });
  assertEquals(menuAction(MDI_ITEM_IDS.cascade), {
    kind: "view",
    id: MDI_ITEM_IDS.cascade,
  });
  assertEquals(menuAction(tileItemId("t7")), {
    kind: "view",
    id: tileItemId("t7"),
  });
  assertEquals(menuAction(patternItemId("grid")), {
    kind: "pattern",
    pattern: "grid",
  });
  assertEquals(menuAction(barItemId("left")), {
    kind: "barPosition",
    position: "left",
  });
  assertEquals(menuAction(ITEM.restoreTile), {
    kind: "tile",
    control: "restoreTile",
  });
  assertEquals(menuAction(ITEM.minimizeTile), {
    kind: "tile",
    control: "minimize",
  });
  assertEquals(menuAction(launchItemId("ssh:web")), {
    kind: "launch",
    entryId: "ssh:web",
  });
  assertEquals(menuAction(ITEM.webPage), { kind: "webPage" });
  assertEquals(menuAction(ITEM.bookmarks), {
    kind: "webDialog",
    dialog: "bookmarks",
  });
  assertEquals(menuAction(ITEM.history), {
    kind: "webDialog",
    dialog: "history",
  });
  assertEquals(menuAction(ITEM.ollama), { kind: "ollama" });
  // The backend's items, a heading, junk: not the page's.
  for (
    const id of [
      ITEM.newWindow,
      CLOSE_AND_END_ITEM,
      ITEM.repo,
      "qutty:launch-heading:shells",
      patternItemId("nope" as never),
      barItemId("middle" as never),
      "qutty:launch:",
      "qutty:launch-agent-chat:nope",
      "qutty:launch-agent-chat:claude",
      "qutty:launch-agent-preset:claude",
      "qutty:launch-agent-preset:claude:",
      "qutty:launch-agent-preset:nope:p1",
      tileItemId(""),
      "nope",
    ]
  ) assertEquals(menuAction(id), null, id);
});

Deno.test("native menus: a modal dialog lets only Connections… through, as the keys do", () => {
  const connections = menuAction(ITEM.connections)!;
  const newTile = menuAction(ITEM.newTile)!;
  assert(menuActionAllowed(connections, true));
  assert(!menuActionAllowed(newTile, true));
  assert(!menuActionAllowed({ kind: "settings" }, true));
  assert(menuActionAllowed(newTile, false));
});

Deno.test("native menus: state follows the workspace (checks, Restore only when maximized)", () => {
  const s = menuItemStates(INPUT);
  assertEquals(s[MDI_ITEM_IDS.viewTiled], { checked: true });
  assertEquals(s[MDI_ITEM_IDS.viewFreeform], { checked: false });
  assertEquals(s[patternItemId("cascade")], { checked: true, enabled: true });
  assertEquals(s[patternItemId("grid")], { checked: false, enabled: true });
  assertEquals(s[barItemId("top")], { checked: true });
  assertEquals(s[ITEM.restoreTile], { enabled: false });
  assertEquals(s[ITEM.maximizeTile], { checked: false, enabled: true });
  assertEquals(s[ITEM.zoomIn], { enabled: true });
  assertEquals(s[ITEM.actualSize], { enabled: true });
  assertEquals(s[ITEM.zoomTogether], { checked: false });
  assertEquals(s[ITEM.closeTile], { enabled: true });
  assertEquals(s[ITEM.broadcast], { checked: false });
  assertEquals(s[MDI_ITEM_IDS.cascade], { enabled: false });
  assertEquals(s[ITEM.nextLayout], { enabled: true });

  const max = menuItemStates({ ...INPUT, maximizedId: "b" });
  assertEquals(max[ITEM.restoreTile], { enabled: true });
  assertEquals(max[ITEM.maximizeTile], { checked: true, enabled: true });

  const free = menuItemStates({ ...INPUT, view: "freeform", broadcast: true });
  assertEquals(free[MDI_ITEM_IDS.viewFreeform], { checked: true });
  assertEquals(free[MDI_ITEM_IDS.cascade], { enabled: true });
  assertEquals(free[patternItemId("cascade")], {
    checked: true,
    enabled: false,
  });
  assertEquals(free[ITEM.nextLayout], { enabled: false });
  assertEquals(free[ITEM.broadcast], { checked: true });

  const empty = menuItemStates({ ...INPUT, focusedId: null, tiles: [] });
  for (
    const id of [
      ITEM.closeTile,
      ITEM.minimizeTile,
      ITEM.zoomIn,
      ITEM.zoomOut,
      ITEM.actualSize,
    ]
  ) {
    assertEquals(empty[id], { enabled: false }, id);
  }
  assertEquals(empty[ITEM.maximizeTile], { checked: false, enabled: false });
  assertEquals(
    menuItemStates({ ...INPUT, zoomTogether: true })[ITEM.zoomTogether],
    { checked: true },
  );
});

Deno.test("native menus: only changed states are pushed", () => {
  const first = menuItemStates(INPUT);
  const pushed = new Map(stateChanges(new Map(), first));
  assertEquals(pushed.size, Object.keys(first).length);
  assertEquals(stateChanges(pushed, first), []);
  const next = menuItemStates({ ...INPUT, pattern: "grid" });
  assertEquals(
    stateChanges(pushed, next).map(([id]) => id).sort(),
    [
      patternItemId("cascade"),
      patternItemId("grid"),
    ].sort(),
  );
});

Deno.test("native menus: the Window menu lists the window's tiles in bar order, the focused one checked", () => {
  const items = windowMenuItems(INPUT);
  assertEquals(items.slice(0, 3), [
    {
      id: tileItemId("a"),
      label: "zsh — ~",
      checked: false,
      accelerator: "CmdOrCtrl+1",
    },
    {
      id: tileItemId("b"),
      label: "claude — ~/x",
      checked: true,
      accelerator: "CmdOrCtrl+2",
    },
    {
      id: tileItemId("c"),
      label: "htop (minimized)",
      checked: false,
      accelerator: "CmdOrCtrl+3",
    },
  ]);
  assertEquals(items.slice(3).map((i) => i.id ?? i.type), [
    "separator",
    ITEM.nextTile,
    ITEM.previousTile,
    ITEM.lastTile,
  ]);
  assert(items.slice(4).every((i) => i.enabled === true));
  // One tile shown: nothing to switch to.
  const one = windowMenuItems({ ...INPUT, tiles: INPUT.tiles.slice(1) });
  assert(one.slice(-3).every((i) => i.enabled === false));
  assertEquals(windowMenuItems({ ...INPUT, tiles: [] }), []);
  assertEquals(itemAccelerator(tileItemId("b"), items), "CmdOrCtrl+2");
  assertEquals(itemAccelerator(ITEM.nextTile), "CmdOrCtrl+]");
  assertEquals(itemAccelerator(MDI_ITEM_IDS.cascade), undefined);
});

Deno.test("native menus: the input comes from the workspace's state", () => {
  const acts: WorkspaceAction[] = [
    { type: "add", id: "a", now: 1, title: "one" },
    { type: "add", id: "b", now: 2, title: "two" },
    { type: "maximize", id: "a", now: 3 },
    { type: "setBarPosition", position: "left" },
    // A program's own (animated) title is not the menu's.
    { type: "setTileTitle", tileTitle: "program" },
    { type: "programTitle", id: "a", title: "⠋ thinking" },
  ];
  const state = acts.reduce(reduce, initialState());
  const input = menuInput(state, true);
  assertEquals(input.view, "tiled");
  assertEquals(input.pattern, "monocle");
  assertEquals(input.barPosition, "left");
  assertEquals(input.focusedId, "a");
  assertEquals(input.maximizedId, "a");
  assertEquals(input.broadcast, true);
  assertEquals(
    input.tiles.map((t) => [t.id, t.title, t.focused]),
    // The bar's order (most recent first by default).
    [["a", "one", true], ["b", "two", false]],
  );
});

Deno.test("native menus: Find in Page… and Developer Tools act on the focused web tile, with no shortcut", () => {
  const all = flat(viewMenuSpec("mac").items);
  for (const id of [ITEM.findInPage, ITEM.devTools]) {
    const i = all.find((x) => x.id === id);
    assert(i, id);
    assertEquals(i.accelerator, undefined, "the page's keys, not the menu's");
  }
  assertEquals(menuAction(ITEM.findInPage), {
    kind: "web",
    command: { kind: "find" },
  });
  assertEquals(menuAction(ITEM.devTools), {
    kind: "web",
    command: { kind: "devTools" },
  });
  // Enabled only while a web tile has the focus.
  const off = menuItemStates(INPUT);
  assertEquals(off[ITEM.findInPage], { enabled: false });
  assertEquals(off[ITEM.devTools], { enabled: false });
  const on = menuItemStates({ ...INPUT, webFocused: true });
  assertEquals(on[ITEM.findInPage], { enabled: true });
  const state = [
    { type: "add", id: "a", now: 1, title: "one" },
    { type: "add", id: "w", now: 2, web: { url: "https://example.com/" } },
  ].reduce((s, a) => reduce(s, a as WorkspaceAction), initialState());
  assertEquals(menuInput(state, false).webFocused, true);
  const back = reduce(state, { type: "focus", id: "a", now: 3 });
  assertEquals(menuInput(back, false).webFocused, false);
});

Deno.test("native menus: a menu click right after the same key the page ran is dropped once", () => {
  let now = 1000;
  const guard = createShortcutGuard(() => now);
  assert(guard.allows("CmdOrCtrl+T"), "no key pressed: a click runs");
  guard.pressed("CmdOrCtrl+T");
  assert(guard.allows("CmdOrCtrl+W"), "another item runs");
  assert(!guard.allows("CmdOrCtrl+T"), "the echo of the key is dropped");
  assert(guard.allows("CmdOrCtrl+T"), "only once");
  guard.pressed("CmdOrCtrl+T");
  now += SHORTCUT_ECHO_MS + 1;
  assert(guard.allows("CmdOrCtrl+T"), "a later click runs");
  guard.pressed("CmdOrCtrl+T");
  assert(guard.allows(undefined), "an item without a shortcut runs");
});

Deno.test("native menus: the backend sets the Shell, View and Help menus and opens New Window", () => {
  const set: [string, DesktopMenuUpdate | null][] = [];
  const opened: unknown[] = [];
  let handler: ((id: string) => void) | undefined;
  const off = installNativeMenus({
    setMenu: (id, menu) => void set.push([id, menu]),
    onAppMenuItem: (fn) => {
      handler = (id) =>
        void fn(id, { source: "menu", keyWindow: null, menu: "qutty:shell" });
      return () => handler = undefined;
    },
    windows: { open: (o) => void opened.push(o) },
  }, "linux");
  assertEquals(set.map(([id]) => id), [
    MENU_IDS.shell,
    MENU_IDS.view,
    MENU_IDS.help,
  ]);
  assertEquals(set[0][1], shellMenu("other"));
  handler!(ITEM.newTile);
  assertEquals(opened, [], "not the backend's");
  handler!(ITEM.newWindow);
  assertEquals(opened.length, 1);
  const o = opened[0] as { url: string; key: string; width?: number };
  assertEquals(o.url, "/");
  assert(o.key.startsWith("ws-") && o.width !== undefined, "a fresh workspace");
  off();
  assertEquals(handler, undefined);
});

Deno.test("native menus: a runtime without app menus leaves Denext's bar (no handler)", () => {
  let subscribed = false;
  const warn = console.warn;
  console.warn = () => {};
  try {
    installNativeMenus({
      setMenu: () => {
        throw new Error("unsupported");
      },
      onAppMenuItem: () => {
        subscribed = true;
        return () => {};
      },
      windows: { open: () => {} },
    }, "darwin");
  } finally {
    console.warn = warn;
  }
  assert(!subscribed);
});

Deno.test("native menus: the self-test renders the bar the runtime got", () => {
  assertEquals(
    renderMenu([
      {
        submenu: {
          label: "Qutty",
          items: [{ role: { role: "about" } }, "separator"],
        },
      },
      {
        submenu: {
          label: "View",
          items: [{
            item: {
              id: "denext:menu:qutty:view:tiled",
              label: "Tiled View",
              checked: true,
            },
          }, {
            item: {
              id: "denext:menu:qutty:tile:restore",
              label: "Restore Tile",
              enabled: false,
            },
          }],
        },
      },
      {
        item: {
          id: "denext:window:app:main:qutty:tiles:next",
          label: "Next Tile",
          accelerator: "CmdOrCtrl+]",
        },
      },
    ]),
    [
      "Qutty >",
      "  <about>",
      "  ----",
      "View >",
      "  [x] Tiled View  {qutty:view:tiled}",
      "  Restore Tile  (disabled)  {qutty:tile:restore}",
      "Next Tile  CmdOrCtrl+]  {qutty:tiles:next}",
    ],
  );
});

Deno.test("native menus: the Window menu's Move Tile to items, and their clicks", () => {
  const moves = {
    targets: [{ window: "w2", name: "Work" }, { window: "w3", name: "Ops" }],
    newWindow: true,
  };
  const items = windowMenuItems(INPUT, moves);
  const tail = items.slice(items.findLastIndex((i) => i.type === "separator"));
  assertEquals(tail, [
    { type: "separator" },
    { id: moveItemId("w2"), label: "Move Tile to Work" },
    { id: moveItemId("w3"), label: "Move Tile to Ops" },
    { id: moveItemId("new"), label: "Move Tile to New Window" },
  ]);
  assertEquals(menuAction(moveItemId("w2")), { kind: "moveTile", to: "w2" });
  assertEquals(menuAction(moveItemId("new")), { kind: "moveTile", to: "new" });
  assertEquals(menuAction(moveItemId("")), null);
  // Without moves (the browser), no focused tile, or nowhere to go: none.
  assertEquals(windowMenuItems(INPUT), windowMenuItems(INPUT, undefined));
  assert(!windowMenuItems(INPUT).some((i) => i.id?.startsWith(moveItemId(""))));
  assert(
    !windowMenuItems({ ...INPUT, focusedId: null }, moves).some((i) =>
      i.id?.startsWith(moveItemId(""))
    ),
  );
  assertEquals(
    windowMenuItems(INPUT, { targets: [], newWindow: false }),
    windowMenuItems(INPUT),
  );
  // A window's only tile does not tear off into a new window.
  const one = windowMenuItems(
    { ...INPUT, tiles: [INPUT.tiles[1]] },
    { targets: [], newWindow: true },
  );
  assert(!one.some((i) => i.id === moveItemId("new")));
});

const AGENTS: Launchables = {
  shells: [],
  agents: [
    { name: "claude", label: "Claude Code", path: "/u/bin/claude" },
    { name: "codex", label: "Codex", path: "/u/bin/codex" },
  ],
};

Deno.test("native menus: Terminal has the agent tools, Coding their chat tiles, as in the + menu", () => {
  const sub = shellMenu("mac", {
    sections: launchSections(AGENTS, []),
    ollama: true,
    webPage: false,
    agentChat: true,
    anthropic: true,
    presets: [{ id: "p1", name: "Reviewer" }, {
      id: "p2",
      name: "Local",
      agent: "ollama",
    }],
  }).items[1].items!;
  assertEquals(tree(sub), [
    { "SSH ▸": ["Connections Manager"] },
    { "Terminal ▸": ["Claude Code", "Codex"] },
    {
      "Coding ▸": [
        "Claude Code",
        "Reviewer",
        "Codex",
        "Ollama",
        "Local",
        "Anthropic API",
        "-",
        "Ollama models…",
      ],
    },
  ]);
  assertEquals(sub[1].items!.map((i) => i.id), [
    launchItemId("agent:claude"),
    launchItemId("agent:codex"),
  ]);
  const coding = sub[2].items!.map((i) => i.id ?? "-");
  assertEquals(coding, [
    ITEM.agentChat,
    "qutty:launch-agent-preset:claude:p1",
    ITEM.agentChatCodex,
    "qutty:launch-agent-chat:ollama",
    "qutty:launch-agent-preset:ollama:p2",
    "qutty:launch-agent-chat:anthropic",
    "-",
    ITEM.ollama,
  ]);
  assertEquals(coding.map((id) => menuAction(id)), [
    { kind: "agentChat" },
    { kind: "agentChat", presetId: "p1" },
    { kind: "agentChat", agent: "codex" },
    { kind: "agentChat", agent: "ollama" },
    { kind: "agentChat", agent: "ollama", presetId: "p2" },
    { kind: "agentChat", agent: "anthropic" },
    null,
    { kind: "ollama" },
  ]);
  // Without agent tiles: no Coding chats (the tools still run in a terminal).
  assertEquals(
    tree(
      shellMenu("mac", {
        sections: launchSections(AGENTS, []),
        ollama: false,
        webPage: false,
      }).items[1].items!,
    ),
    [
      { "SSH ▸": ["Connections Manager"] },
      { "Terminal ▸": ["Claude Code", "Codex"] },
    ],
  );
});

Deno.test("native menus: Source Control in the View menu and New Tile With, with Worktrees…", () => {
  const view = flat(viewMenuSpec("mac").items);
  assert(view.some((i) => i.id === ITEM.sourceControl));
  const sub = shellMenu("mac", {
    sections: [],
    ollama: false,
    webPage: false,
    sourceControl: true,
  }).items[1].items!;
  assertEquals(tree(sub), [
    { "SSH ▸": ["Connections Manager"] },
    "-",
    "Source Control",
    "Worktrees…",
  ]);
  assertEquals(menuAction(ITEM.sourceControl), { kind: "sourceControl" });
  assertEquals(menuAction(ITEM.launchSourceControl), { kind: "sourceControl" });
  assertEquals(menuAction(ITEM.worktrees), {
    kind: "sourceControl",
    show: "worktrees",
  });
  assert(!menuActionAllowed({ kind: "sourceControl" }, true));
});
