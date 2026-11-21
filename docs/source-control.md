# Source Control

Qutty's Source Control tile is a subset of Visual Studio Code's Source Control
view. Each tile shows one git repository, and a linked worktree counts as its
own repository. It is a tile like any other: you can tile it, minimize it, move
it to another window, and it comes back when the workspace is restored.

## Opening it

- `+` menu → **Source Control**, the bar's View menu → **Source Control**, or
  View → Source Control and Shell → New Tile With → Source Control in the native
  menus. The tile opens on the repository of the focused terminal's folder.
- Right-click a terminal tile's header → **Source Control for This Folder**.
- With no folder to go by (no terminal is focused, or its folder is not in a
  repository), the tile asks for a folder. It suggests the repositories of the
  open terminals.
- **Follow focused terminal** (under the header) moves the tile to the
  repository of whichever terminal you focus. **Change Repository…** picks
  another one.

## The panel

- **Header**: the repository's name and the branch picker. In the picker you can
  filter branches, switch to one (local or remote), or create a branch from
  HEAD. If you have uncommitted changes, switching asks first. The header also
  shows ahead / behind counts against the upstream, and has **Fetch**, **Pull**,
  **Push**, **Sync** (pull, then push) and **Refresh**. A running remote
  operation shows git's progress line and a **Cancel** button. Push publishes a
  branch that has no upstream (`push -u origin HEAD`).
- **Commit box**: type the message. **Commit** commits the staged changes; ⌘↩
  (Ctrl+Enter on Linux) in the box does the same. That key is Maximize Tile
  everywhere else, and the box takes it only while it has the keyboard. The ▾
  menu has **Commit Staged**, **Commit All** (`commit -a`) and **Amend Last
  Commit**, which loads HEAD's message into an empty box. If nothing is staged,
  Commit offers to stage everything and commit.
- **Changes**, grouped into Merge Changes (conflicts), Staged Changes, Changes
  and Untracked. Each row shows its letter: M modified, A added, D deleted, R
  renamed, T type changed, U untracked, C conflict. Hover a row for Open File
  (the editor from Settings → Links), Reveal, Stage / Unstage and Discard. Each
  group has Stage All, Unstage All or Discard All. Every discard asks first.
  Untracked files go to the Trash where the OS has a `trash` command (macOS 15
  and later, or `gio trash` on Linux). Otherwise Qutty asks once more and then
  deletes them. If an agent tile in this repository changed a file and nobody
  has reviewed the change in its Changes tab yet, the row wears an **agent**
  badge.
- **Diff**: click a row to see its diff in the tile, unified or side by side. On
  a change, **Stage Hunk** and **Discard Hunk** (asks first) act on one hunk. On
  a staged file, **Unstage Hunk** does. Created, deleted, renamed and binary
  files are staged whole.
- **History**: the last 150 commits with a graph lane. Click a commit to list
  its files, then click a file to see its diff.
- **Stashes**: stash with a message, untracked files too if you like. Apply,
  Pop, or Drop (asks first). An action names the stash by its ref, and Qutty
  checks that the ref still points at the entry you saw. If another checkout
  pushed or popped meanwhile, it refuses.
- **Worktrees**: see below.

The tile refreshes when the repository changes on disk (a debounced file watch
of the worktree plus HEAD, the index and refs), when the tile takes the focus,
after its own actions, and when an agent tile finishes a turn. It never polls.

## Worktrees as workspaces

A linked worktree (`git worktree add`) can open as a workspace of its own: a
Qutty window with a terminal already in the worktree's folder.

- **New Worktree** (the Worktrees section, or `+` menu / Workspaces menu →
  **Worktrees…**): pick an existing branch or type a new one. The checkout goes
  to `<repo-parent>/.qutty-worktrees/<repo>/<branch>` by default. Settings →
  Source Control → **Worktree folder** sets another base folder, and then the
  checkout goes to `<folder>/<repo>/<branch>`. The new worktree opens as a
  workspace.
- **Open as Workspace** on any listed worktree (`git worktree list`) opens it
  the same way. **Terminal** opens a terminal there in this window. **Source
  Control** opens a tile for it.
- **Remove…** runs `git worktree remove`. A checkout with uncommitted changes is
  refused, and Qutty asks before `--force`. The branch is never deleted. Closing
  a worktree workspace never deletes its folder either.
- A worktree workspace wears a **⑂ branch** badge with its repository's name in
  the switcher bar. The Workspaces menu lists closed worktree workspaces after
  the others, grouped by repository.
- New agent tiles in a worktree workspace start in the worktree's folder.
- Agents and the companion can see who works where. Each tile in the agent hub's
  `list_peers` (and `whoami`) carries `worktree`: the checkout's folder, its
  branch, and whether it is a linked worktree.

The demo build (`deno task dev`) has an in-memory repository and a single
window, so there Open as Workspace opens a terminal tile instead.

## How git runs

The `scm` desktop extension (`desktop/scm.ts`) runs git the way Qutty runs every
other program. Git starts in a hidden PTY, as an argv that no shell parses, so
Qutty needs no Deno permission it does not already have. A small `/bin/sh`
wrapper (`lib/scm/run.ts`) keeps git's output exact:

- stdout goes to a private temporary file, which comes back in base64 through
  the terminal, since a PTY would rewrite line endings and mix in stderr;
- stderr stays on the terminal, which is how git shows progress.

Git's own credential helpers and ssh-agent work as they do in your shell. Qutty
never asks for or sees a password. Git is told not to prompt
(`GIT_TERMINAL_PROMPT=0`). If ssh asks a question anyway (a passphrase, an
unknown host key), the run ends and the tile says how to set up a credential
helper or ssh-agent. Output is parsed from porcelain formats:
`status
--porcelain=v2 -z`, `diff --no-color`, `log -z`, `for-each-ref`,
`stash list
-z` and `worktree list --porcelain` (`lib/scm/parse.ts`). Hunk
staging applies a generated one-hunk patch with `git apply --cached`
(`lib/scm/patch.ts`). Qutty never runs `reset --hard`, a bare `git stash` or a
force push. Writes to one repository run one at a time.
