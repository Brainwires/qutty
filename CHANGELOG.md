# Changelog

## Unreleased

- An Ollama helper. When Ollama is installed, the `+` menu gets an Ollama
  section: the harness × model pairs you launched recently, and "Ollama
  models…", a dialog to pick a terminal harness (Claude Code, Codex, OpenCode,
  Hermes Agent, OpenClaw, Qwen Code, Copilot CLI and the other `ollama launch`
  integrations) and a pulled model. It shows each model's size, capabilities
  (tool calling, vision, thinking) and whether it is loaded right now. A model
  without tool calling is marked, and Qutty asks before starting an agent on it.
  The tile runs `ollama launch <harness> --model <model>`, is titled "claude ·
  qwen3.8:27b-mlx — ~/project", and closes when the harness exits. "Pull a
  model…" opens a tile running `ollama pull`, and the list picks the new model
  up when the pull ends. The Library tab searches ollama.com, with popular or
  newest first and an option to show only models with tool calling. It shows the
  harnesses each model is listed for, and has Pull and Pull & launch. A "new"
  badge counts models updated since you last looked.
- Settings → Ollama shows the version, whether the server runs (with Open Ollama
  when it does not), the model table, and Refresh. You can also choose a default
  harness and model there. A pair is a `+` menu entry, so "+ opens" can open it.
- Every harness started from the `+` menu or through Ollama joins the agent hub,
  where its wiring allows. Claude Code and Codex get their hub flags after
  `ollama launch`'s `--`. OpenCode gets an extra config layer
  (`OPENCODE_CONFIG`) and a private server. OpenClaw runs its local terminal UI
  on a config that includes yours. Qwen Code, Copilot CLI and Kimi get an inline
  MCP config, and DeepSeek Harness gets a launcher patch. Hermes Agent has no
  per-session route, so Settings → Agent integration can now add the hub to
  `~/.hermes/config.yaml`, in a marked block that Uninstall removes byte for
  byte. The hub records the model too, so `list_peers` shows it. Hermes Agent
  and OpenClaw are also offered on their own in the `+` menu.
- The status checks run `ollama` and `curl` in hidden terminals, so the app
  still needs no network or process permission. The library pages are cached for
  three hours. Background checks skip `ollama list` while the server is down, so
  Qutty never starts Ollama behind your back.
- The shell is the harness: in a Qutty tile, type `,` and a request at your own
  zsh or bash prompt (`, list the five biggest files here`) and press Enter. The
  model's explanation prints above the prompt and its proposed command lands in
  your edit buffer; nothing runs until you press Enter on it. `, next` continues
  (the session is the conversation: your recent commands, their exit status and
  folder are the context, with secrets redacted), and `, inbox`, `, say <text>`
  and `, to <tile> <text>` use the agent hub's messages. Obviously destructive
  proposals are flagged, and ones that would wipe a disk or your home folder
  land commented out. The model is headless Claude Code (`haiku` by default, no
  tools) or, without it, a local Ollama; `QUTTY_AGENT_PREFIX`,
  `QUTTY_AGENT_BRAIN` and `QUTTY_AGENT_MODEL` change the prefix and model. Turn
  it on in Settings → Agent integration (one marked line in `~/.zshrc` /
  `~/.bashrc`, removed by Uninstall). The shell agent's Ollama brain talks to
  Ollama's API on 127.0.0.1:11434 directly, the app's one network permission
  (loopback, that port only).
- The Homebrew cask now follows releases on its own: brainwires/homebrew-tap
  checks hourly for a new Qutty release and updates itself, so the release
  workflow no longer needs a token for it.
- Loopy is now just its face: the steel bead head with its 13 moods, drawn twice
  as large and without the wire body. A thin rim in the mood's colour rings the
  bead, the head bobs, hops and tilts in place of the body's moves, and clicking
  anywhere on the face opens the chat.
- Codex joins the agent hub for real (checked end to end with Codex CLI 0.167).
  Its MCP server now gets `QUTTY_SOCK` (Codex passes only a few environment
  variables to MCP servers, so before this the qutty server quietly failed to
  connect). Codex hooks are wired the way Claude Code's are: SessionStart
  registers the tile and hands over waiting messages, UserPromptSubmit and
  PostToolUse mark it busy and deliver messages mid-turn, Stop keeps Codex going
  only while messages are waiting, PermissionRequest shows "waiting for you",
  and Interrupt marks it idle. Qutty marks exactly its own hooks as trusted, so
  Codex runs them without a `/hooks` review. The hub's tools carry MCP hints, so
  Codex runs them without asking for approval, except typing into, starting and
  closing tiles.
- Settings → Agent integration for Codex now also installs those hooks and their
  trust in `~/.codex/config.toml`, still in one marked block that Uninstall
  removes byte for byte. A block from an older Qutty shows as out of date, and
  Install refreshes it.
- Built on Denext 4.13.1 (was 4.12), whose desktop runtime starts shells in the
  packaged app again (denext#134). The microphone's permission text and the
  signed build's audio-input entitlement now come from Denext's `microphone`
  capability instead of a step of Qutty's own in the macOS packaging script.
  `QUTTY_PTY_SELFTEST=1` checks a packaged app's terminal path without the
  window: it starts the login shell, has it answer, and exits.
- Rullama updates: `@rullama/mcp-server` 0.12.4 (the hub's MCP tool hints are
  registered with each tool), `@rullama/provider` 0.12.2 (the shell agent's
  Ollama gets its instructions as the system prompt) and
  `@rullama/tool-builtins` 0.12.2. The shell agent's danger check now parses the
  command the way the shell does, so a quoted argument such as
  `git commit -m "rm -rf build"` is no longer flagged, while
  `bash -c "rm -rf /"` and `$(…)` are checked as code. A refused command's line
  names every reason.

## 0.3.0 — agent hub, companion, voice, SSH, sandbox

Version 0.2.0 was tagged but never published; everything it held ships here.

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
- Shared Docker sandbox (Settings → Sandbox → Shared container): one long-lived
  container per window that sandboxed tiles `docker exec` into, so agents share
  one filesystem, process space and set of tools without touching the Mac.
  Choose the image (default `node:22-bookworm`), a project folder mounted at the
  same path (read/write or read-only), network on or off, whether it keeps
  running after the window closes, and whether new tiles open in it; the `+`
  menu's "Run in sandbox" / "Run on host" overrides that per tile. `$HOME` lives
  on a volume (`qutty-sandbox-home`), so agent logins and tools installed there
  persist; the host's `~/.claude` and `~/.codex` can be mounted read-only at
  `/mnt/host`. Sandboxed tiles get a SANDBOX badge and a hatched green header,
  the companion's `list_peers` marks them, and agents inside reach the hub over
  a loopback TCP port with a per-tile token. A status line shows the image and
  uptime with Start/Restart, Stop and Reset volume; without Docker the option
  says why. The container stops with the app (even after a crash) unless kept.

- The companion: Loopy, an animated paper clip, sits in a corner of the window.
  Agents' questions (`ask_user`) appear in its speech bubble with their buttons;
  scripts and hooks can make it talk with
  `qutty-hook say "Tests passed" --mood
  success` (`--action id:label`,
  `--wait` prints the button pressed). Click Loopy to chat with its brain, a
  headless Claude Code session on your own login that sees every tile and can
  act on them: type into a tile, open, close or focus one, and nudge an idle
  agent to read its messages. Agents can message it too (`send_message` to
  `companion`). It starts on first use, thinks visibly while it works, restarts
  on the next use if it stops (messages it had not finished are handed to it
  again), and keeps answers short. Every privileged action is logged
  (`companion-audit.jsonl` in the app-support folder) and shown under Settings →
  Companion, which also sets the corner, the brain and its model, and Off
  (questions then use the card, as before). Follows the theme and reduced
  motion.
- Loopy is redrawn as Denext's current companion: one continuous wire bent into
  two crossed triangle clips, with a steel bead head and a face. It has 13 moods
  (`neutral`, `thinking`, `attention`, `success`, `confused`, `mad`, `sad`,
  `excited`, `sleepy`, `love`, `surprised`, `shocked`, `wow`), each with its own
  wire tint, face and extras, for `qutty-hook say --mood`; `idle`, `ask` and
  `error` are accepted as aliases. A failed companion turn now looks sad.
- Voice for the companion (Settings → Voice). Hold the mic button beside Loopy,
  or hold ⌘⇧M (configurable, never a key the terminal gets), and speak. A short
  click keeps listening until the next click. What you said appears in the chat
  box for review (Send / Edit / Cancel; this step can be turned off), then goes
  to the companion, which can answer, act on a tile or pass it to an agent. In
  "Dictate into focused tile" mode, the transcript is typed into the focused
  tile with no model involved. The Summarize button, or saying "what's going
  on?", asks Loopy for a short summary of every tile. Answers can be read aloud
  (voice, rate, volume), and optional spoken alerts say when an agent finishes,
  needs you, or reports a failed build (`set_status` now takes a `note`).
  Talking or pressing the mic stops the speech. Loopy's head glows while it
  listens, and its mouth moves while it speaks.
  - Speech to text runs on your computer by default: rullama-hardware's Whisper,
    through a native library (`deno task audio:lib` builds it from Rullama). Its
    model (Whisper base.en, 57 MB) is downloaded once, after a size notice, and
    checked against its SHA-256.
  - Cloud engines (Deepgram, ElevenLabs, Deepgram Aura) are built in but
    switched off in this release: keeping their keys would give the app more
    permissions than it should have. They appear in Settings, disabled, with the
    reason.
  - Web Speech is offered only where the window has it.
  - Nothing goes to a cloud service unless you pick one.
  - The packaged macOS app asks for the microphone once
    (`NSMicrophoneUsageDescription`, and the hardened runtime's audio-input
    entitlement).

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
