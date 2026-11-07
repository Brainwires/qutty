// Clickable links in one xterm.js terminal: ⌘-click (Ctrl-click elsewhere) opens what is under
// the pointer, which is underlined (with a pointer cursor) only while that modifier is held. A
// plain click is the terminal's own (selection, mouse reporting); right-click on a link asks for
// its menu (Copy / Open / Reveal, or Download in an SSH tile).
//
// Three sources, in xterm's provider order (the first that has a link under the pointer wins):
//
// 1. OSC 8 hyperlinks (`ls --hyperlink`, gcc, delta, Claude Code): xterm.js finds them itself and
//    calls `linkHandler`. Its OSC 8 provider gives every link an underline on hover; it is wrapped
//    (through xterm's internal link-provider list, guarded: without it OSC 8 links still work,
//    underlined on any hover) so they follow the modifier like the others.
// 2. URLs in plain output, 3. paths (lib/links.ts finds both). A local path is linked only if it
//    exists: the provider asks the backend (desktop/links.ts) on hover, resolved against the
//    tile's directory, and keeps the answer for a few seconds. In an SSH tile a path is remote:
//    it is linked without a check, resolved against the OSC 7 directory, and offers Download.
//
// No key is taken: the modifier is only observed (a passive keydown/keyup listener).

import type { ILink, ILinkProvider, Terminal } from "./xterm.ts";
import {
  findLinks,
  isOpenableUrl,
  type LinkMatch,
  type LinkTarget,
} from "./links.ts";

/** What a link opens. */
export type LinkHit =
  /** A URL (`osc8`: from an OSC 8 hyperlink; a `file:` one may name a local or remote path). */
  | { kind: "url"; url: string; osc8: boolean }
  /** A local path that exists. */
  | {
    kind: "local";
    path: string;
    isDir: boolean;
    line?: number;
    col?: number;
  }
  /** A path in an SSH tile's output, on the remote machine (`~/…` or absolute). */
  | { kind: "remote"; path: string; line?: number; col?: number };

/** What the e2e suite reads: the hovered link's text and whether it shows as one. */
export interface LinkHoverState {
  hovered: string | null;
  underline: boolean;
  pointer: boolean;
}

/** Where a terminal's paths point. */
export type LinkContext =
  /** A local tile: its current directory (the foreground process's, or OSC 7). */
  | { remote: false; cwd(): Promise<string | undefined> }
  /** An SSH tile: the remote directory from OSC 7, if known. */
  | { remote: true; cwd: string | undefined };

/** What a terminal's links need from the manager and the workspace. */
export interface TerminalLinksHost {
  platform: "mac" | "other";
  context(): LinkContext;
  /** Which paths exist (desktop/links.ts `resolve`). */
  resolve(
    cwd: string | undefined,
    paths: string[],
  ): Promise<(LinkTarget | null)[]>;
  /** The modifier-click. */
  activate(hit: LinkHit, event: MouseEvent): void;
  /** A right-click on a link. */
  menu(hit: LinkHit, event: MouseEvent): void;
}

/** How long an existence check is trusted. */
const RESOLVE_TTL_MS = 3000;
/** Logical lines longer than this (a minified bundle printed whole) are not scanned. */
const MAX_LINE = 4000;

// ---------------------------------------------------------------------------------------------
// The modifier, watched once per page
// ---------------------------------------------------------------------------------------------

const modifier = {
  held: false,
  platform: "mac" as "mac" | "other",
  installed: false,
  subs: new Set<() => void>(),
};

/** Whether the link modifier is held in `e` (⌘ on macOS, Ctrl elsewhere). */
export function linkModifier(
  e: { metaKey: boolean; ctrlKey: boolean },
  platform: "mac" | "other",
): boolean {
  return platform === "mac" ? e.metaKey : e.ctrlKey;
}

function setHeld(held: boolean): void {
  if (modifier.held === held) return;
  modifier.held = held;
  for (const cb of [...modifier.subs]) cb();
}

function watchModifier(platform: "mac" | "other"): void {
  modifier.platform = platform;
  if (modifier.installed || !globalThis.addEventListener) return;
  modifier.installed = true;
  const fromEvent = (e: KeyboardEvent | MouseEvent) =>
    setHeld(linkModifier(e, modifier.platform));
  // Observed only: never prevented or stopped, so the key still reaches whatever has focus.
  const opts = { capture: true, passive: true };
  globalThis.addEventListener("keydown", fromEvent, opts);
  globalThis.addEventListener("keyup", fromEvent, opts);
  globalThis.addEventListener("mousemove", fromEvent, opts);
  globalThis.addEventListener("blur", () => setHeld(false));
}

// ---------------------------------------------------------------------------------------------
// One terminal
// ---------------------------------------------------------------------------------------------

/** A logical line (a row and the rows wrapped onto it) and the cell of each string offset. */
interface LogicalLine {
  text: string;
  /** For each UTF-16 offset: its cell, 1-based x and buffer y. */
  cells: { x: number; y: number }[];
}

function readLogicalLine(term: Terminal, y: number): LogicalLine | undefined {
  const buf = term.buffer.active;
  let start = y;
  while (start > 0 && buf.getLine(start)?.isWrapped) start--;
  let text = "";
  const cells: { x: number; y: number }[] = [];
  for (let row = start; row < buf.length; row++) {
    const line = buf.getLine(row);
    if (!line || (row > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      for (let i = 0; i < chars.length; i++) {
        cells.push({ x: x + 1, y: row + 1 });
      }
      text += chars;
    }
    if (text.length > MAX_LINE) return undefined;
  }
  return { text, cells };
}

/** A remote path resolved against the SSH tile's directory (`~/…` and absolute stay as they are). */
function remotePath(path: string, cwd: string | undefined): string | undefined {
  if (path.startsWith("/") || path === "~" || path.startsWith("~/")) {
    return path;
  }
  if (!cwd?.startsWith("/")) return undefined;
  const parts = `${cwd}/${path}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return `/${out.join("/")}`;
}

type Hover = { link: ILink; hit: LinkHit };

/** The links of one terminal; created with it, `attach`ed once it is opened into the DOM. */
export class TerminalLinks {
  #term: Terminal;
  #host: TerminalLinksHost;
  #current: Hover | null = null;
  #cache = new Map<string, { at: number; value: LinkTarget | null }>();
  #disposers: (() => void)[] = [];

  constructor(term: Terminal, host: TerminalLinksHost) {
    this.#term = term;
    this.#host = host;
    watchModifier(host.platform);
    term.options.linkHandler = {
      allowNonHttpProtocols: true,
      activate: (event, uri) => {
        if (!this.#held(event) || !isOpenableUrl(uri)) return;
        host.activate({ kind: "url", url: uri, osc8: true }, event);
      },
    };
    this.#wrapOsc8();
    const provider = term.registerLinkProvider({
      provideLinks: (y, cb) => {
        this.#provide(y).then(cb, () => cb(undefined));
      },
    });
    this.#disposers.push(() => provider.dispose());
    const onModifier = () => this.#sync();
    modifier.subs.add(onModifier);
    this.#disposers.push(() => modifier.subs.delete(onModifier));
  }

  /** Listen for right-clicks on links (once the terminal has its element). */
  attach(element: HTMLElement): void {
    const onMenu = (e: MouseEvent) => {
      const cur = this.#current;
      if (!cur) return;
      e.preventDefault();
      e.stopPropagation();
      this.#host.menu(cur.hit, e);
    };
    element.addEventListener("contextmenu", onMenu, true);
    this.#disposers.push(() =>
      element.removeEventListener("contextmenu", onMenu, true)
    );
  }

  /** What the pointer is over (for the e2e suite). */
  state(): LinkHoverState {
    const cur = this.#current;
    return {
      hovered: cur?.link.text ?? null,
      underline: !!cur?.link.decorations?.underline,
      pointer: !!cur?.link.decorations?.pointerCursor,
    };
  }

  dispose(): void {
    for (const d of this.#disposers.splice(0)) d();
    this.#current = null;
  }

  #held(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
    return linkModifier(e, this.#host.platform);
  }

  /** Show the hovered link as a link exactly while the modifier is held. */
  #sync(): void {
    const d = this.#current?.link.decorations;
    if (!d) return;
    d.underline = modifier.held;
    d.pointerCursor = modifier.held;
  }

  /** A link xterm can show: underline and pointer follow the modifier; activation needs it. */
  #link(
    range: ILink["range"],
    text: string,
    hit: LinkHit,
    activate: (e: MouseEvent) => void,
    inner?: Pick<ILink, "hover" | "leave">,
  ): ILink {
    const link: ILink = {
      range,
      text,
      decorations: { underline: modifier.held, pointerCursor: modifier.held },
      activate: (e) => activate(e),
      hover: (e, t) => {
        this.#current = { link, hit };
        // xterm read the decorations when the pointer arrived; they may be stale.
        this.#sync();
        inner?.hover?.(e, t);
      },
      leave: (e, t) => {
        if (this.#current?.link === link) this.#current = null;
        inner?.leave?.(e, t);
      },
    };
    return link;
  }

  /**
   * xterm.js's own OSC 8 provider (the first one it registers) underlines on any hover; give its
   * links ours. Internal API, so every step is checked: without it nothing breaks.
   */
  #wrapOsc8(): void {
    try {
      const core = (this.#term as unknown as {
        _core?: { _linkProviderService?: { linkProviders?: ILinkProvider[] } };
      })._core;
      const osc = core?._linkProviderService?.linkProviders?.[0];
      if (!osc || typeof osc.provideLinks !== "function") return;
      const provide = osc.provideLinks.bind(osc);
      osc.provideLinks = (y, cb) =>
        provide(y, (links) =>
          cb(
            links?.map((l) =>
              this.#link(
                l.range,
                l.text,
                { kind: "url", url: l.text, osc8: true },
                (e) => l.activate(e, l.text),
                l,
              )
            ),
          ));
    } catch {
      /* xterm's internals moved: OSC 8 links keep xterm's own hover */
    }
  }

  async #provide(y: number): Promise<ILink[] | undefined> {
    const logical = readLogicalLine(this.#term, y - 1);
    if (!logical || logical.text.trim() === "") return undefined;
    const matches = findLinks(logical.text);
    if (matches.length === 0) return undefined;
    const ctx = this.#host.context();
    const hits = ctx.remote
      ? matches.map((m) => this.#remoteHit(m, ctx.cwd))
      : await this.#localHits(matches, await ctx.cwd());
    const links: ILink[] = [];
    matches.forEach((m, i) => {
      const hit = hits[i];
      if (!hit) return;
      const start = logical.cells[m.start];
      const end = logical.cells[m.end - 1];
      if (!start || !end) return;
      links.push(this.#link(
        { start, end },
        logical.text.slice(m.start, m.end),
        hit,
        (e) => {
          if (this.#held(e)) this.#host.activate(hit, e);
        },
      ));
    });
    return links.length > 0 ? links : undefined;
  }

  #remoteHit(m: LinkMatch, cwd: string | undefined): LinkHit | null {
    if (m.kind === "url") return { kind: "url", url: m.text, osc8: false };
    const path = remotePath(m.path, cwd);
    return path ? { kind: "remote", path, ...lineCol(m) } : null;
  }

  async #localHits(
    matches: LinkMatch[],
    cwd: string | undefined,
  ): Promise<(LinkHit | null)[]> {
    const now = Date.now();
    const key = (p: string) => `${cwd ?? ""}\0${p}`;
    const misses = [
      ...new Set(
        matches.flatMap((m) => {
          if (m.kind !== "path") return [];
          const c = this.#cache.get(key(m.path));
          return c && now - c.at < RESOLVE_TTL_MS ? [] : [m.path];
        }),
      ),
    ];
    if (misses.length > 0) {
      const found = await this.#host.resolve(cwd, misses).catch(() =>
        misses.map(() => null)
      );
      if (this.#cache.size > 500) this.#cache.clear();
      misses.forEach((p, i) =>
        this.#cache.set(key(p), { at: now, value: found[i] ?? null })
      );
    }
    return matches.map((m) => {
      if (m.kind === "url") return { kind: "url", url: m.text, osc8: false };
      const target = this.#cache.get(key(m.path))?.value;
      return target
        ? {
          kind: "local",
          path: target.path,
          isDir: target.kind === "dir",
          ...lineCol(m),
        }
        : null;
    });
  }
}

function lineCol(m: LinkMatch): { line?: number; col?: number } {
  if (m.kind !== "path" || m.line === undefined) return {};
  return m.col === undefined ? { line: m.line } : { line: m.line, col: m.col };
}
