# TODO

## Later

- [x] **Detachable sessions.** Closing the window must not close the terminals.
      Reopening the app reattaches to every running shell, with its scrollback,
      tile layout and focus order intact (like tmux/screen detach, but built
      in).
  - Done (Denext 4.13): the PTYs stay in the app's process, which outlives its
    windows (`desktop.app.keepAlive`; a Dock click or Reopen Closed Window
    brings a window back). Each terminal belongs to a workspace
    (`desktop/workspace-host.ts`); its events go to the window showing it
    (Denext's `createOwnedResources`, `desktop/terminal-sessions.ts`), and a 1
    MiB replay ring per PTY redraws it on reattach (raw output, cut at a line
    break when the ring dropped its start; a full-screen program is nudged to
    redraw). The page saves a snapshot (tiles ↔ PTYs, layout, MRU) in the app
    and rebuilds from it (`lib/workspace/session.ts`, `app/use-session.ts`). A
    reload reattaches too. ⌘Q quits and kills everything, asking first when an
    agent is busy; the Workspaces menu ends a workspace for real.
  - Open: detach that survives quitting the app (a separate PTY daemon), and
    restoring the shells themselves (cwd, scrollback) at the next launch: today
    the windows and layouts come back with fresh shells.
  - Off macOS there is no Dock to come back through: closing the last window
    quits (through the same busy-agent question). Not tried on Linux yet.

- [x] **Shell picker on the `+` button.** A dropdown arrow attached to the side
      of `+` (a split button) chooses what the new terminal runs. Clicking `+`
      itself still opens the default shell.
  - List every installed shell, read from `/etc/shells` and checked to exist
    (zsh, bash, fish, nu, ...).
  - Also list agent and CLI tools such as Claude Code (`claude`) and Codex
    (`codex`), found on `PATH`. These launch directly as the terminal's program,
    and the tile closes when the tool exits, with no shell left behind.
  - The backend's `spawn` already takes the command to run, so most of the work
    is detecting what's installed (a new extension method) and building the
    dropdown UI. It should work from both the horizontal and vertical bar.
  - Maybe: remember the last choice, a setting for the default, and user-defined
    entries (command + args + label).
  - Done: shells, agent tools (data-driven list), SSH hosts and "Connections…";
    the last pick is remembered and Settings has "+ opens". User-defined entries
    are still open.

- [x] **Companion + agent hub** (plan: phases 1–4). Shipped in 0.3.0 (Codex and
      the shell agent in 0.3.1); the "open" and "Next" items below remain.
  - Done (phase 1): `desktop/hub.ts` — a unix socket + MCP server per terminal
    (`/tmp/qutty-<uid>/<pid>/<ptyId>.sock`, bound through libc), registry,
    mailboxes, headless screen mirror, `ask_user` (a simple dialog for now),
    `QUTTY_SOCK` / `QUTTY_TILE_ID` / `~/.qutty/bin` in every tile, the
    `qutty-mcp` / `qutty-hook` shims, launch flags for Claude Code and Codex,
    Settings → Agent integration, agent badges in tile headers.
  - Done (phase 2): the companion — Loopy in a corner (`app/companion/`,
    `lib/companion/`), `ask_user` and `qutty-hook say` in its bubble, its chat
    box, a privileged identity on its own socket (`desktop/companion.ts`) with
    the companion-only tools carried out by the page, the brain as headless
    Claude Code in a hidden PTY behind an adapter (`lib/companion/brain.ts`,
    `desktop/companion-brain.ts`), re-attach after it exits, the audit log and
    Settings → Companion.
  - Done (phase 2b): voice — `lib/voice/` (settings, routing, TTS queue with
    barge-in, push-to-talk controller, alerts, model download, FFI binding),
    `desktop/voice.ts` (rullama-audio-ffi over `Deno.dlopen`, the Whisper model
    via `curl` in a hidden PTY, Deepgram / ElevenLabs), the mic / Summarize /
    Stop buttons and the review box on Loopy, Settings → Voice.
  - Voice, open: bundle `librullama_audio_ffi` per architecture in the app
    (Denext's packager has no option for extra files yet: see
    docs/denext-speech-recognition-proposal.md, "Related gap"); until then it is
    installed into the app-support folder by `deno task audio:lib`. The OS
    recognizer (`SFSpeechRecognizer`) waits on the Denext proposal in the same
    doc. ElevenLabs text to speech needs `output_format` sent as a query
    parameter in `@rullama/provider-speech` (it is ignored today, so the reply
    is mp3, which the library cannot play); Deepgram Aura is used instead.
    OpenAI Realtime (Denext's `feat/loopy-voice-tools` Loopy voice) can be one
    more optional cloud engine behind the same adapters.
  - Done (Denext 4.15): the cloud engines (Deepgram, ElevenLabs) are on. Their
    keys live in the voice extension's own secure store (`host.secureStore`,
    `org.qutty.Qutty/ext/voice` in the OS keychain), which no page can read;
    Settings → Voice saves, replaces or removes a key and only learns whether
    one is set (lib/secrets/api-keys.ts, app/companion/api-key-field.tsx).
    `desktop.secureStore: { legacy: false }` and runtime denext.16 bake neither
    `--allow-run=security` nor `--allow-sys`; `netConnect` gained
    api.deepgram.com and api.elevenlabs.io.
  - Secure store, open: Windows bakes `--allow-run=powershell.exe` for it (the
    PasswordVault); the hub (and so the API key brain) does not run on Windows
    yet, but the cloud voices would. Not checked against a packaged build: a key
    saved in the real Keychain from the signed app (the tests use an in-memory
    store only).
  - Voice, Denext: the microphone's Info.plist text and audio-input entitlement
    come from Denext's `microphone` capability (denext.config.ts).
    Packaged-build checks without the UI, each under a temporary `HOME` so the
    installed app's folder is untouched: `QUTTY_VOICE_SELFTEST=<wav>`
    (desktop/voice.ts) logs the library, fetches the model, transcribes and
    plays the file; `QUTTY_PTY_SELFTEST=1` (desktop/pty.ts) loads node-pty's
    addon, starts the login shell as a tile does, has it answer, and exits (the
    check for denext#134, where a runtime's node-pty substitute had no native
    addon). Streaming transcripts (partials) and a wake word are possible with
    the same library.
  - Done (phase 2c): the shared Docker sandbox (see below).
  - Done (phase 3): the shell is the harness —
    `resources/shell/qutty.{zsh,bash}` (a `,` line goes to the model, the
    proposed command lands in the edit buffer), the bash-only `qutty-agent`
    client over the tile socket, the hub side in `lib/hub/shell-agent.ts`
    (prompt, bounds, redaction, reply parsing, danger flags, `, inbox` / `, say`
    / `, to`) and `desktop/shell-agent.ts` (headless Claude Code, or a local
    Ollama through `@rullama/provider`), the rc opt-in rows in Settings → Agent
    integration.
  - Shell agent, open: bash 4.0–5.0 draws the request line once more than 5.1+
    may (only 5.1+ clears it before a `bind -x` command; untested there);
    macOS's bash 3.2 gets the proposal in the history, not the buffer (no
    `READLINE_LINE`); the prompt's new-message check over TCP (sandbox) has no
    connect timeout. Done: Ctrl-C cancels a request hub-side, and an Ollama
    request is closed too (`ChatOptions.signal`, @rullama/provider 0.12.3), so
    Ollama stops generating. Danger flags are Rullama's `classifyCommand` plus
    four Qutty warnings it leaves out on purpose (any `rm -r`/`-f`,
    `--force-with-lease`, `checkout`/`restore .`, `chmod`/`chown -R`); those
    four are regexes over the command with quoted data dropped, not a shell
    parse.
  - Done: the second brain, a local Ollama model
    (`lib/companion/inference-brain.ts`, `runAgentLoop` over
    `@rullama/provider`'s native `OllamaChatProvider` on Ollama's `/api/chat`,
    0.12.3: native `tool_calls` and tool results, and `ChatOptions.signal`, so
    stopping the companion closes the request and Ollama stops generating), its
    tools the hub's handler called in process as the companion
    (`companionToolbox`); Settings → Companion → Brain runs on.
  - Done (Denext 4.15): the API key brain, the same loop over Anthropic's
    Messages API (lib/companion/anthropic-provider.ts, api.anthropic.com) with
    the user's key, kept in the hub extension's own secure store
    (`org.qutty.Qutty/ext/hub`) and read for each request; Settings → Companion
    → Brain runs on → API key, with the key row and Haiku / Sonnet / Opus as
    `claude-haiku-5-5` / `claude-sonnet-5-5` / `claude-opus-5-5` (default). Not
    `@rullama/provider`'s `AnthropicChatProvider`: it drops `thinking` blocks
    from the history and always sends `temperature`, which the current models
    refuse. The server-side refusal fallback (`fallbacks: "default"`) is on for
    Opus and Sonnet.
  - API key brain: its history is never trimmed (the Ollama brain keeps its
    60-message trim). Preserved thinking (Opus 5.5, Sonnet 5.5) accepts thinking
    blocks only in an unedited, append-only history, and dropping the oldest
    turns is an edit (a 400 for newer accounts). So once the serialized history
    passes `ANTHROPIC_HISTORY_CHARS` (1.6M characters, about 400k tokens), the
    next turn starts a fresh session with the same system prompt
    (`InferenceBrain` `history: { fresh }`, lib/companion/inference-brain.ts).
  - API key brain, open: never run against the real API (the tests use a fake
    `fetch`). A fresh session forgets the earlier turns without a summary; Loopy
    does not say so yet. The limit is checked at a turn's start, so one turn's
    tool rounds can grow past it. An OpenAI key brain (`OpenAiChatProvider`,
    api.openai.com) would be one more engine and host.
  - Done: dragging Loopy (snaps to the nearest corner, which is the Corner
    setting) and the mic level driving its listening pulse (`level` events from
    desktop/voice.ts, ~20 Hz while capturing).
  - Next: a floating window (Denext multi-window).
  - Done: Codex (CLI 0.167) end to end: `env_vars` for the MCP server, hooks for
    SessionStart / UserPromptSubmit / PostToolUse / PermissionRequest / Stop /
    Interrupt with their trust (session flags, or the user's config.toml), MCP
    tool hints for Codex's approval. `tests/hub_codex_cli_test.ts` checks the
    installed CLI with no model call; `QUTTY_LIVE_CODEX=1` runs
    `tests/hub_codex_live_test.ts`, one small real request.
  - Open: Codex's hook trust hash is its own algorithm (SHA-256 over the
    normalized hook). Qutty asks the installed Codex (`app-server` `hooks/list`)
    at start and after Install, and Settings shows a warning with Re-trust when
    the hooks are untrusted; if Codex's hash itself changed, Re-trust cannot fix
    it (Qutty must be updated, or write Codex's reported `currentHash`), and
    `tests/hub_codex_cli_test.ts` fails locally.
  - Done: session ids in the registry (`session_id` from the hooks; a
    `SessionStart` replaces it), in `whoami` / `list_peers`; Hermes
    (`hermes-agent`) and OpenClaw (`openclaw-bundle-mcp`) MCP client names.
  - Open: `qutty-hook` starts bash + nc per call (~0.2 s); a tiny relay could
    cut it.

- [x] **Sandboxed shells (Docker)**, as one shared container per window
      (Settings → Sandbox; `desktop/sandbox.ts`, `lib/sandbox/`).
  - Decided: a plain long-lived container. Docker Desktop's `docker sandbox` is
    removed in current releases (4.98 points at the separate Docker Sandboxes
    product: one agent per microVM, not several shells in one sandbox).
  - The hub over TCP + token (`QUTTY_HUB`, `QUTTY_TILE_TOKEN`), bound through
    libc like the unix sockets (no `net` permission); native Linux Docker gets
    `--add-host=host.docker.internal:host-gateway` and the hub also listens on
    the bridge gateway.
  - Done: the container follows its workspace (#32): closing a window detaches
    it and keeps the container for its tiles; ending the workspace stops it
    (unless "keep running" is on).
  - Open: changing the image or mounts recreates the container on Restart
    (packages installed with apt go; `$HOME` stays). With Docker Desktop,
    network off also cuts the sandbox off from the hub (`host.docker.internal`
    is served neither without a network nor on an `--internal` one).
  - Done: native Linux runs the tiles as the app's user
    (`docker exec -u
    uid:gid`, the ids from libc `getuid`/`getgid`), so
    files they create in a read/write project mount are the user's; the
    container's main process stays root and adds a `passwd` entry and the home
    volume (`/home/qutty`) for the user at every start. No root inside on Linux,
    so `apt install` needs `docker exec -u 0`. macOS keeps root (Docker Desktop
    maps ownership).
  - Done: native Linux with the network off joins `qutty-sandbox-hub`, an
    `--internal` network (no route out); its gateway is the host, so the hub
    listens there and `host.docker.internal` points at it. The host's own
    services listening on every address are reachable from it too.

- [x] **SSH sessions and a connection manager.** Shipped in 0.3.0; the "Still
      open" items at the end remain. Run the system `ssh` in a PTY, the same way
      shells run today. Never implement the protocol, and never store passwords.
      Keys, ssh-agent, the keychain, jump hosts, known_hosts and hardware keys
      all come for free from OpenSSH.
  - **Profiles are SSH config.** The manager lists the `Host` entries in
    `~/.ssh/config`, so it's populated on first launch. Hosts saved in Qutty go
    to `~/.ssh/qutty.conf`, pulled into the main config with an `Include` line,
    so they also work from a plain terminal. Never rewrite the user's own config
    file. Keep directives the form doesn't model.
  - **Connection manager dialog.** Keyboard first: open it, type to filter,
    press Enter to connect. Hosts are grouped as Favorites, `~/.ssh/config` and
    Recent. A detail pane shows user, port, key, jump host, remote command, tint
    and forwards, with Connect / Connect in split / Edit. Typing
    `user@host:port` that matches nothing offers quick connect, then save.
  - **In the `+` picker.** SSH hosts appear below the shells and tools (see the
    shell picker), alongside Docker sandboxes, as kinds of connection profile.
  - **Shared connections.** Run Qutty's ssh with `ControlMaster auto` /
    `ControlPersist`. A second tile to the same host opens instantly, with no
    new handshake or 2FA. File transfers reuse the same connection.
  - **File transfer (scp/sftp over the shared connection).**
    - Upload: drop files on an SSH tile to copy them to the remote shell's
      current directory. Get that directory from OSC 7 when the remote shell
      emits it; otherwise ask, defaulting to `~`.
    - Download: a "Download…" action on the tile with a remote path picker
      (`sftp` listing), saving to `~/Downloads` or a chosen folder.
    - Show progress, and allow cancel, in a small overlay on the tile. Works
      without re-authenticating because it rides the control socket.
  - **Dropped connections.** Show a "Disconnected" overlay with Reconnect
    instead of closing the tile. Optional per-host "tmux on connect"
    (`tmux new -A -s qutty`) so a reconnect lands where you left off: detach on
    the remote side.
  - **Host tint.** A per-host color from the theme palette (e.g. red border for
    anything tagged `prod`), so dangerous tiles are obvious.
  - **Auto-label.** When `info()` shows `ssh` as the foreground process in an
    ordinary shell tile, label the tile with the host and offer "Save this
    host".
  - Done: broadcast typing to several selected tiles (cluster ssh: ⌘⇧I or the
    bar button, a checkbox per tile, only the user's keys and pastes are
    repeated, big pastes confirmed), and a per-host port-forward panel
    (`ssh -O forward` / `-O cancel` on the control socket, live; favourites in
    the `# qutty:` metadata). ssh has no control command that lists forwards, so
    the panel shows the ones Qutty added (and the config's own) rather than
    every forward on the master.
  - Status: the backend and the UI are in (manager dialog, SSH tiles with tint /
    Disconnected / Reconnect, drop-to-upload, Download… picker, progress,
    broadcast input, port forwards), and SSH hosts in the `+` picker (with the
    shell picker). Still open: "Connect in split" (the layout has no splits),
    choosing a download folder, auto-label + "Save this host" for `ssh` typed in
    a plain shell (needs the foreground process's argv, which `info()` does not
    report), and favourite forwards for hosts from the user's own config (they
    would need a Qutty host block).

- [x] **Clickable links: URLs and local paths.** ⌘-click (Ctrl-click elsewhere)
      opens what's under the pointer. It's underlined on hover with the modifier
      held, as other terminals do. A plain click still goes to the terminal
      (mouse reporting, selection).
  - **OSC 8 hyperlinks** first. Programs such as Claude Code, `ls --hyperlink`,
    gcc and delta already emit them. xterm.js supports them through its
    `linkHandler` option.
  - **URLs** found in plain output (`http(s)://`, `file://`, and also
    `mailto:`), e.g. with `@xterm/addon-web-links` or a custom
    `registerLinkProvider`. Trim trailing punctuation and closing brackets.
  - **Local paths** in plain output: absolute (`/…`, `~/…`) and relative
    (`./src/x.ts`, `src/x.ts`), resolved against the tile's current directory
    (`info().cwd`, or OSC 7). Only link a path that exists, checked lazily on
    hover through the desktop extension.
  - **What opening does.**
    - A URL opens in the default browser.
    - A folder is revealed in Finder (or the Linux file manager).
    - A file opens in its default app, or in an editor when it carries a
      `:line[:col]` suffix (`src/x.ts:42:7`, as compilers and test runners
      print).
    - A setting picks the editor command, e.g. `code -g {file}:{line}:{col}`,
      `zed`, or `$EDITOR` in a new tile.
  - **Needs:** an "open" desktop method (URL / reveal / open-with). Check
    whether Denext already has one before adding it to `desktop/pty.ts`.
  - **SSH tiles.** URLs work as usual. Remote paths can't be opened locally, so
    ⌘-click offers Download (see SSH) instead.
  - Maybe: a right-click menu on a link with Copy link / Open / Reveal.

- [x] **New Window.** Cmd+N opens another window, each with its own set of
      terminals, switcher bar and layout. A window still tiles all of its own
      terminals, as it does today.
  - Done (Denext 4.13): a window's key is its workspace's id. New Window (⌘N,
    `desktop.menu.window`) opens a fresh workspace, closing a window detaches
    it, Reopen Closed Window / the Dock / the Workspaces menu show a detached
    one again, one window per workspace (Denext keeps keys unique), and
    `desktop.app.restoreWindows` reopens at launch the workspace windows open at
    the last quit (frames and layouts back, fresh shells). The sandbox container
    is per workspace and stops when the workspace is ended (not when its window
    closes). Agent questions go to the window of their tile; the companion talks
    in the last-used window.
  - Maybe: drag a tile from one window to another (the PTY only changes owner:
    `createOwnedResources().attach` already allows it; the cross-window drag is
    the work).
  - Done (Denext 4.15): the Dock reopens the workspace detached last
    (`onDockReopen`), opened windows inherit the title bar, Reopen Closed Window
    is a list by title, an ended workspace's key is forgotten, the ⌘Q guard asks
    with the OS's message box (works with no window open), and the Window menu
    has "Close Window and End Its Shells" (no shortcut; asks when an agent there
    is busy).
  - Done: the close button asks whether to keep the window's shells running or
    end them (`onCloseRequested`; app/use-window-close.ts), with "Remember my
    choice" and Settings → Windows → "When a window closes" (ask / keep / end).
  - Done: tray mode (desktop/tray.ts, Denext's backend tray). The menu-bar /
    tray icon is always there; its menu has New Window, the workspaces with
    terminals (open ones checked; the first 15) and Quit Qutty. With the last
    window closed and terminals running the app lives there (macOS: the
    `"accessory"` policy, no Dock icon, until a window opens); with none left it
    quits. Without a tray host the old behaviour stays. Opening Qutty again
    while it runs brings a window back (macOS: the Dock's reopen; Linux /
    Windows: `desktop.app.singleInstance` and
    `runDesktop({ onSecondInstance })`).
  - Done (Denext 4.16): "Close Window and End Its Shells" is a
    `desktop.menu.window.items` entry handled once, for the key window, by the
    `session` extension; the quit guard waits for the user's answer; the tray
    quits through the typed `DesktopRuntime.quit()`; a second launch is
    `runDesktop({ onSecondInstance })` (docs/denext-multi-window-proposal.md,
    "After 4.16").
  - Later: `defaultWidth` / `defaultHeight` for a new workspace's window, and
    the replay's `dropped` / `truncated` (Denext 4.15 has both).

- [ ] **Switch to Denext's PTY capability** once it lands (being added to Denext
      alongside multi-window support and Deno Node-compat fixes for node-pty).
      Then drop most of `desktop/pty.ts`: the libc I/O, fd-leak cleanup,
      spawn-helper handling and Linux build script.

- [x] **Lite system monitor and hot Loopy** (`lib/sysstats.ts`,
      `app/use-sysstats.ts`, `app/sys-meter.tsx`).
  - Done: CPU, GPU and memory pressure from Denext's `system.stats()` (the
    `systemStats` capability, Denext 4.15); the bar meter; the hot face with
    hysteresis; Settings → System monitor. Qutty's own Mach / IOKit FFI and
    `/proc` readers are gone.
  - Later: per-core bars (`system.stats({ perCore: true })` gives `cpu.cores`);
    Intel GPUs on Linux (Denext reports `null`: no busy figure without
    `intel_gpu_top`).

- [x] **Loopy's reactions** (`lib/companion/reactions.ts`, `sleepy.ts`,
      `loopy-priority.ts`, `lib/shell-marks.ts`, `app/use-reactions.ts`,
      `app/companion/use-loopy-sleep.ts`, `use-loopy-reaction.ts`).
  - Done: OSC 133 marks from the zsh / bash plugins (and any shell integration
    that sends them); celebrate / sad over long build-like commands and agents'
    status notes, rate-limited; sleepy at night with a wake-up stretch; one
    priority function for every face; Settings → Companion → Reactions.
  - Later: use the marks for more (jump between prompts, select a command's
    output, a failed-command gutter mark); bash's `C` mark through `PS0` on bash
    ≥ 4.4 (today bash reports the line and duration with `D`); a fish plugin.

- [x] **Ollama helper** (`desktop/ollama.ts`, `lib/ollama/`,
      `app/ollama-*.tsx`). Shipped in 0.3.1; the "Open" items below remain.
  - Done: model tracking (CLI in hidden PTYs, `show` cached by digest, no
    `ollama list` while the server is down), the `+` menu section and dialog
    (harness × model, recent pairs, no-tools warning), Pull a model…, the
    ollama.com library (search, Applications per model, Pull & launch, "new"
    badge), Settings → Ollama, "+ opens" a pair, hub wiring per harness
    (`lib/hub/wiring.ts`), Hermes in Agent integration.
  - Open: hooks for mid-turn delivery beyond Claude Code and Codex: OpenCode and
    OpenClaw only have JS/TS plugin hooks (a small plugin that calls
    `qutty-hook` would do), Hermes's shell hooks take another input and ask for
    consent, Qwen Code and Kimi have Claude-style hooks but no per-session way
    to add them. Until then their messages arrive through `read_messages`.
  - Open: verify the wiring of the harnesses not installed here (Qwen Code,
    Copilot CLI, Kimi, DeepSeek Harness), and find routes for Droid, Cline, OMP,
    Muse and Pool (config files only).
  - Open: OpenClaw's first `ollama launch` runs its onboarding, which writes the
    config; the hub wiring needs that config, so it applies from the second
    launch on.
  - Open (watch): the library is read from ollama.com's HTML (it has no search
    API): if the markup changes, the parser returns less, never junk. Watch the
    fixtures.

## Pending

- [x] Name: **Qutty** (reads "cutie", Q for quantum, hidden tty; Kazakh құтты =
      "blessed", as in "Qutty bolsyn!" = congratulations). Renamed 2026-11-04;
      bundle id `org.qutty.Qutty`.
- [x] Domain: **qutty.org** (registered 2026-11-04).
- [x] On GitHub as `Brainwires/qutty` (private), with CI and a signed release
      workflow. Denext now comes from JSR (`jsr:@denext/denext`).
- [x] v0.1.0 published (2026-11-04); repository public.
- [x] v0.2.0: tagged, never published (its release run hit runner issues).
- [x] v0.3.0: SSH, shell picker, scaled tiles, Homebrew, agent hub, companion,
      voice, shared sandbox.
- [x] v0.3.1: Codex, Ollama helper, more harnesses, shell agent, lively Loopy.
- [x] v0.4.0: detachable sessions and New Window, Linux packages, SSH broadcast
      input and port forwards, clickable links, CPU / GPU meter, Loopy reacts.
- [x] v0.5.0: Denext 4.15 (system.stats meter, native quit dialog, Dock reopen,
      Reopen Closed Window list, Close Window and End Its Shells, Linux
      metainfo), cloud voices and the API key brain with keys in the keychain.
- [ ] Switcher bar: after a focus change the chip strip's smooth scroll often
      doesn't run, so the focused chip (first in the strip) can stay scrolled
      out of view on the left (seen while hardening the e2e chip clicks, #43).
- [x] Flaky test: with Reduce Motion forced on (`E2E_REDUCED_MOTION=1`), "bar
      overflow: +N appears…" in tests/e2e/bar_test.ts failed about half the
      time. Not a test timing issue but two bar bugs: the focused chip was
      scrolled to its FLIP-inverted (old) place, and a FLIP superseded before
      its frame left chips displaced for good (app/switcher-bar.tsx).
- [x] CI hangs (two jobs ran into GitHub's 6 h limit on the 0.3.1 PR): the hub's
      poll loop handed a closed fd's revents to a new connection under the same
      number (a blocking `read` on Linux), and the e2e harness waited on a
      stalled page without a bound. Fixed; every CI job has `timeout-minutes`.
- [x] Linux packaging: the release builds an AppImage, a `.deb` and a tarball
      for x86_64 and arm64 on GitHub's Ubuntu 24.04 images, installs each and
      runs the PTY self-test under Xvfb. Best-effort: a Linux failure does not
      hold back the macOS release. Pull requests that touch the packaging run
      the same build as a dry run. Open: the AppImage is not self-contained (it
      needs the host's WebKitGTK; its AppStream metainfo says so).
- [x] Denext 4.15's Linux packaging: the `.desktop` entries (terminal
      categories, keywords, `GenericName`, `StartupWMClass`), the bundle's own
      entry (Name, Icon), AppStream metainfo, the pinned AppImage runtime and
      `buildDesktopAppImage` come from denext (denext.config.ts
      `desktop.linux`); scripts/package-linux.ts is the regenerated template
      again, with no Qutty retagging or repacking.
- [ ] `desktop.installers.email` for the `.deb` Maintainer and the metainfo's
      update contact, once Qutty has a public contact address.
