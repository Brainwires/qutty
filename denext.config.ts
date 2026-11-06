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
      // The PTY backend (node-pty) runs in the app's Deno process: `desktop/pty.ts`. The SSH
      // backend (`desktop/ssh.ts`: host list, qutty.conf, scp/sftp transfers) runs beside it and
      // starts ssh/scp/sftp through the same PTY path. The agent hub (`desktop/hub.ts`: a unix
      // socket + MCP server per terminal, the screen mirror, ask_user, Settings → Agent
      // integration) taps the PTY host. The shared Docker sandbox (`desktop/sandbox.ts`) runs
      // docker in hidden PTYs and gives the PTY host the `docker exec` argv of sandboxed tiles.
      extensions: [
        "./desktop/pty.ts",
        "./desktop/ssh.ts",
        "./desktop/hub.ts",
        "./desktop/sandbox.ts",
      ],
    },
    // What the extensions need beyond the baseline (which already has broad read + env):
    // - ffi "*": node-pty's prebuilt Node-API addon (pty.node) is loaded from the compiled app's
    //   embedded file system, whose path cannot be named at package time; the extensions also do
    //   their PTY I/O, signals and file writes (spawn-helper copy, ~/.ssh/qutty.conf, recents,
    //   ~/.qutty, the agent configs) through libc FFI (see desktop/pty.ts and desktop/ssh.ts for
    //   why). The hub's unix sockets too: `Deno.listen({ transport: "unix" })` needs
    //   `--allow-write` for the socket path, which cannot be scoped to a per-user folder here
    //   (desktop/hub-socket.ts). Its uid comes from libc `getuid` (`Deno.uid()` needs `sys`).
    //   The hub's TCP loopback endpoint for the shared Docker sandbox is bound the same way
    //   (`FdTcpListener`), so it needs no `net` permission either; docker itself runs through
    //   the PTY path.
    //   No `run`, `write`, `net` or `sys` is needed.
    extraPermissions: { ffi: ["*"] },
  },
} satisfies DenextConfig;
