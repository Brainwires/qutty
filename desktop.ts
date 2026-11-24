// Entry for `deno desktop` — serves the static export in `out/` inside a native window (run
// `deno task export` first, or `deno task desktop`, which exports then launches the window). The
// serve + window plumbing lives in denext's desktop runtime; pass `import.meta.url` so `out/`
// resolves relative to this entry (works from the packaged app too).
//
// Native capabilities (`denext desktop add <cap>`) are read from `desktop.capabilities` in the
// config and served through the gated bridge — default deny when `desktop` is absent; a backend
// reverse proxy is `spa.proxy`. Both arrive through `.deno-desktop/config.json`, the runtime part
// of `denext.config.ts` that every export, build and `denext desktop` command rewrites: the config
// module itself (and any plugin it imports) is never compiled into the app.
//
// Windows are views of workspaces (desktop/workspace-host.ts): a window's key is its workspace's
// id. Here: the native menus (desktop/menus.ts: Shell, View, Help) are set, Shell → New Window
// (Cmd+N) opens a fresh workspace, a Dock click with no window showing
// reopens the workspace detached last (or a fresh one), and an ended workspace's key is
// forgotten, so Reopen Closed Window, the Dock and the next launch's restored session never offer
// it again (desktop/windows.ts). The quit guard (Cmd+Q asks first when an agent is busy) is the
// `session` extension's (desktop/session.ts).
//
// Tray mode (desktop/tray.ts): the tray icon (the macOS menu bar, the Linux / Windows tray) lists
// the workspaces with terminals, reopens or focuses one, opens a new window and quits. With the
// last window closed and terminals running, the app lives there (no Dock icon on macOS). Opening
// Qutty again while it runs brings back a window: on macOS a Finder or Spotlight relaunch is the
// Dock's reopen (`onDockReopen`); on Linux and Windows the single-instance lock hands the launch to
// this one (`onSecondInstance`). Both open the same window, and the window's opening takes tray
// mode back to a regular app (the `session` extension's `followWindows`).
//
// The Dock menu (desktop/dock-menu.ts, macOS): the open workspace windows, New Window, New
// Terminal, "Claude Code (chat)", "Codex (chat)" and Reopen Closed Window ▸, set here so it works with no window
// open and outlives page reloads.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { workspaces } from "./desktop/workspace-host.ts";
import {
  dockReopenWindow,
  forgetEndedWorkspaces,
  shareRuntimeWindows,
} from "./desktop/windows.ts";
import { trayIcons, trayMenu, trayMode } from "./desktop/tray.ts";
import { dockCommands, dockMenuController } from "./desktop/dock-menu.ts";
import { resolveProgram } from "./desktop/pty.ts";
import { detachSelfTest } from "./desktop/selftest.ts";
import { moveSelfTest } from "./desktop/move-selftest.ts";
import { webviewSelfTest } from "./desktop/webview-selftest.ts";
import { installNativeMenus } from "./desktop/menus.ts";
import { menusSelfTest } from "./desktop/menus-selftest.ts";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
  onDockReopen: () => dockReopenWindow(workspaces, app.windows),
  onSecondInstance: () => dockReopenWindow(workspaces, app.windows),
  tray: {
    ...trayIcons(Deno.build.os),
    tooltip: "Qutty",
    menu: trayMenu(workspaces.list(), Deno.build.os),
  },
});

if (!app.sidecarChild) {
  forgetEndedWorkspaces(workspaces, app.windows);
  shareRuntimeWindows(app.windows);
  trayMode.install(app, workspaces);
  installNativeMenus(app);
  // The Dock menu (macOS; desktop/dock-menu.ts): Denext's backend Dock menu (`setDockMenu`).
  if (Deno.build.os === "darwin") {
    dockMenuController.install({
      dock: app,
      windows: app.windows,
      registry: workspaces,
      showWorkspace: (id) => trayMode.showWorkspace(id),
      newWindow: () => trayMode.newWindow(),
      commands: dockCommands,
      agentChat: async () => (await resolveProgram("claude")) !== undefined,
      codexChat: async () => (await resolveProgram("codex")) !== undefined,
    });
  }

  if (Deno.env.get("QUTTY_PTY_SELFTEST") === "detach") {
    detachSelfTest(app).then(() => Deno.exit(0), (e) => {
      console.error(`detach self-test: FAILED: ${e?.message ?? e}`);
      Deno.exit(1);
    });
  }
  // `QUTTY_PTY_SELFTEST=move`: a shell's tile moved to another window (desktop/move-selftest.ts).
  if (Deno.env.get("QUTTY_PTY_SELFTEST") === "move") {
    moveSelfTest(app).then(() => Deno.exit(0), (e) => {
      console.error(`move self-test: FAILED: ${e?.message ?? e}`);
      Deno.exit(1);
    });
  }
  // `QUTTY_PTY_SELFTEST=webview`: the native web view behind the web tiles (it needs a window).
  if (Deno.env.get("QUTTY_PTY_SELFTEST") === "webview") {
    webviewSelfTest(app).then(() => Deno.exit(0), (e) => {
      console.error(`webview self-test: FAILED: ${e?.message ?? e}`);
      Deno.exit(1);
    });
  }
  // `QUTTY_PTY_SELFTEST=menus`: the native menu bar as the runtime gets it (run it headless).
  if (Deno.env.get("QUTTY_PTY_SELFTEST") === "menus") {
    menusSelfTest(app).then(() => Deno.exit(0), (e) => {
      console.error(`menus self-test: FAILED: ${e?.message ?? e}`);
      Deno.exit(1);
    });
  }
}
