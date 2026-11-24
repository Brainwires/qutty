# Agent detection manifests

Qutty tells what a coding agent in a terminal tile is doing (working, waiting
for you, idle) in two ways:

- **Hooks**, for agents Qutty wires up (Claude Code, Codex). They are
  authoritative.
- **The screen**, for every other agent, and for what the hooks leave out (an
  approval prompt they did not report). Qutty reads the bottom of the tile's
  screen and checks it against the agent's _detection manifest_.

A manifest is data: which process is the agent, and which text on screen means
which state. Qutty bundles manifests for Claude Code, Codex, Gemini CLI,
opencode, aider, GitHub Copilot CLI, Cursor Agent, Amp, Qwen Code, Kimi Code CLI
and Droid (`resources/agent-detection/` in the source). You can fix one, or add
an agent, with a file of your own.

## Where your manifests go

Put a `<agent>.json` or `<agent>.toml` file in the `agent-detection` folder of
Qutty's app folder:

- macOS: `~/Library/Application Support/org.qutty.Qutty/agent-detection/`
- Linux: the app's data folder, `agent-detection/` inside it (beside the
  `skins/` folder)

Your file always wins. It **replaces** the bundled manifest with the same `id`
completely (copy the bundled one and edit it). A new `id` adds an agent. Qutty
reads the folder at start. In the app's devtools, `qutty.agentDetection(true)`
reads it again.

A file that does not parse or check is skipped, and the bundled manifest stays.
The reason is logged and also listed by the debug command.

## The format

```json
{
  "id": "myagent",
  "label": "My Agent",
  "process": {
    "names": ["myagent"],
    "argv": ["(^|/)myagent(\\.js)?$"]
  },
  "lines": 15,
  "interrupt": "esc",
  "working": [
    { "id": "esc-to-interrupt", "text": "esc to interrupt" },
    { "id": "spinner", "regex": "^\\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s" }
  ],
  "blocked": [
    { "id": "approve", "regex": "^\\s*Allow this (command|edit)\\?" },
    { "id": "menu", "all": ["enter to select", "esc to cancel"] }
  ],
  "idle": [
    { "id": "prompt", "regex": "^\\s*>\\s" }
  ]
}
```

The same in TOML:

```toml
id = "myagent"
label = "My Agent"
interrupt = "esc"

[process]
names = ["myagent"]
argv = ['(^|/)myagent(\.js)?$']

[[working]]
id = "esc-to-interrupt"
text = "esc to interrupt"

[[blocked]]
id = "menu"
all = ["enter to select", "esc to cancel"]
```

| Field             | Meaning                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`              | Lower-case letters, digits, `.`, `_`, `-`. Without one, the file name is used. The hub calls the tile's harness by it (`claude`, `codex`, …).                                                                            |
| `label`           | The agent's name in the overlay.                                                                                                                                                                                         |
| `process.names`   | Foreground process names (the base name, any case).                                                                                                                                                                      |
| `process.argv`    | Regular expressions tested against each of the foreground process's first three arguments. A CLI written in Node or Python is `node` or `python3` to the OS, so `node /opt/homebrew/bin/gemini` is matched on `argv[1]`. |
| `lines`           | How many lines at the bottom of the screen are read (default 15, at most 60).                                                                                                                                            |
| `interrupt`       | What the overlay's Interrupt button sends: `esc` (the default) or `ctrl-c`.                                                                                                                                              |
| `working`         | Matchers for "working": spinners, `esc to interrupt`, …                                                                                                                                                                  |
| `blocked`         | Matchers for "waiting for you": the agent's approval or question UI.                                                                                                                                                     |
| `idle`            | Matchers for its prompt. These are optional: a screen nothing matches counts as idle.                                                                                                                                    |
| `confidence`      | `"low"` marks a manifest written without the agent's real UI strings to hand (informational).                                                                                                                            |
| `"//"` (JSON key) | A comment. It is ignored.                                                                                                                                                                                                |

A matcher is an object with an optional `id` (shown by the debug command) and
one of these:

- `text`: a substring of a single line. Case is ignored.
- `regex`: a JavaScript regular expression, tested on each line. `flags` may add
  `i`, `m`, `s` or `u`; use `u` for emoji.
- `all`: a list of substrings that must all appear somewhere in the window, not
  necessarily on the same line. Case is ignored. Use it for a menu, where the
  question and the key hints sit on different lines.

A matcher may also have `lines`, to look only at the last N lines of the window.
A plain string is short for `{ "text": "…" }`.

## How a screen is read

1. **`blocked` first, and strictly.** Only a matcher that fires counts. Qutty
   never guesses that an agent is waiting for you. Make these matchers specific:
   match the approval menu itself, not a question that could also appear in the
   agent's reply.
2. **Then `working`.**
3. **Then `idle`.** Anything else is idle too.

The first matcher that fires decides the state. The state goes into the same
status that the tile badges, the overlay and the companion use: working is
**busy**, blocked is **waiting**, idle is **idle**.

Every tile whose agent is **waiting** counts on the app icon's badge (the Dock
on macOS): the number of terminals, in every window, with an agent waiting for
you. So does an agent that went from **busy** to **idle** (its turn finished),
until you look at its tile: the tile has the focus in the front window. Settings
→ Agents → Waiting agents turns it off.

The screen is read only for a tile whose foreground process is a known agent, or
whose hub harness is one (for example `ollama launch claude`, which is `ollama`
to the OS). It is read on output, at most four times a second. When the agent
quits back to its shell, reading stops.

When the agent's hooks have fired (Claude Code or Codex with Qutty's
integration), the hooks set the status. The screen only adds `waiting` for an
approval prompt the hooks did not report, and hands the status back once the
prompt is gone.

## Debugging

Open the app's devtools on the window and run `qutty.agentDetection()` with the
tile focused. It returns:

- the foreground process and its first arguments;
- the agent detected, and whether it was matched by process or by the hub's
  harness;
- which manifest was used: `bundled`, or your file's path;
- the last verdict: the state, the matcher id that fired (`null` means nothing
  matched, so idle), and the line it matched;
- whether the hooks own the status;
- the user files that were refused, with the reason.

`qutty.agentDetection(true)` reads your manifests again first.
