// The native menu bar's backend half (Denext 4.18's app menus; the model is
// lib/workspace/menus.ts): desktop.ts sets the Shell, View and Help menus at launch, so the bar is
// whole before a page loads and while no window is open, and answers Shell → New Window here (a
// fresh workspace, as the tray's New Window does), with or without a window. The pages keep each
// window's own state and tiles up to date and act on the clicks meant for the key window
// (app/use-native-menus.ts); "Close Window and End Its Shells" is the `session` extension's
// (desktop/session.ts) and Help → "Qutty on GitHub" the `links` extension's (desktop/links.ts).

import type { DesktopOpenWindowOptions, DesktopRuntime } from "denext/desktop";
import { customMenus, ITEM } from "../lib/workspace/menus.ts";
import { newWorkspaceId, workspaceWindow } from "../lib/workspace/windows.ts";

/** What {@linkcode installNativeMenus} drives: the runtime's menus and windows. */
export type MenuRuntime =
  & Pick<DesktopRuntime, "setMenu" | "onAppMenuItem">
  & { windows: { open(options: DesktopOpenWindowOptions): unknown } };

/**
 * Set the custom menus for `os` and answer New Window. A runtime that sets no application menu
 * (`unsupported`) leaves the bar as Denext's managed one, with a warning. Returns the unsubscribe.
 */
export function installNativeMenus(
  rt: MenuRuntime,
  os: string = Deno.build.os,
): () => void {
  const platform = os === "darwin" ? "mac" : "other";
  try {
    for (const { id, menu } of customMenus(platform)) rt.setMenu(id, menu);
  } catch (err) {
    console.warn(
      `menus: the native menus could not be set: ${
        (err as Error)?.message ?? err
      }`,
    );
    return () => {};
  }
  return rt.onAppMenuItem((id) => {
    if (id !== ITEM.newWindow) return;
    try {
      rt.windows.open(workspaceWindow(newWorkspaceId(), true));
    } catch (err) {
      console.error("menus: could not open a window", err);
    }
  });
}
