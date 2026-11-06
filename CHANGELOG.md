# Changelog

## Unreleased

- Homebrew: `brew install --cask brainwires/tap/qutty`. Each release updates the
  cask automatically.
- Public repository, contributing guide, security policy and issue templates.
- Releases publish automatically when a version tag is pushed.
- SSH backend (no UI yet): hosts from `~/.ssh/config` (with `Include`) and
  `~/.ssh/qutty.conf`, saved hosts written only to the latter, the system `ssh`
  run in a tile with a shared connection (`ControlMaster`), and scp/sftp upload,
  download and directory listing over that connection with progress and cancel.
  A terminal can now run a program other than the login shell.
- SSH connection manager (⌘⇧O, or the button next to `+`): filter your hosts
  from `~/.ssh/config` and Qutty's own, grouped as Favorites, Qutty hosts,
  `~/.ssh/config` and Recent; ↑/↓ and Enter to connect in a new tile, or type
  `user@host:port` to quick-connect and save it afterwards. Add, edit, rename
  and delete Qutty hosts (tint, tags, favorite, tmux on connect, remote
  command); hosts from your own config are read-only and can be duplicated.
- SSH tiles: the host's name and an SSH badge in the header and the bar, an
  optional tint from the theme's palette (red, orange, yellow, green, blue,
  purple) on the border, and a Disconnected card with Reconnect instead of a
  restart on Enter.
- File transfer on SSH tiles: drop files or folders from Finder to upload them
  to the remote shell's current folder (from OSC 7, else `~`, editable before
  you confirm); "Download…" in the tile header browses the remote side and saves
  to `~/Downloads`. Progress, Cancel and errors show on the tile.
- New "Inactive tiles" setting (Layout section). `scale` keeps every terminal at
  the focused tile's size and shows the others scaled down, so focusing a tile
  never resizes its terminal and full-screen programs (vim, htop) are not
  garbled. A click on a scaled tile focuses it. `resize`, the current behavior,
  stays the default.
- Shell picker on the `+` button: the arrow beside `+` lists the installed
  shells (from `/etc/shells`, deduplicated, the default marked), agent tools
  found on `PATH` or in your user bin folders (Claude Code, Codex, Gemini CLI,
  Aider, opencode), your SSH hosts and "Connections…". Mouse or ↑/↓, Enter and
  Escape; works with the bar on any edge. Agent tools run directly (the tile is
  titled "claude — ~/proj") and their tile closes when they exit. The last pick
  is remembered, and Settings → Layout → "+ opens" chooses what plain `+` and ⌘T
  open (default shell, last used, or one entry).
- Agent hub: every terminal gets its own MCP server, so coding agents in
  different tiles (Claude Code, Codex, any MCP client, any account) can list
  each other, read any tile's screen and scrollback, message each other or the
  whole window, and ask you a question with buttons. Messages reach a Claude
  Code agent between tool calls or when it would stop (through its hooks), or
  any agent through `read_messages` / `wait_for_message`. Claude Code and Codex
  started from the `+` picker are connected automatically; for agents started by
  hand, Settings → Agent integration installs (and removes) the user-scope
  registration, showing exactly what it changes and keeping backups. Agent tiles
  show the agent's name, busy / idle / waiting and unread messages in their
  header.

## 0.1.0 — first release

- Tiling terminal for macOS (Apple Silicon and Intel): every terminal in one
  window.
- Cascade layout: the focused terminal is largest and tiles shrink the longer
  they go unused.
- Seven layout patterns (cascade, spiral, master-stack, columns, rows, grid,
  monocle) with animated transitions; adjustable master ratio and gap.
- Switcher bar, horizontal or vertical, holding the terminals that overflow the
  cluster.
- Adjustable font typeface and size, with detection of installed monospace
  fonts.
- Six color themes, three dark (Sea Glass, Plum, Ember) and three light (Paper,
  Cloud, Sakura), with preview tiles; they switch every terminal live.
- Collapsible Layout, Theme and Fonts sections in the settings panel.
- Keyboard shortcuts for creating, closing, focusing and cycling terminals.
- Honors your macOS key bindings
  (`~/Library/KeyBindings/DefaultKeyBinding.dict`) inside the terminal, e.g. a
  ⌘⌫ bound to "delete to start of line".
- Mouse reporting for full-screen programs (vim, tmux, htop), including the
  legacy encoding past column 95.
- Signed with a Developer ID and notarized.
