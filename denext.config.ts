import type { DenextConfig } from "denext/server";

export default {
  desktop: {
    // Unique per app: keys the OS storage dirs and the secureStore keychain service. Keep it equal
    // to deno.json's desktop.app.identifier.
    app: {
      identifier: "org.qutty.Qutty",
      name: "Qutty",
      // Generated from icons/source.png: squircle cut-out on the macOS 824/1024 grid.
      icons: {
        macos: "./icons/app.icns",
        windows: "./icons/app.ico",
        linux: "./icons/app.png",
      },
    },
    // The first window. There is no window background-colour option in the config schema; the
    // page's own CSS paints the dark background.
    window: { width: 1600, height: 1000, title: "Qutty" },
    // macOS: the page draws under a transparent title bar with inset traffic lights (pinned
    // runtime). The page must give itself a drag region (`makeWindowDraggable`).
    titleBar: "hiddenInset",
    capabilities: {
      // The PTY backend (node-pty) runs in the app's Deno process: `desktop/pty.ts`.
      extensions: ["./desktop/pty.ts"],
    },
    // What desktop/pty.ts needs beyond the baseline (which already has broad read + env):
    // - ffi "*": node-pty's prebuilt Node-API addon (pty.node) is loaded from the compiled app's
    //   embedded file system, whose path cannot be named at package time; the extension also does
    //   its PTY I/O, signals and the spawn-helper copy through libc FFI (see desktop/pty.ts for why).
    //   No `run`, `write` or `sys` is needed.
    extraPermissions: { ffi: ["*"] },
  },
} satisfies DenextConfig;
