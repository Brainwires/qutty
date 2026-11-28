import { Link } from "denext";
import { Shot, type ShotInfo, SHOTS } from "../../components/ui.tsx";

export const metadata = {
  title: "Features — Qutty",
  description:
    "Everything Qutty does: cascade tiling with seven layouts, a GUI around Claude Code, Codex and other agent harnesses, an agent hub over MCP, a voice companion, web tiles, shells that survive quitting, SSH, six themes.",
};

interface Feature {
  id: string;
  title: string;
  lead: string;
  points: string[];
  shot?: ShotInfo;
}

const FEATURES: Feature[] = [
  {
    id: "layouts",
    title: "Tiling that follows your attention",
    lead:
      "In the cascade layout the focused terminal is largest, the previous one second largest, and so on: tiles shrink the longer they go unused.",
    shot: SHOTS.cascade,
    points: [
      "Seven layout patterns: cascade (dwindle), spiral, master-stack, columns, rows, grid and monocle, with animated transitions. Adjustable main share and gap.",
      "The switcher bar, on any edge of the window, holds the terminals that don't fit the cluster.",
      "Tiled or free-form, per workspace: let Qutty lay the tiles out, or move, resize, overlap, cascade and arrange them as windows inside the workspace.",
      "Minimize, Maximize and Restore on every tile. A minimized tile waits in the switcher bar with its shell running.",
      "Tiles can stay where they are: turn off “Focused tile moves to the main spot” and focusing only moves the focus. Drag a tile by its header onto another to swap them.",
      "Inactive tiles can be scaled down instead of resized, so full-screen programs like vim and htop never redraw at a new size.",
    ],
  },
  {
    id: "agents",
    title: "A GUI around agent harnesses",
    lead:
      "A terminal that runs Claude Code, Codex, Gemini CLI, opencode, aider or another coding-agent harness gets a frame around the harness's own terminal UI, which stays real and interactive in the middle.",
    shot: SHOTS.harness,
    points: [
      "Floating cards in the harness's own colour, in dark and light themes.",
      "The header card shows the harness, its model when known, the tile's agent name (click to rename), a status dot for working, idle or waiting for you, and a Messages button while other agents' messages wait.",
      "The prompt box: Enter sends, Shift+Enter is a new line, ↑ and ↓ walk the history. Attach files, insert saved prompts, hold to dictate, interrupt and send.",
      "The side rail jumps to the top or the latest output, maximizes the tile, and reads the screen aloud.",
      "Qutty recognises the harness from the agent hub, the tool the tile was opened as, the program in the foreground or the title it set. When the harness quits back to the shell, the frame goes.",
    ],
  },
  {
    id: "chat-tiles",
    title: "Claude Code as a chat tile",
    lead:
      "Coding → Claude Code in the + menu opens Claude Code as a chat tile that looks like a terminal.",
    points: [
      "The transcript streams in the terminal's font and colours: your prompts, the answer's markdown with highlighted code, dimmed thinking, and each tool call as a compact row that opens to the diff, the command and its output.",
      "Claude Code asks before it edits or runs something: Allow, Allow always or Deny, right in the transcript.",
      "A prompt box that grows to about twenty lines, with history, saved prompts, attachments (images go to the model as images), hold-to-dictate and Stop.",
      "Pick the model from the header, rename the agent, or open the same session in Claude Code's own terminal UI.",
      "The bar's Agents button lists your agent tiles as Needs you, To review and Working.",
    ],
  },
  {
    id: "hub",
    title: "The agent hub",
    lead:
      "Every terminal gets its own MCP server, so coding agents in different tiles (Claude Code, Codex, any MCP client, any account) can work together.",
    points: [
      "Agents can list each other, read any tile's screen and scrollback, message one another or the whole window, and ask you a question with buttons.",
      "Messages reach Claude Code between tool calls or when it would stop, through its hooks; any agent can read them with read_messages or wait_for_message.",
      "Claude Code and Codex started from the + menu are connected automatically. For agents started by hand, Settings → Agents installs the registration and shows exactly what it changes.",
      "Agent tiles show the agent's name, busy, idle or waiting, and unread messages in their header.",
      "A shared Docker sandbox: one long-lived container per window that sandboxed tiles run in, so agents share a filesystem and tools without touching your Mac.",
      "An Ollama helper launches a harness on a local model you pulled.",
    ],
  },
  {
    id: "companion",
    title: "The companion",
    lead:
      "A small animated face in a corner of the window. Agents' questions appear in its speech bubble, and you can chat with it or talk to it.",
    shot: SHOTS.companion,
    points: [
      "Its brain is a Claude Code session on your own login (or an API key, or a local Ollama model) that sees every tile and can act on them: type into a tile, open, close or focus one, and nudge an idle agent.",
      "Hold the talk key and speak. Speech to text runs on your computer by default, with Whisper; nothing goes to a cloud service unless you pick one.",
      "Hold to dictate types what you said into the focused tile, with the companion off too.",
      "It browses: ask it to look something up and it opens a web tile, reads the page, follows links and fills forms, asking you before anything like a purchase or a sign-in.",
      "Answers and alerts can be read aloud, and scripts can make it talk with qutty-hook say.",
      "Every privileged action is logged and listed in Settings.",
    ],
  },
  {
    id: "web-tiles",
    title: "Web tiles",
    lead:
      "⌘-click a link in a terminal, or type an address in a web tile, and the page opens in a tile beside the terminal, in the layout like any other tile.",
    shot: SHOTS.browser,
    points: [
      "Bookmarks with a bookmarks bar and a manager that imports from Chrome, Safari, Firefox and Edge; history with search.",
      "Browser keys while a web tile is focused: the address field, reload, back and forward, find in page, zoom, print.",
      "Sign-ins are kept across restarts (macOS 14 or later), in cookies separate from your browser's.",
      "A link a page opens in a new window opens in a new tile beside it.",
      "Any site opens in the app on macOS; elsewhere, local development pages, with the rest sent to the default browser.",
    ],
  },
  {
    id: "sessions",
    title: "Shells that last",
    lead:
      "Quitting asks whether to keep the shells running. Kept shells come back at the next launch in their tiles, with what they printed meanwhile.",
    points: [
      "After a restart of the computer, shell tiles come back in their last folder with their old text shown above the new prompt.",
      "Move a tile to another window: drag its header out and let go over another Qutty window. A terminal keeps running, with its scrollback, its folder and its agent name.",
      "Closing a window can keep its shells running; Reopen Closed Window, the Dock or the menu-bar icon brings them back.",
      "A menu-bar icon (a tray icon on Linux) lists the workspaces with running terminals.",
    ],
  },
  {
    id: "ssh",
    title: "SSH",
    lead:
      "A connection manager (⌘⇧O) over the hosts in your ~/.ssh/config and Qutty's own, grouped as Favorites, Qutty hosts, your config and Recent.",
    points: [
      "SSH tiles carry the host's name, an SSH badge and an optional tint, and a Disconnected card with Reconnect.",
      "Broadcast input: type in one checked tile and it goes to all of them, with a banner that says where.",
      "Port forwards (-L, -R, -D) on a live connection, without reconnecting.",
      "Drop files on an SSH tile to upload them to the remote shell's folder; Download… browses the remote side.",
    ],
  },
  {
    id: "activity",
    title: "Activity at a glance",
    lead:
      "An unfocused tile shows what happened in it while you looked elsewhere, on its header and border.",
    points: [
      "New output tints the header; a running command draws a slow shimmer; a bell or an agent waiting for you gives the tile an amber border; a failed command a red one; a finished one a brief green header.",
      "Tiles are titled by what the program calls itself: a remote shell's user@host, vim's file, an agent's task.",
      "The switcher bar's chips show the same colours.",
    ],
  },
  {
    id: "looks",
    title: "Themes, fonts and your keys",
    lead:
      "Six themes, three dark (Sea Glass, Plum, Ember) and three light (Paper, Cloud, Sakura), switched live in every terminal.",
    shot: SHOTS.light,
    points: [
      "Adjustable font typeface and size, with your installed monospace fonts listed.",
      "Your macOS key bindings (~/Library/KeyBindings/DefaultKeyBinding.dict) work inside the terminal.",
      "A native menu bar: Shell, Edit, View, Window and Help on macOS; Shell, View, Window and Help on Linux.",
      "⌘-click opens URLs, OSC 8 hyperlinks and file paths that exist.",
      "Mouse reporting for vim, tmux and htop. Real shells through a PTY, rendered with xterm.js (WebGL when available).",
    ],
  },
];

export default function Features() {
  return (
    <div class="wrap">
      <header class="page-head">
        <h1>Features</h1>
        <p>
          What Qutty does, from the layouts to the agents. For what changed in each release, see the
          {" "}
          <Link href="/changelog">changelog</Link>.
        </p>
      </header>
      <div class="with-toc">
        <nav class="toc" aria-label="On this page">
          <ul>
            {FEATURES.map((f) => (
              <li key={f.id}>
                <a href={`#${f.id}`}>{f.title}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          {FEATURES.map((f) => (
            <section class="feature" id={f.id} key={f.id} aria-labelledby={`${f.id}-t`}>
              <div class="feature-body prose">
                <h2 id={`${f.id}-t`}>{f.title}</h2>
                <p>{f.lead}</p>
              </div>
              {f.shot && <Shot shot={f.shot} />}
              <ul class="feature-body prose">
                {f.points.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </section>
          ))}
          <p>
            <Link class="button" href="/download">Download Qutty</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
