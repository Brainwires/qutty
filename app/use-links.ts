// What a click on a link in a terminal does (lib/terminal-links.ts finds them; the terminal
// manager hands the clicks over):
//
// - ⌘-click (Ctrl-click elsewhere) on an http(s) URL opens it in a web tile beside the terminal
//   when Settings → Links says "A Qutty tile" and the engine can show the page (lib/web/engine.ts:
//   today loopback and local dev hosts), else in the default browser; any other URL opens in the
//   default browser. OSC 8 hyperlinks behave the same; `file:` links are files. On a local folder
//   reveals it in Finder (the Linux file manager); on a local file opens it in its default app,
//   or, when it was printed with a line (`src/x.ts:42:7`), in the editor Settings → Links picks
//   (an installed preset, a custom command template, or `$EDITOR` in a new tile).
// - ⌘-click on a path in an SSH tile's output (or an OSC 8 `file:` link there) is on the remote
//   machine: it offers Download (the SSH download flow) instead.
// - Right-click on a link: a menu with Open / Open in editor / Reveal / Download / Copy; an
//   http(s) URL's offers Open in Qutty tile and Open in default browser (both always), and Copy.
//
// The opening itself is the backend's (desktop/links.ts); a failure is logged, not shown.

import { useCallback, useEffect, useRef, useState } from "denext";
import {
  editorChoice,
  editorTileArgs,
  fileUrlPath,
  type LinkSettings,
} from "../lib/links.ts";
import type { LinkHit } from "../lib/terminal-links.ts";
import type { TerminalManager } from "../lib/terminal-manager.ts";
import { baseName, type TerminalProfile } from "../lib/ssh-ui.ts";
import { parseWebUrl } from "../lib/web/url.ts";
import { webEngine } from "../lib/web/engine.ts";
import type { LinkMenuItem } from "./link-menu.tsx";

export interface UseLinksOptions {
  manager: TerminalManager | null;
  settings: LinkSettings;
  platform: "mac" | "other";
  openTile(profile: TerminalProfile): string | null;
  /** A web tile showing `url`, beside the focused tile. */
  openWebTile(url: string): void;
  /** Download a remote path over SSH tile `id`'s connection. */
  download(id: string, remotePath: string): void;
  refocus(): void;
}

/** The open link menu. */
interface LinkMenuState {
  x: number;
  y: number;
  title: string;
  items: LinkMenuItem[];
}

const warn = (what: string) => (err: unknown) =>
  console.warn(
    `links: ${what} failed: ${err instanceof Error ? err.message : err}`,
  );

/** The text a hit shows in its menu's title. */
function titleOf(hit: LinkHit): string {
  if (hit.kind === "url") return hit.url;
  const at = hit.line === undefined
    ? ""
    : `:${hit.line}${hit.col === undefined ? "" : `:${hit.col}`}`;
  return `${hit.path}${at}`;
}

export function useLinks(opts: UseLinksOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const [menu, setMenu] = useState<LinkMenuState | null>(null);
  /** The installed editor presets (asked once, when a line link is first opened). */
  const editorsRef = useRef<Promise<string[]> | null>(null);

  // A new backend (first boot) asks again.
  useEffect(() => {
    editorsRef.current = null;
  }, [opts.manager]);

  const backend = () => optsRef.current.manager?.backend;

  /** A `file:` URL as the path it names: local, or remote in an SSH tile. */
  const normalize = async (
    id: string,
    hit: LinkHit,
  ): Promise<LinkHit | null> => {
    if (hit.kind !== "url" || !hit.url.toLowerCase().startsWith("file:")) {
      return hit;
    }
    const path = fileUrlPath(hit.url);
    if (!path) return null;
    if (optsRef.current.manager?.profile(id)?.kind === "ssh") {
      return { kind: "remote", path };
    }
    const [target] = await backend()?.linkResolve(undefined, [path]) ?? [null];
    return target
      ? { kind: "local", path: target.path, isDir: target.kind === "dir" }
      : null;
  };

  /** A URL in the default browser. */
  const openUrl = (url: string) =>
    void backend()?.linkOpen({ kind: "url", url }).catch(warn("open"));
  /**
   * A ⌘-clicked URL: an http(s) page the engine can show goes to a web tile (Settings → Links →
   * "Open web links in": a Qutty tile), anything else to the default browser.
   */
  const openLink = (url: string) => {
    const o = optsRef.current;
    if (o.settings.web === "tile" && webEngine().canEmbed(url)) {
      o.openWebTile(url);
    } else openUrl(url);
  };
  const reveal = (path: string) =>
    void backend()?.linkOpen({ kind: "reveal", path }).catch(warn("reveal"));
  const openFile = (path: string) =>
    void backend()?.linkOpen({ kind: "open", path }).catch(warn("open"));

  /** A file at a line, in the editor Settings picks. */
  const edit = async (path: string, line?: number, col?: number) => {
    const be = backend();
    if (!be) return;
    const installed = await (editorsRef.current ??= be.linkEditors().catch(
      () => [],
    ));
    const choice = editorChoice(optsRef.current.settings, installed);
    if (choice.kind === "default") return openFile(path);
    if (choice.kind === "tile") {
      optsRef.current.openTile({
        kind: "agent",
        program: "/bin/sh",
        args: editorTileArgs(path, line),
        name: baseName(path),
        label: "$EDITOR",
        plain: true,
        sandbox: false,
      });
      return;
    }
    await be.linkEdit({
      command: choice.command,
      file: path,
      ...(line === undefined ? {} : { line }),
      ...(col === undefined ? {} : { col }),
    }).catch(warn("the editor"));
  };

  const copy = (text: string) => {
    void globalThis.navigator?.clipboard?.writeText(text).catch(warn("copy"));
  };

  /** The menu's items for a (normalized) hit in terminal `id`. */
  const itemsFor = (id: string, hit: LinkHit): LinkMenuItem[] => {
    const finder = optsRef.current.platform === "mac"
      ? "Reveal in Finder"
      : "Show in file manager";
    switch (hit.kind) {
      case "url":
        return [
          ...(parseWebUrl(hit.url)
            ? [{
              action: "tile",
              label: "Open in Qutty tile",
              run: () => optsRef.current.openWebTile(hit.url),
            }, {
              action: "browser",
              label: "Open in default browser",
              run: () => openUrl(hit.url),
            }]
            : [{
              action: "open",
              label: "Open link",
              run: () => openUrl(hit.url),
            }]),
          { action: "copy", label: "Copy link", run: () => copy(hit.url) },
        ];
      case "remote":
        return [
          {
            action: "download",
            label: `Download ${baseName(hit.path)}…`,
            run: () => optsRef.current.download(id, hit.path),
          },
          { action: "copy", label: "Copy path", run: () => copy(hit.path) },
        ];
      case "local":
        return [
          ...(hit.isDir ? [] : [
            { action: "open", label: "Open", run: () => openFile(hit.path) },
            ...(hit.line === undefined ? [] : [{
              action: "edit",
              label: `Open in editor at line ${hit.line}`,
              run: () => void edit(hit.path, hit.line, hit.col),
            }]),
          ]),
          { action: "reveal", label: finder, run: () => reveal(hit.path) },
          { action: "copy", label: "Copy path", run: () => copy(hit.path) },
        ];
    }
  };

  const showMenu = (id: string, hit: LinkHit, e: MouseEvent) =>
    setMenu({
      x: e.clientX,
      y: e.clientY,
      title: titleOf(hit),
      items: itemsFor(id, hit),
    });

  const onLink = useCallback(
    async (id: string, raw: LinkHit, e: MouseEvent, how: "open" | "menu") => {
      const hit = await normalize(id, raw);
      if (!hit) return;
      if (how === "menu") return showMenu(id, hit, e);
      switch (hit.kind) {
        case "url":
          return openLink(hit.url);
        case "remote":
          // Cannot open on this machine: offer the download.
          return showMenu(id, hit, e);
        case "local":
          if (hit.isDir) return reveal(hit.path);
          if (hit.line !== undefined) {
            return void edit(hit.path, hit.line, hit.col);
          }
          return openFile(hit.path);
      }
    },
    [],
  );

  return {
    menu,
    onLink,
    /** Open `url` in the default browser (a web tile's "Open in default browser"). */
    openInBrowser: openUrl,
    closeMenu() {
      setMenu(null);
      optsRef.current.refocus();
    },
  };
}
