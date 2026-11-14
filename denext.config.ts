import type { DenextConfig } from "denext/server";
import { CLOSE_AND_END_ITEM } from "./lib/workspace/windows.ts";

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
      // Detachable sessions: closing a window detaches its workspace (its terminals keep running
      // in the app's process) and the app stays up with no window, in the menu bar / tray (the
      // backend tray, desktop.ts); Cmd+Q quits and kills them (desktop/workspace-host.ts). The
      // last window's close quits when no terminal is left, and off macOS when there is no tray
      // (desktop/tray.ts).
      keepAlive: true,
      // One running Qutty: launching it again while it runs (in the tray, say) hands the launch
      // to the running one, which opens a window (desktop.ts, `runDesktop({ onSecondInstance })`).
      // On macOS a relaunch from Finder or Spotlight is the Dock's reopen (`onDockReopen`).
      singleInstance: true,
      // The workspace windows open at the last quit come back at launch, at their frames (each
      // window's key is its workspace's id; their terminals start afresh, a quit ended them).
      restoreWindows: true,
      maxWindows: 16,
    },
    // What the Linux packages say about the app (scripts/package-linux.ts; the release builds
    // `--format tar.gz,deb,appimage`). The window is WebKitGTK (the `webview` backend): the .deb
    // depends on libwebkit2gtk-4.1-0 and libgtk-3-0; the AppImage and the tarball need them too.
    // The .deb Maintainer is "Brainwires <155631428+Brainwires@users.noreply.github.com>": the Brainwires GitHub org's no-reply address,
    // which receives no mail (questions go to GitHub issues; SECURITY.md sends reports to
    // GitHub's private advisories).
    installers: {
      publisher: "Brainwires",
      email: "155631428+Brainwires@users.noreply.github.com",
      description:
        "A tiling terminal: the terminal you are using gets the most space",
    },
    linux: {
      // Every .desktop entry denext writes (the .deb's launcher, the bundle's own entry the
      // tarball and the AppImage carry) lists Qutty with the terminals. The window class is the
      // app id: the launchers start the app with LAUFEY_APP_ID=org.qutty.Qutty.
      desktopEntry: {
        categories: ["System", "TerminalEmulator"],
        keywords: [
          "terminal",
          "shell",
          "console",
          "command line",
          "tiling",
          "ssh",
        ],
        genericName: "Terminal",
        startupWMClass: "org.qutty.Qutty",
      },
      // No `appImage.requires`: the AppImage's metainfo already lists the webview backend's
      // WebKitGTK 4.1 and GTK 3, and nothing else Qutty loads on Linux comes from the host but
      // libc (node-pty's pty.node and the libc FFI; the voice library is not built for Linux).
    },
    // The first window. There is no window background-colour option in the config schema; the
    // page's own CSS paints the dark background.
    // Its key is the first workspace's id, so its frame comes back too.
    window: { width: 1600, height: 1000, title: "Qutty", key: "main" },
    // New Window (Cmd+N: a new workspace, its key chosen in desktop.ts), Reopen Closed Window (a
    // submenu of the closed workspace windows by title, most recent first; the first keeps
    // Cmd+Shift+T) and the open windows, as the Window menu. Denext serves these items with no
    // window open. An ended workspace's key is forgotten (desktop/windows.ts), so it is never
    // listed. Qutty's own item, "Close Window and End Its Shells" (no shortcut), reaches the
    // `session` extension once per click with the key window (`host.onWindowMenuItem`,
    // desktop/session.ts), never the pages (Denext 4.16).
    menu: {
      window: {
        newWindow: "/",
        reopenClosed: "list",
        list: true,
        items: [{
          id: CLOSE_AND_END_ITEM,
          label: "Close Window and End Its Shells",
        }],
      },
    },
    // macOS: the page draws under a transparent title bar with inset traffic lights (pinned
    // runtime). The page must give itself a drag region (`makeWindowDraggable`). Every opened
    // window (New Window, Reopen Closed Window, the restored session) inherits it (Denext 4.15).
    titleBar: "hiddenInset",
    capabilities: {
      // The PTY backend (node-pty) runs in the app's Deno process: `desktop/pty.ts`. The SSH
      // backend (`desktop/ssh.ts`: host list, qutty.conf, scp/sftp transfers) runs beside it and
      // starts ssh/scp/sftp through the same PTY path. The agent hub (`desktop/hub.ts`: a unix
      // socket + MCP server per terminal, the screen mirror, ask_user, Settings → Agent
      // integration) taps the PTY host. The shared Docker sandbox (`desktop/sandbox.ts`) runs
      // docker in hidden PTYs and gives the PTY host the `docker exec` argv of sandboxed tiles.
      // The voice backend (`desktop/voice.ts`: push-to-talk through rullama-hardware's audio
      // library over FFI, the Whisper model download, cloud speech) serves the companion's voice
      // layer (lib/voice/).
      extensions: [
        "./desktop/pty.ts",
        // The workspaces (desktop/workspace-host.ts) as the page sees them: join the window's
        // workspace and reattach its terminals with their replay, save its snapshot, list, end.
        "./desktop/session.ts",
        "./desktop/ssh.ts",
        "./desktop/hub.ts",
        "./desktop/sandbox.ts",
        "./desktop/voice.ts",
        // The Ollama helper (`desktop/ollama.ts`): `ollama` and the library fetch (`curl`) run in
        // hidden PTYs, so it needs no `run` or `net` either.
        "./desktop/ollama.ts",
        // Clickable links (`desktop/links.ts`): which printed paths exist, and opening URLs,
        // files, folders and the editor, through hidden PTYs as well (Denext's `shell`
        // capability only opens paths inside the app's own folders and needs `run`).
        "./desktop/links.ts",
      ],
      // The lite system monitor: CPU, GPU and memory figures for the bar meter and Loopy's hot
      // face, from `system.stats()` (app/use-sysstats.ts asks only while one of them is on). It
      // bakes no Deno permission (aggregate figures only; the runtime serves it to an app whose
      // packaged launch config lists it).
      systemStats: true,
      // The microphone: push-to-talk opens it in the app's own process (the native audio
      // library's cpal capture). The capability writes the Info.plist usage text macOS shows when
      // it asks (once), and gives a signed (hardened runtime) build the
      // `com.apple.security.device.audio-input` entitlement it needs to open the microphone. (It
      // also lets the page's own getUserMedia ask, which Qutty does not use.)
      microphone: {
        usageDescription:
          "Qutty listens only while you hold the talk key or the mic button, to turn your speech into text for the companion or the focused tile.",
      },
      // The OS credential store (macOS Keychain, Linux Secret Service) for the API keys of the
      // cloud voices (Deepgram, ElevenLabs) and the companion's API key brain (Anthropic). Only
      // the extensions use it, each through its own namespace (`ctx.secureStore` /
      // `host.secureStore`: `org.qutty.Qutty/ext/voice`, `org.qutty.Qutty/ext/hub`), which no page
      // can read; the page only sets, clears and asks whether a key is set
      // (lib/secrets/api-keys.ts). With `secureStore.legacy: false` below and runtime denext.16+
      // (the capability list baked into .deno-desktop/app.json) it bakes no Deno permission on
      // macOS or Linux: no `--allow-run=security`, no `--allow-sys` (Windows, whose store is the
      // PasswordVault through PowerShell, gets `--allow-run=powershell.exe`).
      secureStore: true,
    },
    // Never `/usr/bin/security` (no item of Qutty's was ever stored through it): the runtime's own
    // Keychain store only, so no `--allow-run=security` is baked.
    secureStore: { legacy: false },
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
    //   The voice extension loads rullama-hardware's audio library (`librullama_audio_ffi`) from
    //   the app-support folder the same way.
    //   No `run`, `write` or `sys` is needed.
    // - netConnect: the shell agent's optional local model (desktop/shell-agent.ts) and the
    //   companion's Ollama brain, Ollama's API on 127.0.0.1:11434 through `@rullama/provider`; the
    //   cloud voices the user picks with their own key (desktop/voice.ts through
    //   `@rullama/provider-speech`: api.deepgram.com, api.elevenlabs.io); and the companion's API
    //   key brain (lib/companion/anthropic-provider.ts: api.anthropic.com). Nothing else is
    //   reachable, and none of the three cloud hosts is called unless the user picked it and saved
    //   a key.
    // The Whisper model download runs `curl` in a hidden PTY, so no `net` for it either.
    extraPermissions: {
      ffi: ["*"],
      netConnect: [
        "127.0.0.1:11434",
        "api.deepgram.com",
        "api.elevenlabs.io",
        "api.anthropic.com",
      ],
    },
  },
} satisfies DenextConfig;
