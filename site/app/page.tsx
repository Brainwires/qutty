import { Link } from "denext";
import { DownloadButton } from "../components/download-button.tsx";
import { JsonLd, Shot, SHOTS, Tile } from "../components/ui.tsx";
import { findAsset, latestRelease } from "../lib/release.ts";
import { DESCRIPTION, softwareJsonLd, TAGLINE } from "../lib/site.ts";

export const metadata = {
  title: `Qutty — ${TAGLINE}`,
  description: DESCRIPTION,
};

/** The seven layout patterns as tiny diagrams (the focused tile filled). */
const PATTERNS: { name: string; rects: [number, number, number, number][] }[] = [
  { name: "cascade", rects: [[0, 0, 9, 10], [9, 0, 7, 6], [9, 6, 4, 4], [13, 6, 3, 4]] },
  { name: "spiral", rects: [[0, 0, 9, 10], [9, 0, 7, 6], [12, 6, 4, 4], [9, 6, 3, 4]] },
  {
    name: "master",
    rects: [[0, 0, 10, 10], [10, 0, 6, 3.4], [10, 3.4, 6, 3.3], [10, 6.7, 6, 3.3]],
  },
  { name: "columns", rects: [[0, 0, 4, 10], [4, 0, 4, 10], [8, 0, 4, 10], [12, 0, 4, 10]] },
  { name: "rows", rects: [[0, 0, 16, 2.5], [0, 2.5, 16, 2.5], [0, 5, 16, 2.5], [0, 7.5, 16, 2.5]] },
  { name: "grid", rects: [[0, 0, 8, 5], [8, 0, 8, 5], [0, 5, 8, 5], [8, 5, 8, 5]] },
  { name: "monocle", rects: [[0, 0, 16, 10]] },
];

const HIGHLIGHTS: { title: string; body: string; href: string }[] = [
  {
    title: "Seven layouts, or none",
    body:
      "Cascade, spiral, master-stack, columns, rows, grid and monocle, with animated transitions. Or switch a workspace to free-form and move, resize and overlap tiles like windows.",
    href: "/features#layouts",
  },
  {
    title: "A GUI around agent harnesses",
    body:
      "Claude Code, Codex, Gemini CLI, opencode and aider keep their own terminal UI, framed by a header card, a prompt box with history and saved prompts, and a side rail.",
    href: "/features#agents",
  },
  {
    title: "Agents that talk to each other",
    body:
      "Every terminal gets its own MCP server. Agents in different tiles can list each other, read any tile's screen, send messages, and ask you a question with buttons.",
    href: "/features#hub",
  },
  {
    title: "Claude Code as a chat tile",
    body:
      "A transcript in the terminal's font: markdown answers, compact tool-call rows that open to the diff, and Allow, Allow always or Deny right where it asks.",
    href: "/features#chat-tiles",
  },
  {
    title: "A companion you can talk to",
    body:
      "Hold a key and speak. Speech to text runs on your computer by default. The companion sees every tile, can act on them, and browses the web for you.",
    href: "/features#companion",
  },
  {
    title: "Web pages in tiles",
    body:
      "⌘-click a URL in a terminal and the page opens beside it, with bookmarks, history, find, zoom and sign-ins that stay signed in.",
    href: "/features#web-tiles",
  },
  {
    title: "Shells that outlive the app",
    body:
      "Quit and your shells keep running; they come back in their tiles at the next launch. Drag a tile out of the window to move it, running, to another one.",
    href: "/features#sessions",
  },
  {
    title: "SSH, built in",
    body:
      "A connection manager over your ~/.ssh/config, broadcast input across tiles, port forwards on a live connection, and drag-and-drop file transfer.",
    href: "/features#ssh",
  },
];

export default async function Home() {
  const release = await latestRelease();
  const url = (p: "mac" | "linux", a: "arm64" | "x86_64", f: "dmg" | "AppImage") =>
    findAsset(release, p, a, f)?.url ?? "/download";
  const targets = {
    version: release.version,
    macArm64: url("mac", "arm64", "dmg"),
    macX64: url("mac", "x86_64", "dmg"),
    linuxArm64: url("linux", "arm64", "AppImage"),
    linuxX64: url("linux", "x86_64", "AppImage"),
  };
  return (
    <>
      <JsonLd json={softwareJsonLd(release, "https://qutty.org/download")} />
      <div class="wrap hero">
        <div class="cascade">
          <Tile title="zsh — ~/qutty" focused labelledBy="hero-title" bodyClass="pitch">
            <h1 id="hero-title">{TAGLINE}</h1>
            <p class="lead">
              Qutty is a tiling terminal for macOS and Linux, built for coding agents. Tiles shrink
              the longer they go unused, so your working set stays big and the rest step back.
            </p>
            <div class="cta">
              <DownloadButton targets={targets} />
              <span class="cta-note">
                Version {release.version}. Free and open source.{" "}
                <Link href="/download">All downloads</Link>
              </span>
            </div>
          </Tile>
          <Tile title="brew — ~" when="just now" dot="green" bodyClass="">
            <pre class="term">
              <span class="c"># macOS, with Homebrew</span>
              {"\n"}
              <span class="p">$</span> brew tap brainwires/tap{"\n"}
              <span class="p">$</span> brew install --cask brainwires/tap/qutty{"\n\n"}
              <span class="c"># Debian and Ubuntu</span>
              {"\n"}
              <span class="p">$</span> sudo apt install ./Qutty-{release.version}-x86_64.deb
            </pre>
          </Tile>
          <Tile title="layouts" bodyClass="">
            <ul class="patterns" aria-label="The seven layout patterns">
              {PATTERNS.map((p) => (
                <li key={p.name}>
                  <svg viewBox="-0.5 -0.5 17 11" role="img" aria-label={p.name}>
                    {p.rects.map(([x, y, w, h], i) => (
                      <rect
                        key={i}
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        rx="0.6"
                        class={i === 0 ? "f" : undefined}
                      />
                    ))}
                  </svg>
                  {p.name}
                </li>
              ))}
            </ul>
          </Tile>
          <Tile title="claude — ~/app" dot="amber" bodyClass="mini">
            <strong>Agents need you</strong>
            An amber border when an agent waits for an answer.
          </Tile>
          <Tile title="codesign — Qutty.app" dot="green" bodyClass="mini">
            <strong>Signed and notarized</strong>
          </Tile>
        </div>
      </div>

      <section class="wrap section" aria-labelledby="see-title">
        <div class="section-head">
          <h2 id="see-title">One window, every terminal</h2>
          <p>
            The focused terminal is largest, the one you used before it second largest, and so on.
            Terminals that don't fit wait in the switcher bar with their shells running.
          </p>
        </div>
        <Shot shot={SHOTS.cascade} eager />
        <div class="shots">
          <Shot shot={SHOTS.harness} />
          <Shot shot={SHOTS.companion} />
          <Shot shot={SHOTS.browser} />
          <Shot shot={SHOTS.light} />
        </div>
      </section>

      <section class="wrap section" aria-labelledby="hl-title">
        <div class="section-head">
          <h2 id="hl-title">Built for working with agents</h2>
          <p>
            Run several coding agents side by side, see at a glance which one needs you, and let
            them coordinate without copying text between windows.
          </p>
        </div>
        <ul class="highlights">
          {HIGHLIGHTS.map((h) => (
            <li key={h.href}>
              <h3>
                <Link href={h.href}>{h.title}</Link>
              </h3>
              <p>{h.body}</p>
            </li>
          ))}
        </ul>
        <p class="more">
          <Link class="button ghost" href="/features">See every feature</Link>
        </p>
      </section>
    </>
  );
}
