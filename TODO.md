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
  - Done: detach that survives quitting the app. With Settings → Windows → "Keep
    shells running after quitting" (on by default) the tiles' shells run in a
    per-user PTY daemon (`desktop/ptyd.ts`, `qutty-ptyd`: the app's own
    executable started headless by the `ptyd` sidecar, detached; a versioned
    protocol on `/tmp/qutty-<uid>/ptyd-<v>.sock`, peer uid checked). ⌘Q asks
    "Keep Shells Running" (the default) / "End Shells" / Cancel (naming a busy
    agent); the next launch adopts every kept shell with its replay and the
    page's snapshot, so the restored windows come back on their running shells
    (`desktop/kept-shells.ts`). Without the daemon (a reboot) the shell tiles
    start again in their last folder with their old text dimmed above the
    prompt. `QUTTY_PTY_SELFTEST=persist` checks it in the packaged app.
  - Open: kept agent tiles keep their old `QUTTY_SOCK` / hub env (the hub's
    per-launch socket folder is gone): their hub integration needs a restart.
    Sandboxed tiles are not kept. Denext has no supported way to run a process
    that outlives the app (sidecars end with it), so the daemon is a detached
    `spawnSelf` child; a Denext "detached sidecar" would make it first-class.
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
  - Done (phase 2): the companion in a corner (`app/companion/`,
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
    Stop buttons and the review box on the companion, Settings → Voice.
  - Voice, open: bundle `librullama_audio_ffi` per architecture in the app
    (Denext's packager has no option for extra files yet: see
    docs/denext-speech-recognition-proposal.md, "Related gap"); until then it is
    installed into the app-support folder by `deno task audio:lib`. The OS
    recognizer (`SFSpeechRecognizer`) waits on the Denext proposal in the same
    doc. ElevenLabs text to speech needs `output_format` sent as a query
    parameter in `@rullama/provider-speech` (it is ignored today, so the reply
    is mp3, which the library cannot play); Deepgram Aura is used instead.
    OpenAI Realtime (the voice of Denext's example companion on
    `feat/loopy-voice-tools`) can be one more optional cloud engine behind the
    same adapters.
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
    plays the file; `QUTTY_PTY_SELFTEST=1` (desktop/pty.ts) checks the runtime's
    `Deno.openPty`, starts the login shell as a tile does, has it answer, and
    exits. Streaming transcripts (partials) and a wake word are possible with
    the same library.
  - Voice, done: hold-to-dictate into a web tile with the native engine
    (`WebViewHandle.insertText`, lib/web/native-engine.ts `insertTextScript`
    through the view's `evaluate`). The iframe engine still reaches only a
    same-origin page, which it never shows, so there a web tile says it can't
    take text.
  - Voice, done (Denext 4.20): a native web view reports a forwarded key's
    release (`keyup`, `webViewCapabilities().keyUp`), so a talk key held in a
    page is a hold. An engine without `keyUp` still latches it like a short
    click on the mic until the next press.
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
    `fetch`). A fresh session forgets the earlier turns without a summary; the
    companion does not say so yet. The limit is checked at a turn's start, so
    one turn's tool rounds can grow past it. An OpenAI key brain
    (`OpenAiChatProvider`, api.openai.com) would be one more engine and host.
  - Done: dragging the companion (snaps to the nearest corner, which is the
    Corner setting) and the mic level driving its listening pulse (`level`
    events from desktop/voice.ts, ~20 Hz while capturing).
  - Done: a floating window (Settings → Companion → Floating;
    desktop/companion-window.ts, app/companion/floating-companion.tsx, the
    `/companion` route). One transparent, frameless, non-activating window for
    the app, on top, off the taskbar, clicks let through outside the companion
    (a hit region, else forwarded click-through), dragged by the companion and
    reopened where it was dropped, on every Space unless turned off. Once its
    page is ready every `ask` and `say` goes to it (a detached workspace's
    questions too) and the workspace windows draw no companion; `companion` goes
    to every window. Its chat box takes the keyboard (`focusWindow`), and
    closing the chat hands it back to the last-used workspace window. With every
    workspace window closed it stays (the app lives in the tray while terminals
    run); tray mode, the Dock's reopen and tile moves ignore it. Floating is
    grayed out with the reason where the system can't float it (no transparent
    window, no click-through, Wayland without layer-shell, the browser demo),
    and the companion stays in the window there.
  - Floating, open: never hand-checked in a real window yet (the logic is unit
    tested, the page in the demo e2e). The hot face and the reactions to
    finished jobs are not shown while floating (they follow a window's tiles),
    and push-to-talk from a workspace window sends without the review box and
    without the floating face listening. Typing into the floating chat box on
    Linux (a layer-shell surface made with `focusable: false`) is untried.
  - Done: the companion's own lines (Settings → Companion → Messages;
    lib/companion/ambient.ts, app/companion/use-companion-ambient.ts). A quote
    of the day (on by default; 217 public-domain quotes in
    lib/companion/quotes.ts, picked by hashing the local date) at startup and at
    the first interaction after midnight, once a day across windows (a claim in
    shared storage; the floating companion follows the windows' activity through
    `storage` events). Encouragement (off by default; 90 original lines in
    lib/companion/encouragements.ts, a no-repeat bag) after 20–40 / 45–90 /
    120–240 minutes of active use, only when nothing else wants the companion.
  - Done: voice mode (Settings → Voice and → Companion, the speaker button
    beside the mic; lib/voice/bubble-speech.ts,
    app/companion/use-bubble-speech.ts). Everything in the bubble is said with
    the chosen voice: answers sentence by sentence as they stream, `say`
    messages, questions with their buttons, the quote with its author,
    encouragement; mail turns and errors as a short summary; code, markdown and
    URLs left out. A new bubble cuts off the old one's speech, closing a bubble
    stops it, barge-in stops the rest of a stream. One window speaks
    (lib/voice/speaker.ts): the floating companion while it shows, else the
    workspace window that last had the focus or input (Speak answers follows the
    same election now).
  - Done: companion looks (Settings → Companion → Look; lib/companion/looks.ts,
    lib/companion/look-build.ts, desktop/companion-looks.ts, the `looks`
    extension; docs/companion-looks.md). A look is a folder in the app-support
    folder's `companions/`: `look.json`, one picture per mood (only `idle`
    required, a fallback chain to it), `speak-N` mouth frames, a scoped and
    sanitized `look.css`. Read with links and sub-folders skipped and size caps,
    sent as data: URLs, drawn in an `<img>` that takes the drawn face's moves. A
    test look, Pixel Blob, is in tests/fixtures/looks (not built in).
  - Looks, open: never tried in the real app (the folder reading is unit tested
    on a temp folder, the page in the demo e2e). No file watching: a changed
    look needs Reload looks. A look's own animated pictures (GIF, animated SVG)
    play, but a look cannot add moves or keyframes of its own (CSS nesting drops
    a nested `@keyframes`).
  - Messages and voice mode, open: never heard in the real app yet (the demo e2e
    uses a recording fake engine). The floating companion's speaker button
    writes the shared settings itself (the workspace windows follow them). The
    reaction line beside the companion and the hot line are not part of voice
    mode (they keep their own voice-alert rules). A window that crashes without
    `pagehide` keeps the speaker claim until another window is focused or used.
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
  - Not doing: a faster relay for `qutty-hook`. Measured 2026-11-18 on the
    M-series Mac (bash 3.2, BSD nc, against a unix-socket stand-in for the hub):
    ~16 ms per call, ~5 ms of it the `nc -h` probe; not the ~0.2 s noted before.
    A compiled relay would save ~14 ms per hook call (hooks run per tool use,
    next to seconds of model time) but means another signed binary per
    architecture in the bundle, plus static Linux builds for the sandbox
    container, where the same script runs. The app's own executable in a light
    mode starts a JS runtime (a bare `deno eval` alone is ~18 ms here), so it is
    no faster than bash.

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
  - Done: drag a tile from one window to another (desktop/tile-move.ts,
    app/use-tile-move.ts). The PTY only changes owner (`attach`) and workspace;
    the source snapshot loses the tile and the target holds it as a pending
    arrival in one step, until the target page saves it. The gesture: a header
    dragged out of its window sends its screen point (`screenX`/`screenY`,
    calibrated against the source window's Denext frame) to the app process,
    which hit-tests the other windows' `getBounds` front to back by focus order
    and tells the one under it (`dragHover`, which marks the drop slot).
    Released over no window, the tile tears off into a new window at the pointer
    (unless it is the window's only tile). The header's right-click menu has
    "Move to Workspace N" / "Move to New Window"; `requestTileMove`
    (desktop/session.ts) is there for a native Window-menu item. A web tile
    moves as its page. The last tile leaving closes its window. A moved
    sandboxed tile keeps its first workspace's container (`onRetired`).
    `QUTTY_PTY_SELFTEST=move` checks it in the packaged app.
  - Maybe (needs Denext): the real z-order of the app's windows (the drop goes
    to the most recently focused window under the pointer), and a cross-window
    drag session (the pointer's screen position and the window under it from the
    OS, instead of the page's pointer capture and the windows' frames).
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
  - Done: the macOS Dock menu, like iTerm2's (desktop/dock-menu.ts): the open
    workspace windows (the frontmost checked; a click brings it forward), New
    Window, New Terminal (in the frontmost window, else a new one), "Claude Code
    (chat)" when Claude Code is installed, and Reopen Closed Window ▸ (the
    detached workspaces with running terminals). The app process sets it on
    `Deno.dock` directly, so it works with no window open and outlives page
    reloads; a window's commands wait for its page (`session` extension,
    `takeDockCommands`). Not tried in a real window yet.
  - Needs Denext: a backend Dock menu (`DesktopRuntime.setDockMenu` /
    `onDockMenuItem`). `setQuickActions` / `onQuickAction` from a page take
    titles only (no separators, checks or submenus), and a click goes to every
    open window's page and to none with no window open, so Qutty goes around
    them to the runtime's `Deno.dock`. Open: SSH connections in the Dock menu
    (the host list and the connect live in the page).

- [x] **Switch to Denext's PTY capability** once it lands (being added to Denext
      alongside multi-window support and Deno Node-compat fixes for node-pty).
      Then drop most of `desktop/pty.ts`: the libc I/O, fd-leak cleanup,
      spawn-helper handling and Linux build script.
  - Done (Denext 4.18, runtime 3.0.0-denext.22): `PtyHost` runs on the runtime's
    `Deno.openPty` (what Denext's `pty` capability is built on), behind the same
    interface; node-pty, its libc master I/O, the fd-leak clean-up,
    spawn-helper, the Linux build script and the `jailScripts` entry are gone.
    The app bakes `--allow-run` (unscoped). The unit tests run on denext's
    toolchain (`deno task test`). Denext's page-facing capability itself is not
    used: a shell allow-list and window-owned terminals do not fit the workspace
    terminals, the hub's environment or ssh/docker/agent programs.
  - Denext gaps: the runtime's PTY has no foreground process / tty queries
    (macOS `info` reads `proc_pidinfo` over FFI; Denext's own `info` answers
    nothing there).

- [x] **Lite system monitor and the hot companion** (`lib/sysstats.ts`,
      `app/use-sysstats.ts`, `app/sys-meter.tsx`).
  - Done: CPU, GPU and memory pressure from Denext's `system.stats()` (the
    `systemStats` capability, Denext 4.15); the bar meter; the hot face with
    hysteresis; Settings → System monitor. Qutty's own Mach / IOKit FFI and
    `/proc` readers are gone.
  - Later: per-core bars (`system.stats({ perCore: true })` gives `cpu.cores`);
    Intel GPUs on Linux (Denext reports `null`: no busy figure without
    `intel_gpu_top`).

- [x] **The companion's reactions** (`lib/companion/reactions.ts`, `sleepy.ts`,
      `face-priority.ts`, `lib/shell-marks.ts`, `app/use-reactions.ts`,
      `app/companion/use-companion-sleep.ts`, `use-companion-reaction.ts`).
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
- [x] **Web tiles.** ⌘-click a URL in a terminal to open it in a tile beside it
      (`lib/web/`, `app/web-tile.tsx`): back, forward, reload / stop, an address
      field and "Open in default browser"; saved and restored with the workspace
      (`TileSnapshot` `{ web: { url, title? } }`), no PTY.
  - The iframe engine (`IframeEngine`, `lib/web/engine.ts`): the browser demo
    and any runtime without web views. It shows loopback and local dev pages
    only (most public sites refuse to be framed), and it cannot read a
    cross-origin page's title or the navigations the page makes itself (the tile
    keeps its own back/forward list).
  - [x] The native engine (`lib/web/native-engine.ts`, Denext 4.18's
        `createWebView` + `attachWebView`): `detectWebEngine()` asks
        `webViewCapabilities()` at boot and `webEngine()` answers it when
        `supported`. Any http(s) site opens in a tile, logins persist (the
        `qutty-web` partition), titles and in-page navigations are reported,
        popups open in a new tile, downloads ask, permission prompts are
        refused. A view draws above all HTML, so while HTML must show over a
        tile the view swaps itself for a snapshot (`setOccluded`: the overlay
        count and the area overlays of `lib/web/overlays.ts`, a tile on top in
        the free-form view, any tile moving), and it leaves room for what stays
        over it (the companion, the broadcast banner). The workspace's shortcuts
        and the talk keys come back from a page as forwarded keys
        (`forwardAccelerators`, lib/workspace/keys.ts). Checked in the packaged
        app without the UI by `QUTTY_PTY_SELFTEST=webview`
        (desktop/webview-selftest.ts).
  - [ ] Native engine, not seen on a real window yet: the snapshot swap, the
        keyboard hand-off (the view's `blur()` gives the keyboard back to the
        app's page, Denext 4.20) and the forwarded keys are unit-tested against
        a fake of Denext's views and the self-test covers create / load / title
        / evaluate / capture; a pass by hand over menus, drags and the cycle is
        still due.
  - Done: `read_screen` of a web tile is its page as `read_page` reads it
    (title, URL, visible text, numbered elements, through `evaluate`); where the
    window cannot look inside the page (the iframe engine, a closed window) it
    answers with the title and URL the hub knows and a `note` saying why. Find
    in page (⌘F, the find bar, ⌘G / ⌘⇧G) and the developer tools (⌥⌘I, the page
    menu's Inspect) were there already; the page menu now has Find in Page…, and
    the View menu has Find in Page… and Developer Tools for the focused web tile
    (no accelerators: the keys are the page's, and a window accelerator would
    take Ctrl+F from terminals on Linux). Zoom is per tile (View → Zoom In / Out
    / Actual Size).
  - [ ] Needs Denext: Qutty UI for a page-initiated download (progress, done →
        Reveal in Finder) and for a permission request (Allow / Deny bar in the
        tile). Denext 4.20's web view only has policies
        (`downloads: "deny" |
        "ask" | "browser"`,
        `permissions: "deny" | "ask"`) and fires no download or permission
        events, so a tile cannot show either; today a download opens the OS save
        panel (`"ask"`) and prompts are refused (`"deny"`).
  - [ ] `[::1]` pages open in the default browser with the iframe engine: a CSP
        host-source has no IPv6 literal, so the page's `frame-src` cannot allow
        them (the native engine is not bound by the page's CSP and shows them).

- [ ] Tiles in place (Settings → Layout → "Focused tile moves to the main spot"
      off; `lib/workspace/tile-order.ts`): tiles swap by a header drag. Maybe: a
      keyboard way to move the focused tile to the next / previous slot, once
      there is a free binding that suits it (none is bound today).

- [ ] **Agent tiles** (a "TUI-looking GUI" for coding agents, a native tile kind
      beside terminals and web tiles).
  - Done (phase 1): Claude Code as a chat tile (`app/agent-tile.tsx`,
    `lib/agent/`, `desktop/agent-*.ts`): headless `claude -p` in stream-json
    mode in a hidden PTY, each session a hub tile of its own; a terminal-styled
    transcript (tool calls as `● Tool(arg)` rows with `⎿` summaries, diffs,
    command output, markdown), permissions through the hub's `approve_tool`
    (Allow / Allow always / Deny in the transcript), the prompt box (queue,
    attachments, ↑ history, Esc), the model picker, Open in terminal, New
    session, restore with `--resume` under a saved copy of the rows, the Agents
    panel (Needs you / To review / Working), dictation, `read_screen` /
    `write_tile` on an agent tile.
  - [x] A Codex adapter: `codex app-server` (JSON-RPC: approvals, streaming,
        `model/list`, `thread/resume`), lib/agent/codex-app-server.ts and
        desktop/agent-codex.ts; the demo has a scripted server
        (lib/agent/codex-demo.ts).
  - [x] An Ollama / API-key adapter through `lib/companion/inference-brain.ts`:
        lib/agent/inference-agent.ts (Read / Write / Edit / Bash, asked through
        `hooks.approve`), desktop/agent-inference.ts.
  - [ ] Codex: a turn's live command output (`outputDelta`) in the running row,
        `turn/steer` for a message typed while it works (today it waits in the
        queue), the reasoning effort in the header.
  - [ ] Ollama / API agent: streamed replies (the loop calls the provider
        unstreamed), images for the API, a Grep / Glob tool of its own.
  - [x] A Changes tab: the session's edits as one diff to review (accept,
        revert, open in the editor). From the tool rows
        (`lib/agent/changes.ts`); revert restores the original when the file is
        as the agent left it, else undoes edit by edit, only inside the
        session's folder.
    - Open: reviewed / accepted marks live in the page (lost on reload); a
      `git diff` view of changes made outside tool calls (Bash) is not shown.
  - [x] Avatars for agents (`lib/agent/avatar.ts`, in the backend's colour:
        `agentHarness` reads the tile's `AgentKind`).
  - [x] Per-agent roles / presets (system prompt, model, permission mode,
        allowed tools), picked in the `+` menu; edited in Settings → Agents.
  - [x] The permission mode in the header (ask / accept edits / plan / bypass).
  - [x] Interleave a permission question with its tool row, and a resumed
        session's history from Claude Code's own transcript file instead of only
        the saved copy.
    - Codex: the Changes tab shows its file changes (each file's diff) but has
      no Revert (Codex reports diffs, not edits Qutty can undo); a preset's
      system prompt and allowed tools are not passed to Codex yet.
  - Not doing: embedding t3code (sidecar, worker mode, PTY adapter). The agent
    tile replaces it (decided 2026-11-17).

- [x] **Skins** (Settings → Appearance → Skin; docs/skins.md). A skin restyles
      the chrome through a documented contract (`data-part` hooks and stable
      classes, `lib/skins/parts.ts`), scoped by `data-skin` on `<html>`.
      Built-in: Qutty and Classic (`public/skins/classic/`, linked always). User
      skins are folders in `<app support>/skins/` (`desktop/skins.ts`): checked,
      the stylesheet sanitized (`lib/skins/skin.ts`: no `@import`, no remote
      `url()`), assets inlined as `data:` URLs, applied as a constructed
      stylesheet (the CSP allows no inline `<style>`). Tile frame options
      (buttons left / right, title alignment) as `data-frame-*` on `<html>`.
  - Open: the floating companion's window does not take the skin or a skin's
    colours (it applies the chosen theme only). No hover preview in the picker
    (a skin restyles the Settings dialog under the pointer). The user skin's
    stylesheet arrives after the first paint at launch (the built-ins do not
    have this: their stylesheets are linked). Classic is tuned for its own grey
    colours; with "Use the skin's colours" off it follows the theme but dark
    themes get stark bevels. Not tried in the packaged app: the `skins`
    extension, the folder button and `data:` fonts under the desktop CSP
    (`font-src 'self' data:` allows them on paper).

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
- [x] v0.3.1: Codex, Ollama helper, more harnesses, shell agent, a lively
      companion.
- [x] v0.4.0: detachable sessions and New Window, Linux packages, SSH broadcast
      input and port forwards, clickable links, CPU / GPU meter, the companion
      reacts.
- [x] v0.5.0: Denext 4.15 (system.stats meter, native quit dialog, Dock reopen,
      Reopen Closed Window list, Close Window and End Its Shells, Linux
      metainfo), cloud voices and the API key brain with keys in the keychain.
- [x] v0.5.1: Denext 4.18, browser tiles, free-form (MDI) view, tile Minimize /
      Maximize / Restore, activity indicators and program titles, tray mode, the
      close-button question.
- [x] v0.6.0: Claude Code chat tiles, native browser tiles with bookmarks and
      history, the companion drives web tiles, Settings dialog, native menus,
      Denext PTY + qutty-ptyd (shells survive quitting), tiles move between
      windows, companion rename and new icon, broadcast picker.
- [x] v0.6.1: Denext 4.20 (web tile key releases, blur, CSP-safe evaluate), a
      GUI overlay around agent harnesses, agent tile prompt box and side rail.
- [x] v0.7.0: Codex, Ollama and Anthropic API agent tiles, the Changes tab,
      agent presets, permission mode in the header, avatars, per-tile zoom (Zoom
      All Tiles Together), Maximize Tile, Find in Page and Developer Tools
      menus, the qutty.org website.
- [x] v0.7.1: Denext 4.20.1 (web view cursor and CEF security fixes), the Dock
      menu (New Window, New Terminal, agent chats, open windows, Reopen Closed
      Window), the floating companion window.
- [x] Switcher bar: after a focus change the chip strip's smooth scroll often
      didn't run to the end, so the focused chip (first in the strip) could stay
      scrolled out of view on the left (seen while hardening the e2e chip
      clicks, #43). A smooth scroll that stops short fires no event at all. The
      bar now aims at an absolute place and aims again when the strip settles
      (scrollend, a glide's end, a resize) or stands still for 8 frames (a frame
      watch, only while the reveal is pending), until the chip is in view; a
      wheel, a press in the strip or a scroll away from the aim (a script's
      `scrollIntoView`) drops it (`chipScrollTarget`, lib/workspace/bar.ts; e2e
      "chips: the focused chip comes into view…").
- [x] A harness tile's frame noticed the harness quitting late when the tile was
      not focused and its shell had no OSC 133 marks. The PTY extension now
      checks the terminal's foreground process group as output flushes and flags
      a change on the `data` event (`fg`); the page reads `info` then
      (desktop/pty.ts `foregroundGroup`, `PtyBackend.onForeground`).
- [x] A quit with "Keep Shells Running" right after a tile moved to another
      window dropped the tile from the kept record (it was still a pending
      arrival there); the record now takes pending arrivals into the snapshot.
- [x] Flaky `tests/codex_trust_test.ts` (Codex asked twice): the hub's start-up
      integration check, overtaken by an Install, cleared the verdict the
      Install had just cached. An overtaken check no longer touches it.
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
