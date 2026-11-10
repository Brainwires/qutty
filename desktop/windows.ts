// The workspace windows as desktop.ts hands them to Denext (`runDesktop` and its
// `DesktopRuntime.windows`): what a Dock click with no window showing opens, and which window keys
// are forgotten. Pure over the registry and a slice of `DesktopWindows`, so it is tested without
// a window (tests/workspace_host_test.ts).

import type { DesktopOpenWindowOptions, DesktopWindows } from "denext/desktop";
import type { WorkspaceRegistry } from "./workspace-host.ts";
import { newWorkspaceId, workspaceWindow } from "../lib/workspace/windows.ts";

/**
 * `runDesktop({ onDockReopen })`: the window a click on the Dock icon opens when no window is
 * showing. The workspace detached most recently comes back (its terminals kept running), else a
 * fresh workspace opens. Denext's own default would reopen the last closed key, which may be a
 * workspace that had no terminal left (dropped) rather than the last one still running. A hidden
 * or minimized workspace window still open gets nothing new: the click only activates the app.
 */
export function dockReopenWindow(
  registry: Pick<WorkspaceRegistry, "lastDetached">,
  windows: Pick<DesktopWindows, "list">,
): DesktopOpenWindowOptions | undefined {
  if (windows.list().some((w) => w.kind !== "panel")) return undefined;
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
