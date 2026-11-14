// Tray mode: Qutty's icon in the macOS menu bar (the system tray on Linux and Windows), always
// there while the app runs. Its menu opens a new window, reopens or focuses a workspace that has
// terminals, and quits. Once the last window closes:
//
// - with terminals still running, the app lives on in the tray (macOS: the "accessory" activation
//   policy, so the Dock icon goes; any window that opens brings the Dock icon back);
// - with nothing running, it quits (on every platform, through the quit guard);
// - with no tray here (a Linux session with no StatusNotifier host, an older runtime), it does
//   what it did before: off macOS it quits, on macOS it stays up with its Dock icon.
//
// The tray icon is Denext's backend tray (`runDesktop({ tray })` in desktop.ts). The menu follows
// the workspaces (desktop/workspace-host.ts) through the tray handle's `update`. The pure parts
// (`trayMenu`, `trayMenuAction`, `lastWindowAction`) and {@linkcode TrayMode} over a fake runtime
// are tested without a window (tests/tray_test.ts).

import type {
  DesktopOpenWindowOptions,
  DesktopTrayHandle,
  DesktopTrayOptions,
  DesktopWindows,
} from "denext/desktop";
import type { WorkspaceInfo, WorkspaceRegistry } from "./workspace-host.ts";
import { newWorkspaceId, workspaceWindow } from "../lib/workspace/windows.ts";

type Os = "darwin" | "windows" | "linux";

/** The most workspaces the tray menu lists; the rest are counted on one line. */
export const TRAY_MAX_WORKSPACES = 15;

/** The tray menu's item ids. */
export const TRAY_NEW_WINDOW = "qutty:tray:new-window";
export const TRAY_QUIT = "qutty:tray:quit";
const TRAY_WORKSPACE = "qutty:tray:ws:";

/** A tray menu entry, as Denext's menus are written. */
export type TrayMenuItem =
  | "separator"
  | {
    id: string;
    label: string;
    checked?: boolean;
    disabled?: boolean;
  };

/** "1 terminal" / "3 terminals". */
function terminals(n: number): string {
  return n === 1 ? "1 terminal" : `${n} terminals`;
}

/**
 * The tray menu for the workspaces `list` (`WorkspaceRegistry.list()`: open ones first): New
 * Window, one entry per workspace with running terminals ("Workspace 2 — 3 terminals", the open ones
 * checked, or marked "(open)" on Linux, whose tray hosts may not draw a check), at most `max` of
 * them, then Quit Qutty.
 */
export function trayMenu(
  list: readonly WorkspaceInfo[],
  os: string,
  max = TRAY_MAX_WORKSPACES,
): TrayMenuItem[] {
  const running = list.filter((w) => w.running > 0);
  const shown = running.slice(0, max).map((w): TrayMenuItem => {
    const label = `${w.name} — ${terminals(w.running)}`;
    const open = w.state === "attached";
    if (!open) return { id: TRAY_WORKSPACE + w.id, label };
    return os === "linux"
      ? { id: TRAY_WORKSPACE + w.id, label: `${label} (open)` }
      : { id: TRAY_WORKSPACE + w.id, label, checked: true };
  });
  const more = running.length - shown.length;
  return [
    { id: TRAY_NEW_WINDOW, label: "New Window" },
    "separator",
    ...(running.length === 0
      ? [{
        id: "qutty:tray:none",
        label: "No running terminals",
        disabled: true,
      }]
      : shown),
    ...(more > 0
      ? [{ id: "qutty:tray:more", label: `${more} more…`, disabled: true }]
      : []),
    "separator",
    { id: TRAY_QUIT, label: "Quit Qutty" },
  ];
}

/** What a tray menu item does. */
export type TrayMenuAction =
  | { kind: "new" }
  | { kind: "quit" }
  | { kind: "workspace"; id: string };

/** The action of the tray menu item `id` (`undefined`: not one of ours, or a disabled line). */
export function trayMenuAction(id: string): TrayMenuAction | undefined {
  if (id === TRAY_NEW_WINDOW) return { kind: "new" };
  if (id === TRAY_QUIT) return { kind: "quit" };
  if (id.startsWith(TRAY_WORKSPACE) && id.length > TRAY_WORKSPACE.length) {
    return { kind: "workspace", id: id.slice(TRAY_WORKSPACE.length) };
  }
  return undefined;
}

/**
 * What the app does once its last window closed: `tray` (live in the tray, the Dock icon hidden on
 * macOS), `quit`, or `stay` (macOS without a tray: a Dock app with no window, as before).
 */
export type LastWindowAction = "tray" | "quit" | "stay";

/**
 * The decision for the last window's close: with a tray, live there while terminals run and quit
 * once none does; without one, quit off macOS (nothing would bring the app back) and stay up in
 * the Dock on macOS.
 */
export function lastWindowAction(
  o: { os: string; tray: boolean; running: boolean },
): LastWindowAction {
  if (o.tray) return o.running ? "tray" : "quit";
  return o.os === "darwin" ? "stay" : "quit";
}

/** Whether any workspace still has a running terminal. */
export function anyRunning(list: readonly WorkspaceInfo[]): boolean {
  return list.some((w) => w.running > 0);
}

/** The tray icon in the export for `os` (public/; scripts/gen-tray-icons.ts makes them). */
export function trayIcons(
  os: string,
): Pick<DesktopTrayOptions, "icon" | "iconDark"> {
  // macOS draws every tray image as a template (only its alpha counts): the black glyph.
  if (os === "darwin") return { icon: "/tray-template.png" };
  return { icon: "/tray.png", iconDark: "/tray-dark.png" };
}

/** The slice of `DesktopRuntime` tray mode drives. */
export interface TrayRuntime {
  readonly tray?: Pick<DesktopTrayHandle, "update" | "onMenuItem">;
  readonly windows: Pick<DesktopWindows, "open" | "byKey" | "list">;
  setActivationPolicy(policy: "regular" | "accessory"): boolean;
  /**
   * Quit the app (`DesktopRuntime.quit()`): every extension's quit guard runs (desktop.ts adds
   * none of its own), so the `session` extension still asks about a busy agent.
   */
  quit(): Promise<boolean>;
}

/** Quit through `rt` (see {@linkcode TrayRuntime.quit}); a failure is logged. */
function quitThrough(rt: Pick<TrayRuntime, "quit">): () => void {
  return () => {
    rt.quit().catch((err) => console.error("tray: could not quit", err));
  };
}

/** How long a burst of workspace changes is coalesced into one menu update. */
const MENU_DEBOUNCE_MS = 100;

/**
 * Tray mode for the app's life. desktop.ts {@linkcode install}s it with the runtime once
 * `runDesktop` is back; the `session` extension (desktop/session.ts) reports the window lifecycle
 * to it ({@linkcode windowOpened}, {@linkcode lastWindowClosed}). Before `install`, or with no
 * tray, it is the fallback ({@linkcode available} is `false`).
 */
export class TrayMode {
  #rt: TrayRuntime | undefined;
  #registry:
    | Pick<WorkspaceRegistry, "list" | "lastDetached" | "onChanged">
    | undefined;
  #os: Os = Deno.build.os as Os;
  #quit: () => void = () => {};
  /** The app lives in the tray: the last window closed with terminals running. */
  #background = false;
  #menu = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  #off: (() => void)[] = [];

  /** Whether the app has a tray icon here. */
  get available(): boolean {
    return this.#rt?.tray !== undefined;
  }

  /** Whether the app lives in the tray now (no window, terminals running). */
  get background(): boolean {
    return this.#background;
  }

  /**
   * Drive the tray of `rt`: its menu follows `registry`'s workspaces and its clicks open, focus
   * or quit. With no tray (`rt.tray` undefined) only the fallback is kept. Returns the uninstall.
   */
  install(
    rt: TrayRuntime,
    registry: Pick<WorkspaceRegistry, "list" | "lastDetached" | "onChanged">,
    opts: { os?: Os; quit?: () => void } = {},
  ): () => void {
    this.uninstall();
    this.#rt = rt;
    this.#registry = registry;
    this.#os = opts.os ?? (Deno.build.os as Os);
    this.#quit = opts.quit ?? quitThrough(rt);
    const tray = rt.tray;
    if (tray) {
      this.#refreshMenu();
      this.#off.push(
        registry.onChanged(() => this.#changed()),
        tray.onMenuItem((id) => this.menuItem(id)),
      );
    }
    return () => this.uninstall();
  }

  /** Stop driving the tray (tests; a second install). */
  uninstall(): void {
    for (const off of this.#off.splice(0)) off();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#rt = undefined;
    this.#registry = undefined;
    this.#background = false;
    this.#menu = "";
  }

  #changed(): void {
    if (this.#background && !anyRunning(this.#registry?.list() ?? [])) {
      // In the tray, the last terminal exited: nothing is left to come back to.
      this.#background = false;
      this.#quit();
    }
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#refreshMenu();
    }, MENU_DEBOUNCE_MS);
  }

  #refreshMenu(): void {
    const tray = this.#rt?.tray;
    if (!tray || !this.#registry) return;
    const menu = trayMenu(this.#registry.list(), this.#os);
    const json = JSON.stringify(menu);
    if (json === this.#menu) return;
    this.#menu = json;
    try {
      tray.update({ menu, tooltip: "Qutty" });
    } catch (err) {
      console.error("tray: could not update the menu", err);
    }
  }

  /** A tray menu item was chosen. */
  menuItem(id: string): void {
    const action = trayMenuAction(id);
    if (!action) return;
    if (action.kind === "quit") return this.#quit();
    if (action.kind === "new") {
      return this.#open(workspaceWindow(newWorkspaceId(), true));
    }
    this.showWorkspace(action.id);
  }

  /** Focus workspace `id`'s window, or reopen it when it is detached. */
  showWorkspace(id: string): void {
    const rt = this.#rt;
    if (!rt) return;
    const open = rt.windows.byKey(id);
    if (!open) return this.#open(workspaceWindow(id));
    this.#regular();
    open.show();
    open.focus();
  }

  #open(options: DesktopOpenWindowOptions): void {
    this.#regular();
    try {
      this.#rt?.windows.open(options);
    } catch (err) {
      console.error("tray: could not open a window", err);
    }
  }

  /** macOS: back to a regular app (the Dock icon returns and the app comes to the front). */
  #regular(): void {
    this.#background = false;
    if (this.#os !== "darwin" || !this.#rt?.tray) return;
    try {
      this.#rt.setActivationPolicy("regular");
    } catch (err) {
      console.error("tray: could not show the Dock icon", err);
    }
  }

  /**
   * A window opened (the tray, the Dock, a second launch, Reopen Closed Window, New Window, a
   * page).
   */
  windowOpened(): void {
    if (this.#background) this.#regular();
  }

  /**
   * The app's last window closed (not for a quit). Returns what was done: live in the tray (the
   * Dock icon hidden on macOS), quit, or stay (macOS without a tray).
   */
  lastWindowClosed(): LastWindowAction {
    const action = lastWindowAction({
      os: this.#os,
      tray: this.available,
      running: anyRunning(this.#registry?.list() ?? []),
    });
    if (action === "quit") this.#quit();
    if (action === "tray") {
      this.#background = true;
      if (this.#os === "darwin") {
        try {
          this.#rt?.setActivationPolicy("accessory");
        } catch (err) {
          console.error("tray: could not hide the Dock icon", err);
        }
      }
    }
    return action;
  }
}

const KEY = Symbol.for("qutty.trayMode");

/**
 * The app's tray mode, shared by desktop.ts and the `session` extension. Kept on `globalThis`, as
 * desktop/workspace-host.ts's `workspaces` is, in case the loader gave the entry and the extensions two copies.
 */
export const trayMode: TrayMode =
  ((globalThis as Record<symbol, unknown>)[KEY] as TrayMode | undefined) ??
    ((globalThis as Record<symbol, unknown>)[KEY] = new TrayMode()) as TrayMode;
