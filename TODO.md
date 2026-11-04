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

- [ ] **Shell picker on the `+` button.** A dropdown arrow attached to the side
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

- [ ] **Sandboxed shells (Docker).** Offer "Sandboxed shell" in the `+` picker:
      a terminal whose shell runs inside a Docker sandbox, isolated from the
      Mac, so untrusted scripts or AI agents (Claude Code, Codex) can run
      freely.
  - Check what recent Docker Desktop provides (`docker sandbox …`: which agents
    and images, and whether a plain shell is supported) and what it needs
    (Docker Desktop running, version).
  - Only list it when Docker is installed and running; show a clear message
    otherwise.
  - Decide what the sandbox can see: the current directory mounted, network on
    or off, and whether it is discarded when the tile closes.
  - Mark sandboxed tiles visibly (a badge or tinted header) so you always know
    where you are.

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
- [ ] Publish the v0.1.0 draft release, then decide when to make the repo
      public.
- [ ] Flaky test: with Reduce Motion forced on (`E2E_REDUCED_MOTION=1`), "bar
      overflow: +N appears…" in tests/e2e/bar_test.ts fails about half the time
      with a bare assertion. CI runs with animations on, where it passes. Find
      the timing assumption.
