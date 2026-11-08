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
      // Detachable sessions: closing a window detaches its workspace (its terminals keep running
      // in the app's process) and the app stays up with no window, in the Dock; Cmd+Q quits and
      // kills them (desktop/workspace-host.ts). Off macOS the last window's close quits
      // (desktop/session.ts).
      keepAlive: true,
      // The workspace windows open at the last quit come back at launch, at their frames (each
      // window's key is its workspace's id; their terminals start afresh, a quit ended them).
      restoreWindows: true,
      maxWindows: 16,
    },
    // The first window. There is no window background-colour option in the config schema; the
    // page's own CSS paints the dark background.
    // Its key is the first workspace's id, so its frame comes back too.
    window: { width: 1600, height: 1000, title: "Qutty", key: "main" },
    // New Window (Cmd+N: a new workspace, its key chosen in desktop.ts), Reopen Closed Window
    // (Cmd+Shift+T: the workspace detached last) and the open windows, as the Window menu.
    menu: { window: { newWindow: "/", reopenClosed: true, list: true } },
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
        // The lite system monitor (`desktop/sysstats.ts`): CPU, GPU and memory figures for the bar
        // meter and Loopy's hot face, read through Mach / IOKit FFI on macOS and `/proc` on Linux
        // (no `sys`), only when the page asks.
        "./desktop/sysstats.ts",
      ],
      // The microphone: push-to-talk opens it in the app's own process (the native audio
      // library's cpal capture). The capability writes the Info.plist usage text macOS shows when
      // it asks (once), and gives a signed (hardened runtime) build the
      // `com.apple.security.device.audio-input` entitlement it needs to open the microphone. (It
      // also lets the page's own getUserMedia ask, which Qutty does not use.)
      microphone: {
        usageDescription:
          "Qutty listens only while you hold the talk key or the mic button, to turn your speech into text for the companion or the focused tile.",
      },
      // Not yet: `secureStore: true` for cloud voice keys (Deepgram, ElevenLabs). Denext's packager
      // then bakes `--allow-run=security` and `--allow-sys`, which the app must not have, so the
      // cloud engines are off (lib/voice/engines.ts CLOUD_KEYS_UNAVAILABLE; TODO.md).
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
    //   The voice extension loads rullama-hardware's audio library (`librullama_audio_ffi`) from
    //   the app-support folder the same way.
    //   The system monitor (desktop/sysstats.ts) calls libSystem (`host_statistics`,
    //   `sysctlbyname`), IOKit and CoreFoundation the same way, instead of `sys`.
    //   No `run`, `write` or `sys` is needed.
    // - netConnect, loopback only: the shell agent's optional local model (desktop/shell-agent.ts),
    //   Ollama's API on 127.0.0.1:11434 through `@rullama/provider`. Nothing else is reachable.
    // The Whisper model download runs `curl` in a hidden PTY, so no `net` for it either. (With the
    // cloud voices on: `netConnect: ["api.deepgram.com", "api.elevenlabs.io"]`.)
    extraPermissions: { ffi: ["*"], netConnect: ["127.0.0.1:11434"] },
  },
} satisfies DenextConfig;
