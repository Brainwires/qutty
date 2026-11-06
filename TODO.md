# TODO

## Later

- [ ] **Detachable sessions.** Closing the window must not close the terminals.
      Reopening the app reattaches to every running shell, with its scrollback,
      tile layout and focus order intact (like tmux/screen detach, but built
      in).
  - The PTYs currently live in the desktop extension (`desktop/pty.ts`) inside
    the app process, so they die with it. They need a long-lived host that
    outlives the window: a background daemon, or keeping the app alive with no
    window (menu-bar / Dock-only).
  - On reattach, replay each terminal's recent output (a per-PTY ring buffer) so
    xterm.js redraws it.
  - Decide what quitting means (Cmd+Q) versus closing the window, and how to
    kill a session for real.

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

- [ ] **Companion + agent hub** (plan: phases 1–4).
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
  - Next: voice (phase 2b: `CompanionRuntime.userSays(text, "voice")` is the
    transcript's way in, `subscribe` the answers' way out), the
    `@rullama/inference` brain adapter (`InferenceBrainOptions` is the typed
    TODO), dragging Loopy, a floating window (Denext multi-window), the
    shell-as-harness.
  - Done (phase 2c): the shared Docker sandbox (see below).
  - Open: Codex hooks (Codex has Claude-style lifecycle hooks behind
    `features.hooks`); for now Codex gets messages through `read_messages`.
    `qutty-hook` starts bash + nc per call (~0.2 s); a tiny relay could cut it.

- [x] **Sandboxed shells (Docker)**, as one shared container per window
      (Settings → Sandbox; `desktop/sandbox.ts`, `lib/sandbox/`).
  - Decided: a plain long-lived container. Docker Desktop's `docker sandbox` is
    removed in current releases (4.98 points at the separate Docker Sandboxes
    product: one agent per microVM, not several shells in one sandbox).
  - The hub over TCP + token (`QUTTY_HUB`, `QUTTY_TILE_TOKEN`), bound through
    libc like the unix sockets (no `net` permission); native Linux Docker gets
    `--add-host=host.docker.internal:host-gateway` and the hub also listens on
    the bridge gateway.
  - Open: Denext 4.12 has no window-closed hook, so a second window's container
    stops when the app quits (4.13's `onWindowClosed` can stop it earlier).
    Native Linux: files the root user creates in a read/write project mount are
    owned by root on the host (Docker Desktop maps them to you). Changing the
    image or mounts recreates the container on Restart (packages installed with
    apt go; `$HOME` stays). Network off also cuts the sandbox off from the hub.

- [ ] **SSH sessions and a connection manager.** Run the system `ssh` in a PTY,
      the same way shells run today. Never implement the protocol, and never
      store passwords. Keys, ssh-agent, the keychain, jump hosts, known_hosts
      and hardware keys all come for free from OpenSSH.
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
  - Maybe: broadcast typing to several selected SSH tiles (cluster ssh), and a
    per-host port-forward panel (`ssh -O forward` / `-O cancel` on the control
    socket, live).
  - Status: the backend and the UI are in (manager dialog, SSH tiles with tint /
    Disconnected / Reconnect, drop-to-upload, Download… picker, progress). Still
    open: SSH hosts in the `+` picker (no picker yet), "Connect in split" (the
    layout has no splits), choosing a download folder, auto-label + "Save this
    host" for `ssh` typed in a plain shell (needs the foreground process's argv,
    which `info()` does not report), the port-forward panel and cluster ssh.

- [ ] **Clickable links: URLs and local paths.** ⌘-click (Ctrl-click elsewhere)
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

- [ ] **New Window.** Cmd+N opens another window, each with its own set of
      terminals, switcher bar and layout. A window still tiles all of its own
      terminals, as it does today.
  - Check whether Denext's desktop runtime can open several windows from one app
    process. If it can't, that's another Denext gap.
  - **Combined with detach (the tricky part).** Proposed model: the long-lived
    PTY host owns _workspaces_, each one a named group of terminals with its
    layout, MRU order and settings. A window is just a view attached to one
    workspace.
    - Closing a window detaches its workspace; the terminals keep running.
    - On launch, reattach every workspace that was open, each in its own window.
      Cmd+N creates a new empty workspace. A "Reopen workspace" menu lists
      detached ones.
    - Decide: can two windows show the same workspace at once? (Simplest: no,
      one window per workspace.)
    - Maybe: drag a tile from one window to another to move the terminal between
      workspaces. The PTY stays put and only its owner changes.
  - Each window's state needs a stable workspace id, so restoring after a crash
    or relaunch doesn't mix up which terminals go where.

- [ ] **Switch to Denext's PTY capability** once it lands (being added to Denext
      alongside multi-window support and Deno Node-compat fixes for node-pty).
      Then drop most of `desktop/pty.ts`: the libc I/O, fd-leak cleanup,
      spawn-helper handling and Linux build script.

## Pending

- [x] Name: **Qutty** (reads "cutie", Q for quantum, hidden tty; Kazakh құтты =
      "blessed", as in "Qutty bolsyn!" = congratulations). Renamed 2026-11-04;
      bundle id `org.qutty.Qutty`.
- [x] Domain: **qutty.org** (registered 2026-11-04).
- [x] On GitHub as `Brainwires/qutty` (private), with CI and a signed release
      workflow. Denext now comes from JSR (`jsr:@denext/denext`).
- [x] v0.1.0 published (2026-11-04); repository public.
- [x] v0.2.0: SSH, shell picker, scaled tiles, Homebrew.
- [ ] Flaky test: with Reduce Motion forced on (`E2E_REDUCED_MOTION=1`), "bar
      overflow: +N appears…" in tests/e2e/bar_test.ts fails about half the time
      with a bare assertion. CI runs with animations on, where it passes. Find
      the timing assumption.
