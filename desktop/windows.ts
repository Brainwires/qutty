// The workspace windows as desktop.ts hands them to Denext (`runDesktop` and its
// `DesktopRuntime.windows`): what a Dock click with no window showing opens, and which window keys
// are forgotten. Pure over the registry and a slice of `DesktopWindows`, so it is tested without
// a window (tests/workspace_host_test.ts).

import type { DesktopOpenWindowOptions, DesktopWindows } from "denext/desktop";
import type { WorkspaceRegistry } from "./workspace-host.ts";
import { newWorkspaceId, workspaceWindow } from "../lib/workspace/windows.ts";
import { isCompanionWindow } from "./companion-window.ts";

/**
 * `runDesktop({ onDockReopen })`: the window a click on the Dock icon opens when no window is
 * showing. The workspace detached most recently comes back (its terminals kept running), else a
 * fresh workspace opens. Denext's own default would reopen the last closed key, which may be a
 * workspace that had no terminal left (dropped) rather than the last one still running. A hidden
 * or minimized workspace window still open gets nothing new: the click only activates the app.
 * The floating companion's window (desktop/companion-window.ts) is not one: with only it showing,
 * the click opens a workspace.
 */
export function dockReopenWindow(
  registry: Pick<WorkspaceRegistry, "lastDetached">,
  windows: Pick<DesktopWindows, "list">,
): DesktopOpenWindowOptions | undefined {
  if (
    windows.list().some((w) => w.kind !== "panel" && !isCompanionWindow(w.id))
  ) return undefined;
  const last = registry.lastDetached();
  return last ? workspaceWindow(last) : workspaceWindow(newWorkspaceId(), true);
}

/**
 * Forget the window key of every workspace ended for good (its terminals were killed): it leaves
 * Reopen Closed Window, the Dock's reopen and the session restored at the next launch
 * (`windows.forget`). A workspace shown in a window is ended only once that window has closed
 * (`WorkspaceRegistry.endOnClose`), after Denext remembered the close, so the key really goes.
 * Returns the unsubscribe.
 */
export function forgetEndedWorkspaces(
  registry: Pick<WorkspaceRegistry, "onEnded">,
  windows: Pick<DesktopWindows, "forget">,
): () => void {
  return registry.onEnded((id) => {
    try {
      windows.forget(id);
    } catch (err) {
      console.error(`workspace ${id}: could not forget its window`, err);
    }
  });
}

const WINDOWS_KEY = Symbol.for("qutty.runtimeWindows");
type RuntimeWindows =
  & Pick<DesktopWindows, "get">
  & Partial<Pick<DesktopWindows, "order">>;
const shared = globalThis as Record<symbol, RuntimeWindows | undefined>;

/**
 * Hand desktop.ts's `DesktopRuntime.windows` to the extensions that close a window themselves (the
 * `session` extension's "Close Window and End Its Shells"). Kept on `globalThis`, as
 * desktop/workspace-host.ts's `workspaces` is, in case the loader gave the entry and the extensions
 * two copies of this module.
 */
export function shareRuntimeWindows(windows: RuntimeWindows): void {
  shared[WINDOWS_KEY] = windows;
}

/**
 * Close window `id` for good, without asking its page's close guard (`DesktopWindowRef.close`).
 * Nothing happens when it is gone, or before desktop.ts shared the runtime's windows.
 */
export function closeAppWindow(id: string): void {
  try {
    shared[WINDOWS_KEY]?.get(id)?.close();
  } catch (err) {
    console.error(`window ${id}: could not close it`, err);
  }
}

/**
 * Bring window `id` to the front with the keyboard (`DesktopWindowRef.focus`): the floating
 * companion hands the keyboard back to the workspace window used last. Nothing happens when it is
 * gone, or before desktop.ts shared the runtime's windows.
 */
export function focusAppWindow(id: string): void {
  try {
    shared[WINDOWS_KEY]?.get(id)?.focus();
  } catch (err) {
    console.error(`window ${id}: could not focus it`, err);
  }
}

/**
 * The app's windows on screen front to back as the OS stacks them (Denext 4.22's
 * `windows.order()` with `source: "os"`: macOS, Windows, Linux on X11), for a tile dragged between
 * windows (desktop/tile-move.ts). `null` where the OS does not tell (`source: "focus"`: Wayland, an
 * older runtime; the tile mover then orders by Qutty's own focus order), or before desktop.ts
 * shared the runtime's windows.
 */
export function appWindowOrder(): readonly string[] | null {
  try {
    const order = shared[WINDOWS_KEY]?.order?.();
    return order?.source === "os" ? order.ids : null;
  } catch {
    return null;
  }
}

/**
 * Window `id`'s frame on screen (`DesktopWindowRef.getBounds`), for a tile dragged between windows
 * (desktop/tile-move.ts). `null` when it is gone, when the runtime cannot say, or before desktop.ts
 * shared the runtime's windows.
 */
export function appWindowBounds(
  id: string,
): { x: number; y: number; width: number; height: number } | null {
  try {
    return shared[WINDOWS_KEY]?.get(id)?.getBounds() ?? null;
  } catch {
    return null;
  }
}
