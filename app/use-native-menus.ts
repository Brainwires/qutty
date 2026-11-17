// The native menu bar, the page's half (Denext 4.18's app menus; the model is
// lib/workspace/menus.ts, the backend's half desktop/menus.ts). Where the runtime draws native
// menus ({@linkcode nativeMenusAvailable}: the one capability check; never in the web build, which
// keeps the in-app menus), the page:
//
// - sets the macOS app menu and Edit (`setAppMenu`: Settings… lives there);
// - keeps its window's state on the menus as the workspace changes (`setMenuItemState` with this
//   window's id: radio checks, enabled items), pushing only what changed, never polling;
// - lists its tiles in the Window menu (`setWindowMenuAppItems`), the focused one checked;
// - keeps the Shell menu's "New Tile With" submenu (the `+` menu's entries, app-wide) current, and
//   puts its own list there again when its window takes the focus;
// - acts on the clicks meant for it: a custom item with this window key, or this window's own
//   Window-menu item. Denext queues each click for the live pages only, so a reload never replays
//   one. A click that follows the same key the page's keydown handler just ran is dropped
//   (`createShortcutGuard`), so a shortcut never runs twice.
//
// Denext keeps each window's state and shows it while that window is key, so a window that
// becomes key shows its own checks without a call.

import { useEffect, useMemo, useRef, useState } from "denext";
import {
  appCapabilities,
  type DesktopMenuItemState,
  type DesktopWindowMenuAppItem,
  onAppMenuItem,
  setAppMenu,
  setMenu,
  setMenuItemState,
  setWindowMenuAppItems,
} from "denext/desktop/app";
import { currentWindowId, onWindowFocus } from "denext/desktop/window";
import { isDesktop } from "../lib/pty-client.ts";
import {
  commandForKey,
  type KeyCommand,
  type KeyPlatform,
} from "../lib/workspace/keys.ts";
import {
  appMenu,
  createShortcutGuard,
  itemAccelerator,
  keyAccelerator,
  MENU_IDS,
  menuAction,
  menuActionAllowed,
  menuInput,
  menuItemStates,
  shellMenu,
  stateChanges,
  windowMenuItems,
} from "../lib/workspace/menus.ts";
import {
  type BarPosition,
  maximizedId,
  type WorkspaceState,
} from "../lib/workspace/store.ts";
import type { TileControl } from "../lib/workspace/tile-controls.ts";
import type { LayoutPattern } from "../lib/layout/mod.ts";
import {
  flatEntries,
  type LaunchEntry,
  type LaunchSection,
} from "../lib/launcher.ts";

/**
 * Whether this page drives native menus: the desktop app on a runtime that sets per-window
 * application menus (`appCapabilities().customMenus`). The one place that decides it.
 */
async function nativeMenusAvailable(): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    return (await appCapabilities()).customMenus;
  } catch {
    return false;
  }
}

/** What the clicks act through: the workspace's own actions. */
export interface NativeMenuHandlers {
  /** What the shortcut does (the keydown handler's). */
  runCommand(cmd: KeyCommand): void;
  /** Open Settings (whatever opens it today). */
  openSettings(): void;
  /** An item of the view model (the view, an arrange command, a tile of the list). */
  menuItem(id: string): void;
  setPattern(pattern: LayoutPattern): void;
  setBarPosition(position: BarPosition): void;
  tileControl(control: TileControl, id: string): void;
  /** Start a `+` menu entry. */
  launch(entry: LaunchEntry): void;
  openWebPage(): void;
  openOllama(): void;
  /** The window took the focus (the `+` menu's entries are read again). */
  onFocus(): void;
}

export interface NativeMenusOptions {
  /** The page is up (the boot is done). */
  ready: boolean;
  platform: KeyPlatform;
  state: WorkspaceState;
  broadcast: boolean;
  sections: readonly LaunchSection[];
  /** "Ollama Models…" in the launch submenu. */
  ollama: boolean;
  /** "Web Page" in the launch submenu (the native web engine). */
  webPage: boolean;
  /** A modal dialog has the keyboard. */
  modalOpen: boolean;
  handlers: NativeMenuHandlers;
}

/** Log a failed menu call once per kind (the menus then just lag behind). */
const warned = new Set<string>();
function warnOnce(what: string, err: unknown): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`native menus: ${what} failed`, err);
}

/** Drive the native menus for this window. Returns whether they are on (the in-app menus step back). */
export function useNativeMenus(opts: NativeMenusOptions): boolean {
  const { ready, platform } = opts;
  const [windowId, setWindowId] = useState<string | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // On: the capability, this window's id, and the macOS app menu.
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void (async () => {
      if (!(await nativeMenusAvailable())) return;
      const id = await currentWindowId();
      const page = appMenu(platform);
      if (page) await setAppMenu(page).catch((e) => warnOnce("setAppMenu", e));
      if (live) setWindowId(id);
    })().catch((e) => warnOnce("setup", e));
    return () => {
      live = false;
    };
  }, [ready, platform]);
  const on = windowId !== null;

  // This window's state: only what changed since the last push.
  const input = useMemo(
    () => menuInput(opts.state, opts.broadcast),
    [opts.state, opts.broadcast],
  );
  const pushed = useRef(new Map<string, DesktopMenuItemState>());
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (windowId === null) return;
    for (const [id, s] of stateChanges(pushed.current, menuItemStates(input))) {
      pushed.current.set(id, s);
      setMenuItemState(id, s, { windowId }).catch((e) => {
        pushed.current.delete(id);
        warnOnce("setMenuItemState", e);
      });
    }
  }, [windowId, input, epoch]);

  // This window's tiles in the Window menu.
  const windowItems = useMemo(() => windowMenuItems(input), [input]);
  const windowItemsRef = useRef<DesktopWindowMenuAppItem[]>([]);
  windowItemsRef.current = windowItems;
  const windowItemsKey = JSON.stringify(windowItems);
  useEffect(() => {
    if (windowId === null) return;
    setWindowMenuAppItems(windowItemsRef.current).catch((e) =>
      warnOnce("setWindowMenuAppItems", e)
    );
  }, [windowId, windowItemsKey]);

  // The Shell menu with the `+` menu's entries (app-wide: this window's list), again on focus.
  const shell = useMemo(
    () =>
      shellMenu(platform, {
        sections: opts.sections,
        ollama: opts.ollama,
        webPage: opts.webPage,
      }),
    [platform, opts.sections, opts.ollama, opts.webPage],
  );
  const shellKey = JSON.stringify(shell);
  const shellRef = useRef(shell);
  shellRef.current = shell;
  useEffect(() => {
    if (windowId === null) return;
    setMenu(MENU_IDS.shell, shellRef.current).catch((e) =>
      warnOnce("setMenu", e)
    );
  }, [windowId, shellKey]);
  useEffect(() => {
    if (windowId === null) return;
    return onWindowFocus(() => {
      optsRef.current.handlers.onFocus();
      setMenu(MENU_IDS.shell, shellRef.current).catch((e) =>
        warnOnce("setMenu", e)
      );
    });
  }, [windowId]);

  // A key the page ran: the menu item with its accelerator must not run it again.
  const guard = useMemo(() => createShortcutGuard(() => performance.now()), []);
  useEffect(() => {
    if (windowId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = commandForKey(e, platform);
      if (cmd) guard.pressed(keyAccelerator(cmd));
    };
    globalThis.addEventListener("keydown", onKeyDown, true);
    return () => globalThis.removeEventListener("keydown", onKeyDown, true);
  }, [windowId, platform, guard]);

  // The clicks meant for this window.
  useEffect(() => {
    if (windowId === null) return;
    return onAppMenuItem((id, info) => {
      const mine = info.kind === "windowMenu"
        ? info.windowId === undefined || info.windowId === windowId
        : info.keyWindow?.id === windowId;
      if (!mine) return;
      // A checkbox or radio item shows its new state already: push this window's state again
      // after acting, in case the action changed nothing (a dialog was up).
      if (info.checked !== undefined) {
        pushed.current.clear();
        setEpoch((n) => n + 1);
      }
      const action = menuAction(id);
      if (!action) return;
      if (!guard.allows(itemAccelerator(id, windowItemsRef.current))) return;
      const o = optsRef.current;
      if (!menuActionAllowed(action, o.modalOpen)) return;
      const h = o.handlers;
      const focused = o.state.focusedId;
      switch (action.kind) {
        case "key":
          return h.runCommand(action.command);
        case "settings":
          return h.openSettings();
        case "view":
          return h.menuItem(action.id);
        case "pattern":
          return h.setPattern(action.pattern);
        case "barPosition":
          return h.setBarPosition(action.position);
        case "tile": {
          const target = action.control === "restoreTile"
            ? maximizedId(o.state)
            : focused;
          if (target) h.tileControl(action.control, target);
          return;
        }
        case "launch": {
          const entry = flatEntries(o.sections).find((e) =>
            e.id === action.entryId
          );
          if (entry) h.launch(entry);
          return;
        }
        case "webPage":
          return h.openWebPage();
        case "ollama":
          return h.openOllama();
      }
    });
  }, [windowId, guard]);

  return on;
}
